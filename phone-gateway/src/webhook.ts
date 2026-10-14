// Calls app webhooks for verbs and sends status callbacks. JSON apps get
// JSON; TwiML apps get Twilio-style form posts so existing apps work.

import { signJson, signTwilio } from "./signing.js";
import { twimlToVerbs } from "./twiml.js";
import { parseVerbs, type Verb } from "./verbs.js";

export type AppFormat = "json" | "twiml";

/** What the gateway tells apps about a call (camelCase; TwiML apps get Twilio names). */
export interface CallInfo {
  callSid: string;
  direction: "inbound" | "outbound-api" | "outbound-dial";
  from: string;
  to: string;
  callStatus: string;
  parentCallSid?: string;
  [extra: string]: string | number | undefined;
}

const TWILIO_NAMES: Record<string, string> = {
  callSid: "CallSid",
  direction: "Direction",
  from: "From",
  to: "To",
  callStatus: "CallStatus",
  parentCallSid: "ParentCallSid",
  digits: "Digits",
  speechResult: "SpeechResult",
  confidence: "Confidence",
  recordingUrl: "RecordingUrl",
  recordingSid: "RecordingSid",
  recordingDuration: "RecordingDuration",
  dialCallStatus: "DialCallStatus",
  dialCallSid: "DialCallSid",
  dialCallDuration: "DialCallDuration",
  callDuration: "CallDuration",
  event: "CallbackEvent",
};

function toTwilioParams(info: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = { AccountSid: "AC_gateway", ApiVersion: "2010-04-01" };
  for (const [key, value] of Object.entries(info)) {
    if (value === undefined) continue;
    params[TWILIO_NAMES[key] ?? key[0]!.toUpperCase() + key.slice(1)] = String(value);
  }
  return params;
}

export class WebhookClient {
  constructor(
    private readonly secret: string,
    private readonly timeoutMs = 10000,
  ) {}

  /** POST call info to an app and parse the verbs it returns. */
  async fetchVerbs(url: string, format: AppFormat, info: Record<string, unknown>): Promise<Verb[]> {
    const response = await this.post(url, format, info);
    if (!response.ok) throw new Error(`Webhook ${url} returned ${response.status}`);
    const text = await response.text();
    if (!text.trim()) return [];
    return format === "twiml" ? twimlToVerbs(text) : parseVerbs(JSON.parse(text));
  }

  /** Fire-and-forget notification (status callbacks), retried once. */
  notify(url: string, format: AppFormat, info: Record<string, unknown>): void {
    const attempt = (retry: boolean) =>
      this.post(url, format, info)
        .then((r) => {
          if (!r.ok && retry) setTimeout(() => attempt(false), 2000);
        })
        .catch(() => {
          if (retry) setTimeout(() => attempt(false), 2000);
        });
    void attempt(true);
  }

  private post(url: string, format: AppFormat, info: Record<string, unknown>): Promise<Response> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    if (format === "twiml") {
      const params = toTwilioParams(info);
      return fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": signTwilio(this.secret, url, params),
        },
        body: new URLSearchParams(params),
        signal,
      });
    }
    const body = JSON.stringify(info);
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-signature": signJson(this.secret, body) },
      body,
      signal,
    });
  }
}
