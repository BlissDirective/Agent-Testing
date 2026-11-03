# Rerun: how it works

**Target:** `target/rerun`, from https://github.com/rerun-build/rerun at commit `a6d63a4b` (see `notes/sources.md`). It's licensed **AGPL-3.0-only** (`LICENSE`, `package.json`).

**Method:** static reading only. Nothing was installed, built or run, and no Rerun service was called. This is a clean-room study: the notes describe behaviour in our own words, and no code was copied. `notes/agent-platform-design.md` is written from these notes, not from the source.

**Tags:** every claim is **CONFIRMED** (seen in code) or **GUESS** (inferred). Paths are relative to `target/rerun/`; `engine/` means `apps/engine/src/`.

## 1. What it is

Rerun sells "AI coworkers": long-lived agents that run on a schedule, on a webhook, or when you chat with them. Each one has:

- a name and a system prompt ("soul", `SOUL.md`)
- a model
- memory, skills, files and a private SQLite database
- about 20 tool families, each of which can be switched off

## 2. Big picture

```
 Browser (Next.js UI, apps/ui)
   │  Supabase Realtime (board, notifications)      SSE (chat stream, proxied)
   ▼                                                   │
 Control plane: apps/ui API routes + Supabase ─────────┤  Bearer RERUN_API_KEY
   users, workspaces, billing, agents index,           │
   notifications, services catalog, API keys,          ▼
   engine_pool / pairing                     Engine (apps/engine, one per workspace)
   /api/mcp/account (public MCP, 50 tools)     Hono HTTP server + scheduler loop
   /api/t/<agent>/<slug>/<token> (webhooks)    agent loop (Vercel AI SDK)
   /api/mcp/composio, /managed (MCP proxies)   files + SQLite per agent on DATA_DIR
                                               Xvfb/openbox/x11vnc desktop per agent
```

- **Two halves (CONFIRMED).** The control plane (UI and Supabase) holds identity and billing. The **engine** holds everything about the agents: files, SQLite databases, credentials and the run loop (`supabase/migrations/*remote_schema.sql`, `engine/config/paths.ts`).
- **One engine per workspace (CONFIRMED).** The engine is one Node process: a Hono server plus a 30 s scheduler tick (`engine/http/server.ts`, `engine/runtime/scheduler.ts`). Rerun Cloud hands out engines from an `engine_pool` table (Hetzner, Azure, AWS or Incus hosts). Self-hosters can **pair** their own engine using a one-time token (`engine/pairing/pairing.ts`).
- **"Credentials live on your computer" (CONFIRMED)** means the engine's data directory.

## 3. Engine storage layout (CONFIRMED, `engine/config/paths.ts`)

```
DATA_DIR/
  rerun.db                      # just an agents index
  agents/<id>/
    SOUL.md  config.json  .env  INSTALL.md
    workspace/                  # agent's working dir (fs tools rooted here)
    data/agent.db               # free-form SQLite the agent owns
    data/system.db              # sessions, messages(+FTS), runs, run_steps, tool_calls,
                                # memories(+vector+FTS), compaction_checkpoints, skill_proposals
    memory/<id>.md              # one memory per file, front-matter
    skills/<slug>/SKILL.md      # YAML front-matter + body + up to 200 files
    schedules/<slug>.md         # front-matter (cron|runAt, tz, lastRunAt) + prompt body
    triggers/<slug>.md          # front-matter (token, methods, fireCount) + prompt body
    mcp/<server>.json           # OAuth tokens for MCP servers
    browser-profile/
  shared/  shared-db/shared.db  brain/*.md  brain-db/brain.db
  connections/<id>/             # model-provider logins (Claude token, Codex auth, API keys)
```

**Design point (CONFIRMED):** schedules, triggers, skills, memories and the soul are **markdown files with front matter**. The database is only an index or cache for some of them, such as memory vectors.

## 4. Agent loop (`engine/runtime/loop.ts`)

