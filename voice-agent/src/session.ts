// One live call: wires speech-to-text, the LLM and text-to-speech together and
// decides when the assistant starts and stops talking.
//
//   user audio -> STT -> endpointing -> LLM (streamed) -> sentence chunker
//              -> TTS (streamed) -> audio out, tracked against playback time
//
// While the assistant is talking, transcripts are checked for barge-in; an
// interruption aborts the LLM and TTS and tells the client to drop its queued
// audio.

import { randomUUID } from "node:crypto";
import { SentenceChunker } from "./chunker.js";
import type { AssistantConfig } from "./config.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import type { LlmConversation, Providers, SttStream, Transcript } from "./providers/types.js";
import { builtinTools, ToolRegistry, type ToolDefinition } from "./tools.js";
import { endpointDelaySeconds, isAcknowledgement, shouldInterrupt } from "./turn-taking.js";

/** Where the session sends its output (a WebSocket, or a fake in tests). */
export interface CallTransport {
  sendJson(message: ServerMessage): void;
  sendAudio(pcm: Buffer): void;
  close(): void;
}

interface SpokenSegment {
  text: string;
  /** When this segment's audio starts playing on the client (ms epoch). */
  playsAtMs: number;
}

interface Turn {
  id: number;
  abort: AbortController;
  /** True when the reply comes from the LLM (false for scripted speech). */
  generated: boolean;
  generationDone: boolean;
  audioStarted: boolean;
  segments: SpokenSegment[];
}

export class CallSession {
  readonly id = randomUUID();
  private readonly conversation: LlmConversation;
  private readonly tools: ToolRegistry;
  private stt: SttStream | null = null;

  private turnCounter = 0;
  private turn: Turn | null = null;
  /** When all audio sent so far finishes playing on the client (ms epoch). */
  private playoutEndMs = 0;
  private playoutTimer: NodeJS.Timeout | undefined;

  /** Finalized user speech not yet answered. */
  private pendingUserText = "";
  private endpointTimer: NodeJS.Timeout | undefined;
  /** Finalized speech heard while the assistant was talking. */
  private bargeInText = "";
  /** Don't start a new reply before this time (interruption backoff). */
  private notBeforeMs = 0;
  /** Context for the next reply if the user cut off a finished reply. */
  private interruptedNote = "";

  private endCallReason: string | null = null;
  private maxDurationTimer: NodeJS.Timeout | undefined;
  private ended = false;

  constructor(
    private readonly config: AssistantConfig,
    private readonly providers: Providers,
    private readonly transport: CallTransport,
    tools: ToolDefinition<any>[] = builtinTools,
  ) {
    this.conversation = providers.llm.startConversation(config.systemPrompt);
    this.tools = new ToolRegistry(
      tools,
      {
        endCall: (reason) => {
          this.endCallReason = reason;
        },
      },
      (name, input) =>
        this.transport.sendJson({ type: "tool-call", turnId: this.turn?.id ?? 0, name, input }),
    );
  }

  start(): void {
    this.stt = this.providers.stt.start(
      { sampleRate: this.config.sampleRate },
      {
        onTranscript: (t) => this.onTranscript(t),
        onSpeechStarted: () => this.onSpeechStarted(),
        onError: (error) => this.fail(error),
      },
    );
    this.maxDurationTimer = setTimeout(
      () => this.end("exceeded-max-duration"),
      this.config.maxDurationSeconds * 1000,
    ).unref(); // don't keep the process alive on its own
    this.transport.sendJson({ type: "listening", callId: this.id, sampleRate: this.config.sampleRate });
    this.transport.sendJson({ type: "status-update", status: "in-progress" });

    if (this.config.firstMessage) {
      // The conversation must open with a user turn.
      this.conversation.addUserMessage("[The call has connected.]");
      this.speakScripted(this.config.firstMessage);
    }
  }

  handleAudio(pcm: Buffer): void {
    if (!this.ended) this.stt?.write(pcm);
  }

