// ============ WORKERS AI PROPOSAL REVIEWER ============
// Auto-absorption (tasks/absorption.ts) digests the obvious proposals immediately
// (link >= 0.92, orphan_rescue-rescue >= 0.90, orphan_rescue-archive at any
// confidence). Everything below that pile up unreviewed. This step uses Workers AI
// (a cheap 3B model, same as recap.ts) to make an actual judgment call on what's left:
//   - link proposals, any confidence
//   - orphan_rescue (rescue action only), confidence < 0.90
// Both compare two REAL observations by id, which is what makes an LLM
// comparison possible.
//
// dedup is deliberately NOT fetched here (ops/ADR-JANITOR.md §6.4 point 3):
// "never absorbed, never AI-reviewed." A dedup proposal asserts the two
// observations are the SAME memory (one gets metabolized on accept) — a
// judgment with a much higher error cost than "these two are related," and one
// carrying only a single cosine as evidence (vs. orphan-archive's three failed
// rescue attempts). It goes straight to Rook's digest, same review gate as
// salience_regrade, and for the same reason: no automatic path exists at any
// confidence.
//
// consolidation is intentionally EXCLUDED here: its source_id/target_id are the
// same agent ENTITY id repeated twice (see tasks/kit-hygiene.ts), not observation
// ids — findObservation() can never resolve either side, and the real accept-side
// effect (candidate matching + skill-observation synthesis, see tools-v2/propose.ts)
// is far more involved than a link/rescue accept. Left pending for human review
// via mind_propose, same as dedup, salience_regrade, skill_promotion,
// cross_agent, cross_tenant, paradox_detected, recall_contract, fact_commitment.
//
// NOT a daemon task inside runDaemonTasks() — it needs env.AI, which the
// orchestrator doesn't have. Called directly from scheduled() instead, after
// daemon tasks (including absorption) and after subconscious processing, so it
// only ever sees what absorption didn't already handle.

import type { IBrainStorage } from "../storage/interface";
import type { DaemonProposal, Observation } from "../types";
import { createBidirectionalLink } from "./helpers";
import type { WorkersAIClient } from "../ai";
import type { DaemonRunContext } from "./types";

const TEXT_GEN_MODEL = "@cf/meta/llama-3.2-3b-instruct";
// ops/ADR-JANITOR.md §0.5/§2/§9 commit 3: the backlog was never reached at the old
// sizes — listProposals used to fetch the 20 NEWEST per type (LIFO), which starves
// anything that's been pending a while, ages it out to expireStaleProposals(30) and
// (pre-commit-2) laundered the timeout into a false rejection that fed §0.3's
// governor. gatherCandidates now fetches FIFO (order: "oldest") instead, so raising
// these two just widens how much of the real backlog a single night can reach.
const BATCH_SIZE = 90;
const FETCH_PER_TYPE = 200; // pool per type before the combined batch is capped
const ORPHAN_RESCUE_ABSORBED_THRESHOLD = 0.90; // absorption.ts already took >= this
const MIN_SIMILARITY_FOR_AI_ACCEPT = 0.60; // model can't override a floor this low — excessive-agency guard
const MAX_CONTENT_CHARS = 500; // keep the prompt small — the 3B model works better concise
const MAX_REASON_CHARS = 300;

interface ReviewDecision {
	decision: "accept" | "reject";
	reason: string;
}

export interface AiProposalReviewResult {
	/** Proposals actually reviewed (accepted + rejected — not skipped). */
	reviewed: number;
	/** True when context.deadlineAt was reached mid-batch and the loop broke early. */
	truncatedByDeadline: boolean;
}

/**
 * Reviews up to BATCH_SIZE pending link/orphan_rescue proposals via Workers AI.
 * dedup is never fetched — see the header comment (ops/ADR-JANITOR.md §6.4).
 */
