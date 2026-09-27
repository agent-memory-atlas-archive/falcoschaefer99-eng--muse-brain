// ============ STORAGE INTERFACE ============
// IBrainStorage defines the full contract for all storage backends.
// Every method in BrainStorage (R2) has a counterpart here, plus new
// Postgres-native capabilities (vector search, filtered queries, bulk ops).
//
// No imports from storage implementations — pure interface file.

import type {
	Observation,
	Link,
	OpenLoop,
	BrainState,
	Letter,
	IdentityCore,
	Anchor,
	Desire,
	WakeLogEntry,
	RelationalState,
	SubconsciousState,
	TriggerCondition,
	ConsentState,
	TerritoryOverview,
	IronGripEntry,
	Entity,
	Relation,
	EntityFilter,
	ProjectDossier,
	ProjectDossierFilter,
	AgentCapabilityManifest,
	AgentCapabilityManifestFilter,
	DaemonProposal,
	OrphanObservation,
	DaemonConfig,
	ObservationVersion,
	ProcessingEntry,
	ConsolidationCandidate,
	DispatchFeedback,
	DispatchStat,
	Task,
	AgentRuntimeSession,
	AgentRuntimeRun,
	AgentRuntimePolicy,
	AgentRuntimeUsage,
	CapturedSkillArtifact,
	CapturedSkillArtifactCreate,
	CapturedSkillArtifactFilter,
	CapturedSkillRegistryHealth,
	AgentLeaseRecord,
	AgentAuditEvent,
	AgentAuditEventFilter,
	ChargeValenceRow
} from "../types";
import type { QuerySignals, RetrievalProfile } from "../retrieval/query-signals";
import type { RetrievalRerankMode } from "../retrieval/rerank";
import type { AnyHybridScoreBreakdown } from "../retrieval/scoring";
import type { ArrivalBoundary, StateWindow } from "../daemon/types";

/** Whichever scorer produced this result — the new RRF scorer, or the frozen
 * legacy scorer (retrieval_profile: "legacy"). Defined in ../retrieval/scoring.ts
 * next to its constituents; re-exported here for existing importers. */
export type { AnyHybridScoreBreakdown };

// ============ FILTER / QUERY TYPES ============

export interface LetterListOptions {
	context?: string;
	limit?: number;
	cursor?: string;
	unread_only?: boolean;
	from?: string;
	query?: string;
}

export interface LetterListResult {
	letters: Letter[];
	has_more: boolean;
	next_cursor: string | null;
}

/** Filter options for queryObservations — all fields optional, AND-combined. */
export interface ObservationFilter {
	territory?: string;
	/** Filter observations linked to this entity. */
	entity_id?: string;
	/** Exact grip match. */
	grip?: string;
	/** Match observations that have ALL of these charges (superset). */
	charges_all?: string[];
	/** Match observations that have ANY of these charges (intersection). */
	charges_any?: string[];
	/** ISO 8601 — observations created on or after this timestamp. */
	created_after?: string;
	/** ISO 8601 — observations created on or before this timestamp. */
	created_before?: string;
	/** ISO 8601 — observations created or last accessed on/after this timestamp. */
	touched_after?: string;
	/** Observation subtype: "journal", "whisper", etc. */
	type?: string;
	/** User-assigned tag filter — any match. */
	tags?: string[];
	limit?: number;
	offset?: number;
	/** Column to sort by. Defaults to "created". */
	order_by?: "created" | "last_accessed" | "access_count";
	order_dir?: "asc" | "desc";
}

/** Options for vector similarity search. */
export interface SimilarSearchOptions {
	/** 768-dimension embedding vector as a flat number array. */
	embedding: number[];
	/** Narrow search to a specific territory. */
	territory?: string;
	/** Narrow search to specific grip levels. */
	grip?: string[];
	/** Minimum cosine similarity threshold (0–1). Defaults to 0 (no threshold). */
	min_similarity?: number;
	limit?: number;
}

/** A search result observation with its similarity score. */
export interface SimilarResult {
	observation: Observation;
	territory: string;
	similarity: number;
}

/** Options for hybrid search (vector + full-text + Neural Surfacing modulation). */
export interface HybridSearchOptions {
	query: string;
	/** Pre-computed query embedding — if omitted, vector search is skipped. */
	embedding?: number[];
	/** Retrieval profile baseline: fused (default), flat, legacy (native/balanced/benchmark
	 * are frozen aliases of fused — see normalizeRetrievalProfile). */
	retrieval_profile?: RetrievalProfile;
	/** Optional pre-extracted query signals (storage extracts when omitted). */
	query_signals?: QuerySignals;
	/** Optional second-pass rerank mode for top candidates. Backends may ignore unsupported modes. */
	rerank_mode?: RetrievalRerankMode;
	/** Number of top candidates eligible for rerank. */
	rerank_top_n?: number;
	territory?: string;
	grip?: string[];
	charge_phase?: string;
	/** Minimum fused rank-score threshold (0–1 band). Defaults to the resolved profile's
	 * min_score (fused/flat: 0.02; legacy: 0.3 — ADR-RETRIEVAL-FUSION-RETUNE §1 "Band migration").
	 * Explicit values here always win over the profile default. */
	min_similarity?: number;
	/** Max results to return. Defaults to 10. */
	limit?: number;
	/** Current circadian phase name — used for territory bias modulation. */
	circadian_phase?: string;
	/** Filter to observations linked to this entity. */
	entity_id?: string;
	/**
	 * Per-run overrides for the "fused" profile's rrf_k / lane_weights — the seam the
	 * benchmark CLI's --rrf-k / --lane-weights sweep flags write through (ADR §1 "Rook's
	 * note"). Ignored when the resolved profile is "flat" or "legacy": the sweep tunes
	 * fused only. lane_weights, when present, must be a complete four-key object.
	 */
	profile_overrides?: {
		rrf_k?: number;
		lane_weights?: { vector: number; keyword: number; entity: number; hint: number };
	};
}

