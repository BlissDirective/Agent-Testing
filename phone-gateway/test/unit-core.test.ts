import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { dialString, statusForCause } from "../src/call.js";
import { AudioPacer, parseRtp, swap16 } from "../src/rtp.js";
import { signJson, signTwilio, verifyJson } from "../src/signing.js";
import { twimlToVerbs, UnsupportedTwimlError } from "../src/twiml.js";
import { parseVerbs } from "../src/verbs.js";

test("verbs are validated, with defaults filled in", () => {
  const verbs = parseVerbs([{ play: { media: "sound:hello-world" } }, { gather: { numDigits: 4 } }, { hangup: {} }]);
  assert.deepEqual(verbs[0], { name: "play", args: { media: "sound:hello-world", loop: 1 } });
  assert.deepEqual(verbs[1], { name: "gather", args: { numDigits: 4, finishOnKey: "#", timeout: 5 } });
  assert.throws(() => parseVerbs([{ dance: {} }]), /unknown verb "dance"/);
  assert.throws(() => parseVerbs([{ play: {}, hangup: {} }]), /exactly one key/);
  assert.throws(() => parseVerbs([{ connect: { url: "http://not-a-websocket" } }]), /connect/);
  assert.throws(() => parseVerbs({ play: {} }), /JSON array/);
});

test("TwiML is translated into verbs", () => {
  const verbs = twimlToVerbs(`<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Play loop="2">https://example.com/hello.wav</Play>
      <Gather numDigits="3" timeout="4" action="https://app.example/digits">
        <Play>beep</Play>
      </Gather>
      <Dial callerId="+15550000" timeout="20" record="record-from-answer"><Number>+15551234</Number></Dial>
      <Dial>sip:alice@example.com</Dial>
      <Record maxLength="30" playBeep="false" action="https://app.example/rec"/>
      <Connect><Stream url="wss://ai.example/stream"><Parameter name="lang" value="en"/></Stream></Connect>
      <Pause length="2"/>
      <Redirect>https://app.example/next</Redirect>
      <Reject reason="busy"/>
      <Hangup/>
    </Response>`);
  assert.deepEqual(
    verbs.map((v) => v.name),
    ["play", "gather", "dial", "dial", "record", "connect", "pause", "redirect", "reject", "hangup"],
  );
  assert.deepEqual(verbs[0]!.args, { media: "https://example.com/hello.wav", loop: 2 });
  assert.deepEqual(verbs[1]!.args, {
    numDigits: 3, finishOnKey: "#", timeout: 4, play: "sound:beep", actionHook: "https://app.example/digits",
  });
  assert.deepEqual(verbs[2]!.args, {
    target: "+15551234", callerId: "+15550000", timeout: 20, record: true, actionHook: undefined,
  });
  assert.equal((verbs[3]!.args as { target: string }).target, "sip:alice@example.com");
  assert.deepEqual(verbs[5]!.args, {
    url: "wss://ai.example/stream", protocol: "twilio", parameters: { lang: "en" }, record: false, actionHook: undefined,
  });
  assert.deepEqual(verbs[8]!.args, { reason: "busy" });

  assert.throws(() => twimlToVerbs("<Response><Say>Hi</Say></Response>"), UnsupportedTwimlError);
  assert.throws(() => twimlToVerbs("<Response><Enqueue>support</Enqueue></Response>"), UnsupportedTwimlError);
  assert.throws(() => twimlToVerbs("<NotResponse/>"), /Response/);
});

test("Twilio-style signature matches Twilio's documented algorithm", () => {
  // Independent reimplementation: url + each sorted key immediately followed by its value.
  const url = "https://app.example/voice?x=1";
  const params = { To: "+15551234", From: "+15550000", CallSid: "CA123", Digits: "42" };
  const data = url + "CallSid" + "CA123" + "Digits" + "42" + "From" + "+15550000" + "To" + "+15551234";
  const expected = createHmac("sha1", "secret-token-1234").update(data).digest("base64");
  assert.equal(signTwilio("secret-token-1234", url, params), expected);
});

test("JSON webhook signatures verify, and reject tampering and replays", () => {
  const body = JSON.stringify({ callSid: "CA1" });
  const header = signJson("s3cret-s3cret-s3cret", body);
  assert.ok(verifyJson("s3cret-s3cret-s3cret", body, header));
  assert.ok(!verifyJson("s3cret-s3cret-s3cret", body + " ", header));
  assert.ok(!verifyJson("wrong-secret-wrong", body, header));
  const old = signJson("s3cret-s3cret-s3cret", body, Math.floor(Date.now() / 1000) - 3600);
  assert.ok(!verifyJson("s3cret-s3cret-s3cret", body, old));
});

