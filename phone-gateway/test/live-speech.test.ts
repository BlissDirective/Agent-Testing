// Live speech tests: real calls through Asterisk, with Piper speaking and
// Whisper listening (speech/start.sh). The test caller's recording of what it
// heard is transcribed back to check the words, not just that sound played.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { parseConfig } from "../src/config.js";
import { Gateway } from "../src/gateway.js";
import { wavToPcm } from "../src/speech/tts.js";
import { AppServer, ariAvailable, ariOptions, getGlobal, placeInboundCall, recordingsDir, setGlobal, waitFor } from "./live-harness.js";

const SPEECH = "http://127.0.0.1:8090";
const speechUp = await fetch(`${SPEECH}/health`).then((r) => r.ok).catch(() => false);
const live = (await ariAvailable()) && speechUp;
const dir = mkdtempSync(path.join(tmpdir(), "gw-speech-"));

/** What a recording says, according to Whisper. */
async function transcribe(wavFile: string): Promise<string> {
  const { pcm, sampleRate } = wavToPcm(await readFile(wavFile));
  const response = await fetch(`${SPEECH}/stt`, {
    method: "POST",
    headers: { "content-type": `audio/L16;rate=${sampleRate}` },
    body: new Uint8Array(pcm),
  });
  return ((await response.json()) as { text: string }).text.toLowerCase();
}

