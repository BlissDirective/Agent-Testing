// One phone call: runs the app's verbs in order against an Asterisk channel,
// tracks status, and reports it via status callbacks.
//
// Lessons taken from jambonz: answer only when a verb needs media; treat a
// hangup at any point (even mid-webhook) as normal; let a redirect replace the
// remaining verbs and interrupt the current one; fire each callback once.

import { randomBytes, randomUUID } from "node:crypto";
import { AriError, type AriClient, type AriEvent } from "./ari.js";
import type { GatewayConfig } from "./config.js";
import { runMediaSession } from "./media.js";
import { listenForSpeech, type Listener } from "./speech/listen.js";
import type { SttEngine, SttEngineName } from "./speech/stt.js";
import { splitSentences, type TtsOptions, type TtsService } from "./speech/tts.js";
import type { Verb, VerbArgs } from "./verbs.js";
import type { AppFormat, CallInfo, WebhookClient } from "./webhook.js";

export type CallStatus =
  | "queued" | "ringing" | "in-progress" | "completed" | "busy" | "failed" | "no-answer" | "canceled";

export interface CallApp {
  url?: string;
  format: AppFormat;
  verbs?: Verb[];
  statusCallback?: string;
}

export interface CallDeps {
  ari: AriClient;
  config: GatewayConfig;
  webhooks: WebhookClient;
  tts: TtsService;
  stt: Map<SttEngineName, SttEngine>;
  /** Route ARI events for this channel/bridge/playback id to the call. */
  claim: (id: string, call: Call) => void;
  release: (call: Call) => void;
  log: (message: string) => void;
}

class Hangup extends Error {}
class Redirected extends Error {}

export function newSid(prefix: string): string {
  return prefix + randomBytes(16).toString("hex");
}

/** Map an Asterisk hangup cause code to a call status. */
export function statusForCause(cause: number | undefined): CallStatus {
  if (cause === 17 || cause === 21) return "busy";
  if (cause === 18 || cause === 19) return "no-answer";
  if (cause === 16 || cause === undefined) return "completed";
  return "failed";
}

export class Call {
  readonly sid = newSid("CA");
  readonly channelId: string;
  readonly parentCallSid?: string;
  status: CallStatus;
  readonly createdAt = new Date();
  answeredAt?: Date;
  endedAt?: Date;

  private verbs: Verb[] = [];
  private current: AbortController = new AbortController();
  private listeners = new Set<(event: AriEvent) => void>();
  private ended = false;
  private recordingCount = 0;
  private dtmfHandler: ((digit: string) => void) | null = null;
  private readonly sentEvents = new Set<string>();

  constructor(
    private readonly deps: CallDeps,
    readonly direction: CallInfo["direction"],
    readonly from: string,
    readonly to: string,
    readonly app: CallApp,
    options: { channelId?: string; status?: CallStatus; parentCallSid?: string } = {},
  ) {
    this.channelId = options.channelId ?? randomUUID();
    this.status = options.status ?? "queued";
    this.parentCallSid = options.parentCallSid;
    deps.claim(this.channelId, this);
  }

  get info(): CallInfo {
    return {
      callSid: this.sid,
      direction: this.direction,
      from: this.from,
      to: this.to,
      callStatus: this.status,
      parentCallSid: this.parentCallSid,
    };
  }

  toJSON() {
    return {
      sid: this.sid,
      direction: this.direction,
      from: this.from,
      to: this.to,
      status: this.status,
      parentCallSid: this.parentCallSid,
      createdAt: this.createdAt.toISOString(),
      answeredAt: this.answeredAt?.toISOString(),
      endedAt: this.endedAt?.toISOString(),
      duration: this.durationSeconds,
    };
  }

  get durationSeconds(): number | undefined {
    if (!this.answeredAt) return undefined;
    return Math.round(((this.endedAt ?? new Date()).getTime() - this.answeredAt.getTime()) / 1000);
  }

  // ---- Lifecycle -----------------------------------------------------------

