# Open questions

## What we couldn't determine from Vapi's public code
- **Vapi's interruption mechanics on web calls.** How does it stop audio that is already queued? The web client doesn't flush, so it's probably done server-side in the Daily room. Unverified.
- **TTS chunk splitting rule.** Docs show buffering and `<flush/>` but not the split rule.
- **Default "smart endpointing" model.** What Vapi's own model is trained on, and how the "audio-text fusion" they describe works.
- **Backchanneling and filler injection.** Now internal-only. When and how fillers are chosen isn't documented.
- **Server SDK license.** `server-sdk-typescript` declares no license. Nothing from it was copied; only the API shape informed the notes.

## For you to decide
- **Production LLM.** Which Claude model and effort to run? This trades latency against quality. The starter uses Opus 5.5 at low effort. Measure Sonnet 5.5 and Haiku 5.5 on your own calls.
- **Local model hardware.** Is there a GPU for Whisper and a local LLM? It decides whether "fully local" can stay under about 1 s.
- **Telephony scope.** Inbound only, or also outbound? Your own SIP trunk, or a carrier's?
- **Recordings and data retention.** Whether calls and transcripts are recorded and stored, and where (and the consent requirements that come with it).

## Phone gateway (Twilio phase)
- **Twilio webhook parameter names.** The exact names Twilio POSTs (Digits, RecordingUrl, DialCallStatus…) aren't in the public repos. The gateway's TwiML mode uses the commonly documented names; check them against Twilio's docs before relying on strict compatibility.
- **Media Streams details.** Some fields of the `start` message (e.g. `mediaFormat`, `tracks`) are inferred, not confirmed from code. They're implemented to match Twilio's public docs.
- **For you to decide:** carrier (SIP trunk) and numbers; whether call records must persist (a database); whether wideband (G.722/Opus) SIP calls matter. If they do, 16 kHz end to end needs a newer Asterisk or FreeSWITCH, since Asterisk 20's External Media can't receive slin16.
- **Speech recognition of brand names.** Whisper sometimes misspells names on phone audio ("Acme" heard as "Acne"). Use `hints` for names you expect, or switch to Deepgram (supports keyterms) where accuracy matters.
- **Deepgram and ElevenLabs are untested live.** Both are implemented and unit-tested against mock servers, but haven't been called with real keys from this environment.
- **Several gateways at once.** SQLite suits one gateway per server. Running several against one database (or one Asterisk) needs Postgres and a rule for which gateway owns which calls.

## Strawberry
Public surface only. See `notes/strawberry-ARCHITECTURE.md`.

- **Credit cost per action.** The public docs give no rate card. How many credits do a chat turn, a page read, a connector call or a transcription minute cost, and what are the model multipliers?
- **Is the $0.001/credit meter the cost basis?** `meter_team_usage_monthly_credit` (0.1 cent per credit) exists in the Stripe price registry, but the docs say there is no team overage. Is it legacy, unused, or the internal cost basis?
- **Where the agent loop runs.** In the desktop main process or on Strawberry's servers? Routines stopping when the app closes points to the client, but this isn't confirmed.
- **Connector vendor.** Who supplies the "2,000+ apps"? An aggregator (Composio, Pipedream, Nango...) or in-house? Are OAuth tokens held server-side?
- **Real connector list.** The in-app integration catalog isn't public. Do Shopify, WooCommerce, Yelp, Twilio, Google Business Profile or any POS actually exist as connectors?
- **Browser-lane approvals.** How are risky clicks gated on arbitrary websites (form submits, purchases), as opposed to connector actions that have permission controls?
- **Chat encryption keys.** Chats are restorable across devices and searchable, so does Strawberry hold the keys (not end-to-end)?
- **Desktop shell.** Is it Electron? It's inferred from the "main/renderer process" wording and press coverage. Confirming it needs the binary, which is out of scope.
- **Legal terms.** The privacy policy, AUP, business terms and T&Cs sit behind a Cloudflare JS challenge (403). Sub-processors, retention and DPA terms are unread.
- **Trust Center.** It's a Vanta page; its content loads by API (not called). Is there a SOC 2 Type II report, or only "meets SOC 2 requirements"?
- **"Use your ChatGPT plan".** What's the mechanism (OAuth to a ChatGPT subscription?), and which of its usage bypasses credits?
- **Staff access to chats.** What does the `admin/analysis/chat/[chatId]` route expose to staff?
