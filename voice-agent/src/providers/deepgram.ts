// Speech-to-text provider: Deepgram live streaming over WebSocket.

import WebSocket from "ws";
import type { SttHandlers, SttProvider, SttStream } from "./types.js";

export interface DeepgramOptions {
  apiKey: string;
  model?: string;
  language?: string;
}

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

export class DeepgramProvider implements SttProvider {
  constructor(private readonly options: DeepgramOptions) {}

  start({ sampleRate }: { sampleRate: number }, handlers: SttHandlers): SttStream {
    const params = new URLSearchParams({
      model: this.options.model ?? "nova-3",
      language: this.options.language ?? "en",
      encoding: "linear16",
      sample_rate: String(sampleRate),
      channels: "1",
      interim_results: "true",
      smart_format: "true", // punctuation drives our endpointing
      vad_events: "true",
      endpointing: "300",
    });
    const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${this.options.apiKey}` },
    });
    const backlog: Buffer[] = [];
    let closed = false;

    socket.on("open", () => {
      for (const pcm of backlog.splice(0)) socket.send(pcm);
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      let message: DeepgramMessage;
      try {
        message = JSON.parse(data.toString()) as DeepgramMessage;
      } catch {
        return;
      }
      if (message.type === "SpeechStarted") handlers.onSpeechStarted();
      if (message.type === "Results") {
        const text = message.channel?.alternatives?.[0]?.transcript ?? "";
        if (text) handlers.onTranscript({ text, isFinal: message.is_final === true });
      }
    });
    socket.on("error", (error) => {
      if (!closed) handlers.onError(error);
    });
    socket.on("close", (code) => {
      if (!closed && code !== 1000) handlers.onError(new Error(`Deepgram closed (${code})`));
    });

    // Deepgram drops idle connections; keep it open while the user is silent.
    const keepAlive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "KeepAlive" }));
    }, 5000);

    return {
      write(pcm) {
        if (closed) return;
        if (socket.readyState === WebSocket.OPEN) socket.send(pcm);
        else if (socket.readyState === WebSocket.CONNECTING) backlog.push(pcm);
      },
      close() {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "CloseStream" }));
          socket.close(1000);
        } else {
          socket.terminate();
        }
      },
    };
  }
}
