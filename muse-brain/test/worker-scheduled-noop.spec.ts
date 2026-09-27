// Pins the fix for the double-fire bug (found 2026-08-30, fixed 2026-09-04):
// wrangler.jsonc used to carry a "0 3 * * *" cron trigger AND the box runner
// (rook-brain-daemon.timer) ran the same nightly metabolism cycle at the same
// time — decay/novelty ran twice a night, and the Worker's copy died anyway on
// the Workers FREE plan's CPU cap. The fix: no cron trigger in wrangler.jsonc,
// and scheduled() is a deliberate no-op so a trigger re-added by accident can't
// silently resurrect the double-run. See test/daemon-cycle-order.spec.ts for the
// box-path seam (runTenantCycle) this handler USED to call.

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ cycleCalls: 0 }));

vi.mock("../src/daemon/cycle", () => ({
	runTenantCycle: vi.fn(async () => {
		hoisted.cycleCalls++;
		return { decayChanges: 0, noveltyChanges: 0, fatal: false, ok: true };
	})
}));

vi.mock("../src/storage/index", () => ({
	createStorage: vi.fn(() => ({}))
}));

import worker from "../src/index";
import { runTenantCycle } from "../src/daemon/cycle";
import { createStorage } from "../src/storage/index";

describe("worker scheduled() no-op", () => {
	beforeEach(() => {
		hoisted.cycleCalls = 0;
		vi.clearAllMocks();
	});

	it("does not run the tenant metabolism cycle on cron", async () => {
		const env = { STORAGE_BACKEND: "sqlite", SQLITE_PATH: "/tmp/muse-brain-scheduled-noop.sqlite" } as any;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(worker.scheduled({} as any, env, {} as any)).resolves.toBeUndefined();

		expect(runTenantCycle).not.toHaveBeenCalled();
		expect(createStorage).not.toHaveBeenCalled();
		expect(hoisted.cycleCalls).toBe(0);

		logSpy.mockRestore();
	});

	it("logs a structured no-op line instead of running silently", async () => {
		const env = { STORAGE_BACKEND: "sqlite", SQLITE_PATH: "/tmp/muse-brain-scheduled-noop.sqlite" } as any;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await worker.scheduled({} as any, env, {} as any);

		expect(logSpy).toHaveBeenCalledTimes(1);
		const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
		expect(logged).toMatchObject({ event: "scheduled_noop" });

		logSpy.mockRestore();
	});
});
