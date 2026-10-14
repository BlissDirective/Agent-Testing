// Provider interfaces. Every speech and language model plugs in through one of
// these, so hosted APIs and local models are interchangeable.

import type { ToolRegistry } from "../tools.js";

/** One transcription result from a streaming speech-to-text session. */
export interface Transcript {
  text: string;
  /** false = interim guess that may still change; true = final for this segment. */
  isFinal: boolean;
}

export interface SttHandlers {
  onTranscript(transcript: Transcript): void;
  /** Voice activity detected (fires before any words are transcribed). */
  onSpeechStarted(): void;
  onError(error: Error): void;
}

export interface SttStream {
  /** Raw PCM, signed 16-bit little-endian, mono, at the session sample rate. */
  write(pcm: Buffer): void;
  close(): void;
}

export interface SttProvider {
  start(options: { sampleRate: number }, handlers: SttHandlers): SttStream;
}

export interface TtsProvider {
  /**
   * Stream speech for `text` as raw PCM (s16le, mono, `sampleRate`).
   * Must stop promptly when `signal` aborts.
   */
  synthesize(
    text: string,
    options: { sampleRate: number; signal: AbortSignal },
  ): AsyncIterable<Buffer>;
}

/**
 * A conversation with an LLM. The provider owns the history format (Anthropic,
 * OpenAI-style, ...); the session only deals in plain text.
 */
export interface LlmConversation {
  addUserMessage(text: string): void;
  addAssistantMessage(text: string): void;
  /**
   * Generate the assistant's reply as streamed text deltas, running any tool
   * calls through `tools` along the way. The finished reply is committed to
   * history. If `signal` aborts, nothing from this reply is committed; call
   * `commitInterrupted` with what the user actually heard.
   */
  respond(options: { signal: AbortSignal; tools: ToolRegistry }): AsyncIterable<string>;
  commitInterrupted(spokenText: string): void;
}

export interface LlmProvider {
  startConversation(systemPrompt: string): LlmConversation;
}

export interface Providers {
  stt: SttProvider;
  llm: LlmProvider;
  tts: TtsProvider;
}
