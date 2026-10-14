// Minimal client for Asterisk's REST Interface (ARI): REST calls plus the
// event WebSocket, with automatic reconnects.

import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface AriChannel {
  id: string;
  name: string;
  state: string;
  caller: { name: string; number: string };
  connected: { name: string; number: string };
  dialplan?: { context: string; exten: string };
  channelvars?: Record<string, string>;
}

/** Any ARI event; see the Asterisk ARI docs for each type's fields. */
export interface AriEvent {
  type: string;
  application: string;
  channel?: AriChannel;
  args?: string[];
  digit?: string;
  playback?: { id: string; state: string; target_uri: string };
  recording?: { name: string; state: string; target_uri: string; duration?: number; cause?: string };
  cause?: number;
  cause_txt?: string;
  [key: string]: unknown;
}

export class AriError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AriOptions {
  url: string;
  user: string;
  password: string;
  app: string;
}

export class AriClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private closed = false;
  private readonly auth: string;

  constructor(readonly options: AriOptions) {
    super();
    this.auth = "Basic " + Buffer.from(`${options.user}:${options.password}`).toString("base64");
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`/ari${path}`, this.options.url);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: { authorization: this.auth, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AriError(response.status, `ARI ${method} ${path}: ${response.status} ${text}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Open the event stream. Resolves once connected; reconnects on its own after that. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL("/ari/events", this.options.url.replace(/^http/, "ws"));
      url.searchParams.set("app", this.options.app);
      url.searchParams.set("subscribeAll", "false");
      const socket = new WebSocket(url, { headers: { authorization: this.auth } });
      let opened = false;

      socket.on("open", () => {
        opened = true;
        this.socket = socket;
        this.emit("connected");
        resolve();
      });
      socket.on("message", (data) => {
        let event: AriEvent;
        try {
          event = JSON.parse(data.toString()) as AriEvent;
        } catch {
          return;
        }
        this.emit("event", event);
      });
      socket.on("error", (error) => {
        if (!opened) reject(error);
      });
      socket.on("close", () => {
        this.socket = null;
        if (this.closed || !opened) return;
        this.emit("disconnected");
        setTimeout(() => void this.reconnect(), 1000);
      });
    });
  }

  private async reconnect(): Promise<void> {
    for (let delay = 1000; !this.closed; delay = Math.min(delay * 2, 10000)) {
      try {
        await this.connect();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }
}
