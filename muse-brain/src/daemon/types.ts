// ============ DAEMON TASK TYPES ============
// Used internally by the daemon orchestrator and all task modules.

/**
 * The two boundary shapes this codebase kept confusing under one name
 * (`touchedAfter`) — ops/ADR-JANITOR.md's "instance sixteen." The test that
 * tells them apart: "if nothing were written to this table for 90 days, would
 * this task's correct answer change?" YES → StateWindow (computed from the
 * clock — an age/staleness/recency THRESHOLD). NO → ArrivalBoundary (rows
 * written since the last successful run — an incremental-scan CURSOR).
 * Branded so a future author reaching for a run boundary inside a state
 * check gets a compile error instead of a silent empty result — the type
 * system enforces what a comment alone couldn't (see orphans.ts's C2 fix,
 * the instance this pair of types exists to stop from happening again).
 */
/** "Rows written since the last successful run." Arrival scans ONLY. */
export type ArrivalBoundary = string & { readonly __brand: "ArrivalBoundary" };
/** "The window this predicate is true over." Computed from the CLOCK, never from a run. */
export type StateWindow = string & { readonly __brand: "StateWindow" };

/**
 * Storage-level guard shared by both backends' `findOrphanCandidates` — an
 * arrival boundary layered onto a state-window (age) cutoff is definitionally
 * unsatisfiable for what an orphan query means: `arrival` chronologically
 * AFTER `cutoff` asks for rows that are simultaneously "created before
 * cutoff" (old) and "touched since arrival" (recently touched), for a
 * population (orphans: access_count <= 1) that is specifically the rows
 * nobody has touched. Centralized here, not duplicated per backend, so the
 * two implementations cannot silently drift on what counts as a violation.
 * Throws rather than silently ignoring one argument — a caller that hits
 * this has reintroduced ops/ADR-JANITOR.md §2.1 "instance sixteen" and needs
 * to know immediately, not discover it as another empty result.
 */
export function assertArrivalNotAfterCutoff(cutoff: StateWindow, arrival: ArrivalBoundary | undefined): void {
	if (arrival === undefined) return;
	// Widen both to plain `string` for the comparison — the branding
	// deliberately makes ArrivalBoundary and StateWindow mutually
	// incomparable with `>` (verified: TS2365 without this cast, proving the
	// brand actually blocks cross-kind operations, not just cross-kind
	// assignment). Both are still ISO 8601 instants underneath, so a plain
	// lexicographic string comparison is a correct chronological comparison.
	if ((arrival as string) > (cutoff as string)) {
		throw new Error(
			`findOrphanCandidates: arrival boundary (${arrival}) is after the state-window cutoff (${cutoff}) — ` +
			"an orphan query asks for rows nobody has touched; pairing it with a recent-arrival " +
			"requirement is self-defeating (ops/ADR-JANITOR.md §2.1 'instance sixteen'). Drop the " +
			"arrival argument unless you have a genuinely new reason to combine both."
		);
	}
}

/**
 * A bounded, non-mutating snapshot of what a corpus-level scan found vs. what a
 * throughput cap actually allowed through — ops/ADR-JANITOR.md §5's shadow-mode
 * fix (commit 7b). Written by a task instead of a proposal row, so the gap
 * between "the rule's input" (candidates_total) and "the rule's output"
 * (would_create) is legible at wake even while creation is capped or fully
 * suppressed (shadow). Generic over the sample shape — salience-regrade
 * (RegradeSample) and dedup (DedupSample, §6.1, commit 8) both reuse this same
 * envelope rather than inventing their own.
 */
export interface ScanRecord<TSample> {
	at: string;
	/** Foundational count / corpus slice this scan drew its candidates from. */
	population_total: number;
	/** What the candidate rule found — the gate's INPUT. */
	candidates_total: number;
	/** What the throughput cap allows through — the gate's OUTPUT, a preview computed identically whether shadow suppresses the insert or not. NOT the same as `created` below — conflating the two was ops/ADR-JANITOR.md §2.1 instance nine (commit 7c): `wake.ts` used to mirror this into a field literally named `created_last_run`. */
	would_create: number;
	/**
	 * Actual proposals inserted THIS run. Zero under shadow, always (§5.0's
	 * invariant — shadow creates nothing). Live and not deadline-truncated, this
	 * equals `would_create`; if `DaemonTaskResult.truncated_by_deadline` is true,
	 * this can be less — the create loop stopped before exhausting headroom.
	 * ops/ADR-JANITOR.md §2.1 instance nine (commit 7c).
	 */
	created: number;
	sample: TSample[];
	sample_truncated_to: number;
}

