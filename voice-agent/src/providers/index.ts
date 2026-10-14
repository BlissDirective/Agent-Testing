// Builds the provider set from environment variables.

import { ClaudeProvider, EFFORTS, type Effort } from "./claude.js";
import { DeepgramProvider } from "./deepgram.js";
import { ElevenLabsProvider } from "./elevenlabs.js";
import type { Providers } from "./types.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

function effortFromEnv(): Effort | undefined {
  const value = process.env.LLM_EFFORT;
  if (!value) return undefined;
  if (!(EFFORTS as readonly string[]).includes(value)) {
    throw new Error(`LLM_EFFORT must be one of ${EFFORTS.join(", ")}`);
  }
  return value as Effort;
}

export function providersFromEnv(): Providers {
  const stt = process.env.STT_PROVIDER ?? "deepgram";
  const llm = process.env.LLM_PROVIDER ?? "anthropic";
  const tts = process.env.TTS_PROVIDER ?? "elevenlabs";

  if (stt !== "deepgram") throw new Error(`Unknown STT_PROVIDER: ${stt}`);
  if (llm !== "anthropic") throw new Error(`Unknown LLM_PROVIDER: ${llm}`);
  if (tts !== "elevenlabs") throw new Error(`Unknown TTS_PROVIDER: ${tts}`);

  return {
    stt: new DeepgramProvider({ apiKey: required("DEEPGRAM_API_KEY"), model: process.env.DEEPGRAM_MODEL }),
    // The Anthropic SDK reads ANTHROPIC_API_KEY (or an `ant auth login` profile) itself.
    llm: new ClaudeProvider({ model: process.env.LLM_MODEL, effort: effortFromEnv() }),
    tts: new ElevenLabsProvider({
      apiKey: required("ELEVENLABS_API_KEY"),
      voiceId: process.env.ELEVENLABS_VOICE_ID,
      modelId: process.env.ELEVENLABS_MODEL_ID,
    }),
  };
}