1. **Claim the session (CONFIRMED).** Each session gets an in-memory claim, so only one run happens per conversation. A second message gets HTTP 409 (`run-control.ts`).
2. **Create the run row first (CONFIRMED).** The run row and its abort controller exist before setup starts, so a failed setup is still recorded.
3. **Prepare in parallel (CONFIRMED):** memory recall; model/connection resolution; tool building; MCP preparation; the system prompt; and history loading with compaction, which also repairs orphaned tool calls.
4. **Build the user turn (CONFIRMED).** It carries a context part with the top-5 relevant memories, the language, and a `<now>` timestamp.
5. **Call `streamText` once (CONFIRMED)**, using the Vercel AI SDK v6:
   - `experimental_repairToolCall` cleans up bad tool arguments;
   - `prepareStep` attaches screenshots and moves the cache marker;
   - `onStepFinish` saves `run_steps` and `tool_calls` rows.
6. **No step limit (CONFIRMED).** No `stepCountIs` or `maxSteps` appears anywhere (grep). A run stops when the model stops calling tools, or right after a human-in-the-loop tool call. The only hard cap is 200 computer actions per run (60 on CLI providers).
7. **One guarded `settle()` for every exit (CONFIRMED).** It runs once for done, error, abort or a stream that ends silently. It saves messages and the run, sets the agent idle, frees the session and notifies the hub. After a successful turn it also starts the memory curator in the background.
8. **Recovery (CONFIRMED).** On startup, runs that were interrupted are marked failed (`reconcile.ts`). Stream retry only exists for the hosted and OpenRouter providers: two replays, at 2 s and 8 s, and only if nothing irreversible has been sent yet.

### Providers (CONFIRMED, `engine/agents/providers.ts`)

One AI SDK registry covers rerun (a hosted OpenAI-compatible proxy), anthropic, openai, google, openrouter, **claude** and **codex**.

- **"Use your Claude/ChatGPT plan"** works by driving the vendor CLIs through `ai-sdk-provider-claude-code` and `ai-sdk-provider-codex-cli`.
- For those two, the CLI's built-in tools, memory and auto-compact are switched off, and Rerun's tools are bridged in as an in-process MCP server (`mcp__rerun__*`).
- The Claude CLI runs with `bypassPermissions` (CONFIRMED).
- Whether a vendor's terms allow plan-based use like this is a business question for you, not a technical one (see open questions).

### Prompt caching (CONFIRMED, `engine/agents/caching.ts`)

- **Anthropic:** 1-hour ephemeral breakpoints, set on the stable system block and on the tail of the conversation.
- **OpenAI-style providers:** `promptCacheKey = sessionId`.
- **What this means (CONFIRMED, `systemPrompt.ts`):** the system prompt is split into a **stable** block and a **volatile** block so that the cached part stays the same between turns.

### Compaction (CONFIRMED, `engine/runtime/compaction/`)

- **When:** once estimated tokens (characters ÷ 4) reach 75% of the context window. API providers also have a cap of 150k.
- **What is kept:** the newest ~20k tokens stay verbatim. Older tool outputs over 2,000 characters are replaced by `[pruned]` stubs.
- **What is summarised:** everything older is summarised under fixed headings, with temperature 0 and at most 12k output tokens.
- **Storage:** the summary is saved as a checkpoint and becomes the first message of later history.

## 5. System prompt (CONFIRMED, `engine/agents/systemPrompt.ts`)

- **Stable block:** the soul, then XML-tagged sections:
  - environment paths, service catalog, computer use;
  - how to report failures, what the user sees, chat cards, how to ask the user, turn order, language, verbosity;
  - rules for unattended runs and for sub-agents.
- **Volatile block:** an index of skills (name and description only; the body is read with `skill_read`), the agent's schedules and triggers, a "brain" index, the memory index (one line per active memory), private and shared database schemas (capped), connected MCP services, and today's date.

## 6. Tools (`engine/tools/`)

- **How tools are built (CONFIRMED).** Each tool is an AI SDK `tool({description, inputSchema: zod, execute})`. `buildTools` merges families according to the per-agent flags in `config.tools`, all on by default (`registry.ts`, `packages/contracts/src/agent.ts`).

