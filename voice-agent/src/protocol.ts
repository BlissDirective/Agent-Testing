// Wire protocol for a call over one WebSocket.
//
// Binary frames carry audio both ways: raw PCM, signed 16-bit little-endian,
// mono, at the call's sample rate (16 kHz by default).
// Text frames carry the JSON messages below.
//
// Any client can speak this protocol: the browser page in public/, or later a
// telephony gateway that bridges phone audio to it.

export type Role = "user" | "assistant";

/** Server -> client. */
export type ServerMessage =
  /** The assistant is ready; start sending audio. */
  | { type: "listening"; callId: string; sampleRate: number }
  | { type: "transcript"; role: Role; transcriptType: "partial" | "final"; transcript: string }
  | { type: "speech-update"; role: Role; status: "started" | "stopped"; turnId?: number }
  /** Streamed LLM text for a turn. */
  | { type: "model-output"; turnId: number; output: string }
  /** The user talked over the assistant: drop any queued audio for this turn now. */
  | { type: "user-interrupted"; turnId: number }
  | { type: "tool-call"; turnId: number; name: string; input: unknown }
  | { type: "status-update"; status: "in-progress" | "ended"; endedReason?: string }
  | { type: "error"; message: string };

/** Client -> server. */
export type ClientMessage =
  /** Speak this text verbatim. */
  | { type: "say"; message: string }
  /** Add context to the conversation, optionally prompting a reply. */
  | { type: "add-message"; role: Role; content: string; triggerResponse?: boolean }
  | { type: "end-call" };

export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  switch (message.type) {
    case "say":
      return typeof message.message === "string" ? { type: "say", message: message.message } : null;
    case "add-message":
      if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
        return null;
      }
      return {
        type: "add-message",
        role: message.role,
        content: message.content,
        triggerResponse: message.triggerResponse === true,
      };
    case "end-call":
      return { type: "end-call" };
    default:
      return null;
  }
}
