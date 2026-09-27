// Regression coverage for the arrivalBoundary/cutoffDate bug: paradox-detection's
// own header (src/daemon/tasks/paradox-detection.ts:5-6) states "challenged 3+
// times in the last 30 days" as its design window, but the challenge filter
// used `context.touchedAfter ?? cutoffDate` (touchedAfter renamed arrivalBoundary
// — ops/ADR-JANITOR.md §2.1 "instance sixteen") — and it is the previous
// successful daemon run's started_at (daemon/context.ts), roughly 24h under the
// real nightly cadence. The 30-day cutoffDate was built (line 27) and never
// used. The task has produced zero proposals in production since it shipped.
import { describe, expect, it, vi } from "vitest";

import { runParadoxDetectionTask } from "../src/daemon/tasks/paradox-detection";
import type { IdentityCore, OpenLoop } from "../src/types";
import type { ArrivalBoundary, ParadoxSample, ScanRecord } from "../src/daemon/types";

// DaemonTaskResult.scan is a union across sibling tasks (RegradeSample |
// DedupSample | ParadoxSample) — narrowed by `task` name at the real call
// site (cycle.ts), same as cycle.ts's own regradeScan/dedupScan/paradoxScan
// casts. This task only ever returns the Paradox shape, so tests narrow the
// same way rather than asserting through the union.
function paradoxScan(result: { scan?: unknown }): ScanRecord<ParadoxSample> {
	return result.scan as ScanRecord<ParadoxSample>;
}

const daysAgo = (n: number): string => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function core(overrides: Partial<IdentityCore> & { id: string; challenges: IdentityCore["challenges"] }): IdentityCore {
	return {
		type: "identity_core",
		name: "Test Core",
		content: "a value I hold",
		category: "value",
		weight: 1,
		created: daysAgo(90),
		last_reinforced: daysAgo(10),
		reinforcement_count: 1,
		challenge_count: overrides.challenges?.length ?? 0,
		evolution_history: [],
		linked_observations: [],
		charge: [],
		...overrides
	};
}

function mockStorage(cores: IdentityCore[], opts: { loops?: OpenLoop[]; proposalExists?: boolean } = {}) {
	return {
		getTenant: () => "rainer",
		readIdentityCores: vi.fn(async () => cores),
		readOpenLoops: vi.fn(async () => opts.loops ?? []),
		proposalExists: vi.fn(async () => opts.proposalExists ?? false),
		createProposal: vi.fn(async (p: any) => ({ ...p, id: "proposal_1", proposed_at: new Date().toISOString() }))
	} as any;
}