/**
 * ops/ADR-JANITOR.md §5.2 sample shape for a salience_regrade scan. `last_surfaced_at`
 * reads Observation.last_surfaced_at (the real `observations` column, mapped through by
 * both backends' row-mappers as of §2.1 instance nine, commit 7c — it used to read
 * Observation.texture.last_surfaced_at, which is structurally always null: commit 7a's
 * own finding is that updateSurfacingEffects mirrors only novelty_score into texture,
 * never this). It still gates no decision; the storage-layer candidate query
 * (findSalienceRegradeCandidates) is the one place that reads the real column in SQL —
 * this field is display only, now backed by a real value instead of a null one.
 */
export interface RegradeSample {
	id: string;
	summary: string;
	created: string;
	access_count: number;
	last_surfaced_at: string | null;
	pull_strength: number;
	rationale: string;
}

/**
 * ops/ADR-JANITOR.md §6.3 sample shape for a dedup scan — one PAIR, not one
 * observation (RegradeSample's unit): dedup's candidate query is pairwise
 * (findSimilarByEmbedding per source), so the natural sample row names both
 * sides plus the cosine that pairs them. `source_id`/`target_id` are the same
 * ids a created `dedup` proposal would use (§6.4).
 */
export interface DedupSample {
	source_id: string;
	target_id: string;
	source_summary: string;
	target_summary: string;
	similarity: number;
}

/**
 * Sample shape for a paradox-detection scan (daemon/tasks/paradox-detection.ts).
 * One identity core per row — the task's candidate unit, unlike dedup's pairs.
 * `challenge_count` is the count the 30-day window filter actually produced
 * (the same number the created proposal's rationale/metadata reports), so a
 * reader never has to trust a summary number that could silently drift from
 * what the filter itself found (the class of bug ADR-JANITOR.md §2.1 instance
 * nine already burned this codebase on once, for regrade's created/would_create).
 */
export interface ParadoxSample {
	core_id: string;
	core_name: string;
	challenge_count: number;
	rationale: string;
}

/**
 * Sample shape for a novelty-regeneration scan (daemon/cycle.ts's inline "novelty"
 * stage — not a runDaemonTasks() task, so this is built and folded into the
 * heartbeat write directly in cycle.ts, not threaded through DaemonTaskResult.scan
 * like RegradeSample/DedupSample/ParadoxSample). One boosted observation per row.
 */
export interface NoveltySample {
	id: string;
	/**
	 * Days since the boost's REFERENCE point, not necessarily since a real
	 * surfacing — B4 (below) falls back to `created` for a row whose
	 * `last_surfaced_at` is NULL, so this can mean "days since created" for a
	 * never-surfaced row. The field is not renamed to keep this a small diff;
	 * see `NoveltyScanRecord.never_surfaced_total` for which rows in a given
	 * scan used which reference point.
	 */
	days_since_surfaced: number;
	novelty_score_after: number;
}

/**
 * fix(brain): novelty regeneration skips every memory that was never surfaced —
 * B4. `ScanRecord<TSample>` has no field for this because regrade/dedup/paradox
 * have no equivalent concept; extending the shared envelope here rather than
 * adding an optional field there, which would be meaningless for those three.
 *
 * `never_surfaced_total` counts, among this run's population_total (the rows
 * actually evaluated for staleness this cycle — i.e. rows that already carry a
 * `texture.novelty_score`, so the OTHER cycle.ts branch that backfills a
 * missing score to 0.5 does not count here), how many have `last_surfaced_at
 * === null`. It is NOT gated by the 30-day threshold the way candidates_total
 * is — a brand-new never-surfaced row counts here even though it is not yet a
 * candidate — because the point of this number is to make the SHAPE of the
 * population visible at wake, independent of tonight's candidate count. Before
 * this fix, `candidates_total` could read 0 while `never_surfaced_total` read
 * in the hundreds; that gap is the direct evidence B4 exists to close (verified
 * live 2026-09-06: 92.8%/95.6% of two tenants' corpora had never been
 * surfaced).
 */
export interface NoveltyScanRecord extends ScanRecord<NoveltySample> {
	never_surfaced_total: number;
}

/**
 * ops/ADR-VALENCE-FLOOR.md, slice 0 — the nightly valence-floor measurement,
 * stored whole at `daemon_config.data.valence_floor` (not folded into
 * ScanRecord<T>: this task has no candidate/would-create/created shape, it's a
 * seat-count formula over counted quantities). `seats` computes here but is
 * NOT consumed anywhere yet — slice 0 is measurement only, wired into
 * brain_health.janitor.valence_floor for visibility, with zero effect on the
 * foundation lane (buildFoundationLane, tools-v2/wake.ts, is untouched).
 *
 * Every field below is a COUNT over the current corpus, per the ADR's
 * "Honest limits" rule: no health field computed from config. `reason` is
 * populated by the task itself only when its own formula computes a real,
 * measured zero (e.g. no eligible memories exist yet) — the DISTINCT "never
 * run at all" case ("awaiting first measurement") is synthesized by the
 * reader (tools-v2/wake.ts's buildJanitorHealth) when this key is absent from
 * daemon_config.data entirely, mirroring every other scan record's
 * null-before-first-run convention (ops/ADR-JANITOR.md §7).
 */
