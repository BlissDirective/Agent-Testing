// The call-control language: an app returns a JSON array of verbs, executed
// in order. Each verb is an object with exactly one key, e.g.
//
//   [{ "play": { "media": "sound:hello-world" } },
//    { "connect": { "url": "ws://localhost:8080/call" } },
//    { "hangup": {} }]
//
// TwiML responses are translated into the same verbs (src/twiml.ts).

import { z } from "zod";

/** A URL the gateway POSTs to when a verb finishes; its reply replaces the remaining verbs. */
const actionHook = z.string().url().optional();

export const verbSchemas = {
  answer: z.object({}).strict(),
  pause: z.object({ length: z.number().min(0).max(600).default(1) }).strict(),
  play: z
    .object({
      /** "sound:<name>" for Asterisk sounds, or an http(s) URL to a WAV file. */
      media: z.string().min(1),
      loop: z.number().int().min(1).max(100).default(1),
    })
    .strict(),
  gather: z
    .object({
      numDigits: z.number().int().min(1).max(64).optional(),
      finishOnKey: z.string().regex(/^[0-9*#]?$/).default("#"),
      /** Seconds to wait for the first digit, and between digits. */
      timeout: z.number().min(1).max(60).default(5),
      /** Prompt to play while waiting; stops at the first key press. */
      play: z.string().optional(),
      actionHook,
    })
    .strict(),
  connect: z
    .object({
      /** WebSocket URL of the app that takes over the call's audio. */
      url: z.string().regex(/^wss?:\/\//),
      /** "native": PCM16 16 kHz binary frames (the voice agent's protocol). "twilio": Twilio Media Streams JSON. */
      protocol: z.enum(["native", "twilio"]).default("native"),
      parameters: z.record(z.string(), z.string()).default({}),
      /** Record both sides while connected. */
      record: z.boolean().default(false),
      actionHook,
    })
    .strict(),
  dial: z
    .object({
      /** "sip:user@host", a phone number (sent to the trunk), or a raw Asterisk dial string. */
      target: z.string().min(1),
      callerId: z.string().optional(),
      timeout: z.number().int().min(5).max(600).default(30),
      record: z.boolean().default(false),
      actionHook,
    })
    .strict(),
  record: z
    .object({
      maxLength: z.number().int().min(1).max(3600).default(60),
      finishOnKey: z.string().regex(/^[0-9*#]?$/).default("#"),
      beep: z.boolean().default(true),
      actionHook,
    })
    .strict(),
  hangup: z.object({}).strict(),
  reject: z.object({ reason: z.enum(["rejected", "busy"]).default("rejected") }).strict(),
  redirect: z.object({ url: z.string().url() }).strict(),
} as const;

export type VerbName = keyof typeof verbSchemas;
export type VerbArgs<N extends VerbName> = z.infer<(typeof verbSchemas)[N]>;
export type Verb = { [N in VerbName]: { name: N; args: VerbArgs<N> } }[VerbName];

/** Parse an app's JSON reply into verbs, rejecting anything malformed. */
export function parseVerbs(input: unknown): Verb[] {
  if (!Array.isArray(input)) throw new Error("App must return a JSON array of verbs");
  return input.map((item, index) => {
    if (typeof item !== "object" || item === null || Object.keys(item).length !== 1) {
      throw new Error(`Verb ${index}: must be an object with exactly one key`);
    }
    const [name, args] = Object.entries(item)[0]!;
    if (!(name in verbSchemas)) throw new Error(`Verb ${index}: unknown verb "${name}"`);
    const parsed = verbSchemas[name as VerbName].safeParse(args ?? {});
    if (!parsed.success) throw new Error(`Verb ${index} (${name}): ${parsed.error.message}`);
    return { name, args: parsed.data } as Verb;
  });
}
