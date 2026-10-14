// Gateway configuration, loaded from a JSON file (GATEWAY_CONFIG) with
// secrets overridable from the environment.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parseVerbs } from "./verbs.js";

const appSchema = z.union([
  z.object({
    /** Webhook that returns verbs (JSON) or TwiML for each new call. */
    url: z.string().url(),
    format: z.enum(["json", "twiml"]).default("json"),
    statusCallback: z.string().url().optional(),
  }),
  z.object({
    /** Fixed verbs, no webhook. */
    verbs: z.array(z.unknown()).transform((v) => parseVerbs(v)),
    statusCallback: z.string().url().optional(),
  }),
]);
export type AppConfig = z.infer<typeof appSchema>;

const configSchema = z.object({
  port: z.number().int().default(3000),
  /** Base URL this gateway is reachable at, used in recording URLs. */
  publicUrl: z.string().url().default("http://localhost:3000"),
  /** Bearer tokens accepted by the REST API. */
  apiKeys: z.array(z.string().min(16)).min(1),
  /** Signs every webhook and status callback the gateway sends. */
  webhookSecret: z.string().min(16),
  ari: z
    .object({
      url: z.string().url().default("http://127.0.0.1:8088"),
      user: z.string().default("gateway"),
      password: z.string(),
      app: z.string().default("gateway"),
    })
    .default({ url: "http://127.0.0.1:8088", user: "gateway", password: "gateway-dev-secret", app: "gateway" }),
  /** Address Asterisk sends call audio (RTP) to; must be reachable from Asterisk. */
  rtpHost: z.string().default("127.0.0.1"),
  /** How phone numbers are dialed out. {number} is replaced. */
  trunkDialString: z.string().default("PJSIP/{number}@trunk"),
  /** Where Asterisk writes recordings (its spool/recording directory). */
  recordingsDir: z.string(),
  /** App per dialed number (E.164 or SIP user); "default" catches the rest. */
  numbers: z.record(z.string(), appSchema).default({}),
});
export type GatewayConfig = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): GatewayConfig {
  return configSchema.parse(raw);
}

export async function loadConfig(path: string): Promise<GatewayConfig> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  if (process.env.GATEWAY_API_KEY) raw.apiKeys = [process.env.GATEWAY_API_KEY];
  if (process.env.GATEWAY_WEBHOOK_SECRET) raw.webhookSecret = process.env.GATEWAY_WEBHOOK_SECRET;
  if (process.env.GATEWAY_ARI_PASSWORD) raw.ari = { ...raw.ari, password: process.env.GATEWAY_ARI_PASSWORD };
  return parseConfig(raw);
}

export function appFor(config: GatewayConfig, number: string): AppConfig | undefined {
  return config.numbers[number] ?? config.numbers[number.replace(/^\+/, "")] ?? config.numbers.default;
}
