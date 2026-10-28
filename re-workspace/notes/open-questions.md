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

## Beside
- **Credit rates beyond the help-center card.** Some actions have no published cost (lead capture is free, but what about outbound email via Gmail, GBP posts, or Housecall Pro writes?). The /pricing page publishes no rate card at all.
- **Which "waitlist" modules are really live.** Marketing calls website, SEO, ads and reviews "waitlist", while the help center documents them running in agent.beta. We would need a signup to settle this, which is out of scope.
- **The missing ToS sections.** Liability cap, indemnity, content license and the arbitration procedure/opt-out are absent from the served HTML. Is this a CMS bug or the actual contract? A cached or archived copy would answer it. Not fetched.
- **Default state of Recording Consent.** The docs say "toggle it on", which implies off by default. Not confirmed.
- **Is there AI disclosure in the receptionist's default greeting?** The blog leaves disclosure to the customer; the default script text isn't published.
- **VoIP / carrier provider and A2P 10DLC handling.** The subprocessor list says only "VoIP Providers". Nothing about 10DLC brand/campaign registration was found.
- **Contact enrichment vendor.** The marketing mock-up shows "Found LinkedIn profile and email address"; no matching subprocessor is listed.
- **WorkflowAI and Qdrant roles.** Is the agent orchestration actually built on WorkflowAI? Inferred from the subprocessor list only.
- **The other 15 integration pages.** Are they all Zapier-only? Only HubSpot and Square were checked.
- **The true customer count and ARPU after the May 2026 plan refresh.** Public figures conflict (20k / 21k / 25k).
- **Agency pricing / reseller terms.** These are only available via a sales demo.
- **For you to decide:** whether Prolectio adopts a public credit/outcome rate card, a public live-demo number, and llms.txt plus markdown siblings (see `notes/beside-ARCHITECTURE.md` §9).
