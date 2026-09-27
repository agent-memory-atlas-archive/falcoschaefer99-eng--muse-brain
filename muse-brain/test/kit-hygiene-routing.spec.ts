import { describe, expect, it } from "vitest";

import { runKitHygieneTask } from "../src/daemon/tasks/kit-hygiene";
import { createStorage } from "../src/storage/factory";

/**
 * Counts the storage methods the task calls, without changing behaviour.
 * Methods are applied to the raw target, so a backend's own internal calls stay
 * uncounted — the tally is exactly what kit-hygiene asked the storage layer for.
 */
function countingStorage<T extends object>(storage: T): { storage: T; calls: Record<string, number> } {
	const calls: Record<string, number> = {};
	const proxy = new Proxy(storage, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				calls[prop as string] = (calls[prop as string] ?? 0) + 1;
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		}
	});
	return { storage: proxy, calls };
}

function receipt(id: string, projectId: string, lines: string[], created: string) {
	return {
		id,
		content: ["repo_receipt", `project_entity_id: ${projectId}`, "status: success", ...lines].join("\n"),
		territory: "craft",
		created,
		texture: {
			salience: "background",
			vividness: "soft",
			charge: ["receipt", "repo", "success", "project-routing"],
			grip: "loose",
			charge_phase: "fresh"
		},
		access_count: 0,
		type: "repo_receipt",
		tags: ["repo-receipt"],
		entity_id: projectId
	} as any;
}

/** Two projects: one with an empty dossier, one whose dossier disagrees with its receipts. */
async function seedFixture(storage: any, now: string) {
	const fresh = await storage.createEntity({
		tenant_id: "rainer",
		name: "MUSE Brain",
		entity_type: "project",
		tags: ["muse-brain"],
		salience: "active",
		primary_context: "Persistent memory substrate"
	});
	await storage.createProjectDossier({
		project_entity_id: fresh.id,
		lifecycle_status: "active",
		summary: "Brain work",
		goals: [], constraints: [], decisions: [], open_questions: [], next_actions: [],
		metadata: {}
	});

	const drifted = await storage.createEntity({
		tenant_id: "rainer",
		name: "Sovereign MUSE",
		entity_type: "project",
		tags: ["sovereign-muse"],
		salience: "active",
		primary_context: "The app"
	});
	await storage.createProjectDossier({
		project_entity_id: drifted.id,
		lifecycle_status: "active",
		summary: "App work",
		goals: [], constraints: [], decisions: [], open_questions: [], next_actions: [],
		metadata: {
			workspace_routing: {
				local_paths: ["/home/user/AI/old-sovereign-muse"],
				deploy: { commands: ["./old-deploy.sh"] }
			}
		}
	});

	for (const suffix of ["a", "b"]) {
		await storage.appendToTerritory("craft", receipt(`obs_fresh_${suffix}`, fresh.id, [
			"local_path: /home/user/AI/muse-brain",
			"deploy_command: npm run deploy"
		], now));
		await storage.appendToTerritory("craft", receipt(`obs_drift_${suffix}`, drifted.id, [
			"local_path: /home/user/AI/sovereign-muse",
			"deploy_command: ./deploy.sh",
			"artifact_path: /home/user/AI/sovereign-muse/dist/bundle.js"
		], now));
	}

	await storage.createTask({
		title: "Build release artifact",
		status: "done",
		priority: "normal",
		source: "test",
		linked_observation_ids: [],
		linked_entity_ids: [fresh.id],
		completion_note: "Built the package but forgot the path.",
		completed_at: now
	});

	return { fresh, drifted };
}

/** The comparable shape of a created proposal — what the reviewer actually acts on. */
function payloadsOf(proposals: any[]) {
	return proposals
		.map(p => ({
			proposal_type: p.proposal_type,
			source_id: p.source_id,
			target_id: p.target_id,
			confidence: p.confidence,
			status: p.status,
			metadata: p.metadata,
			rationale: p.rationale
		}))
		.sort((a, b) => `${a.proposal_type}${a.target_id}`.localeCompare(`${b.proposal_type}${b.target_id}`));
}

async function allProjectProposals(storage: any) {
	const types = [
		"project_routing_update",
		"project_routing_drift",
		"stale_deploy_command",
		"missing_artifact_receipt"
	];
	const out: any[] = [];
	for (const type of types) out.push(...await storage.listProposals(type, "pending", 50));
	return out;
}

function newStorage() {
	const dbPath = `/tmp/muse-brain-kit-routing-${crypto.randomUUID()}.sqlite`;
	return createStorage({ backend: "sqlite", sqlitePath: dbPath }, "rainer");
}

