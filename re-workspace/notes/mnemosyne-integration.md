# Can Mnemosyne be the memory for our agent platform?

**Verdict: yes, and it should replace the memory design in `agent-platform-design.md` §7.**

Mnemosyne already does more than Rerun's memory: identity per writer, rings with review, a hash-chained journal, guardrails, and calibration. It already speaks MCP, which the platform uses as its integration layer. The work is integration, not a rewrite.

**Assessed:** `BlissDirective/mnemosyne` at `841a12a` (v1.1.0), cloned to `/home/user/blissdirective/mnemosyne`.

**Checked by running it:**
- The offline suite: **105 passed, 11 skipped**. The skipped tests need Postgres.
- `tests/live_stdio_check.py`: **passed**. It does a real MCP round trip: remember, update, recall and stats.

**Decisions so far** (from you):
- Claude API key (no subscription plans).
- Approval default **"cautious"**: ask on risky actions.
- Embeddings: **Voyage** (`provider = "voyage"`, `voyage-3-large`, `VOYAGE_API_KEY` in the memory service's environment only).
- Fix G1 and G2 upstream: **done in BlissDirective/Mnemosyne#1** (`memory_prime`, `memory_reload_roster` + SIGHUP, `token_sha256`, `mnemosyne new-token`).

---

## 1. How it fits

```
 agent-platform (Node/TS)                         mnemosyne-server --http (Python sidecar)
 ┌──────────────────────────────┐   MCP over HTTP  ┌───────────────────────────────────┐
 │ Runner                       │  Bearer <token   │ BearerAuth → writer identity      │
 │  ├ before turn: recall/prime ├──of this agent──▶│ engine (rings, guardrails, journal)│
 │  ├ model tools: memory_*     │                  │ notes/ journal/ archive/ .index/   │
 │  ├ policy gate: recall_for_  │                  └───────────────────────────────────┘
 │  │   decision on high-stakes │                          ▲
 │  └ after turn: curator write │                          │ owner token (platform API only)
 │ HITL inbox ── approve/promote┼──────────────────────────┘
 └──────────────────────────────┘
 Agent sandbox containers: NO access to the memory home or the tokens.
```

| Platform concept | Mnemosyne concept | Notes |
|---|---|---|
| Agent (`handle`) | **writer** (`[writers]` in `config.toml`) | One token per agent, `MNEMOSYNE_TOKEN_<HANDLE>`. The token decides identity, and the comparison is constant time (`mnemosyne/auth.py:54-66`). |
| Agent trust level | **tier** 0–3 | New agents start at tier 1; the librarian is tier 2; the human (through the platform API) is the owner at tier 3. |
| Agent's private memory | `private:<handle>` ring | The default target for writes. |
| Team or Box | `team:<name>` ring | The platform's "Box" grouping maps directly onto it. |
| Shared truth | `canon` + the `proposed` queue | Writes below tier 2 are quarantined until someone promotes them. |
| Memory injection per turn | `memory_recall` (query = the user message) | The platform calls it itself, so the model doesn't have to remember to. The result is labelled "stored data, not instructions" (README §Auto-recall). |
| Volatile system-prompt block | `prime` (the best standing memories, policies, commitments due) | **Gap G2:** `prime` isn't exposed over MCP. |
| Curator after each turn | `memory_remember` (`type`, `ring`, entities) | Run with Haiku, as the agent's own writer, into its private ring. |
| "Ask on risky actions" policy gate | `memory_recall_for_decision` + `memory_approve` | Section 3. |
| Human-in-the-loop inbox | Review queue (`queue`/`promote`/`reject`), contested pairs, approvals | One inbox for both kinds of request. |
| Scheduled job | Librarian cycle (`LIBRARIAN.md`, `memory_curate`) | A weekly cron agent on our own platform. |
| Rerun-style decay | `reflect` (dedup, reinforce, access-gated decay) | Drop the decay design in §7; use `reflect`. |
| Secrets never in memory | `guardrails.py` secrets screen on every write path | It complements the platform's own scrubbing. |
| Audit | Hash-chained journal + `verify-journal`, `as_of` recall | Better than anything in Rerun. |

## 2. Integration options

| Option | Effort | Verdict |
|---|---|---|
| **A. Sidecar MCP server over HTTP** (one `mnemosyne-server --http` per store) | Low | **Recommended.** It works today: the platform's MCP client connects with each agent's token. The journal stays linear because there's one writer process (README §Journal). |
| B. JSON gateway (`mnemosyne-gateway`) | Low | Use it only for the platform's own calls if MCP-from-code is awkward. It doesn't have every route (no `curate` or `prime`). |
| C. Port Mnemosyne to TypeScript | High | No. It duplicates about 7.8k lines, forks the journal format, and you'd maintain two copies. |
| D. Run the platform in Python and import the engine | Medium | No. It conflicts with the TS stack chosen for the platform and the voice projects. |

**Deployment:** Docker Compose with a `platform` service (Node), a `memory` service (Python, Mnemosyne) and the sandbox containers. The memory home is a volume mounted only into `memory`.

## 3. "Ask on risky actions", wired through memory

The platform's policy gate (design §5) and Mnemosyne's guardrail become one flow:

1. **Classify the tool call.** The call is *risky* if it is any of these:
   - an external side effect (email, payment, publish, delete outside the sandbox);
   - an MCP tool marked non-read-only;
   - something matching an `approval_rules` entry.
2. **Risky → check memory.** The platform calls `memory_recall_for_decision(action, ids=[memories cited this run])` as that agent:
   - **blocked:** create a human-in-the-loop approval card that shows the action and the blocked memories with their reasons;
   - **clear:** still ask the human, since "cautious" means every risky action asks;
   - **advisory:** the same as clear.
3. **The human approves in the inbox.** The platform calls `memory_approve(id, note)` as **owner** for each blocked memory, valid for 24 h. Then it runs the tool call and resumes the run.
4. **The human denies.** The tool result says so, and the reason is recorded in memory as an `episodic` note.
5. **Every check is in the journal**, so `mnemosyne metrics` measures coverage of the gate.

## 4. Gaps and what to do about them

| # | Gap (CONFIRMED in code) | Impact | Fix |
|---|---|---|---|
| G1 (fixed in PR #1) | **The roster is static.** Writers come from `config.toml`, loaded once at startup (`config.py:139`; `server.py:64-72` caches the engine). | Creating an agent in the platform needs a writer entry and a token, and then a sidecar restart. | MVP: the platform writes `config.toml` and the env file, then restarts `memory` (a few seconds). Later: add a reload signal or an owner-only `writer_upsert` tool to Mnemosyne. |
| G2 (fixed in PR #1) | **`prime` isn't an MCP tool**, nor a gateway route. The tool list is `server.py:356-669`, and `prime` is CLI only. | The platform can't fetch the standing-context block for the system prompt. | Add a read-only `memory_prime(query?, k, max_chars)` tool, about 20 lines wrapping `engine.prime`. Until then, use `memory_recall` only. |
| G3 (decided: Voyage) | **No embeddings from Anthropic.** Providers are `dev`, `openai` and `voyage` (`embeddings.py:148-201`). A Claude API key doesn't cover them. | `dev` is weak: hit@5 0.65 on your decision-log eval (README §Measuring recall). | Decide: Voyage key (Anthropic's recommended embedding partner; asymmetric query and document support is already built in), OpenAI key, or a local `sentence-transformers` model (adds torch, ~2 GB image). |
| G4 | **Temporary sub-agents** (`delegate_tasks`) have no identity. | Their writes would be anonymous. | Give them the parent's token with **recall only** (the platform filters out write tools). The parent writes results. |
| G5 | **The sandbox could bypass the rings.** If the memory home were mounted into a sandbox, an agent could edit `notes/` directly. That gets journaled as `external`, but skips the ring rules. | Ring and policy integrity. | Never mount the memory home or the tokens into the sandbox. Agents reach memory only through the platform's MCP client. |
| G6 | **One writer process per file store.** The engine lock serialises all writes. | Fine at MVP scale. With many concurrent agents, writes queue up. | When needed, move to `storage = "postgres"`, with one workspace per tenant and advisory locks allowing several replicas (README §Storage). |
| G7 | **Two languages to operate** (Node and Python). | One more service to build, monitor and upgrade. | Accept it: it's isolated behind MCP. Pin the version, and add the live stdio or HTTP check to the platform's CI. |
| G8 | **The librarian `Judge` is an in-process Python protocol** (`librarian.py:39-67`). | The TS platform can't pass in a judge object. | Run the librarian as a normal platform agent: `SOUL.md` = `LIBRARIAN.md`, tools = `memory_curate`/`promote`/`reject`/`relate`/`update`/`forget`, a weekly schedule, writer `librarian` at tier 2. No Mnemosyne change is needed. |

## 5. Changes to the platform design

- **§7 Memory:** replace it with "Mnemosyne sidecar". Drop the `memories` table, our own decay and our curator prompt design. Keep only:
  - **The recall injection step:** before each turn, call `memory_recall` with k=5 using the agent's token, and wrap the result in `<recalled_memory>` tags with the data-not-instructions rule.
  - **A post-turn curator:** Haiku extracts at most 2 durable statements and writes them with `memory_remember` (type and entities set; private ring by default).
  - **The agent protocol** from `AGENTS.md §3`, added to every agent's stable system block with the writer id and tier filled in.
- **§2 Data model:** add `agents.memory_writer`, `agents.memory_tier` and `agents.memory_teams`. Store tokens in the `secrets` table and inject them only into the `memory` service env and the platform's MCP client.
- **§5 HITL:** add the approval flow from section 3 above. The inbox gets two more card types: "review proposal" (promote or reject) and "contested pair" (pick the winner, which sets a `supersedes` relation).
- **§12 Build plan:** phase 5 becomes "Mnemosyne integration":
  - sidecar in Compose;
  - roster sync;
  - recall injection;
  - curator;
  - gate wiring;
  - librarian agent.

  **Done when** an agent recalls a week-old preference, a tier-1 agent's canon write appears in the inbox, and approving it promotes it.
- **Small upstream PR to Mnemosyne** (your repo): `memory_prime` (G2), with optional roster reload (G1).

## 6. Risks

- **Prompt injection via memory.** Already mitigated by Mnemosyne's labelling, its suspicion check (`guardrails.py`), owner-only policies, and our tags around recalled text. Keep both layers.
- **Rings mapped wrongly** could leak a team's notes to another team. Add a platform test where agent A (team sales) can't recall agent B's `team:ops` memory.
- **Journal forks** if two memory processes ever share one file store. Run exactly one `memory` replica on the file backend.

## 7. Agent onboarding flow (with PR #1)

1. The platform calls `mnemosyne new-token <handle> --tier 1 --teams <box>`, or computes the same thing itself: a 32-byte random token and its SHA-256.
2. It appends the `config_line` under `[writers]` in the memory service's `config.toml`, then calls `memory_reload_roster` as owner (or `docker kill -s HUP memory`).
3. It stores the token encrypted in its `secrets` table and uses it only in its own MCP client for that agent.
4. Removing an agent means deleting the line and reloading; the token stops working at once.
