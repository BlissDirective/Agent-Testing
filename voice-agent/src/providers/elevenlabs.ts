// Text-to-speech provider: ElevenLabs streaming HTTP endpoint, raw PCM out.

import type { TtsProvider } from "./types.js";

export interface ElevenLabsOptions {
  apiKey: string;
  /** Defaults to a premade voice; pick another in the ElevenLabs voice library. */
  voiceId?: string;
  /** Flash models trade a little quality for the lowest latency. */
  modelId?: string;
}

const SUPPORTED_RATES = new Set([8000, 16000, 22050, 24000, 44100]);

export class ElevenLabsProvider implements TtsProvider {
  constructor(private readonly options: ElevenLabsOptions) {}

  async *synthesize(
    text: string,
    { sampleRate, signal }: { sampleRate: number; signal: AbortSignal },
  ): AsyncIterable<Buffer> {
    if (!SUPPORTED_RATES.has(sampleRate)) {
      throw new Error(`ElevenLabs does not output PCM at ${sampleRate} Hz`);
    }
    const voiceId = this.options.voiceId ?? "21m00Tcm4TlvDq8ikWAM";
    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream` +
      `?output_format=pcm_${sampleRate}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.options.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: this.options.modelId ?? "eleven_flash_v2_5" }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`ElevenLabs TTS failed: ${response.status} ${await response.text()}`);
    }

    // PCM samples are 2 bytes; never split one across chunks.
    let carry: Buffer = Buffer.alloc(0);
    for await (const piece of response.body) {
      const bytes = Buffer.concat([carry, Buffer.from(piece)]);
      const even = bytes.length - (bytes.length % 2);
      carry = bytes.subarray(even);
      if (even > 0) yield bytes.subarray(0, even);
    }
  }
}