export interface ValenceFloorResult {
	seats: number;
	reason?: string;
	classified: number;
	eligible: number;
	/** eligible / classified. Null when classified === 0 — nothing to divide. */
	eligible_share: number | null;
	simulated_eligible_in_lane: number;
	eligible_supply_after_cut: number;
	lexicon_rows: number;
	/** Pct of distinct charges appearing on foundational memories that have a lexicon row. Null when no foundational memories carry any charge. */
	lexicon_coverage_pct: number | null;
	unclassified_charge_count: number;
	computed_at: string;
}

export interface DaemonTaskResult {
	task: string;
	changes: number;
	proposals_created: number;
	error?: string;
	/** True when a task's long-running loop broke early on DaemonRunContext.deadlineAt. */
	truncated_by_deadline?: boolean;
	/**
	 * ops/ADR-JANITOR.md §5 commit 7b / §6 commit 8 — see ScanRecord. Set by
	 * salience-regrade (ScanRecord<RegradeSample>), dedup (ScanRecord<DedupSample>),
	 * and paradox-detection (ScanRecord<ParadoxSample>) — cycle.ts narrows by
	 * `task` name before reading any of the three shapes (see
	 * regradeScan/dedupScan/paradoxScan in runTenantCycle()).
	 */
	scan?: ScanRecord<RegradeSample> | ScanRecord<DedupSample> | ScanRecord<ParadoxSample>;
}

/**
 * The successful-run boundary used by the dailies-only daemon sweeps.
 *
 * An absent boundary is intentional: it means this is the first run, or the
 * previous run never reached its finished heartbeat, so callers retain their
 * existing bounded bootstrap lookback.
 */
export interface DaemonRunContext {
	/**
	 * Renamed from `touchedAfter` — the old name read like a row property
	 * ("this was touched after X"), which is half of why it kept getting fed
	 * into state-window checks it doesn't belong in (ops/ADR-JANITOR.md
	 * "instance sixteen"). This is a RUN BOUNDARY: the previous successful
	 * cycle's `started_at`. Correct for incremental ("what arrived since I
	 * last looked") scans only — never for "does X currently satisfy
	 * condition over the last N days" checks, whose answer must be computed
	 * from the clock (StateWindow above), not from when the daemon last ran.
	 */
	arrivalBoundary?: ArrivalBoundary;
	/** The deployment's explicit tenant boundary, retained for cross-tenant scans. */
	allowedTenants?: readonly string[];
	/**
	 * Absolute epoch-ms after which long-running loops should stop starting new work.
	 * Set once in cycle.ts at run start (`Date.now() + JANITOR_BUDGET_MS`). The
	 * Cloudflare subrequest ceiling this daemon used to reason about is gone (box
	 * systemd unit since 2026-08-01); what actually binds now is wall clock —
	 * `TimeoutStartSec=30min`, shared SEQUENTIALLY across every tenant in one
	 * invocation (daemon-runner/main.ts loops tenants one after another). Recorded
	 * here and threaded to every task that already receives a DaemonRunContext.
	 * Instrumentation only in this commit: nothing reads it to break a loop yet
	 * (see ops/ADR-JANITOR.md §2/§9 commit 4) — it is deliberately far enough in
	 * the future that no run in practice reaches it before that lands.
	 */
	deadlineAt?: number;
	/**
	 * Operator-set escape hatch, read from `daemon_config.data.backlog_mode` by
	 * readDaemonRunContext() — the daemon never writes this itself (ops/ADR-JANITOR.md
	 * §9 commit 4, §10 reversibility: "daemon_config.data.backlog_mode = false, free,
	 * no deploy"). When true, orphans.ts switches to backlog-drain caps and
	 * learning.ts freezes threshold adjustment. Absent (not `false`) in the default
	 * case, matching arrivalBoundary's convention above.
	 *
	 * PRECONDITION before an operator flips this to true (ops/ADR-JANITOR.md §8):
	 * the dedup shadow scan must have already run and recorded
	 * `daemon_config.data.last_dedup_scan`. Backlog-mode draining rewrites the link
	 * graph (orphan rescue + absorption accept proposals), and dedup's shadow scan
	 * (commit 8, daemon/tasks/dedup.ts) needs a pre-drain baseline to compare
	 * against. Registered as the FIRST task in runDaemonTasks() (daemon/index.ts)
	 * so every night's cycle captures that baseline before orphans' drain runs —
	 * but that only protects a single cycle's internal ordering. Whether ANY scan
	 * has ever run before an operator flips this flag is still not something code
	 * enforces (a brand-new tenant could have zero recorded scans the moment
	 * someone sets the flag): don't set `backlog_mode: true` until
	 * `last_dedup_scan` exists in `mind_health`/daemon_config.
	 */
	backlogMode?: boolean;
}
