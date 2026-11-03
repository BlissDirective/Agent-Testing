# Our autonomous agent platform: design

This is a clean-room design. It's written from `notes/rerun-ARCHITECTURE.md` (behaviour notes), not from Rerun's AGPL source, and no Rerun code is copied. Implement it from this doc only.

**Stack:** TypeScript on Node 22, Claude models, SQLite and Docker. It matches `voice-agent/` and `phone-gateway/`.
**MVP scope:** the agent loop and tools, triggers (cron, webhook, chat), human-in-the-loop, and multi-agent calls with MCP.
**Decided:** Claude API key; approval default "cautious" (ask on risky actions); memory = Mnemosyne sidecar (see `mnemosyne-integration.md`, which supersedes §7 below).

---

## 1. Shape

```
                ┌──────────────────────── apps/server (one Node process) ────────────────────────┐
 Web UI ──HTTP/SSE──▶ API (Hono)  ──▶ RunQueue ──▶ Runner (agent loop) ──▶ Anthropic Messages API
 Webhooks ──────────▶ /hooks/...    ▲     ▲            │   │
 Cron (scheduler) ──────────────────┘     │            │   └─▶ Tools ─▶ Sandbox (Docker exec per workspace)
 call_agent / delegate ───────────────────┘            │            └─▶ MCP clients (stdio/HTTP)
                                                       └─▶ Store: SQLite (runs, messages, memory, approvals)
                                                           + files: agents/<id>/{SOUL.md, skills/, schedules/, triggers/}
                                                       └─▶ Notifier (email / web push / Slack webhook)
```

**Choices made**

- **One process at first.** There is no separate control plane: a single process with one SQLite file. Leave clean seams (`RunQueue`, `Sandbox`, `Store`) so it can later split into an API service plus workers, using Postgres and a job queue.
- **Our own agent loop on the Anthropic TypeScript SDK (`@anthropic-ai/sdk`).** Rerun also runs its own loop. Owning it is what makes these possible:
  - a durable pause for approvals;
  - a cost budget per run;
  - saving every step;
  - our own compaction.
- **Claude Agent SDK as a fallback.** It's the alternative if you'd rather take Claude Code's tools and loop off the shelf. You'd lose fine control over pausing for approvals and over persistence.
- **Models.** The default is `claude-sonnet-5-5`. Use `claude-opus-5-5` for agents that are "smart" on hard jobs, and `claude-haiku-5-5` for the memory curator, summaries and routing.
- **A real sandbox from day one.** This is the biggest fix over Rerun: one Docker container per workspace. The rules:
  - it runs as a non-root user, with no access to the server's environment;
  - its CPU and memory are capped, and outbound network is optional;
  - each agent's workspace is mounted at `/work/<agent>`, plus a `/shared` mount.

## 2. Data model

### Files: the source of truth that agents can edit

```
data/
  app.db                         # SQLite (WAL)
  agents/<agentId>/
    agent.json                   # name, handle, model, tool flags, limits, mcp servers
    SOUL.md                      # system prompt (markdown)
    skills/<slug>/SKILL.md       # front-matter name/description + body (+ files)
    schedules/<slug>.md          # front-matter: cron | runAt, tz, enabled; body = prompt
    triggers/<slug>.md           # front-matter: tokenHash, methods, enabled; body = prompt
  workspaces/<agentId>/          # mounted into the sandbox
  shared/
```

### SQLite tables

| Table | Key columns |
|---|---|
| `agents` | id, handle (unique), name, status, created_at |
| `sessions` | id, agent_id, source (chat\|schedule\|webhook\|agent\|delegate), parent_run_id, title, status |
| `messages` | id, session_id, role, content_json, created_at |
| `runs` | id, session_id, agent_id, status (queued\|running\|waiting_human\|done\|error\|cancelled), trigger, depth, step_count, input/output/cache tokens, cost_micros, error, started/ended_at |
| `run_steps` | run_id, idx, stop_reason, tokens, duration_ms |
| `tool_calls` | id, run_id, name, input_json, result_json, is_error, duration_ms |
| `hitl_requests` | id, run_id, tool_use_id, kind (question\|approval\|secret), payload_json, status (pending\|answered\|expired), answer_json, decided_by |
| `memories` | id, agent_id, kind, content, embedding BLOB, strength, access_count, last_access, created_at (+ FTS5 table) |
| `schedule_state` | agent_id, slug, last_fired_slot, lease_until |
| `webhook_events` | id, agent_id, slug, idempotency_key, received_at, run_id |
| `secrets` | agent_id, name, ciphertext (AES-GCM, key from env or KMS) |
| `approval_rules` | agent_id, tool, match_json, decision (allow\|deny\|ask) |
| `compactions` | session_id, through_message_id, summary |

