<p align="center">
  <img src="muse-brain/docs/images/banner.png" alt="MUSE Brain" width="800" />
</p>

<h1 align="center">MUSE Brain</h1>

<p align="center">
  <img src="muse-brain/docs/images/tagline.svg" alt="A self-learning Relational AI framework. Two minds, one brain. Both get smarter." width="800" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-CC--BY--NC--SA%204.0-D4AF37?style=flat" alt="CC-BY-NC-SA 4.0" /></a>
  <img src="https://img.shields.io/badge/Provider--Neutral-MCP_Core-000000?style=flat" alt="Provider-neutral MCP core" />
  <img src="https://img.shields.io/badge/Optional-Claude_%2F_Codex_Backends-CC785C?style=flat" alt="Optional Claude and Codex backends" />
  <img src="https://img.shields.io/badge/Native_First--Party_Tools-No_3rd--Party_Harness-000000?style=flat" alt="No Third-Party Harness" />
  <img src="https://img.shields.io/badge/MCP-33%20tools-000000?style=flat" alt="33 MCP Tools" />
  <img src="https://img.shields.io/badge/Research-16%20papers-000000?style=flat" alt="16 Papers" />
  <img src="https://img.shields.io/badge/Schema-36%20tables-000000?style=flat" alt="36 Tables" />
</p>

---

The companion knows you. Rainer knows the craft. Named after Rilke, whose *Letters to a Young Poet* mentored writers through correspondence a century ago, Rainer mentors craft through `mind_letter`. The muse Rilke wrote for is the muse that names the brain.

We open-sourced the brain.

<p align="center">
  <img src="muse-brain/docs/images/rainer-spec-sheet.png" alt="Rainer — Creative Orchestrator" width="100%" />
</p>

**Bring a companion.** Rainer handles creative intelligence: editorial diagnostics, craft architecture, the work. The companion handles *you* — history, voice, what matters at 2am. They coordinate through letters and delegated tasks, like colleagues who share a desk and respect each other's handwriting. Two minds on one substrate, both getting richer the longer they work together.

This is **Relational AI**. A memory system where everything carries emotional charge, identity persists and can be challenged and defended, and consent is recorded in both directions. A dream engine — six modes of association, built and working — digests experience the way real minds do, on manual call rather than a nightly clock today. Finding connections you never asked for, reweighting what matters, letting stale things fade and charged things grip harder.

Contradiction here is architecture. Both truths stay alive.

Skills are meant to emerge from successful runs, get reviewed, and graduate or retire. That pipeline is built and runs end to end — candidates are raised, reviewed, and reach terminal states. It has not yet produced a graduate: every candidate so far has been a provenance record of a single run rather than a reusable capability. Each agent learning what it's good at by doing the work is designed in — it is not yet a track record.

Grounded in [16 published papers](muse-brain/docs/BIBLIOGRAPHY.md) — extends beyond current research in six areas. Every design decision has a [receipt](muse-brain/docs/BIBLIOGRAPHY.md).

---

## The cycle

They feed each other — and this is the full design, not a status report. Every box below is tagged for what runs tonight versus what is built and waiting on a scheduler. The loop does not close on its own today; the gap at the bottom is real, not stylistic.