/** A hybrid search result with composite score and source indicators. */
export interface HybridSearchResult {
	observation: Observation;
	territory: string;
	/** Composite score after all Neural Surfacing modulations. */
	score: number;
	/** Which search paths returned this observation. */
	match_sources: string[];
	/** Raw cosine similarity before modulation (if vector search ran). */
	vector_similarity?: number;
	/** Raw ts_rank score before modulation (if keyword search ran). */
	keyword_rank?: number;
	/**
	 * 1-based position of this candidate within each lane's own ordered pool
	 * (array index + 1), independent of `keyword_rank` above (which is the raw
	 * ts_rank magnitude, not a position). A lane key is present only when the
	 * candidate was returned by that lane's query. Diagnostic — not read by
	 * `scoreHybridCandidate`.
	 */
	lane_ranks?: {
		vector?: number;
		keyword?: number;
		entity?: number;
		hint?: number;
	};
	/** Scoring diagnostics for retrieval analysis. */
	score_breakdown?: AnyHybridScoreBreakdown;
}

/**
 * Options for `probeLanes` — locates specific ids within the vector and keyword
 * lanes' own ordered pools, independent of scoring/fusion/entity/hint. Diagnostic
 * only: never called from the live `mind_search` retrieval path.
 */
export interface LaneProbeOptions {
	query: string;
	/** Pre-computed query embedding — if omitted, the vector lane returns nothing. */
	embedding?: number[];
	/** Evidence ids to locate within each lane. */
	ids: string[];
	/**
	 * How many rows deep to query each lane (e.g. 200). Backends clamp this to
	 * [1, 5000] — `probeLanes` never runs an unbounded scan. `runBenchmarkHarness`
	 * may additionally RAISE the effective depth above this value (never lower)
	 * so it covers every benchmarked profile's own candidate_pool size — see
	 * BenchmarkRunConfig.lane_probe in benchmarks/types.ts.
	 */
	depth: number;
}

export interface LaneProbeResult {
	depth: number;
	lanes: {
		vector: { returned: number; top1: number; at_depth: number };
		keyword: { returned: number; top1: number; at_depth: number };
	};
	items: Array<{
		id: string;
		/**
		 * 1-based POSITION within the lane's own ordered pool (null when not found
		 * within depth). Named `*_position`, not `*_rank`, to avoid colliding with
		 * `HybridSearchResult.keyword_rank`, which is a ts_rank MAGNITUDE, not a
		 * position — the two must never share a field name.
		 */
		vector_position: number | null;
		vector_similarity: number | null;
		keyword_position: number | null;
		keyword_ts_rank: number | null;
	}>;
}

export interface LetterPageOptions {
	context: string;
	limit: number;
	cursor?: string;
	unread_only?: boolean;
	from?: string;
	query?: string;
}

export interface LetterPage {
	letters: Letter[];
	has_more: boolean;
	next_cursor?: string | null;
}

/** Options for bulk texture updates (decay daemon). */
export interface TextureUpdate {
	id: string;
	texture: Partial<Observation["texture"]>;
	/** Update last_accessed timestamp. */
	touch?: boolean;
}

/** Config passed to createStorage. */
export interface StorageConfig {
	backend: "postgres" | "sqlite";
	/** Explicit tenant boundary for this deployment; omitted only for legacy defaults. */
	allowedTenants?: readonly string[];
	/** Neon DATABASE_URL — required for postgres backend. */
	databaseUrl?: string;
	/** Enable prepared statements; direct Postgres may pass true, while Hyperdrive uses false. */
	prepare?: boolean;
	/** Local sqlite file path — required for sqlite backend. */
	sqlitePath?: string;
	/** R2Bucket — legacy field (unused in v1.3). */
	bucket?: R2Bucket;
}

// ============ MAIN INTERFACE ============

export interface IBrainStorage {
	// --- Tenant ---

	/** Return the current tenant identifier. */
	getTenant(): string;

	/** Return the validated tenant boundary retained by every storage clone. */
	getAllowedTenants(): readonly string[];

	/** Return a new IBrainStorage scoped to a different tenant (for cross-brain letters). */
	forTenant(tenant: string): IBrainStorage;

	// --- Territory Validation ---

	/** Validate and return territory string. Throws on invalid value. */
	validateTerritory(territory: string): string;

	// --- Brain State ---

	/** Read brain state, applying momentum decay and afterglow fade. */
	readBrainState(): Promise<BrainState>;

	/** Persist brain state. Stamps last_updated before writing. */
	writeBrainState(state: BrainState): Promise<void>;

