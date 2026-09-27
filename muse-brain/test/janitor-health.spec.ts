// ops/ADR-JANITOR.md §7 — brain_health.janitor, surfaced by both mind_wake
// (tools-v2/wake.ts's buildJanitorHealth) and mind_health section=janitor
// (tools-v2/health.ts, which imports the SAME function rather than
// re-implementing the block — see the Blind-Spot Guard against mirror drift).
import { describe, expect, it, vi } from "vitest";
import { createStorage } from "../src/storage/factory";
import { handleTool as handleWakeTool, buildJanitorHealth, computeOrphanFlow } from "../src/tools-v2/wake";
import { handleTool as handleHealthTool } from "../src/tools-v2/health";

function freshStorage() {
	const dbPath = `/tmp/muse-brain-test-janitor-health-${crypto.randomUUID()}.sqlite`;
	return createStorage({ backend: "sqlite", sqlitePath: dbPath }, "companion");
}

/** Minimal storage surface buildJanitorHealth() itself touches — not a full mind_wake mock. */
function minimalJanitorStorage(overrides: Record<string, unknown> = {}) {
	return {
		getEmbeddingCoverage: vi.fn(async () => ({ total: 0, embedded: 0 })),
		readDaemonConfig: vi.fn(async () => ({ tenant_id: "companion", link_proposal_threshold: 0.75, data: {} })),
		getOrphanStats: vi.fn(async () => ({ orphaned: 0, rescued: 0, archived: 0, oldest_days: 0 })),
		getProposalStats: vi.fn(async () => ({})),
		countFoundationalObservations: vi.fn(async () => 0),
		countIronObservations: vi.fn(async () => 0),
		getChargePhaseCounts: vi.fn(async () => ({ fresh: 0, active: 0, processing: 0, metabolized: 0 })),
		getOldestPendingProposalDays: vi.fn(async () => null),
		...overrides
	};
}

// Same shape as wake-foundation.spec.ts's baseMockStorage — the minimum surface a
// full `mind_wake` (depth: quick) call needs, so a wiring/warning-text test doesn't
// require seeding a real sqlite backend.
function baseWakeMockStorage(overrides: Record<string, unknown> = {}) {
	return {
		getTenant: vi.fn(() => "companion"),
		readOverviews: vi.fn(async () => []),
		readIronGripIndex: vi.fn(async () => []),
		readLetters: vi.fn(async () => []),
		readOpenLoops: vi.fn(async () => []),
		readBrainState: vi.fn(async () => ({
			current_mood: "focused", energy_level: 0.5, last_updated: new Date().toISOString(),
			momentum: { current_charges: [], intensity: 0, last_updated: new Date().toISOString() },
			afterglow: { residue_charges: [] }
		})),
		readSubconscious: vi.fn(async () => null),
		listTasks: vi.fn(async () => []),
		readAllTerritories: vi.fn(async () => []),
		readLatestWakeLog: vi.fn(async () => null),
		listTaskChangesSince: vi.fn(async () => []),
		listProjectDossiers: vi.fn(async () => []),
		getLimbicConfig: vi.fn(async () => null),
		readAnchors: vi.fn(async () => []),
		touchAnchors: vi.fn(async () => undefined),
		readFoundationalObservations: vi.fn(async () => []),
		appendWakeLog: vi.fn(async () => undefined),
		...minimalJanitorStorage(),
		...overrides
	};
}