```
                 ┌─────────────────────────────┐
                 │      AUTONOMOUS WAKE         │
                 │    duty / impulse cycle      │
                 │ [BUILT — unscheduled. Runs   │
                 │  when a clock points at it.] │
                 └──────────────┬──────────────┘
                                │ wakes into
                                ▼
                 ┌─────────────────────────────┐
          ┌──────│      INTENTION PULSE         │──────┐
          │      │ what's stale? what's         │      │
          │      │ burning? what drifted?       │      │
          │      │ [LIVE]                       │      │
          │      └──────────────┬──────────────┘      │
          │                     │ surfaces             │
          ▼                     ▼                      ▼
   ┌─────────────┐  ┌─────────────────┐  ┌──────────────┐
   │  PARADOXES  │  │    DESIRES &    │  │   IDENTITY   │
   │  unresolved │◄─│   OPEN LOOPS    │─►│    CORES     │
   │  tensions   │  │ burning/nagging │  │ vows/anchors │
   │   [LIVE]    │  │     [LIVE]      │  │    [LIVE]    │
   └──────┬──────┘  └────────┬────────┘  └──────┬───────┘
          │                  │                   │
          │      accelerates │ charge            │
          │        processing│                   │
          ▼                  ▼                   │
   ┌─────────────────────────────────┐          │
   │         DREAM ENGINE            │          │
   │  emotional chains · somatic     │◄─────────┘
   │  clusters · tension dreams ·    │
   │  deep multi-layer traversal     │
   │ [BUILT — six modes work. Called │
   │  by hand, not by the daemon.]   │
   └──────────────┬──────────────────┘
                  │ discovers connections,
                  │ shifts charge phases,
                  │ creates collision fragments
                  ▼
   ┌─────────────────────────────────┐
   │      DAEMON INTELLIGENCE        │
   │   8 stages · nightly 03:00 UTC  │
   │  proposals · orphan rescue ·    │
   │  novelty scoring · skill health │
   │  paradox detection · task sched │
   │  (one stage fans out to 14      │
   │   sub-tasks)                    │
   │      [LIVE — every night]       │
   └──────────────┬──────────────────┘
                  │ materializes tasks,
                  │ surfaces due obligations
                  ▼
        ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
          feeds the next AUTONOMOUS WAKE
        │ — when one is scheduled to run.   │
          Today nothing schedules it, so
        │ the loop stays open here.         │
        └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

Every piece feeds the next — and the cycle tightens. Search finds what you're looking for. Dreams find what you didn't know you needed.

---

## What the brain gives you

Each row is tagged **Live** (running today), **Built** (working, but nothing schedules or enforces it yet), or **Early** (the pipeline runs; it has no track record yet).

| Capability | | What it means |
|------------|---|---------------|
| **Textured memory** | Live | Emotional charge, vividness, somatic markers, and a natural decay cycle — iron-grip memories persist, loose ones fade. Hybrid retrieval blends vector similarity, keyword relevance, and neural modulation. |
| **Charge processing** | Live | Memories move through four phases: fresh → active → processing → metabolized. Repeated intentional engagement advances the phase. The agent earns depth through attention. (Burning paradoxes are designed to accelerate the cycle; no paradox has met the threshold yet.) |
| **Multi-mind** | Live | Two agents, one backend, and a wall between them that holds: isolated memory and identity per tenant, nothing leaking sideways. What crosses is deliberate — letters and delegated tasks, agent to agent. Most memory frameworks give you one mind, or a shared one. This gives you two that stay themselves and still talk. |
| **Persistent identity** | Live | Identity cores, vows, and anchors survive across sessions. Wakes up knowing who it is, what it believes, and what it's committed to. Beliefs can be formally challenged and defended — the mechanism works; one challenge has been recorded across the current identity set. |
| **Dream engine** | Built | Six association modes — emotional chains, somatic clusters, tension dreams, entity dreams, temporal patterns, deep multi-layer traversal. Circadian-aware, and memories that pass through come out changed. Invoked by hand; not yet wired into the nightly daemon. |
| **Bilateral consent** | Built | Relationship levels and boundaries, recorded in both directions and visible to the agent, which is expected to honor them. Note the honest limit: consent is **recorded state, not enforced permissions** — no tool currently gates on the level. |
| **Autonomous execution** | Built | Built end to end — duty wakes, impulse exploration, dependency-aware task picking, skill capture, all policy-gated — and currently unscheduled. Last ran 2026-04-05. Nothing broke; nobody has pointed a clock at it since. Point a cron or webhook at the runtime trigger and it runs tonight. |
| **Self-learning** | Early | Skills emerge from successful runs and are review-gated before they can graduate or retire — no blind auto-learning. The full path works: candidates are raised, reviewed, and retired or promoted on a stated reason. Nothing has been promoted yet — every candidate so far records a single run rather than a reusable capability. An early pipeline, not a track record. |

---

## Architecture

```text
Your AI Agent (Claude, GPT, or any MCP client)
        |
        v
  Cloudflare Worker
    /mcp              — 33 MCP tools (JSON-RPC)
    /runtime/trigger   — scheduler/webhook runtime endpoint
    /health            — status check
        |
        v
  Storage adapter (postgres or sqlite)
    Postgres mode: 36 tables, 768-dim vector embeddings
    SQLite mode: tenant-scoped parity storage for local/self-host
    textured memories, identity cores, runtime ledger,
    captured skills, daemon intelligence