	// --- Territories ---

	/** Read all observations for a territory. */
	readTerritory(territory: string): Promise<Observation[]>;

	/** Overwrite all observations for a territory. */
	writeTerritory(territory: string, observations: Observation[]): Promise<void>;

	/** Append a single observation to a territory. */
	appendToTerritory(territory: string, observation: Observation): Promise<void>;

	/** Read all territories in parallel. Returns territory + observations pairs. */
	readAllTerritories(): Promise<{ territory: string; observations: Observation[] }[]>;

	/** Find a single observation by ID, searching across all territories. */
	findObservation(id: string): Promise<{ observation: Observation; territory: string } | null>;

	// --- Observation Queries (new Postgres-native capabilities) ---

	/** Filtered query across observations. All filter fields are optional (AND-combined). */
	queryObservations(filter: ObservationFilter): Promise<{ observation: Observation; territory: string }[]>;

	/**
	 * All foundational-salience observations across every territory, regardless of recency.
	 * Dedicated query (not queryObservations, whose fetch window is created_at-ordered and
	 * would risk losing an old foundational memory behind a wall of newer ones) — the wake
	 * foundation lane's whole point is "unreachable by recency" recall.
	 *
	 * ops/ADR-JANITOR.md §5.1 — backends bound the result to FOUNDATIONAL_LANE_CAP
	 * (../constants), ranked by calculatePullStrength DESCENDING, not by recency. This
	 * used to be `ORDER BY created_at DESC LIMIT 200`: a truncation-by-recency that ran
	 * BEFORE the wake foundation lane's own pull-strength ranking ever saw the rows, so a
	 * high-pull-strength old memory could be dropped here without ever being considered.
	 * Now the truncation uses the same measure the lane ranks by, so what gets dropped
	 * past the cap is the least-alive, not merely the oldest. Foundational salience is
	 * assumed rare, but that assumption can be wrong, so truncation past the cap is
	 * surfaced (not silent) via countFoundationalObservations() — the wake foundation
	 * lane reports foundational_total vs foundational_considered from the two together.
	 */
	readFoundationalObservations(): Promise<{ observation: Observation; territory: string }[]>;

	/**
	 * Total count of foundational-salience observations across every territory, independent
	 * of readFoundationalObservations()'s FOUNDATIONAL_LANE_CAP — lets callers detect and
	 * surface truncation instead of silently reintroducing recency bias into a lane whose
	 * entire purpose is being recency-independent. Optional: backends/mocks that predate this
	 * surface just don't report truncation (readFoundationalObservations().length is used
	 * as a same-as-considered fallback).
	 */
	countFoundationalObservations?(): Promise<number>;

	/**
	 * Count of observations whose texture.grip is 'iron' — used by
	 * brain_health.janitor.iron (ops/ADR-JANITOR.md §7). Optional, same
	 * predates-this-surface fallback convention as countFoundationalObservations.
	 */
	countIronObservations?(): Promise<number>;

	/**
	 * Corpus-wide charge_phase distribution — used by brain_health.janitor.charge_phase.
	 * Optional, same fallback convention as countFoundationalObservations.
	 */
	getChargePhaseCounts?(): Promise<{ fresh: number; active: number; processing: number; metabolized: number }>;

	/** Batch-update texture dimensions for multiple observations (decay daemon). */
	bulkUpdateTexture(updates: TextureUpdate[]): Promise<void>;

	/** Batch full-replace texture for multiple observations in a single query (unnest). */
	bulkReplaceTexture(updates: { id: string; texture: Observation["texture"] }[]): Promise<void>;

	/** Apply one daemon decay step in storage and return the number of rows changed. */
	runDecay(asOf?: Date): Promise<number>;

	/** Overwrite the full texture for a single observation by ID (safe, no destructive territory rewrite). */
	updateObservationTexture(id: string, texture: Observation["texture"]): Promise<void>;

	/** Increment access_count and stamp last_accessed_at for a single observation (safe, no territory rewrite). */
	updateObservationAccess(id: string): Promise<void>;

	/** Delete a single observation by ID. Returns true if found and deleted. */
	deleteObservation(id: string): Promise<boolean>;

	// --- Vector Search (new — embeddings nullable until populated) ---

	/** Update the embedding vector for a single observation (called after generation). */
	updateObservationEmbedding(id: string, embedding: number[]): Promise<void>;

	/** Bulk update embeddings for multiple observations. */
	bulkUpdateEmbeddings(updates: Array<{id: string; embedding: number[]}>): Promise<void>;

	/** Query observations missing embeddings for backfill. */
	queryUnembedded(limit: number): Promise<{id: string; content: string}[]>;

	/** Count observations missing embeddings. */
	countUnembedded(): Promise<number>;

	/** Find observations semantically similar to the provided embedding. */
	searchSimilar(options: SimilarSearchOptions): Promise<SimilarResult[]>;

	/**
	 * Auto-discovery: find observations similar to the given observation ID
	 * that are not yet linked to it. Returns candidates sorted by similarity.
	 */
	findUnlinkedSimilar(id: string, limit?: number): Promise<SimilarResult[]>;

