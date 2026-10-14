// Text-to-speech for the `say` verb. Text is synthesized to 16 kHz WAV files
// that Asterisk plays like any other sound; files are cached by content, so a
// repeated phrase (greetings, menus) costs nothing after the first call.
//
// Engines: Piper (local, free; via speech/server.py) and ElevenLabs (hosted).
// If ElevenLabs fails or isn't configured, the gateway falls back to Piper so
// the caller still hears the message.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type TtsEngineName = "piper" | "elevenlabs";

export interface TtsOptions {
  engine?: TtsEngineName;
  /** Piper voice name (e.g. en_US-lessac-medium) or ElevenLabs voice id. */
  voice?: string;
  /** 0.5 (slow) to 2.0 (fast). */
  speed?: number;
}

export interface TtsEngine {
  readonly name: TtsEngineName;
  /** Returns mono 16-bit PCM, little-endian, 16 kHz. */
  synthesize(text: string, voice: string | undefined, speed: number, signal: AbortSignal): Promise<Buffer>;
}

export interface TtsConfig {
  engine: TtsEngineName;
  cacheDir: string;
  piper: { url: string; voice?: string };
  elevenlabs?: { apiKey: string; voiceId: string; modelId: string };
}

/** Extract PCM from a 16-bit mono WAV file. */
export function wavToPcm(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  let offset = 12;
  let sampleRate = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") sampleRate = wav.readUInt32LE(offset + 12);
    if (id === "data") return { pcm: wav.subarray(offset + 8, offset + 8 + size), sampleRate };
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV file has no data");
}

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class PiperEngine implements TtsEngine {
  readonly name = "piper";

  constructor(
    private readonly url: string,
    private readonly defaultVoice?: string,
  ) {}

  async synthesize(text: string, voice: string | undefined, speed: number, signal: AbortSignal): Promise<Buffer> {
    const response = await fetch(`${this.url}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: voice ?? this.defaultVoice, speed, sampleRate: 16000 }),
      signal,
    });
    if (!response.ok) throw new Error(`Piper: ${response.status} ${await response.text()}`);
    const { pcm, sampleRate } = wavToPcm(Buffer.from(await response.arrayBuffer()));
    if (sampleRate !== 16000) throw new Error(`Piper returned ${sampleRate} Hz audio`);
    return pcm;
  }
}

export class ElevenLabsEngine implements TtsEngine {
  readonly name = "elevenlabs";

  constructor(
    private readonly apiKey: string,
    private readonly defaultVoice: string,
    private readonly modelId: string,
    private readonly baseUrl = "https://api.elevenlabs.io",
  ) {}

  async synthesize(text: string, voice: string | undefined, speed: number, signal: AbortSignal): Promise<Buffer> {
    const voiceId = encodeURIComponent(voice ?? this.defaultVoice);
    const response = await fetch(`${this.baseUrl}/v1/text-to-speech/${voiceId}?output_format=pcm_16000`, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: this.modelId, voice_settings: { speed } }),
      signal,
    });
    if (!response.ok) throw new Error(`ElevenLabs: ${response.status} ${await response.text()}`);
    const pcm = Buffer.from(await response.arrayBuffer());
    return pcm.subarray(0, pcm.length - (pcm.length % 2));
  }
}

/** Splits text into sentences so the first can play while the rest are synthesized. */
export function splitSentences(text: string, maxLength = 300): string[] {
  const pieces = text.replace(/\s+/g, " ").trim().match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [];
  const sentences: string[] = [];
  for (const raw of pieces) {
    let piece = raw.trim();
    while (piece.length > maxLength) {
      const cut = piece.lastIndexOf(" ", maxLength);
      const at = cut > 0 ? cut : maxLength;
      sentences.push(piece.slice(0, at).trim());
      piece = piece.slice(at).trim();
    }
    if (piece) sentences.push(piece);
  }
  return sentences;
}

export class TtsService {
  private readonly engines = new Map<TtsEngineName, TtsEngine>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly config: TtsConfig,
    private readonly log: (message: string) => void,
    engines?: TtsEngine[],
  ) {
    for (const engine of engines ?? defaultEngines(config)) this.engines.set(engine.name, engine);
  }

  /**
   * Make sure `text` is synthesized and return the Asterisk media URI to play
   * it (sound:<path without extension>; the file is <path>.wav16).
   */
  async media(text: string, options: TtsOptions, signal: AbortSignal): Promise<string> {
    const wanted = options.engine ?? this.config.engine;
    try {
      return await this.cached(wanted, text, options, signal);
    } catch (error) {
      if (signal.aborted || wanted === "piper" || !this.engines.has("piper")) throw error;
      this.log(`TTS ${wanted} failed (${(error as Error).message}); falling back to piper`);
      return this.cached("piper", text, { speed: options.speed }, signal);
    }
  }

  private async cached(engineName: TtsEngineName, text: string, options: TtsOptions, signal: AbortSignal) {
    const engine = this.engines.get(engineName);
    if (!engine) throw new Error(`TTS engine ${engineName} is not configured`);
    const speed = options.speed ?? 1;
    const key = createHash("sha256")
      .update(JSON.stringify([engineName, options.voice ?? "", speed, text]))
      .digest("hex")
      .slice(0, 32);
    const base = path.resolve(this.config.cacheDir, key);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const job = (async () => {
      if (await stat(`${base}.wav16`).catch(() => null)) return `sound:${base}`;
      const started = Date.now();
      const pcm = await engine.synthesize(text, options.voice, speed, signal);
      await mkdir(this.config.cacheDir, { recursive: true });
      const temp = `${base}.${randomUUID()}.tmp`;
      await writeFile(temp, pcmToWav(pcm, 16000));
      await rename(temp, `${base}.wav16`); // atomic: never play a half-written file
      this.log(`TTS ${engineName}: ${text.length} chars in ${Date.now() - started} ms`);
      return `sound:${base}`;
    })();
    this.inFlight.set(key, job);
    try {
      return await job;
    } finally {
      this.inFlight.delete(key);
    }
  }
}

function defaultEngines(config: TtsConfig): TtsEngine[] {
  const engines: TtsEngine[] = [new PiperEngine(config.piper.url, config.piper.voice)];
  if (config.elevenlabs) {
    const { apiKey, voiceId, modelId } = config.elevenlabs;
    engines.push(new ElevenLabsEngine(apiKey, voiceId, modelId));
  }
  return engines;
}