  /** Place an outbound call (REST API). Verbs run once it's answered. */
  async originate(endpoint: string, callerId: string, timeoutSeconds: number): Promise<void> {
    this.statusEvent("initiated");
    await this.deps.ari.request("POST", "/channels", {
      endpoint,
      app: this.deps.config.ari.app,
      appArgs: `outbound,${this.sid}`,
      callerId,
      timeout: timeoutSeconds,
      channelId: this.channelId,
    });
  }

  /** The channel entered our ARI app: inbound arrival, or outbound answered. */
  async start(): Promise<void> {
    if (this.direction === "inbound") {
      this.setStatus("ringing");
      this.statusEvent("ringing");
    } else {
      this.markAnswered();
    }
    try {
      this.verbs = this.app.verbs ? [...this.app.verbs] : await this.fetchApp(this.app.url!, {});
      await this.runVerbs();
    } catch (error) {
      if (!(error instanceof Hangup)) this.deps.log(`[${this.sid}] app error: ${(error as Error).message}`);
    }
    if (!this.ended) await this.hangupChannel(this.answeredAt ? "normal" : "rejected");
  }

  /** Replace the remaining verbs (REST update or redirect) and interrupt the current one. */
  redirect(verbs: Verb[]): void {
    this.verbs = verbs;
    this.current.abort(new Redirected());
  }

  async hangup(): Promise<void> {
    await this.hangupChannel("normal");
  }

  handleEvent(event: AriEvent): void {
    if (event.type === "ChannelStateChange" && event.channel?.id === this.channelId) {
      if (event.channel.state === "Ringing" && this.status === "queued") {
        this.setStatus("ringing");
        this.statusEvent("ringing");
      }
    }
    if (event.type === "ChannelDtmfReceived" && event.channel?.id === this.channelId && event.digit) {
      this.dtmfHandler?.(event.digit);
    }
    if (
      (event.type === "StasisEnd" || event.type === "ChannelDestroyed") &&
      event.channel?.id === this.channelId
    ) {
      this.onEnded(event.type === "ChannelDestroyed" ? event.cause : 16);
    }
    for (const listener of [...this.listeners]) listener(event);
  }

  private onEnded(cause: number | undefined): void {
    if (this.ended) return;
    this.ended = true;
    this.endedAt = new Date();
    if (this.answeredAt) this.setStatus("completed");
    else this.setStatus(this.direction === "inbound" ? "canceled" : statusForCause(cause));
    this.current.abort(new Hangup());
    this.statusEvent("completed", { callDuration: this.durationSeconds ?? 0 });
    this.deps.release(this);
  }

  private setStatus(status: CallStatus): void {
    this.status = status;
  }

  private markAnswered(): void {
    if (this.answeredAt) return;
    this.answeredAt = new Date();
    this.setStatus("in-progress");
    this.statusEvent("answered");
  }

  private statusEvent(event: string, extra: Record<string, unknown> = {}): void {
    if (this.sentEvents.has(event) || !this.app.statusCallback) return;
    this.sentEvents.add(event);
    this.deps.webhooks.notify(this.app.statusCallback, this.app.format, { event, ...this.info, ...extra });
  }

  // ---- Verb runner -----------------------------------------------------------

  private async runVerbs(): Promise<void> {
    while (this.verbs.length && !this.ended) {
      const verb = this.verbs.shift()!;
      this.current = new AbortController();
      try {
        await this.runVerb(verb, this.current.signal);
      } catch (error) {
        if (error instanceof Redirected || this.current.signal.reason instanceof Redirected) continue;
        if (error instanceof Hangup || this.ended) throw new Hangup();
        throw error;
      }
    }
  }