describe("kit hygiene project routing synthesis", () => {
	it("proposes routing updates from repeated project receipts and flags missing artifact paths", async () => {
		const storage = newStorage();
		const now = "2026-06-13T09:00:00.000Z";
		const { fresh } = await seedFixture(storage, now);

		const result = await runKitHygieneTask(storage);
		expect(result.proposals_created).toBeGreaterThanOrEqual(2);

		const routingUpdates = await storage.listProposals("project_routing_update", "pending", 20);
		expect(routingUpdates.some(proposal =>
			proposal.metadata.project_entity_id === fresh.id
			&& proposal.metadata.field === "workspace_routing.local_paths"
			&& proposal.metadata.proposed_value === "/home/user/AI/muse-brain"
		)).toBe(true);

		const missingArtifacts = await storage.listProposals("missing_artifact_receipt", "pending", 20);
		expect(missingArtifacts.some(proposal =>
			proposal.metadata.project_entity_id === fresh.id
			&& proposal.metadata.task_title === "Build release artifact"
		)).toBe(true);
	});

	it("produces the full expected proposal set for the fixture", async () => {
		const storage = newStorage();
		const now = "2026-06-13T09:00:00.000Z";
		const { fresh, drifted } = await seedFixture(storage, now);

		const result = await runKitHygieneTask(storage);

		// 2 for the empty dossier (local_path + deploy_command), 3 for the drifted one
		// (drift + stale deploy + artifact root), 1 missing artifact receipt.
		expect(result.proposals_created).toBe(6);

		const created = payloadsOf(await allProjectProposals(storage));
		expect(created.map(p => [p.proposal_type, p.source_id === fresh.id ? "fresh" : "drifted", p.target_id, p.confidence])).toEqual([
			["missing_artifact_receipt", "fresh", expect.stringMatching(/^task:/), 0.74],
			["project_routing_drift", "drifted", "local_path:/home/user/AI/sovereign-muse", 0.86],
			["project_routing_update", "drifted", "artifact_root:/home/user/AI/sovereign-muse/dist", 0.72],
			["project_routing_update", "fresh", "deploy_command:npm run deploy", 0.78],
			["project_routing_update", "fresh", "local_path:/home/user/AI/muse-brain", 0.82],
			["stale_deploy_command", "drifted", "deploy_command:./deploy.sh", 0.84]
		]);

		// Every payload carries the project identity the reviewer needs.
		for (const proposal of created) {
			expect(proposal.status).toBe("pending");
			expect(proposal.metadata.project_entity_id).toBeTruthy();
			expect(proposal.metadata.project_name).toBeTruthy();
			expect(proposal.rationale).toBeTruthy();
		}
	});

	it("reads the project scan in a fixed number of round-trips, not one per project", async () => {
		const raw = newStorage();
		const now = "2026-06-13T09:00:00.000Z";
		await seedFixture(raw, now);
		const { storage, calls } = countingStorage(raw as any);

		await runKitHygieneTask(storage);

		// The per-project reads are gone: batched primitives only.
		expect(calls.getProjectDossier ?? 0).toBe(0);
		expect(calls.getEntityObservations ?? 0).toBe(0);
		expect(calls.proposalExists ?? 0).toBe(0);

		expect(calls.listProjectDossiers).toBe(1);
		expect(calls.listTasks).toBe(1);
		// one for the (empty) agent scan, one for the project scan
		expect(calls.batchGetEntityObservations ?? 0).toBeLessThanOrEqual(1);
		expect(calls.batchProposalExists).toBe(1);
		// one write per proposal actually created, and nothing more
		expect(calls.createProposal).toBe(6);
	});

	it("does not re-propose anything on a second night", async () => {
		const storage = newStorage();
		const now = "2026-06-13T09:00:00.000Z";
		await seedFixture(storage, now);

		const first = await runKitHygieneTask(storage);
		const before = payloadsOf(await allProjectProposals(storage));

		const second = await runKitHygieneTask(storage);
		const after = payloadsOf(await allProjectProposals(storage));

		expect(first.proposals_created).toBe(6);
		expect(second.proposals_created).toBe(0);
		expect(after).toEqual(before);
	});

	it("skips projects without a dossier", async () => {
		const storage = newStorage();
		const now = "2026-06-13T09:00:00.000Z";
		const orphanProject = await storage.createEntity({
			tenant_id: "rainer",
			name: "No Dossier",
			entity_type: "project",
			tags: [],
			salience: "active",
			primary_context: "unregistered"
		});
		for (const suffix of ["a", "b"]) {
			await storage.appendToTerritory("craft", receipt(`obs_nd_${suffix}`, orphanProject.id, [
				"local_path: /home/user/AI/no-dossier"
			], now));
		}

		const result = await runKitHygieneTask(storage);

		expect(result.proposals_created).toBe(0);
	});
});
