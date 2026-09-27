// ops/ADR-JANITOR.md §2.1 "instance sixteen" — assertArrivalNotAfterCutoff,
// exercised directly with arbitrary inputs so a violation reads as this
// assertion failing, not an unhandled stack trace surfacing the first time
// some future caller re-threads an ArrivalBoundary into a StateWindow check.
// Mirrors test/orphan-flow-invariant.spec.ts's pattern for the sibling
// assertOrphanFlowInvariant.
import { describe, expect, it } from "vitest";
import { assertArrivalNotAfterCutoff } from "../src/daemon/types";
import type { ArrivalBoundary, StateWindow } from "../src/daemon/types";

const asCutoff = (s: string) => s as StateWindow;
const asArrival = (s: string) => s as ArrivalBoundary;

describe("assertArrivalNotAfterCutoff — the storage-level guard, tested as a function", () => {
	it("does not throw when arrival is absent", () => {
		expect(() => assertArrivalNotAfterCutoff(asCutoff("2026-07-20T00:00:00.000Z"), undefined)).not.toThrow();
	});

	it("does not throw when arrival sits before the cutoff (the one satisfiable ordering)", () => {
		expect(() =>
			assertArrivalNotAfterCutoff(asCutoff("2026-07-20T00:00:00.000Z"), asArrival("2026-07-15T00:00:00.000Z"))
		).not.toThrow();
	});

	it("does not throw when arrival exactly equals the cutoff (boundary, not violation)", () => {
		expect(() =>
			assertArrivalNotAfterCutoff(asCutoff("2026-07-20T00:00:00.000Z"), asArrival("2026-07-20T00:00:00.000Z"))
		).not.toThrow();
	});

	it("throws a descriptive error — naming both boundaries and the ADR — when arrival is after cutoff", () => {
		// Exactly orphans.ts's pre-C2 shape: cutoffDate 14 days ago (an old,
		// stale-age boundary), arrival ~24h ago (a recent run boundary) —
		// chronologically after the cutoff, the combination this assertion exists
		// to catch.
		expect(() =>
			assertArrivalNotAfterCutoff(asCutoff("2026-07-20T00:00:00.000Z"), asArrival("2026-07-30T03:00:00.000Z"))
		).toThrow(/arrival boundary.*2026-07-30.*after the state-window cutoff.*2026-07-20.*ADR-JANITOR\.md §2\.1/s);
	});
});
