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

Needs Node 22+, Asterisk 20, and, for speech, Python 3.10+ and sox (`apt install asterisk sox` on Ubuntu 24.04).

```bash
npm install
speech/setup.sh                       # once: installs Piper (text-to-speech) and Whisper (speech-to-text) locally
speech/start.sh                       # local speech server on 127.0.0.1:8090
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
| `say` `{ text, loop, engine, voice, speed }` | Speak text (text-to-speech). |
| `pause` `{ length }` | Wait, in seconds. |
| `play` `{ media, loop }` | Play an Asterisk sound (`sound:name`) or a WAV URL. |
| `gather` `{ input, say, play, numDigits, finishOnKey, timeout, speechTimeout, maxSpeechTime, hints, actionHook }` | Collect keypad digits and/or a spoken answer (`input: ["speech", "dtmf"]`) while a prompt plays, then POST `digits` or `speechResult` + `confidence` to `actionHook`. The prompt stops as soon as the caller starts answering. |
| `connect` `{ url, protocol, parameters, record, actionHook }` | Stream the call's audio to a WebSocket app until it disconnects. |
| `dial` `{ target, callerId, timeout, record, actionHook }` | Call `sip:…`, a phone number (sent via the trunk) or a dial string, and bridge the two parties. |
| `record` `{ maxLength, finishOnKey, beep, actionHook }` | Record the caller, then POST `recordingUrl`. |
| `hangup`, `reject` `{ reason }`, `redirect` `{ url }` | End the call, refuse it, or fetch new verbs. |

`connect` has two audio protocols:
- `native`: binary PCM s16le, mono, 16 kHz, in both directions. It's the voice agent's protocol, and a `user-interrupted` message flushes queued audio for barge-in.
- `twilio`: Twilio Media Streams (JSON, base64 μ-law 8 kHz, with `mark` and `clear`).

### Speech

The voice for `say` and `gather` prompts:
- **Piper (default):** free and runs on this server. Change the voice with `tts.piper.voice`, or per verb with `voice`. Install more voices with `speech/setup.sh <voice-name>`, from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices).
- **ElevenLabs:** more natural, paid. Set `ELEVENLABS_API_KEY` (or `tts.elevenlabs` in `gateway.json`), then use `"engine": "elevenlabs"` per verb or `tts.engine` globally.

If ElevenLabs fails or has no key, the gateway falls back to Piper, so callers always hear the message. Speech is cached in `tts.cacheDir`, so each phrase is synthesized once. Long text is spoken sentence by sentence, so the first sentence starts while the rest are prepared.

Spoken answers:
- **Whisper:** the local default, about 1 s per answer on a CPU.
- **Deepgram:** faster and hosted. Set `DEEPGRAM_API_KEY`, then use `stt.engine: "deepgram"` or `speechEngine` per gather.

`hints` lists words to expect, which improves accuracy.

When a verb with an `actionHook` finishes, the gateway POSTs the result there, and the reply replaces the remaining verbs.

**TwiML apps** (`"format": "twiml"`) receive Twilio-style form posts (`CallSid`, `From`, `To`, `Digits`, `SpeechResult`, …) and can reply with TwiML. Supported:
- `Say`, including SSML text
- `Play`, `Pause`
- `Gather` with DTMF and/or speech, with a `Say` or `Play` prompt
- `Dial` (`Number`/`Sip`)
- `Record`
- `Connect`+`Stream`
- `Redirect`, `Reject`, `Hangup`

Twilio voice names such as `Polly.Joanna` fall back to the default Piper voice. Anything unsupported (queues, conferences) returns a clear error.

**Webhook signatures:**
- JSON requests carry `X-Gateway-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`. Verify it with `verifyJson` in `src/signing.ts`.
- TwiML requests carry a Twilio-compatible `X-Twilio-Signature`. Twilio's own validators work if you use the gateway's `webhookSecret` as the auth token.

Status callbacks (`statusCallback`) receive the events `initiated`, `ringing`, `answered` and `completed`.

## Call records

Every call is saved in a SQLite database (`database`, default `./data/gateway.db`), so history survives restarts. That covers who called, when, how long, how it ended and its recordings. SQLite is built into Node, so no database server is needed.

- Records and their recording files are deleted after `retentionDays` (default 90). This runs at startup and daily.
- Calls a crashed or killed run left unfinished are marked `failed` with `endedReason: "gateway-restart"` on the next start. Any of their channels still open in Asterisk are hung up.
- Calls the gateway refused are recorded too: `busy` while shutting down, `failed` when no app is configured for the number.

Node prints an `ExperimentalWarning` for SQLite at startup. It's harmless.

## Stopping and restarting

Stop the gateway with `SIGTERM` (systemd, Docker and Kubernetes send it) or Ctrl-C, and it shuts down gracefully:

1. **New callers get a busy signal**, so the carrier can retry another server. New outbound calls get HTTP `503` with `Retry-After`. `GET /health` returns `503 {"status":"draining"}`, so load balancers stop sending traffic.
2. **Calls in progress continue** for up to `shutdown.drainSeconds` (default 300).
3. **Calls still going after that** hear `shutdown.goodbye` ("We're sorry, we have to end this call now…") and are hung up. Their records show `endedReason: "gateway-shutdown"`.

The gateway exits once every call has ended. Sending the signal a second time stops it immediately. Give your process manager a stop timeout longer than `drainSeconds`, for example `TimeoutStopSec=330` in systemd or `terminationGracePeriodSeconds: 330` in Kubernetes.

## REST API

Every request needs `Authorization: Bearer <api key>`.

```bash
# Place a call
curl -X POST localhost:3000/v1/calls -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"to":"sip:alice@192.0.2.10","from":"+15550000","verbs":[{"play":{"media":"sound:hello-world"}}]}'

curl "localhost:3000/v1/calls?limit=20&status=completed" -H "Authorization: Bearer $KEY"            # history
curl localhost:3000/v1/calls/CA… -H "Authorization: Bearer $KEY"                                  # one call + its recordings
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
npm test            # also live calls through Asterisk, and live speech if speech/start.sh is running
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
- spoken text that the test caller records and Whisper transcribes back word for word
- a spoken answer recognized while the caller talks over the prompt
- silence timing out
- a TwiML speech `Gather`
- the ElevenLabs → Piper fallback
- call records and recordings surviving a restart
- recovery after a crash
- a drain: the short call finishes, a new caller gets busy, and the long call hears the goodbye
- the real process stopping on `SIGTERM`

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
| `src/store.ts` | Call records in SQLite, retention, crash recovery |
| `src/speech/` | Text-to-speech (`tts.ts`), speech-to-text (`stt.ts`), and the spoken-answer listener (`listen.ts`) |
| `speech/` | Local speech server (Piper + Whisper), with `setup.sh` and `start.sh` |
| `asterisk/` | Self-contained Asterisk config and `start.sh` |
