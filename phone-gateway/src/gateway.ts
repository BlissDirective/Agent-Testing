// Ties it together: receives ARI events, creates a Call for each new channel,
// and routes later events (playbacks, recordings, bridges, extra legs) to the
// call that owns them. Also owns the call records (src/store.ts) and the
// graceful shutdown (drain).

import { AriClient, type AriEvent } from "./ari.js";
import { Call, dialString, newSid, type CallApp, type CallDeps } from "./call.js";
import { appFor, type GatewayConfig } from "./config.js";
import { CallStore } from "./store.js";
import { parseVerbs } from "./verbs.js";
import { createSttEngines } from "./speech/stt.js";
import { TtsService } from "./speech/tts.js";
import { WebhookClient } from "./webhook.js";

const KEEP_FINISHED_CALLS = 1000;
const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;
/** After the goodbye starts, how long to wait before hanging up regardless. */
const GOODBYE_GRACE_MS = 20_000;

/** Thrown for new outbound calls while the gateway is shutting down. */
export class DrainingError extends Error {}

export interface DrainResult {
  /** Calls that finished on their own during the drain. */
  finishedNaturally: number;
  /** Calls the gateway ended at the deadline (after the goodbye). */
  endedByGateway: number;
}

export class Gateway {
  readonly ari: AriClient;
  readonly webhooks: WebhookClient;
  readonly calls = new Map<string, Call>();
  readonly store: CallStore;
  private readonly routes = new Map<string, Call>();
  private readonly deps: CallDeps;
  private purgeTimer: NodeJS.Timeout | undefined;
  private drainPromise: Promise<DrainResult> | null = null;

  constructor(
    readonly config: GatewayConfig,
    private readonly log: (message: string) => void = (m) => console.log(m),
  ) {
    this.ari = new AriClient(config.ari);
    this.webhooks = new WebhookClient(config.webhookSecret);
    this.store = new CallStore(config.database);
    this.deps = {
      ari: this.ari,
      config,
      webhooks: this.webhooks,
      tts: new TtsService(config.tts, log),
      stt: createSttEngines(config.stt),
      claim: (id, call) => this.routes.set(id, call),
      release: (call) => this.release(call),
      onChange: (call) => this.store.saveCall(call.toJSON()),
      onRecording: (recording) => this.store.saveRecording(recording),
      log,
    };
  }

  get draining(): boolean {
    return this.drainPromise !== null;
  }

  /** Calls that haven't ended yet. */
  get activeCalls(): Call[] {
    return [...this.calls.values()].filter((call) => !call.endedAt);
  }

  async start(): Promise<void> {
    // A previous run that crashed or was killed may have left calls "live".
    const orphans = this.store.closeOrphans("gateway-restart");
    if (orphans.length) this.log(`Marked ${orphans.length} unfinished call(s) from the last run as failed`);

    this.ari.on("event", (event: AriEvent) => this.onEvent(event));
    this.ari.on("disconnected", () => this.log("ARI disconnected; reconnecting"));
    this.ari.on("connected", () => this.log("ARI connected"));
    await this.ari.connect();
    await this.hangUpLeftoverChannels();

    await this.purgeOldRecords();
    this.purgeTimer = setInterval(() => void this.purgeOldRecords(), PURGE_EVERY_MS).unref();
  }

  stop(): void {
    clearInterval(this.purgeTimer);
    this.ari.close();
    this.store.close();
  }

  /**
   * Graceful shutdown. New calls get a busy signal and new outbound calls are
   * refused; calls in progress may finish for up to `drainSeconds`. Calls
   * still going then hear the goodbye message and are hung up.
   */
  drain(options: { drainSeconds?: number; goodbye?: string } = {}): Promise<DrainResult> {
    this.drainPromise ??= this.runDrain(
      options.drainSeconds ?? this.config.shutdown.drainSeconds,
      options.goodbye ?? this.config.shutdown.goodbye,
    );
    return this.drainPromise;
  }

  private async runDrain(drainSeconds: number, goodbye: string): Promise<DrainResult> {
    const startedWith = this.activeCalls;
    this.log(`Draining: ${startedWith.length} call(s) in progress, waiting up to ${drainSeconds}s`);
    await waitUntil(() => this.activeCalls.length === 0, drainSeconds * 1000);

    const leftover = this.activeCalls;
    if (leftover.length) {
      this.log(`Drain time is up: ending ${leftover.length} call(s) with a goodbye`);
      for (const call of leftover) {
        call.endedReason = "gateway-shutdown";
        if (call.answeredAt) call.redirect(parseVerbs([{ say: { text: goodbye } }, { hangup: {} }]));
        else void call.hangup().catch(() => {}); // still ringing: nothing to say goodbye to
      }
      await waitUntil(() => this.activeCalls.length === 0, GOODBYE_GRACE_MS);
      for (const call of this.activeCalls) await call.hangup().catch(() => {});
      await waitUntil(() => this.activeCalls.length === 0, 5000);
    }
    const result = {
      finishedNaturally: startedWith.length - leftover.length,
      endedByGateway: leftover.length,
    };
    this.log(`Drained: ${result.finishedNaturally} finished on their own, ${result.endedByGateway} ended by the gateway`);
    return result;
  }

