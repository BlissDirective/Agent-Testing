// In-memory providers and transport for exercising CallSession without APIs.

import type { ServerMessage } from "../src/protocol.js";
import type {
  LlmConversation,
  LlmProvider,
  SttHandlers,
  SttProvider,
  SttStream,
  TtsProvider,
} from "../src/providers/types.js";
import type { CallTransport } from "../src/session.js";
import type { ToolRegistry } from "../src/tools.js";

export class FakeStt implements SttProvider {
  handlers: SttHandlers | null = null;
  received = 0;
  closed = false;

  start(_options: { sampleRate: number }, handlers: SttHandlers): SttStream {
    this.handlers = handlers;
    return {
      write: (pcm) => (this.received += pcm.length),
      close: () => (this.closed = true),
    };
  }

  say(text: string, isFinal = true): void {
    this.handlers?.onTranscript({ text, isFinal });
  }
}

/** One scripted reply: text pieces with an optional pause before each, and tool calls first. */
export interface ScriptedReply {
  tools?: { name: string; input: unknown }[];
  pieces: { text: string; delayMs?: number }[];
}

export class FakeConversation implements LlmConversation {
  history: { role: string; text: string }[] = [];
  interruptedWith: string[] = [];
  aborted = 0;

  constructor(private readonly replies: ScriptedReply[]) {}

  addUserMessage(text: string): void {
    this.history.push({ role: "user", text });
  }

  addAssistantMessage(text: string): void {
    this.history.push({ role: "assistant", text });
  }

  commitInterrupted(spokenText: string): void {
    this.interruptedWith.push(spokenText);
  }

  async *respond({ signal, tools }: { signal: AbortSignal; tools: ToolRegistry }): AsyncIterable<string> {
    const reply = this.replies.shift() ?? { pieces: [{ text: "Okay." }] };
    for (const call of reply.tools ?? []) await tools.run(call.name, call.input);
    let full = "";
    for (const piece of reply.pieces) {
      if (piece.delayMs) await wait(piece.delayMs, signal);
      if (signal.aborted) {
        this.aborted++;
        return;
      }
      full += piece.text;
      yield piece.text;
    }
    this.history.push({ role: "assistant", text: full });
  }
}

export class FakeLlm implements LlmProvider {
  conversation: FakeConversation;

  constructor(replies: ScriptedReply[] = []) {
    this.conversation = new FakeConversation(replies);
  }

  startConversation(): LlmConversation {
    return this.conversation;
  }
}

/** Returns `msPerChunk` of silence for every text chunk, after `latencyMs`. */
export class FakeTts implements TtsProvider {
  spoken: string[] = [];

  constructor(
    private readonly msPerChunk = 50,
    private readonly latencyMs = 5,
  ) {}

  async *synthesize(text: string, { sampleRate, signal }: { sampleRate: number; signal: AbortSignal }) {
    await wait(this.latencyMs, signal);
    if (signal.aborted) return;
    this.spoken.push(text);
    yield Buffer.alloc(Math.round((sampleRate * this.msPerChunk) / 1000) * 2);
  }
}

export class FakeTransport implements CallTransport {
  messages: ServerMessage[] = [];
  audioBytes = 0;
  closed = false;

  sendJson(message: ServerMessage): void {
    this.messages.push(message);
  }

  sendAudio(pcm: Buffer): void {
    this.audioBytes += pcm.length;
  }

  close(): void {
    this.closed = true;
  }

  ofType<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await wait(5);
  }
}
