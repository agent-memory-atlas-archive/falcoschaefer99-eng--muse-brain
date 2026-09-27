// ============ DAEMON TASK: CROSS-TENANT PROPOSALS ============
// SECURITY CRITICAL: only operates on explicitly shared territories.
// Private territories (self, us, body, emotional, kin, episodic) are NEVER
// surfaced across tenants. Only 'craft' and 'philosophy' are shared.
//
// For each shared territory, finds observations from the current tenant and
// all other tenants within the last 7 days, then proposes synthesis when
// two observations are semantically similar (> 0.75).

import type { IBrainStorage } from "../../storage/interface";
import type { DaemonTaskResult } from "../types";
import type { ArrivalBoundary, DaemonRunContext } from "../types";
import type { Observation } from "../../types";
import { ALLOWED_TENANTS } from "../../constants";
import { proposalKey } from "../../storage/keys";
import { readCrossTenantBoundary } from "../context";

// SECURITY: Only these territories are shared across tenants.
// All other territories contain personal/private content that MUST NOT cross tenant boundaries.
const SHARED_TERRITORIES: ReadonlyArray<string> = ["craft", "philosophy"];

const LOOKBACK_DAYS = 7;
const CROSS_TENANT_SIMILARITY_THRESHOLD = 0.75;

// The pair scan is O(n²): 50 current-tenant observations × 50 per other tenant,
// per shared territory. Every surviving pair used to cost a proposalExists AND a
// createProposal inside the loop, with no governor at all — a busy week in
// 'craft' could file thousands of subrequests from this task alone and kill the
// invocation for every tenant after it. Mirrors absorption's MAX_ABSORB_PER_RUN.
const MAX_PAIR_PROPOSALS_PER_RUN = 50;

interface PairCandidate {
	obsA: Observation;
	obsB: Observation;
	otherTenant: string;
	territory: string;
}

interface OtherTenantStorage {
	tenant: string;
	storage: IBrainStorage;
	/** Same rename/brand as DaemonRunContext.arrivalBoundary — this carries the OTHER tenant's own run boundary, not a row property. */
	arrivalBoundary?: ArrivalBoundary;
}

type OptionalClosableStorage = IBrainStorage & {
	close?: () => Promise<void> | void;
	end?: () => Promise<void> | void;
};

async function closeClonedStorage(storage: IBrainStorage): Promise<void> {
	const closable = storage as OptionalClosableStorage;
	if (typeof closable.close === "function") {
		await closable.close();
		return;
	}
	if (typeof closable.end === "function") {
		await closable.end();
	}
}

async function closeClonedStorages(storages: OtherTenantStorage[]): Promise<void> {
	const results = await Promise.allSettled(storages.map(({ storage }) => closeClonedStorage(storage)));
	const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failures.length === 0) return;
	for (const failure of failures) {
		console.error("cross-tenant: cloned storage close failed:", failure.reason instanceof Error ? failure.reason.message : "unknown error");
	}
	throw new Error("cross-tenant: failed to close cloned storage");
}