	/**
	 * Hybrid search: combines vector similarity + full-text keyword search,
	 * then applies Neural Surfacing v1 score modulations (grip, charge phase,
	 * novelty, circadian territory bias).
	 */
	hybridSearch(options: HybridSearchOptions): Promise<HybridSearchResult[]>;

	/**
	 * Read-only diagnostic: locates specific evidence ids within the vector and
	 * keyword lanes' own ordered pools (at a caller-chosen depth), independent of
	 * scoring/fusion/entity/hint. Powers the benchmark harness's lane_probe wiring —
	 * never called from mind_search's live retrieval path.
	 */
	probeLanes(options: LaneProbeOptions): Promise<LaneProbeResult>;

	/**
	 * Record memory cascade pairs for observations that appeared together in a
	 * search result set. Increments count if pair already exists.
	 * Only records pairs from the top 5 results (canonical ordering: id_a < id_b).
	 */
	recordMemoryCascade(observationIds: string[]): Promise<void>;

	/**
	 * Apply post-search surfacing effects to a set of returned observation IDs:
	 * decrement novelty_score by 0.05 (min 0), increment surface_count, stamp last_surfaced_at.
	 */
	updateSurfacingEffects(observationIds: string[]): Promise<void>;

	// --- Open Loops ---

	readOpenLoops(): Promise<OpenLoop[]>;
	writeOpenLoops(loops: OpenLoop[]): Promise<void>;
	appendOpenLoop(loop: OpenLoop): Promise<void>;

	// --- Links ---

	readLinks(): Promise<Link[]>;
	writeLinks(links: Link[]): Promise<void>;
	appendLink(link: Link): Promise<void>;

	// --- Letters ---

	readLetters(): Promise<Letter[]>;
	getLetterById?(id: string, recipientContext: string): Promise<Letter | null>;
	countLettersFromSince?(fromContext: string, sinceIso: string): Promise<number>;
	markLettersRead?(ids: string[]): Promise<void>;
	listLettersPaged?(options: LetterPageOptions): Promise<LetterPage>;
	writeLetters(letters: Letter[]): Promise<void>;
	appendLetter(letter: Letter): Promise<void>;

	// --- Identity Cores ---

	readIdentityCores(): Promise<IdentityCore[]>;
	writeIdentityCores(cores: IdentityCore[]): Promise<void>;

	// --- Anchors ---

	readAnchors(): Promise<Anchor[]>;
	writeAnchors(anchors: Anchor[]): Promise<void>;

	/** Bump activation_count (+1) and stamp last_activated for the given anchor ids in one write — not N. */
	touchAnchors(ids: string[]): Promise<void>;

	// --- Desires ---

	readDesires(): Promise<Desire[]>;
	writeDesires(desires: Desire[]): Promise<void>;

	// --- Wake Log (append-only) ---

	appendWakeLog(entry: WakeLogEntry): Promise<void>;
	readWakeLog(): Promise<WakeLogEntry[]>;

	// --- Conversation Context ---

	readConversationContext(): Promise<unknown>;
	writeConversationContext(context: unknown): Promise<void>;

	// --- Relational State ---

	readRelationalState(): Promise<RelationalState[]>;
	writeRelationalState(states: RelationalState[]): Promise<void>;

	// --- Subconscious ---

	readSubconscious(): Promise<SubconsciousState | null>;
	writeSubconscious(state: SubconsciousState): Promise<void>;

	// --- Triggers ---

	readTriggers(): Promise<TriggerCondition[]>;
	writeTriggers(triggers: TriggerCondition[]): Promise<void>;

	// --- Consent ---

	readConsent(): Promise<ConsentState>;
	writeConsent(consent: ConsentState): Promise<void>;

	// --- Backfill Tracking ---

	readBackfillFlag(version: string): Promise<unknown>;
	writeBackfillFlag(version: string, data: unknown): Promise<void>;

	// --- Territory Overviews (Phase B) ---

	readOverviews(): Promise<TerritoryOverview[]>;
	writeOverviews(overviews: TerritoryOverview[]): Promise<void>;

	// --- Iron Grip Index (Phase B) ---

	readIronGripIndex(): Promise<IronGripEntry[]>;
	writeIronGripIndex(entries: IronGripEntry[]): Promise<void>;
	appendIronGripEntry(entry: IronGripEntry): Promise<void>;

	// --- Entities ---

	createEntity(entity: Omit<Entity, 'id' | 'created_at' | 'updated_at'>): Promise<Entity>;
	findEntityByName(name: string): Promise<Entity | null>;
	findEntityById(id: string): Promise<Entity | null>;
	findEntitiesByIds?(ids: string[]): Promise<Entity[]>;
	listEntities(filter?: EntityFilter): Promise<Entity[]>;
	updateEntity(id: string, updates: Partial<Pick<Entity, 'name' | 'entity_type' | 'tags' | 'salience' | 'primary_context'>>): Promise<Entity>;

	// --- Project Dossiers ---

	createProjectDossier(dossier: Omit<ProjectDossier, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>): Promise<ProjectDossier>;
	getProjectDossier(projectEntityId: string): Promise<ProjectDossier | null>;
	listProjectDossiers(filter?: ProjectDossierFilter): Promise<ProjectDossier[]>;
	updateProjectDossier(
		projectEntityId: string,
		updates: Partial<Pick<ProjectDossier, 'lifecycle_status' | 'summary' | 'goals' | 'constraints' | 'decisions' | 'open_questions' | 'next_actions' | 'metadata' | 'last_active_at'>>
	): Promise<ProjectDossier>;