describe("buildJanitorHealth — defensive fallback", () => {
	it("a storage object lacking EVERY new optional method still returns a fully-zeroed block without throwing", async () => {
		// Deliberately mirrors a pre-ADR-JANITOR backend/mock: only the two calls
		// buildBrainHealth already made before this commit are present.
		const storage = {
			getEmbeddingCoverage: vi.fn(async () => ({ total: 5, embedded: 5 })),
			readDaemonConfig: vi.fn(async () => ({ tenant_id: "companion", link_proposal_threshold: 0.75, data: {} }))
			// no getOrphanStats, no getProposalStats, no count*/get* additions
		};

		const janitor = await buildJanitorHealth(storage as any);

		expect(janitor).toEqual({
			foundational: { count: 0, cap: 200, truncating: false },
			iron: { count: 0, pct_of_corpus: 0 },
			charge_phase: { fresh: 0, active: 0, processing: 0, metabolized: 0 },
			orphans: { orphaned: 0, oldest_days: 0, drained_last_night: 0, detected_last_night: 0 },
			// ops/ADR-JANITOR.md §2.1: DETECT_LIMIT_STEADY (6) is derived so
			// 6 * SLOTS_PER_ORPHAN_STEADY (4) = 24 < RESCUE_LIMIT_STEADY (50) — the
			// invariant that used to fail every steady-mode night now holds by
			// construction (asserted at orphans.ts module load), so this block reports
			// healthy with no warning, defensive-fallback storage or not.
			orphan_flow: { detect_limit: 6, rescue_limit: 50, mode: "steady", net_per_night: -6, healthy: true },
			proposals: { pending: 0, oldest_pending_days: null, expired_last_night: 0 },
			regrade: { awaiting_rook: 0, accepted_total: 0, rejected_total: 0, shadow: true, candidates_last_scan: null, created_last_run: 0, would_create_last_run: 0, scan_at: null },
			dedup: { threshold: null, candidates_last_scan: null, created_last_run: 0, would_create_last_run: 0, scan_at: null, scanned_last_run: null },
			paradox: { population_last_scan: null, candidates_last_scan: null, created_last_run: 0, would_create_last_run: 0, scan_at: null },
			novelty: { population_last_scan: null, candidates_last_scan: null, never_surfaced_last_scan: null, created_last_run: 0, would_create_last_run: 0, scan_at: null },
			backlog_mode: false,
			last_run: { truncated_by_deadline: false },
			valence_floor: {
				seats: 0,
				reason: "awaiting first measurement",
				classified: null,
				eligible: null,
				eligible_share: null,
				simulated_eligible_in_lane: null,
				eligible_supply_after_cut: null,
				lexicon_rows: null,
				lexicon_coverage_pct: null,
				unclassified_charge_count: null,
				computed_at: null
			},
			valence_nudge: {
				fired_total: null,
				answered_total: null,
				answer_rate: null,
				current_cooldown_minutes: null,
				last_fired_at: null,
				reason: "not yet implemented"
			}
		});
	});
});