/** Make a sound file of `text` for the test caller to say (Asterisk plays <base>.wav16). */
async function speechFile(name: string, text: string): Promise<string> {
  const response = await fetch(`${SPEECH}/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, sampleRate: 16000 }),
  });
  const base = path.join(dir, name);
  await writeFile(`${base}.wav16`, Buffer.from(await response.arrayBuffer()));
  return base;
}

describe("live speech: say and speech gather", { skip: !live && "needs asterisk/start.sh and speech/start.sh" }, () => {
  let app: AppServer;
  let gateway: Gateway;
  const logs: string[] = [];
  let salesFile = "";

  before(async () => {
    salesFile = await speechFile("sales", "I would like to talk to sales, please.");
    app = new AppServer({
      "/menu": () => [
        {
          gather: {
            input: ["speech", "dtmf"],
            say: "Thanks for calling Acme. Please tell me which department you need. You can say sales, support, or billing, or press a key.",
            hints: "sales, support, billing",
            actionHook: `${app.url}/answer`,
          },
        },
        { say: { text: "Sorry, I didn't catch that. Goodbye." } },
        { hangup: {} },
      ],
      "/answer": () => [{ say: { text: "Connecting you now." } }, { hangup: {} }],
      "/twiml": () => ({
        type: "text/xml",
        body: `<Response><Gather input="speech" action="${app.url}/twiml-answer" timeout="3">
                 <Say>Which department?</Say></Gather><Say>Goodbye.</Say></Response>`,
      }),
      "/twiml-answer": () => ({ type: "text/xml", body: "<Response><Hangup/></Response>" }),
    });
    await app.start();

    const config = parseConfig({
      port: 0,
      apiKeys: ["test-api-key-0123456789"],
      webhookSecret: "test-webhook-secret-123",
      ari: ariOptions,
      recordingsDir,
      database: ":memory:",
      tts: { engine: "piper", cacheDir: path.join(dir, "cache"), piper: { url: SPEECH } },
      stt: { engine: "whisper", whisper: { url: SPEECH } },
      numbers: {
        "+15550020": {
          verbs: [{ say: { text: "Your appointment is confirmed for Tuesday at three o'clock. Thank you for calling." } }, { hangup: {} }],
        },
        "+15550021": { url: `${app.url}/menu` },
        "+15550022": { url: `${app.url}/twiml`, format: "twiml" },
        "+15550023": {
          // ElevenLabs is selected but has no key: the gateway must fall back to Piper.
          verbs: [{ say: { text: "This message has a backup voice.", engine: "elevenlabs" } }, { hangup: {} }],
        },
      },
    });
    gateway = new Gateway(config, (m) => logs.push(m));
    await gateway.start();
    if (process.env.GATEWAY_TEST_EVENTS) {
      gateway.ari.on("event", (e: any) =>
        logs.push(`EVENT ${e.type} ${e.channel?.id ?? ""} ${e.playback ? `${e.playback.id} ${e.playback.state} ${e.playback.media_uri ?? ""}` : ""}`));
    }
    await setGlobal("HEARD_PREFIX", path.join(dir, "heard"));
  });

  after(() => {
    gateway?.stop();
    app?.close();
    if (process.env.GATEWAY_TEST_LOG) console.log(logs.join("\n"));
  });

  /** Place a call and wait for it (not an earlier call to the same number) to finish. */
  async function callAndWait(to: string, caller: Parameters<typeof placeInboundCall>[1], vars: Record<string, string>, timeoutMs = 30000) {
    const seen = new Set(gateway.calls.keys());
    await placeInboundCall(to, caller, vars);
    const call = await waitFor(
      () => [...gateway.calls.values()].find((c) => !seen.has(c.sid) && c.to === to),
      5000,
      `call to ${to}`,
    );
    await waitFor(() => call.endedAt, timeoutMs, `call to ${to} to end`);
    return call;
  }

  test("say: the caller hears the exact words, and repeats come from the cache", async () => {
    for (let round = 1; round <= 2; round++) {
      const call = await callAndWait("+15550020", "listener", { LISTEN_SECONDS: "10" });
      assert.equal(call.status, "completed");
    }
    const heard = await transcribe(`${await getGlobal("LAST_HEARD")}.wav`);
    assert.match(heard, /appointment/);
    assert.match(heard, /tuesday/);
    assert.match(heard, /three|3/);
    const syntheses = logs.filter((l) => l.startsWith("TTS piper"));
    assert.equal(syntheses.length, 2, `two sentences synthesized once, second call cached (${syntheses.join("; ")})`);
  });

  test("speech gather: the caller says a department, interrupting the prompt", async () => {
    const started = Date.now();
    // The prompt is ~8 s long; the caller starts talking 2 s in.
    const done = callAndWait("+15550021", "speaker", { SPEAK_FILE: salesFile, SPEAK_AFTER: "2" });
    const answer = await waitFor(() => app.find("/answer")[0], 20000, "speech answer");
    const elapsed = (Date.now() - started) / 1000;
    assert.match(String(answer.json.speechResult).toLowerCase(), /sales/);
    assert.ok(answer.json.confidence > 0 && answer.json.confidence <= 1, `confidence ${answer.json.confidence}`);
    assert.ok(elapsed < 9, `barge-in: answered after ${elapsed.toFixed(1)} s, before the prompt would have ended`);

    // The caller heard the start of the prompt, but not the end of it.
    await done;
    const heard = await transcribe(`${await getGlobal("LAST_HEARD")}.wav`);
    // (Whisper spells "Acme" variously on phone audio, so match the plain words.)
    assert.match(heard, /thanks for calling/, `heard: "${heard}"`);
    assert.doesNotMatch(heard, /billing/, `prompt was cut off (heard: "${heard}")`);
    assert.match(heard, /connect/, `heard: "${heard}"`);
  });

  test("speech gather: silence times out and the call carries on", async () => {
    const before = app.find("/answer").length;
    const call = await callAndWait("+15550021", "listener", { LISTEN_SECONDS: "25" });
    assert.equal(app.find("/answer").length, before, "no answer was posted");
    assert.ok(logs.some((l) => l.includes(call.sid) && l.includes("no input")));
    const heard = await transcribe(`${await getGlobal("LAST_HEARD")}.wav`);
    assert.match(heard, /didn't catch that|did not catch that/);
  });

  test("TwiML <Gather input=\"speech\"> with a <Say> prompt posts SpeechResult", async () => {
    await callAndWait("+15550022", "speaker", { SPEAK_FILE: salesFile, SPEAK_AFTER: "2.5" });
    const answer = await waitFor(() => app.find("/twiml-answer")[0], 5000, "TwiML speech answer");
    assert.match(String(answer.form?.SpeechResult).toLowerCase(), /sales/);
    assert.ok(Number(answer.form?.Confidence) > 0);
  });

  test("an ElevenLabs failure falls back to the Piper voice", async () => {
    await callAndWait("+15550023", "listener", { LISTEN_SECONDS: "6" });
    assert.ok(logs.some((l) => l.includes("falling back to piper")));
    assert.match(await transcribe(`${await getGlobal("LAST_HEARD")}.wav`), /backup voice/);
  });
});
