// ============ DAEMON TASK: KIT HYGIENE ============
// Kit's cleanup cycle runs per agent entity.
// For each agent: counts observations by charge_phase, proposes consolidation
// when metabolized or total counts are high.
//
// Dedup used to live here too (vector similarity > 0.92) — moved to
// daemon/tasks/dedup.ts (ops/ADR-JANITOR.md §0.4/§6.1). It never actually fired
// from this location: a corpus-level operation living inside a per-agent loop,
// bounded by a per-night recency window, filtered by findSimilarUnlinked's
// anti-duplicate exclusions (wrong for dedup), against a threshold above the
// corpus's measured cosine ceiling. Every one of those was a category error.

import type { IBrainStorage } from "../../storage/interface";
import type { DaemonTaskResult } from "../types";
import type { DaemonRunContext } from "../types";
import type { DaemonProposalType, Entity, Observation, ProjectWorkspaceRouting, Task } from "../../types";
import { extractProjectWorkspaceRoutingFromMetadata } from "../../tools-v2/project-routing";
import { proposalKey } from "../../storage/keys";

const METABOLIZED_THRESHOLD = 20;
const TOTAL_THRESHOLD = 50;
const CONSOLIDATION_LOOKBACK_DAYS = 30;
const PROJECT_RECEIPT_LIMIT = 120;
const MIN_STABLE_RECEIPTS = 2;

type ReceiptKind = "repo_receipt" | "deploy_receipt" | "artifact_receipt";

interface ParsedReceipt {
	id: string;
	type: ReceiptKind;
	created: string;
	status?: string;
	values: Record<string, string[]>;
}

function firstValue(receipt: ParsedReceipt, key: string): string | undefined {
	return receipt.values[key]?.[0];
}

function parseReceipt(observation: Observation): ParsedReceipt | null {
	if (!isReceiptKind(observation.type)) return null;
	const type = observation.type;
	const values: Record<string, string[]> = {};
	for (const rawLine of observation.content.split(/\r?\n/)) {
		const line = rawLine.trim();
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (!key || !value) continue;
		(values[key] ??= []).push(value);
	}
	return {
		id: observation.id,
		type,
		created: observation.created,
		status: firstString(values.status),
		values
	};
}

function isReceiptKind(value: unknown): value is ReceiptKind {
	return value === "repo_receipt" || value === "deploy_receipt" || value === "artifact_receipt";
}

function firstString(values: string[] | undefined): string | undefined {
	return values?.find(value => value.trim().length > 0);
}

function countValues(receipts: ParsedReceipt[], key: string, options?: { successOnly?: boolean }): Map<string, string[]> {
	const counts = new Map<string, string[]>();
	for (const receipt of receipts) {
		if (options?.successOnly && receipt.status && receipt.status !== "success") continue;
		for (const value of receipt.values[key] ?? []) {
			const clean = value.trim();
			if (!clean) continue;
			const ids = counts.get(clean) ?? [];
			ids.push(receipt.id);
			counts.set(clean, ids);
		}
	}
	return counts;
}

function strongest(counts: Map<string, string[]>): { value: string; ids: string[] } | undefined {
	return Array.from(counts.entries())
		.map(([value, ids]) => ({ value, ids }))
		.sort((a, b) => b.ids.length - a.ids.length || a.value.localeCompare(b.value))[0];
}

function routingValues(routing: ProjectWorkspaceRouting | undefined, key: "local_paths" | "artifact_roots" | "deploy_commands"): string[] {
	if (!routing) return [];
	if (key === "deploy_commands") return routing.deploy?.commands ?? [];
	return routing[key] ?? [];
}

function hasValue(values: string[], value: string | undefined): boolean {
	if (!value) return false;
	return values.some(item => item === value);
}

/**
 * A proposal this run wants to make, held until every candidate is collected.
 *
 * The scan used to check-and-write inline: one proposalExists round-trip per
 * candidate, per project. Collecting first lets the whole scan share ONE
 * batchProposalExists — the same shape skill-health already uses.
 */
interface ProjectProposalCandidate {
	type: DaemonProposalType;
	project: Entity;
	targetId: string;
	confidence: number;
	rationale: string;
	metadata: Record<string, unknown>;
}