  /** Place an outbound call (REST API). */
  async createCall(options: { to: string; from: string; app: CallApp; timeout?: number }): Promise<Call> {
    if (this.draining) throw new DrainingError("The gateway is shutting down; try again shortly");
    const call = new Call(this.deps, "outbound-api", options.from, options.to, options.app);
    this.track(call);
    try {
      await call.originate(dialString(options.to, this.config.trunkDialString), options.from, options.timeout ?? 30);
    } catch (error) {
      this.release(call);
      throw error;
    }
    return call;
  }

  private onEvent(event: AriEvent): void {
    if (event.type === "StasisStart") {
      const [kind, value] = event.args ?? [];
      if (kind === "inbound" && event.channel) {
        this.onInbound(event, value ?? event.channel.dialplan?.exten ?? "");
        return;
      }
      if (kind === "outbound" && value) {
        const call = this.calls.get(value);
        if (call) void call.start();
        return;
      }
    }
    this.route(event);
  }

  private onInbound(event: AriEvent, to: string): void {
    const channel = event.channel!;
    const app = appFor(this.config, to);
    const from = channel.caller.number || channel.caller.name || "anonymous";
    if (this.draining) {
      this.log(`Draining; busy signal for call from ${from} to ${to}`);
      this.rejectInbound(channel.id, from, to, "busy", "busy", "gateway-draining");
      return;
    }
    if (!app) {
      this.log(`No app for ${to}; rejecting call from ${from}`);
      this.rejectInbound(channel.id, from, to, "unallocated", "failed", "no-app-for-number");
      return;
    }
    const call = new Call(
      this.deps,
      "inbound",
      from,
      to,
      "url" in app
        ? { url: app.url, format: app.format, statusCallback: app.statusCallback }
        : { verbs: app.verbs, format: "json", statusCallback: app.statusCallback },
      { channelId: channel.id, status: "ringing" },
    );
    this.track(call);
    this.log(`[${call.sid}] inbound ${from} -> ${to}`);
    void call.start();
  }

  /** Refuse a new call, and keep a record of it. */
  private rejectInbound(channelId: string, from: string, to: string, reason: string, status: string, endedReason: string) {
    void this.ari.request("DELETE", `/channels/${channelId}`, { reason }).catch(() => {});
    const now = new Date().toISOString();
    this.store.saveCall({
      sid: newSid("CA"), direction: "inbound", from, to, status, createdAt: now, endedAt: now, endedReason,
    });
  }

  /** Channels still in our ARI app from a previous run have no Call to drive them. */
  private async hangUpLeftoverChannels(): Promise<void> {
    const app = await this.ari
      .request<{ channel_ids: string[] }>("GET", `/applications/${this.config.ari.app}`)
      .catch(() => ({ channel_ids: [] }));
    for (const id of app.channel_ids) {
      if (this.routes.has(id)) continue;
      await this.ari.request("DELETE", `/channels/${id}`).catch(() => {});
    }
    if (app.channel_ids.length) this.log(`Hung up ${app.channel_ids.length} leftover channel(s) from the last run`);
  }

  private async purgeOldRecords(): Promise<void> {
    try {
      const { calls, recordings } = await this.store.purge(this.config.retentionDays, this.config.recordingsDir);
      if (calls) this.log(`Deleted ${calls} call record(s) and ${recordings} recording(s) older than ${this.config.retentionDays} days`);
    } catch (error) {
      this.log(`Purging old records failed: ${(error as Error).message}`);
    }
  }

  private route(event: AriEvent): void {
    const ids = [
      event.channel?.id,
      event.playback?.id,
      event.recording?.target_uri?.split(":")[1],
      (event.bridge as { id?: string } | undefined)?.id,
    ];
    for (const id of ids) {
      const call = id ? this.routes.get(id) : undefined;
      if (call) return call.handleEvent(event);
    }
  }

  private track(call: Call): void {
    this.calls.set(call.sid, call);
    this.store.saveCall(call.toJSON());
    if (this.calls.size > KEEP_FINISHED_CALLS) {
      for (const [sid, old] of this.calls) {
        if (this.calls.size <= KEEP_FINISHED_CALLS) break;
        if (old.endedAt) this.calls.delete(sid);
      }
    }
  }

  private release(call: Call): void {
    // Keep routing briefly so late events (e.g. RecordingFinished) still arrive.
    setTimeout(() => {
      for (const [id, owner] of this.routes) if (owner === call) this.routes.delete(id);
    }, 5000).unref();
  }
}

function waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (done() || Date.now() >= deadline) return resolve();
      setTimeout(check, 200);
    };
    check();
  });
}