  private async runVerb(verb: Verb, signal: AbortSignal): Promise<void> {
    this.deps.log(`[${this.sid}] ${verb.name} ${JSON.stringify(verb.args)}`);
    switch (verb.name) {
      case "answer":
        return this.ensureAnswered();
      case "pause":
        return this.sleep(verb.args.length * 1000, signal);
      case "say":
        return this.say(verb.args, signal);
      case "play":
        return this.play(verb.args, signal);
      case "gather":
        return this.gather(verb.args, signal);
      case "connect":
        return this.connect(verb.args, signal);
      case "dial":
        return this.dial(verb.args, signal);
      case "record":
        return this.record(verb.args, signal);
      case "hangup":
        await this.hangupChannel("normal");
        throw new Hangup();
      case "reject":
        await this.hangupChannel(this.answeredAt ? "normal" : verb.args.reason === "busy" ? "busy" : "rejected");
        throw new Hangup();
      case "redirect":
        this.verbs = await this.fetchApp(verb.args.url, {});
        return;
    }
  }

  private async ensureAnswered(): Promise<void> {
    if (this.answeredAt) return;
    await this.ari("POST", `/channels/${this.channelId}/answer`);
    this.markAnswered();
  }

  private async play(args: VerbArgs<"play">, signal: AbortSignal): Promise<void> {
    await this.ensureAnswered();
    for (let i = 0; i < args.loop; i++) await this.playOnce(args.media, signal);
  }

  private async playOnce(media: string, signal: AbortSignal): Promise<void> {
    const id = randomUUID();
    const scope = scoped(signal);
    const finished = this.waitFor(
      (e) => (e.type === "PlaybackFinished" || e.type === "PlaybackFailed") && e.playback?.id === id,
      scope.signal,
    );
    this.deps.claim(id, this);
    try {
      await this.ari("POST", `/channels/${this.channelId}/play/${id}`, { media });
      await finished;
    } finally {
      scope.abort();
      if (signal.aborted) await this.ari("DELETE", `/playbacks/${id}`).catch(() => {});
    }
  }

  private async say(args: VerbArgs<"say">, signal: AbortSignal): Promise<void> {
    await this.ensureAnswered();
    for (let i = 0; i < args.loop; i++) await this.speak(args.text, args, signal);
  }

  /**
   * Speak text: synthesize sentence by sentence, playing each one while the
   * next is prepared, so long messages start quickly. A TTS failure is logged
   * and skipped rather than dropping the call.
   */
  private async speak(text: string, options: TtsOptions, signal: AbortSignal): Promise<void> {
    const sentences = splitSentences(text);
    const scope = scoped(signal);
    const synth = (sentence: string) => {
      const job = this.deps.tts.media(sentence, options, scope.signal);
      job.catch(() => {}); // handled when awaited
      return job;
    };
    try {
      let next = sentences.length ? synth(sentences[0]!) : undefined;
      for (let i = 0; i < sentences.length; i++) {
        let media: string;
        try {
          media = await next!;
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          this.deps.log(`[${this.sid}] say failed: ${(error as Error).message}`);
          return;
        }
        next = i + 1 < sentences.length ? synth(sentences[i + 1]!) : undefined;
        await this.playOnce(media, signal);
      }
    } finally {
      scope.abort();
    }
  }

  /** The prompt of a gather: spoken text, then a sound, either optional. */
  private async playPrompt(args: VerbArgs<"gather">, signal: AbortSignal): Promise<void> {
    if (args.say) await this.speak(args.say, args, signal);
    if (args.play && !signal.aborted) await this.playOnce(args.play, signal);
  }