describe("paradox-detection", () => {
	it("proposes for a core challenged 3 times across the full 30-day window, even when context.arrivalBoundary is only ~24h old (the real nightly cadence)", async () => {
		const c = core({
			id: "core_1",
			challenges: [
				{ description: "challenge a", date: daysAgo(25) },
				{ description: "challenge b", date: daysAgo(15) },
				{ description: "challenge c", date: daysAgo(2) }
			]
		});
		const storage = mockStorage([c]);

		const result = await runParadoxDetectionTask(storage, { arrivalBoundary: daysAgo(1) as ArrivalBoundary });

		expect(storage.createProposal).toHaveBeenCalledTimes(1);
		expect(result.proposals_created).toBe(1);
	});

	it("does not propose for a core with only 2 challenges in 30 days (threshold still respected)", async () => {
		const c = core({
			id: "core_1",
			challenges: [
				{ description: "challenge a", date: daysAgo(20) },
				{ description: "challenge b", date: daysAgo(5) }
			]
		});
		const storage = mockStorage([c]);

		const result = await runParadoxDetectionTask(storage, {});

		expect(storage.createProposal).not.toHaveBeenCalled();
		expect(result.proposals_created).toBe(0);
	});

	it("rationale and metadata report the same count and window the filter actually used — no 24h count reported as 30 days", async () => {
		const c = core({
			id: "core_1",
			name: "Precision",
			challenges: [
				{ description: "challenge a", date: daysAgo(25) },
				{ description: "challenge b", date: daysAgo(15) },
				{ description: "challenge c", date: daysAgo(2) }
			]
		});
		const storage = mockStorage([c]);

		await runParadoxDetectionTask(storage, { arrivalBoundary: daysAgo(1) as ArrivalBoundary });

		const proposal = storage.createProposal.mock.calls[0][0];
		expect(proposal.rationale).toBe(
			'Identity core "Precision" was challenged 3 times in the last 30 days — paradox loop may be needed'
		);
		expect(proposal.metadata.challenge_count).toBe(3);
	});

	it("skips a core that already has a paradox open_loop linked to it", async () => {
		const c = core({
			id: "core_1",
			challenges: [
				{ description: "challenge a", date: daysAgo(25) },
				{ description: "challenge b", date: daysAgo(15) },
				{ description: "challenge c", date: daysAgo(2) }
			]
		});
		const loop: OpenLoop = {
			id: "loop_1",
			content: "existing paradox",
			status: "open",
			territory: "identity",
			created: daysAgo(10),
			mode: "paradox",
			linked_entity_ids: ["core_1"]
		};
		const storage = mockStorage([c], { loops: [loop] });

		const result = await runParadoxDetectionTask(storage, {});

		expect(storage.createProposal).not.toHaveBeenCalled();
		expect(result.proposals_created).toBe(0);
	});

	it("skips a core when a paradox_detected proposal already exists for it", async () => {
		const c = core({
			id: "core_1",
			challenges: [
				{ description: "challenge a", date: daysAgo(25) },
				{ description: "challenge b", date: daysAgo(15) },
				{ description: "challenge c", date: daysAgo(2) }
			]
		});
		const storage = mockStorage([c], { proposalExists: true });

		const result = await runParadoxDetectionTask(storage, {});

		expect(storage.proposalExists).toHaveBeenCalledWith("paradox_detected", "core_1", "core_1");
		expect(storage.createProposal).not.toHaveBeenCalled();
		expect(result.proposals_created).toBe(0);
	});

	// Eli's audit generalisation of instance nine: `changes: 0, proposals: 0` is
	// indistinguishable from health; `population_total: N, candidates_total: 0`
	// is not — a quiet corpus (nothing worth proposing) must stay legible from an
	// unrun scan (population_total: null before this task ever ran).
	describe("scan record", () => {
		it("reports population_total/candidates_total/created as 0 for a corpus with no cores that clear the challenge threshold — not indistinguishable-from-unrun", async () => {
			const c = core({
				id: "core_1",
				challenges: [
					{ description: "challenge a", date: daysAgo(20) },
					{ description: "challenge b", date: daysAgo(5) }
				]
			});
			const storage = mockStorage([c]);

			const result = await runParadoxDetectionTask(storage, {});

			expect(result.scan).toBeDefined();
			expect(result.scan!.population_total).toBe(1);
			expect(result.scan!.candidates_total).toBe(0);
			expect(result.scan!.would_create).toBe(0);
			expect(result.scan!.created).toBe(0);
			expect(result.scan!.sample).toEqual([]);
		});

		it("reports population_total: 0 and an empty scan for a tenant with zero identity cores", async () => {
			const storage = mockStorage([]);

			const result = await runParadoxDetectionTask(storage, {});

			expect(result.scan).toEqual({
				at: expect.any(String),
				population_total: 0,
				candidates_total: 0,
				would_create: 0,
				created: 0,
				sample: [],
				sample_truncated_to: 0
			});
		});

		it("candidates_total counts every core that clears the challenge window, even one already covered by an existing loop or proposal (candidacy, not creation)", async () => {
			const covered = core({
				id: "core_covered",
				challenges: [
					{ description: "a", date: daysAgo(25) },
					{ description: "b", date: daysAgo(15) },
					{ description: "c", date: daysAgo(2) }
				]
			});
			const fresh = core({
				id: "core_fresh",
				challenges: [
					{ description: "a", date: daysAgo(25) },
					{ description: "b", date: daysAgo(15) },
					{ description: "c", date: daysAgo(2) }
				]
			});
			const loop: OpenLoop = {
				id: "loop_1",
				content: "existing paradox",
				status: "burning",
				territory: "identity",
				created: daysAgo(10),
				mode: "paradox",
				linked_entity_ids: ["core_covered"]
			};
			const storage = mockStorage([covered, fresh], { loops: [loop] });

			const result = await runParadoxDetectionTask(storage, {});

			// both cleared the window (candidacy)...
			expect(result.scan!.candidates_total).toBe(2);
			// ...but only the uncovered one actually got a proposal (creation)
			expect(result.proposals_created).toBe(1);
			expect(result.scan!.created).toBe(1);
			expect(result.scan!.would_create).toBe(1);
			expect(paradoxScan(result).sample.map(s => s.core_id).sort()).toEqual(["core_covered", "core_fresh"]);
		});

		it("sample rows report the same rationale and challenge_count the created proposal itself carries — no drift between the two", async () => {
			const c = core({
				id: "core_1",
				name: "Precision",
				challenges: [
					{ description: "a", date: daysAgo(25) },
					{ description: "b", date: daysAgo(15) },
					{ description: "c", date: daysAgo(2) }
				]
			});
			const storage = mockStorage([c]);

			const result = await runParadoxDetectionTask(storage, {});

			const proposalArg = storage.createProposal.mock.calls[0][0];
			const sampleRow = paradoxScan(result).sample[0];
			expect(sampleRow.core_id).toBe("core_1");
			expect(sampleRow.core_name).toBe("Precision");
			expect(sampleRow.challenge_count).toBe(3);
			expect(sampleRow.rationale).toBe(proposalArg.rationale);
		});
	});
});
