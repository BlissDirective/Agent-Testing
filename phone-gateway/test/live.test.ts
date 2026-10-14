// Live tests: real calls through the local Asterisk (start it with
// asterisk/start.sh). Skipped when Asterisk isn't running.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { WebSocketServer } from "ws";
import { makeConfig as makeAgentConfig } from "../../voice-agent/src/config.js";
import type { Providers } from "../../voice-agent/src/providers/types.js";
import { startServer as startVoiceAgent } from "../../voice-agent/src/server.js";
import { startApi } from "../src/api.js";
import { parseConfig } from "../src/config.js";
import { Gateway } from "../src/gateway.js";
import { signTwilio, verifyJson } from "../src/signing.js";
import {
  AppServer, ariAvailable, ariOptions, getGlobal, placeInboundCall, recordingsDir, setGlobal, tone, toMulaw,
  toneSeconds, waitFor, wavStats,
} from "./live-harness.js";

const SECRET = "test-webhook-secret-123";
const API_KEY = "test-api-key-0123456789";
const live = await ariAvailable();
const heardDir = mkdtempSync(path.join(tmpdir(), "gw-heard-"));

describe("live calls through Asterisk", { skip: !live && "Asterisk not running (asterisk/start.sh)" }, () => {
  let app: AppServer;
  let gateway: Gateway;
  let api: Server;
  let apiUrl = "";
  const logs: string[] = [];

  // Fake Twilio Media Streams app.
  const streamEvents: any[] = [];
  let markEchoedAfterMs = -1;
  let streamServer: WebSocketServer;

  // The real voice agent, with fake speech/LLM providers: the greeting is a 3 s
  // tone, and the fake transcriber interrupts it ~1 s into the caller's audio.
  let agentServer: Server;
  let agentAudioBytes = 0;
  const agentEvents: string[] = [];
  const agentProviders: Providers = {
    stt: {
      start(_options, handlers) {
        let interrupted = false;
        let answered = false;
        return {
          write(pcm) {
            agentAudioBytes += pcm.length;
            if (!interrupted && agentAudioBytes > 32000) {
              interrupted = true;
              agentEvents.push("interim");
              handlers.onTranscript({ text: "no wait stop", isFinal: false });
            }
            if (!answered && agentAudioBytes > 64000) {
              answered = true;
              handlers.onTranscript({ text: "No wait, stop.", isFinal: true });
            }
          },
          close() {},
        };
      },
    },
    llm: {
      startConversation() {
        return {
          addUserMessage(text: string) { agentEvents.push(`user: ${text}`); },
          addAssistantMessage() {},
          commitInterrupted() { agentEvents.push("interrupted"); },
          async *respond() { yield "Okay."; },
        };
      },
    },
    tts: {
      async *synthesize(text, { sampleRate }) {
        agentEvents.push(`tts: ${text}`);
        yield tone(sampleRate, text === "Okay." ? 0.3 : 3, 440);
      },
    },
  };

  before(async () => {
    streamServer = new WebSocketServer({ port: 0 });
    streamServer.on("connection", (socket) => {
      let sentAt = 0;
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        streamEvents.push(message);
        if (message.event === "start") {
          // 1 s of tone back to the caller, then a mark to learn when it finished playing.
          socket.send(JSON.stringify({
            event: "media", streamSid: message.streamSid,
            media: { payload: toMulaw(tone(8000, 1, 440)).toString("base64") },
          }));
          socket.send(JSON.stringify({ event: "mark", streamSid: message.streamSid, mark: { name: "tone-done" } }));
          sentAt = Date.now();
        }
        if (message.event === "mark" && message.mark?.name === "tone-done") {
          markEchoedAfterMs = Date.now() - sentAt;
          setTimeout(() => socket.close(), 300);
        }
      });
    });
    const streamUrl = `ws://127.0.0.1:${(streamServer.address() as AddressInfo).port}/stream`;

    agentServer = startVoiceAgent(makeAgentConfig({ firstMessage: "Hello caller" }), agentProviders, 0);
    await new Promise((r) => agentServer.once("listening", r));
    const agentUrl = `ws://127.0.0.1:${(agentServer.address() as AddressInfo).port}/call`;

    app = new AppServer({
      "/play": () => [{ play: { media: "sound:hello-world" } }, { hangup: {} }],
      "/gather": () => [{ gather: { finishOnKey: "#", timeout: 5, actionHook: `${app.url}/digits` } }],
      "/digits": () => [{ hangup: {} }],
      "/record": () => [
        { record: { maxLength: 3, beep: false, finishOnKey: "", actionHook: `${app.url}/recorded` } },
      ],
      "/recorded": () => [{ hangup: {} }],
      "/dial": () => [
        { dial: { target: "Local/answerer@gateway-test/n", record: true, actionHook: `${app.url}/dialed` } },
      ],
      "/dialed": () => [{ hangup: {} }],
      "/twiml-stream": () => ({
        type: "text/xml",
        body: `<?xml version="1.0"?><Response><Connect><Stream url="${streamUrl}">
          <Parameter name="customer" value="42"/></Stream></Connect><Hangup/></Response>`,
      }),
    });
    await app.start();

    const config = parseConfig({
      port: 0,
      publicUrl: "http://127.0.0.1:0",
      apiKeys: [API_KEY],
      webhookSecret: SECRET,
      ari: ariOptions,
      recordingsDir,
      numbers: {
        "+15550001": { url: `${app.url}/play`, statusCallback: `${app.url}/status` },
        "+15550002": { url: `${app.url}/gather` },
        "+15550003": { url: `${app.url}/record` },
        "+15550004": { url: `${app.url}/dial` },
        "+15550005": { verbs: [{ connect: { url: agentUrl, record: true } }, { hangup: {} }] },
        "+15550006": { url: `${app.url}/twiml-stream`, format: "twiml" },
        "+15550007": { verbs: [{ answer: {} }, { pause: { length: 30 } }] },
        "+15550008": { verbs: [{ answer: {} }, { pause: { length: 10 } }], statusCallback: `${app.url}/sip-status` },
      },
    });
    gateway = new Gateway(config, (m) => logs.push(m));
    await gateway.start();
    if (process.env.GATEWAY_TEST_EVENTS) {
      gateway.ari.on("event", (e: any) =>
        logs.push(`EVENT ${e.type} ${e.channel?.id ?? ""} ${e.recording ? `${e.recording.name} ${e.recording.state} ${e.recording.target_uri}` : ""}`));
    }
    api = startApi(gateway, 0);
    await new Promise((r) => api.once("listening", r));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    await setGlobal("HEARD_PREFIX", path.join(heardDir, "heard"));
  });

  after(() => {
    gateway?.stop();
    api?.close();
    app?.close();
    streamServer?.close();
    agentServer?.close();
    if (process.env.GATEWAY_TEST_LOG) console.log(logs.join("\n"));
  });

  const callTo = (to: string) => () =>
    [...gateway.calls.values()].find((c) => c.to === to && c.direction === "inbound");

  test("inbound call plays audio, hangs up, and sends signed status callbacks", async () => {
    await placeInboundCall("+15550001", "listener");
    const call = await waitFor(callTo("+15550001"), 5000, "inbound call");
    await waitFor(() => call.endedAt, 20000, "call to end");
    assert.equal(call.status, "completed");
    assert.equal(call.from, "+15559990000");

    const webhook = app.find("/play")[0]!;
    assert.equal(webhook.json.callSid, call.sid);
    assert.ok(verifyJson(SECRET, webhook.body, String(webhook.headers["x-gateway-signature"])), "webhook signature");

    const events = await waitFor(() => {
      const e = app.find("/status").map((r) => r.json.event);
      return e.includes("completed") && e;
    }, 5000, "completed callback");
    assert.deepEqual(events, ["ringing", "answered", "completed"]);

    const heard = await wavStats(`${await getGlobal("LAST_HEARD")}.wav`);
    assert.ok(heard.rms > 300, `caller heard the prompt (rms ${heard.rms.toFixed(0)})`);
  });

  test("gather collects keypad digits and posts them to the action hook", async () => {
    await placeInboundCall("+15550002", "presser", { DIGITS: "4271#" });
    const digits = await waitFor(() => app.find("/digits")[0], 15000, "digits webhook");
    assert.equal(digits.json.digits, "4271");
    await waitFor(() => callTo("+15550002")()?.endedAt, 10000, "call to end");
  });

  test("record captures the caller and serves the recording over the API", async () => {
    await placeInboundCall("+15550003", "talker");
    const recorded = await waitFor(() => app.find("/recorded")[0], 15000, "recorded webhook");
    const name = recorded.json.recordingSid as string;
    assert.ok(recorded.json.recordingDuration >= 2, `duration ${recorded.json.recordingDuration}`);
    const stats = await wavStats(path.join(recordingsDir, `${name}.wav`));
    assert.ok(stats.rms > 300, `recording has speech (rms ${stats.rms.toFixed(0)})`);

    const response = await fetch(`${apiUrl}/v1/recordings/${name}.wav`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    assert.equal((await fetch(`${apiUrl}/v1/recordings/${name}.wav`)).status, 401);
  });

  test("dial bridges to another party and records both sides", async () => {
    await placeInboundCall("+15550004", "listener", { LISTEN_SECONDS: "15" });
    const dialed = await waitFor(() => app.find("/dialed")[0], 20000, "dialed webhook");
    assert.equal(dialed.json.dialCallStatus, "completed");
    const stats = await wavStats(path.join(recordingsDir, `${dialed.json.recordingSid}.wav`));
    assert.ok(stats.rms > 300, `bridge recording has audio (rms ${stats.rms.toFixed(0)})`);
    const heard = await wavStats(`${await getGlobal("LAST_HEARD")}.wav`);
    assert.ok(heard.rms > 300, `caller heard the callee (rms ${heard.rms.toFixed(0)})`);
  });

  test("connect bridges the caller to the voice agent, with working barge-in", async () => {
    await placeInboundCall("+15550005", "talker", { TALK_TAIL: "4" });
    const call = await waitFor(callTo("+15550005"), 5000, "inbound call");
    await waitFor(() => call.endedAt, 20000, "call to end");

    assert.ok(agentAudioBytes > 64000, `agent received caller audio (${agentAudioBytes} bytes)`);
    assert.ok(agentEvents.includes("interim"), "agent heard the caller talk over it");
    assert.ok(agentEvents.includes("user: No wait, stop."), `agent got the transcript (${agentEvents.join(" | ")})`);
    assert.ok(agentEvents.includes("tts: Okay."), "agent replied");

    // The caller heard the greeting tone, but cut short by the barge-in.
    const heardFile = `${await getGlobal("LAST_HEARD")}.wav`;
    const seconds = await toneSeconds(heardFile);
    assert.ok(seconds > 0.4, `caller heard the agent (${seconds.toFixed(2)} s of tone)`);
    assert.ok(seconds < 2.2, `greeting was cut off by barge-in (${seconds.toFixed(2)} s of 3 s)`);
  });

  test("TwiML app streams call audio with Twilio's Media Streams protocol", async () => {
    // The caller talks (so audio flows to the app) and records what it receives.
    await placeInboundCall("+15550006", "talker", { TALK_TAIL: "3" });
    const call = await waitFor(callTo("+15550006"), 5000, "inbound call");
    await waitFor(() => call.endedAt, 20000, "call to end");

    const webhook = app.find("/twiml-stream")[0]!;
    assert.equal(webhook.form?.CallSid, call.sid);
    assert.equal(
      webhook.headers["x-twilio-signature"],
      signTwilio(SECRET, `${app.url}/twiml-stream`, webhook.form!),
      "Twilio-compatible signature",
    );

    const kinds = streamEvents.map((e) => e.event);
    assert.equal(kinds[0], "connected");
    assert.equal(kinds[1], "start");
    assert.deepEqual(streamEvents[1].start.customParameters, { customer: "42" });
    assert.equal(streamEvents[1].start.callSid, call.sid);
    const media = streamEvents.filter((e) => e.event === "media");
    assert.ok(media.length > 20, `received ${media.length} media frames`);
    assert.equal(Buffer.from(media[0].media.payload, "base64").length, 160, "20 ms mu-law frames");
    assert.ok(markEchoedAfterMs >= 800, `mark echoed after playback (${markEchoedAfterMs} ms)`);

    const heard = await wavStats(`${await getGlobal("LAST_HEARD")}.wav`);
    assert.ok(heard.rms > 300, `caller heard the stream's audio (rms ${heard.rms.toFixed(0)})`);
    assert.ok(Math.abs(heard.frequency - 440) < 40, `tone at ~440 Hz (${heard.frequency.toFixed(0)} Hz)`);
  });

  test("REST API redirects and hangs up a live call", async () => {
    await placeInboundCall("+15550007", "listener", { LISTEN_SECONDS: "20" });
    const call = await waitFor(callTo("+15550007"), 5000, "inbound call");
    await waitFor(() => call.answeredAt, 5000, "answer");
    const headers = { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" };

    const redirect = await fetch(`${apiUrl}/v1/calls/${call.sid}`, {
      method: "POST", headers, body: JSON.stringify({ verbs: [{ play: { media: "sound:beep" } }, { pause: { length: 30 } }] }),
    });
    assert.equal(redirect.status, 200);
    await waitFor(() => logs.some((l) => l.includes(call.sid) && l.includes("play")), 5000, "redirected verb");

    const hangup = await fetch(`${apiUrl}/v1/calls/${call.sid}`, {
      method: "POST", headers, body: JSON.stringify({ status: "completed" }),
    });
    assert.equal(hangup.status, 200);
    await waitFor(() => call.endedAt, 5000, "call to end");
    assert.equal(call.status, "completed");
  });

  test("REST API places outbound calls and reports failures", async () => {
    const headers = { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" };
    const created = await fetch(`${apiUrl}/v1/calls`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        to: "Local/listener@gateway-test/n",
        from: "+15550000",
        verbs: [{ play: { media: "sound:hello-world" } }, { hangup: {} }],
        statusCallback: `${app.url}/out-status`,
      }),
    });
    assert.equal(created.status, 201);
    const { sid } = (await created.json()) as { sid: string };
    const call = gateway.calls.get(sid)!;
    await waitFor(() => call.endedAt, 20000, "outbound call to end");
    assert.equal(call.status, "completed");
    const events = await waitFor(() => {
      const e = app.find("/out-status").map((r) => r.json.event);
      return e.includes("completed") && e;
    }, 5000, "status callbacks");
    assert.deepEqual(events, ["initiated", "answered", "completed"]);
    const heard = await wavStats(`${await getGlobal("LAST_HEARD")}.wav`);
    assert.ok(heard.rms > 300, `callee heard the prompt (rms ${heard.rms.toFixed(0)})`);

    const failed = await fetch(`${apiUrl}/v1/calls`, {
      method: "POST",
      headers,
      body: JSON.stringify({ to: "Local/nobody@gateway-test/n", from: "+15550000", verbs: [{ hangup: {} }] }),
    });
    const failedCall = gateway.calls.get(((await failed.json()) as { sid: string }).sid)!;
    await waitFor(() => failedCall.endedAt, 10000, "failed call to end");
    assert.notEqual(failedCall.status, "completed");

    assert.equal((await fetch(`${apiUrl}/v1/calls`, { method: "POST", headers, body: "{}" })).status, 400);
  });

  test("real SIP call from a SIP client (SIPp) is answered and completed", async () => {
    const sipp = spawn("sipp", ["-sn", "uac", "-s", "+15550008", "-m", "1", "-d", "2000", "-timeout", "15", "-nostdin", "127.0.0.1:5060"], {
      stdio: "ignore",
    });
    const exit = await new Promise<number | null>((resolve) => sipp.on("exit", resolve));
    assert.equal(exit, 0, "SIPp's call succeeded (INVITE answered, BYE accepted)");
    const call = await waitFor(callTo("+15550008"), 10000, "SIP call");
    await waitFor(() => call.endedAt, 15000, "SIP call to end");
    assert.equal(call.status, "completed");
    assert.ok((call.durationSeconds ?? 0) >= 1, `duration ${call.durationSeconds}`);
    const events = await waitFor(() => {
      const e = app.find("/sip-status").map((r) => r.json.event);
      return e.includes("completed") && e;
    }, 5000, "status callbacks");
    assert.deepEqual(events, ["ringing", "answered", "completed"]);
  });
});