  private async gather(args: VerbArgs<"gather">, signal: AbortSignal): Promise<void> {
    await this.ensureAnswered();
    const wantsDtmf = args.input.includes("dtmf");
    const wantsSpeech = args.input.includes("speech");
    const scope = scoped(signal);
    const prompt = scoped(scope.signal);
    let digits = "";
    let speaking = false;
    let onSpeechStart = () => {};

    let listener: Listener | undefined;
    if (wantsSpeech) {
      listener = await listenForSpeech({
        ari: this.deps.ari,
        app: this.deps.config.ari.app,
        rtpHost: this.deps.config.rtpHost,
        channelId: this.channelId,
        vad: { endSilence: args.speechTimeout, maxSpeech: args.maxSpeechTime },
        noSpeechTimeout: args.timeout,
        claim: (id) => this.deps.claim(id, this),
        onSpeechStart: () => onSpeechStart(),
        signal: scope.signal,
      });
    }
    const promptDone = this.playPrompt(args, prompt.signal).catch(() => {});

    try {
      const outcome = await new Promise<"digits" | "speech" | "none">((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const wait = () => {
          clearTimeout(timer);
          timer = setTimeout(() => resolve(digits ? "digits" : "none"), args.timeout * 1000);
        };
        // Like Twilio, the timeout starts once the prompt has finished.
        void promptDone.then(() => {
          if (speaking || digits) return;
          listener?.armTimeout();
          if (wantsDtmf) wait();
        });
        onSpeechStart = () => {
          this.deps.log(`[${this.sid}] caller started speaking`);
          speaking = true;
          prompt.abort(); // barge-in: stop the prompt when the caller talks
          clearTimeout(timer);
        };
        if (wantsDtmf) {
          this.dtmfHandler = (digit) => {
            prompt.abort();
            if (listener) void listener.close(); // keypad wins over speech
            if (digit === args.finishOnKey && args.finishOnKey) return resolve(digits ? "digits" : "none");
            digits += digit;
            if (args.numDigits && digits.length >= args.numDigits) return resolve("digits");
            wait();
          };
        }
        void listener?.result.then((audio) => {
          if (audio) resolve("speech");
          else if (!digits) resolve("none");
        });
        scope.signal.addEventListener("abort", () => resolve("none"), { once: true });
      });

      this.dtmfHandler = null;
      prompt.abort();
      if (signal.aborted) throw signal.reason;

      if (outcome === "digits") {
        this.deps.log(`[${this.sid}] gathered digits "${digits}"`);
        if (args.actionHook) await this.runAction(args.actionHook, { digits });
        return;
      }
      if (outcome === "speech") {
        const audio = (await listener!.result)!;
        const result = await this.transcribe(audio, args, signal);
        if (!result) return; // nothing understood: carry on to the next verb, like Twilio
        this.deps.log(`[${this.sid}] gathered speech "${result.text}" (${result.confidence})`);
        if (args.actionHook) {
          await this.runAction(args.actionHook, { speechResult: result.text, confidence: result.confidence });
        }
        return;
      }
      this.deps.log(`[${this.sid}] gather: no input`);
    } finally {
      this.dtmfHandler = null;
      prompt.abort();
      await promptDone;
      await listener?.close();
      scope.abort();
    }
  }

  private async transcribe(audio: Buffer, args: VerbArgs<"gather">, signal: AbortSignal) {
    const engineName = args.speechEngine ?? this.deps.config.stt.engine;
    const engine = this.deps.stt.get(engineName);
    if (!engine) {
      this.deps.log(`[${this.sid}] speech engine ${engineName} is not configured`);
      return null;
    }
    try {
      const result = await engine.transcribe(audio, args.hints, signal);
      return result.text ? result : null;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      this.deps.log(`[${this.sid}] speech recognition failed: ${(error as Error).message}`);
      return null;
    }
  }

  private async connect(args: VerbArgs<"connect">, signal: AbortSignal): Promise<void> {
    await this.ensureAnswered();
    const recordingName = args.record ? this.nextRecordingName() : undefined;
    const result = await runMediaSession({
      ari: this.deps.ari,
      app: this.deps.config.ari.app,
      rtpHost: this.deps.config.rtpHost,
      callSid: this.sid,
      channelId: this.channelId,
      url: args.url,
      protocol: args.protocol,
      parameters: args.parameters,
      recordingName,
      claim: (id) => this.deps.claim(id, this),
      setDtmfHandler: (handler) => (this.dtmfHandler = handler),
      signal,
    });
    this.deps.log(`[${this.sid}] connect ended: ${result.reason}${result.error ? ` (${result.error})` : ""}`);
    if (signal.aborted) throw signal.reason;
    if (args.actionHook) {
      await this.runAction(args.actionHook, {
        connectResult: result.reason,
        ...(recordingName ? this.recordingInfo(recordingName) : {}),
      });
    }
  }

