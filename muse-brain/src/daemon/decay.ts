// ============ DAEMON DECAY SEMANTICS ============
// Pure, storage-independent implementation of one decay step.

import type { Texture } from "../types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Thresholds are deliberately named in the same units as the old daemon rules. */
export const DECAY_THRESHOLDS = {
	vividnessCrystallineToVividDays: 7,
	vividnessVividToSoftDays: 30,
	gripIronToStrongDays: 14,
	gripStrongToPresentDays: 60,
	chargeFreshToActiveHours: 1,
	chargeActiveToProcessingDays: 1
} as const;

export interface DecayResult {
	texture: Texture;
	changed: boolean;
}

/**
 * Apply exactly one old-daemon decay step without mutating the input texture.
 *
 * Two clocks, ops/ADR-JANITOR.md §4 (b): vividness and grip decay on whichever
 * reflects genuine attention — last_accessed when present, otherwise created.
 * charge_phase decays on created alone, unconditionally — it names ingestion
 * freshness (ADR-BRAIN-METABOLIC-ORGANISM.md §2), not how often the memory is
 * looked at; access must not be able to pin it fresh forever. Threshold
 * comparisons are strict (>), so an observation exactly at a threshold does
 * not change until it is older.
 */
export function applyDecaySemantics(
	texture: Texture,
	lastAccessed: string | undefined,
	created: string | undefined,
	asOf: Date = new Date()
): DecayResult {
	if (texture.salience === "foundational") {
		return { texture, changed: false };
	}

	const asOfMs = asOf.getTime();
	if (!Number.isFinite(asOfMs)) {
		return { texture, changed: false };
	}

	// vividness, grip — access clock (falls back to created when never accessed).
	const referenceTimestamp = lastAccessed || created;
	const referenceMs = referenceTimestamp ? new Date(referenceTimestamp).getTime() : Number.NaN;

	// charge_phase — age clock. Invalid/missing dates produce NaN, making every
	// strict comparison false; that dimension simply doesn't advance this run.
	const creationMs = created ? new Date(created).getTime() : Number.NaN;

	let next = texture;

	// Each dimension advances at most one state per run. The else-if shape is
	// intentional: a 60-day crystalline memory becomes vivid first, not soft.
	if (Number.isFinite(referenceMs)) {
		const accessAgeMs = asOfMs - referenceMs;

		if (
			accessAgeMs > DECAY_THRESHOLDS.vividnessCrystallineToVividDays * DAY_MS &&
			texture.vividness === "crystalline"
		) {
			next = { ...next, vividness: "vivid" };
		} else if (
			accessAgeMs > DECAY_THRESHOLDS.vividnessVividToSoftDays * DAY_MS &&
			texture.vividness === "vivid"
		) {
			next = { ...next, vividness: "soft" };
		}

		if (
			accessAgeMs > DECAY_THRESHOLDS.gripIronToStrongDays * DAY_MS &&
			texture.grip === "iron"
		) {
			next = { ...next, grip: "strong" };
		} else if (
			accessAgeMs > DECAY_THRESHOLDS.gripStrongToPresentDays * DAY_MS &&
			texture.grip === "strong"
		) {
			next = { ...next, grip: "present" };
		}
	}

	if (Number.isFinite(creationMs)) {
		const creationAgeMs = asOfMs - creationMs;

		if (
			creationAgeMs > DECAY_THRESHOLDS.chargeFreshToActiveHours * HOUR_MS &&
			texture.charge_phase === "fresh"
		) {
			next = { ...next, charge_phase: "active" };
		} else if (
			creationAgeMs > DECAY_THRESHOLDS.chargeActiveToProcessingDays * DAY_MS &&
			texture.charge_phase === "active"
		) {
			next = { ...next, charge_phase: "processing" };
		}
	}

	return { texture: next, changed: next !== texture };
}