	// --- Agent Capability Manifests ---

	createAgentCapabilityManifest(manifest: Omit<AgentCapabilityManifest, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>): Promise<AgentCapabilityManifest>;
	getAgentCapabilityManifest(agentEntityId: string): Promise<AgentCapabilityManifest | null>;
	listAgentCapabilityManifests(filter?: AgentCapabilityManifestFilter): Promise<AgentCapabilityManifest[]>;
	updateAgentCapabilityManifest(
		agentEntityId: string,
		updates: Partial<Pick<AgentCapabilityManifest, 'version' | 'delegation_mode' | 'router_agent_entity_id' | 'supports_streaming' | 'accepted_output_modes' | 'protocols' | 'skills' | 'metadata'>>
	): Promise<AgentCapabilityManifest>;

	// --- Relations ---

	createRelation(relation: Omit<Relation, 'id' | 'created_at' | 'updated_at'>): Promise<Relation>;
	getEntityRelations(entityId: string): Promise<Relation[]>;

	// --- Entity-Observation Linking ---

	linkObservationToEntity(observationId: string, entityId: string): Promise<void>;
	getEntityObservations(entityId: string, limit?: number): Promise<{ observation: Observation; territory: string }[]>;
	/** Batch-fetch observations for multiple entity IDs in a single query. */
	batchGetEntityObservations(entityIds: string[], limitPerEntity?: number, touchedAfter?: string): Promise<Map<string, { observation: Observation; territory: string }[]>>;
	/** Count an entity's full bounded corpus without loading observations into JS. */
	countEntityObservations(entityIds: string[]): Promise<Map<string, { total: number; metabolized: number }>>;

	/**
	 * Backfill helper: return all observations that have entity_tags set but no entity_id yet.
	 * Returns minimal rows — only id and entity_tags. Used by the backfill action in mind_entity.
	 */
	queryEntityTagsForBackfill(): Promise<Array<{ id: string; entity_tags: string[] }>>;

	// --- Daemon Proposals ---

	createProposal(proposal: Omit<DaemonProposal, 'id' | 'proposed_at'>): Promise<DaemonProposal>;
	/**
	 * `order` defaults to "newest" (`proposed_at DESC`) — every pre-existing caller
	 * (mind_propose's review list, kit-hygiene's recent-consolidations read,
	 * absorption's pending sweep) keeps that behavior unchanged. Pass "oldest" to
	 * push `proposed_at ASC` into the SQL LIMIT itself — needed wherever the queue
	 * is deep enough that LIMIT truncates before a caller-side sort could reach the
	 * old end (ops/ADR-JANITOR.md §0.5: the AI reviewer's FIFO fix, ai-review.ts).
	 */
	listProposals(type?: string, status?: string, limit?: number, order?: 'newest' | 'oldest'): Promise<DaemonProposal[]>;
	getProposalById(id: string): Promise<DaemonProposal | null>;
	reviewProposal(id: string, status: 'accepted' | 'rejected', feedbackNote?: string): Promise<DaemonProposal>;
	getProposalStats(): Promise<Record<string, { total: number; accepted: number; rejected: number; ratio: number }>>;
	proposalExists(type: string, sourceId: string, targetId: string): Promise<boolean>;
	/** Batch-check whether proposals exist for multiple (type, source, target) triples. Returns a Set of keys that exist. */
	batchProposalExists(checks: Array<{ type: string; sourceId: string; targetId: string }>): Promise<Set<string>>;
	/**
	 * DELETE (not reject) pending proposals of an expirable type older than `days`,
	 * plus a one-time backfill of proposals a previous, buggier version of this
	 * method mis-tombstoned as 'rejected'. See EXPIRABLE_PROPOSAL_TYPES
	 * (types.ts) and ops/ADR-JANITOR.md §1: a pending proposal nobody reviewed is
	 * not a rejection, and the old UPDATE...status='rejected' silently blocked its
	 * own regeneration forever via the status-blind unique index. Returns the total
	 * row count deleted across both operations.
	 */
	expireStaleProposals(days: number): Promise<number>;

	// --- Orphan Management ---

	/**
	 * Single-id form. No caller in this codebase uses it — the daemon marks in
	 * batches. Retained as part of the published storage contract (this interface is
	 * what a self-hoster implements), NOT because a one-off caller exists.
	 */
	markOrphan(observationId: string): Promise<void>;
	/**
	 * Batch equivalent of markOrphan — one write for the whole set instead of one per id.
	 * Same semantics as markOrphan (already-marked observations are left untouched).
	 * Returns the number of rows actually inserted. This is the form the daemon uses.
	 */
	markOrphans(observationIds: string[]): Promise<number>;
	/**
	 * Least-recently-attempted first in every backend (last_rescue_attempt ASC
	 * NULLS FIRST, first_marked ASC as tiebreak) — the sort decides which orphans
	 * get worked. See ops/ADR-JANITOR.md §1: first_marked ASC alone worked the same
	 * 50 oldest orphans every night, so once those carried tombstoned proposals the
	 * drain moved zero orphans forever. This ordering makes head-of-line blocking
	 * impossible by construction.
	 */
	listOrphans(status?: string, limit?: number): Promise<OrphanObservation[]>;
	/** Single-id form. Retained for the storage contract only — see markOrphan. */
	incrementRescueAttempt(observationId: string): Promise<void>;
	/**
	 * Batch equivalent of incrementRescueAttempt — one write for the whole set.
	 * Returns the number of orphan rows actually updated. This is the form the daemon uses.
	 */
	incrementRescueAttempts(observationIds: string[]): Promise<number>;
	updateOrphanStatus(observationId: string, status: 'rescued' | 'archived'): Promise<void>;