export async function runAiProposalReview(
	storage: IBrainStorage,
	ai: WorkersAIClient | undefined,
	context: DaemonRunContext = {}
): Promise<AiProposalReviewResult> {
	if (!ai) return { reviewed: 0, truncatedByDeadline: false };

	let accepted = 0;
	let rejected = 0;
	let skipped = 0;
	let truncatedByDeadline = false;

	const candidates = await gatherCandidates(storage);

	for (const proposal of candidates.slice(0, BATCH_SIZE)) {
		if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
			truncatedByDeadline = true;
			break;
		}
		try {
			const outcome = await reviewOne(storage, ai, proposal);
			if (outcome === "accepted") accepted++;
			else if (outcome === "rejected") rejected++;
			else skipped++;
		} catch (err) {
			console.error(`ai-review: proposal ${proposal.id} (${proposal.proposal_type}) failed:`, err instanceof Error ? err.message : err);
			skipped++;
		}
	}

	const reviewed = accepted + rejected;
	await storeSummary(storage, { reviewed, accepted, rejected, skipped });

	return { reviewed, truncatedByDeadline };
}

async function gatherCandidates(storage: IBrainStorage): Promise<DaemonProposal[]> {
	// FIFO, not the storage default: ops/ADR-JANITOR.md §0.5 — listProposals's
	// default "newest" order took the 20 NEWEST per type, so a backlog older than
	// one fetch window was never reached and aged out to expireStaleProposals(30).
	// "oldest" pushes ORDER BY proposed_at ASC into the SQL LIMIT itself, which is
	// what actually matters once the pending queue is deeper than FETCH_PER_TYPE —
	// a caller-side re-sort of a "newest" fetch would still be missing the old end.
	//
	// dedup is deliberately not fetched here at all (not even for a zero-share
	// slice) — ops/ADR-JANITOR.md §6.4 point 3: never AI-reviewed, full stop.
	const [links, orphanRescues] = await Promise.all([
		storage.listProposals("link", "pending", FETCH_PER_TYPE, "oldest"),
		storage.listProposals("orphan_rescue", "pending", FETCH_PER_TYPE, "oldest")
	]);

	// absorption.ts already took orphan_rescue "archive" (any confidence) and
	// "rescue" >= 0.90 — only lower-confidence rescue attempts remain reviewable here.
	const eligibleOrphanRescues = orphanRescues.filter(p => {
		const meta = (p.metadata ?? {}) as Record<string, unknown>;
		return meta.action !== "archive" && p.confidence < ORPHAN_RESCUE_ABSORBED_THRESHOLD;
	});

	// Cap each type before concatenating so a flood of one type (e.g. links) can't
	// starve the other out of the BATCH_SIZE slice taken by the caller. link and
	// orphan_rescue are the only 2 types this function ever fetches, so dividing
	// by 2 is exact — ops/ADR-JANITOR.md §2's ceilings table and §9 commit 3's
	// acceptance line both specify ceil(90/2) over two types.
	const perType = Math.ceil(BATCH_SIZE / 2); // 45 each
	return [...links.slice(0, perType), ...eligibleOrphanRescues.slice(0, perType)].slice(0, BATCH_SIZE);
}

async function reviewOne(storage: IBrainStorage, ai: WorkersAIClient, proposal: DaemonProposal): Promise<"accepted" | "rejected" | "skipped"> {
	const [sourceFound, targetFound] = await Promise.all([
		storage.findObservation(proposal.source_id),
		storage.findObservation(proposal.target_id)
	]);

	if (!sourceFound || !targetFound) {
		// Deleted since the proposal was created — nothing left to compare, auto-reject.
		await storage.reviewProposal(proposal.id, "rejected", "AI-reviewed: source or target observation no longer exists");
		return "rejected";
	}

	const prompt = buildPrompt(proposal, sourceFound.observation, targetFound.observation);

	let decision: ReviewDecision | null;
	try {
		decision = await runModelReview(ai, prompt);
	} catch (err) {
		console.warn(`ai-review: model call failed for proposal ${proposal.id}:`, err instanceof Error ? err.message : err);
		return "skipped";
	}

	if (!decision) {
		console.warn(`ai-review: could not parse model response for proposal ${proposal.id}`);
		return "skipped";
	}

	const feedbackNote = `AI-reviewed: ${decision.reason}`.slice(0, 1000);

	if (decision.decision === "accept") {
		const score = proposal.similarity ?? proposal.confidence;
		if (score < MIN_SIMILARITY_FOR_AI_ACCEPT) {
			await storage.reviewProposal(
				proposal.id,
				"rejected",
				`AI-reviewed: model approved but similarity ${Math.round(score * 100)}% below ${MIN_SIMILARITY_FOR_AI_ACCEPT * 100}% floor`
			);
			return "rejected";
		}

		if (proposal.proposal_type === "link") {
			await createBidirectionalLink(storage, proposal);
		} else if (proposal.proposal_type === "orphan_rescue") {
			await createBidirectionalLink(storage, proposal);
			await storage.updateOrphanStatus(proposal.source_id, "rescued");
		}
		// dedup can never reach here — gatherCandidates() never fetches it
		// (ops/ADR-JANITOR.md §6.4 point 3). Its accept-side effect (link +
		// metabolize the newer side) lives only in tools-v2/propose.ts.
		await storage.reviewProposal(proposal.id, "accepted", feedbackNote);
		return "accepted";
	}

	await storage.reviewProposal(proposal.id, "rejected", feedbackNote);
	return "rejected";
}

