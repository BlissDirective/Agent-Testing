// Live tests for call records across restarts and for graceful shutdown,
// with real calls through the local Asterisk (asterisk/start.sh). The goodbye
// check also needs the speech server (speech/start.sh).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { AriError } from "../src/ari.js";
import { startApi } from "../src/api.js";
import { parseConfig } from "../src/config.js";
import { Gateway } from "../src/gateway.js";
import { wavToPcm } from "../src/speech/tts.js";
import { CallStore } from "../src/store.js";
import { ariAvailable, ariOptions, getGlobal, placeInboundCall, recordingsDir, setGlobal, testAri, waitFor } from "./live-harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SPEECH = "http://127.0.0.1:8090";
const live = await ariAvailable();
const speechUp = await fetch(`${SPEECH}/health`).then((r) => r.ok).catch(() => false);
const dir = mkdtempSync(path.join(tmpdir(), "gw-life-"));
const API_KEY = "test-api-key-0123456789";

const numbers = {
  "+15550030": { verbs: [{ record: { maxLength: 2, beep: false, finishOnKey: "" } }, { hangup: {} }] },
  "+15550031": { verbs: [{ answer: {} }, { pause: { length: 60 } }] },
  "+15550032": { verbs: [{ play: { media: "sound:hello-world" } }, { hangup: {} }] },
};

function configFor(database: string, extra: Record<string, unknown> = {}) {
  return parseConfig({
    port: 0,
    apiKeys: [API_KEY],
    webhookSecret: "test-webhook-secret-123",
    ari: ariOptions,
    recordingsDir,
    database,
    tts: { engine: "piper", cacheDir: path.join(dir, "tts-cache"), piper: { url: SPEECH } },
    numbers,
    ...extra,
  });
}

async function startGateway(database: string, logs: string[], extra: Record<string, unknown> = {}) {
  const gateway = new Gateway(configFor(database, extra), (m) => logs.push(m));
  await gateway.start();
  const api = startApi(gateway, 0);
  await new Promise((r) => api.once("listening", r));
  return { gateway, api, url: `http://127.0.0.1:${(api.address() as AddressInfo).port}` };
}

async function get(url: string, pathname: string) {
  const response = await fetch(`${url}${pathname}`, { headers: { authorization: `Bearer ${API_KEY}` } });
  return { status: response.status, body: (await response.json()) as any };
}

async function transcribe(wavFile: string): Promise<string> {
  const { pcm, sampleRate } = wavToPcm(await readFile(wavFile));
  const response = await fetch(`${SPEECH}/stt`, {
    method: "POST",
    headers: { "content-type": `audio/L16;rate=${sampleRate}` },
    body: new Uint8Array(pcm),
  });
  return ((await response.json()) as { text: string }).text.toLowerCase();
}

/** Place a call and return the gateway's Call for it once it exists. */
async function place(gateway: Gateway, to: string, caller: "listener" | "talker", vars: Record<string, string> = {}) {
  const seen = new Set(gateway.calls.keys());
  await placeInboundCall(to, caller, vars);
  return waitFor(() => [...gateway.calls.values()].find((c) => !seen.has(c.sid) && c.to === to), 5000, `call to ${to}`);
}