| Family | Tools (CONFIRMED) |
|---|---|
| Files | `fs_read/write/list/edit/search` (workspace), `shared_*` (shared dir) |
| Shell | `shell_exec`: 120 s timeout, 50k character output cap |
| Web | `web_fetch`, `web_search`, `download` |
| Memory | `memory_write/recall/delete` |
| Databases | `db_query/execute/schema` (agent.db), `shared_db_*` |
| Brain (company wiki) | `brain_search/read/propose/delete/proposals/decide` |
| Skills | `skill_list/read/create/edit/import/delete/…`, `skill_propose` |
| Self-modification | `soul_update`, `tool_install` (npm), `mcp_register/login/status` |
| Automation | `schedule_*` (6), `trigger_*` (7) |
| Multi-agent | `delegate_tasks`, `call_agent` |
| Browser and computer | `browser_navigate`, `vision_analyze`, `computer`, `computer_open_app` |
| Human-in-the-loop | `ask_user`, `request_approval`, `request_secret`, `suggest_service`, `request_mcp_sign_in`, `request_takeover` |
| Output | `notify_user`, `card_table`, `card_file`, table views |

### Security weaknesses

- **No OS isolation (CONFIRMED).** `shell_exec` runs as the engine user, with the engine's whole `process.env` plus the agent's `.env`. Only 8 regexes block commands (`rm -rf /`, `mkfs`, `dd if=`, fork bomb…) (`tools/sandbox.ts:15`). An agent can therefore read other agents' files and secrets (GUESS, inferred from the shared user and env; `desktop/apps.ts` says as much).
- **File tools only (CONFIRMED).** The file tools alone are confined, by a path-escape check (`resolveWithin`).
- **Weak engine API auth (CONFIRMED).** It compares the key with a plain `!==`, and skips auth entirely if `RERUN_API_KEY` isn't set (`http/auth.ts:4-10`).
- **No webhook rate limit (GUESS):** none was found.

### MCP (CONFIRMED, `tools/mcp*.ts`)

- **Declaration:** servers are listed in the agent's config; transport (stdio, SSE or HTTP) is detected automatically.
- **Preparation:** OAuth bearer tokens, `${VAR}` substitution from secrets, and hub headers are added.
- **Pooling:** connections are pooled per agent and server; idle connections close after 10 minutes.
- **Naming:** each MCP tool is exposed as `<server>_<tool>`.

## 7. Memory (CONFIRMED, `engine/memory/`)

- **Storage:** one markdown file per memory, with `kind` set to preference, fact, learned, note or task. It is indexed in `system.db` with a 1536-dimension vector (embeddings come from the hub) and FTS5.
- **Recall score:** cosine similarity + 0.15 × the share of query terms matched, multiplied by a **decay strength**.
- **Decay:** the half-life depends on kind, from 72 h for tasks to 2,160 h for preferences, and grows with log2 of the access count. Memories below 0.15 strength are hidden; below 0.05 they are archived hourly.
- **Writing:** a model call decides whether the new memory updates one of its 5 nearest neighbours.
- **autoMemory:** after each turn, a "curator" model call reads the last exchange and returns at most one new or updated memory plus a list of obsolete ids.

## 8. Skills (CONFIRMED, `engine/skills/`)

- **Format:** `SKILL.md` with `name` and `description` front matter, plus bundled files. This is the same shape as Claude skills.
- **Writes:** atomic, via a staging folder that is renamed into place.
- **Proposals:** `skill_propose` saves a proposal. When the user accepts it, the model drafts the full skill.

## 9. Triggers

- **Schedules (CONFIRMED, `engine/schedules/`, `runtime/scheduler.ts`):**
  - **Format:** a cron expression (via `croner`, with an optional timezone) or a one-shot `runAt`.
  - **Tick:** every 30 s.
  - **When due:** a schedule is due when the next slot after `lastRunAt` has passed. After downtime, all missed slots **collapse into one** catch-up run.
  - **Delivery:** at most once, because the schedule is stamped as fired before the run starts. Duplicates are blocked by an in-memory map.
  - **Message:** the prompt is wrapped as `<scheduled_run>`.
  - **"Run now":** skips the stamp.
