// Ties it together: receives ARI events, creates a Call for each new channel,
// and routes later events (playbacks, recordings, bridges, extra legs) to the
// call that owns them.

import { AriClient, type AriEvent } from "./ari.js";
import { Call, dialString, type CallApp, type CallDeps } from "./call.js";
import { appFor, type GatewayConfig } from "./config.js";
import { createSttEngines } from "./speech/stt.js";
import { TtsService } from "./speech/tts.js";
import { WebhookClient } from "./webhook.js";

const KEEP_FINISHED_CALLS = 1000;

export class Gateway {
  readonly ari: AriClient;
  readonly webhooks: WebhookClient;
  readonly calls = new Map<string, Call>();
  private readonly routes = new Map<string, Call>();
  private readonly deps: CallDeps;

  constructor(
    readonly config: GatewayConfig,
    private readonly log: (message: string) => void = (m) => console.log(m),
  ) {
    this.ari = new AriClient(config.ari);
    this.webhooks = new WebhookClient(config.webhookSecret);
    this.deps = {
      ari: this.ari,
      config,
      webhooks: this.webhooks,
      tts: new TtsService(config.tts, log),
      stt: createSttEngines(config.stt),
      claim: (id, call) => this.routes.set(id, call),
      release: (call) => this.release(call),
      log,
    };
  }

  async start(): Promise<void> {
    this.ari.on("event", (event: AriEvent) => this.onEvent(event));
    this.ari.on("disconnected", () => this.log("ARI disconnected; reconnecting"));
    this.ari.on("connected", () => this.log("ARI connected"));
    await this.ari.connect();
  }

  stop(): void {
    this.ari.close();
  }

  /** Place an outbound call (REST API). */
  async createCall(options: { to: string; from: string; app: CallApp; timeout?: number }): Promise<Call> {
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
    if (!app) {
      this.log(`No app for ${to}; rejecting call from ${from}`);
      void this.ari.request("DELETE", `/channels/${channel.id}`, { reason: "unallocated" }).catch(() => {});
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