describe("live: call records and graceful shutdown", { skip: !live && "Asterisk not running (asterisk/start.sh)" }, () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));
  before(async () => setGlobal("HEARD_PREFIX", path.join(dir, "heard")));

  test("call records and recordings are still there after a restart", async () => {
    const database = path.join(dir, "restart.db");
    const logs: string[] = [];
    const first = await startGateway(database, logs);
    servers.push(first.api);
    const call = await place(first.gateway, "+15550030", "talker");
    await waitFor(() => call.endedAt, 15000, "call to end");
    await waitFor(() => first.gateway.store.listRecordings(call.sid)[0]?.durationSeconds !== undefined, 5000, "recording duration");
    first.api.close();
    first.gateway.stop();

    const second = await startGateway(database, logs);
    servers.push(second.api);
    try {
      assert.equal(second.gateway.calls.size, 0, "a fresh process has nothing in memory");
      const { status, body } = await get(second.url, `/v1/calls/${call.sid}`);
      assert.equal(status, 200);
      assert.equal(body.status, "completed");
      assert.equal(body.to, "+15550030");
      assert.ok(body.duration >= 2, `duration ${body.duration}`);
      assert.equal(body.recordings.length, 1);
      assert.ok(body.recordings[0].durationSeconds >= 1);
      assert.match(body.recordings[0].url, /\/v1\/recordings\/CA[0-9a-f]+-1\.wav$/);
      const listed = await get(second.url, "/v1/calls?limit=5");
      assert.ok(listed.body.some((c: any) => c.sid === call.sid));
      const recording = await fetch(`${second.url}/v1/recordings/${body.recordings[0].name}.wav`, {
        headers: { authorization: `Bearer ${API_KEY}` },
      });
      assert.equal(recording.status, 200);
      assert.equal((await post(second.url, `/v1/calls/${call.sid}`, { status: "completed" })).status, 409, "ended calls can't be changed");
    } finally {
      second.api.close();
      second.gateway.stop();
    }
  });

  test("after a crash, unfinished calls are marked failed and stray channels hung up", async () => {
    const database = path.join(dir, "crash.db");
    const logs: string[] = [];
    const first = await startGateway(database, logs);
    servers.push(first.api);
    const call = await place(first.gateway, "+15550031", "listener", { LISTEN_SECONDS: "60" });
    await waitFor(() => call.answeredAt, 5000, "answer");
    // Simulate a crash: the process disappears without hanging anything up.
    first.api.close();
    first.gateway.ari.close();
    first.gateway.store.close();

    const second = await startGateway(database, logs);
    servers.push(second.api);
    try {
      const record = second.gateway.store.getCall(call.sid)!;
      assert.equal(record.status, "failed");
      assert.equal(record.endedReason, "gateway-restart");
      assert.ok(logs.some((l) => l.includes("leftover channel")), "stray channel hung up");
      await new Promise((r) => setTimeout(r, 1000)); // let the hangup land
      await assert.rejects(testAri.request("GET", `/channels/${call.channelId}`), (e) => e instanceof AriError && e.status === 404);
    } finally {
      second.api.close();
      second.gateway.stop();
    }
  });

  test("drain: calls finish, new callers get busy, the rest hear a goodbye", async () => {
    const logs: string[] = [];
    const { gateway, api, url } = await startGateway(":memory:", logs);
    servers.push(api);
    try {
      const long = await place(gateway, "+15550031", "listener", { LISTEN_SECONDS: "30" });
      await waitFor(() => long.answeredAt, 5000, "long call answered");
      const longHeard = `${await getGlobal("LAST_HEARD")}.wav`; // before the next call replaces it
      const short = await place(gateway, "+15550032", "listener", { LISTEN_SECONDS: "10" });
      await waitFor(() => long.answeredAt && short.answeredAt, 5000, "both answered");
      assert.equal((await fetch(`${url}/health`)).status, 200);

      const started = Date.now();
      const drained = gateway.drain({ drainSeconds: 5 });

      // While draining: health says so, new calls get busy, outbound is refused.
      const health = await fetch(`${url}/health`);
      assert.equal(health.status, 503);
      assert.deepEqual(await health.json(), { status: "draining", activeCalls: 2 });
      await placeInboundCall("+15550032", "listener");
      const busy = await waitFor(() => gateway.store.listCalls({ status: "busy" })[0], 5000, "busy record");
      assert.equal(busy.endedReason, "gateway-draining");
      const refused = await post(url, "/v1/calls", { to: "Local/listener@gateway-test/n", from: "+1555", verbs: [{ hangup: {} }] });
      assert.equal(refused.status, 503);
      assert.equal(refused.headers.get("retry-after"), "60");

      const result = await drained;
      const seconds = (Date.now() - started) / 1000;
      assert.deepEqual(result, { finishedNaturally: 1, endedByGateway: 1 });
      assert.ok(seconds >= 5 && seconds < 25, `drain took ${seconds.toFixed(1)} s`);
      assert.equal(short.endedReason, undefined, "the short call finished on its own");
      assert.equal(long.endedReason, "gateway-shutdown");
      assert.equal(gateway.store.getCall(long.sid)!.endedReason, "gateway-shutdown");
      assert.equal(gateway.activeCalls.length, 0);

      if (speechUp) {
        const heard = await transcribe(longHeard);
        assert.match(heard, /call back/, `the long call heard the goodbye ("${heard}")`);
      }
    } finally {
      api.close();
      gateway.stop();
    }
  });

  test("SIGTERM drains and exits; the record shows why the call ended", async () => {
    const database = path.join(dir, "signal.db");
    const configFile = path.join(dir, "signal.json");
    writeFileSync(configFile, JSON.stringify({
      port: 0, apiKeys: [API_KEY], webhookSecret: "test-webhook-secret-123", ari: ariOptions,
      recordingsDir, database, numbers, shutdown: { drainSeconds: 3, goodbye: "Goodbye for now." },
      tts: { engine: "piper", cacheDir: path.join(dir, "tts-cache"), piper: { url: SPEECH } },
    }));
    const child = spawn(path.join(here, "../node_modules/.bin/tsx"), ["src/main.ts"], {
      cwd: path.join(here, ".."),
      env: { ...process.env, GATEWAY_CONFIG: configFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    try {
      await waitFor(() => output.includes("Phone gateway API"), 15000, "gateway process to start");
      await placeInboundCall("+15550031", "listener", { LISTEN_SECONDS: "30" });
      await waitFor(() => output.includes("pause"), 5000, "call to start");

      child.kill("SIGTERM");
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 30000))]);
      assert.equal(code, 0, `exit code (output:\n${output})`);
      assert.match(output, /shutting down gracefully/);
      assert.match(output, /Drained: 0 finished on their own, 1 ended by the gateway/);

      const store = new CallStore(database);
      const [record] = store.listCalls({ limit: 1 });
      store.close();
      assert.equal(record!.to, "+15550031");
      assert.equal(record!.status, "completed");
      assert.equal(record!.endedReason, "gateway-shutdown");
    } finally {
      child.kill("SIGKILL");
    }
  });
});

async function post(url: string, pathname: string, body: unknown) {
  return fetch(`${url}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