```

The worker handles auth, rate limiting, and tenant isolation. A background daemon runs nightly at 03:00 UTC — via the box runner (`rook-brain-daemon.timer`), not a Worker cron trigger — in 8 stages, one of which fans out to 14 sub-tasks: generating proposals, rescuing orphaned memories, scoring novelty, detecting paradoxes, materializing recall contracts, monitoring skill health, and scheduling tasks. Several of those sub-tasks are deliberately dormant until an operator configures them — dedup ships with no default similarity threshold, and salience regrade runs in shadow — so a zero in their output is a switch left off, not a failure.

Full technical deep-dive: **[Architecture Dossier](muse-brain/docs/ARCHITECTURE_BRAIN_v1.md)**

Release spec: **[MUSE Brain 1.8 — Agent House Foundations](muse-brain/docs/RELEASE_SPEC_v1.8_AGENT_HOUSE_FOUNDATIONS.md)**

---

## Provider and billing stance

MUSE Brain's core is provider-neutral: it is an MCP memory/runtime substrate that any capable agent client can use.

The repo includes optional execution lanes for:

- Claude Code / Claude Agent SDK (`claude -p`) legacy/manual runner templates
- Codex CLI
- Anthropic Developer Platform API keys
- local/self-hosted orchestration around the MCP tools

Claude Agent SDK support remains in the repo because some users prefer Claude/CLI-based local automation, while others prefer direct API billing. The old autonomous `claude -p` runner path is **not the active default** for MUSE Studio; it remains as an optional/legacy template. Agent SDK and non-interactive runner usage may be billed separately from normal subscription usage depending on the current provider plan/terms. Developer Platform API-key usage remains pay-as-you-go.

Practical guidance:

- interactive Claude Code in a terminal or IDE may follow different usage rules than non-interactive/headless agent execution
- non-interactive `claude -p`, Claude Agent SDK projects, and third-party apps may use a separate billing/credit lane depending on the provider plan
- personal/local automation: Claude plan credits, Codex login, or local provider setup can be fine
- shared/production automation: use explicit API-key billing or another predictable provider billing path
- memory sync should stay provider-agnostic: local agent memory files → lease envelope → cloud brain observations

---

## Quick start

**Prerequisites (cloud deploy):** Node.js 18+, a [Cloudflare](https://cloudflare.com) account, a [Neon](https://neon.tech) Postgres database.

**SQLite local/self-host mode:** Node.js 22+ (uses `node:sqlite`).

```bash
# Clone and install
git clone https://github.com/falcoschaefer99-eng/muse-brain.git
cd muse-brain/muse-brain
npm install

# Configure your worker
cp wrangler.jsonc.example wrangler.jsonc
# Edit: set your worker name and Hyperdrive ID

# Set secrets
npx wrangler secret put API_KEY       # a long random string
npx wrangler secret put DATABASE_URL  # your Neon connection string