describe("buildJanitorHealth — numbers", () => {
	it("computes iron pct_of_corpus from getEmbeddingCoverage's total", async () => {
		const storage = minimalJanitorStorage({
			getEmbeddingCoverage: vi.fn(async () => ({ total: 200, embedded: 200 })),
			countIronObservations: vi.fn(async () => 50)
		});

		const janitor = await buildJanitorHealth(storage as any);

		expect(janitor.iron).toEqual({ count: 50, pct_of_corpus: 25 });
	});

	it("marks foundational truncating only once count exceeds the 200 cap", async () => {
		const under = await buildJanitorHealth(minimalJanitorStorage({ countFoundationalObservations: vi.fn(async () => 200) }) as any);
		expect(under.foundational).toEqual({ count: 200, cap: 200, truncating: false });

		const over = await buildJanitorHealth(minimalJanitorStorage({ countFoundationalObservations: vi.fn(async () => 201) }) as any);
		expect(over.foundational).toEqual({ count: 201, cap: 200, truncating: true });
	});

	it("sums pending across every proposal type from getProposalStats", async () => {
		const storage = minimalJanitorStorage({
			getProposalStats: vi.fn(async () => ({
				link: { total: 10, accepted: 3, rejected: 2, ratio: 0.6 },      // 5 pending
				orphan_rescue: { total: 8, accepted: 1, rejected: 1, ratio: 0.5 } // 6 pending
			}))
		});

		const janitor = await buildJanitorHealth(storage as any);

		expect(janitor.proposals.pending).toBe(11);
	});

	it("regrade defaults to zero today — salience_regrade doesn't exist as a type until ADR-JANITOR §9 commit 7", async () => {
		const storage = minimalJanitorStorage({
			getProposalStats: vi.fn(async () => ({
				link: { total: 5, accepted: 2, rejected: 1, ratio: 0.66 }
			}))
		});

		const janitor = await buildJanitorHealth(storage as any);

		expect(janitor.regrade).toEqual({ awaiting_rook: 0, accepted_total: 0, rejected_total: 0, shadow: true, candidates_last_scan: null, created_last_run: 0, would_create_last_run: 0, scan_at: null });
	});

	it("reads regrade from a salience_regrade stats row once one exists", async () => {
		const storage = minimalJanitorStorage({
			getProposalStats: vi.fn(async () => ({
				salience_regrade: { total: 12, accepted: 4, rejected: 3, ratio: 0.57 }
			}))
		});

		const janitor = await buildJanitorHealth(storage as any);

		expect(janitor.regrade).toEqual({ awaiting_rook: 5, accepted_total: 4, rejected_total: 3, shadow: true, candidates_last_scan: null, created_last_run: 0, would_create_last_run: 0, scan_at: null });
	});

	it("reads candidates_last_scan/created_last_run/would_create_last_run/scan_at from daemon_config.data.last_regrade_scan (ops/ADR-JANITOR.md §5 commit 7b's breadcrumb)", async () => {
		const withoutScan = await buildJanitorHealth(minimalJanitorStorage() as any);
		expect(withoutScan.regrade.candidates_last_scan).toBeNull();
		expect(withoutScan.regrade.created_last_run).toBe(0);
		expect(withoutScan.regrade.would_create_last_run).toBe(0);
		expect(withoutScan.regrade.scan_at).toBeNull();

		// A live run, fully caught up: created equals would_create.
		const withScan = await buildJanitorHealth(minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: {
					last_regrade_scan: {
						at: "2026-09-06T03:00:00.000Z",
						population_total: 515,
						candidates_total: 28,
						would_create: 10,
						created: 10,
						sample: [],
						sample_truncated_to: 25
					}
				}
			}))
		}) as any);
		expect(withScan.regrade.candidates_last_scan).toBe(28);
		expect(withScan.regrade.created_last_run).toBe(10);
		expect(withScan.regrade.would_create_last_run).toBe(10);
		expect(withScan.regrade.scan_at).toBe("2026-09-06T03:00:00.000Z");
	});

	it("ops/ADR-JANITOR.md §2.1 instance nine — a shadow run reads created_last_run 0 while would_create_last_run reports the cap's preview, never the old bug of mirroring one into the other", async () => {
		const shadowScan = await buildJanitorHealth(minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: {
					last_regrade_scan: {
						at: "2026-09-06T03:00:00.000Z",
						population_total: 515,
						candidates_total: 28,
						would_create: 10,
						created: 0, // shadow: zero rows actually inserted
						sample: [],
						sample_truncated_to: 25
					}
				}
			}))
		}) as any);

		expect(shadowScan.regrade.created_last_run).toBe(0);
		expect(shadowScan.regrade.would_create_last_run).toBeGreaterThan(0);
		expect(shadowScan.regrade.would_create_last_run).toBe(10);
	});

	it("a pre-fix persisted scan record (no `created` field) reads created_last_run as 0, not the old buggy mirror of would_create", async () => {
		const legacyScan = await buildJanitorHealth(minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: {
					last_regrade_scan: {
						at: "2026-09-06T03:00:00.000Z",
						population_total: 515,
						candidates_total: 28,
						would_create: 10,
						// no `created` — simulates a ScanRecord written before commit 7c
						sample: [],
						sample_truncated_to: 25
					}
				}
			}))
		}) as any);

		expect(legacyScan.regrade.created_last_run).toBe(0);
		expect(legacyScan.regrade.would_create_last_run).toBe(10);
	});

	it("reads regrade.shadow from daemon_config.data.salience_regrade_shadow — absent reads true, explicit false reads false", async () => {
		const defaultOn = await buildJanitorHealth(minimalJanitorStorage() as any);
		expect(defaultOn.regrade.shadow).toBe(true);

		const explicitlyOff = await buildJanitorHealth(minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: { salience_regrade_shadow: false }
			}))
		}) as any);
		expect(explicitlyOff.regrade.shadow).toBe(false);
	});

	it("ops/ADR-JANITOR.md §6.3/this fix — dedup defaults to null/zero before any scan has run and no threshold is configured", async () => {
		const janitor = await buildJanitorHealth(minimalJanitorStorage() as any);

		expect(janitor.dedup).toEqual({
			threshold: null,
			candidates_last_scan: null,
			created_last_run: 0,
			would_create_last_run: 0,
			scan_at: null,
			scanned_last_run: null
		});
	});

	it("reads dedup.threshold from daemon_config.data.dedup_similarity_threshold — absent reads null (shadow), configured reads the number", async () => {
		const shadow = await buildJanitorHealth(minimalJanitorStorage() as any);
		expect(shadow.dedup.threshold).toBeNull();

		const live = await buildJanitorHealth(minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: { dedup_similarity_threshold: 0.78 }
			}))
		}) as any);
		expect(live.dedup.threshold).toBe(0.78);
	});

	it("reads dedup's candidates_last_scan/created_last_run/would_create_last_run/scan_at/scanned_last_run from daemon_config.data.last_dedup_scan (ops/ADR-JANITOR.md §6.3 commit 8's breadcrumb)", async () => {
		const withoutScan = await buildJanitorHealth(minimalJanitorStorage() as any);
		expect(withoutScan.dedup.candidates_last_scan).toBeNull();
		expect(withoutScan.dedup.created_last_run).toBe(0);
		expect(withoutScan.dedup.would_create_last_run).toBe(0);
		expect(withoutScan.dedup.scan_at).toBeNull();
		expect(withoutScan.dedup.scanned_last_run).toBeNull();

		// Shadow: the scan ran (population/candidates populated), no threshold
		// configured yet, so `created` is 0 even though pairs were found.
		const withScan = await buildJanitorHealth(minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: {
					last_dedup_scan: {
						at: "2026-09-06T03:00:00.000Z",
						population_total: 50,
						candidates_total: 12,
						would_create: 0,
						created: 0,
						sample: [],
						sample_truncated_to: 12
					}
				}
			}))
		}) as any);
		expect(withScan.dedup.candidates_last_scan).toBe(12);
		expect(withScan.dedup.created_last_run).toBe(0);
		expect(withScan.dedup.would_create_last_run).toBe(0);
		expect(withScan.dedup.scan_at).toBe("2026-09-06T03:00:00.000Z");
		// The coverage caveat this fix exists to surface: population_total is
		// bounded at SCAN_SOURCE_LIMIT (50), not the corpus size.
		expect(withScan.dedup.scanned_last_run).toBe(50);
	});

	it("paradox defaults to null/zero before any scan has ever run — population_total 0 is a real health signal Eli's audit distinguished from an unrun scan (ops/ADR-JANITOR.md instance-nine generalisation)", async () => {
		const janitor = await buildJanitorHealth(minimalJanitorStorage() as any);

		expect(janitor.paradox).toEqual({
			population_last_scan: null,
			candidates_last_scan: null,
			created_last_run: 0,
			would_create_last_run: 0,
			scan_at: null
		});
	});

	it("reads paradox's population_last_scan/candidates_last_scan/created_last_run/would_create_last_run/scan_at from daemon_config.data.last_paradox_scan, even when candidates_total is 0 (a scanned-but-quiet tenant, not an unrun scan)", async () => {
		const withoutScan = await buildJanitorHealth(minimalJanitorStorage() as any);
		expect(withoutScan.paradox.population_last_scan).toBeNull();
		expect(withoutScan.paradox.candidates_last_scan).toBeNull();

		// 41 identity cores scanned, zero candidates — a real, healthy zero, not
		// the same shape as "no scan has ever run" above.
		const quietScan = await buildJanitorHealth(minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: {
					last_paradox_scan: {
						at: "2026-09-06T03:00:00.000Z",
						population_total: 41,
						candidates_total: 0,
						would_create: 0,
						created: 0,
						sample: [],
						sample_truncated_to: 0
					}
				}
			}))
		}) as any);
		expect(quietScan.paradox.population_last_scan).toBe(41);
		expect(quietScan.paradox.candidates_last_scan).toBe(0);
		expect(quietScan.paradox.created_last_run).toBe(0);
		expect(quietScan.paradox.would_create_last_run).toBe(0);
		expect(quietScan.paradox.scan_at).toBe("2026-09-06T03:00:00.000Z");

		// A run that actually created a proposal: would_create and created agree
		// (no throughput cap for this task, unlike regrade/dedup).
		const liveScan = await buildJanitorHealth(minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: {
					last_paradox_scan: {
						at: "2026-09-06T03:05:00.000Z",
						population_total: 41,
						candidates_total: 2,
						would_create: 1,
						created: 1,
						sample: [],
						sample_truncated_to: 1
					}
				}
			}))
		}) as any);
		expect(liveScan.paradox.candidates_last_scan).toBe(2);
		expect(liveScan.paradox.created_last_run).toBe(1);
		expect(liveScan.paradox.would_create_last_run).toBe(1);
	});

	// fix(brain): novelty regeneration skips every memory that was never surfaced
	// — B4. Same null-before-first-scan discipline as regrade/dedup/paradox above.
	it("novelty defaults to null/zero before any scan has ever run", async () => {
		const janitor = await buildJanitorHealth(minimalJanitorStorage() as any);

		expect(janitor.novelty).toEqual({
			population_last_scan: null,
			candidates_last_scan: null,
			never_surfaced_last_scan: null,
			created_last_run: 0,
			would_create_last_run: 0,
			scan_at: null
		});
	});

	it("reads novelty's population_last_scan/candidates_last_scan/never_surfaced_last_scan/created_last_run/would_create_last_run/scan_at from daemon_config.data.last_novelty_scan — deliberately DISTINCT nonzero values for candidates vs never_surfaced (B4's whole point: never_surfaced_total is NOT gated by the 30-day threshold candidates_total is, so a fixture where they coincide could not catch a wiring swap)", async () => {
		const withoutScan = await buildJanitorHealth(minimalJanitorStorage() as any);
		expect(withoutScan.novelty.population_last_scan).toBeNull();
		expect(withoutScan.novelty.candidates_last_scan).toBeNull();
		expect(withoutScan.novelty.never_surfaced_last_scan).toBeNull();

		const withScan = await buildJanitorHealth(minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: {
					last_novelty_scan: {
						at: "2026-09-06T03:00:00.000Z",
						population_total: 100,
						candidates_total: 40,
						never_surfaced_total: 92, // > candidates_total on purpose — most never-surfaced rows are too young to be 30-day candidates yet
						would_create: 40,
						created: 40,
						sample: [],
						sample_truncated_to: 20
					}
				}
			}))
		}) as any);
		expect(withScan.novelty.population_last_scan).toBe(100);
		expect(withScan.novelty.candidates_last_scan).toBe(40);
		expect(withScan.novelty.never_surfaced_last_scan).toBe(92);
		expect(withScan.novelty.created_last_run).toBe(40);
		expect(withScan.novelty.would_create_last_run).toBe(40);
		expect(withScan.novelty.scan_at).toBe("2026-09-06T03:00:00.000Z");
	});

	it("reads drained_last_night from daemon_config.data.last_orphan_drain (cycle.ts's breadcrumb)", async () => {
		const storage = minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: { last_orphan_drain: { count: 42, at: "2026-09-06T03:00:00.000Z" } }
			}))
		});

		const janitor = await buildJanitorHealth(storage as any);

		expect(janitor.orphans.drained_last_night).toBe(42);
	});

	it("reads detected_last_night from daemon_config.data.last_orphan_detect (cycle.ts's breadcrumb, published beside last_orphan_drain — ops/ADR-JANITOR.md §2.1 'instance sixteen')", async () => {
		const storage = minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: {
					last_orphan_drain: { count: 3, at: "2026-09-06T03:00:00.000Z" },
					last_orphan_detect: { count: 5, at: "2026-09-06T03:00:00.000Z" }
				}
			}))
		});

		const janitor = await buildJanitorHealth(storage as any);

		// Distinct nonzero values on purpose (blind-spot-guard: a test that only
		// ever sees drained === detected can't tell them apart if the wiring
		// swaps).
		expect(janitor.orphans.detected_last_night).toBe(5);
		expect(janitor.orphans.drained_last_night).toBe(3);
	});

	it("reads expired_last_night from daemon_config.data.last_expiry (commit 2's breadcrumb) — zero before that commit lands", async () => {
		const withoutExpiry = await buildJanitorHealth(minimalJanitorStorage() as any);
		expect(withoutExpiry.proposals.expired_last_night).toBe(0);

		const withExpiry = await buildJanitorHealth(minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: { last_expiry: { deleted: 7, by_type: { link: 5, orphan_rescue: 2 }, at: "2026-09-06T03:00:00.000Z" } }
			}))
		}) as any);
		expect(withExpiry.proposals.expired_last_night).toBe(7);
	});

	it("reads backlog_mode and last_run.truncated_by_deadline from daemon_config.data — both false before any commit sets them", async () => {
		const janitor = await buildJanitorHealth(minimalJanitorStorage() as any);
		expect(janitor.backlog_mode).toBe(false);
		expect(janitor.last_run.truncated_by_deadline).toBe(false);

		const flagged = await buildJanitorHealth(minimalJanitorStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: { backlog_mode: true, last_daemon_run: { started_at: "x", completed_stages: [], finished_at: "y", truncated_by_deadline: true } }
			}))
		}) as any);
		expect(flagged.backlog_mode).toBe(true);
		expect(flagged.last_run.truncated_by_deadline).toBe(true);
	});

	// ops/ADR-JANITOR.md §2.1 — the (A+1)-slot invariant. Real, derived orphans.ts
	// constants can never produce an unhealthy orphan_flow (assertOrphanFlowInvariant
	// throws at module load first), so the unhealthy branch is tested directly
	// against computeOrphanFlow with arbitrary inputs, per §2.1's explicit
	// instruction not to delete this coverage — only redirect it.
	describe("orphan_flow", () => {
		it("computeOrphanFlow reports unhealthy when detect × slots >= rescue — unreachable from the real orphans.ts constants, exercised here with arbitrary inputs", () => {
			expect(computeOrphanFlow(100, 50, 1, "steady")).toEqual({
				detect_limit: 100,
				rescue_limit: 50,
				mode: "steady",
				net_per_night: 50,
				healthy: false
			});
		});

		it("computeOrphanFlow's healthy boundary is strict: net_per_night === 0 is NOT healthy, only net_per_night < 0 is", () => {
			expect(computeOrphanFlow(12, 48, 4, "steady").healthy).toBe(false); // 12 - floor(48/4) = 0
			expect(computeOrphanFlow(11, 48, 4, "steady").healthy).toBe(true);  // 11 - floor(48/4) = -1
		});

		it("buildJanitorHealth is healthy by default (backlog_mode absent): DETECT_LIMIT_STEADY (6) × SLOTS_PER_ORPHAN_STEADY (4) = 24 < RESCUE_LIMIT_STEADY (50), no warning", async () => {
			const janitor = await buildJanitorHealth(minimalJanitorStorage() as any);

			expect(janitor.orphan_flow).toEqual({
				detect_limit: 6,
				rescue_limit: 50,
				mode: "steady",
				net_per_night: -6,
				healthy: true
			});
			expect(janitor.warning).toBeUndefined();
		});

		it("stays healthy once backlog_mode is true: DETECT_LIMIT_BACKLOG (0) never competes with RESCUE_LIMIT_BACKLOG (200)", async () => {
			const janitor = await buildJanitorHealth(minimalJanitorStorage({
				readDaemonConfig: vi.fn(async () => ({
					tenant_id: "companion", link_proposal_threshold: 0.75, data: { backlog_mode: true }
				}))
			}) as any);

			expect(janitor.orphan_flow).toEqual({
				detect_limit: 0,
				rescue_limit: 200,
				mode: "backlog",
				net_per_night: -100,
				healthy: true
			});
			expect(janitor.warning).toBeUndefined();
		});
	});
});