## 3. The agent loop (`Runner.run(runId)`)

1. **Claim the run.** Use `UPDATE runs SET status='running' WHERE id=? AND status='queued'`. A per-session lock (one active run per session) is enforced by the queue.
2. **Build the context.**
   - **System prompt, part 1, cached:** SOUL.md, the tool and operating rules, the skills index, and the agent's own schedules and triggers.
   - **System prompt, part 2, changes often:** the memory index, today's date, and connected services.
   - **Message history:** session messages since the last compaction summary.
   - **Memories:** the top-k recalled memories go into the user turn.
   - **Caching:** put `cache_control` on the end of system part 1 and on the last message.
3. **Run the model loop.** Call `messages.stream(...)` with the tools, then:
   - stream text deltas to the SSE bus (`runId` channel, replayable from a buffer);
   - on `tool_use`, run each tool through the **policy gate**:
     - **allow:** execute it;
     - **ask:** create an `hitl_requests` row, set the run to `waiting_human`, save, notify, and **return** (the process may exit; nothing is held in memory);
     - **deny:** return a tool error that says why;
   - append the tool results and loop;
   - save each step (messages, `run_steps`, `tool_calls`).
4. **Enforce limits.** Each agent has `maxSteps` (default 50), `maxCostMicros` per run, `maxWallClock`, and a cap on computer actions. Hitting a limit makes the run end with a short summary of where it stopped.
5. **Settle once.** Every exit (done, error, cancel or limit) goes through a single `settle()` call. It is guarded so it runs only once. It:
   - writes the final status and usage;
   - releases the session lock;
   - emits `run.finished`;
   - queues the memory curator (Haiku) in the background.
6. **Resume after a human answers.** `POST /hitl/:id/answer` saves the answer. Then:
   - **if it was an approval:** execute (or reject) the original `tool_use` now, using the stored input;
   - append the `tool_result`, re-queue the **same run**, and the loop continues from step 2.

   This is the real pause and resume that Rerun lacks. The model sees a normal tool result, not a fresh chat message.
7. **Compact when context fills up.** Trigger at about 70% of the context window:
   - keep the last ~20k tokens verbatim;
   - stub out large old tool results;
   - summarise the rest with Haiku into fixed headings (Goal, Decisions, State, Open items, Files);
   - save the summary to `compactions`.
8. **Recover after a crash.** On boot, a `running` run becomes `queued` again if its last step was saved cleanly. Otherwise it becomes `error` with code `interrupted`.

## 4. Tools (MVP)

Tools are typed with zod and turned into JSON Schema for the API. A registry builds them per agent from flags in `agent.json`.

| Family | Tools | Notes |
|---|---|---|
| fs | `fs_read`, `fs_write`, `fs_edit`, `fs_list`, `fs_search` | Run inside the sandbox, under `/work/<agent>` and `/shared` |
| shell | `shell_exec` | `docker exec` as a non-root user, timeout, output cap. The container itself is the guard, not a regex. |
| web | `web_fetch`, `web_search` | Search uses a provider key (Brave, Tavily…), or Anthropic's server-side web search tool |
| memory | `memory_write`, `memory_recall`, `memory_forget` | Section 7 |
| skills | `skill_list`, `skill_read`, `skill_write` | `skill_write` only if `allowSelfEdit` |
| automation | `schedule_upsert/list/delete`, `trigger_upsert/list/delete` | The agent can set up its own routines |
| multi-agent | `call_agent`, `delegate_tasks` | Section 6 |
| human-in-the-loop | `ask_user`, `request_approval`, `request_secret` | They pause the run (section 5) |
| notify | `notify_user` | Email, web push or Slack webhook |
| mcp | `<server>__<tool>` | Section 8 |

Browser and computer use comes later. When added, use Playwright inside the sandbox image, and Xvfb plus noVNC for takeover.

## 5. Human-in-the-loop and approvals