/**
 * One existence check for every collected candidate, then one write per proposal
 * actually created. Preserves the inline behaviour exactly:
 *  - same proposals, same payloads, same creation order (insertion-ordered map);
 *  - a duplicate candidate within one run is created once. Inline, the first
 *    createProposal made the second proposalExists return true; here the dedupe
 *    map does it without the round-trip.
 */
async function createProjectProposals(
	storage: IBrainStorage,
	candidates: ProjectProposalCandidate[]
): Promise<number> {
	if (candidates.length === 0) return 0;

	const deduped = new Map<string, ProjectProposalCandidate>();
	for (const candidate of candidates) {
		const key = proposalKey(candidate.type, candidate.project.id, candidate.targetId);
		if (!deduped.has(key)) deduped.set(key, candidate);
	}

	const existing = await storage.batchProposalExists(
		[...deduped.values()].map(candidate => ({
			type: candidate.type,
			sourceId: candidate.project.id,
			targetId: candidate.targetId
		}))
	);

	let created = 0;
	for (const [key, candidate] of deduped) {
		if (existing.has(key)) continue;
		await storage.createProposal({
			tenant_id: storage.getTenant(),
			proposal_type: candidate.type,
			source_id: candidate.project.id,
			target_id: candidate.targetId,
			confidence: candidate.confidence,
			rationale: candidate.rationale,
			metadata: {
				project_entity_id: candidate.project.id,
				project_name: candidate.project.name,
				...candidate.metadata
			},
			status: "pending"
		});
		created++;
	}
	return created;
}

function taskLooksFileProducing(task: Task): boolean {
	const text = `${task.title}\n${task.description ?? ""}\n${task.source ?? ""}`.toLowerCase();
	return /\b(build|deploy|codegen|generate|export|write|patch|artifact|file|doc|deck|site|worker|package)\b/.test(text);
}

function taskHasArtifactPath(task: Task): boolean {
	return /artifact path:/i.test(task.completion_note ?? "");
}