  private async dial(args: VerbArgs<"dial">, signal: AbortSignal): Promise<void> {
    await this.ensureAnswered();
    const legId = randomUUID();
    const dialSid = newSid("CA");
    this.deps.claim(legId, this);
    const scope = scoped(signal);
    const legEnded = this.waitFor((e) => e.type === "ChannelDestroyed" && e.channel?.id === legId, scope.signal);
    const legAnswered = this.waitFor((e) => e.type === "StasisStart" && e.channel?.id === legId, scope.signal);
    const started = Date.now();
    let dialStatus: CallStatus = "failed";
    let bridgeId: string | undefined;
    const recordingName = args.record ? this.nextRecordingName() : undefined;

    try {
      await this.ari("POST", "/channels", {
        endpoint: dialString(args.target, this.deps.config.trunkDialString),
        app: this.deps.config.ari.app,
        appArgs: `dialed,${this.sid}`,
        callerId: args.callerId ?? this.from,
        timeout: args.timeout,
        channelId: legId,
      });
      const first = await Promise.race([legAnswered.then(() => "answered" as const), legEnded]);
      if (first !== "answered") {
        dialStatus = statusForCause((first as AriEvent).cause);
        if (dialStatus === "completed") dialStatus = "no-answer";
      } else {
        dialStatus = "completed";
        const answeredAt = Date.now();
        const bridge = await this.ari<{ id: string }>("POST", "/bridges", { type: "mixing" });
        bridgeId = bridge.id;
        this.deps.claim(bridgeId, this);
        await this.ari("POST", `/bridges/${bridgeId}/addChannel`, { channel: `${this.channelId},${legId}` });
        if (recordingName) {
          await this.ari("POST", `/bridges/${bridgeId}/record`, { name: recordingName, format: "wav", ifExists: "overwrite" });
        }
        await legEnded; // until the far end hangs up (our hangup aborts the wait)
        this.deps.log(`[${this.sid}] dial leg ended after ${Math.round((Date.now() - answeredAt) / 1000)}s`);
      }
    } finally {
      scope.abort();
      if (signal.aborted) await this.ari("DELETE", `/channels/${legId}`).catch(() => {});
      if (bridgeId) await this.ari("DELETE", `/bridges/${bridgeId}`).catch(() => {});
    }
    const result = {
      dialCallStatus: dialStatus,
      dialCallSid: dialSid,
      dialCallDuration: Math.round((Date.now() - started) / 1000),
      ...(recordingName ? this.recordingInfo(recordingName) : {}),
    };
    if (signal.aborted) {
      // Like Twilio: the app still hears how the dial went, even though the caller is gone.
      if (args.actionHook && this.ended) this.notifyAction(args.actionHook, result);
      throw signal.reason;
    }
    if (args.actionHook) await this.runAction(args.actionHook, result);
  }