- **`ask_user`.** Takes a question plus optional choices. The answer is returned as the tool result.
- **`request_approval`.** The model can ask for approval explicitly. **In addition**, the policy gate can force approval on any tool call. The rules are `approval_rules`, checked from most to least specific:
  - per tool, e.g. `email_send: ask`;
  - with an argument match, e.g. `stripe_*` when `amount > 50`;
  - plus a default per agent: `autopilot` (allow all), `cautious` (ask on writes outside the sandbox), or `strict`.

  This is the "Autopilot" feature Rerun only advertises.
- **`request_secret`.** The UI shows a masked form. The value is encrypted into `secrets` and injected into the sandbox environment and MCP configs as `${NAME}`. The model never sees the value.
- **Timeouts.** Pending requests expire after N hours. The run is then resumed with a tool result of "no answer — timed out", so it can wrap up gracefully.
- **Who gets notified.** Waiting on a human notifies the owner by email or push, with a deep link to the answer form.

## 6. Multi-agent

- **`call_agent({handle, message, wait})`**
  - Starts a run on another persistent agent in a new session with `source='agent'`, recording `parent_run_id`.
  - **Depth limit:** `depth = parent.depth + 1`, refused when it reaches 4 or more.
  - **Loop guard:** refused if the target is already in the caller's ancestor chain.
  - **`wait:true`:** the caller's tool waits on the child's `run.finished` event, with a timeout, and returns its final text.
  - **`wait:false`:** returns `{runId}` immediately. The child's result can later be sent back as a message into the caller's session.
- **`delegate_tasks({tasks[]})`**
  - Starts temporary sub-runs of the same agent, 4 at a time and at most 10 tasks.
  - Each sub-run has fewer tools: no human-in-the-loop, no scheduling, no delegating.
  - Each gets its own temporary directory inside the sandbox, removed afterwards.
  - Results come back as `## Task N` sections.
- **Budget:** child runs count against the parent run's cost budget.

## 7. Memory

- **Storage.** Rows with a `kind` (preference, fact, task or note), FTS5 for keywords, and an embedding.
  - Embeddings can come from an embedding provider such as Voyage, or from a local model like `bge-small` through transformers.js.
  - Without embeddings, FTS5 alone is a fine start.
- **Recall score:** `0.7·cosine + 0.3·bm25_norm`, multiplied by strength.
  - Strength decays with a half-life per kind: task 3 days, note 3 weeks, fact 6 weeks, preference 3 months.
  - Each access raises it again.
  - The top 5 go into the user turn.
- **Write path.** Before inserting, find the 5 nearest memories and ask Haiku whether this is new, an update to one of them, or a duplicate.
- **Curator.** It runs after each completed run when `autoMemory` is on. Haiku reads the last exchange and returns at most two new or updated memories and a list of obsolete ids.

## 8. Integrations through MCP

- **Declaring servers.** `agent.json → mcp: [{name, transport: 'stdio'|'http', command|url, env|headers}]`. Secrets are referenced as `${NAME}`.
- **The client.** Use the `@modelcontextprotocol/sdk` client. Pool connections per agent and server, close them after 10 minutes idle, and time out connects after 20 s.
- **Where stdio servers run.** **Inside the sandbox container**, so third-party MCP code is isolated too.
- **Tool names.** Each tool is listed as `<server>__<tool>`, and the policy gate applies to MCP tools like any other.
- **OAuth.** For MCP servers that need it, implement the MCP authorization flow. The callback lands on our server, and tokens are stored encrypted in `secrets`.
- **Breadth of apps.** For many apps at once, plug in an aggregator MCP (Composio, Pipedream, Zapier MCP) instead of building connectors yourself.

## 9. Triggers

- **Chat.** `POST /agents/:id/sessions/:sid/messages` returns 409 if a run is already active in that session, or queues the message (configurable). The response streams over SSE.
- **Cron (scheduler tick, every 30 s).** For each enabled schedule:
  - compute the latest slot ≤ now (via `croner`, timezone required, defaulting to the workspace timezone);
  - if that slot is after `last_fired_slot`, take a **lease** with `UPDATE … WHERE lease_until < now`, write `last_fired_slot`, and queue a run;
  - missed slots collapse into one run;
  - the lease makes it safe once several workers run;
  - the prompt is wrapped as `<scheduled_run name=… slot=…>`.