// This scan used to cost ~2N+ round-trips for N projects: a getProjectDossier and
// a getEntityObservations each, plus a proposalExists per candidate proposal. At
// 200 projects that is 800-2000 subrequests against a ~1000 per-invocation
// ceiling that ALL tenants share — the largest single consumer in the nightly run.
// It is now four reads (entities, dossiers, observations, tasks) plus one
// existence check, plus one write per proposal actually created.
async function runProjectRoutingHygiene(storage: IBrainStorage, context: DaemonRunContext): Promise<number> {
	const projects = await storage.listEntities({ entity_type: "project", limit: 200 });
	if (projects.length === 0) return 0;

	// One read for every dossier instead of one per project. Both this and the
	// project scan are capped at 200, so a tenant past that cap sees the same
	// truncation the entity scan already imposed.
	const dossiers = await storage.listProjectDossiers({ limit: 200 });
	const dossierByProject = new Map(dossiers.map(dossier => [dossier.project_entity_id, dossier]));

	// One read for every project's receipts instead of one per project — the same
	// primitive the agent loop below already uses.
	const allProjectObs = context.arrivalBoundary
		? await storage.batchGetEntityObservations(projects.map(p => p.id), PROJECT_RECEIPT_LIMIT, context.arrivalBoundary)
		: await storage.batchGetEntityObservations(projects.map(p => p.id), PROJECT_RECEIPT_LIMIT);

	const candidates: ProjectProposalCandidate[] = [];

	for (const project of projects) {
		const dossier = dossierByProject.get(project.id);
		if (!dossier) continue;
		const routing = extractProjectWorkspaceRoutingFromMetadata(dossier.metadata);
		const entityObs = allProjectObs.get(project.id) ?? [];
		const receipts = entityObs
			.map(row => parseReceipt(row.observation))
			.filter((receipt): receipt is ParsedReceipt => Boolean(receipt));
		if (receipts.length === 0) continue;

		const localPath = strongest(countValues(receipts, "local_path", { successOnly: true }));
		if (localPath && localPath.ids.length >= MIN_STABLE_RECEIPTS) {
			const existing = routingValues(routing, "local_paths");
			if (existing.length === 0) {
				candidates.push({
					type: "project_routing_update",
					project,
					targetId: `local_path:${localPath.value}`,
					confidence: 0.82,
					rationale: `Project ${project.name} has ${localPath.ids.length} successful receipts pointing to local path ${localPath.value}; propose adding it to workspace_routing.local_paths.`,
					metadata: { field: "workspace_routing.local_paths", proposed_value: localPath.value, supporting_receipts: localPath.ids }
				});
			} else if (!hasValue(existing, localPath.value)) {
				candidates.push({
					type: "project_routing_drift",
					project,
					targetId: `local_path:${localPath.value}`,
					confidence: 0.86,
					rationale: `Project ${project.name} routing drift: dossier local paths (${existing.join(", ")}) disagree with repeated successful receipt path ${localPath.value}.`,
					metadata: { field: "workspace_routing.local_paths", dossier_values: existing, receipt_value: localPath.value, supporting_receipts: localPath.ids }
				});
			}
		}

		const artifactRoot = strongest(countValues(receipts, "artifact_path", { successOnly: true }));
		if (artifactRoot && artifactRoot.ids.length >= MIN_STABLE_RECEIPTS && routingValues(routing, "artifact_roots").length === 0) {
			const artifactDir = artifactRoot.value.includes("/") ? artifactRoot.value.replace(/\/[^/]*$/, "") : artifactRoot.value;
			candidates.push({
				type: "project_routing_update",
				project,
				targetId: `artifact_root:${artifactDir}`,
				confidence: 0.72,
				rationale: `Project ${project.name} has repeated artifact receipts under ${artifactDir}; propose adding an artifact root.`,
				metadata: { field: "workspace_routing.artifact_roots", proposed_value: artifactDir, supporting_receipts: artifactRoot.ids }
			});
		}

		const deployCommand = strongest(countValues(receipts, "deploy_command", { successOnly: true }));
		if (deployCommand && deployCommand.ids.length >= MIN_STABLE_RECEIPTS) {
			const existing = routingValues(routing, "deploy_commands");
			const proposalType: DaemonProposalType = existing.length > 0 && !hasValue(existing, deployCommand.value)
				? "stale_deploy_command"
				: "project_routing_update";
			if (existing.length === 0 || !hasValue(existing, deployCommand.value)) {
				candidates.push({
					type: proposalType,
					project,
					targetId: `deploy_command:${deployCommand.value}`,
					confidence: proposalType === "stale_deploy_command" ? 0.84 : 0.78,
					rationale: proposalType === "stale_deploy_command"
						? `Project ${project.name} dossier deploy command may be stale; repeated successful receipts use ${deployCommand.value}.`
						: `Project ${project.name} has repeated successful deploy receipts using ${deployCommand.value}; propose adding it to routing metadata.`,
					metadata: { field: "workspace_routing.deploy.commands", dossier_values: existing, proposed_value: deployCommand.value, supporting_receipts: deployCommand.ids }
				});
			}
		}
	}

	const changedTasks = context.arrivalBoundary && typeof storage.listTaskChangesSince === "function"
		? await storage.listTaskChangesSince(context.arrivalBoundary, 200, true)
		: await storage.listTasks("done", undefined, 200, true);
	const doneTasks = changedTasks.filter(task => task.status === "done");
	for (const task of doneTasks) {
		if (!taskLooksFileProducing(task) || taskHasArtifactPath(task)) continue;
		const projectId = (task.linked_entity_ids ?? [])[0];
		if (!projectId) continue;
		const project = projects.find(item => item.id === projectId);
		if (!project) continue;
		candidates.push({
			type: "missing_artifact_receipt",
			project,
			targetId: `task:${task.id}`,
			confidence: 0.74,
			rationale: `File-producing task "${task.title}" is done but has no artifact_path receipt.`,
			metadata: { task_id: task.id, task_title: task.title, completed_at: task.completed_at, completion_note: task.completion_note }
		});
	}

	return createProjectProposals(storage, candidates);
}