  private async record(args: VerbArgs<"record">, signal: AbortSignal): Promise<void> {
    await this.ensureAnswered();
    const name = this.nextRecordingName();
    const scope = scoped(signal);
    const finished = this.waitFor(
      (e) => (e.type === "RecordingFinished" || e.type === "RecordingFailed") && e.recording?.name === name,
      scope.signal,
    );
    await this.ari("POST", `/channels/${this.channelId}/record`, {
      name,
      format: "wav",
      maxDurationSeconds: args.maxLength,
      beep: args.beep,
      terminateOn: args.finishOnKey || "none",
      ifExists: "overwrite",
    });
    const isDone = (e: AriEvent) =>
      (e.type === "RecordingFinished" || e.type === "RecordingFailed") && e.recording?.name === name;
    let event: AriEvent;
    try {
      event = await finished;
    } catch (error) {
      if (!this.ended) {
        await this.ari("POST", `/recordings/live/${name}/stop`).catch(() => {});
        throw error;
      }
      // The caller hung up mid-recording (the usual end of a voicemail): the
      // recording is still saved, so report it once Asterisk finishes it.
      const late = await this.waitFor(isDone, AbortSignal.timeout(3000)).catch(() => undefined);
      if (args.actionHook) {
        this.notifyAction(args.actionHook, {
          ...this.recordingInfo(name),
          recordingDuration: late?.recording?.duration ?? 0,
        });
      }
      throw error;
    } finally {
      scope.abort();
    }
    if (args.actionHook) {
      await this.runAction(args.actionHook, {
        ...this.recordingInfo(name),
        recordingDuration: event.recording?.duration ?? 0,
      });
    }
  }

  // ---- Helpers ---------------------------------------------------------------

  private nextRecordingName(): string {
    return `${this.sid}-${++this.recordingCount}`;
  }

  private recordingInfo(name: string) {
    return { recordingSid: name, recordingUrl: `${this.deps.config.publicUrl}/v1/recordings/${name}.wav` };
  }

  /**
   * Report a verb's result to its action hook. If the call is still up, the
   * reply becomes the next verbs. If it ended meanwhile (e.g. the caller hung
   * up the instant a recording finished), the result is still delivered.
   */
  private async runAction(url: string, extra: Record<string, unknown>): Promise<void> {
    if (this.ended) {
      this.notifyAction(url, extra);
      throw new Hangup();
    }
    this.verbs = await this.fetchApp(url, extra);
  }

  /** Tell an action hook what happened when the call is already over (reply ignored). */
  private notifyAction(url: string, extra: Record<string, unknown>): void {
    this.deps.webhooks.notify(url, this.app.format, { ...this.info, ...extra });
  }

  private async fetchApp(url: string, extra: Record<string, unknown>): Promise<Verb[]> {
    if (this.ended) throw new Hangup();
    const verbs = await this.deps.webhooks.fetchVerbs(url, this.app.format, { ...this.info, ...extra });
    if (this.ended) throw new Hangup(); // hung up while the webhook was running
    return verbs;
  }

  private async hangupChannel(reason: "normal" | "busy" | "rejected"): Promise<void> {
    if (this.ended) return;
    await this.ari("DELETE", `/channels/${this.channelId}`, { reason }).catch((error) => {
      if (!(error instanceof AriError && error.status === 404)) throw error;
    });
  }

  private ari<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    return this.deps.ari.request<T>(method, path, query);
  }

  /** Resolve with the next matching event; reject with the abort reason. */
  private waitFor(match: (event: AriEvent) => boolean, signal: AbortSignal): Promise<AriEvent> {
    const promise = new Promise<AriEvent>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const listener = (event: AriEvent) => {
        if (!match(event)) return;
        cleanup();
        resolve(event);
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => {
        this.listeners.delete(listener);
        signal.removeEventListener("abort", onAbort);
      };
      this.listeners.add(listener);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    promise.catch(() => {}); // a waiter that's never awaited must not crash the process
    return promise;
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  }
}

/** Turn a dial target into an Asterisk dial string. */
export function dialString(target: string, trunkDialString: string): string {
  if (/^sips?:/i.test(target)) return `PJSIP/trunk/${target}`;
  if (/^(PJSIP|Local)\//.test(target)) return target;
  const number = target.replace(/[^\d+*#]/g, "");
  if (!number) throw new Error(`Can't dial "${target}"`);
  return trunkDialString.replace("{number}", number);
}

/** A child AbortController that also aborts when `parent` does. */
function scoped(parent: AbortSignal): AbortController {
  const child = new AbortController();
  if (parent.aborted) child.abort(parent.reason);
  else parent.addEventListener("abort", () => child.abort(parent.reason), { once: true });
  return child;
}
