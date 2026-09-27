import { describe, expect, it, vi } from "vitest";

import { CHECKPOINT_STAGES, DaemonHeartbeat } from "../src/daemon/heartbeat";

/** The stage names scheduled() reports, in execution order. */
const NIGHTLY_STAGES = [
	"ai-review",
	"daemon-tasks",
	"decay",
	"subconscious",
	"novelty",
	"summary-backfill",
	"overviews",
	"embedding-backfill"
];

function traceOf(storage: { state: { data: Record<string, unknown> } }) {
	return storage.state.data.last_daemon_run as {
		started_at: string;
		completed_stages: string[];
		finished_at: string | null;
	};
}

/** Storage double whose daemon_config.data behaves like postgres: whole-blob replace. */
function makeConfigStorage(initialData: Record<string, unknown> = {}) {
	const state = { data: { ...initialData } };
	return {
		state,
		readDaemonConfig: vi.fn(async () => ({
			tenant_id: "rook",
			link_proposal_threshold: 0.87,
			data: state.data
		})),
		updateDaemonConfigData: vi.fn(async (data: Record<string, unknown>) => {
			state.data = data; // replace, not merge — matches PostgresBrainStorage
		})
	};
}

describe("daemon heartbeat", () => {
	it("writes started_at and the first stage as soon as one stage completes", async () => {
		const storage = makeConfigStorage();
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await heartbeat.stageComplete("ai-review");

		expect(storage.updateDaemonConfigData).toHaveBeenCalledTimes(1);
		expect(storage.state.data.last_daemon_run).toEqual({
			started_at: "2026-07-29T03:00:00.000Z",
			completed_stages: ["ai-review"],
			finished_at: null
		});
	});

	it("persists three times per run regardless of stage count", async () => {
		const storage = makeConfigStorage();
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		for (const stage of NIGHTLY_STAGES) {
			await heartbeat.stageComplete(stage);
		}
		await heartbeat.finish("2026-07-29T03:02:00.000Z");

		// first stage + the daemon-tasks checkpoint + finish
		expect(storage.updateDaemonConfigData).toHaveBeenCalledTimes(3);
		expect(storage.state.data.last_daemon_run).toEqual({
			started_at: "2026-07-29T03:00:00.000Z",
			completed_stages: NIGHTLY_STAGES,
			finished_at: "2026-07-29T03:02:00.000Z"
		});
	});

	it("distinguishes a death before, inside, and after the task sweep", async () => {
		// died before the sweep: ai-review recorded, daemon-tasks absent
		const early = makeConfigStorage();
		const earlyBeat = new DaemonHeartbeat(early as any, "2026-07-29T03:00:00.000Z");
		await earlyBeat.stageComplete("ai-review");
		expect(traceOf(early)).toMatchObject({ completed_stages: ["ai-review"], finished_at: null });

		// died after the sweep: the checkpoint write proves daemon-tasks survived
		const late = makeConfigStorage();
		const lateBeat = new DaemonHeartbeat(late as any, "2026-07-29T03:00:00.000Z");
		await lateBeat.stageComplete("ai-review");
		await lateBeat.stageComplete("daemon-tasks");
		await lateBeat.stageComplete("decay");
		// invocation killed here — finish() never runs
		expect(traceOf(late)).toMatchObject({
			completed_stages: ["ai-review", "daemon-tasks"],
			finished_at: null
		});
		expect(late.updateDaemonConfigData).toHaveBeenCalledTimes(2);
	});

	it("only checkpoints on the designated stages", async () => {
		expect([...CHECKPOINT_STAGES]).toEqual(["daemon-tasks"]);

		const storage = makeConfigStorage();
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await heartbeat.stageComplete("ai-review");
		await heartbeat.stageComplete("decay");
		await heartbeat.stageComplete("subconscious");

		expect(storage.updateDaemonConfigData).toHaveBeenCalledTimes(1);
	});

	it("preserves every other key in the data blob", async () => {
		const storage = makeConfigStorage({
			last_ai_review: { reviewed: 12, at: "2026-07-28T03:00:00.000Z" },
			link_proposal_weights: { semantic: 0.6 }
		});
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await heartbeat.stageComplete("ai-review");
		await heartbeat.finish("2026-07-29T03:02:00.000Z");

		expect(storage.state.data.last_ai_review).toEqual({ reviewed: 12, at: "2026-07-28T03:00:00.000Z" });
		expect(storage.state.data.link_proposal_weights).toEqual({ semantic: 0.6 });
		expect(storage.state.data.last_daemon_run).toBeDefined();
	});

	it("re-reads the blob at write time so mid-run writers are not clobbered", async () => {
		const storage = makeConfigStorage();
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await heartbeat.stageComplete("ai-review");
		// another writer (e.g. runAiProposalReview's storeSummary) lands between writes
		storage.state.data = { ...storage.state.data, last_ai_review: { reviewed: 3 } };

		await heartbeat.finish("2026-07-29T03:02:00.000Z");

		expect(storage.state.data.last_ai_review).toEqual({ reviewed: 3 });
		expect((storage.state.data.last_daemon_run as { finished_at: string }).finished_at)
			.toBe("2026-07-29T03:02:00.000Z");
	});

	it("never throws when the config write fails", async () => {
		const storage = makeConfigStorage();
		storage.updateDaemonConfigData.mockRejectedValue(new Error("hyperdrive down"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await expect(heartbeat.stageComplete("ai-review")).resolves.toBeUndefined();
		await expect(heartbeat.finish("2026-07-29T03:02:00.000Z")).resolves.toBeUndefined();

		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("distinguishes a thrown error from an uncatchable budget kill", async () => {
		// budget kill: nothing can run, so the trace just stops — no error key
		const killed = makeConfigStorage();
		const killedBeat = new DaemonHeartbeat(killed as any, "2026-07-29T03:00:00.000Z");
		await killedBeat.stageComplete("ai-review");
		expect(traceOf(killed).finished_at).toBeNull();
		expect(traceOf(killed)).not.toHaveProperty("error");

		// thrown error: caught, so we get to say so
		const thrown = makeConfigStorage();
		const thrownBeat = new DaemonHeartbeat(thrown as any, "2026-07-29T03:00:00.000Z");
		await thrownBeat.stageComplete("ai-review");
		await thrownBeat.fail("connection terminated", "2026-07-29T03:00:09.000Z");

		expect(traceOf(thrown)).toEqual({
			started_at: "2026-07-29T03:00:00.000Z",
			completed_stages: ["ai-review"],
			finished_at: "2026-07-29T03:00:09.000Z",
			error: "connection terminated"
		});
	});

	it("retains a daemon-task result error through the final finish", async () => {
		const storage = makeConfigStorage();
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await heartbeat.stageComplete("ai-review");
		await heartbeat.stageFailed("daemon-tasks", "cascade: database unavailable");
		await heartbeat.stageComplete("decay");
		await heartbeat.finish("2026-07-29T03:02:00.000Z");

		expect(traceOf(storage)).toEqual({
			started_at: "2026-07-29T03:00:00.000Z",
			completed_stages: ["ai-review", "daemon-tasks", "decay"],
			finished_at: "2026-07-29T03:02:00.000Z",
			error: "daemon-tasks: cascade: database unavailable",
			failed_stages: ["daemon-tasks"]
		});
	});

	it("omits the error key entirely on a healthy run", async () => {
		const storage = makeConfigStorage();
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await heartbeat.stageComplete("ai-review");
		await heartbeat.finish("2026-07-29T03:02:00.000Z");

		expect(traceOf(storage)).not.toHaveProperty("error");
	});

	it("merges finish()'s extraData into the SAME write as last_daemon_run, never a second write", async () => {
		const storage = makeConfigStorage({ some_other_key: "untouched" });
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await heartbeat.stageComplete("ai-review");
		await heartbeat.finish("2026-07-29T03:02:00.000Z", { last_orphan_drain: { count: 3, at: "2026-07-29T03:02:00.000Z" } });

		// first stage + finish — extraData rides the finish write, no third call
		expect(storage.updateDaemonConfigData).toHaveBeenCalledTimes(2);
		expect(storage.state.data.last_orphan_drain).toEqual({ count: 3, at: "2026-07-29T03:02:00.000Z" });
		expect(storage.state.data.some_other_key).toBe("untouched");
		expect(storage.state.data.last_daemon_run).toMatchObject({ finished_at: "2026-07-29T03:02:00.000Z" });
	});

	it("finish() without extraData behaves exactly as before (backward compatible)", async () => {
		const storage = makeConfigStorage();
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await heartbeat.finish("2026-07-29T03:00:05.000Z");

		expect(storage.state.data).toEqual({
			last_daemon_run: {
				started_at: "2026-07-29T03:00:00.000Z",
				completed_stages: [],
				finished_at: "2026-07-29T03:00:05.000Z"
			}
		});
	});

	it("still stamps finished_at when no stage ever completed", async () => {
		const storage = makeConfigStorage();
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await heartbeat.finish("2026-07-29T03:00:05.000Z");

		expect(storage.state.data.last_daemon_run).toEqual({
			started_at: "2026-07-29T03:00:00.000Z",
			completed_stages: [],
			finished_at: "2026-07-29T03:00:05.000Z"
		});
	});

	// ops/ADR-JANITOR.md §9 commit 4 — the first writer of a field commit 1 only typed.
	it("omits truncated_by_deadline on a healthy run that never calls markTruncatedByDeadline", async () => {
		const storage = makeConfigStorage();
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await heartbeat.stageComplete("ai-review");
		await heartbeat.finish("2026-07-29T03:02:00.000Z");

		expect(traceOf(storage)).not.toHaveProperty("truncated_by_deadline");
	});

	it("sets truncated_by_deadline: true on the next persisted trace once marked", async () => {
		const storage = makeConfigStorage();
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await heartbeat.stageComplete("ai-review");
		heartbeat.markTruncatedByDeadline();
		await heartbeat.finish("2026-07-29T03:02:00.000Z");

		expect(traceOf(storage)).toMatchObject({ truncated_by_deadline: true });
	});

	it("keeps truncated_by_deadline true through the rest of the run once marked (sticky)", async () => {
		const storage = makeConfigStorage();
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		heartbeat.markTruncatedByDeadline();
		await heartbeat.stageComplete("ai-review");
		await heartbeat.stageComplete("daemon-tasks");
		await heartbeat.finish("2026-07-29T03:02:00.000Z");

		// every persisted write after the mark carries the flag, not just the last one
		expect((storage.updateDaemonConfigData.mock.calls[0][0] as any).last_daemon_run.truncated_by_deadline).toBe(true);
		expect(traceOf(storage)).toMatchObject({ truncated_by_deadline: true });
	});

	it("does not add a write of its own — markTruncatedByDeadline rides the next scheduled persist", async () => {
		const storage = makeConfigStorage();
		const heartbeat = new DaemonHeartbeat(storage as any, "2026-07-29T03:00:00.000Z");

		await heartbeat.stageComplete("ai-review");
		expect(storage.updateDaemonConfigData).toHaveBeenCalledTimes(1);

		heartbeat.markTruncatedByDeadline();
		expect(storage.updateDaemonConfigData).toHaveBeenCalledTimes(1); // still 1 — synchronous, no I/O

		await heartbeat.finish("2026-07-29T03:02:00.000Z");
		expect(storage.updateDaemonConfigData).toHaveBeenCalledTimes(2);
	});
});