	// --- Daemon Config ---

	readDaemonConfig(): Promise<DaemonConfig>;
	updateProposalThreshold(threshold: number): Promise<void>;
	/** Merge-replace the daemon_config.data JSON blob (per-tenant free-form daemon state, e.g. last_ai_review). */
	updateDaemonConfigData(data: Record<string, unknown>): Promise<void>;

	// --- Health Queries ---

	getEmbeddingCoverage(): Promise<{ total: number; embedded: number }>;
	getOrphanStats(): Promise<{ orphaned: number; rescued: number; archived: number; oldest_days: number }>;
	getTopCascadePairs(limit?: number): Promise<Array<{ obs_id_a: string; obs_id_b: string; count: number }>>;
	/**
	 * Age (in days, rounded) of the oldest pending proposal across every type, or
	 * null when none are pending — used by brain_health.janitor.proposals
	 * (ops/ADR-JANITOR.md §7). Optional, same fallback convention as
	 * countFoundationalObservations.
	 */
	getOldestPendingProposalDays?(): Promise<number | null>;

	// --- Valence Lexicon (ops/ADR-VALENCE-FLOOR.md, slice 0) ---

	/**
	 * All charge_valence rows for this tenant — read once per nightly run by
	 * both daemon/tasks/valence-lexicon.ts (to find charges without a row yet)
	 * and daemon/tasks/valence-floor.ts (to classify eligibility). Optional,
	 * same predates-this-surface fallback convention as
	 * countFoundationalObservations — a backend/mock lacking this method makes
	 * both tasks no-op rather than throw.
	 */
	readChargeValence?(): Promise<ChargeValenceRow[]>;

	/**
	 * Insert-or-update by (tenant_id, charge) — a charge string is the primary
	 * key, so re-writing an already-classified charge (e.g. nightly
	 * observation_count recount) overwrites in place rather than duplicating.
	 * Optional, same fallback convention as readChargeValence above.
	 */
	upsertChargeValence?(rows: ChargeValenceRow[]): Promise<void>;

	// --- Daemon: find similar unlinked (for proposal generation) ---

	/**
	 * Vector similarity search excluding observations already linked to sourceId
	 * and excluding observations with an existing pending proposal from sourceId.
	 */
	findSimilarUnlinked(sourceId: string, limit: number): Promise<Array<{ observation: Observation; territory: string; similarity: number }>>;

	/**
	 * ops/ADR-JANITOR.md §6.2 — findSimilarUnlinked minus its two exclusion CTEs
	 * (already_linked, pending_proposals), plus a similarity floor pushed into
	 * SQL. Deliberately does NOT exclude already-linked targets: a duplicate pair
	 * the orphan-rescue linker already linked is exactly what dedup needs to see
	 * (§0.4 item 3 — the opposite requirement from link discovery). Raw cosine,
	 * not a fused hybridSearch score. This method's own SQL predicates
	 * (tenant_id, id != sourceId, embedding IS NOT NULL) are structural, not
	 * protective. Protection-list filtering (foundational, territory='self',
	 * anchor target, metabolized — §6.4) is entirely the caller's job
	 * (daemon/tasks/dedup.ts's isProtected()) — the OPPOSITE division of labor
	 * from findSalienceRegradeCandidates, which embeds its full protection list
	 * as SQL predicates. Not arbitrary: dedup's protection applies to BOTH sides
	 * of a candidate pair, and the caller — not this method — decides which
	 * observation is scanned as the source, so the caller must check the
	 * source's protection status regardless of what this method returns about
	 * candidates. Splitting candidate-protection into SQL here and
	 * source-protection into the caller would fragment one rule across two
	 * layers; keeping both checks together in the caller keeps the rule
	 * symmetric. Optional, same predates-this-surface fallback convention as
	 * countFoundationalObservations.
	 */
	findSimilarByEmbedding?(sourceId: string, limit: number, minSimilarity: number): Promise<Array<{ observation: Observation; territory: string; similarity: number }>>;

