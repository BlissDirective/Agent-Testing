// Helpers for live tests against the local Asterisk (asterisk/start.sh).

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AriClient } from "../src/ari.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const recordingsDir = path.resolve(here, "../asterisk/.run/spool/recording");
export const ariOptions = { url: "http://127.0.0.1:8088", user: "gateway", password: "gateway-dev-secret", app: "gateway" };

/** A second ARI client (no event socket) for placing test calls. */
export const testAri = new AriClient({ ...ariOptions, app: "tester" });

export async function ariAvailable(): Promise<boolean> {
  try {
    await testAri.request("GET", "/asterisk/info");
    return true;
  } catch {
    return false;
  }
}

export async function setGlobal(name: string, value: string): Promise<void> {
  await testAri.request("POST", "/asterisk/variable", { variable: name, value });
}

export async function getGlobal(name: string): Promise<string> {
  return (await testAri.request<{ value: string }>("GET", "/asterisk/variable", { variable: name })).value;
}

/**
 * Place a call into the gateway's inbound dialplan as if a carrier sent it.
 * The far end is one of the [gateway-test] helpers: listener, presser, talker.
 */
export async function placeInboundCall(
  to: string,
  caller: "listener" | "presser" | "talker" | "speaker",
  variables: Record<string, string> = {},
): Promise<void> {
  await testAri.request(
    "POST",
    "/channels",
    {
      endpoint: `Local/${to}@from-trunk/n`,
      context: "gateway-test",
      extension: caller,
      priority: 1,
      callerId: "Test Caller <+15559990000>",
    },
    { variables },
  );
}

export interface RecordedRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
  json?: any;
  form?: Record<string, string>;
}

/** A fake customer app: answers webhooks from a route table and records every request. */
export class AppServer {
  readonly requests: RecordedRequest[] = [];
  private server: Server | null = null;
  url = "";

  constructor(
    private readonly routes: Record<string, (req: RecordedRequest) => { type?: string; body: string } | unknown>,
  ) {}

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString();
      const recorded: RecordedRequest = { path: req.url ?? "/", headers: req.headers, body };
      if (req.headers["content-type"]?.includes("json")) recorded.json = JSON.parse(body || "null");
      if (req.headers["content-type"]?.includes("urlencoded")) {
        recorded.form = Object.fromEntries(new URLSearchParams(body));
      }
      this.requests.push(recorded);
      const route = this.routes[recorded.path];
      if (!route) {
        res.writeHead(204).end();
        return;
      }
      const reply = route(recorded);
      if (reply && typeof reply === "object" && "body" in (reply as object) && "type" in (reply as object)) {
        const r = reply as { type: string; body: string };
        res.writeHead(200, { "content-type": r.type }).end(r.body);
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
      }
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  find(pathname: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === pathname);
  }

  close(): void {
    this.server?.close();
  }
}

export async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 15000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Loudness and dominant frequency of a 16-bit PCM WAV file. */
export async function wavStats(file: string): Promise<{ seconds: number; rms: number; frequency: number }> {
  const data = await readFile(file);
  let offset = 12;
  let sampleRate = 8000;
  while (offset + 8 <= data.length) {
    const id = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === "fmt ") sampleRate = data.readUInt32LE(offset + 12);
    if (id === "data") {
      const samples = new Int16Array(data.buffer, data.byteOffset + offset + 8, Math.floor(Math.min(size, data.length - offset - 8) / 2));
      let sum = 0;
      let crossings = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i]! * samples[i]!;
        if (i && (samples[i - 1]! < 0) !== (samples[i]! < 0)) crossings++;
      }
      const seconds = samples.length / sampleRate;
      return { seconds, rms: Math.sqrt(sum / Math.max(1, samples.length)), frequency: crossings / 2 / Math.max(seconds, 1e-9) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`No audio data in ${file}`);
}

/** A sine tone as 16-bit PCM little-endian. */
export function tone(sampleRate: number, seconds: number, frequency = 440, amplitude = 8000): Buffer {
  const count = Math.round(sampleRate * seconds);
  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude), i * 2);
  }
  return pcm;
}

/** G.711 mu-law encode (for the Twilio stream test). */
export function toMulaw(pcm: Buffer): Buffer {
  const out = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < out.length; i++) {
    let sample = pcm.readInt16LE(i * 2);
    const sign = sample < 0 ? 0x80 : 0;
    if (sign) sample = -sample;
    sample = Math.min(sample, 32635) + 0x84;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

/** Seconds of a WAV file that contain a tone near `frequency` (20 ms windows). */
export async function toneSeconds(file: string, frequency = 440): Promise<number> {
  const data = await readFile(file);
  let offset = 12;
  let sampleRate = 8000;
  while (offset + 8 <= data.length) {
    const id = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === "fmt ") sampleRate = data.readUInt32LE(offset + 12);
    if (id === "data") {
      const samples = new Int16Array(data.buffer, data.byteOffset + offset + 8, Math.floor(Math.min(size, data.length - offset - 8) / 2));
      const window = sampleRate / 50;
      let toneWindows = 0;
      for (let start = 0; start + window <= samples.length; start += window) {
        let sum = 0;
        let crossings = 0;
        for (let i = start; i < start + window; i++) {
          sum += samples[i]! * samples[i]!;
          if (i > start && (samples[i - 1]! < 0) !== (samples[i]! < 0)) crossings++;
        }
        const freq = (crossings / 2) * 50;
        if (Math.sqrt(sum / window) > 300 && Math.abs(freq - frequency) < 80) toneWindows++;
      }
      return toneWindows / 50;
    }
    offset += 8 + size + (size % 2);
  }
  return 0;
}