function truncate(content: string): string {
	return content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS)}…` : content;
}

function buildPrompt(proposal: DaemonProposal, source: Observation, target: Observation): string {
	const scorePct = Math.round((proposal.similarity ?? proposal.confidence) * 100);
	const rationale = proposal.rationale ?? "none given";

	if (proposal.proposal_type === "orphan_rescue") {
		return `You are a memory curator reviewing whether an orphaned memory belongs with a candidate rescue target.

Orphaned memory (territory: ${source.territory}):
${truncate(source.content)}

Candidate rescue target (territory: ${target.territory}):
${truncate(target.content)}

Proposal type: orphan_rescue
Similarity score: ${scorePct}%
Daemon rationale: ${rationale}

Does the orphaned memory genuinely belong with the rescue target? Consider:
- Do they share a meaningful relationship (thematic, causal, temporal, referential)?
- Would linking the orphan to this target help it surface again in the right context?
- Is this a genuine connection or just surface-level word overlap?

Respond with JSON only:
{"decision": "accept" | "reject", "reason": "one sentence"}`;
	}

	return `You are a memory curator reviewing whether two memories should be linked.

Memory A (territory: ${source.territory}):
${truncate(source.content)}

Memory B (territory: ${target.territory}):
${truncate(target.content)}

Proposal type: ${proposal.proposal_type}
Similarity score: ${scorePct}%
Daemon rationale: ${rationale}

Should these memories be connected? Consider:
- Do they share a meaningful relationship (thematic, causal, temporal, referential)?
- Would connecting them help retrieval — would finding one make the other relevant?
- Is this a genuine connection or just surface-level word overlap?

Respond with JSON only:
{"decision": "accept" | "reject", "reason": "one sentence"}`;
}

async function runModelReview(ai: WorkersAIClient, prompt: string): Promise<ReviewDecision | null> {
	let result: { response: string };
	try {
		result = await ai.run(TEXT_GEN_MODEL, {
			messages: [
				{ role: "system", content: "You are a precise, concise memory curator. Respond with JSON only, no commentary." },
				{ role: "user", content: prompt }
			],
			max_tokens: 200
		}) as { response: string };
	} catch (err) {
		throw new Error(`Workers AI text generation failed: ${err instanceof Error ? err.message : "unknown error"}`);
	}

	const responseText = typeof result.response === "string"
		? result.response
		: (result.response != null ? JSON.stringify(result.response) : "");

	if (!responseText) return null;

	// The model sometimes wraps JSON in markdown code fences — strip them (same pattern as recap.ts).
	const raw = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

	try {
		const parsed = JSON.parse(raw);
		if (parsed && (parsed.decision === "accept" || parsed.decision === "reject")) {
			return {
				decision: parsed.decision,
				reason: typeof parsed.reason === "string" && parsed.reason.trim()
					? parsed.reason.trim().slice(0, MAX_REASON_CHARS)
					: "no reason given"
			};
		}
	} catch {
		// Not JSON — treat as unparseable, caller leaves the proposal pending.
	}

	return null;
}

async function storeSummary(
	storage: IBrainStorage,
	counts: { reviewed: number; accepted: number; rejected: number; skipped: number }
): Promise<void> {
	const summary = {
		timestamp: new Date().toISOString(),
		reviewed: counts.reviewed,
		accepted: counts.accepted,
		rejected: counts.rejected,
		skipped: counts.skipped
	};

	try {
		const config = await storage.readDaemonConfig();
		const data = { ...(config.data as Record<string, unknown>), last_ai_review: summary };
		await storage.updateDaemonConfigData(data);
	} catch (err) {
		console.error("ai-review: failed to store summary:", err instanceof Error ? err.message : err);
	}
}
