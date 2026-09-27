// ops/ADR-JANITOR.md §3/§9 commit 4 — freeze the threshold governor while
// backlog_mode drains, so post-drain acceptance is measured on the corrected
// link formula (§3), not a threshold already railed by five weeks of laundered
// timeouts (§0.5/§1) feeding a governor tuning a plant whose transfer function
// was wrong.
//
// Reads context.backlogMode (threaded by daemon/index.ts), NOT a second
// daemon_config.data.backlog_mode lookup — see daemon-orchestrator-order.spec.ts
// for the wiring test that drives the real orchestrator and proves context
// actually reaches this task.
import { describe, expect, it, vi } from "vitest";

import { runLearningTask } from "../src/daemon/tasks/learning";

function makeStorage(overrides: Record<string, unknown> = {}) {
	return {
		readDaemonConfig: vi.fn(async () => ({ tenant_id: "rook", link_proposal_threshold: 0.75, data: {} })),
		getProposalStats: vi.fn(async () => ({
			link: { total: 30, accepted: 2, rejected: 28, ratio: 2 / 30 } // well under 0.3 — would raise
		})),
		updateProposalThreshold: vi.fn(async () => undefined),
		...overrides
	};
}

describe("daemon learning task — backlog mode freeze", () => {
	it("adjusts the threshold normally when context.backlogMode is absent (default context)", async () => {
		const storage = makeStorage();

		const result = await runLearningTask(storage as any);

		expect(result.changes).toBe(1);
		expect(storage.updateProposalThreshold).toHaveBeenCalled();
	});

	it("adjusts the threshold normally when context.backlogMode is explicitly false", async () => {
		const storage = makeStorage();

		const result = await runLearningTask(storage as any, { backlogMode: false });

		expect(result.changes).toBe(1);
		expect(storage.updateProposalThreshold).toHaveBeenCalled();
	});

	it("freezes all threshold adjustment when context.backlogMode is true, even with strong low-acceptance signal", async () => {
		const storage = makeStorage();

		const result = await runLearningTask(storage as any, { backlogMode: true });

		expect(result.changes).toBe(0);
		expect(storage.updateProposalThreshold).not.toHaveBeenCalled();
		// frozen before even reading acceptance stats — the governor doesn't just
		// decline to act, it doesn't consult the plant at all while drain is active
		expect(storage.getProposalStats).not.toHaveBeenCalled();
	});

	it("freezes even when there is high-acceptance signal that would otherwise lower the bar", async () => {
		const storage = makeStorage({
			getProposalStats: vi.fn(async () => ({
				link: { total: 30, accepted: 29, rejected: 1, ratio: 29 / 30 }
			}))
		});

		const result = await runLearningTask(storage as any, { backlogMode: true });

		expect(result.changes).toBe(0);
		expect(storage.updateProposalThreshold).not.toHaveBeenCalled();
	});

	it("un-freezes the instant context.backlogMode flips back to false", async () => {
		const frozen = makeStorage();
		await runLearningTask(frozen as any, { backlogMode: true });
		expect(frozen.updateProposalThreshold).not.toHaveBeenCalled();

		const unfrozen = makeStorage();
		const result = await runLearningTask(unfrozen as any, { backlogMode: false });
		expect(result.changes).toBe(1);
		expect(unfrozen.updateProposalThreshold).toHaveBeenCalled();
	});

	it("still returns zero-change (not an error) when frozen and sample size would have been too small anyway", async () => {
		const storage = makeStorage({
			getProposalStats: vi.fn(async () => ({}))
		});

		const result = await runLearningTask(storage as any, { backlogMode: true });

		expect(result).toEqual({ task: "learning", changes: 0, proposals_created: 0 });
	});

	it("ignores a stale daemon_config.data.backlog_mode if one is ever present — context is the single source of truth, not a second storage read", async () => {
		// Guards against the exact duplication this refactor removed: even if
		// readDaemonConfig() returns data.backlog_mode: true, the task must NOT
		// freeze unless context.backlogMode says so.
		const storage = makeStorage({
			readDaemonConfig: vi.fn(async () => ({
				tenant_id: "rook", link_proposal_threshold: 0.75, data: { backlog_mode: true }
			}))
		});

		const result = await runLearningTask(storage as any, { backlogMode: false });

		expect(result.changes).toBe(1);
		expect(storage.updateProposalThreshold).toHaveBeenCalled();
	});
});
