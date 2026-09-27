// ============ PROPOSE TOOL (v2) ============
// mind_propose — review and manage daemon-generated proposals.
// action=list: list pending proposals (filterable by type, including skill lifecycle proposals)
// action=review: accept or reject. Accept + link → create bidirectional link.
//   Accept + orphan_rescue + archive → metabolize + update orphan status.
//   Accept + orphan_rescue (rescue) → create link + update orphan status.
//   Accept + dedup → create "duplicate" link + metabolize the newer observation.
//   Accept + consolidation → create skill observation, metabolize sources, accept candidate.
// action=stats: return proposal statistics

import { generateId, getTimestamp, toStringArray } from "../helpers";
import { RESONANCE_TYPES } from "../constants";
import type { DaemonProposalType, Link, Observation } from "../types";
import type { ToolContext } from "./context";
import { createParadoxLoop } from "./connections";

// cross_agent's accept branch matches its own staged ConsolidationCandidate by
// exact source_observation_ids set (see the branch below). Only cross-agent.ts
// ever creates one, so this pool doesn't need to be as large as a corpus scan —
// wide enough that a real backlog doesn't hide the match, no wider than that.
const CONSOLIDATION_CANDIDATE_SCAN_LIMIT = 200;

const PROPOSAL_TYPES: DaemonProposalType[] = [
	"link",
	"orphan_rescue",
	"consolidation",
	"dedup",
	"salience_regrade",
	"cross_agent",
	"cross_tenant",
	"paradox_detected",
	"skill_recapture",
	"skill_supersession",
	"skill_promotion",
	"recall_contract",
	"fact_commitment",
	"project_routing_update",
	"project_routing_drift",
	"missing_artifact_receipt",
	"stale_deploy_command",
	"path_alias_conflict"
];

export const TOOL_DEFS = [
	{
		name: "mind_propose",
		description: "Review and manage daemon-generated proposals. action=list: see pending proposals (types: link, orphan_rescue, consolidation, dedup, salience_regrade, cross_agent, cross_tenant, paradox_detected, skill_recapture, skill_supersession, skill_promotion, recall_contract, fact_commitment, project_routing_update, project_routing_drift, missing_artifact_receipt, stale_deploy_command, path_alias_conflict). action=review: accept or reject a proposal (link → bidirectional link; orphan_rescue → rescue or archive; dedup → duplicate link + metabolize the newer side, never merged; consolidation → skill observation + metabolize sources; salience_regrade → demote foundational to active, unless still in shadow mode). action=stats: acceptance statistics.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["list", "review", "stats"],
					description: "list: view proposals. review: accept/reject. stats: acceptance statistics."
				},
				// list params
				type: {
					type: "string",
					enum: PROPOSAL_TYPES,
					description: "[list] Filter by proposal type"
				},
				status: {
					type: "string",
					enum: ["pending", "accepted", "rejected"],
					description: "[list] Filter by status. Defaults to 'pending'."
				},
				limit: {
					type: "number",
					default: 20,
					description: "[list] Max proposals to return"
				},
				// review params
				proposal_id: {
					type: "string",
					description: "[review] ID of the proposal to review"
				},
				decision: {
					type: "string",
					enum: ["accepted", "rejected"],
					description: "[review] Accept or reject the proposal"
				},
				feedback_note: {
					type: "string",
					description: "[review] Optional note on the decision"
				},
				resonance_type: {
					type: "string",
					description: "[review] Override resonance_type for accepted link proposals"
				}
			},
			required: ["action"]
		}
	}
];

