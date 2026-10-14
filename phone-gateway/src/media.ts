// The `connect` verb: bridges a call's audio to a WebSocket app.
//
//   caller channel ──┐
//                    ├─ mixing bridge ── External Media channel ⇄ RTP ⇄ this process ⇄ WebSocket app
//   (recording) ─────┘
//
// Two wire protocols:
// - native: binary frames of PCM s16le mono 16 kHz both ways, plus the voice
//   agent's JSON events ("user-interrupted" flushes queued audio). Asterisk
//   leg is 8 kHz slin; see src/resample.ts for why and how it's converted.
// - twilio: Twilio Media Streams JSON (base64 mu-law 8 kHz, mark, clear, dtmf).

import WebSocket from "ws";
import type { AriClient } from "./ari.js";
import { bytesToSamples, Downsampler, samplesToBytes, Upsampler } from "./resample.js";
import { AudioPacer, formats, RtpEndpoint, swap16, type MediaFormat } from "./rtp.js";

export interface MediaSessionOptions {
  ari: AriClient;
  app: string;
  rtpHost: string;
  callSid: string;
  channelId: string;
  url: string;
  protocol: "native" | "twilio";
  parameters: Record<string, string>;
  /** If set, the bridge is recorded to this name (wav). */
  recordingName?: string;
  /** Called with each id the session creates, so its ARI events reach the call. */
  claim: (id: string) => void;
  /** The session registers how to pass the caller's key presses to the app. */
  setDtmfHandler: (handler: ((digit: string) => void) | null) => void;
  signal: AbortSignal;
}

export interface MediaSessionResult {
  /** Why it ended: the app closed the socket, the call ended, or an error. */
  reason: "app-closed" | "call-ended" | "error";
  error?: string;
}

export async function runMediaSession(options: MediaSessionOptions): Promise<MediaSessionResult> {
  const { ari } = options;
  const format: MediaFormat = options.protocol === "native" ? "slin" : "ulaw";
  const { bytesPerFrame, silence } = formats[format];
  const rtp = new RtpEndpoint(format);
  const pacer = new AudioPacer(bytesPerFrame, silence, (frame) => rtp.send(frame));
  let externalId: string | undefined;
  let bridgeId: string | undefined;
  let socket: WebSocket | undefined;

  const cleanup = async () => {
    options.setDtmfHandler(null);
    pacer.stop();
    rtp.close();
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000);
    await Promise.allSettled([
      externalId ? ari.request("DELETE", `/channels/${externalId}`) : undefined,
      bridgeId ? ari.request("DELETE", `/bridges/${bridgeId}`) : undefined,
    ]);
  };

  try {
    const local = await rtp.bind(options.rtpHost);
    const external = await ari.request<{ id: string; channelvars?: Record<string, string> }>(
      "POST",
      "/channels/externalMedia",
      {
        app: options.app,
        external_host: `${local.address}:${local.port}`,
        format,
        encapsulation: "rtp",
        transport: "udp",
        direction: "both",
      },
    );
    externalId = external.id;
    options.claim(externalId);
    const vars = external.channelvars ?? {};
    if (vars.UNICASTRTP_LOCAL_ADDRESS && vars.UNICASTRTP_LOCAL_PORT) {
      rtp.setRemote(vars.UNICASTRTP_LOCAL_ADDRESS, Number(vars.UNICASTRTP_LOCAL_PORT));
    }

    const bridge = await ari.request<{ id: string }>("POST", "/bridges", { type: "mixing" });
    bridgeId = bridge.id;
    options.claim(bridgeId);
    await ari.request("POST", `/bridges/${bridgeId}/addChannel`, {
      channel: `${options.channelId},${externalId}`,
    });
    if (options.recordingName) {
      await ari.request("POST", `/bridges/${bridgeId}/record`, {
        name: options.recordingName,
        format: "wav",
        ifExists: "overwrite",
      });
    }

    socket = new WebSocket(options.url);
    const protocol =
      options.protocol === "native"
        ? nativeProtocol(socket, pacer, options)
        : twilioProtocol(socket, pacer, options);
    rtp.onAudio = protocol.onCallAudio;
    pacer.start();

    return await new Promise<MediaSessionResult>((resolve) => {
      const finish = (result: MediaSessionResult) => {
        options.signal.removeEventListener("abort", onAbort);
        protocol.onEnd();
        resolve(result);
      };
      const onAbort = () => finish({ reason: "call-ended" });
      options.signal.addEventListener("abort", onAbort, { once: true });
      socket!.on("close", () => finish({ reason: "app-closed" }));
      socket!.on("error", (error) => finish({ reason: "error", error: error.message }));
    });
  } catch (error) {
    return { reason: "error", error: (error as Error).message };
  } finally {
    await cleanup();
  }
}

interface Protocol {
  onCallAudio(payload: Buffer): void;
  onEnd(): void;
}

function nativeProtocol(socket: WebSocket, pacer: AudioPacer, options: MediaSessionOptions): Protocol {
  const up = new Upsampler(); // caller (8 kHz) -> app (16 kHz)
  const down = new Downsampler(); // app (16 kHz) -> caller (8 kHz)
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      const pcm16k = bytesToSamples(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      pacer.push(swap16(samplesToBytes(down.process(pcm16k))));
      return;
    }
    let message: { type?: string };
    try {
      message = JSON.parse(data.toString()) as { type?: string };
    } catch {
      return;
    }
    if (message.type === "user-interrupted") pacer.clear();
  });
  options.setDtmfHandler((digit) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({ type: "add-message", role: "user", content: `[The caller pressed ${digit} on the keypad]` }),
    );
  });
  return {
    onCallAudio(payload) {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(samplesToBytes(up.process(bytesToSamples(swap16(payload)))));
    },
    onEnd() {},
  };
}

function twilioProtocol(socket: WebSocket, pacer: AudioPacer, options: MediaSessionOptions): Protocol {
  const streamSid = `MZ${options.callSid.slice(2)}`;
  let sequence = 0;
  let chunk = 0;
  const started = Date.now();
  const send = (message: Record<string, unknown>) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ ...message, sequenceNumber: String(++sequence) }));
    }
  };

  socket.on("open", () => {
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    send({
      event: "start",
      streamSid,
      start: {
        streamSid,
        callSid: options.callSid,
        accountSid: "AC_gateway",
        tracks: ["inbound"],
        customParameters: options.parameters,
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      },
    });
  });
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    let message: { event?: string; media?: { payload?: string }; mark?: { name?: string } };
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.event === "media" && message.media?.payload) {
      pacer.push(Buffer.from(message.media.payload, "base64"));
    } else if (message.event === "mark" && message.mark?.name) {
      pacer.mark(message.mark.name);
    } else if (message.event === "clear") {
      pacer.clear();
    }
  });
  pacer.onMark = (name) => send({ event: "mark", streamSid, mark: { name } });
  options.setDtmfHandler((digit) =>
    send({ event: "dtmf", streamSid, dtmf: { track: "inbound_track", digit } }),
  );

  return {
    onCallAudio(payload) {
      if (socket.readyState !== WebSocket.OPEN) return;
      send({
        event: "media",
        streamSid,
        media: {
          track: "inbound",
          chunk: String(++chunk),
          timestamp: String(Date.now() - started),
          payload: payload.toString("base64"),
        },
      });
    },
    onEnd() {
      send({ event: "stop", streamSid, stop: { accountSid: "AC_gateway", callSid: options.callSid } });
    },
  };
}
