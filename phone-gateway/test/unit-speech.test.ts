import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { UtteranceDetector } from "../src/speech/listen.js";
import { DeepgramEngine, WhisperEngine } from "../src/speech/stt.js";
import { pcmToWav, splitSentences, TtsService, wavToPcm, type TtsEngine } from "../src/speech/tts.js";
import { twimlToVerbs } from "../src/twiml.js";
import { parseVerbs } from "../src/verbs.js";

test("say verb and TwiML <Say>, including SSML and speech <Gather>", () => {
  assert.deepEqual(parseVerbs([{ say: { text: "Hello" } }])[0], { name: "say", args: { text: "Hello", loop: 1 } });
  assert.throws(() => parseVerbs([{ say: { text: "" } }]));
  assert.throws(() => parseVerbs([{ say: { text: "x", engine: "polly" } }]));

  const verbs = twimlToVerbs(`<Response>
      <Say voice="Polly.Joanna" loop="2">Welcome to <emphasis>Acme</emphasis>.<break time="1s"/>How can we help?</Say>
      <Say voice="en_GB-alan-medium">Cheerio</Say>
      <Gather input="speech dtmf" speechTimeout="auto" hints="sales, support" action="https://app.example/ans">
        <Say>Say sales or support.</Say>
      </Gather>
    </Response>`);
  assert.deepEqual(verbs[0], { name: "say", args: { text: "Welcome to Acme. How can we help?", loop: 2, voice: undefined } });
  assert.equal((verbs[1]!.args as { voice?: string }).voice, "en_GB-alan-medium");
  const gather = verbs[2]!.args as Record<string, unknown>;
  assert.deepEqual(gather.input, ["speech", "dtmf"]);
  assert.equal(gather.say, "Say sales or support.");
  assert.equal(gather.hints, "sales, support");
  assert.equal(gather.speechTimeout, 1.2);
});

test("sentences are split for faster first audio", () => {
  assert.deepEqual(splitSentences("Hi there!  Your order shipped. Track it online"), [
    "Hi there!", "Your order shipped.", "Track it online",
  ]);
  const long = splitSentences("word ".repeat(200), 100);
  assert.ok(long.every((s) => s.length <= 100) && long.length > 5);
  assert.deepEqual(splitSentences("   "), []);
});

test("WAV round trip", () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
  assert.deepEqual(wavToPcm(pcmToWav(pcm, 16000)), { pcm, sampleRate: 16000 });
  assert.throws(() => wavToPcm(Buffer.from("not a wav file at all, nope")));
});

test("TTS service caches by content and falls back to Piper", async () => {
  const calls: string[] = [];
  const fake = (name: "piper" | "elevenlabs", fail = false): TtsEngine => ({
    name,
    async synthesize(text) {
      calls.push(`${name}:${text}`);
      if (fail) throw new Error("quota exceeded");
      return Buffer.alloc(320);
    },
  });
  const dir = mkdtempSync(path.join(tmpdir(), "tts-"));
  const logs: string[] = [];
  const tts = new TtsService(
    { engine: "elevenlabs", cacheDir: dir, piper: { url: "http://unused" } },
    (m) => logs.push(m),
    [fake("piper"), fake("elevenlabs", true)],
  );
  const signal = new AbortController().signal;

  const media = await tts.media("Hello", {}, signal);
  assert.match(media, /^sound:\//);
  assert.deepEqual(calls, ["elevenlabs:Hello", "piper:Hello"], "fell back to piper");
  assert.ok(logs.some((l) => l.includes("falling back to piper")));
  const wav = await readFile(`${media.slice("sound:".length)}.wav16`);
  assert.equal(wavToPcm(wav).sampleRate, 16000);

  calls.length = 0;
  assert.equal(await tts.media("Hello", { engine: "piper" }, signal), media, "same text, same file");
  assert.deepEqual(calls, [], "served from cache");
  const [a, b] = await Promise.all([tts.media("Once", { engine: "piper" }, signal), tts.media("Once", { engine: "piper" }, signal)]);
  assert.equal(a, b);
  assert.deepEqual(calls, ["piper:Once"], "concurrent requests share one synthesis");
});

test("utterance detector finds the start and end of an answer", () => {
  const frame = (amplitude: number) => Int16Array.from({ length: 160 }, (_, i) => Math.round(Math.sin(i / 3) * amplitude));
  const vad = new UtteranceDetector({ endSilence: 0.4, maxSpeech: 10 });
  const events: string[] = [];
  const feed = (amplitude: number, frames: number) => {
    for (let i = 0; i < frames; i++) {
      const event = vad.push(frame(amplitude));
      if (event) events.push(event);
    }
  };
  feed(50, 50); // 1 s of quiet line noise
  assert.deepEqual(events, []);
  feed(5000, 40); // 0.8 s of speech
  assert.deepEqual(events, ["start"]);
  feed(50, 25); // 0.5 s of silence ends it
  assert.deepEqual(events, ["start", "end"]);
  const seconds = vad.audio().length / 8000;
  assert.ok(seconds > 0.8 && seconds < 1.6, `utterance length ${seconds}s`);

  const capped = new UtteranceDetector({ endSilence: 5, maxSpeech: 1 });
  let ended = false;
  for (let i = 0; i < 100 && !ended; i++) ended = capped.push(frame(5000)) === "end";
  assert.ok(ended, "maxSpeech caps a never-ending answer");
});

test("Whisper and Deepgram engines send audio and parse results", async () => {
  const seen: { path: string; headers: Record<string, unknown>; bytes: number }[] = [];
  const server = createServer(async (req, res) => {
    let bytes = 0;
    for await (const chunk of req) bytes += (chunk as Buffer).length;
    seen.push({ path: req.url ?? "", headers: req.headers, bytes });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.startsWith("/stt")) res.end(JSON.stringify({ text: "sales", confidence: 0.9 }));
    else res.end(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: " Support please ", confidence: 0.97 }] }] } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signal = new AbortController().signal;
  try {
    assert.deepEqual(await new WhisperEngine(base).transcribe(Buffer.alloc(3200), "sales, support", signal), {
      text: "sales", confidence: 0.9,
    });
    assert.equal(seen[0]!.headers["content-type"], "audio/L16;rate=16000");
    assert.equal(decodeURIComponent(String(seen[0]!.headers["x-hints"])), "sales, support");
    assert.equal(seen[0]!.bytes, 3200);

    const deepgram = new DeepgramEngine("dg-key", "nova-3", base);
    assert.deepEqual(await deepgram.transcribe(Buffer.alloc(3200), "sales, support", signal), {
      text: "Support please", confidence: 0.97,
    });
    const url = new URL(seen[1]!.path, base);
    assert.equal(url.pathname, "/v1/listen");
    assert.equal(url.searchParams.get("sample_rate"), "16000");
    assert.deepEqual(url.searchParams.getAll("keyterm"), ["sales", "support"]);
    assert.equal(seen[1]!.headers.authorization, "Token dg-key");
  } finally {
    server.close();
  }
});
