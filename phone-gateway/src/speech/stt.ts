// Speech-to-text for speech `gather`: one finished utterance in, text out.
//
// Engines: Whisper (local, free; via speech/server.py) and Deepgram (hosted,
// ready to switch on with an API key).

export type SttEngineName = "whisper" | "deepgram";

export interface SttResult {
  text: string;
  /** 0..1 */
  confidence: number;
}

export interface SttEngine {
  readonly name: SttEngineName;
  /** `pcm`: mono 16-bit little-endian at 16 kHz. `hints`: words/phrases to expect. */
  transcribe(pcm: Buffer, hints: string | undefined, signal: AbortSignal): Promise<SttResult>;
}

export interface SttConfig {
  engine: SttEngineName;
  whisper: { url: string };
  deepgram?: { apiKey: string; model: string };
}

export class WhisperEngine implements SttEngine {
  readonly name = "whisper";

  constructor(private readonly url: string) {}

  async transcribe(pcm: Buffer, hints: string | undefined, signal: AbortSignal): Promise<SttResult> {
    const response = await fetch(`${this.url}/stt`, {
      method: "POST",
      headers: {
        "content-type": "audio/L16;rate=16000",
        ...(hints ? { "x-hints": encodeURIComponent(hints) } : {}),
      },
      body: new Uint8Array(pcm),
      signal,
    });
    if (!response.ok) throw new Error(`Whisper: ${response.status} ${await response.text()}`);
    return (await response.json()) as SttResult;
  }
}

export class DeepgramEngine implements SttEngine {
  readonly name = "deepgram";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.deepgram.com",
  ) {}

  async transcribe(pcm: Buffer, hints: string | undefined, signal: AbortSignal): Promise<SttResult> {
    const params = new URLSearchParams({
      model: this.model,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      smart_format: "true",
    });
    for (const term of (hints ?? "").split(",").map((t) => t.trim()).filter(Boolean)) {
      params.append("keyterm", term);
    }
    const response = await fetch(`${this.baseUrl}/v1/listen?${params}`, {
      method: "POST",
      headers: { authorization: `Token ${this.apiKey}`, "content-type": "audio/l16" },
      body: new Uint8Array(pcm),
      signal,
    });
    if (!response.ok) throw new Error(`Deepgram: ${response.status} ${await response.text()}`);
    const data = (await response.json()) as {
      results?: { channels?: { alternatives?: { transcript?: string; confidence?: number }[] }[] };
    };
    const best = data.results?.channels?.[0]?.alternatives?.[0];
    return { text: best?.transcript?.trim() ?? "", confidence: best?.confidence ?? 0 };
  }
}

export function createSttEngines(config: SttConfig): Map<SttEngineName, SttEngine> {
  const engines = new Map<SttEngineName, SttEngine>([["whisper", new WhisperEngine(config.whisper.url)]]);
  if (config.deepgram) {
    engines.set("deepgram", new DeepgramEngine(config.deepgram.apiKey, config.deepgram.model));
  }
  return engines;
}
