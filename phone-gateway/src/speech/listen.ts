// Captures one spoken answer from the caller for speech `gather`.
//
// The caller's audio is tapped with an ARI snoop channel (spy on what the
// caller says), so prompts can keep playing on the call itself. A simple
// energy-based voice activity detector decides when the answer starts and
// ends; the utterance is upsampled to 16 kHz for the STT engine.

import type { AriClient } from "../ari.js";
import { bytesToSamples, samplesToBytes, Upsampler } from "../resample.js";
import { RtpEndpoint, swap16 } from "../rtp.js";

const FRAME_MS = 20;
const SPEECH_START_FRAMES = 3; // 60 ms of speech before we believe it
const PREROLL_FRAMES = 15; // keep 300 ms before the detected start

export interface VadOptions {
  /** Silence (seconds) after speech that ends the answer. */
  endSilence: number;
  /** Hard limit on answer length (seconds). */
  maxSpeech: number;
  /** Minimum RMS for a frame to count as speech (0..32767). */
  threshold?: number;
}

/** Feeds 20 ms frames; reports speech start and returns the utterance when done. */
export class UtteranceDetector {
  private readonly preroll: Int16Array[] = [];
  private readonly utterance: Int16Array[] = [];
  private loudFrames = 0;
  private silentFrames = 0;
  private noiseFloor = 0;
  started = false;
  ended = false;

  constructor(private readonly options: VadOptions) {}

  /** Returns "start" once when speech begins, "end" when the answer is complete. */
  push(frame: Int16Array): "start" | "end" | null {
    if (this.ended) return null;
    let sum = 0;
    for (const sample of frame) sum += sample * sample;
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    const threshold = Math.max(this.options.threshold ?? 400, this.noiseFloor * 3);
    const loud = rms > threshold;

    if (!this.started) {
      if (!loud) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05; // track background noise
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      this.loudFrames = loud ? this.loudFrames + 1 : 0;
      if (this.loudFrames >= SPEECH_START_FRAMES) {
        this.started = true;
        this.utterance.push(...this.preroll);
        return "start";
      }
      return null;
    }

    this.utterance.push(frame);
    this.silentFrames = loud ? 0 : this.silentFrames + 1;
    if (
      this.silentFrames * FRAME_MS >= this.options.endSilence * 1000 ||
      this.utterance.length * FRAME_MS >= this.options.maxSpeech * 1000
    ) {
      this.ended = true;
      return "end";
    }
    return null;
  }

  /** The captured answer (8 kHz), without the trailing silence. */
  audio(): Int16Array {
    const keep = this.utterance.slice(0, Math.max(0, this.utterance.length - this.silentFrames + 10));
    const total = keep.reduce((n, f) => n + f.length, 0);
    const out = new Int16Array(total);
    let offset = 0;
    for (const frame of keep) {
      out.set(frame, offset);
      offset += frame.length;
    }
    return out;
  }
}

export interface ListenOptions {
  ari: AriClient;
  app: string;
  rtpHost: string;
  channelId: string;
  vad: VadOptions;
  /** Give up if no speech starts within this many seconds (after `armTimeout`). */
  noSpeechTimeout: number;
  claim: (id: string) => void;
  onSpeechStart: () => void;
  signal: AbortSignal;
}

export interface Listener {
  /** Resolves with 16 kHz PCM of the answer, or null if nobody spoke. */
  result: Promise<Buffer | null>;
  /** Start the no-speech timer (call once the prompt has finished). */
  armTimeout(): void;
  close(): Promise<void>;
}

export async function listenForSpeech(options: ListenOptions): Promise<Listener> {
  const { ari } = options;
  const rtp = new RtpEndpoint("slin");
  const detector = new UtteranceDetector(options.vad);
  const ids: { snoop?: string; external?: string; bridge?: string } = {};
  let timer: NodeJS.Timeout | undefined;
  let settle: (value: Buffer | null) => void = () => {};
  const result = new Promise<Buffer | null>((resolve) => (settle = resolve));

  const finish = (audio: Int16Array | null) => {
    clearTimeout(timer);
    rtp.onAudio = () => {};
    settle(audio && audio.length ? samplesToBytes(new Upsampler().process(audio)) : null);
  };
  options.signal.addEventListener("abort", () => finish(null), { once: true });

  const close = async () => {
    finish(null);
    rtp.close();
    await Promise.allSettled([
      ids.external ? ari.request("DELETE", `/channels/${ids.external}`) : undefined,
      ids.snoop ? ari.request("DELETE", `/channels/${ids.snoop}`) : undefined,
    ]);
    if (ids.bridge) await ari.request("DELETE", `/bridges/${ids.bridge}`).catch(() => {});
  };

  try {
    const local = await rtp.bind(options.rtpHost);
    const snoop = await ari.request<{ id: string }>("POST", `/channels/${options.channelId}/snoop`, {
      app: options.app,
      appArgs: "snoop",
      spy: "in",
    });
    ids.snoop = snoop.id;
    options.claim(snoop.id);
    const external = await ari.request<{ id: string; channelvars?: Record<string, string> }>(
      "POST",
      "/channels/externalMedia",
      {
        app: options.app,
        external_host: `${local.address}:${local.port}`,
        format: "slin",
        encapsulation: "rtp",
        transport: "udp",
        direction: "both",
      },
    );
    ids.external = external.id;
    options.claim(external.id);
    const bridge = await ari.request<{ id: string }>("POST", "/bridges", { type: "mixing" });
    ids.bridge = bridge.id;
    options.claim(bridge.id);
    await ari.request("POST", `/bridges/${bridge.id}/addChannel`, { channel: `${snoop.id},${external.id}` });
  } catch (error) {
    await close();
    throw error;
  }

  rtp.onAudio = (payload) => {
    const event = detector.push(bytesToSamples(swap16(payload)));
    if (event === "start") {
      clearTimeout(timer);
      options.onSpeechStart();
    } else if (event === "end") {
      finish(detector.audio());
    }
  };

  return {
    result,
    armTimeout() {
      if (!detector.started) timer = setTimeout(() => finish(null), options.noSpeechTimeout * 1000);
    },
    close,
  };
}