describe("mind_wake — brain_health.janitor wiring", () => {
	it("carries a fully-zeroed, healthy janitor block (ops/ADR-JANITOR.md §2.1 — the derived constants make orphan_flow healthy by construction) on an empty tenant, with no warning at all", async () => {
		const storage = freshStorage();
		await storage.updateDaemonConfigData({
			last_daemon_run: { started_at: "2026-09-05T03:00:00.000Z", completed_stages: ["ai-review"], finished_at: "2026-09-05T03:01:00.000Z" }
		});

		const result = await handleWakeTool("mind_wake", { depth: "quick" }, { storage: storage as any });

		expect(result.brain_health.janitor).toEqual({
			foundational: { count: 0, cap: 200, truncating: false },
			iron: { count: 0, pct_of_corpus: 0 },
			charge_phase: { fresh: 0, active: 0, processing: 0, metabolized: 0 },
			orphans: { orphaned: 0, oldest_days: 0, drained_last_night: 0, detected_last_night: 0 },
			orphan_flow: { detect_limit: 6, rescue_limit: 50, mode: "steady", net_per_night: -6, healthy: true },
			proposals: { pending: 0, oldest_pending_days: null, expired_last_night: 0 },
			regrade: { awaiting_rook: 0, accepted_total: 0, rejected_total: 0, shadow: true, candidates_last_scan: null, created_last_run: 0, would_create_last_run: 0, scan_at: null },
			dedup: { threshold: null, candidates_last_scan: null, created_last_run: 0, would_create_last_run: 0, scan_at: null, scanned_last_run: null },
			paradox: { population_last_scan: null, candidates_last_scan: null, created_last_run: 0, would_create_last_run: 0, scan_at: null },
			novelty: { population_last_scan: null, candidates_last_scan: null, never_surfaced_last_scan: null, created_last_run: 0, would_create_last_run: 0, scan_at: null },
			backlog_mode: false,
			last_run: { truncated_by_deadline: false },
			valence_floor: {
				seats: 0,
				reason: "awaiting first measurement",
				classified: null,
				eligible: null,
				eligible_share: null,
				simulated_eligible_in_lane: null,
				eligible_supply_after_cut: null,
				lexicon_rows: null,
				lexicon_coverage_pct: null,
				unclassified_charge_count: null,
				computed_at: null
			},
			valence_nudge: {
				fired_total: null,
				answered_total: null,
				answer_rate: null,
				current_cooldown_minutes: null,
				last_fired_at: null,
				reason: "not yet implemented"
			}
		});
		expect(result.brain_health.warning).toBeUndefined();
	});

	it("stays healthy once the tenant sets backlog_mode: true, with the mode-scoped derived constants", async () => {
		const storage = freshStorage();
		await storage.updateDaemonConfigData({
			backlog_mode: true,
			last_daemon_run: { started_at: "2026-09-05T03:00:00.000Z", completed_stages: ["ai-review"], finished_at: "2026-09-05T03:01:00.000Z" }
		});

		const result = await handleWakeTool("mind_wake", { depth: "quick" }, { storage: storage as any });

		expect(result.brain_health.janitor.orphan_flow).toEqual({
			detect_limit: 0, rescue_limit: 200, mode: "backlog", net_per_night: -100, healthy: true
		});
		expect(result.brain_health.janitor.warning).toBeUndefined();
		expect(result.brain_health.warning).toBeUndefined();
	});

	it("warns when the Foundation lane is truncating", async () => {
		const storage = baseWakeMockStorage({ countFoundationalObservations: vi.fn(async () => 315) });

		const result = await handleWakeTool("mind_wake", { depth: "quick" }, { storage: storage as any });

		expect(result.brain_health.warning).toMatch(/Foundation lane is showing you 200 of 315 foundational memories/);
	});

	it("warns when orphaned exceeds the 200-row rescue clamp", async () => {
		const storage = baseWakeMockStorage({
			getOrphanStats: vi.fn(async () => ({ orphaned: 250, rescued: 10, archived: 5, oldest_days: 40 }))
		});

		const result = await handleWakeTool("mind_wake", { depth: "quick" }, { storage: storage as any });

		expect(result.brain_health.warning).toMatch(/250 observations are orphaned/);
	});

	it("warns when the oldest pending proposal exceeds 21 days", async () => {
		const storage = baseWakeMockStorage({ getOldestPendingProposalDays: vi.fn(async () => 25) });

		const result = await handleWakeTool("mind_wake", { depth: "quick" }, { storage: storage as any });

		expect(result.brain_health.warning).toMatch(/oldest pending proposal has waited 25 days/);
	});

	it("warns when a salience_regrade proposal is awaiting Rook while shadow is on — should be structurally impossible after ops/ADR-JANITOR.md §5 commit 7b", async () => {
		const storage = baseWakeMockStorage({
			getProposalStats: vi.fn(async () => ({
				salience_regrade: { total: 3, accepted: 0, rejected: 0, ratio: 0 }
			}))
			// shadow defaults to true (daemon_config.data has no salience_regrade_shadow key)
		});

		const result = await handleWakeTool("mind_wake", { depth: "quick" }, { storage: storage as any });

		expect(result.brain_health.warning).toMatch(/3 salience_regrade proposals exist while shadow is on.*This should be impossible/);
	});

	it("does NOT warn about shadow+awaiting_rook once shadow is off, even with proposals pending review", async () => {
		const storage = baseWakeMockStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: { salience_regrade_shadow: false }
			})),
			getProposalStats: vi.fn(async () => ({
				salience_regrade: { total: 3, accepted: 0, rejected: 0, ratio: 0 }
			}))
		});

		const result = await handleWakeTool("mind_wake", { depth: "quick" }, { storage: storage as any });

		expect(result.brain_health.warning ?? "").not.toMatch(/shadow is on/);
	});

	// ops/ADR-JANITOR.md §5.1 (this commit) — the "cannot reach its own target"
	// alarm was REMOVED, not fixed-to-not-fire: it compared the salience_regrade
	// candidate pool against a "close the gap to foundational.count − 200" target,
	// a category error (§5's "Current state" box) now that readFoundationalObservations()
	// ranks by pull strength before truncating — the Foundation lane no longer needs
	// foundational.count to shrink to ≤200 to behave correctly. These three cases
	// (a real too-small scan, never scanned, and a scan "at the old target") all used
	// to be distinguished by that logic; now none of them can ever produce this
	// warning, on the exact fixture data that used to trigger it. Split into three
	// named cases (Reeve, post-hoc review of 0e26c36) — one `it()` covering all
	// three loses failure isolation: a regression in any single case reports as
	// the same generic test name as the other two.
	it("never warns about a regrade-candidate-pool target on a real too-small scan", async () => {
		const smallScan = baseWakeMockStorage({
			countFoundationalObservations: vi.fn(async () => 515),
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: {
					last_regrade_scan: {
						at: "2026-09-06T03:00:00.000Z", population_total: 515,
						candidates_total: 28, would_create: 10, sample: [], sample_truncated_to: 25
					}
				}
			}))
		});
		const smallScanResult = await handleWakeTool("mind_wake", { depth: "quick" }, { storage: smallScan as any });
		expect(smallScanResult.brain_health.warning ?? "").not.toMatch(/cannot reach its own target/);
	});

	it("never warns about a regrade-candidate-pool target when the task has never scanned", async () => {
		const neverScanned = baseWakeMockStorage({ countFoundationalObservations: vi.fn(async () => 515) });
		const neverScannedResult = await handleWakeTool("mind_wake", { depth: "quick" }, { storage: neverScanned as any });
		expect(neverScannedResult.brain_health.warning ?? "").not.toMatch(/cannot reach its own target/);
	});

	it("never warns about a regrade-candidate-pool target on a scan sitting at the old (removed) target", async () => {
		const atOldTarget = baseWakeMockStorage({
			countFoundationalObservations: vi.fn(async () => 515),
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: {
					last_regrade_scan: {
						at: "2026-09-06T03:00:00.000Z", population_total: 515,
						candidates_total: 315, would_create: 10, sample: [], sample_truncated_to: 25
					}
				}
			}))
		});
		const atOldTargetResult = await handleWakeTool("mind_wake", { depth: "quick" }, { storage: atOldTarget as any });
		expect(atOldTargetResult.brain_health.warning ?? "").not.toMatch(/cannot reach its own target/);
	});

	it("warns when last night's run was truncated by its deadline", async () => {
		const storage = baseWakeMockStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "companion", link_proposal_threshold: 0.75,
				data: {
					last_daemon_run: {
						started_at: "2026-09-05T03:00:00.000Z",
						completed_stages: ["ai-review"],
						finished_at: "2026-09-05T03:30:00.000Z",
						truncated_by_deadline: true
					}
				}
			}))
		});

		const result = await handleWakeTool("mind_wake", { depth: "quick" }, { storage: storage as any });

		expect(result.brain_health.warning).toMatch(/hit its time budget and stopped early/);
	});
});

