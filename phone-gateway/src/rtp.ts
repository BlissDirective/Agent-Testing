// RTP to and from Asterisk's External Media channel, and a pacer that plays
// out queued audio in real time (20 ms frames), with clear and marks for
// barge-in and playback tracking.

import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { randomInt } from "node:crypto";

export type MediaFormat = "slin" | "ulaw";

export const formats: Record<MediaFormat, { sampleRate: number; bytesPerFrame: number; silence: number }> = {
  /** 8 kHz signed linear, big-endian on the wire (network order). */
  slin: { sampleRate: 8000, bytesPerFrame: 320, silence: 0x00 },
  /** 8 kHz G.711 mu-law. */
  ulaw: { sampleRate: 8000, bytesPerFrame: 160, silence: 0xff },
};

const FRAME_MS = 20;
/** Static RTP payload types (both work in both directions with Asterisk 20). */
const DEFAULT_PAYLOAD_TYPE: Record<MediaFormat, number> = { slin: 10, ulaw: 0 };

export function parseRtp(packet: Buffer): { payloadType: number; payload: Buffer } | null {
  if (packet.length < 12 || packet[0]! >> 6 !== 2) return null;
  const csrcCount = packet[0]! & 0x0f;
  const hasExtension = (packet[0]! & 0x10) !== 0;
  const hasPadding = (packet[0]! & 0x20) !== 0;
  let offset = 12 + csrcCount * 4;
  if (hasExtension) {
    if (packet.length < offset + 4) return null;
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  let end = packet.length;
  if (hasPadding) end -= packet[packet.length - 1]!;
  if (offset > end) return null;
  return { payloadType: packet[1]! & 0x7f, payload: packet.subarray(offset, end) };
}

/** One UDP RTP stream to an Asterisk External Media channel. */
export class RtpEndpoint {
  private readonly socket: Socket = createSocket("udp4");
  private remote: { address: string; port: number } | null = null;
  private payloadType: number;
  private sequence = randomInt(0, 0xffff);
  private timestamp = randomInt(0, 0xffffffff);
  private readonly ssrc = randomInt(0, 0xffffffff);
  private closed = false;

  /** Called with each received audio payload. */
  onAudio: (payload: Buffer) => void = () => {};

  constructor(readonly format: MediaFormat) {
    this.payloadType = DEFAULT_PAYLOAD_TYPE[format];
    this.socket.on("message", (packet: Buffer, from: RemoteInfo) => {
      const rtp = parseRtp(packet);
      if (!rtp) return;
      // Mirror what Asterisk sends us (symmetric RTP).
      this.payloadType = rtp.payloadType;
      this.remote ??= { address: from.address, port: from.port };
      this.onAudio(rtp.payload);
    });
  }

  async bind(host: string): Promise<{ address: string; port: number }> {
    await new Promise<void>((resolve) => this.socket.bind(0, host, resolve));
    return this.socket.address();
  }

  /** Where to send audio (from the channel's UNICASTRTP_LOCAL_* variables). */
  setRemote(address: string, port: number): void {
    this.remote = { address, port };
  }

  send(payload: Buffer): void {
    if (!this.remote || this.closed) return;
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = this.payloadType;
    header.writeUInt16BE(this.sequence, 2);
    header.writeUInt32BE(this.timestamp, 4);
    header.writeUInt32BE(this.ssrc, 8);
    this.sequence = (this.sequence + 1) & 0xffff;
    const samples = this.format === "slin" ? payload.length / 2 : payload.length;
    this.timestamp = (this.timestamp + samples) >>> 0;
    this.socket.send(Buffer.concat([header, payload]), this.remote.port, this.remote.address);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}

type QueueItem = { kind: "audio"; data: Buffer } | { kind: "mark"; name: string };

/**
 * Plays queued audio out at real-time speed, one frame every 20 ms, so a
 * client can send a whole sentence at once. `clear()` drops everything queued
 * (barge-in). Marks are reported once the audio queued before them has played.
 */
export class AudioPacer {
  private queue: QueueItem[] = [];
  private partial: Buffer = Buffer.alloc(0);
  private idleTicks = 0;
  private timer: NodeJS.Timeout | undefined;
  private nextTickAt = 0;

  /** Called when a mark is reached, or dropped by clear() (`cleared` = true). */
  onMark: (name: string, cleared: boolean) => void = () => {};

  constructor(
    private readonly bytesPerFrame: number,
    private readonly silence: number,
    private readonly sendFrame: (frame: Buffer) => void,
  ) {}

  start(): void {
    this.nextTickAt = performance.now();
    this.tick();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  push(audio: Buffer): void {
    if (audio.length) this.queue.push({ kind: "audio", data: audio });
  }

  mark(name: string): void {
    this.queue.push({ kind: "mark", name });
  }

  /** Drop all queued audio now. Pending marks are reported as cleared. */
  clear(): void {
    const marks = this.queue.filter((i): i is { kind: "mark"; name: string } => i.kind === "mark");
    this.queue = [];
    this.partial = Buffer.alloc(0);
    for (const mark of marks) this.onMark(mark.name, true);
  }

  /** Milliseconds of audio still waiting to play. */
  get queuedMs(): number {
    const bytes =
      this.partial.length +
      this.queue.reduce((sum, item) => sum + (item.kind === "audio" ? item.data.length : 0), 0);
    return (bytes / this.bytesPerFrame) * FRAME_MS;
  }

  private tick(): void {
    this.sendNextFrame();
    // Schedule against the ideal clock so timer jitter doesn't accumulate.
    this.nextTickAt += FRAME_MS;
    const delay = Math.max(0, this.nextTickAt - performance.now());
    if (delay === 0 && performance.now() - this.nextTickAt > 200) {
      this.nextTickAt = performance.now(); // fell far behind (e.g. paused process); resync
    }
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private sendNextFrame(): void {
    // Fill one frame from the queue, firing marks as they are reached.
    while (this.partial.length < this.bytesPerFrame && this.queue.length) {
      const item = this.queue[0]!;
      if (item.kind === "mark") {
        if (this.partial.length) break; // let the audio before the mark play first
        this.queue.shift();
        this.onMark(item.name, false);
        continue;
      }
      const need = this.bytesPerFrame - this.partial.length;
      this.partial = Buffer.concat([this.partial, item.data.subarray(0, need)]);
      if (item.data.length > need) item.data = item.data.subarray(need);
      else this.queue.shift();
    }

    if (this.partial.length >= this.bytesPerFrame) {
      this.sendFrame(this.partial.subarray(0, this.bytesPerFrame));
      this.partial = this.partial.subarray(this.bytesPerFrame);
      this.idleTicks = 0;
      return;
    }
    // A short tail with nothing more coming: pad it with silence and send.
    if (this.partial.length && (this.queue.length || ++this.idleTicks >= 2)) {
      const frame = Buffer.alloc(this.bytesPerFrame, this.silence);
      this.partial.copy(frame);
      this.partial = Buffer.alloc(0);
      this.idleTicks = 0;
      this.sendFrame(frame);
    }
  }
}

/** Swap byte order of 16-bit samples (big-endian RTP <-> little-endian PCM). */
export function swap16(input: Buffer): Buffer {
  const output = Buffer.from(input.subarray(0, input.length - (input.length % 2)));
  output.swap16();
  return output;
}