	/**
	 * Return observations that are orphan candidates: no entity_id, access_count <= 1,
	 * created before the cutoff, and not already in orphan_observations.
	 * All filtering is done in SQL — no links loaded into JS memory.
	 *
	 * `cutoffDate` is a StateWindow (age threshold, computed from the clock —
	 * "created before now minus N days"), branded so a caller cannot pass an
	 * ArrivalBoundary here by accident. `arrival`, if given, is an ADDITIONAL
	 * restriction ("and also touched since the last successful run") layered on
	 * top of the age check — ops/ADR-JANITOR.md §2.1 "instance sixteen": pairing
	 * a state-window predicate with a recent-arrival requirement is close to
	 * self-defeating for an orphan query specifically (orphans are, by
	 * definition, the rows nobody has touched), which is why orphans.ts (the
	 * only current caller) never passes it. Kept as an optional param, not
	 * removed, for a caller with a genuinely different need; implementations
	 * MUST throw if both are given and `arrival > cutoffDate` — see each
	 * backend's implementation for the exact guard.
	 */
	findOrphanCandidates(cutoffDate: StateWindow, limit: number, arrival?: ArrivalBoundary): Promise<Observation[]>;

	/**
	 * Candidates for ops/ADR-JANITOR.md §5's salience_regrade proposal: foundational
	 * salience, territory != 'self', access_count <= 1, created before minAgeCutoff,
	 * last_surfaced_at null or before surfacedCutoff (a plain observations column
	 * written by updateSurfacingEffects, NOT inside texture — ops/ADR-JANITOR.md
	 * §5.2 says "texture->>'last_surfaced_at'", which is imprecise for Postgres:
	 * updateSurfacingEffects's jsonb_set only ever mirrors novelty_score into
	 * texture, never last_surfaced_at), charge_phase not
	 * 'metabolized' (§2.1), and none of: an anchor's triggers_memory_id target, a
	 * prior salience_regrade proposal in ANY status (§5.5's anti-nag guarantee —
	 * rejection must be permanent), a source of an accepted consolidation, present
	 * in a captured skill artifact's metabolized_observation_ids, or linked
	 * (inbound or outbound). All filtering in SQL, ordered oldest-first — the
	 * caller re-sorts by calculatePullStrength ascending (§5.2's actual ranking
	 * key) and applies its own batch limit.
	 *
	 * Deliberately NOT readFoundationalObservations() — that method ranks by
	 * calculatePullStrength DESC and caps at FOUNDATIONAL_LANE_CAP (ops/ADR-JANITOR.md
	 * §5.1, fixed from an earlier `ORDER BY created_at DESC LIMIT 200` that truncated
	 * by recency ahead of any ranking), so it keeps the MOST-alive rows and drops the
	 * rest; this task exists specifically to reach the LEAST-alive foundational rows —
	 * the same population approached from the opposite end, for the opposite purpose
	 * (§5.2 sorts these candidates by calculatePullStrength ASCENDING, the mirror of
	 * the lane's own DESCENDING sort). Optional, same predates-this-surface fallback
	 * convention as countFoundationalObservations.
	 */
	findSalienceRegradeCandidates?(minAgeCutoff: string, surfacedCutoff: string, limit: number): Promise<Observation[]>;

	// --- Observation Versions (Sprint 6) ---

	/** Snapshot current content+texture before an edit. Returns the created version. */
	createVersion(observationId: string, content: string, texture: Observation["texture"], changeReason?: string): Promise<ObservationVersion>;

	/** Return version history for an observation, oldest first. */
	getVersionHistory(observationId: string): Promise<ObservationVersion[]>;

	// --- Processing Log (Sprint 6) ---

	/** Record an engagement with an observation (mind_pull with process:true). */
	createProcessingEntry(entry: Omit<ProcessingEntry, 'id' | 'tenant_id' | 'created_at'>): Promise<ProcessingEntry>;

	/** List processing log entries for an observation, newest first. */
	listProcessingEntries(observationId: string, limit?: number): Promise<ProcessingEntry[]>;

	/** Increment processing_count on an observation by 1 (called after createProcessingEntry). */
	incrementProcessingCount(observationId: string): Promise<number>;

	/** Advance charge_phase for an observation based on processing count thresholds. */
	advanceChargePhase(observationId: string): Promise<{ advanced: boolean; new_phase?: string }>;

	// --- Consolidation Candidates (Sprint 6) ---

	/** Create a new consolidation candidate. */
	createConsolidationCandidate(candidate: Omit<ConsolidationCandidate, 'id' | 'tenant_id' | 'created_at' | 'reviewed_at'>): Promise<ConsolidationCandidate>;

	/** List consolidation candidates, optionally filtered by status. */
	listConsolidationCandidates(status?: string, limit?: number): Promise<ConsolidationCandidate[]>;

	/** Accept, reject, or defer a consolidation candidate. */
	reviewConsolidationCandidate(id: string, status: 'accepted' | 'rejected' | 'deferred'): Promise<ConsolidationCandidate>;

	// --- Dispatch Feedback (Sprint 6) ---

	/** Record a dispatch feedback entry (Karpathy scalar). */
	recordDispatch(entry: Omit<DispatchFeedback, 'id' | 'tenant_id' | 'dispatched_at'>): Promise<DispatchFeedback>;

	/** Get aggregated dispatch stats grouped by task_type. */
	getDispatchStats(agentEntityId?: string): Promise<DispatchStat[]>;

	// --- Tasks (Sprint 6 schema — Sprint 7 wiring) ---

	/** Create a new task. */
	createTask(task: Omit<Task, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>): Promise<Task>;

	/** List tasks with optional status and priority filters. When includeAssigned is true, also returns tasks assigned to this tenant from other tenants. */
	listTasks(status?: string, priority?: string, limit?: number, includeAssigned?: boolean): Promise<Task[]>;

