// Signatures on outgoing webhooks, so apps can verify a request came from
// this gateway.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * JSON webhooks: header `X-Gateway-Signature: t=<unix seconds>,v1=<hex>`,
 * where hex = HMAC-SHA256(secret, `${t}.${body}`). Include `t` so receivers
 * can reject replays older than a few minutes.
 */
export function signJson(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifyJson(secret: string, body: string, header: string, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = signJson(secret, body, timestamp).split("v1=")[1]!;
  return safeEqual(expected, parts.v1);
}

/**
 * TwiML webhooks: `X-Twilio-Signature`, computed the way Twilio does, so
 * existing Twilio apps can validate with their usual library by using the
 * gateway's webhook secret as the auth token:
 * base64(HMAC-SHA1(secret, url + concat(sorted key + value))).
 */
export function signTwilio(secret: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", secret).update(Buffer.from(data, "utf8")).digest("base64");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