export async function runKitHygieneTask(storage: IBrainStorage, context: DaemonRunContext = {}): Promise<DaemonTaskResult> {
	let proposals_created = 0;

	// Get all agent entities for this tenant
	const agentEntities = await storage.listEntities({ entity_type: "agent", limit: 200 });

	if (agentEntities.length === 0) {
		proposals_created += await runProjectRoutingHygiene(storage, context);
		return { task: "kit-hygiene", changes: 0, proposals_created };
	}

	const cutoffDate = new Date(Date.now() - CONSOLIDATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

	// Hoist listProposals — avoids one DB call per agent hitting the total threshold.
	// Only track source_ids with accepted consolidations within the lookback window.
	const recentConsolidations = await storage.listProposals("consolidation", "accepted", 200);
	const consolidatedSourceIds = new Set(
		recentConsolidations.filter(p => p.proposed_at >= cutoffDate).map(p => p.source_id)
	);

	const agentIds = agentEntities.map(a => a.id);

	// Consolidation thresholds are corpus properties, not dailies properties —
	// kept global and SQL-side via countEntityObservations() where available.
	// batchGetEntityObservations(...,200) is the fallback bounded inventory for a
	// compatibility mock/backend with no count primitive (dedup used to need a
	// SECOND, recency-bound fetch here too — moved to daemon/tasks/dedup.ts,
	// §6.1 — so this is back down to the one fetch consolidation actually needs).
	let corpusCounts: Map<string, { total: number; metabolized: number }> | undefined;
	let corpusObs: Map<string, { observation: Observation; territory: string }[]> | undefined;
	if (context.arrivalBoundary && typeof storage.countEntityObservations === "function") {
		corpusCounts = await storage.countEntityObservations(agentIds);
	} else {
		corpusObs = await storage.batchGetEntityObservations(agentIds, 200);
	}

	// Batch-check all consolidation proposals upfront (all share the same source=target=agent.id pattern)
	const consolidationChecks = agentIds.map(id => ({ type: "consolidation", sourceId: id, targetId: id }));
	const existingConsolidations = await storage.batchProposalExists(consolidationChecks);

	for (const agent of agentEntities) {
		const entityObs = corpusObs?.get(agent.id) ?? [];

		if ((corpusCounts?.get(agent.id)?.total ?? entityObs.length) === 0) continue;

		const observations = entityObs.map(r => r.observation);

		// Count by charge_phase
		const counts = corpusCounts?.get(agent.id);
		const metabolizedCount = counts?.metabolized ?? observations.filter(obs => obs.texture?.charge_phase === "metabolized").length;
		const totalCount = counts?.total ?? observations.length;

		const consolidationKey = proposalKey("consolidation", agent.id, agent.id);

		// (a) High metabolized count → propose archival consolidation
		if (metabolizedCount > METABOLIZED_THRESHOLD) {
			if (!existingConsolidations.has(consolidationKey)) {
				await storage.createProposal({
					tenant_id: storage.getTenant(),
					proposal_type: "consolidation",
					source_id: agent.id,
					target_id: agent.id,
					confidence: 0.85,
					rationale: `Agent ${agent.name} has ${metabolizedCount} metabolized observations ready for archival`,
					metadata: { agent_id: agent.id, agent_name: agent.name, metabolized_count: metabolizedCount },
					status: "pending"
				});
				proposals_created++;
			}
		}
		// (b) High total count without recent consolidation → propose consolidation
		else if (totalCount > TOTAL_THRESHOLD) {
			// Use pre-fetched consolidation set — avoids a DB call per agent
			const hasRecentConsolidation = consolidatedSourceIds.has(agent.id);

			if (!hasRecentConsolidation) {
				if (!existingConsolidations.has(consolidationKey)) {
					await storage.createProposal({
						tenant_id: storage.getTenant(),
						proposal_type: "consolidation",
						source_id: agent.id,
						target_id: agent.id,
						confidence: 0.75,
						rationale: `Agent ${agent.name} has ${totalCount} total observations, needs consolidation`,
						metadata: { agent_id: agent.id, agent_name: agent.name, total_count: totalCount },
						status: "pending"
					});
					proposals_created++;
				}
			}
		}
	}

	proposals_created += await runProjectRoutingHygiene(storage, context);

	return { task: "kit-hygiene", changes: 0, proposals_created };
}