test("dial targets map to Asterisk dial strings", () => {
  assert.equal(dialString("sip:alice@example.com", "PJSIP/{number}@trunk"), "PJSIP/trunk/sip:alice@example.com");
  assert.equal(dialString("+1 (555) 123-4567", "PJSIP/{number}@trunk"), "PJSIP/+15551234567@trunk");
  assert.equal(dialString("Local/listener@gateway-test/n", "x"), "Local/listener@gateway-test/n");
  assert.throws(() => dialString("not a number", "PJSIP/{number}@trunk"));
  assert.equal(statusForCause(17), "busy");
  assert.equal(statusForCause(19), "no-answer");
  assert.equal(statusForCause(1), "failed");
});

test("RTP packets parse, including CSRCs and padding", () => {
  const header = Buffer.from([0x80, 118, 0, 1, 0, 0, 0, 160, 1, 2, 3, 4]);
  const payload = Buffer.from([9, 8, 7, 6]);
  assert.deepEqual(parseRtp(Buffer.concat([header, payload])), { payloadType: 118, payload });

  const withCsrcAndPadding = Buffer.concat([
    Buffer.from([0xa1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]), // V=2, P=1, CC=1
    Buffer.from([0, 0, 0, 5]), // CSRC
    payload,
    Buffer.from([0, 2]), // 2 bytes of padding
  ]);
  assert.deepEqual(parseRtp(withCsrcAndPadding)?.payload, payload);
  assert.equal(parseRtp(Buffer.from([0x40, 0])), null);
  assert.deepEqual(swap16(Buffer.from([1, 2, 3, 4])), Buffer.from([2, 1, 4, 3]));
});

test("pacer plays out at 20 ms per frame, pads the tail, and honours marks and clear", async () => {
  const frames: Buffer[] = [];
  const marks: [string, boolean][] = [];
  const pacer = new AudioPacer(4, 0xff, (frame) => frames.push(Buffer.from(frame)));
  pacer.onMark = (name, cleared) => marks.push([name, cleared]);

  pacer.push(Buffer.from([1, 1, 1, 1, 2, 2]));
  pacer.mark("first");
  const started = Date.now();
  pacer.start();
  await new Promise((r) => setTimeout(r, 70));
  assert.deepEqual(frames[0], Buffer.from([1, 1, 1, 1]));
  assert.deepEqual(frames[1], Buffer.from([2, 2, 0xff, 0xff]), "tail is padded with silence");
  assert.deepEqual(marks, [["first", false]], "mark fires after the audio before it");

  // A long burst is spread out in real time, not sent at once.
  pacer.push(Buffer.alloc(4 * 50, 3)); // 50 frames = 1 s
  pacer.mark("long");
  await new Promise((r) => setTimeout(r, 200));
  const sent = frames.length - 2;
  assert.ok(sent >= 7 && sent <= 13, `expected ~10 frames in 200 ms, got ${sent}`);
  assert.ok(pacer.queuedMs > 500);

  pacer.clear(); // barge-in
  assert.equal(pacer.queuedMs, 0);
  assert.deepEqual(marks.at(-1), ["long", true], "cleared marks are reported");
  const afterClear = frames.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(frames.length, afterClear, "nothing plays after clear");
  pacer.stop();
  assert.ok(Date.now() - started < 1000);
});

test("resampler keeps voice-band tones and removes what 8 kHz can't carry", async () => {
  const { Downsampler, Upsampler } = await import("../src/resample.js");
  const sine = (rate: number, freq: number, seconds: number) =>
    Int16Array.from({ length: rate * seconds }, (_, i) => Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 10000));
  const rms = (s: Int16Array) => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length);
  const freq = (s: Int16Array, rate: number) => {
    let c = 0;
    for (let i = 1; i < s.length; i++) if ((s[i - 1]! < 0) !== (s[i]! < 0)) c++;
    return c / 2 / (s.length / rate);
  };

  // 16 kHz -> 8 kHz, in uneven chunks to exercise the streaming state.
  const down = new Downsampler();
  const input = sine(16000, 440, 1);
  const parts = [input.subarray(0, 333), input.subarray(333, 9001), input.subarray(9001)].map((p) => down.process(p));
  const out8 = Int16Array.from(parts.flatMap((p) => [...p]));
  assert.equal(out8.length, 8000);
  assert.ok(Math.abs(freq(out8.subarray(100), 8000) - 440) < 5, "440 Hz preserved");
  assert.ok(Math.abs(rms(out8.subarray(100)) - rms(input)) / rms(input) < 0.05, "level preserved");

  // A 6 kHz tone can't exist at 8 kHz; it must be filtered, not aliased to 2 kHz.
  const aliased = new Downsampler().process(sine(16000, 6000, 1));
  assert.ok(rms(aliased.subarray(100)) < 300, `6 kHz suppressed (rms ${rms(aliased).toFixed(0)})`);

  // 8 kHz -> 16 kHz.
  const up = new Upsampler().process(sine(8000, 440, 1));
  assert.equal(up.length, 16000);
  assert.ok(Math.abs(freq(up.subarray(200), 16000) - 440) < 5, "upsampled 440 Hz");
  assert.ok(Math.abs(rms(up.subarray(200)) - 7071) / 7071 < 0.05, "upsampled level");
});
