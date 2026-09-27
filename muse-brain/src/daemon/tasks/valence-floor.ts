// ============ DAEMON TASK: VALENCE FLOOR (measurement) ============
// ops/ADR-VALENCE-FLOOR.md, slice 0 — computes how many reserved seats the
// foundation lane's valence floor WOULD hold, and writes the measurement to
// daemon_config.data.valence_floor. Slice 0 is measurement only: `seats`
// computes here but nothing consumes it — buildFoundationLane (tools-v2/
// wake.ts) is not touched, so the lane stays byte-identical.
//
// Not a runDaemonTasks() task — like the inline "novelty" stage, this reuses
// cycle.ts's already-fetched territoryData rather than a second corpus read,
// and must run AFTER daemon/tasks/valence-lexicon.ts in the same cycle (the
// floor reads what the lexicon just classified this run).
//
// The formula (ADR §"How many seats — derived, not guessed"):
//   classified                 = # foundational memories whose charges are ALL in the lexicon
//   eligible                   = # of those that are unmixed-positive
//   eligible_share             = eligible / classified
//   simulated_eligible_in_lane = # eligible in the top 5 by pull (simulating production)
//   eligible_supply_after_cut  = # eligible surviving the 519->200 storage cut
//
//   raw    = round(5 * eligible_share)
//   target = eligible > 0 ? max(raw, 1) : 0
//   seats  = clamp(target - simulated_eligible_in_lane, 0, 2)
//   seats  = min(seats, eligible_supply_after_cut)
//
// Every number here is a COUNT over the current corpus — no field is computed
// from config (ops/ADR-VALENCE-FLOOR.md's "Honest limits" rule). The stage 1
// (519->200) and stage 2 (200->5) cuts are simulated with the same formula
// and direction production uses (stage 1 calls helpers.ts's exported
// rankFoundationalByPullStrength directly; stage 2 in production — wake.ts's
// buildFoundationLane — inlines an equivalent sort rather than calling a
// shared function) and the SAME cap constants (FOUNDATIONAL_LANE_CAP,
// FOUNDATION_OBS_CAP) — no second ranker exists anywhere in this file.
//
// Documented simplification: `simulated_eligible_in_lane` does NOT exclude ids
// already claimed by the `pulling`/`recent_grip` lanes the way buildFoundationLane
// itself does (wake.ts:922-923) — those are wake-time state (results of a live
// hybrid-search call) this nightly task has no access to. This makes the
// simulation a close proxy for what a given wake actually serves, not a
// byte-identical replay of it.

import type { IBrainStorage } from "../../storage/interface";
import type { ChargeValence, Observation } from "../../types";
import type { ValenceFloorResult } from "../types";
import { rankFoundationalByPullStrength } from "../../helpers";
import { FOUNDATIONAL_LANE_CAP } from "../../constants";
import { FOUNDATION_OBS_CAP } from "../../tools-v2/wake";
import { chargesOf } from "./valence-lexicon";

/**
 * Largest whole number below half the lane (5 / 2) — ADR §"How many seats":
 * "a floor that can claim half the lane has stopped being a floor and become
 * the ranking, the thing this ADR is forbidden to build." A judgment, not a
 * measurement — flagged here rather than dressed up as one.
 */
const SEAT_CAP = 2;

type EligibilityVerdict = "eligible" | "ineligible" | "unclassified";

/**
 * Pure — ADR §"Eligibility: unmixed positive". A memory is eligible only when
 * EVERY charge it carries has a lexicon row (fail closed on any unclassified
 * charge) AND at least one charge is positive AND none is negative or mixed.
 * "Majority positive" and "net positive" are both explicitly rejected by the
 * ADR — a five-charge repair memory containing one positive charge among
 * grief/shame already wins on pull strength; eligibility exists for the
 * class that LOSES that competition, the clean one.
 */
export function classifyEligibility(
	charges: string[],
	valenceByCharge: ReadonlyMap<string, ChargeValence>
): EligibilityVerdict {
	if (charges.length === 0) return "ineligible";
	let sawPositive = false;
	for (const charge of charges) {
		const valence = valenceByCharge.get(charge);
		if (!valence) return "unclassified";
		if (valence === "negative" || valence === "mixed") return "ineligible";
		if (valence === "positive") sawPositive = true;
		// "neutral" charges neither disqualify nor satisfy "at least one positive".
	}
	return sawPositive ? "eligible" : "ineligible";
}