- **Webhooks (CONFIRMED, `engine/triggers/`, `apps/ui/app/api/t/...`):**
  - **URL:** `/api/t/<agentId>/<slug>/<token>`. The token in the path is the only secret, and it is compared in constant time.
  - **Errors:** every failure returns 404; a wrong method returns 405.
  - **Bots:** link-preview bots and prefetches get a 204 and start no run.
  - **Limits:** bodies are capped at 1 MiB.
  - **Message:** the trigger's prompt, plus a `<trigger_payload …>` block truncated at 64 KiB.
  - **Runs:** each call starts a new session, with no de-duplication.

## 10. Human-in-the-loop (CONFIRMED, `engine/tools/builtin/hitl.ts`, `packages/contracts/src/chat-hitl.ts`)

- **No real suspension.** A human-in-the-loop tool just returns "delivered, end your turn", and `stopWhen` ends the turn.
- **Pending state.** It is worked out later from the **last unanswered human-in-the-loop tool call** in the transcript.
- **Resuming.** The answer arrives as an ordinary new user message, serialised to text. A declined approval tells the model not to work around it.
- **Secrets.** The UI writes them directly into the agent's `.env`; the model only ever sees key names.
- **Notifications.** The engine posts `question`, `approval` or `connector` to the hub. The hub saves a row, sets the session to `awaiting_*`, sends email if the user is offline, and sends push.
- **"Autopilot".** It's only marketing copy; there is no rules engine in the code.

## 11. Multi-agent (CONFIRMED)

- **`delegate_tasks`:**
  - Runs temporary clone agents, **4 at a time**, with no limit on the number of tasks.
  - The clones can't delegate, ask the user, schedule or call other agents, so nesting stops at depth 1.
  - It is synchronous and returns `## Task N` sections. The clone's workspace is deleted afterwards.
- **`call_agent`:**
  - Messages a persistent agent by id or name, in a new session with source `agent`.
  - Fire-and-forget by default; with `wait:true` it returns the final text.
  - **No depth or loop limit** was found (GUESS: A↔B ping-pong is possible).

## 12. Integrations ("3,000+ apps")

- **Composio (GUESS).** Most likely Composio's catalog, reached through a hub-hosted MCP proxy (`apps/ui/app/api/mcp/composio/[slug]`). Composio holds the third-party tokens.
- **Other sources (CONFIRMED):** managed OAuth (token kept on the engine and sent per call), generic MCP OAuth (token stored in `agents/<id>/mcp/`), and plain API-key apps.
- **Computer use (CONFIRMED):** covers apps with no connector.

## 13. Computer use (CONFIRMED, `engine/desktop/`, `tools/builtin/browser.ts`, `computer.ts`)

- **Display per agent:** Xvfb at 1920x1080, with openbox, tint2 panels and x11vnc on localhost.
- **Browser:** `patchright` Chromium, a stealth fork of Playwright, with a persistent profile per agent.
- **Each action:** an xdotool action, then a 600 ms wait, then a `maim` screenshot scaled to at most 1280x720 JPEG. Coordinates are scaled back to the real screen. At most 6 recent screenshots stay in context.
- **Takeover:** noVNC through a WebSocket bridge, gated by a one-minute HMAC ticket (watch or drive). When a person drives, the agent backs off.

## 14. Streaming and UI (CONFIRMED)

- **Chat stream:** SSE in the AI SDK UI message format, with a 15 s keepalive. The run keeps going with nobody watching, and the stream stays reconnectable for 3 minutes after the run ends (`runtime/run-streams.ts`).
- **Board:** agent status is idle, working, error, waiting_human or offline. It updates through Supabase Realtime, not the engine.

## 15. Lessons for our version

**Keep:**

- files-as-source-of-truth (soul, skills, schedules, triggers as markdown);
- one run per session;
- create the run row first, then a single `settle()`;
- the stable/volatile prompt split for caching;
- human-in-the-loop as "end the turn and resume on the next message" (simple and durable);
- webhook rules: token in the path, 404 for every failure, payload wrapped in tags;
- collapsing missed cron slots into one run;
- MCP as the integration layer;
- decaying, hybrid-recall memory.

**Fix:**

- real sandboxing (one container per workspace, with no access to the engine's env);
- constant-time auth that is always required;
- a step and token budget per run;
- depth and loop limits on `call_agent`;
- webhook rate limits and idempotency keys;
- schedule locking that works across processes;
- real approval policies (Rerun's "Autopilot" is only copy).