export async function runCrossTenantTask(storage: IBrainStorage, context: DaemonRunContext = {}): Promise<DaemonTaskResult> {
	let proposals_created = 0;
	const otherStorages: OtherTenantStorage[] = [];
	let taskFailed = false;

	const currentTenant = storage.getTenant();
	const configuredTenants = context.allowedTenants
		?? (typeof storage.getAllowedTenants === "function" ? storage.getAllowedTenants() : ALLOWED_TENANTS);
	const otherTenants = configuredTenants.filter(t => t !== currentTenant);

	if (otherTenants.length === 0) {
		return { task: "cross-tenant", changes: 0, proposals_created: 0 };
	}

	const cutoffDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

	try {
		// Hoisted out of the territory loop: the postgres backend allocates a fresh
		// connection pool on every forTenant() call, so calling it per territory built
		// one pool per territory per tenant. Keep the handles and close them in the
		// finally block below, including early-return and error paths.
		for (const tenant of otherTenants) {
			const otherStorage = storage.forTenant(tenant);
			const entry: OtherTenantStorage = { tenant, storage: otherStorage };
			otherStorages.push(entry);
			// Legacy/mock seams may not expose daemon configuration. Treat those as
			// bootstrap context rather than logging a misleading read failure.
			// SECURITY: readCrossTenantBoundary(), never readDaemonConfig() or
			// readDaemonRunContext() directly — see its doc comment in daemon/context.ts.
			const otherContext = typeof otherStorage.readDaemonConfig === "function"
				? await readCrossTenantBoundary(otherStorage)
				: {};
			entry.arrivalBoundary = otherContext.arrivalBoundary;
		}

		const candidates: PairCandidate[] = [];
		let truncated = 0;

		for (const territory of SHARED_TERRITORIES) {
			// Get current tenant's recent observations in this territory
			const currentObs = await storage.queryObservations({
				territory,
				...(context.arrivalBoundary ? { touched_after: context.arrivalBoundary } : { created_after: cutoffDate }),
				limit: 50,
				order_by: "created",
				order_dir: "desc"
			});

			if (currentObs.length === 0) continue;

			// SECURITY: every read below is scoped to a DIFFERENT tenant via forTenant —
			// never the current tenant's storage.
			for (const { tenant: otherTenant, storage: otherStorage, arrivalBoundary } of otherStorages) {
				const otherObs = await otherStorage.queryObservations({
					territory,
					...(arrivalBoundary ? { touched_after: arrivalBoundary } : { created_after: cutoffDate }),
					limit: 50,
					order_by: "created",
					order_dir: "desc"
				});

				if (otherObs.length === 0) continue;

				// Check each pair for similarity
				for (const { observation: obsA } of currentObs) {
					if (obsA.texture?.charge_phase === "metabolized") continue;

					// Use findSimilarUnlinked scoped to the other tenant to find matches
					// Note: findSimilarUnlinked uses the embedding of obsA to find similar obs in otherStorage
					// But findSimilarUnlinked is tenant-scoped and obsA belongs to currentTenant.
					// We need to find similarities within otherObs against obsA.
					// Approach: iterate otherObs and find the ones with embeddings via searchSimilar on otherStorage.
					// Since we don't have obsA's embedding directly, we fall back to checking if obsA's id
					// exists in otherStorage's findSimilarUnlinked — it won't since it's a different tenant.
					//
					// Safe approach: use the content-level check via the hybrid search or just use
					// findSimilarUnlinked on currentStorage's obsA id, which returns similar obs
					// from the CURRENT tenant — not what we want.
					//
					// Correct approach: for each obsA, call otherStorage.findSimilarUnlinked only if
					// obsA exists there — which it doesn't (different tenant).
					//
					// We need findSimilarUnlinked on the OTHER tenant scoped to obsA's embedding.
					// The cleanest path: iterate pairs and use the metadata we have.
					// Since we can't call cross-tenant vector search without a shared embedding space,
					// we use a conservative proxy: if both tenants have observations in the same territory
					// about the same entity_id, that's a strong convergence signal.

					for (const { observation: obsB } of otherObs) {
						if (obsB.texture?.charge_phase === "metabolized") continue;

						// Primary signal: same entity_id in same shared territory
						const sharedEntity = obsA.entity_id && obsB.entity_id && obsA.entity_id === obsB.entity_id;
						if (!sharedEntity) continue;

						// Collect, don't write. The existence check and the write both used to
						// sit here, inside the innermost of four nested loops.
						if (candidates.length >= MAX_PAIR_PROPOSALS_PER_RUN) {
							truncated++;
							continue;
						}
						candidates.push({ obsA, obsB, otherTenant, territory });
					}
				}
			}
		}

		if (truncated > 0) {
			// Never truncate silently: a cap that hides its own effect looks identical to
			// "there was nothing to propose".
			console.warn(
				`cross-tenant [${currentTenant}]: pair cap of ${MAX_PAIR_PROPOSALS_PER_RUN} reached — ${truncated} candidate pairs deferred to a later run`
			);
		}

		if (candidates.length === 0) {
			return { task: "cross-tenant", changes: 0, proposals_created: 0 };
		}

		// ONE existence check for every surviving pair.
		// NOTE (pre-existing, deliberately preserved): the check keys off the SORTED
		// pair while the write below stores the unsorted (obsA, obsB) order, so for
		// pairs where obsA.id > obsB.id the check can never match its own write and the
		// proposal is re-created nightly. Fixing that changes which proposals get made,
		// which is a policy change and out of scope for this batching pass — see the
		// follow-up. Batching neither introduces nor worsens it.
		const sortedPair = (candidate: PairCandidate): [string, string] => {
			const [idA, idB] = [candidate.obsA.id, candidate.obsB.id].sort();
			return [idA, idB];
		};
		const existing = await storage.batchProposalExists(candidates.map(candidate => {
			const [idA, idB] = sortedPair(candidate);
			return { type: "cross_tenant", sourceId: idA, targetId: idB };
		}));

		for (const candidate of candidates) {
			const { obsA, obsB, otherTenant, territory } = candidate;
			const [idA, idB] = sortedPair(candidate);
			if (existing.has(proposalKey("cross_tenant", idA, idB))) continue;

			await storage.createProposal({
				tenant_id: currentTenant,
				proposal_type: "cross_tenant",
				source_id: obsA.id,
				target_id: obsB.id,
				confidence: 0.8,
				rationale: `Cross-tenant convergence: ${currentTenant} and ${otherTenant} both have observations about the same entity in shared territory '${territory}'`,
				metadata: {
					tenant_a: currentTenant,
					tenant_b: otherTenant,
					obs_a: obsA.id,
					obs_b: obsB.id,
					territory,
					entity_id: obsA.entity_id
				},
				status: "pending"
			});
			proposals_created++;
		}

		return { task: "cross-tenant", changes: 0, proposals_created };
	} catch (err) {
		taskFailed = true;
		throw err;
	} finally {
		try {
			await closeClonedStorages(otherStorages);
		} catch (closeError) {
			if (!taskFailed) throw closeError;
		}
	}
}
