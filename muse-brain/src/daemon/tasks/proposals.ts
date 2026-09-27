// ============ DAEMON TASK: LINK PROPOSAL GENERATION ============
// Generates link proposals from vector similarity between fresh/active observations.
//
// Confidence formula (ops/ADR-JANITOR.md §3, §9 commit 5):
//   confidence = min(1, similarity + CHARGE_BONUS * chargeRatio)
// Similarity is the ONLY creation gate (see the `candidate.similarity < threshold`
// check below); charge overlap can only ever raise confidence above similarity,
// never substitute for it. The previous formula blended similarity/charge/entity
// as independently config-tunable weights and re-gated that blend against the
// SAME threshold with a *different* quantity — at zero charge overlap, max
// reachable confidence was 0.6 (default similarity_weight), so nothing could
// ever clear a threshold above 0.6. A control loop (learning.ts) spent five
// weeks raising that unreachable threshold to its 0.95 ceiling chasing a
// formula that could never satisfy it (§0.3 — CONFIRMED on the live tenant:
// current_threshold 0.95, pinned since 2026-07-30T03:00:53Z).
//
// tenant-tunable charge_weight/similarity_weight/entity_weight
// (daemon_config.data, still echoed read-only by mind_health/health.ts) no
// longer feed this calculation. Flagged, not fixed, here — out of scope for
// this commit (ops/ADR-JANITOR.md §9 row 5 names proposals.ts only).
//
// *** MANDATORY RUNBOOK STEP — this fix is INERT without it ***
// The live `link_proposal_threshold` sits at 0.95. This formula change alone
// creates ZERO proposals while it stays there: similarity tops out at 1.0,
// and the highest cosine ever observed on this corpus is 0.802
// (ADR-RETRIEVAL-FUSION-RETUNE §0) — both are below 0.95. A one-time
// `updateProposalThreshold(0.75)` call against the live tenant's
// daemon_config is required to reset it. That is a live DATA correction, not
// a code change, and does not ship in this commit. Do not consider commit 5
// "done" — in the sense of actually creating link proposals again — until
// that call has run. (ops/ADR-JANITOR.md §0.3: this exact class of
// threshold-in-a-comment-and-a-ticket sat railed for five weeks last time.)

import type { IBrainStorage } from "../../storage/interface";
import type { DaemonTaskResult } from "../types";

const BATCH_SIZE = 50;
/** ops/ADR-JANITOR.md §3 — charge overlap's bonus weight; never a gate. */
const CHARGE_BONUS = 0.1;

export async function runProposalTask(storage: IBrainStorage): Promise<DaemonTaskResult> {
	let proposals_created = 0;

	const expired = await storage.expireStaleProposals(30);
	if (expired > 0) console.log(`Proposals: auto-expired ${expired} stale pending proposal(s)`);

	// Read config: threshold only — see header comment on why the tenant-tunable
	// weights formerly read from config.data no longer drive the formula.
	const config = await storage.readDaemonConfig();
	const threshold = config.link_proposal_threshold;

	// Query recent observations (batch of 50)
	const candidates = await storage.queryObservations({
		limit: BATCH_SIZE,
		order_by: "created",
		order_dir: "desc"
	});

	// Filter to non-metabolized observations — fresh, active, and processing are all
	// valid for link discovery. The narrow fresh/active window (~1 hour / ~1 day)
	// combined with async embedding backfill means most observations get embeddings
	// AFTER being decayed to "processing". findSimilarUnlinked already excludes
	// existing links and pending proposals, so no wasted work.
	const eligible = candidates.filter(({ observation: obs }) => {
		const phase = obs.texture?.charge_phase;
		return phase !== "metabolized";
	});

	console.log(`Proposals: ${candidates.length} candidates, ${eligible.length} eligible (non-metabolized)`);

	for (const { observation: source } of eligible) {
		// Find top 5 similar unlinked observations
		const similar = await storage.findSimilarUnlinked(source.id, 5);

		if (similar.length === 0) continue;
		console.log(`Proposals: source ${source.id.slice(0, 8)} found ${similar.length} similar (best: ${Math.round(similar[0].similarity * 100)}%)`);

		for (const candidate of similar) {
			// Filter by threshold (findSimilarUnlinked already excludes pending proposals via CTE)
			if (candidate.similarity < threshold) continue;

			// Compute shared charges
			const sourceCharges = new Set(source.texture?.charge ?? []);
			const candidateCharges = candidate.observation.texture?.charge ?? [];
			let sharedCharges = 0;
			for (const c of candidateCharges) {
				if (sourceCharges.has(c)) sharedCharges++;
			}
			const maxCharges = Math.max(sourceCharges.size, candidateCharges.length, 1);
			const chargeRatio = sharedCharges / maxCharges;

			// Compute shared entity flag
			const sharedEntity =
				source.entity_id != null &&
				candidate.observation.entity_id != null &&
				source.entity_id === candidate.observation.entity_id;

			// Confidence: similarity is the only gate (already passed, above).
			// Charge overlap is a bonus that can raise confidence above
			// similarity — e.g. into absorption.ts's auto-link band — but can
			// never substitute for similarity in deciding whether to create a
			// proposal at all (ops/ADR-JANITOR.md §3).
			const confidence = Math.min(1, candidate.similarity + CHARGE_BONUS * chargeRatio);

			await storage.createProposal({
				tenant_id: storage.getTenant(),
				proposal_type: "link",
				source_id: source.id,
				target_id: candidate.observation.id,
				similarity: candidate.similarity,
				resonance_type: "semantic",   // Default resonance for vector-similarity links; reviewer can adjust
				confidence,
				rationale: `Vector similarity ${Math.round(candidate.similarity * 100)}%, shared charges ${sharedCharges}/${maxCharges}`,
				metadata: {
					shared_charges: sharedCharges,
					charge_ratio: chargeRatio,
					shared_entity: sharedEntity
				},
				status: "pending"
			});
			proposals_created++;
		}
	}

	return { task: "proposals", changes: 0, proposals_created };
}
