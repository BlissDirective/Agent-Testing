# Phone Gateway

A self-hosted programmable voice gateway: your own version of the phone-call side of Twilio.

- **Asterisk** handles SIP and audio codecs.
- **This TypeScript app** controls every call through Asterisk's REST interface (ARI).

Apps control calls with **JSON verbs** or **TwiML**, and a call's audio can be bridged to a WebSocket app such as `../voice-agent`.

```
phone / SIP trunk ──SIP/RTP──▶ Asterisk ──ARI──▶ phone-gateway ──webhooks──▶ your app
                                   ▲  RTP ▼               │
                                   └──────────────────────┴──WebSocket audio──▶ voice agent
```

The design notes are in [`../re-workspace/notes/phone-gateway-design.md`](../re-workspace/notes/phone-gateway-design.md).

## Run it

Needs Node 22+ and Asterisk 20 (`apt install asterisk` on Ubuntu 24.04).

```bash
npm install
asterisk/start.sh                     # gateway's own Asterisk instance: SIP udp/5060, ARI on 127.0.0.1:8088
cp gateway.example.json gateway.json  # set apiKeys, webhookSecret, numbers
npm start
```

To try it with the voice agent, run `../voice-agent` on port 8080. Then call `+15550100` from any SIP softphone pointed at this machine.

`asterisk/start.sh stop` stops Asterisk, and `asterisk/start.sh cli` opens its console.

## Apps

Each number in `gateway.json` maps to an app. An app is either a fixed `verbs` list, or a `url` the gateway POSTs call details to and runs whatever the reply says.

**JSON apps** (`"format": "json"`) receive a JSON body. They reply with a list of verbs, run in order:

```json
[
  { "play": { "media": "sound:hello-world" } },
  { "gather": { "numDigits": 1, "actionHook": "https://app.example/menu" } },
  { "connect": { "url": "ws://localhost:8080/call", "record": true } },
  { "hangup": {} }
]
```

| Verb | What it does |
|---|---|
| `answer` | Answer now. Media verbs answer automatically. |
| `pause` `{ length }` | Wait, in seconds. |
| `play` `{ media, loop }` | Play an Asterisk sound (`sound:name`) or a WAV URL. |
| `gather` `{ numDigits, finishOnKey, timeout, play, actionHook }` | Collect keypad digits, then POST `digits` to `actionHook`. |
| `connect` `{ url, protocol, parameters, record, actionHook }` | Stream the call's audio to a WebSocket app until it disconnects. |
| `dial` `{ target, callerId, timeout, record, actionHook }` | Call `sip:…`, a phone number (sent via the trunk) or a dial string, and bridge the two parties. |
| `record` `{ maxLength, finishOnKey, beep, actionHook }` | Record the caller, then POST `recordingUrl`. |
| `hangup`, `reject` `{ reason }`, `redirect` `{ url }` | End the call, refuse it, or fetch new verbs. |

`connect` has two audio protocols:
- `native`: binary PCM s16le, mono, 16 kHz, in both directions. It's the voice agent's protocol, and a `user-interrupted` message flushes queued audio for barge-in.
- `twilio`: Twilio Media Streams (JSON, base64 μ-law 8 kHz, with `mark` and `clear`).

When a verb with an `actionHook` finishes, the gateway POSTs the result there, and the reply replaces the remaining verbs.

**TwiML apps** (`"format": "twiml"`) receive Twilio-style form posts (`CallSid`, `From`, `To`, `Digits`, …) and can reply with TwiML. Supported: `Play`, `Pause`, `Gather` (DTMF), `Dial` (`Number`/`Sip`), `Record`, `Connect`+`Stream`, `Redirect`, `Reject` and `Hangup`. Anything else (`Say`, speech recognition, queues) returns a clear error.

**Webhook signatures:**
- JSON requests carry `X-Gateway-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`. Verify it with `verifyJson` in `src/signing.ts`.
- TwiML requests carry a Twilio-compatible `X-Twilio-Signature`. Twilio's own validators work if you use the gateway's `webhookSecret` as the auth token.

Status callbacks (`statusCallback`) receive the events `initiated`, `ringing`, `answered` and `completed`.

## REST API

Every request needs `Authorization: Bearer <api key>`.

```bash
# Place a call
curl -X POST localhost:3000/v1/calls -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"to":"sip:alice@192.0.2.10","from":"+15550000","verbs":[{"play":{"media":"sound:hello-world"}}]}'

curl localhost:3000/v1/calls/CA… -H "Authorization: Bearer $KEY"                                  # status
curl -X POST localhost:3000/v1/calls/CA… -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"verbs":[{"hangup":{}}]}'                              # redirect
curl -X POST localhost:3000/v1/calls/CA… -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"status":"completed"}'                                 # hang up
curl localhost:3000/v1/recordings/CA…-1.wav -H "Authorization: Bearer $KEY" -o rec.wav            # recording
```

For an app, create and update calls with one of: `verbs`, `twiml`, or `url` (plus `format`).

## Test it

```bash
npm run test:unit   # no Asterisk needed
npm test            # also runs live calls through the local Asterisk (skipped if it isn't running)
```

The live tests place real calls through Asterisk with real RTP audio:
- playback and signed status callbacks
- DTMF gather
- recording, and downloading it through the API
- dial with recording
- the voice agent bridge, including barge-in
- a TwiML app using Twilio Media Streams
- REST redirect, hangup and outbound calls
- a real SIP call from SIPp

## Connecting a carrier

Calls already work over SIP. Calls to and from real phone numbers need a SIP trunk:
1. Sign up with a carrier (Telnyx, Bandwidth, …).
2. Fill in `[trunk]` in `asterisk/etc/pjsip.conf` (IP auth or registration).
3. Point your numbers at this server and add them to `numbers` in `gateway.json`.

`trunkDialString` controls how outbound numbers are dialed.

## Layout

| Path | What it is |
|---|---|
| `src/gateway.ts` | ARI connection; creates a `Call` per channel and routes events to it |
| `src/call.ts` | The verb runner: answer, play, gather, connect, dial, record, redirect, status callbacks |
| `src/media.ts` | `connect`: RTP ⇄ WebSocket, in the native and Twilio protocols |
| `src/rtp.ts` | RTP endpoint, plus a real-time pacer with `clear` and marks |
| `src/resample.ts` | 8 ⇄ 16 kHz FIR resampler, and why it's needed |
| `src/twiml.ts` | TwiML → verbs |
| `src/webhook.ts`, `src/signing.ts` | Webhooks and their signatures |
| `src/api.ts` | REST API |
| `asterisk/` | Self-contained Asterisk config and `start.sh` |