function emptyResult(computedAt: string, lexiconRows: number, reason: string): ValenceFloorResult {
	return {
		seats: 0,
		reason,
		classified: 0,
		eligible: 0,
		eligible_share: null,
		simulated_eligible_in_lane: 0,
		eligible_supply_after_cut: 0,
		lexicon_rows: lexiconRows,
		lexicon_coverage_pct: null,
		unclassified_charge_count: 0,
		computed_at: computedAt
	};
}

export async function runValenceFloorTask(
	storage: IBrainStorage,
	territoryData: Array<{ territory: string; observations: Observation[] }>
): Promise<ValenceFloorResult> {
	const computedAt = new Date().toISOString();

	if (typeof storage.readChargeValence !== "function") {
		// Backend/mock predates this surface — same fallback convention as
		// countFoundationalObservations elsewhere in the janitor. Distinct from
		// the "before the first janitor run" reason (that one is synthesized by
		// the reader, tools-v2/wake.ts's buildJanitorHealth, when this key is
		// absent from daemon_config.data entirely).
		return emptyResult(computedAt, 0, "storage backend does not support the valence lexicon yet");
	}

	const lexiconRows = await storage.readChargeValence();
	const valenceByCharge = new Map<string, ChargeValence>(lexiconRows.map(row => [row.charge, row.valence]));

	const allFoundational: Observation[] = [];
	for (const { observations } of territoryData) {
		for (const o of observations) {
			if (o.texture?.salience === "foundational") allFoundational.push(o);
		}
	}

	if (allFoundational.length === 0) return emptyResult(computedAt, lexiconRows.length, "no foundational memories exist yet");

	let classified = 0;
	let eligible = 0;
	const distinctChargesOnFoundational = new Set<string>();
	const unclassifiedCharges = new Set<string>();

	for (const o of allFoundational) {
		const charges = chargesOf(o);
		for (const charge of charges) distinctChargesOnFoundational.add(charge);
		const verdict = classifyEligibility(charges, valenceByCharge);
		if (verdict === "unclassified") {
			for (const charge of charges) if (!valenceByCharge.has(charge)) unclassifiedCharges.add(charge);
			continue;
		}
		classified++;
		if (verdict === "eligible") eligible++;
	}

	const eligibleShare = classified > 0 ? eligible / classified : null;

	// Stage 1 simulation: rank ALL foundational memories by pull strength (the
	// SAME exported function + direction production uses), no cap — then slice
	// at the SAME two boundaries production applies (FOUNDATIONAL_LANE_CAP=200,
	// FOUNDATION_OBS_CAP=5), rather than re-deriving a second ranking.
	const ranked = rankFoundationalByPullStrength(
		allFoundational.map(observation => ({ observation })),
		allFoundational.length
	);

	const afterStorageCut = ranked.slice(0, FOUNDATIONAL_LANE_CAP);
	const eligibleSupplyAfterCut = afterStorageCut.filter(
		({ observation }) => classifyEligibility(chargesOf(observation), valenceByCharge) === "eligible"
	).length;

	const simulatedEligibleInLane = afterStorageCut.slice(0, FOUNDATION_OBS_CAP).filter(
		({ observation }) => classifyEligibility(chargesOf(observation), valenceByCharge) === "eligible"
	).length;

	const raw = Math.round(5 * (eligibleShare ?? 0));
	const target = eligible > 0 ? Math.max(raw, 1) : 0;
	const seatsBeforeSupplyClamp = Math.min(Math.max(target - simulatedEligibleInLane, 0), SEAT_CAP);
	const seats = Math.min(seatsBeforeSupplyClamp, eligibleSupplyAfterCut);

	const lexiconCoveragePct = distinctChargesOnFoundational.size > 0
		? Math.round(((distinctChargesOnFoundational.size - unclassifiedCharges.size) / distinctChargesOnFoundational.size) * 100)
		: null;

	let reason: string | undefined;
	if (seats === 0) {
		if (eligible === 0) {
			reason = "no eligible (unmixed-positive) foundational memories measured yet";
		} else if (eligibleSupplyAfterCut === 0) {
			reason = "no eligible memories survived the 519->200 storage cut";
		} else {
			reason = "the ranker already seats enough eligible memories unaided";
		}
	}

	return {
		seats,
		...(reason ? { reason } : {}),
		classified,
		eligible,
		eligible_share: eligibleShare,
		simulated_eligible_in_lane: simulatedEligibleInLane,
		eligible_supply_after_cut: eligibleSupplyAfterCut,
		lexicon_rows: lexiconRows.length,
		lexicon_coverage_pct: lexiconCoveragePct,
		unclassified_charge_count: unclassifiedCharges.size,
		computed_at: computedAt
	};
}