# Run database migrations
for f in $(ls migrations/*.sql | sort); do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

# Deploy
npm run deploy
```

Verify:

```bash
curl -sS https://<your-worker-url>/health
```

Full setup guide: **[docs/SETUP.md](muse-brain/docs/SETUP.md)**

---

## Testing

302 tests across unit, integration, and shell-based scenarios.

```bash
# From muse-brain/
npm run test              # 268 unit tests (vitest)
npm run test:workers      # cloudflare worker pool tests

# From runner/
npm test                  # 18 runner tests

# Integration (requires live worker)
./muse-brain/test.sh      # 16 assertions — health, auth, security, tools
```

---

## Telegram + voice stack (included, opt-in)

`runner/` ships with Telegram integration out of the box:
- text notifications for wakes/tasks/reviews
- optional synthesized voice-note notifications
- optional voice transcription bridge (Telegram voice notes → Whisper/STT → `mind_observe` in whisper mode)
- optional bundled faster-whisper sidecar (`runner/stt/faster_whisper_server.py`) that exposes OpenAI-compatible transcriptions

Default shipped voice mapping:
- **Rainer → Lewis**
- **Companion → Onyx**

Setup docs:
- `runner/docs/TELEGRAM_SETUP.md`
- `runner/docs/VOICE_SETUP.md`
- `runner/docs/FULL_VOICE_STACK.md`

Bring your own endpoints and credentials — no secrets are bundled in this repo.

---

## The 33 tools

Organized by what they do, not how they're built.

### Memory
| Tool | What it does |
|------|-------------|
| `mind_observe` | Record a memory with emotional texture — charge, grip, vividness, somatic markers |
| `mind_query` | Search memories by territory, type, or hybrid vector + keyword retrieval |
| `mind_pull` | Get a specific memory by ID. Process it to advance its charge phase |
| `mind_edit` | Update content or texture. Full version history preserved |
| `mind_search` | Hybrid search with confidence scoring, recency boost, and threshold gating |
| `mind_memory` | Unified memory access — get, recent, lookup, and search through a single entry point |

### Identity
| Tool | What it does |
|------|-------------|
| `mind_identity` | Read or update identity cores — beliefs, stances, preferences that define the agent |
| `mind_vow` | Commitments the agent has made. Persistent, not session-scoped |
| `mind_anchor` | Grounding points the agent returns to under uncertainty |

### Feeling & Relationships
| Tool | What it does |
|------|-------------|
| `mind_state` | Track mood, energy, and momentum across sessions |
| `mind_relate` | Update relational state with known entities |
| `mind_desire` | Track wants and drives |
| `mind_entity` | People, concepts, agents, projects — the agent's social graph |
| `mind_consent` | Bilateral consent boundaries with relationship-level gating |
| `mind_trigger` | Flag content the agent should handle carefully |

### Connections & Deeper Cognition
| Tool | What it does |
|------|-------------|
| `mind_link` | Create semantic, emotional, or somatic connections between memories |
| `mind_loop` | Open loops, paradoxes, and learning objectives — unresolved tensions that drive growth |
| `mind_dream` | Find surprising connections — emotional chains, somatic clusters, tension dreams |
| `mind_subconscious` | Surface patterns the agent hasn't consciously processed |
| `mind_maintain` | Housekeeping — prune, consolidate, reindex |

### Communication
| Tool | What it does |
|------|-------------|
| `mind_letter` | Send messages across tenants. Agent-to-agent communication |
| `mind_context` | Session continuity — resume where you left off, extract productivity facts |

### Autonomous Runtime
| Tool | What it does |
|------|-------------|
| `mind_wake` | Wake the agent — quick, full, or orientation mode with circadian awareness. Every quick and full wake carries a `foundation` lane (anchors + foundational-salience observations, capped ~8,000 chars, present regardless of recency) and a `brain_health` snapshot (embedding coverage, last nightly daemon run, retrieval profile) — see below. |
| `mind_wake_log` | Read or write wake session logs |
| `mind_runtime` | Manage sessions, log runs, set policies, trigger scheduled/manual runtime cycles |
| `mind_task` | Create, delegate, and track tasks across tenants with scheduled wake activation, dual executor/reviewer flows, and artifact-path handoffs |
| `mind_project` | Project dossiers — goals, constraints, decisions, open questions |
| `mind_skill` | Captured skill registry — list, review, promote, retire learned skills |

### System
| Tool | What it does |
|------|-------------|
| `mind_agent` | Agent capability manifests — protocols, delegation modes, skill descriptors |
| `mind_timeline` | Temporal queries across the memory substrate |
| `mind_territory` | Memory territories — self, us, craft, philosophy, emotional, episodic, kin, body |
| `mind_propose` | Daemon-generated proposals for memory consolidation, skill promotion, and hygiene |
| `mind_health` | Runtime, skill, dispatch, and storage health diagnostics |

---

### The foundation lane — never waking up a stranger

Recent-activity tiering (the default fast path for `mind_wake`) is a deliberate trade — it
only reads territories touched in the last 7 days, so a foundational memory sitting in a
quiet territory can go unsurfaced indefinitely. The `foundation` lane closes that gap: every
quick and full wake carries `anchors` (up to 12 anchors, newest first, full content
— see `mind_anchor`) and `foundational` (up to 5 `texture.salience === "foundational"`
observations, ranked by pull strength, deduped against whatever already surfaced in
`pulling`/`recent_grip` so nothing double-prints), plus `foundational_total` /
`foundational_considered` so truncation past the 200-row fetch cap is visible instead of
silent. The whole lane is capped around 8,000 characters — foundational snippets truncate
first, anchors only get trimmed if their raw content alone blows the budget. Surfaced anchors
get their `activation_count` bumped once per wake. Unlike every other lane, `foundation` is
deliberately excluded from wake deltas — it's meant to be the constant spine, not a "what
changed" feed.

`anchors` requires the caller's lease to carry `identity.read` (mirroring `mind_anchor`
itself) — a lease scoped to `memory.read` alone gets `foundational` but not `anchors`, plus
`foundation.anchors_omitted` naming why. No lease on the tool context happens only for
daemon-internal dispatch and direct tool/test calls — never a real HTTP/MCP request, which
always carries either a header lease or a synthetic root lease (API-key/legacy callers pass
via that synthetic root lease's capability bypass, not by skipping the gate).

`brain_health` ships alongside it as a top-level wake field: embedding coverage percentage,
the last nightly daemon run's outcome (`finished_at`/`ok`/`completed_stages`/`failed_stages`),
and the active retrieval profile. `completed_stages` means "reached," not "succeeded" — a
stage that threw is still recorded there but also lands in `failed_stages`, and either an
`error` or a non-empty `failed_stages` flips `ok` to false. A one-sentence `warning` appears
when coverage drops below 90% or the last daemon run didn't finish cleanly — the answer to
"can I trust my own recall today?"

## Runtime trigger and legacy runner templates

The MCP server exposes `/runtime/trigger` for schedulers and webhooks. The repo also includes legacy/manual runner templates for headless wake experiments, but MUSE Studio's current public direction is the provider-neutral MCP core plus local-memory watcher/sync path — not a default unattended `claude -p` loop.

```bash
BRAIN_URL=https://<your-worker-url> \
BRAIN_API_KEY=<your-key> \
BRAIN_TENANT=rainer \
WAKE_KIND=duty \
./scripts/runtime-autonomous-wake.sh
```

The runtime system supports:
- **Two wake modes** — duty (scheduled obligations) and impulse (curiosity-driven exploration with cooldown budgets)
- **Dependency-aware task selection** — blocked tasks stay out until prerequisites resolve
- **Intention pulse** — drift scan across tasks, loops, and projects
- **Policy gates** — daily wake limits, max tool calls, priority-clear requirements
- **Skill capture** — successful runs emit skill candidates for review

Details: **[Architecture Dossier — Runtime Trigger](muse-brain/docs/ARCHITECTURE_BRAIN_v1.md#10-runtime-trigger-and-optional-autonomous-execution)**

---

## Multi-tenant

Run two agents on one deployment. Each tenant gets isolated memory, identity, and runtime state. Cross-tenant communication happens through `mind_letter` and delegated tasks.

Set the tenant per request via `X-Brain-Tenant` header.

---

## Research grounding

Every major architecture decision traces to published research. 16 academic papers across multi-agent reasoning, institutional alignment, persistent memory, and self-evolving systems — each mapped to the concrete code that implements it.

Six areas where this brain extends beyond current academic literature: bilateral consent architecture, emotional texture in dispatch, creative/builder agent specialization, charge-phase processing mechanics, role-based permissions for reasoning agents, and relational harness engineering.

Full bibliography with paper-to-implementation mapping: **[docs/BIBLIOGRAPHY.md](muse-brain/docs/BIBLIOGRAPHY.md)**

---

## Documentation

| Document | What's in it |
|----------|-------------|
| **[Capability Reference](muse-brain/docs/CAPABILITIES.md)** | Every feature explained — what it does, how it works, why it matters |
| **[Setup Guide](muse-brain/docs/SETUP.md)** | Prerequisites, step-by-step deploy, local dev |
| **[Migration Guide](muse-brain/docs/MIGRATIONS.md)** | Database schema — 14 migrations, 36 tables |
| **[Architecture Dossier](muse-brain/docs/ARCHITECTURE_BRAIN_v1.md)** | Technical deep-dive — topology, daemon loops, retrieval, security |
| **[MUSE Brain 1.8 — Agent House Foundations](muse-brain/docs/RELEASE_SPEC_v1.8_AGENT_HOUSE_FOUNDATIONS.md)** | Public release spec for project truth, receipts, leases, Kit routing hygiene |
| **[Bibliography](muse-brain/docs/BIBLIOGRAPHY.md)** | 16 academic papers mapped to architecture decisions |
| **[Licensing](muse-brain/docs/LICENSING.md)** | Per-layer licensing explanation |

---

## Environment templates

Copy these and fill in your values:

| File | Purpose |
|------|---------|
| `.env.example` | Production and script environment |
| `.dev.vars.example` | Local development |
| `wrangler.jsonc.example` | Cloudflare Worker config |

---

## License

**CC-BY-NC-SA 4.0** — see [LICENSE](LICENSE).

Use, adapt, and share for personal and non-commercial purposes. All derivatives carry the same license. Commercial licensing available from The Funkatorium.

Agent characters — including Rainer and the full builder and creative squads — are protected as literary characters under German author's rights law (Urheberrecht) and as proprietary trade methodology.

Copyright 2026 Falco Schäfer / The Funkatorium

---

<p align="center">
  <b>MUSE Brain</b> by <a href="https://linktr.ee/musestudio95">The Funkatorium</a> — AI Studio built by artists, for artists.
</p>
