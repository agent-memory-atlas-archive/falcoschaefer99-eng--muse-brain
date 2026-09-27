// ops/ADR-JANITOR.md §2/§9 commit 4 — second absorption pass.
// Orphan-rescue/archive proposals are CREATED in the orphans task (position 5),
// but absorption runs at position 2 — without a second call, every archive
// proposal from tonight's drain would wait a full night before absorption sees
// it. Drives the REAL runDaemonTasks() (src/daemon/index.ts), mocking only the
// individual task modules, so this proves the actual orchestrator's wiring —
// not a hand-copied re-implementation of "what order things should run in."
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ callOrder: [] as string[] }));

function task(name: string) {
	return vi.fn(async () => {
		hoisted.callOrder.push(name);
		return { task: name, changes: 0, proposals_created: 0 };
	});
}

vi.mock("../src/daemon/tasks/dedup", () => ({ runDedupTask: task("dedup") }));
vi.mock("../src/daemon/tasks/proposals", () => ({ runProposalTask: task("proposals") }));
vi.mock("../src/daemon/tasks/absorption", () => ({ runAbsorptionTask: task("absorption") }));
vi.mock("../src/daemon/tasks/learning", () => ({ runLearningTask: task("learning") }));
vi.mock("../src/daemon/tasks/cascade", () => ({ runCascadeTask: task("cascade") }));
vi.mock("../src/daemon/tasks/orphans", () => ({ runOrphanTask: task("orphans") }));
vi.mock("../src/daemon/tasks/salience-regrade", () => ({ runSalienceRegradeTask: task("salience-regrade") }));
vi.mock("../src/daemon/tasks/kit-hygiene", () => ({ runKitHygieneTask: task("kit-hygiene") }));
vi.mock("../src/daemon/tasks/skill-health", () => ({ runSkillHealthTask: task("skill-health") }));
vi.mock("../src/daemon/tasks/cross-agent", () => ({ runCrossAgentTask: task("cross-agent") }));
vi.mock("../src/daemon/tasks/cross-tenant", () => ({ runCrossTenantTask: task("cross-tenant") }));
vi.mock("../src/daemon/tasks/paradox-detection", () => ({ runParadoxDetectionTask: task("paradox-detection") }));
vi.mock("../src/daemon/tasks/recall-contracts", () => ({ runRecallContractsTask: task("recall-contracts") }));
vi.mock("../src/daemon/tasks/task-scheduling", () => ({ runTaskSchedulingTask: task("task-scheduling") }));

import { runDaemonTasks } from "../src/daemon/index";
import { runAbsorptionTask } from "../src/daemon/tasks/absorption";
import { runLearningTask } from "../src/daemon/tasks/learning";
import { runOrphanTask } from "../src/daemon/tasks/orphans";
import { runKitHygieneTask } from "../src/daemon/tasks/kit-hygiene";

describe("runDaemonTasks() orchestrator — second absorption pass", () => {
	beforeEach(() => {
		hoisted.callOrder.length = 0;
		vi.clearAllMocks();
	});

	it("calls runAbsorptionTask exactly twice per cycle", async () => {
		await runDaemonTasks({} as any, {});

		expect(runAbsorptionTask).toHaveBeenCalledTimes(2);
	});

	it("runs dedup BEFORE every other task, including proposals — ops/ADR-JANITOR.md §8 step 0: the dedup shadow scan must capture the corpus's pre-drain cosine baseline before orphan-rescue/absorption rewrite the link graph", async () => {
		await runDaemonTasks({} as any, {});

		expect(hoisted.callOrder[0]).toBe("dedup");
		expect(hoisted.callOrder.indexOf("dedup")).toBeLessThan(hoisted.callOrder.indexOf("proposals"));
		expect(hoisted.callOrder.indexOf("dedup")).toBeLessThan(hoisted.callOrder.indexOf("orphans"));
	});

	it("runs the second absorption pass AFTER orphans and BEFORE kit-hygiene, without moving the first pass", async () => {
		await runDaemonTasks({} as any, {});

		expect(hoisted.callOrder).toEqual([
			"dedup",     // ops/ADR-JANITOR.md §8 step 0 — before everything, including proposals
			"proposals",
			"absorption", // 1st pass — unmoved: still right after proposals
			"learning",   // task 3 — runs before orphans and the 2nd absorption pass
			"cascade",
			"orphans",
			"absorption", // 2nd pass — right after orphans
			"salience-regrade",
			"kit-hygiene",
			"skill-health",
			"cross-agent",
			"cross-tenant",
			"paradox-detection",
			"recall-contracts",
			"task-scheduling"
		]);
	});

	it("learning (task 3) sees exactly the inputs it saw before this commit — unaffected by the second absorption pass", async () => {
		await runDaemonTasks({} as any, {});

		const learningIndex = hoisted.callOrder.indexOf("learning");
		const firstAbsorptionIndex = hoisted.callOrder.indexOf("absorption");
		const orphansIndex = hoisted.callOrder.indexOf("orphans");
		const secondAbsorptionIndex = hoisted.callOrder.lastIndexOf("absorption");

		// learning still runs right after the FIRST absorption pass and strictly
		// before orphans / the second absorption pass exist in the timeline
		expect(learningIndex).toBe(firstAbsorptionIndex + 1);
		expect(learningIndex).toBeLessThan(orphansIndex);
		expect(learningIndex).toBeLessThan(secondAbsorptionIndex);
		expect(runLearningTask).toHaveBeenCalledTimes(1);
	});

	it("includes both absorption results in the returned array (one per pass)", async () => {
		const results = await runDaemonTasks({} as any, {});

		const absorptionResults = results.filter(r => r.task === "absorption");
		expect(absorptionResults).toHaveLength(2);
	});

	it("threads the same context into orphans as the rest of the sweep", async () => {
		const context = { deadlineAt: 12345, backlogMode: true };

		await runDaemonTasks({} as any, context);

		expect(runOrphanTask).toHaveBeenCalledWith({}, context);
	});

	it("threads the same context into learning — the wiring gap this commit closes (learning.ts used to re-read daemon_config.data.backlog_mode itself instead of receiving it)", async () => {
		const context = { deadlineAt: 12345, backlogMode: true };

		await runDaemonTasks({} as any, context);

		expect(runLearningTask).toHaveBeenCalledWith({}, context);
	});

	it("still runs kit-hygiene even if the second absorption pass throws", async () => {
		(runAbsorptionTask as any)
			.mockImplementationOnce(async () => {
				hoisted.callOrder.push("absorption");
				return { task: "absorption", changes: 0, proposals_created: 0 };
			})
			.mockImplementationOnce(async () => {
				hoisted.callOrder.push("absorption");
				throw new Error("second pass boom");
			});

		const results = await runDaemonTasks({} as any, {});

		expect(hoisted.callOrder).toContain("kit-hygiene");
		expect((runKitHygieneTask as any)).toHaveBeenCalled();
		const failedAbsorption = results.find(r => r.task === "absorption" && r.error);
		expect(failedAbsorption?.error).toContain("second pass boom");
	});
});
