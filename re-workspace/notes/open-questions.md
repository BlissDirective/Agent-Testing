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