- **Webhooks.**
  - **URL:** `POST /hooks/:agentHandle/:slug/:token`, where only a hash of the token is stored and it's compared in constant time.
  - **Errors:** every failure returns 404; a wrong method returns 405.
  - **Limits:** the body is capped at 1 MiB, with a token-bucket rate limit per trigger.
  - **Idempotency:** taken from the `Idempotency-Key` header, or a hash of the body for 10 minutes.
  - **HMAC:** optional signature check for providers that sign requests (Stripe, GitHub).
  - **Bots:** link-preview bots get a 204.
  - **Message:** the trigger prompt plus a `<webhook_payload method=… content_type=… truncated=…>` block, at most 64 KiB, with closing tags escaped.

## 10. API surface (MVP)

```
POST   /agents                         create (name, handle, soul, model, tools)
GET    /agents /agents/:id             list / get
PATCH  /agents/:id                     update config / soul
POST   /agents/:id/sessions            new chat
POST   /agents/:id/sessions/:sid/messages   send → {runId}
GET    /runs/:id/stream                SSE (replay buffer, reconnectable)
POST   /runs/:id/cancel
GET    /hitl?status=pending            inbox
POST   /hitl/:id/answer                {answer | decision: approve|deny, note}
PUT    /agents/:id/schedules/:slug     upsert;  POST …/run  (run now)
PUT    /agents/:id/triggers/:slug      upsert → returns URL once (token shown once)
POST   /hooks/:handle/:slug/:token     public webhook
POST   /mcp                            (later) our own MCP server so Claude Code can manage agents
```

**Auth:** every route needs an API key or session token, compared in constant time and never skipped. Webhooks are the only public routes.

## 11. Security checklist

- A sandbox container per workspace. The server's environment is never passed into tool processes.
- Optional network allowlist for the sandbox (egress proxy).
- Secrets encrypted at rest and handed to processes only by name. Scrub secret values from tool output before it is saved or sent to the model.
- Policy gate on every tool call. External side effects (email, payments, deletes outside the sandbox) default to `ask`.
- Treat fetched web pages, emails and webhook bodies as untrusted. Wrap them in tags, and add a system rule that their contents are data, not instructions.
- Budgets per run and per day for each agent; cron runs stop when the budget is exhausted.
- An audit log of every tool call (already covered by the `tool_calls` table).

## 12. Build plan

| Phase | Deliverable | Done when |
|---|---|---|
| 1 | Loop and tools: Runner, Store, fs, shell (Docker sandbox), web_fetch; CLI chat | An agent can read and write files and run commands in its container across multiple steps |
| 2 | API + SSE + minimal web UI (agent list, chat, run log) | Chat in the browser with streamed tool calls |
| 3 | Triggers: scheduler with leases, webhooks with rate limits and idempotency | A cron agent posts a daily summary, and a webhook agent reacts to a test POST |
| 4 | Human-in-the-loop: hitl_requests, policy gate, approval inbox, notifications, secrets | A run pauses on `send_email`, survives a server restart, then resumes after approval |
| 5 | Memory and skills: memory tools, curator, skills index and `skill_read`, compaction | An agent recalls a preference from a week-old session; a long session compacts without losing the goal |
| 6 | Multi-agent and MCP: call_agent (depth and loop guards), delegate_tasks, MCP pool | A "manager" agent delegates research to 3 sub-tasks and uses a GitHub MCP server |
| 7 | Hardening: budgets, egress allowlist, an eval suite of scripted scenarios with a mock model, a Postgres option | Evals green in CI |

**Testing approach:** a `FakeModel` that replays scripted `tool_use` sequences. Every phase can then be tested with no API calls. A small set of live tests is gated by `ANTHROPIC_API_KEY`.

## 13. Suggested repo layout

```
agent-platform/
  src/
    server.ts            # Hono app, routes
    runner/loop.ts       # Runner.run, settle, resume
    runner/compaction.ts
    runner/prompt.ts     # stable + volatile system blocks
    queue.ts             # RunQueue (in-proc, session locks)
    store/db.ts          # SQLite + migrations
    store/files.ts       # agent dirs, front-matter loaders
    sandbox/docker.ts    # exec, fs ops, lifecycle
    tools/*.ts           # one file per family + registry.ts + policy.ts
    mcp/pool.ts
    triggers/scheduler.ts  triggers/webhooks.ts
    hitl/service.ts      notify/*.ts
    memory/store.ts      memory/curator.ts
  sandbox/Dockerfile     # node, python, git, ripgrep, playwright (later)
  test/                  # FakeModel scenario tests
```