export async function handleTool(name: string, args: any, context: ToolContext): Promise<any> {
	const storage = context.storage;

	switch (name) {
		case "mind_propose": {
			const action = args.action;

			// --- list ---
			if (action === "list") {
				const status = args.status ?? "pending";
				const type = args.type ?? undefined;
				const limit = Math.min(args.limit ?? 20, 100);

				const proposals = await storage.listProposals(type, status, limit);
				return {
					total: proposals.length,
					proposals: proposals.map(p => ({
						id: p.id,
						type: p.proposal_type,
						source_id: p.source_id,
						target_id: p.target_id,
						confidence: Math.round(p.confidence * 100) / 100,
						similarity: p.similarity !== undefined ? Math.round(p.similarity * 100) / 100 : undefined,
						rationale: p.rationale,
						metadata: p.metadata,
						status: p.status,
						proposed_at: p.proposed_at
					}))
				};
			}

			// --- review ---
			if (action === "review") {
				if (!args.proposal_id) {
					return { error: "proposal_id is required for action=review" };
				}
				if (!args.decision || !["accepted", "rejected"].includes(args.decision)) {
					return { error: "decision must be 'accepted' or 'rejected'" };
				}

				// Fix 5: cap feedback_note to 1000 characters
				if (args.feedback_note && args.feedback_note.length > 1000) {
					return { error: "feedback_note must be 1000 characters or fewer" };
				}

				// Fix 8: direct PK lookup instead of loading 200 rows to find one
				const proposal = await storage.getProposalById(args.proposal_id);
				if (!proposal || proposal.status !== "pending") {
					return { error: `Proposal ${args.proposal_id} not found or not in pending state` };
				}

				// Validate IDs contain only safe characters
				if (!/^[a-zA-Z0-9_-]+$/.test(proposal.source_id) || !/^[a-zA-Z0-9_-]+$/.test(proposal.target_id)) {
					return { error: "Invalid observation IDs in proposal" };
				}

				// ops/ADR-JANITOR.md §5.0, §5.5 (commit 7b) — this is now a DEAD-MAN'S
				// SWITCH, not a mode gate. Before commit 7b, the daemon task itself
				// created a real pending proposal for every candidate under shadow
				// (tagged metadata.shadow: true) and this block was the ONLY thing
				// stopping an accidental accept — the mode gate. Commit 7b moved the
				// gate upstream: shadow mode now creates zero salience_regrade rows in
				// the first place (daemon/tasks/salience-regrade.ts), so a proposal
				// reaching this branch with metadata.shadow === true can only be one
				// created by a pre-fix version of the daemon still sitting in the
				// queue. Left byte-identical (:149-157) rather than removed — it costs
				// nothing to keep and it is the only thing standing between an old
				// shadow-tagged row and an accidental accept until that backlog is
				// cleared. Rejection remains always allowed, shadow tag or not — safe
				// and permanent by design (§5.5).
				if (
					proposal.proposal_type === "salience_regrade" &&
					args.decision === "accepted" &&
					(proposal.metadata as Record<string, unknown> | undefined)?.shadow === true
				) {
					return {
						error: "salience_regrade proposal is in shadow mode — accept is disabled until an operator sets daemon_config.data.salience_regrade_shadow to false. Rejection is still allowed."
					};
				}

				const reviewed = await storage.reviewProposal(
					args.proposal_id,
					args.decision,
					args.feedback_note
				);

				if (args.decision === "accepted") {
					// --- link proposal: create bidirectional link ---
					if (proposal.proposal_type === "link") {
						const resonanceType = args.resonance_type ?? proposal.resonance_type ?? "semantic";

						// Fix 4: validate resonance_type against the allowlist
						if (!RESONANCE_TYPES.includes(resonanceType)) {
							return { error: `Invalid resonance_type '${resonanceType}'. Must be one of: ${RESONANCE_TYPES.join(", ")}` };
						}
						const now = getTimestamp();

						const fwdLink: Link = {
							id: generateId("link"),
							source_id: proposal.source_id,
							target_id: proposal.target_id,
							resonance_type: resonanceType,
							strength: "present",
							origin: "daemon",
							created: now,
							last_activated: now
						};
						const revLink: Link = {
							id: generateId("link"),
							source_id: proposal.target_id,
							target_id: proposal.source_id,
							resonance_type: resonanceType,
							strength: "present",
							origin: "daemon",
							created: now,
							last_activated: now
						};

						await Promise.all([
							storage.appendLink(fwdLink),
							storage.appendLink(revLink)
						]);

						return {
							reviewed: true,
							decision: "accepted",
							proposal_id: reviewed.id,
							action_taken: "created_bidirectional_link",
							link_ids: [fwdLink.id, revLink.id]
						};
					}

					// --- orphan_rescue proposal ---
					if (proposal.proposal_type === "orphan_rescue") {
						const meta = proposal.metadata as Record<string, unknown>;

						if (meta.action === "archive") {
							// Metabolize the observation + update orphan status
							const found = await storage.findObservation(proposal.source_id);
							if (found) {
								const texture = { ...found.observation.texture, charge_phase: "metabolized" as const };
								await storage.updateObservationTexture(proposal.source_id, texture);
							}
							await storage.updateOrphanStatus(proposal.source_id, "archived");

							return {
								reviewed: true,
								decision: "accepted",
								proposal_id: reviewed.id,
								action_taken: "metabolized_and_archived_orphan",
								observation_id: proposal.source_id
							};
						} else {
							// Rescue: create link between orphan and its rescuer + update orphan status
							const now = getTimestamp();
							const fwdLink: Link = {
								id: generateId("link"),
								source_id: proposal.source_id,
								target_id: proposal.target_id,
								resonance_type: "semantic",
								strength: "present",
								origin: "daemon",
								created: now,
								last_activated: now
							};
							const revLink: Link = {
								id: generateId("link"),
								source_id: proposal.target_id,
								target_id: proposal.source_id,
								resonance_type: "semantic",
								strength: "present",
								origin: "daemon",
								created: now,
								last_activated: now
							};

							await Promise.all([
								storage.appendLink(fwdLink),
								storage.appendLink(revLink),
								storage.updateOrphanStatus(proposal.source_id, "rescued")
							]);

							return {
								reviewed: true,
								decision: "accepted",
								proposal_id: reviewed.id,
								action_taken: "rescued_orphan",
								observation_id: proposal.source_id,
								linked_to: proposal.target_id,
								link_ids: [fwdLink.id, revLink.id]
							};
						}
					}

					// --- dedup proposal: link the pair, metabolize the newer side ---
					// ops/ADR-JANITOR.md §6.4 — dedup never merges. Nothing is deleted and
					// both copies stay fully retrievable; the newer one just ranks lower
					// from here on (scoring.ts's metabolized damping). resonance_type is
					// fixed at "duplicate" — unlike the "link" branch above, there is no
					// args.resonance_type override for this proposal type.
					if (proposal.proposal_type === "dedup") {
						const [sourceFound, targetFound] = await Promise.all([
							storage.findObservation(proposal.source_id),
							storage.findObservation(proposal.target_id)
						]);

						if (!sourceFound || !targetFound) {
							return {
								reviewed: true,
								decision: "accepted",
								proposal_id: reviewed.id,
								action_taken: "observation_not_found"
							};
						}

						const now = getTimestamp();
						const fwdLink: Link = {
							id: generateId("link"),
							source_id: proposal.source_id,
							target_id: proposal.target_id,
							resonance_type: "duplicate",
							strength: "present",
							origin: "daemon",
							created: now,
							last_activated: now
						};
						const revLink: Link = {
							id: generateId("link"),
							source_id: proposal.target_id,
							target_id: proposal.source_id,
							resonance_type: "duplicate",
							strength: "present",
							origin: "daemon",
							created: now,
							last_activated: now
						};

						// "Newer" by created timestamp (ISO 8601 — lexicographic order is
						// chronological order, same comparison kit-hygiene.ts already relies
						// on for proposed_at). The older observation is treated as the
						// canonical copy.
						const newer = sourceFound.observation.created >= targetFound.observation.created
							? sourceFound.observation
							: targetFound.observation;
						const texture = { ...newer.texture, charge_phase: "metabolized" as const };

						await Promise.all([
							storage.appendLink(fwdLink),
							storage.appendLink(revLink),
							storage.updateObservationTexture(newer.id, texture)
						]);

						return {
							reviewed: true,
							decision: "accepted",
							proposal_id: reviewed.id,
							action_taken: "linked_duplicate_and_metabolized_newer",
							link_ids: [fwdLink.id, revLink.id],
							metabolized_observation_id: newer.id
						};
					}

					// --- salience_regrade proposal: demote foundational to active ---
					// ops/ADR-JANITOR.md §5.2 — one step, never two ("foundational" ->
					// "active"; never straight to "background"). The shadow-mode check
					// above already returned before reviewProposal() ran if this branch
					// would otherwise be a no-op, so reaching here means it's safe to apply.
					if (proposal.proposal_type === "salience_regrade") {
						const found = await storage.findObservation(proposal.source_id);
						if (found) {
							const texture = { ...found.observation.texture, salience: "active" };
							await storage.updateObservationTexture(proposal.source_id, texture);
						}

						return {
							reviewed: true,
							decision: "accepted",
							proposal_id: reviewed.id,
							action_taken: found ? "demoted_to_active" : "observation_not_found",
							observation_id: proposal.source_id
						};
					}

					// --- paradox_detected proposal: create the burning paradox loop ---
					// The proposal's stated purpose (paradox-detection.ts:5-6, "propose a
					// paradox loop") — accept is the only place that purpose is realized.
					// Never AI-reviewed (ai-review.ts's gatherCandidates never fetches this
					// type) and never absorbed (no automatic accept path exists anywhere,
					// same non-negotiable as salience_regrade/dedup above).
					//
					// source_id === target_id === the single identity core the detector
					// found (paradox-detection.ts) — the detector structurally cannot name
					// a counter-core, so linked_entity_ids here is deliberately ONE element,
					// not the two mind_loop action=paradox normally requires. Do not invent
					// a second core to satisfy that gate; createParadoxLoop (connections.ts)
					// is the shared creation path with no such minimum. A tension whose
					// other half isn't named yet is the thing worth sitting with.
					if (proposal.proposal_type === "paradox_detected") {
						const cores = await storage.readIdentityCores();
						const core = cores.find(c => c.id === proposal.source_id);

						if (!core) {
							return {
								reviewed: true,
								decision: "accepted",
								proposal_id: reviewed.id,
								action_taken: "core_not_found"
							};
						}

						const loop = await createParadoxLoop(storage, {
							content: proposal.rationale ?? `Paradox: identity core "${core.name}" carries unresolved tension — counter-core not yet named.`,
							linked_entity_ids: [core.id],
							status: "burning"
						});

						return {
							reviewed: true,
							decision: "accepted",
							proposal_id: reviewed.id,
							action_taken: "created_paradox_loop",
							loop_id: loop.id
						};
					}

					// --- cross_agent proposal: realize the synthesis the daemon already staged ---
					// cross-agent.ts (daemon/tasks/cross-agent.ts) creates BOTH a pending
					// ConsolidationCandidate (suggested_type: "synthesis") and this proposal
					// in the same loop iteration, from the same sourceObsIds — the candidate
					// is the daemon's own draft of what accept should do; nothing here
					// invents it. Same source_id === target_id shape as paradox_detected
					// (both equal the converged entity, metadata.target_entity_id) — the
					// real per-agent observation IDs live only in metadata.agents[].obs_id.
					//
					// Unlike "consolidation" above (kit-hygiene.ts: one agent's OWN history,
					// archived into a fresh skill), the contributing observations here
					// belong to DIFFERENT agents who each independently reached a related
					// finding. Metabolizing them on accept would erase one agent's memory of
					// their own finding merely because another agent noticed something
					// similar — that is not what convergence means, so the sources are left
					// exactly as live as they were. The new observation records the
					// convergence itself; source_observations is its provenance
					// (Observation.source_observations — documented for exactly this:
					// "provenance for synthesis/consolidation observations").
					//
					// Never AI-reviewed (ai-review.ts's gatherCandidates never fetches this
					// type) and never absorbed (absorption.ts has no branch for it).
					if (proposal.proposal_type === "cross_agent") {
						const meta = (proposal.metadata ?? {}) as Record<string, unknown>;
						const agentsMeta = Array.isArray(meta.agents) ? (meta.agents as Array<Record<string, unknown>>) : [];
						const obsIds = agentsMeta
							.map(a => (typeof a.obs_id === "string" ? a.obs_id : undefined))
							.filter((id): id is string => Boolean(id));

						// The daemon task only ever proposes cross_agent with 2+ converging
						// agents (cross-agent.ts:73: `if (agentsSeen.size < 2) continue`) — a
						// proposal with fewer than 2 real obs IDs here means the metadata was
						// hand-edited or corrupted, not a legitimate convergence.
						if (obsIds.length < 2) {
							return {
								reviewed: true,
								decision: "accepted",
								proposal_id: reviewed.id,
								action_taken: "invalid_metadata"
							};
						}

						const targetEntityId = typeof meta.target_entity_id === "string" ? meta.target_entity_id : proposal.source_id;
						const agentNames = agentsMeta
							.map(a => (typeof a.agent_name === "string" ? a.agent_name : undefined))
							.filter((n): n is string => Boolean(n));

						// Close the loop on the daemon's own staged candidate, matched by
						// exact source_observation_ids set — the only field both records
						// share, since cross-agent.ts builds them from the same sourceObsIds
						// in the same iteration. Not found is not an error: the candidate is
						// a convenience cross-reference, not a dependency — nothing below
						// requires it to exist.
						const candidates = await storage.listConsolidationCandidates("pending", CONSOLIDATION_CANDIDATE_SCAN_LIMIT);
						const obsIdSet = new Set(obsIds);
						const matchedCandidate = candidates.find(c =>
							c.source_observation_ids.length === obsIdSet.size &&
							c.source_observation_ids.every(id => obsIdSet.has(id))
						);
						if (matchedCandidate) {
							await storage.reviewConsolidationCandidate(matchedCandidate.id, "accepted");
						}

						const now = getTimestamp();
						const synthesisObs: Observation = {
							id: generateId("obs"),
							content: matchedCandidate?.pattern_description
								?? proposal.rationale
								?? `${agentNames.join(", ")} independently converged on entity ${targetEntityId}`,
							territory: "craft",
							created: now,
							texture: {
								salience: "active",
								vividness: "vivid",
								charge: [],
								grip: "present",
								charge_phase: "fresh"
							},
							context: `Cross-agent synthesis from proposal ${proposal.id}`,
							access_count: 0,
							type: "synthesis",
							entity_id: targetEntityId,
							source_observations: obsIds
						};

						await storage.appendToTerritory("craft", synthesisObs);

						return {
							reviewed: true,
							decision: "accepted",
							proposal_id: reviewed.id,
							action_taken: "created_synthesis_observation",
							synthesis_observation_id: synthesisObs.id,
							entity_id: targetEntityId,
							contributing_observation_ids: obsIds,
							candidate_id: matchedCandidate?.id
						};
					}

					// --- cross_tenant proposal: deliberately NO accept branch ---
					// cross-tenant.ts's source_id/target_id are two real observation IDs,
					// one per tenant — structurally the same shape "link" and "dedup" use,
					// and the honest accept action that shape implies is the same one they
					// take: a bidirectional link. But making that link genuinely
					// bidirectional (so BOTH tenants can surface the convergence, which is
					// the entire point of "convergence") means writing the reverse link
					// into the OTHER tenant's storage via forTenant() — a write into
					// another tenant's data. ADR-JANITOR.md §8's "never automatic" list,
					// item 5, names "any cross-tenant action" as the sovereignty boundary;
					// a human-reviewed accept is not the same thing as an automatic one,
					// but building the write anyway would still be inferring a
					// cross-tenant-write design decision from the proposal's shape instead
					// of getting one. Left unresolved on purpose — accept and reject both
					// fall through to the generic tombstone below (action_taken: "none" on
					// accept, same as before this commit). Whether the right call is a
					// same-tenant-only action instead (e.g. a task, like
					// recall_contract/fact_commitment below) or the cross-tenant write with
					// Eli's sign-off is Falco's and Eli's call, not mine.
					//
					// Never AI-reviewed and never absorbed, same as cross_agent above.

					// --- consolidation proposal: create skill obs, metabolize sources ---
					if (proposal.proposal_type === "consolidation") {
						const meta = proposal.metadata as Record<string, unknown>;
						const agentId = meta.agent_id as string | undefined;

						// Find pending consolidation candidates linked to this agent
						const candidates = await storage.listConsolidationCandidates("pending", 10);
						const agentCandidates = agentId
							? candidates.filter(c => {
								// Candidates created by kit-hygiene store agent obs IDs.
								// Cross-agent candidates store obs from multiple agents.
								// We match on any candidate whose pattern_description mentions the agent.
								return c.pattern_description.includes(agentId) || c.pattern_description.includes(meta.agent_name as string ?? "");
							})
							: candidates;

						const candidate = agentCandidates[0]; // Take the first matching candidate
						let sourceObsIds: string[] = [];
						let candidateId: string | undefined;

						if (candidate) {
							sourceObsIds = candidate.source_observation_ids;
							candidateId = candidate.id;
							await storage.reviewConsolidationCandidate(candidate.id, "accepted");
						}

						// Mark source observations as metabolized
						const metabolized: string[] = [];
						for (const obsId of sourceObsIds) {
							const found = await storage.findObservation(obsId);
							if (found) {
								const texture = { ...found.observation.texture, charge_phase: "metabolized" as const };
								await storage.updateObservationTexture(obsId, texture);
								metabolized.push(obsId);
							}
						}

						// Create skill observation for the agent
						const now = getTimestamp();
						const agentName = (meta.agent_name as string) ?? "unknown agent";
						const skillObs: Observation = {
							id: generateId("obs"),
							content: `Skill distilled from ${metabolized.length} observations by ${agentName}. Pattern: ${candidate?.pattern_description ?? proposal.rationale ?? "consolidation"}`,
							territory: "craft",
							created: now,
							texture: {
								salience: "active",
								vividness: "vivid",
								charge: [],
								grip: "present",
								charge_phase: "fresh"
							},
							access_count: 0,
							type: "skill",
							...(agentId ? { entity_id: agentId } : {})
						};

						await storage.appendToTerritory("craft", skillObs);

						const capturedSkill = await storage.createCapturedSkillArtifact({
							skill_key: buildDerivedSkillKey(storage.getTenant(), agentName, candidateId ?? proposal.id),
							layer: "derived",
							status: "candidate",
							name: `Consolidated learning: ${agentName}`,
							domain: "agent-learning",
							task_type: "consolidation",
							agent_tenant: storage.getTenant(),
							source_observation_id: skillObs.id,
							provenance: {
								proposal_id: proposal.id,
								consolidation_candidate_id: candidateId,
								source_observation_ids: sourceObsIds,
								metabolized_observation_ids: metabolized
							},
							metadata: {
								agent_entity_id: agentId,
								agent_name: agentName,
								pattern_description: candidate?.pattern_description,
								rationale: proposal.rationale,
								review_gate: "candidate_requires_mind_skill_review"
							}
						});

						// Update the agent entity's primary_context if we have an agent ID
						if (agentId) {
							await storage.updateEntity(agentId, {
								primary_context: `Last skill distilled: ${now.slice(0, 10)} (${metabolized.length} observations consolidated)`
							});
						}

						return {
							reviewed: true,
							decision: "accepted",
							proposal_id: reviewed.id,
							action_taken: "created_skill_observation_and_candidate_artifact",
							skill_observation_id: skillObs.id,
							captured_skill_id: capturedSkill.id,
							captured_skill_status: capturedSkill.status,
							metabolized_count: metabolized.length,
							metabolized_ids: metabolized,
							candidate_id: candidateId
						};
					}

					// --- recall/fact commitment proposals: review-gated task materialization ---
					if (proposal.proposal_type === "recall_contract" || proposal.proposal_type === "fact_commitment") {
						const metadata = (proposal.metadata ?? {}) as Record<string, unknown>;
						const title = typeof metadata.title === "string" ? metadata.title.trim() : "Review follow-up";
						const description = typeof metadata.description === "string"
							? metadata.description
							: (typeof proposal.rationale === "string" ? proposal.rationale : undefined);
						const priority = normalizeTaskPriority(metadata.priority);
						const source = typeof metadata.source === "string"
							? metadata.source
							: (proposal.proposal_type === "recall_contract" ? "recall_contract" : "fact_commitment_bridge");
						const linkedEntityIds = toStringArray(metadata.linked_entity_ids);
						const linkedObservationIds = toStringArray(metadata.linked_observation_ids);

						const task = await storage.createTask({
							title: title.length > 0 ? title.slice(0, 200) : "Review follow-up",
							description,
							status: "open",
							priority: priority ?? (proposal.proposal_type === "fact_commitment" ? "high" : "normal"),
							source,
							linked_entity_ids: linkedEntityIds,
							linked_observation_ids: linkedObservationIds
						});

						return {
							reviewed: true,
							decision: "accepted",
							proposal_id: reviewed.id,
							action_taken: "created_task",
							proposal_type: proposal.proposal_type,
							task_id: task.id,
							task
						};
					}
				}

				// Rejection or unknown type — just return the reviewed status
				return {
					reviewed: true,
					decision: args.decision,
					proposal_id: reviewed.id,
					action_taken: args.decision === "rejected" ? "rejected" : "none"
				};
			}

			// --- stats ---
			if (action === "stats") {
				const [stats, config] = await Promise.all([
					storage.getProposalStats(),
					storage.readDaemonConfig()
				]);

				return {
					current_threshold: config.link_proposal_threshold,
					last_threshold_update: config.last_threshold_update,
					stats_by_type: stats
				};
			}

			return { error: `Unknown action: ${action}. Must be list, review, or stats.` };
		}

		default:
			throw new Error(`Unknown propose tool: ${name}`);
	}
}

function buildDerivedSkillKey(tenant: string, agentName: string, sourceId: string): string {
	const slug = `${agentName}-${sourceId}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return `derived:${tenant}:${slug || "agent-consolidation"}`;
}


function normalizeTaskPriority(value: unknown): "burning" | "high" | "normal" | "low" | "someday" | undefined {
	if (typeof value !== "string") return undefined;
	return ["burning", "high", "normal", "low", "someday"].includes(value)
		? value as "burning" | "high" | "normal" | "low" | "someday"
		: undefined;
}