	/** List tasks created or updated since the provided timestamp. */
	listTaskChangesSince(since: string, limit?: number, includeAssigned?: boolean): Promise<Task[]>;

	/** Update task fields (status, priority, description, etc). When includeAssigned is true, also allows updating tasks assigned to this tenant from other tenants. */
	updateTask(id: string, updates: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'estimated_effort' | 'scheduled_wake' | 'completion_note' | 'completed_at'>>, includeAssigned?: boolean): Promise<Task>;

	/** Bulk-open due scheduled tasks in wake-time order. Returns number of tasks advanced to open. */
	openDueScheduledTasks(nowIso?: string, limit?: number): Promise<number>;

	/** Get a single task by ID. When includeAssigned is true, also returns tasks assigned to this tenant from other tenants. */
	getTask(id: string, includeAssigned?: boolean): Promise<Task | null>;

	// --- Captured Skill Registry (Sprint 9) ---

	/** Create a captured skill artifact candidate/version from runtime/task provenance. */
	createCapturedSkillArtifact(artifact: CapturedSkillArtifactCreate): Promise<CapturedSkillArtifact>;

	/** Fetch one captured skill artifact by id. */
	getCapturedSkillArtifact(id: string): Promise<CapturedSkillArtifact | null>;

	/** List captured skill artifacts with optional status/layer/provenance filters. */
	listCapturedSkillArtifacts(filter?: CapturedSkillArtifactFilter): Promise<CapturedSkillArtifact[]>;

	/** Review/publish lifecycle state changes (candidate→accepted, accepted→degraded/retired, etc). */
	reviewCapturedSkillArtifact(
		id: string,
		status: CapturedSkillArtifact["status"],
		reviewedBy?: string,
		reviewNote?: string
	): Promise<CapturedSkillArtifact>;

	/** Aggregate captured skill health diagnostics for status/layer/provenance coverage. */
	getCapturedSkillRegistryHealth(): Promise<CapturedSkillRegistryHealth>;

	// --- Runtime ledger (Sprint 8) ---

	/** Upsert active session state for a tenant-scoped agent runtime. */
	upsertAgentRuntimeSession(
		session: Omit<AgentRuntimeSession, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>
	): Promise<AgentRuntimeSession>;

	/** Read latest session state for a tenant-scoped agent runtime. */
	getAgentRuntimeSession(agentTenant: string): Promise<AgentRuntimeSession | null>;

	/** Append one runtime ledger row. */
	createAgentRuntimeRun(
		run: Omit<AgentRuntimeRun, 'id' | 'tenant_id' | 'created_at'>
	): Promise<AgentRuntimeRun>;

	/** List recent runtime ledger rows for one tenant-scoped agent runtime. */
	listAgentRuntimeRuns(agentTenant: string, limit?: number): Promise<AgentRuntimeRun[]>;

	/** Upsert runtime execution policy for one tenant-scoped agent runtime. */
	upsertAgentRuntimePolicy(
		policy: Omit<AgentRuntimePolicy, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>
	): Promise<AgentRuntimePolicy>;

	/** Read runtime execution policy for one tenant-scoped agent runtime. */
	getAgentRuntimePolicy(agentTenant: string): Promise<AgentRuntimePolicy | null>;

	/** Read runtime usage counters since the given timestamp (ISO). */
	getAgentRuntimeUsage(agentTenant: string, since: string): Promise<AgentRuntimeUsage>;

	/** Get the most recent wake log entry, newest first. */
	readLatestWakeLog(): Promise<WakeLogEntry | null>;

	// --- Agent House Trust Layer (v1.8) ---

	/** Upsert a server-side lease ledger row by tenant+lease_id. */
	recordAgentLease(
		lease: Omit<AgentLeaseRecord, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>
	): Promise<AgentLeaseRecord>;

	/** Fetch a lease ledger row by external lease_id. */
	getAgentLease(leaseId: string): Promise<AgentLeaseRecord | null>;

	/** Stamp a heartbeat for an active lease. Returns null when not found. */
	heartbeatAgentLease(leaseId: string, processId?: string): Promise<AgentLeaseRecord | null>;

	/** Mark all active leases for a process as expired/revoked. */
	expireAgentLeasesForProcess(processId: string, status?: 'expired' | 'revoked'): Promise<number>;

	/** Mark active leases whose expires_at is in the past as expired. */
	reapExpiredAgentLeases(nowIso?: string): Promise<number>;

	/** Append one audit event. Diffs go in event.diff; avoid full snapshots. */
	createAgentAuditEvent(
		event: Omit<AgentAuditEvent, 'id' | 'tenant_id' | 'created_at'>
	): Promise<AgentAuditEvent>;

	/** List recent audit events for review/reconciliation. */
	listAgentAuditEvents(filter?: AgentAuditEventFilter): Promise<AgentAuditEvent[]>;

	// --- Limbic Config (Phase 1) ---

	/**
	 * Return the limbic feature config for this tenant.
	 * Returns null when no row exists (feature off by default).
	 * `natal` is reserved for Phase 2 — not read in Phase 1.
	 */
	getLimbicConfig(): Promise<{ enabled: boolean; natal: unknown } | null>;
}
