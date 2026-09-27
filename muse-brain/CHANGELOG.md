# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- `mind_wake`: new `foundation` lane on every quick and full wake — up to 10 anchors (full content, newest first) and up to 5 `texture.salience === "foundational"` observations (ranked by pull strength, deduped against `pulling`/`recent_grip`), hard-capped around 3,000 chars. Anchors surfaced this way get `activation_count` bumped once per wake via a new single-write `touchAnchors` storage method. Deliberately excluded from wake deltas — the lane is meant to be the constant spine, not a change feed. (ADR-SURFACER-POC §0)
- `mind_wake`: new top-level `brain_health` field — embedding coverage percentage, last nightly daemon run outcome (`finished_at`/`ok`/`completed_stages`/`failed_stages`), and active retrieval profile, with a one-sentence `warning` when coverage drops below 90% or the last daemon run didn't finish cleanly.
- Storage: `IBrainStorage.readFoundationalObservations()` — a dedicated cross-territory read for `salience === "foundational"` observations, independent of the recency-ordered fetch window `queryObservations` uses, so an old foundational memory can't get buried behind newer ones.
- `mind_wake` / `mind_health section=janitor`: new `brain_health.janitor` block — foundational/iron/charge-phase counts, orphan and proposal stats, salience-regrade throughput, `backlog_mode` state, and last-run status, plus wake-time warnings for Foundation-lane truncation, an orphan backlog over 200, pending proposals aging past 21 days, and any daemon stage cut short by its own deadline. Daemon runs now carry a per-tenant 8-minute wall-clock deadline (`JANITOR_BUDGET_MS`) so a slow night truncates its loops cleanly and reports it, instead of running unbounded against the (since-retired) Cloudflare subrequest ceiling.
- New operator flag `daemon_config.data.backlog_mode`: widens the orphan rescue window (`RESCUE_LIMIT` 50→200), drops `MAX_RESCUE_ATTEMPTS` to 1 for faster archival, runs a second nightly absorption pass so archive proposals created during the drain don't sit a full day before being absorbed, and freezes the link-confidence threshold governor (see Fixed) for the duration. The daemon never sets this flag itself — flipping it is a manual, reversible operator write.
- New daemon proposal type `salience_regrade`: proposes demoting individual `salience: "foundational"` observations back to `active` (least-alive-first, via `calculatePullStrength` ascending) so they re-enter ordinary decay instead of being excluded from it forever. Shadow mode (`daemon_config.data.salience_regrade_shadow`, on by default) runs the full candidate scan but creates zero proposal rows, publishing a bounded preview instead (`janitor.regrade.candidates_last_scan` / `would_create_last_run`) — so lifting shadow evaluates the corpus as it stands then, rather than converting a pool of already-created shadow rows it can no longer act on. Non-shadow creation is throughput-capped by pending-review WIP (10 proposals before 30 total reviews, 25 after), never auto-accepted at any confidence, and never expires — a rejection is a permanent, deliberate tombstone by design.
- `npm run deploy` now runs `predeploy` (typecheck + the full unit suite) first. A module-load invariant assertion introduced this cycle (orphan-detection derivation, see Fixed) could otherwise fail Worker instantiation on every request for every tenant with nothing catching it before deploy. Bypass deliberately with `npm run deploy --ignore-scripts`.
- Corpus-wide `dedup` scan (`daemon/tasks/dedup.ts`, registered as the first daemon task each cycle): finds near-duplicate observation pairs above a similarity floor via a new `findSimilarByEmbedding` storage primitive, raw-cosine and deliberately not excluding already-linked pairs (unlike `findSimilarUnlinked`, whose exclusions were wrong for this purpose). Shadow by design, not by flag — there is no default `daemon_config.data.dedup_similarity_threshold`; the scan always runs and records the top-50 pairs by cosine (`last_dedup_scan`), but creates zero proposals until an operator configures a measured value from that distribution. On accept, a `dedup` proposal creates a `resonance_type: "duplicate"` link and metabolizes the newer of the two observations — never merges, never deletes, both copies stay fully retrievable. Never auto-absorbed and never AI-reviewed (removed from the Workers AI reviewer's candidate pool entirely) — like `salience_regrade`, it goes straight to a human review queue, since a dedup judgment ("these are the same memory") carries a much higher error cost than a link/rescue judgment and only a single cosine as evidence.

### Changed
- `charge_phase` now advances on `created_at` alone; `grip` and `vividness` continue to advance on `COALESCE(last_accessed_at, created_at)`, unchanged. Previously all three dimensions shared one access-gated clock, so a repeatedly-pulled old memory could reset its own `charge_phase` to `fresh` on every read — `charge_phase` names ingestion freshness, not access frequency, and grip/vividness are left rewarding access, which is the correct signal for them.
- `mind_health section=proposals` (and `section=all`) no longer echoes a `tenant_weights` block (`charge_weight`/`similarity_weight`/`entity_weight`). The link-proposal confidence-formula fix (below, under Fixed) removed the last code that read those `daemon_config.data` keys; health.ts was the only remaining live site, showing them back as though they still controlled scoring when they controlled nothing. Any caller parsing `mind_health` for that key now gets nothing back.

### Fixed
- `mind_wake`: `foundation.anchors` now requires the caller's lease to carry `identity.read` (or `system.root`/`*`/`identity.*`) — a lease scoped to `memory.read` alone previously got the full anchor set anyway, a scope bypass. Gated leases get `foundational` only, plus `foundation.anchors_omitted` naming why; no lease on the tool context happens only for daemon-internal dispatch and direct tool/test calls — never a real HTTP/MCP request, which always carries either a header lease or a synthetic root lease (API-key/legacy callers pass via that synthetic root lease's capability bypass).
- `daemon/cycle.ts`: per-stage errors now call `heartbeat.stageFailed(stage, err)` instead of falling through to `stageComplete` — `completed_stages` meant "reached," not "succeeded," so a stage that threw and was swallowed still reported clean. `brain_health.last_daemon.ok` now also considers the new `failed_stages` list, not just `finished_at`/`error`.
- `readFoundationalObservations()`: the 200-row fetch cap is silent truncation that can reintroduce the recency bias this lane exists to avoid. `foundation.foundational_total`/`foundational_considered` now surface it, with a `console.warn` when they diverge. sqlite backend now applies the same 200-row, newest-first cap as postgres (previously unbounded). **Correction:** making both backends apply the same cap surfaced the truncation but did not fix it — both still capped newest-first while `buildFoundationLane` re-ranks the result by pull strength afterward, so a high-pull-strength old memory could still be dropped before the ranker ever saw it. Closed below.
- Foundation lane now ranks before it truncates: both backends' `readFoundationalObservations()` sort all matching rows by `calculatePullStrength` descending *before* slicing to the cap, via a shared `rankFoundationalByPullStrength` helper, so the two backends can't drift onto two different rankings again. `FOUNDATIONAL_LANE_CAP` (200) moves to a single constant instead of two hand-synced literals; Postgres additionally fetches under a named `FOUNDATIONAL_SAFETY_VALVE` (10,000) as an explicit defensive backstop, not the real cap. This also retires the `candidates_last_scan < (foundational.count − 200)` wake alarm — its premise, that the foundational count needed to shrink toward 200, was never correct; the lane's truncation order was the actual defect, not the raw count.
- `capFoundationLane`: a remaining char budget of 1-2 could overshoot the hard cap by pushing a bare `"..."` (3 chars); items are now dropped instead once budget drops below 3.
- `mind_wake`: `foundation` lane's char cap raised 3,000 → 8,000 and anchor cap 10 → 12 — a real tenant's 10 anchors (~550 chars each, ~5,500 total) blew the old 3,000 cap and silently dropped the oldest/most important anchor.
- Rejected proposals were permanent tombstones blocking their own regeneration: `expireStaleProposals(30)` marked timed-out pending proposals `rejected` — a judgment nobody made — against a status-blind unique index (`ON CONFLICT DO NOTHING`), so once a proposal expired, `createProposal` silently returned the same stale rejected row forever. 239 `orphan_rescue`/`link` tombstones existed, 91 of them sitting on the 50-row rescue drain head, so the nightly drain was moving zero orphans. Expiry now `DELETE`s pending proposals of a hardcoded allowlist (`link`, `orphan_rescue`, never config-driven) instead of rejecting them; every other proposal type (`consolidation`, `salience_regrade`, `dedup`, etc.) still tombstones permanently on rejection — by design, an anti-nag guarantee for types a human judges once, not a bug. A one-time backfill cleared the historical damage, identified by `reviewed_at IS NULL` on a rejected row — the one signal no real review (human, AI reviewer, or auto-absorption) ever leaves absent. The rescue queue is also reordered (`last_rescue_attempt ASC NULLS FIRST` instead of `first_marked ASC`) so the same 50 oldest orphans no longer monopolize the drain head under normal operation — see `ops/ADR-JANITOR.md` §1 for the conditions under which head-of-line blocking can still reconstitute. A second, independent starvation compounded it: the AI proposal reviewer fetched the 20 *newest* pending proposals per type, so a backlog deeper than one fetch window was never reached — it aged into the 30-day expiry above and fed a false rejection into the link-confidence learning governor. Review order is now FIFO (oldest first) with the fetch/batch caps raised (`FETCH_PER_TYPE` 20→200, `BATCH_SIZE` 20→90).
- Link proposals were structurally dead, not merely noisy: confidence was `similarity * 0.6 + chargeRatio * 0.4`, re-checked a second time against the *same* threshold a raw similarity cosine had already cleared once. At zero charge overlap — the common case, given a low-cardinality emotion-tag vocabulary — confidence maxed at 0.6, so no pair could ever clear a threshold above that regardless of similarity. A control loop spent five weeks raising that unreachable threshold toward its 0.95 ceiling, chasing a formula that could never satisfy it; and because orphan detection requires an observation to have no links, a dead linker was the upstream source of the orphan backlog. Confidence is now `min(1, similarity + 0.10 * chargeRatio)` behind a single gate — similarity alone decides creation; charge overlap can only raise an already-eligible pair's confidence, never substitute for similarity. **This fix alone creates zero proposals**: the live `link_proposal_threshold` on the `rook` tenant was 0.95 at the time of writing (pinned since 2026-07-30), and similarity tops out at 0.802, the highest cosine ever measured on this corpus. Reactivating link creation requires a one-time `updateProposalThreshold(0.75)` data correction against the tenant's `daemon_config` — not a code change, and not run as part of this commit.
- Orphan detection had no relationship to rescue throughput: an orphan only exits the nightly rescue window by being selected `exhausted`, which costs `MAX_RESCUE_ATTEMPTS + 1` window slots (rescue-by-link is unreachable on this corpus — it compares raw cosine similarity against absorption's 0.90 gate, against a measured corpus-wide maximum of 0.802). The real invariant is `DETECT_LIMIT × (MAX_RESCUE_ATTEMPTS + 1) < RESCUE_LIMIT`; steady mode violated it 8×, and backlog mode — assumed to be draining — was exactly marginal (100 × 2 = 200): a net-zero drain. `DETECT_LIMIT` is now derived per mode from rescue capacity (steady 6, backlog 0 — a drain doesn't look for new work) and the relationship is asserted at module load, so a hand-edit or an unmatched `MAX_RESCUE_ATTEMPTS` change throws at import instead of silently reintroducing the defect. A metric in the same family had the same shape of bug: `getOrphanStats()`'s `oldest_days` (`MIN(first_marked)`) carried no status filter on Postgres, so archival — the drain's dominant exit — could never make it shrink; the metric grading the drain could only grow while the drain worked (sqlite already filtered correctly). Both backends now filter to `status = 'orphaned'`.
- `janitor.regrade`'s own instrumentation was reporting two numbers that lied: `created_last_run` mirrored the scan's throughput-cap preview (computed identically whether shadow suppressed the insert or not), so it showed a nonzero count on every shadow-mode run while zero rows were actually created; and its diagnostic sample's `last_surfaced_at` read a `texture` path that neither backend actually populates, so it displayed `null` on every row. `created_last_run` now reflects real inserts only, with the cap's preview published separately as `would_create_last_run`; `last_surfaced_at` is now mapped from the real database column onto both backends' public `Observation` type.
- `dedup` (formerly inside `kit-hygiene.ts`'s per-agent loop) could never actually fire, for four independent reasons: it was a corpus-level operation scoped to agent-attributed observations only (most of the corpus is territory-filed, not agent-attributed); both sides of a pair had to land in the same night's bounded recency window; `findSimilarUnlinked`'s anti-duplicate exclusions hid exactly the already-linked pairs dedup needed to see; and its `0.92` threshold sat above this corpus's measured cosine ceiling (0.802). Moved to its own corpus-wide daemon task (see Added) with none of the four defects.

### Security
- `readDaemonConfig()` returned the full, unrestricted `daemon_config.data` blob to any caller with a storage handle, including a cross-tenant clone — safe today, not safe by design. Cross-tenant callers now read through a new `readCrossTenantBoundary()` whose return type *is* the boundary (`touchedAfter`/`backlogMode` only), so a future field added to `daemon_config.data` can't leak across tenants by default.

## [1.8.1] — 2026-06-14

### Fixed
- Removed the `mind_project action=list` N+1 hydration pattern by batch-loading project entities instead of fetching one entity per dossier.
- Hoisted `mind_dream` territory reads out of the dream-depth loop and reused the same snapshot for texture drift, keeping territory reads constant instead of depth-scaled.
- Hardened project routing URL validation for `workspace_routing.canonical_repo_url`.
- Added an accessible README `<h1>` while preserving the visual banner.
- Replaced load-bearing observation subtype casts with typed `Observation.type` / `source_observations` fields where applicable.
- Replaced Kit receipt parsing's subtype cast with a runtime `ReceiptKind` guard.

### Tests
- Added lease boundary coverage for malformed lease headers across enforcement modes, delegation-chain cap behavior, and `allow_all` tenant isolation.
- Added receipt coverage for the entity-exists-but-dossier-missing path.
- Added project-list assertions that guard against reintroducing per-dossier entity lookups.
- Added dream-read count coverage to prevent reintroducing depth-scaled territory reads.

### Deferred
- HMAC-signed leases and flipping default enforcement from `shadow` to `required` remain future trust-layer work, not a patch-level compatibility change.

## [1.8.0] — 2026-06-13

### Added
- **Agent House Foundations** public release spec: project truth, receipt-backed wayfinding, scoped leases, and Kit routing hygiene.
- Project dossier `workspace_routing` support for repo URLs, local paths, artifact roots, deploy/test commands, aliases, handoff docs, and related projects.
- `mind_receipt` operational receipts for repo, deploy, and artifact events, plus `scripts/repo-receipt-sync.mjs` for local checkout → Brain receipt intake.
- Agent lease trust layer: `X-Brain-Lease`, delegated scope narrowing, enforcement modes, lease ledger, and audit events.
- Kit project routing hygiene proposals: `project_routing_update`, `project_routing_drift`, `missing_artifact_receipt`, `stale_deploy_command`, and `path_alias_conflict`.
- `cognitive_advantage` benchmark adapter, heuristic rerank lane, report scripts, and organic corpus seeding helper.
- GitHub lifecycle-script guard for install-time package script changes.

### Changed
- Legacy/headless autonomous runner docs now present the runner as optional/manual infrastructure, not the active MUSE Studio default.
- Runtime wording now distinguishes the Brain's scheduler/webhook contract from future app-level autonomous orchestration.
- Cross-brain letters now use clearer tenant resolution and delivery status fields.

### Fixed
- Project routing lookup and receipt paths now avoid semantic guessing when deterministic project truth exists.
- Kit can now catch missing artifact paths and stale/different routing evidence before it becomes cross-session confusion.
- `queryObservations({ entity_id })` is honored in both SQLite and Postgres paths.

### Verification
- `npx tsc --noEmit`
- `npm test -- --run` — 24 files / 281 tests
- Cognitive benchmark smoke with `--dataset cognitive_advantage --rerank-mode heuristic`

## [1.7.0] — 2026-04-29

### Added
- `mind_observe` now accepts an optional `relation` payload so observations can capture relational feeling alongside memory creation.
  - Supported sync modes: `observe_and_relate`, `observe_only`, and `relate_only`.
  - Missing `relation` preserves the old pure-observation behavior.
- Shared relational write path with bounded input validation for feeling, context, entity name, charge entries, and intensity.
- `mind_memory action=timeline` delegates to `mind_timeline`.
- `mind_memory action=territory` delegates to `mind_territory`.
- `mind_memory action=get` now supports processing passthrough (`process`, `processing_note`, `charge`) for parity with `mind_pull`.
- Release notes for the v7.0 daily-use ergonomics milestone.

### Changed
- `mind_memory` is now the preferred read lane: direct ID get, recent/lookup/search, timeline, and territory reads.
- `mind_observe` is now the preferred write lane for observation + relational feeling capture.
- `mind_relate action=feel` remains available for compatibility and explicit relational-state writes.
- `test:reliability` remains as a compatibility alias for `test:contracts`.

### Fixed
- Exposed `mind_memory` through the aggregate dispatcher so schema availability and runtime execution match.
- Hardened Phase 1 audit findings:
  - typed relational write results with a discriminated union
  - consent log preservation on relationship-level changes
  - coverage for `relate_only`, append behavior, validation failures, and update paths
- Hardened Phase 2b audit findings:
  - stronger `mind_memory action=get` assertions
  - string-charge coercion coverage
  - negative invariant for `process !== true`
  - stronger dispatcher tests for search, timeline, and territory
  - safer test factory texture overrides
- Aligned MCP `initialize.serverInfo.version` with package version `1.7.0`.
- Removed remaining private/user-specific release-fixture names from packaged tests.
- Restored consent audit logging parity for `mind_relate action=level` by routing level writes through the shared relationship-level helper.

### Known Issues
- `queryObservations({ entity_id })` is declared in the storage interface but the Postgres storage implementation does not enforce that filter internally yet. Current v1.7.0 read tools still apply their own defensive entity filter; storage-contract tightening is targeted for public v1.7.1.

### Compatibility
- No legacy tools are removed in v7.0.
- `mind_pull`, `mind_query`, `mind_search`, `mind_timeline`, `mind_territory`, and `mind_relate` remain callable.
- `mind_search` is not hard-aliased yet because its output shape differs from `mind_memory action=search`.

## [1.6.2] — 2026-04-26

### Changed
- Default daemon cron reduced from every 15 minutes to daily (`0 3 * * *`). Cuts ~99% of background compute on managed Postgres tiers with CU-hour billing. Interactive brain operations (observe, query, pull, search) are unaffected — they run on-demand. Self-hosters can adjust the frequency in `wrangler.jsonc` to match their compute budget.

## [1.6.1] — 2026-04-23

### Added
- Scoped letter lookup contract in storage: optional `getLetterById(id, recipientContext)` on `IBrainStorage`, with backend implementations for Postgres and SQLite.
- New test script: `npm run test:contracts` (replaces `test:reliability`; the old name is aliased for backward compatibility).

### Changed
- `mind_pull` and `mind_letter action=get` now route letter reads through a shared context-scoped lookup helper to avoid unbounded table/list fallbacks.
- `mind_memory action=get` now passes optional letter context through to `mind_pull` for symmetric scoped reads.
- Observation access updates in `mind_pull` are now non-blocking and `waitUntil`-aware.
- Agent-memory sync bridge hardening:
  - source root allowlist guard on `--source`
  - endpoint URL/scheme validation (`https` required for non-local hosts)
  - API key source narrowed to `MUSE_BRAIN_API_KEY` (legacy fallback chain removed)

### Fixed
- Eliminated hidden full-scan fallback on letter ID reads when storage lacked a dedicated lookup capability.
- Restored letter context isolation on direct-ID lookups by requiring `to_context` scope in backend queries.
- Added regression coverage for:
  - `process:true` non-advance branch (`new_phase` absent) and explicit `processing_count` assertions
  - unprefixed fallback chain behavior (`letter -> task -> entity`)
  - `ent_` project+dossier return shape
  - `mind_letter action=get` optimized `getLetterById` lane

## [1.6.0] — 2026-04-23

### Added
- Retrieval reliability release: universal ID resolver, letter-path correctness, and the benchmark receipt foundation.
- Agent learning bridge: `scripts/agent-memory-sync.mjs` backfills local specialist memory into brain observations via authenticated MCP calls.

### Changed
- Version alignment for the v6 release train: package/tag target is now `v1.6.0`.
- `mind_pull` now acts as a universal ID resolver (`obs_`, `letter_`, `task_`, `ent_`) so direct letter/task/entity retrieval works in a single call.
- `mind_memory action=get` now routes through the same `mind_pull` read path to avoid tool-routing drift.
- `mind_letter` read surface expanded to include explicit `list`, `get`, and `search` actions (with pagination/search semantics), while retaining backward-compatible `read`.

### Fixed
- Letter retrieval reliability gap where `letter_` IDs could fail through observation-only pull paths.
- Added a dedicated contract-retrieval test command: `npm run test:reliability` (checks unified memory + letter resolver paths).
- Typed miss hints are now symmetric for prefixed resolver misses (`letter_`, `task_`, `ent_`).

## [1.5.0] — 2026-04-10

### Changed
- StoryScope persona deepening pass for Rainer and companion prompt packs.
- Writing quality guidance strengthened via StoryScope editorial intelligence framing.

## [1.4.0] — 2026-04-01

### Added
- **Dual-task heartbeat** — `mind_task action=create_dual` creates executor/reviewer task pairs with reviewer dependency wiring out of the box
- **Artifact completion contract** — `mind_task` now accepts `artifact_path` on update/complete and folds it into completion notes + delegated handoff letters
- **Dependency-aware runtime selection** — `mind_runtime action=trigger` skips blocked tasks with unmet `depends_on` instead of surfacing work that cannot run yet
- **Workspace routing in runner contracts** — autonomous prompts now include local/shared/peer/artifact workspace hints when trigger metadata provides them
- **Claude/Codex launcher templates** — shipped shell templates for Rainer and a generic companion slot, plus a one-command Codex installer for the Rainer specialist prompt
- **Autonomous runner** (`runner/`) — subscription-first execution layer with three provider backends:
  - Claude Code CLI (`claude -p`) — tested, working
  - Codex CLI (`codex exec`) — compiled, provider-ready
  - Anthropic API (`node dist/index.js`) — compiled, untested (contributions welcome)
- **Harness runtime** — contract-driven agent execution with 4-stage flow (plan → execute → verify → repair)
  - Agent harness definitions in markdown frontmatter (`runner/harness/rainer.md`)
  - 4 validation gate types: `required_output_keys`, `must_call_tools`, `non_empty_summary`, `max_iterations`
  - 7 named failure codes: `timeout`, `tool_fail`, `contract_fail`, `empty_output`, `budget_exceeded`, `validation_fail`, `stage_error`
  - Per-stage JSON artifacts + JSONL audit ledger
- **Self-improvement loop** (opt-in) — autonomous proposal review with confidence-threshold gating and learning telemetry via `mind_observe`
- **SQLite storage backend** — tenant-scoped parity storage for local/self-host deployments (`STORAGE_BACKEND=sqlite|postgres`)
- **Multi-provider launcher** (`run.sh`) — auto-detects available provider (claude → codex → anthropic_api) with per-provider config
- Rainer harness definition — creative orchestrator agent ready to run out of the box

### Security
- Path traversal protection on all config-sourced file paths (null-byte guard, root-relative resolution)
- Integer bounds on all numeric config values (iterations, tokens, repairs, timeouts, thresholds)
- Shell injection prevention in `run.sh` (env-var passing to Python, no heredoc interpolation)
- SQLite constructor tenant validation against ALLOWED_TENANTS allowlist
- Null-byte guard on SQLite database path
- Non-root Docker user
- Bearer auth on all brain API calls (30s timeout, generic error messages)

### Fixed
- `hybridSearch` entity scoring — removed early entity_id pre-filter that killed mixed results; entity match is now a scoring boost, not a hard filter (SQLite + Postgres parity)
- `withObservations` helper — added explicit `replace(next)` path for safe full-array rewrites
- Duplicate `mind_wake` in validation tool list — verify gate now uses `toolCallsMade` directly
- `ENABLE_SELF_IMPROVEMENT` defaults to `false` (opt-in for open-source users)

### Changed
- `audit*.jsonl` glob in `.gitignore` and `.dockerignore` (covers all audit log variants)
- Brain README updated — removed broken template links, points to `runner/harness/rainer.md`

## [1.3.3] — 2026-03-30

### Added
- Confidence-gated context retrieval on `mind_query` and `mind_search` — `confidence_threshold`, `shadow_mode`, `recency_boost`, `max_context_items`
- Productivity fact extraction on `mind_context` set — regex-based classification (decision/deadline/goal/preference/assignment)
- Runtime context retrieval policy emission — `runner_contract.context_retrieval_policy` injected into autonomous prompts
- Shared confidence utility module (`confidence-utils.ts`) — scoring, filtering, side effects
- 8 new test cases for confidence gating and fact extraction

### Changed
- Parallel fact writes (Promise.all instead of sequential for-await)
- Variable shadowing fix in `mind_letter` read branch
- Input sanitization on fact content before persisting
- Tool descriptions clarified for hybrid-only confidence params

## [1.3.2] — 2026-03-29

### Added
- Skill health daemon — proposes `skill_recapture`, `skill_supersession`, `skill_promotion`
- Proposal deduplication fix for skill proposals
- 8 targeted tests for skill health daemon and registry

## [1.3.1] — 2026-03-29

### Added
- Captured skill registry — `mind_skill` with list/get/review lifecycle
- Skill statuses: `candidate`, `accepted`, `degraded`, `retired`
- Skill layers: `fixed`, `captured`, `derived`
- Runtime-to-skill provenance capture
- `mind_health section=skills` diagnostics

### Fixed
- Audit findings from Sprint 9 review (51 tests passing)

## [1.3.0] — 2026-03-28

### Added
- Autonomous runtime substrate — trigger bridge, policy, session continuity, proof loop
- `mind_runtime` with `set_session`, `get_session`, `log_run`, `list_runs`, `set_policy`, `get_policy`, `trigger`
- `/runtime/trigger` webhook endpoint for scheduler/cron integration
- Runner contract model (`should_run`, selected task, generated prompt, `resume_session_id`)
- Duty/impulse wake gating with daily budgets and cooldowns
- Headless runner script (`scripts/runtime-autonomous-wake.sh`)
- Candidate skill-capture stub from successful trigger runs
- Per-IP rate limiting
- Security hardening (timing-safe auth, payload validation, request size limits)

## [1.2.0] — 2026-03-27

### Added
- `mind_task` with cross-tenant delegation and scheduled wake support
- Task scheduling daemon — advances overdue scheduled tasks to open
- `mind_project` — project dossier create/get/update/list
- `mind_agent` — agent capability manifests with delegation mode and protocols
- Wake delta MVP — task changes, loop changes, project activity since last wake
- Dispatch calibration schema (`dispatch_feedback` expanded)
- Pre-deploy hardening migration (indexes + foreign-key integrity)

## [1.1.0] — 2026-03-26

### Added
- Paradox system — `mind_loop action=paradox` with burning urgency and entity linking
- Charge-phase processing ("sitting in feelings") — fresh/active/processing/metabolized lifecycle
- Paradox detection daemon — scans identity cores for recurring tensions
- 10 daemon loops: proposals, learning, cascade, orphans, kit-hygiene, skill-health, cross-agent, cross-tenant, paradox-detection, task-scheduling
- Adaptive link-threshold learning in daemon
- Cross-tenant daemon proposals (shared territories only: craft, philosophy)

## [1.0.0] — 2026-03-25

### Added
- Renamed to MUSE Brain. Public documentation and companion infrastructure.
- Hybrid retrieval (vector + keyword + neural modulation)
- Full-text search with embedding pipeline
- Tiered wake loading (L0/L1/L2)
- Entity model (people, concepts, agents)
- Territory overviews and iron-grip indexing
- 14 database migrations (001–014)
- Multi-tenant support (run multiple agents on one backend)
- Cross-tenant communication via `mind_letter`
- Bilateral consent framework
- Dream engine (6 association modes)
- Daemon intelligence (proposals, orphan rescue, novelty, decay, cascade)

### Pre-1.0 history
- Brain v4 Phases A–C: territory overviews, tiered wake, L0 summary generation
- Brain v5 Sprints 1–5: embedding pipeline, hybrid search, entity model, daemon intelligence, Hyperdrive migration
