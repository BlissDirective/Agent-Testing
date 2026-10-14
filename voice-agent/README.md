# Voice Agent

A self-hosted, real-time voice agent written from scratch in TypeScript:

```
mic → WebSocket → speech-to-text → endpointing → LLM (streamed) → sentence chunks → text-to-speech → speaker
```

The assistant handles turn-taking itself: it decides when you've finished speaking, lets you interrupt it mid-sentence, ignores "uh-huh", and can call tools (including hanging up).

The design notes are in [`../re-workspace/notes/my-version-design.md`](../re-workspace/notes/my-version-design.md).

## Run it

Needs Node 22+ and three API keys.

```bash
cp .env.example .env              # then fill in the keys
npm install
node --env-file=.env --import tsx src/server.ts
```

Open http://localhost:8080, press **Start call**, and allow microphone access. Headphones work best.

| Variable | Default | |
|---|---|---|
| `DEEPGRAM_API_KEY` | (required) | Speech-to-text |
| `ANTHROPIC_API_KEY` | (required, or an `ant auth login` profile) | LLM |
| `ELEVENLABS_API_KEY` | (required) | Text-to-speech |
| `LLM_MODEL` | `claude-opus-5-5` | Try `claude-sonnet-5-5` or `claude-haiku-5-5` for lower latency |
| `LLM_EFFORT` | `low` | `low` to `max`; higher is slower to start speaking |
| `ELEVENLABS_VOICE_ID` | a premade voice | |
| `ASSISTANT_CONFIG` | | Path to a JSON file overriding `src/config.ts` (prompt, first message, turn-taking settings) |
| `PORT` | `8080` | |

## Test it

```bash
npm test          # session, turn-taking, chunker and Claude adapter tests; no API keys needed
npm run typecheck
```

## Layout

| Path | What it is |
|---|---|
| `src/server.ts` | HTTP server for `public/`, plus one `CallSession` per WebSocket on `/call` |
| `src/session.ts` | The orchestrator: endpointing, turns, TTS queue, playback clock, barge-in |
| `src/turn-taking.ts` | When to start replying, and when speech counts as an interruption |
| `src/chunker.ts` | Splits streamed text into sentences for TTS |
| `src/protocol.ts` | The WebSocket protocol, shared by the browser and any future gateway |
| `src/providers/` | `types.ts` interfaces, plus Deepgram, Claude and ElevenLabs adapters |
| `src/tools.ts` | Tools the assistant can call (`end_call`, `get_current_time`) |
| `public/` | Browser client: AudioWorklet mic capture and gapless playback |

## Adding a provider

Implement `SttProvider`, `LlmProvider` or `TtsProvider` from `src/providers/types.ts`, then select it in `src/providers/index.ts`. The session never sees provider details, so swapping to local models (Whisper, Ollama, Piper) needs no other changes.

## Connecting something other than a browser

Any client that speaks `src/protocol.ts` can hold a call:

- **Audio:** binary frames of raw PCM s16le mono at 16 kHz, in both directions.
- **Events:** JSON text frames.

That is how a telephony gateway (SIP/RTP ↔ WebSocket) would plug in.