  handleMessage(message: ClientMessage): void {
    if (this.ended) return;
    switch (message.type) {
      case "say":
        this.speakScripted(message.message);
        break;
      case "add-message":
        if (message.role === "user") this.conversation.addUserMessage(message.content);
        else this.conversation.addAssistantMessage(message.content);
        if (message.triggerResponse) void this.runGeneratedTurn();
        break;
      case "end-call":
        this.end("customer-ended-call");
        break;
    }
  }

  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.turn?.abort.abort();
    this.turn = null;
    clearTimeout(this.endpointTimer);
    clearTimeout(this.playoutTimer);
    clearTimeout(this.maxDurationTimer);
    this.stt?.close();
    this.transport.sendJson({ type: "status-update", status: "ended", endedReason: reason });
    this.transport.close();
  }

  // ---- Listening ---------------------------------------------------------

  private assistantIsActive(): boolean {
    return this.turn !== null || Date.now() < this.playoutEndMs;
  }

  private onSpeechStarted(): void {
    if (this.assistantIsActive() && this.config.stopSpeakingPlan.numWords === 0) {
      this.interrupt();
    }
  }

  private onTranscript({ text, isFinal }: Transcript): void {
    if (this.ended || !text.trim()) return;
    this.transport.sendJson({
      type: "transcript",
      role: "user",
      transcriptType: isFinal ? "final" : "partial",
      transcript: text,
    });

    if (this.assistantIsActive()) {
      const heard = `${this.bargeInText} ${text}`.trim();
      if (!shouldInterrupt(heard, this.config.stopSpeakingPlan)) {
        // Too short, or just "uh-huh": let the assistant keep talking.
        // Acknowledgements are dropped; other words count toward a barge-in.
        if (isFinal && !isAcknowledgement(text, this.config.stopSpeakingPlan)) {
          this.bargeInText = heard;
        }
        return;
      }
      this.interrupt();
      // The words that interrupted become the start of the user's turn.
      this.pendingUserText = `${this.pendingUserText} ${this.bargeInText}`.trim();
      this.bargeInText = "";
    }

    clearTimeout(this.endpointTimer);
    if (!isFinal) return; // still talking; the final transcript re-arms the timer
    this.pendingUserText = `${this.pendingUserText} ${text}`.trim();
    this.armEndpointTimer();
  }

  private armEndpointTimer(): void {
    clearTimeout(this.endpointTimer);
    const delayMs = Math.max(
      endpointDelaySeconds(this.pendingUserText, this.config.startSpeakingPlan) * 1000,
      this.notBeforeMs - Date.now(),
    );
    this.endpointTimer = setTimeout(() => this.onEndpoint(), delayMs);
  }

  private onEndpoint(): void {
    const text = this.pendingUserText;
    if (!text || this.ended) return;
    this.pendingUserText = "";
    const note = this.interruptedNote;
    this.interruptedNote = "";
    this.conversation.addUserMessage(note ? `${note}\n${text}` : text);
    void this.runGeneratedTurn();
  }

  // ---- Speaking ----------------------------------------------------------

  private newTurn(generated: boolean): Turn {
    this.turn?.abort.abort();
    this.bargeInText = "";
    this.turn = {
      id: ++this.turnCounter,
      abort: new AbortController(),
      generated,
      generationDone: false,
      audioStarted: false,
      segments: [],
    };
    return this.turn;
  }

  private speakScripted(text: string): void {
    const turn = this.newTurn(false);
    this.conversation.addAssistantMessage(text);
    this.transport.sendJson({ type: "transcript", role: "assistant", transcriptType: "final", transcript: text });
    void this.speakChunks(turn, oneChunk(text));
  }

  private async runGeneratedTurn(): Promise<void> {
    const turn = this.newTurn(true);
    const { signal } = turn.abort;
    const chunker = new SentenceChunker();
    const queue = new ChunkQueue();
    const speaking = this.speakChunks(turn, queue);

    try {
      for await (const delta of this.conversation.respond({ signal, tools: this.tools })) {
        if (signal.aborted) return;
        this.transport.sendJson({ type: "model-output", turnId: turn.id, output: delta });
        for (const chunk of chunker.push(delta)) queue.push(chunk);
      }
      for (const chunk of chunker.flush()) queue.push(chunk);
    } catch (error) {
      if (!signal.aborted) this.fail(error as Error);
      return;
    } finally {
      queue.close();
    }
    await speaking;
  }

  /** Synthesize chunks in order and stream the audio to the client. */
  private async speakChunks(turn: Turn, chunks: AsyncIterable<string>): Promise<void> {
    const { signal } = turn.abort;
    try {
      for await (const text of chunks) {
        let first = true;
        for await (const pcm of this.providers.tts.synthesize(text, {
          sampleRate: this.config.sampleRate,
          signal,
        })) {
          if (signal.aborted) return;
          if (!turn.audioStarted) {
            turn.audioStarted = true;
            const waitMs = this.config.startSpeakingPlan.waitSeconds * 1000;
            if (waitMs > 0) await sleep(waitMs, signal);
            if (signal.aborted) return;
            this.transport.sendJson({
              type: "speech-update",
              role: "assistant",
              status: "started",
              turnId: turn.id,
            });
          }
          const playsAtMs = this.queueAudio(pcm);
          if (first) {
            turn.segments.push({ text, playsAtMs });
            first = false;
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) this.fail(error as Error);
      return;
    }
    turn.generationDone = true;
    this.schedulePlayoutCheck();
  }

  /** Send audio and return when it will start playing on the client. */
  private queueAudio(pcm: Buffer): number {
    const now = Date.now();
    const startsAt = Math.max(now, this.playoutEndMs);
    this.playoutEndMs = startsAt + pcmDurationMs(pcm, this.config.sampleRate);
    this.transport.sendAudio(pcm);
    this.schedulePlayoutCheck();
    return startsAt;
  }

  private schedulePlayoutCheck(): void {
    clearTimeout(this.playoutTimer);
    this.playoutTimer = setTimeout(
      () => this.onPlayoutCheck(),
      Math.max(0, this.playoutEndMs - Date.now()),
    );
  }

  private onPlayoutCheck(): void {
    const turn = this.turn;
    if (!turn || !turn.generationDone || Date.now() < this.playoutEndMs) return;
    this.turn = null;
    this.bargeInText = "";
    if (turn.audioStarted) {
      this.transport.sendJson({ type: "speech-update", role: "assistant", status: "stopped", turnId: turn.id });
    }
    if (this.endCallReason) this.end(`assistant-ended-call: ${this.endCallReason}`);
    // Speech that finished while the assistant talked (but didn't interrupt)
    // is answered now.
    else if (this.pendingUserText) this.armEndpointTimer();
  }

  private interrupt(): void {
    const turn = this.turn;
    if (!turn) {
      this.playoutEndMs = 0;
      return;
    }
    turn.abort.abort();
    this.turn = null;
    clearTimeout(this.playoutTimer);
    const now = Date.now();
    this.playoutEndMs = 0;
    this.notBeforeMs = now + this.config.stopSpeakingPlan.backoffSeconds * 1000;
    this.transport.sendJson({ type: "user-interrupted", turnId: turn.id });
    if (turn.audioStarted) {
      this.transport.sendJson({ type: "speech-update", role: "assistant", status: "stopped", turnId: turn.id });
    }

    // Approximate what the user actually heard: segments that started playing.
    const heard = turn.segments
      .filter((s) => s.playsAtMs <= now)
      .map((s) => s.text)
      .join(" ");
    if (!turn.generated) return; // scripted text is already in history
    if (turn.generationDone) {
      // The full reply is already in history; tell the model how far it got.
      this.interruptedNote = heard
        ? `[You were interrupted. The caller only heard: "${heard}"]`
        : "[You were interrupted before the caller heard your reply.]";
    } else {
      this.conversation.commitInterrupted(heard);
    }
  }

  private fail(error: Error): void {
    if (this.ended) return;
    console.error(`[call ${this.id}]`, error);
    this.transport.sendJson({ type: "error", message: error.message });
    this.end("pipeline-error");
  }
}

function pcmDurationMs(pcm: Buffer, sampleRate: number): number {
  return (pcm.length / 2 / sampleRate) * 1000;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function* oneChunk(text: string): AsyncIterable<string> {
  yield text;
}

/** An async queue of TTS chunks, filled by the LLM loop and drained in order. */
class ChunkQueue implements AsyncIterable<string> {
  private readonly items: string[] = [];
  private closed = false;
  private wake: (() => void) | null = null;

  push(item: string): void {
    this.items.push(item);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}
