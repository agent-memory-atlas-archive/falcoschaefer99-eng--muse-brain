// ops/ADR-JANITOR.md §2.1 (Eli) — the (A+1)-slot orphan flow invariant, tested at
// the source level rather than only relied on as an import-time throw. Two things
// live here:
//   1. assertOrphanFlowInvariant itself, exercised with arbitrary inputs so a
//      violation reads as this assertion failing, not an unhandled stack trace
//      surfacing the first time some future edit breaks the derivation.
//   2. The cross-module ceiling (RESCUE_LIMIT_BACKLOG <= MAX_ABSORB_PER_RUN) that
//      §2.1 explicitly calls out to assert as a TEST, not a module-load throw —
//      a cross-task import between orphans.ts and absorption.ts would be the
//      wrong dependency for two sibling daemon tasks to carry on each other.
import { describe, expect, it } from "vitest";
import {
	assertOrphanFlowInvariant,
	DETECT_LIMIT_STEADY,
	DETECT_LIMIT_BACKLOG,
	RESCUE_LIMIT_STEADY,
	RESCUE_LIMIT_BACKLOG,
	SLOTS_PER_ORPHAN_STEADY,
	SLOTS_PER_ORPHAN_BACKLOG
} from "../src/daemon/tasks/orphans";
import { MAX_ABSORB_PER_RUN } from "../src/daemon/tasks/absorption";

describe("assertOrphanFlowInvariant — the module-load assertion, tested as a function", () => {
	it("does not throw for the real, currently-shipped steady and backlog constants", () => {
		expect(() =>
			assertOrphanFlowInvariant(DETECT_LIMIT_STEADY, RESCUE_LIMIT_STEADY, SLOTS_PER_ORPHAN_STEADY, "steady")
		).not.toThrow();
		expect(() =>
			assertOrphanFlowInvariant(DETECT_LIMIT_BACKLOG, RESCUE_LIMIT_BACKLOG, SLOTS_PER_ORPHAN_BACKLOG, "backlog")
		).not.toThrow();
	});

	it("throws a descriptive error — naming the constants and the ADR — when detect × slots >= rescue", () => {
		// The old, pre-§2.1 model: DETECT_LIMIT=100, RESCUE_LIMIT=50, 1 slot per
		// orphan. 100 * 1 = 100 >= 50 — exactly the violation this ADR fixes.
		expect(() => assertOrphanFlowInvariant(100, 50, 1, "steady")).toThrow(
			/steady-mode orphan flow invariant violated.*100.*50.*ADR-JANITOR\.md §2\.1/s
		);
	});

	it("throws on the exact boundary (equal, not just greater) — the invariant is strict", () => {
		// 6 * 4 = 24 vs a rescue limit of 24: not LESS than, so this must throw.
		expect(() => assertOrphanFlowInvariant(6, 24, 4, "backlog")).toThrow();
	});

	it("does not throw one slot below the boundary", () => {
		expect(() => assertOrphanFlowInvariant(6, 25, 4, "backlog")).not.toThrow();
	});
});

describe("ops/ADR-JANITOR.md §2.1 — cross-module ceiling (test, not a module-load throw)", () => {
	it("RESCUE_LIMIT_BACKLOG never exceeds MAX_ABSORB_PER_RUN — orphans creates archive proposals before rescue proposals, and absorption's listProposals fetch is newest-first (LIFO); a backlog window larger than absorption's per-run cap would starve tonight's archive proposals out of the window (§0.5's disease, relocated into absorption)", () => {
		expect(RESCUE_LIMIT_BACKLOG).toBeLessThanOrEqual(MAX_ABSORB_PER_RUN);
	});
});