describe("mind_health section=janitor — mirrors mind_wake's brain_health.janitor exactly", () => {
	it("same numbers through both entry points, same underlying storage", async () => {
		const storage = freshStorage();
		await storage.appendToTerritory("craft", {
			id: "obs_iron",
			content: "an iron-grip observation",
			territory: "craft",
			created: new Date().toISOString(),
			texture: { salience: "active", vividness: "vivid", charge: [], grip: "iron", charge_phase: "active" },
			access_count: 3
		});

		const wakeResult = await handleWakeTool("mind_wake", { depth: "quick" }, { storage: storage as any });
		const healthResult = await handleHealthTool("mind_health", { section: "janitor" }, { storage: storage as any });

		expect(healthResult.janitor).toEqual(wakeResult.brain_health.janitor);
		expect(wakeResult.brain_health.janitor.iron.count).toBe(1);
	});

	it("section=all also includes janitor alongside the other sections", async () => {
		const storage = freshStorage();

		const result = await handleHealthTool("mind_health", { section: "all" }, { storage: storage as any });

		expect(result.janitor).toBeDefined();
		expect(result.embeddings).toBeDefined();
	});

	it("section other than all/janitor does not touch buildJanitorHealth at all", async () => {
		const getOrphanStats = vi.fn(async () => ({ orphaned: 0, rescued: 0, archived: 0, oldest_days: 0 }));
		const storage = { getTenant: () => "companion", getEmbeddingCoverage: vi.fn(async () => ({ total: 0, embedded: 0 })), getOrphanStats };

		const result = await handleHealthTool("mind_health", { section: "embeddings" }, { storage: storage as any });

		expect(result.janitor).toBeUndefined();
		expect(getOrphanStats).not.toHaveBeenCalled();
	});
});
