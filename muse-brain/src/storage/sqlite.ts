// ============ SQLITE BRAIN STORAGE ============
// Self-host focused backend for local deployments.
//
// Design notes:
// - Uses node:sqlite (dynamic import) so Cloudflare workers are unaffected unless backend=sqlite.
// - Persists tenant-scoped JSON documents in a small key/value SQLite table.
// - Favors correctness/portability over raw query performance.

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

import {
	VALID_TERRITORIES,
	HARD_BOUNDARIES,
	RELATIONSHIP_GATES,
	CIRCADIAN_PHASES,
	ALLOWED_TENANTS,
	FOUNDATIONAL_LANE_CAP
} from "../constants";
import { EXPIRABLE_PROPOSAL_TYPES } from "../types";
import { isAllowedTenant, normalizeAllowedTenants } from "./tenant-scope";

import { getTimestamp, calculateMomentumDecay, calculateAfterglowFade, generateId, rankFoundationalByPullStrength } from "../helpers";
import {
	DEFAULT_RETRIEVAL_PROFILE,
	getRetrievalProfileConfig,
	normalizeRetrievalProfile,
	extractQuerySignals,
	validateProfileOverrides,
	computeSignalDocumentFrequency
} from "../retrieval/query-signals";
import {
	scoreHybridCandidate,
	scoreHybridCandidateLegacy,
	resolveCandidatePoolForProfile,
	type ScoringPlan,
	type CandidateSetStats
} from "../retrieval/scoring";
import type { RetrievalHintArtifact } from "../retrieval/hints";
import {
	buildInitialRetrievalHints,
	computeRetrievalHintMatch,
	deriveQueryHintTerms
} from "../retrieval/hints";
import { applyRetrievalRerank } from "../retrieval/rerank";
import { proposalKey } from "./keys";
import { applyDecaySemantics } from "../daemon/decay";
import { assertArrivalNotAfterCutoff } from "../daemon/types";
import type { ArrivalBoundary, StateWindow } from "../daemon/types";

import type {
	IBrainStorage,
	ObservationFilter,
	SimilarSearchOptions,
	SimilarResult,
	HybridSearchOptions,
	HybridSearchResult,
	LaneProbeOptions,
	LaneProbeResult,
	TextureUpdate
} from "./interface";

type SqliteDb = {
	exec: (sql: string) => void;
	prepare: (sql: string) => {
		run: (...args: any[]) => any;
		get: (...args: any[]) => any;
		all: (...args: any[]) => any[];
	};
};

type StoredObservation = Observation & {
	embedding?: number[];
	entity_tags?: string[];
	processing_count?: number;
	surface_count?: number;
	novelty_score?: number;
};

type CascadePair = { obs_id_a: string; obs_id_b: string; count: number; last_co_surfaced?: string };

type DbPromises = {
	dbPromise: Promise<SqliteDb>;
};

const KV_KEYS = {
	observations: "observations",
	open_loops: "open_loops",
	links: "links",
	letters: "letters",
	identity_cores: "identity_cores",
	anchors: "anchors",
	desires: "desires",
	wake_log: "wake_log",
	conversation_context: "conversation_context",
	relational_states: "relational_states",
	subconscious: "subconscious",
	triggers: "triggers",
	consent: "consent",
	backfill_flags: "backfill_flags",
	territory_overviews: "territory_overviews",
	iron_grip_index: "iron_grip_index",
	entities: "entities",
	relations: "relations",
	project_dossiers: "project_dossiers",
	agent_capability_manifests: "agent_capability_manifests",
	daemon_proposals: "daemon_proposals",
	orphan_observations: "orphan_observations",
	daemon_config: "daemon_config",
	observation_versions: "observation_versions",
	processing_log: "processing_log",
	consolidation_candidates: "consolidation_candidates",
	dispatch_feedback: "dispatch_feedback",
	tasks: "tasks",
	captured_skills: "captured_skills",
	runtime_sessions: "runtime_sessions",
	runtime_runs: "runtime_runs",
	runtime_policies: "runtime_policies",
	agent_leases: "agent_leases",
	agent_audit_events: "agent_audit_events",
	memory_cascade: "memory_cascade",
	retrieval_hints: "retrieval_hints",
	limbic_config: "limbic_config",
	charge_valence: "charge_valence"
} as const;

function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

function toMillis(iso?: string): number {
	if (!iso) return 0;
	const n = Date.parse(iso);
	return Number.isFinite(n) ? n : 0;
}

function cosineSimilarity(a: number[], b: number[]): number {
	if (!a.length || !b.length || a.length !== b.length) return 0;
	let dot = 0;
	let magA = 0;
	let magB = 0;
	for (let i = 0; i < a.length; i++) {
		const av = a[i] || 0;
		const bv = b[i] || 0;
		dot += av * bv;
		magA += av * av;
		magB += bv * bv;
	}
	if (magA === 0 || magB === 0) return 0;
	return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.map(t => t.trim())
		.filter(Boolean);
}

function nowIso(): string {
	return getTimestamp();
}

/**
 * One candidate as it enters a lane pool. Module-scope (not method-local) because
 * `generateLaneCandidates`, `hybridSearch`, and `probeLanes` all share this shape —
 * lifted out of hybridSearch so probeLanes can reuse the exact same seed-building
 * logic instead of a second hand-maintained copy.
 */
interface CandidateSeed {
	obs: StoredObservation;
	keywordRank: number;
	vectorSimilarity?: number;
	hasEntityMatch: boolean;
	hintScore: number;
	hintMatchedTypes: string[];
}

async function initSqlite(path: string): Promise<SqliteDb> {
	let sqliteModule: any;
	try {
		const moduleName = "node:sqlite";
		sqliteModule = await import(moduleName);
	} catch (err) {
		throw new Error(`SQLite backend unavailable in this runtime: ${err instanceof Error ? err.message : "unknown"}`);
	}

	const DatabaseSync = sqliteModule?.DatabaseSync ?? sqliteModule?.default?.DatabaseSync;
	if (!DatabaseSync) {
		throw new Error("SQLite backend unavailable: DatabaseSync export missing");
	}

	const db = new DatabaseSync(path || "./muse-brain.sqlite") as SqliteDb;
	db.exec(`
		PRAGMA journal_mode=WAL;
		PRAGMA synchronous=NORMAL;
		PRAGMA temp_store=MEMORY;
		CREATE TABLE IF NOT EXISTS kv_store (
			tenant_id TEXT NOT NULL,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, key)
		);
	`);
	return db;
}

export class SQLiteBrainStorage implements IBrainStorage {
	private readonly sqlitePath: string;
	private readonly tenant: string;
	private readonly dbPromise: Promise<SqliteDb>;

	constructor(sqlitePath: string, tenant: string, shared?: DbPromises, allowedTenants: readonly string[] = ALLOWED_TENANTS) {
		this.allowedTenants = normalizeAllowedTenants(allowedTenants);
		if (!isAllowedTenant(tenant, this.allowedTenants)) {
			throw new Error(`Invalid tenant: ${tenant}`);
		}

		const normalizedPath = sqlitePath || "./muse-brain.sqlite";
		if (normalizedPath.includes("\0")) {
			throw new Error("Invalid sqlite path");
		}

		this.sqlitePath = normalizedPath;
		this.tenant = tenant;
		this.dbPromise = shared?.dbPromise ?? initSqlite(this.sqlitePath);
	}

	private readonly allowedTenants: readonly string[];

	private async db(): Promise<SqliteDb> {
		return this.dbPromise;
	}

	private toPublicObservation(obs: StoredObservation): Observation {
		const {
			embedding: _embedding,
			entity_tags: _entity_tags,
			processing_count: _processing_count,
			surface_count: _surface_count,
			novelty_score: _novelty_score,
			...publicObs
		} = obs;
		// last_surfaced_at is a real Observation field (ops/ADR-JANITOR.md §2.1 instance
		// nine, commit 7c) — it stays in publicObs now, deliberately not destructured out.
		return publicObs as Observation;
	}

	private normalizeObservation(obs: StoredObservation): StoredObservation {
		const texture = obs.texture ?? {
			salience: "active",
			vividness: "vivid",
			charge: [],
			grip: "present"
		};
		return {
			...obs,
			territory: obs.territory,
			created: obs.created ?? nowIso(),
			access_count: obs.access_count ?? 0,
			links: asArray<string>(obs.links),
			tags: asArray<string>(obs.tags),
			texture: {
				...texture,
				charge: asArray<string>(texture.charge)
			},
			embedding: Array.isArray(obs.embedding) ? obs.embedding.filter(n => typeof n === "number") : undefined,
			entity_tags: asArray<string>(obs.entity_tags),
			processing_count: typeof obs.processing_count === "number" ? obs.processing_count : 0,
			surface_count: typeof obs.surface_count === "number" ? obs.surface_count : 0,
			novelty_score: typeof obs.novelty_score === "number"
				? obs.novelty_score
				: (typeof texture.novelty_score === "number" ? texture.novelty_score : 1.0)
		};
	}

	private deriveHintsForObservation(obs: StoredObservation): RetrievalHintArtifact[] {
		return buildInitialRetrievalHints({
			id: obs.id,
			content: obs.content,
			summary: obs.summary,
			context: obs.context,
			mood: obs.mood,
			territory: obs.territory,
			type: obs.type,
			created: obs.created,
			entity_id: obs.entity_id,
			tags: obs.tags
		});
	}

	private async readValue<T>(key: string, fallback: T): Promise<T> {
		const db = await this.db();
		const row = db.prepare("SELECT value FROM kv_store WHERE tenant_id = ? AND key = ? LIMIT 1").get(this.tenant, key) as { value?: string } | undefined;
		if (!row?.value) return deepClone(fallback);
		try {
			return JSON.parse(row.value) as T;
		} catch (err) {
			// A parse failure here (corruption, partial write, truncation) would otherwise
			// be indistinguishable from "genuinely empty" — log so a future occurrence
			// leaves a trace instead of silence. Fallback behavior is unchanged.
			console.error(`readValue: failed to parse stored JSON for key "${key}":`, err instanceof Error ? err.message : err);
			return deepClone(fallback);
		}
	}

	private async writeValue<T>(key: string, value: T): Promise<void> {
		const db = await this.db();
		db.prepare(
			"INSERT INTO kv_store (tenant_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
		).run(this.tenant, key, JSON.stringify(value), nowIso());
	}

	private async readCollection<T>(key: string): Promise<T[]> {
		const value = await this.readValue<T[]>(key, []);
		return Array.isArray(value) ? value : [];
	}

	private async writeCollection<T>(key: string, items: T[]): Promise<void> {
		await this.writeValue(key, items);
	}

	/**
	 * Observation mutation helper.
	 *
	 * Default mode is in-place mutation of the provided `observations` array.
	 * For full-array rewrites, mutators can call `replace(next)` explicitly.
	 */
	private async withObservations<T>(
		mutator: (observations: StoredObservation[], replace: (next: StoredObservation[]) => void) => Promise<T> | T
	): Promise<T> {
		let observations = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));
		const replace = (next: StoredObservation[]) => {
			observations = next.map(o => this.normalizeObservation(o));
		};

		const result = await mutator(observations, replace);
		await this.writeCollection(KV_KEYS.observations, observations);
		return result;
	}

	private defaultConsent(): ConsentState {
		return {
			user_consent: [],
			ai_boundaries: {
				hard: [...HARD_BOUNDARIES],
				relationship_gated: { ...RELATIONSHIP_GATES }
			},
			relationship_level: "stranger",
			log: []
		};
	}

	private defaultDaemonConfig(): DaemonConfig {
		return {
			tenant_id: this.tenant,
			link_proposal_threshold: 0.75,
			data: {}
		};
	}

	// ============ TENANT ============

	getTenant(): string {
		return this.tenant;
	}

	getAllowedTenants(): readonly string[] {
		return this.allowedTenants;
	}

	forTenant(tenant: string): IBrainStorage {
		if (!isAllowedTenant(tenant, this.allowedTenants)) {
			throw new Error("Invalid tenant");
		}
		return new SQLiteBrainStorage(this.sqlitePath, tenant, { dbPromise: this.dbPromise }, this.allowedTenants);
	}

	// ============ TERRITORY VALIDATION ============

	validateTerritory(territory: string): string {
		if (!VALID_TERRITORIES.includes(territory)) {
			throw new Error("Invalid territory");
		}
		return territory;
	}

	// ============ BRAIN STATE ============

	async readBrainState(): Promise<BrainState> {
		const defaultState: BrainState = {
			current_mood: "neutral",
			energy_level: 0.7,
			last_updated: nowIso(),
			momentum: { current_charges: [], intensity: 0, last_updated: nowIso() },
			afterglow: { residue_charges: [] }
		};
		const stored = await this.readValue<Partial<BrainState>>("brain_state", defaultState);
		const state: BrainState = {
			current_mood: stored.current_mood ?? defaultState.current_mood,
			energy_level: stored.energy_level ?? defaultState.energy_level,
			last_updated: stored.last_updated ?? defaultState.last_updated,
			momentum: stored.momentum ?? defaultState.momentum,
			afterglow: stored.afterglow ?? defaultState.afterglow
		};
		if (!state.momentum.last_updated) {
			state.momentum.last_updated = nowIso();
		}
		state.momentum = calculateMomentumDecay(state.momentum);
		state.afterglow = calculateAfterglowFade(state.afterglow);
		return state;
	}

	async writeBrainState(state: BrainState): Promise<void> {
		state.last_updated = nowIso();
		await this.writeValue("brain_state", state);
	}

	// ============ TERRITORIES ============

	async readTerritory(territory: string): Promise<Observation[]> {
		this.validateTerritory(territory);
		const observations = (await this.readCollection<StoredObservation>(KV_KEYS.observations))
			.map(o => this.normalizeObservation(o))
			.filter(o => o.territory === territory)
			.sort((a, b) => toMillis(a.created) - toMillis(b.created));
		return observations.map(o => this.toPublicObservation(o));
	}

	async writeTerritory(territory: string, observations: Observation[]): Promise<void> {
		this.validateTerritory(territory);
		const existingTerritoryIds = new Set(
			(await this.readCollection<StoredObservation>(KV_KEYS.observations))
				.map(o => this.normalizeObservation(o))
				.filter(o => o.territory === territory)
				.map(o => o.id)
		);

		await this.withObservations(async all => {
			for (let i = all.length - 1; i >= 0; i--) {
				if (all[i].territory === territory) all.splice(i, 1);
			}
			for (const obs of observations) {
				all.push(this.normalizeObservation({ ...obs, territory } as StoredObservation));
			}
		});

		const hints = await this.readCollection<RetrievalHintArtifact>(KV_KEYS.retrieval_hints);
		const filtered = hints.filter(hint => !existingTerritoryIds.has(hint.observation_id));
		const replacementHints = observations.flatMap(obs =>
			this.deriveHintsForObservation(this.normalizeObservation({ ...obs, territory } as StoredObservation))
		);
		await this.writeCollection(KV_KEYS.retrieval_hints, [...filtered, ...replacementHints]);
	}

	async appendToTerritory(territory: string, observation: Observation): Promise<void> {
		this.validateTerritory(territory);
		const normalized = this.normalizeObservation({ ...observation, territory } as StoredObservation);
		await this.withObservations(async all => {
			all.push(normalized);
		});

		const hints = await this.readCollection<RetrievalHintArtifact>(KV_KEYS.retrieval_hints);
		const filtered = hints.filter(hint => hint.observation_id !== normalized.id);
		await this.writeCollection(KV_KEYS.retrieval_hints, [...filtered, ...this.deriveHintsForObservation(normalized)]);
	}

	async readAllTerritories(): Promise<{ territory: string; observations: Observation[] }[]> {
		const all = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));
		return VALID_TERRITORIES.map(territory => ({
			territory,
			observations: all
				.filter(o => o.territory === territory)
				.sort((a, b) => toMillis(a.created) - toMillis(b.created))
				.map(o => this.toPublicObservation(o))
		}));
	}

	async findObservation(id: string): Promise<{ observation: Observation; territory: string } | null> {
		const obs = (await this.readCollection<StoredObservation>(KV_KEYS.observations))
			.map(o => this.normalizeObservation(o))
			.find(o => o.id === id);
		if (!obs) return null;
		return { observation: this.toPublicObservation(obs), territory: obs.territory };
	}

	// ============ OBSERVATION QUERIES ============

	async queryObservations(filter: ObservationFilter): Promise<{ observation: Observation; territory: string }[]> {
		const limit = Math.max(1, filter.limit ?? 100);
		const offset = filter.offset ?? 0;
		const orderBy = filter.order_by ?? "created";
		const orderDir = filter.order_dir ?? "desc";

		let rows = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));

		if (filter.territory) rows = rows.filter(o => o.territory === filter.territory);
		if (filter.entity_id) rows = rows.filter(o => o.entity_id === filter.entity_id);
		if (filter.grip) rows = rows.filter(o => o.texture?.grip === filter.grip);
		if (filter.charges_all?.length) rows = rows.filter(o => filter.charges_all!.every(c => o.texture?.charge?.includes(c)));
		if (filter.charges_any?.length) rows = rows.filter(o => filter.charges_any!.some(c => o.texture?.charge?.includes(c)));
		if (filter.created_after) rows = rows.filter(o => toMillis(o.created) >= toMillis(filter.created_after));
		if (filter.created_before) rows = rows.filter(o => toMillis(o.created) <= toMillis(filter.created_before));
		if (filter.touched_after) {
			const touchedAfter = toMillis(filter.touched_after);
			rows = rows.filter(o => Math.max(toMillis(o.created), toMillis(o.last_accessed)) >= touchedAfter);
		}
		if (filter.type) rows = rows.filter(o => o.type === filter.type);
		if (filter.tags?.length) rows = rows.filter(o => filter.tags!.some(tag => (o.tags ?? []).includes(tag)));

		rows.sort((a, b) => {
			let av: number | string;
			let bv: number | string;
			if (orderBy === "access_count") {
				av = a.access_count ?? 0;
				bv = b.access_count ?? 0;
			} else if (orderBy === "last_accessed") {
				av = a.last_accessed ?? a.created;
				bv = b.last_accessed ?? b.created;
			} else {
				av = a.created;
				bv = b.created;
			}
			if (av < bv) return orderDir === "asc" ? -1 : 1;
			if (av > bv) return orderDir === "asc" ? 1 : -1;
			return 0;
		});

		return rows.slice(offset, offset + limit).map(o => ({ observation: this.toPublicObservation(o), territory: o.territory }));
	}

	async readFoundationalObservations(): Promise<{ observation: Observation; territory: string }[]> {
		const rows = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));
		// ops/ADR-JANITOR.md §5.1 — ranked by calculatePullStrength via the shared
		// rankFoundationalByPullStrength helper, not recency — parity with postgres.ts's
		// readFoundationalObservations, which ranks the same way for the same reason
		// (buildFoundationLane in wake.ts re-ranks by this exact measure; truncating by
		// recency here first was dropping high-pull-strength old memories before the
		// ranker ever saw them).
		const mapped = rows
			.filter(o => o.texture?.salience === "foundational")
			.map(o => ({ observation: this.toPublicObservation(o), territory: o.territory }));
		return rankFoundationalByPullStrength(mapped, FOUNDATIONAL_LANE_CAP);
	}

	async countFoundationalObservations(): Promise<number> {
		const rows = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));
		return rows.filter(o => o.texture?.salience === "foundational").length;
	}

	async countIronObservations(): Promise<number> {
		const rows = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));
		return rows.filter(o => o.texture?.grip === "iron").length;
	}

	async getChargePhaseCounts(): Promise<{ fresh: number; active: number; processing: number; metabolized: number }> {
		const rows = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));
		const counts = { fresh: 0, active: 0, processing: 0, metabolized: 0 };
		for (const o of rows) {
			const phase = o.texture?.charge_phase;
			if (phase && phase in counts) counts[phase as keyof typeof counts]++;
		}
		return counts;
	}

	async bulkUpdateTexture(updates: TextureUpdate[]): Promise<void> {
		if (!updates.length) return;
		await this.withObservations(async all => {
			const byId = new Map(all.map(o => [o.id, o] as const));
			for (const update of updates) {
				const target = byId.get(update.id);
				if (!target) continue;
				target.texture = { ...target.texture, ...update.texture };
				if (typeof target.texture.novelty_score === "number") {
					target.novelty_score = target.texture.novelty_score;
				}
				if (update.touch) {
					target.access_count = (target.access_count ?? 0) + 1;
					target.last_accessed = nowIso();
				}
			}
		});
	}

	async bulkReplaceTexture(updates: { id: string; texture: Observation["texture"] }[]): Promise<void> {
		if (!updates.length) return;
		await this.withObservations(async all => {
			const byId = new Map(all.map(o => [o.id, o] as const));
			for (const update of updates) {
				const target = byId.get(update.id);
				if (!target) continue;
				target.texture = { ...update.texture, charge: asArray<string>(update.texture?.charge) } as Observation["texture"];
				target.novelty_score = typeof target.texture.novelty_score === "number" ? target.texture.novelty_score : target.novelty_score;
			}
		});
	}

	async runDecay(asOf: Date = new Date()): Promise<number> {
		let changed = 0;
		await this.withObservations(async all => {
			for (const observation of all) {
				if (observation.texture?.salience === "foundational") continue;

				const result = applyDecaySemantics(
					observation.texture,
					observation.last_accessed,
					observation.created,
					asOf
				);
				if (!result.changed) continue;

				observation.texture = result.texture;
				changed++;
			}
		});
		return changed;
	}

	async updateObservationTexture(id: string, texture: Observation["texture"]): Promise<void> {
		await this.bulkReplaceTexture([{ id, texture }]);
	}

	async updateObservationAccess(id: string): Promise<void> {
		await this.withObservations(async all => {
			const target = all.find(o => o.id === id);
			if (!target) return;
			target.access_count = (target.access_count ?? 0) + 1;
			target.last_accessed = nowIso();
		});
	}

	async deleteObservation(id: string): Promise<boolean> {
		let deleted = false;
		await this.withObservations(async all => {
			const idx = all.findIndex(o => o.id === id);
			if (idx >= 0) {
				all.splice(idx, 1);
				deleted = true;
			}
		});
		if (!deleted) return false;

		const links = await this.readCollection<Link>(KV_KEYS.links);
		await this.writeCollection(KV_KEYS.links, links.filter(l => l.source_id !== id && l.target_id !== id));

		const versions = await this.readCollection<ObservationVersion>(KV_KEYS.observation_versions);
		await this.writeCollection(KV_KEYS.observation_versions, versions.filter(v => v.observation_id !== id));

		const processing = await this.readCollection<ProcessingEntry>(KV_KEYS.processing_log);
		await this.writeCollection(KV_KEYS.processing_log, processing.filter(p => p.observation_id !== id));

		const hints = await this.readCollection<RetrievalHintArtifact>(KV_KEYS.retrieval_hints);
		await this.writeCollection(KV_KEYS.retrieval_hints, hints.filter(h => h.observation_id !== id));

		return true;
	}

	// ============ EMBEDDINGS / SEARCH ============

	async updateObservationEmbedding(id: string, embedding: number[]): Promise<void> {
		await this.withObservations(async all => {
			const target = all.find(o => o.id === id);
			if (!target) return;
			target.embedding = embedding;
		});
	}

	async bulkUpdateEmbeddings(updates: Array<{ id: string; embedding: number[] }>): Promise<void> {
		if (!updates.length) return;
		await this.withObservations(async all => {
			const byId = new Map(all.map(o => [o.id, o] as const));
			for (const update of updates) {
				const target = byId.get(update.id);
				if (target) target.embedding = update.embedding;
			}
		});
	}

	async queryUnembedded(limit: number): Promise<{ id: string; content: string }[]> {
		const cap = Math.max(1, Math.min(limit || 50, 500));
		// Mirrors postgres.ts's `content IS NOT NULL AND btrim(content) <> ''` predicate —
		// empty-content rows can never be embedded and must never poison the oldest-first queue.
		const rows = (await this.readCollection<StoredObservation>(KV_KEYS.observations))
			.map(o => this.normalizeObservation(o))
			.filter(o => !o.embedding || !o.embedding.length)
			.filter(o => typeof o.content === "string" && o.content.trim() !== "")
			.slice(0, cap);
		return rows.map(r => ({ id: r.id, content: r.content }));
	}

	async countUnembedded(): Promise<number> {
		// Mirrors queryUnembedded's predicate — actual backfill queue depth, not the coverage
		// denominator (getEmbeddingCoverage counts ALL rows, empty-content included).
		const rows = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));
		return rows
			.filter(o => !o.embedding || !o.embedding.length)
			.filter(o => typeof o.content === "string" && o.content.trim() !== "").length;
	}

	async searchSimilar(options: SimilarSearchOptions): Promise<SimilarResult[]> {
		const limit = Math.max(1, options.limit ?? 10);
		const minSimilarity = options.min_similarity ?? 0;
		const rows = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));

		let filtered = rows.filter(o => Array.isArray(o.embedding) && o.embedding.length === options.embedding.length);
		if (options.territory) filtered = filtered.filter(o => o.territory === options.territory);
		if (options.grip?.length) filtered = filtered.filter(o => options.grip!.includes(o.texture?.grip ?? "present"));

		const scored = filtered
			.map(o => ({
				observation: this.toPublicObservation(o),
				territory: o.territory,
				similarity: cosineSimilarity(options.embedding, o.embedding ?? [])
			}))
			.filter(r => r.similarity >= minSimilarity)
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, limit);

		return scored;
	}

	async findUnlinkedSimilar(id: string, limit = 10): Promise<SimilarResult[]> {
		const source = (await this.readCollection<StoredObservation>(KV_KEYS.observations))
			.map(o => this.normalizeObservation(o))
			.find(o => o.id === id);
		if (!source?.embedding?.length) return [];

		const links = await this.readCollection<Link>(KV_KEYS.links);
		const linked = new Set<string>();
		for (const link of links) {
			if (link.source_id === id) linked.add(link.target_id);
			if (link.target_id === id) linked.add(link.source_id);
		}

		const candidates = await this.searchSimilar({ embedding: source.embedding, limit: Math.max(limit * 3, 30) });
		return candidates.filter(c => c.observation.id !== id && !linked.has(c.observation.id)).slice(0, limit);
	}

	/**
	 * Builds the four lane pools (vector / keyword / entity / hint) from the observation
	 * collection — the sqlite mirror of postgres's `generateLaneCandidates`. Single source
	 * of the seed-building logic (token match, cosine similarity, hint match, sort + slice
	 * per lane); both `hybridSearch` and the read-only `probeLanes` diagnostic call this,
	 * so the two paths can't drift apart. `pools` lets a caller request a different pool
	 * size per lane than a retrieval profile's own candidate_pool config (e.g. probeLanes'
	 * flat `depth`); hybridSearch passes its profile's actual pools.
	 */
	private async generateLaneCandidates(
		options: {
			query?: string;
			embedding?: number[];
			territory?: string;
			grip?: string[];
			charge_phase?: string;
			entity_id?: string;
			queryHintTerms: string[];
		},
		pools: { vector: number; keyword: number; entity: number; hint: number }
	): Promise<{
		vectorSeeds: CandidateSeed[];
		keywordSeeds: CandidateSeed[];
		entitySeeds: CandidateSeed[];
		hintSeeds: CandidateSeed[];
	}> {
		const queryTokens = tokenize(options.query || "");

		let rows = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));
		const hints = await this.readCollection<RetrievalHintArtifact>(KV_KEYS.retrieval_hints);
		const hintsByObservation = new Map<string, RetrievalHintArtifact[]>();
		for (const hint of hints) {
			const bucket = hintsByObservation.get(hint.observation_id);
			if (bucket) bucket.push(hint);
			else hintsByObservation.set(hint.observation_id, [hint]);
		}

		if (options.territory) rows = rows.filter(o => o.territory === options.territory);
		if (options.grip?.length) rows = rows.filter(o => options.grip!.includes(o.texture?.grip ?? "present"));
		if (options.charge_phase) rows = rows.filter(o => (o.texture?.charge_phase ?? "fresh") === options.charge_phase);

		const seeds: CandidateSeed[] = [];
		for (const obs of rows) {
			const body = `${obs.content}\n${obs.summary ?? ""}`.toLowerCase();
			let keywordRank = 0;
			if (queryTokens.length > 0) {
				let matched = 0;
				for (const token of queryTokens) {
					if (body.includes(token)) matched++;
				}
				keywordRank = matched / queryTokens.length;
			}

			const vectorSimilarity = options.embedding && obs.embedding?.length === options.embedding.length
				? cosineSimilarity(options.embedding, obs.embedding)
				: undefined;

			const hasEntityMatch = Boolean(options.entity_id && obs.entity_id === options.entity_id);
			const observationHints = hintsByObservation.get(obs.id) ?? this.deriveHintsForObservation(obs);
			const hintMatch = computeRetrievalHintMatch(observationHints, options.queryHintTerms);
			const hintScore = hintMatch.score;

			if ((vectorSimilarity ?? 0) <= 0 && keywordRank <= 0 && !hasEntityMatch && hintScore <= 0) continue;
			seeds.push({
				obs,
				keywordRank,
				vectorSimilarity,
				hasEntityMatch,
				hintScore,
				hintMatchedTypes: hintMatch.matched_hint_types
			});
		}

		const vectorSeeds = seeds
			.filter(seed => typeof seed.vectorSimilarity === "number" && (seed.vectorSimilarity ?? 0) > 0)
			.sort((a, b) => (b.vectorSimilarity ?? 0) - (a.vectorSimilarity ?? 0))
			.slice(0, pools.vector);
		const keywordSeeds = seeds
			.filter(seed => seed.keywordRank > 0)
			.sort((a, b) => b.keywordRank - a.keywordRank)
			.slice(0, pools.keyword);
		const entitySeeds = seeds
			.filter(seed => seed.hasEntityMatch)
			.sort((a, b) => toMillis(b.obs.created) - toMillis(a.obs.created))
			.slice(0, pools.entity);
		const hintSeeds = seeds
			.filter(seed => seed.hintScore >= 0.08)
			.sort((a, b) => b.hintScore - a.hintScore)
			.slice(0, pools.hint);

		return { vectorSeeds, keywordSeeds, entitySeeds, hintSeeds };
	}

	async hybridSearch(options: HybridSearchOptions): Promise<HybridSearchResult[]> {
		const retrievalProfile = normalizeRetrievalProfile(options.retrieval_profile) ?? DEFAULT_RETRIEVAL_PROFILE;
		// Discriminated on `mode` (not on retrievalProfile again) so the compiler narrows
		// `profile_config` for free below — no `!` needed.
		const scoringPlan: ScoringPlan = retrievalProfile === "legacy"
			? { mode: "legacy" }
			: (() => {
				const baseConfig = getRetrievalProfileConfig(retrievalProfile);
				const overrides = retrievalProfile === "fused" ? options.profile_overrides : undefined;
				if (overrides) validateProfileOverrides(overrides);
				return {
					mode: "rrf" as const,
					profile_config: overrides
						? {
							...baseConfig,
							rrf_k: overrides.rrf_k ?? baseConfig.rrf_k,
							lane_weights: overrides.lane_weights ?? baseConfig.lane_weights
						}
						: baseConfig
				};
			})();
		const limit = Math.max(1, options.limit ?? 10);
		const minSimilarity = options.min_similarity
			?? (scoringPlan.mode === "legacy" ? 0.3 : scoringPlan.profile_config.min_score);
		const querySignals = options.query_signals ?? extractQuerySignals(options.query || "");
		const queryHintTerms = deriveQueryHintTerms({
			query: options.query || "",
			quoted_phrases: querySignals.quoted_phrases,
			proper_names: querySignals.proper_names,
			temporal: querySignals.temporal
		});
		const circadianBias = options.circadian_phase ? new Set(CIRCADIAN_PHASES[options.circadian_phase]?.retrieval_bias ?? []) : new Set<string>();

		const pools = resolveCandidatePoolForProfile(retrievalProfile);
		const { vectorSeeds, keywordSeeds, entitySeeds, hintSeeds } = await this.generateLaneCandidates(
			{
				query: options.query,
				embedding: options.embedding,
				territory: options.territory,
				grip: options.grip,
				charge_phase: options.charge_phase,
				entity_id: options.entity_id,
				queryHintTerms
			},
			{
				vector: pools.vector,
				keyword: pools.keyword,
				entity: pools.entity,
				hint: Math.max(12, Math.floor(pools.keyword * 0.7))
			}
		);

		const candidateMap = new Map<string, CandidateSeed>();
		const mergeSeed = (seed: CandidateSeed): void => {
			const existing = candidateMap.get(seed.obs.id);
			if (!existing) {
				candidateMap.set(seed.obs.id, {
					...seed,
					hintMatchedTypes: Array.from(new Set(seed.hintMatchedTypes))
				});
				return;
			}
			existing.vectorSimilarity = Math.max(existing.vectorSimilarity ?? 0, seed.vectorSimilarity ?? 0) || undefined;
			existing.keywordRank = Math.max(existing.keywordRank, seed.keywordRank);
			existing.hasEntityMatch = existing.hasEntityMatch || seed.hasEntityMatch;
			existing.hintScore = Math.max(existing.hintScore, seed.hintScore);
			existing.hintMatchedTypes = Array.from(new Set([...existing.hintMatchedTypes, ...seed.hintMatchedTypes]));
		};

		for (const seed of [...vectorSeeds, ...keywordSeeds, ...entitySeeds, ...hintSeeds]) {
			mergeSeed(seed);
		}

		// 1-based position within each lane's own already-sorted/sliced pool
		// (array index + 1) — read-only diagnostic map, kept separate from
		// mergeSeed above so it can't perturb scoring.
		const vectorRankById = new Map<string, number>();
		vectorSeeds.forEach((seed, i) => vectorRankById.set(seed.obs.id, i + 1));
		const keywordRankById = new Map<string, number>();
		keywordSeeds.forEach((seed, i) => keywordRankById.set(seed.obs.id, i + 1));
		const entityRankById = new Map<string, number>();
		entitySeeds.forEach((seed, i) => entityRankById.set(seed.obs.id, i + 1));
		const hintRankById = new Map<string, number>();
		hintSeeds.forEach((seed, i) => hintRankById.set(seed.obs.id, i + 1));

		// Legacy-scorer input only (RRF reads lane_positions, never this normalization —
		// ADR §1 "rank in, magnitude out").
		let maxKeywordRank = 0;
		for (const seed of candidateMap.values()) {
			if (seed.keywordRank > maxKeywordRank) maxKeywordRank = seed.keywordRank;
		}

		// Candidate-set statistics for the fused scorer's IDF-weighted signal boosts
		// (ADR §3) — same merged candidate set as maxKeywordRank above. Only computed
		// for the fused path; the legacy scorer never reads this.
		const candidateSetStats: CandidateSetStats | undefined = scoringPlan.mode === "rrf"
			? {
				candidate_count: candidateMap.size,
				// Not read by the scorer — diagnostic carried for the Surfacer decision
				// log (ADR-RETRIEVAL-FUSION-RETUNE §4) and the benchmark artifact.
				lane_sizes: {
					vector: vectorSeeds.length,
					keyword: keywordSeeds.length,
					entity: entitySeeds.length,
					hint: hintSeeds.length
				},
				signal_df: computeSignalDocumentFrequency(
					querySignals,
					Array.from(candidateMap.values(), seed => seed.obs),
					scoringPlan.profile_config.query_signal_boosts
				)
			}
			: undefined;

		const results: HybridSearchResult[] = [];
		for (const seed of candidateMap.values()) {
			const { obs, keywordRank, vectorSimilarity, hasEntityMatch, hintScore, hintMatchedTypes } = seed;

			const laneRanks: NonNullable<HybridSearchResult["lane_ranks"]> = {};
			const vectorRank = vectorRankById.get(obs.id);
			if (vectorRank !== undefined) laneRanks.vector = vectorRank;
			const keywordLaneRank = keywordRankById.get(obs.id);
			if (keywordLaneRank !== undefined) laneRanks.keyword = keywordLaneRank;
			const entityRank = entityRankById.get(obs.id);
			if (entityRank !== undefined) laneRanks.entity = entityRank;
			const hintRank = hintRankById.get(obs.id);
			if (hintRank !== undefined) laneRanks.hint = hintRank;

			const circadianMatched = circadianBias.has(obs.territory);
			const noveltyScore = typeof obs.novelty_score === "number"
				? obs.novelty_score
				: (typeof obs.texture?.novelty_score === "number" ? obs.texture.novelty_score : undefined);

			const scored = scoringPlan.mode === "legacy"
				? scoreHybridCandidateLegacy({
					observation: this.toPublicObservation(obs),
					territory: obs.territory,
					retrieval_profile: "legacy",
					query_signals: querySignals,
					max_keyword_rank: maxKeywordRank,
					vector_similarity: vectorSimilarity,
					keyword_rank: keywordRank > 0 ? keywordRank : undefined,
					hint_score: hintScore > 0 ? hintScore : undefined,
					entity_matched: hasEntityMatch,
					novelty_score: noveltyScore,
					circadian_bias_matched: circadianMatched,
					min_similarity: minSimilarity
				})
				: scoreHybridCandidate({
					observation: this.toPublicObservation(obs),
					territory: obs.territory,
					profile_config: scoringPlan.profile_config,
					query_signals: querySignals,
					lane_positions: laneRanks,
					vector_similarity: vectorSimilarity,
					keyword_ts_rank: keywordRank > 0 ? keywordRank : undefined,
					novelty_score: noveltyScore,
					circadian_bias_matched: circadianMatched,
					min_score: minSimilarity
				}, candidateSetStats);
			if (!scored) continue;

			results.push({
				observation: this.toPublicObservation(obs),
				territory: obs.territory,
				score: scored.score,
				match_sources: hintMatchedTypes.length > 0
					? Array.from(new Set([...scored.match_sources, ...hintMatchedTypes]))
					: scored.match_sources,
				vector_similarity: vectorSimilarity,
				keyword_rank: keywordRank > 0 ? keywordRank : undefined,
				lane_ranks: laneRanks,
				score_breakdown: scored.score_breakdown
			});
		}

		results.sort((a, b) => b.score - a.score);
		const reranked = await applyRetrievalRerank({
			query: options.query,
			retrieval_profile: retrievalProfile,
			query_signals: querySignals,
			results,
			options: {
				mode: options.rerank_mode ?? "off",
				top_n: options.rerank_top_n
			}
		});
		return reranked.results.slice(0, limit);
	}

	async probeLanes(options: LaneProbeOptions): Promise<LaneProbeResult> {
		const depth = Math.min(Math.max(1, Math.floor(options.depth)), 5000);
		const { vectorSeeds, keywordSeeds } = await this.generateLaneCandidates(
			{
				query: options.query,
				embedding: options.embedding,
				queryHintTerms: []
			},
			{ vector: depth, keyword: depth, entity: 0, hint: 0 }
		);

		const vectorRankById = new Map<string, number>();
		const vectorSimById = new Map<string, number>();
		vectorSeeds.forEach((seed, i) => {
			vectorRankById.set(seed.obs.id, i + 1);
			vectorSimById.set(seed.obs.id, seed.vectorSimilarity ?? 0);
		});
		const keywordRankById = new Map<string, number>();
		const keywordTsRankById = new Map<string, number>();
		keywordSeeds.forEach((seed, i) => {
			keywordRankById.set(seed.obs.id, i + 1);
			keywordTsRankById.set(seed.obs.id, seed.keywordRank);
		});

		let vectorTop1 = 0;
		let vectorAtDepth = 0;
		let keywordTop1 = 0;
		let keywordAtDepth = 0;
		const items = options.ids.map(id => {
			const vectorRank = vectorRankById.get(id) ?? null;
			const keywordRank = keywordRankById.get(id) ?? null;
			if (vectorRank === 1) vectorTop1++;
			if (vectorRank !== null) vectorAtDepth++;
			if (keywordRank === 1) keywordTop1++;
			if (keywordRank !== null) keywordAtDepth++;
			return {
				id,
				vector_position: vectorRank,
				vector_similarity: vectorSimById.get(id) ?? null,
				keyword_position: keywordRank,
				keyword_ts_rank: keywordTsRankById.get(id) ?? null
			};
		});

		return {
			depth,
			lanes: {
				vector: { returned: vectorSeeds.length, top1: vectorTop1, at_depth: vectorAtDepth },
				keyword: { returned: keywordSeeds.length, top1: keywordTop1, at_depth: keywordAtDepth }
			},
			items
		};
	}

	async recordMemoryCascade(observationIds: string[]): Promise<void> {
		const top = observationIds.slice(0, 5);
		if (top.length < 2) return;

		const pairs: Array<[string, string]> = [];
		for (let i = 0; i < top.length; i++) {
			for (let j = i + 1; j < top.length; j++) {
				const a = top[i];
				const b = top[j];
				pairs.push(a < b ? [a, b] : [b, a]);
			}
		}

		const current = await this.readCollection<CascadePair>(KV_KEYS.memory_cascade);
		const map = new Map<string, CascadePair>(current.map(p => [`${p.obs_id_a}::${p.obs_id_b}`, p] as [string, CascadePair]));
		const now = nowIso();
		for (const [a, b] of pairs) {
			const key = `${a}::${b}`;
			const existing = map.get(key);
			if (existing) {
				existing.count += 1;
				existing.last_co_surfaced = now;
			} else {
				map.set(key, { obs_id_a: a, obs_id_b: b, count: 1, last_co_surfaced: now });
			}
		}
		await this.writeCollection(KV_KEYS.memory_cascade, Array.from(map.values()));
	}

	async updateSurfacingEffects(observationIds: string[]): Promise<void> {
		if (!observationIds.length) return;
		const set = new Set(observationIds);
		await this.withObservations(async all => {
			for (const obs of all) {
				if (!set.has(obs.id)) continue;
				const currentNovelty = typeof obs.novelty_score === "number"
					? obs.novelty_score
					: (typeof obs.texture?.novelty_score === "number" ? obs.texture.novelty_score : 1.0);
				const nextNovelty = Math.max(currentNovelty - 0.05, 0.0);
				obs.novelty_score = nextNovelty;
				obs.texture = { ...obs.texture, novelty_score: nextNovelty };
				obs.surface_count = (obs.surface_count ?? 0) + 1;
				obs.last_surfaced_at = nowIso();
			}
		});
	}

	// ============ OPEN LOOPS ============

	async readOpenLoops(): Promise<OpenLoop[]> {
		return await this.readCollection<OpenLoop>(KV_KEYS.open_loops);
	}

	async writeOpenLoops(loops: OpenLoop[]): Promise<void> {
		await this.writeCollection(KV_KEYS.open_loops, loops);
	}

	async appendOpenLoop(loop: OpenLoop): Promise<void> {
		const loops = await this.readCollection<OpenLoop>(KV_KEYS.open_loops);
		loops.push(loop);
		await this.writeCollection(KV_KEYS.open_loops, loops);
	}

	// ============ LINKS ============

	async readLinks(): Promise<Link[]> {
		return await this.readCollection<Link>(KV_KEYS.links);
	}

	async writeLinks(links: Link[]): Promise<void> {
		await this.writeCollection(KV_KEYS.links, links);
	}

	async appendLink(link: Link): Promise<void> {
		const links = await this.readCollection<Link>(KV_KEYS.links);
		links.push(link);
		await this.writeCollection(KV_KEYS.links, links);
	}

	// ============ LETTERS ============

	async readLetters(): Promise<Letter[]> {
		return await this.readCollection<Letter>(KV_KEYS.letters);
	}

	async getLetterById(id: string, recipientContext: string): Promise<Letter | null> {
		const scopedContext = recipientContext.trim();
		if (!scopedContext) return null;
		const letters = await this.readCollection<Letter>(KV_KEYS.letters);
		return letters.find(letter => letter.id === id && letter.to_context === scopedContext) ?? null;
	}

	async writeLetters(letters: Letter[]): Promise<void> {
		await this.writeCollection(KV_KEYS.letters, letters);
	}

	async appendLetter(letter: Letter): Promise<void> {
		const letters = await this.readCollection<Letter>(KV_KEYS.letters);
		letters.push(letter);
		await this.writeCollection(KV_KEYS.letters, letters);
	}

	// ============ IDENTITY / ANCHORS / DESIRES ============

	async readIdentityCores(): Promise<IdentityCore[]> {
		return await this.readCollection<IdentityCore>(KV_KEYS.identity_cores);
	}

	async writeIdentityCores(cores: IdentityCore[]): Promise<void> {
		await this.writeCollection(KV_KEYS.identity_cores, cores);
	}

	async readAnchors(): Promise<Anchor[]> {
		return await this.readCollection<Anchor>(KV_KEYS.anchors);
	}

	async writeAnchors(anchors: Anchor[]): Promise<void> {
		await this.writeCollection(KV_KEYS.anchors, anchors);
	}

	async touchAnchors(ids: string[]): Promise<void> {
		if (!ids.length) return;
		const idSet = new Set(ids);
		const anchors = await this.readAnchors();
		let changed = false;
		const now = nowIso();
		for (const anchor of anchors) {
			if (!idSet.has(anchor.id)) continue;
			anchor.activation_count = (anchor.activation_count || 0) + 1;
			anchor.last_activated = now;
			changed = true;
		}
		// The KV backend has no per-row UPDATE — this is still a single collection
		// write (one row in kv_store), not N, mirroring the postgres single-UPDATE contract.
		if (changed) await this.writeAnchors(anchors);
	}

	async readDesires(): Promise<Desire[]> {
		return await this.readCollection<Desire>(KV_KEYS.desires);
	}

	async writeDesires(desires: Desire[]): Promise<void> {
		await this.writeCollection(KV_KEYS.desires, desires);
	}

	// ============ WAKE LOG ============

	async appendWakeLog(entry: WakeLogEntry): Promise<void> {
		const rows = await this.readCollection<WakeLogEntry>(KV_KEYS.wake_log);
		rows.push(entry);
		await this.writeCollection(KV_KEYS.wake_log, rows);
	}

	async readWakeLog(): Promise<WakeLogEntry[]> {
		const rows = await this.readCollection<WakeLogEntry>(KV_KEYS.wake_log);
		return rows.sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
	}

	async readLatestWakeLog(): Promise<WakeLogEntry | null> {
		const rows = await this.readWakeLog();
		if (!rows.length) return null;
		return rows[rows.length - 1];
	}

	// ============ CONVERSATION CONTEXT ============

	async readConversationContext(): Promise<unknown> {
		return await this.readValue(KV_KEYS.conversation_context, null);
	}

	async writeConversationContext(context: unknown): Promise<void> {
		await this.writeValue(KV_KEYS.conversation_context, context);
	}

	// ============ RELATIONAL / SUBCONSCIOUS / TRIGGERS ============

	async readRelationalState(): Promise<RelationalState[]> {
		return await this.readCollection<RelationalState>(KV_KEYS.relational_states);
	}

	async writeRelationalState(states: RelationalState[]): Promise<void> {
		await this.writeCollection(KV_KEYS.relational_states, states);
	}

	async readSubconscious(): Promise<SubconsciousState | null> {
		return await this.readValue<SubconsciousState | null>(KV_KEYS.subconscious, null);
	}

	async writeSubconscious(state: SubconsciousState): Promise<void> {
		await this.writeValue(KV_KEYS.subconscious, state);
	}

	async readTriggers(): Promise<TriggerCondition[]> {
		return await this.readCollection<TriggerCondition>(KV_KEYS.triggers);
	}

	async writeTriggers(triggers: TriggerCondition[]): Promise<void> {
		await this.writeCollection(KV_KEYS.triggers, triggers);
	}

	// ============ CONSENT ============

	async readConsent(): Promise<ConsentState> {
		const value = await this.readValue<ConsentState>(KV_KEYS.consent, this.defaultConsent());
		return {
			user_consent: Array.isArray(value.user_consent) ? value.user_consent : [],
			ai_boundaries: value.ai_boundaries ?? this.defaultConsent().ai_boundaries,
			relationship_level: value.relationship_level ?? "stranger",
			log: Array.isArray(value.log) ? value.log : []
		};
	}

	async writeConsent(consent: ConsentState): Promise<void> {
		await this.writeValue(KV_KEYS.consent, consent);
	}

	// ============ BACKFILL FLAGS ============

	async readBackfillFlag(version: string): Promise<unknown> {
		if (!/^[a-z0-9]+$/i.test(version)) throw new Error("Invalid backfill version");
		const flags = await this.readValue<Record<string, unknown>>(KV_KEYS.backfill_flags, {});
		return flags[version];
	}

	async writeBackfillFlag(version: string, data: unknown): Promise<void> {
		if (!/^[a-z0-9]+$/i.test(version)) throw new Error("Invalid backfill version");
		const flags = await this.readValue<Record<string, unknown>>(KV_KEYS.backfill_flags, {});
		flags[version] = data;
		await this.writeValue(KV_KEYS.backfill_flags, flags);
	}

	// ============ OVERVIEWS / IRON INDEX ============

	async readOverviews(): Promise<TerritoryOverview[]> {
		return await this.readCollection<TerritoryOverview>(KV_KEYS.territory_overviews);
	}

	async writeOverviews(overviews: TerritoryOverview[]): Promise<void> {
		await this.writeCollection(KV_KEYS.territory_overviews, overviews);
	}

	async readIronGripIndex(): Promise<IronGripEntry[]> {
		return await this.readCollection<IronGripEntry>(KV_KEYS.iron_grip_index);
	}

	async writeIronGripIndex(entries: IronGripEntry[]): Promise<void> {
		await this.writeCollection(KV_KEYS.iron_grip_index, entries);
	}

	async appendIronGripEntry(entry: IronGripEntry): Promise<void> {
		const rows = await this.readCollection<IronGripEntry>(KV_KEYS.iron_grip_index);
		rows.push(entry);
		await this.writeCollection(KV_KEYS.iron_grip_index, rows);
	}

	// ============ ENTITIES ============

	async createEntity(entity: Omit<Entity, "id" | "created_at" | "updated_at">): Promise<Entity> {
		const now = nowIso();
		const created: Entity = {
			id: generateId("ent"),
			tenant_id: this.tenant,
			name: entity.name,
			entity_type: entity.entity_type,
			tags: asArray<string>(entity.tags),
			salience: entity.salience ?? "active",
			primary_context: entity.primary_context,
			created_at: now,
			updated_at: now
		};
		const entities = await this.readCollection<Entity>(KV_KEYS.entities);
		entities.push(created);
		await this.writeCollection(KV_KEYS.entities, entities);
		return created;
	}

	async findEntityByName(name: string): Promise<Entity | null> {
		const needle = name.trim().toLowerCase();
		const entities = await this.readCollection<Entity>(KV_KEYS.entities);
		return entities.find(e => e.name.trim().toLowerCase() === needle) ?? null;
	}

	async findEntityById(id: string): Promise<Entity | null> {
		const entities = await this.readCollection<Entity>(KV_KEYS.entities);
		return entities.find(e => e.id === id) ?? null;
	}

	async listEntities(filter?: EntityFilter): Promise<Entity[]> {
		let entities = await this.readCollection<Entity>(KV_KEYS.entities);
		if (filter?.entity_type) entities = entities.filter(e => e.entity_type === filter.entity_type);
		if (filter?.salience) entities = entities.filter(e => e.salience === filter.salience);
		if (filter?.tags?.length) entities = entities.filter(e => filter.tags!.some(t => (e.tags ?? []).includes(t)));
		entities.sort((a, b) => toMillis(b.updated_at) - toMillis(a.updated_at));
		if (filter?.limit) entities = entities.slice(0, Math.max(1, filter.limit));
		return entities;
	}

	async updateEntity(id: string, updates: Partial<Pick<Entity, "name" | "entity_type" | "tags" | "salience" | "primary_context">>): Promise<Entity> {
		const entities = await this.readCollection<Entity>(KV_KEYS.entities);
		const idx = entities.findIndex(e => e.id === id);
		if (idx < 0) throw new Error("Entity not found");
		const current = entities[idx];
		const updated: Entity = {
			...current,
			...updates,
			tags: updates.tags ? asArray<string>(updates.tags) : current.tags,
			updated_at: nowIso()
		};
		entities[idx] = updated;
		await this.writeCollection(KV_KEYS.entities, entities);
		return updated;
	}

	// ============ PROJECT DOSSIERS ============

	async createProjectDossier(dossier: Omit<ProjectDossier, "id" | "tenant_id" | "created_at" | "updated_at">): Promise<ProjectDossier> {
		const now = nowIso();
		const created: ProjectDossier = {
			id: generateId("proj"),
			tenant_id: this.tenant,
			project_entity_id: dossier.project_entity_id,
			lifecycle_status: dossier.lifecycle_status ?? "active",
			summary: dossier.summary,
			goals: asArray<string>(dossier.goals),
			constraints: asArray<string>(dossier.constraints),
			decisions: asArray<string>(dossier.decisions),
			open_questions: asArray<string>(dossier.open_questions),
			next_actions: asArray<string>(dossier.next_actions),
			metadata: dossier.metadata ?? {},
			last_active_at: dossier.last_active_at,
			created_at: now,
			updated_at: now
		};
		const rows = await this.readCollection<ProjectDossier>(KV_KEYS.project_dossiers);
		rows.push(created);
		await this.writeCollection(KV_KEYS.project_dossiers, rows);
		return created;
	}

	async getProjectDossier(projectEntityId: string): Promise<ProjectDossier | null> {
		const rows = await this.readCollection<ProjectDossier>(KV_KEYS.project_dossiers);
		return rows.find(r => r.project_entity_id === projectEntityId) ?? null;
	}

	async listProjectDossiers(filter?: ProjectDossierFilter): Promise<ProjectDossier[]> {
		let rows = await this.readCollection<ProjectDossier>(KV_KEYS.project_dossiers);
		if (filter?.lifecycle_status) rows = rows.filter(r => r.lifecycle_status === filter.lifecycle_status);
		if (filter?.updated_after) rows = rows.filter(r => toMillis(r.updated_at) >= toMillis(filter.updated_after));
		rows.sort((a, b) => toMillis(b.updated_at) - toMillis(a.updated_at));
		if (filter?.limit) rows = rows.slice(0, Math.max(1, filter.limit));
		return rows;
	}

	async updateProjectDossier(
		projectEntityId: string,
		updates: Partial<Pick<ProjectDossier, "lifecycle_status" | "summary" | "goals" | "constraints" | "decisions" | "open_questions" | "next_actions" | "metadata" | "last_active_at">>
	): Promise<ProjectDossier> {
		const rows = await this.readCollection<ProjectDossier>(KV_KEYS.project_dossiers);
		const idx = rows.findIndex(r => r.project_entity_id === projectEntityId);
		if (idx < 0) throw new Error("Project dossier not found");
		const current = rows[idx];
		const updated: ProjectDossier = {
			...current,
			...updates,
			goals: updates.goals ? asArray<string>(updates.goals) : current.goals,
			constraints: updates.constraints ? asArray<string>(updates.constraints) : current.constraints,
			decisions: updates.decisions ? asArray<string>(updates.decisions) : current.decisions,
			open_questions: updates.open_questions ? asArray<string>(updates.open_questions) : current.open_questions,
			next_actions: updates.next_actions ? asArray<string>(updates.next_actions) : current.next_actions,
			metadata: updates.metadata ?? current.metadata,
			updated_at: nowIso()
		};
		rows[idx] = updated;
		await this.writeCollection(KV_KEYS.project_dossiers, rows);
		return updated;
	}

	// ============ AGENT MANIFESTS ============

	async createAgentCapabilityManifest(manifest: Omit<AgentCapabilityManifest, "id" | "tenant_id" | "created_at" | "updated_at">): Promise<AgentCapabilityManifest> {
		const now = nowIso();
		const created: AgentCapabilityManifest = {
			id: generateId("manifest"),
			tenant_id: this.tenant,
			agent_entity_id: manifest.agent_entity_id,
			version: manifest.version ?? "1.0.0",
			delegation_mode: manifest.delegation_mode ?? "explicit",
			router_agent_entity_id: manifest.router_agent_entity_id,
			supports_streaming: Boolean(manifest.supports_streaming),
			accepted_output_modes: asArray<string>(manifest.accepted_output_modes),
			protocols: asArray<string>(manifest.protocols),
			skills: asArray<any>(manifest.skills),
			metadata: manifest.metadata ?? {},
			created_at: now,
			updated_at: now
		};
		const rows = await this.readCollection<AgentCapabilityManifest>(KV_KEYS.agent_capability_manifests);
		rows.push(created);
		await this.writeCollection(KV_KEYS.agent_capability_manifests, rows);
		return created;
	}

	async getAgentCapabilityManifest(agentEntityId: string): Promise<AgentCapabilityManifest | null> {
		const rows = await this.readCollection<AgentCapabilityManifest>(KV_KEYS.agent_capability_manifests);
		return rows.find(r => r.agent_entity_id === agentEntityId) ?? null;
	}

	async listAgentCapabilityManifests(filter?: AgentCapabilityManifestFilter): Promise<AgentCapabilityManifest[]> {
		let rows = await this.readCollection<AgentCapabilityManifest>(KV_KEYS.agent_capability_manifests);
		if (filter?.delegation_mode) rows = rows.filter(r => r.delegation_mode === filter.delegation_mode);
		rows.sort((a, b) => toMillis(b.updated_at) - toMillis(a.updated_at));
		if (filter?.limit) rows = rows.slice(0, Math.max(1, filter.limit));
		return rows;
	}

	async updateAgentCapabilityManifest(
		agentEntityId: string,
		updates: Partial<Pick<AgentCapabilityManifest, "version" | "delegation_mode" | "router_agent_entity_id" | "supports_streaming" | "accepted_output_modes" | "protocols" | "skills" | "metadata">>
	): Promise<AgentCapabilityManifest> {
		const rows = await this.readCollection<AgentCapabilityManifest>(KV_KEYS.agent_capability_manifests);
		const idx = rows.findIndex(r => r.agent_entity_id === agentEntityId);
		if (idx < 0) throw new Error("Agent manifest not found");
		const current = rows[idx];
		const updated: AgentCapabilityManifest = {
			...current,
			...updates,
			accepted_output_modes: updates.accepted_output_modes ? asArray<string>(updates.accepted_output_modes) : current.accepted_output_modes,
			protocols: updates.protocols ? asArray<string>(updates.protocols) : current.protocols,
			skills: updates.skills ? asArray<any>(updates.skills) : current.skills,
			metadata: updates.metadata ?? current.metadata,
			updated_at: nowIso()
		};
		rows[idx] = updated;
		await this.writeCollection(KV_KEYS.agent_capability_manifests, rows);
		return updated;
	}

	// ============ RELATIONS ============

	async createRelation(relation: Omit<Relation, "id" | "created_at" | "updated_at">): Promise<Relation> {
		const now = nowIso();
		const created: Relation = {
			id: generateId("rel"),
			tenant_id: this.tenant,
			from_entity_id: relation.from_entity_id,
			to_entity_id: relation.to_entity_id,
			relation_type: relation.relation_type,
			strength: relation.strength ?? 1.0,
			context: relation.context,
			created_at: now,
			updated_at: now
		};
		const rows = await this.readCollection<Relation>(KV_KEYS.relations);
		rows.push(created);
		await this.writeCollection(KV_KEYS.relations, rows);
		return created;
	}

	async getEntityRelations(entityId: string): Promise<Relation[]> {
		const rows = await this.readCollection<Relation>(KV_KEYS.relations);
		return rows.filter(r => r.from_entity_id === entityId || r.to_entity_id === entityId);
	}

	// ============ ENTITY-OBS LINKS ============

	async linkObservationToEntity(observationId: string, entityId: string): Promise<void> {
		await this.withObservations(async all => {
			const target = all.find(o => o.id === observationId);
			if (!target) throw new Error("Observation not found");
			target.entity_id = entityId;
		});
	}

	async getEntityObservations(entityId: string, limit = 20): Promise<{ observation: Observation; territory: string }[]> {
		const cap = Math.max(1, Math.min(limit, 200));
		const rows = (await this.readCollection<StoredObservation>(KV_KEYS.observations))
			.map(o => this.normalizeObservation(o))
			.filter(o => o.entity_id === entityId)
			.sort((a, b) => toMillis(b.created) - toMillis(a.created))
			.slice(0, cap);
		return rows.map(o => ({ observation: this.toPublicObservation(o), territory: o.territory }));
	}

	async batchGetEntityObservations(entityIds: string[], limitPerEntity = 20, touchedAfter?: string): Promise<Map<string, { observation: Observation; territory: string }[]>> {
		const result = new Map<string, { observation: Observation; territory: string }[]>();
		const all = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));
		const touchedAfterMillis = touchedAfter ? toMillis(touchedAfter) : undefined;
		for (const entityId of entityIds) {
			const rows = all
				.filter(o => o.entity_id === entityId)
				.filter(o => touchedAfterMillis === undefined || Math.max(toMillis(o.created), toMillis(o.last_accessed)) >= touchedAfterMillis)
				.sort((a, b) => toMillis(b.created) - toMillis(a.created))
				.slice(0, Math.max(1, limitPerEntity))
				.map(o => ({ observation: this.toPublicObservation(o), territory: o.territory }));
			result.set(entityId, rows);
		}
		return result;
	}

	async countEntityObservations(entityIds: string[]): Promise<Map<string, { total: number; metabolized: number }>> {
		const result = new Map<string, { total: number; metabolized: number }>();
		const ids = new Set(entityIds);
		const all = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));
		for (const entityId of entityIds) result.set(entityId, { total: 0, metabolized: 0 });
		for (const observation of all) {
			if (!observation.entity_id || !ids.has(observation.entity_id)) continue;
			const counts = result.get(observation.entity_id);
			if (!counts) continue;
			counts.total++;
			if (observation.texture?.charge_phase === "metabolized") counts.metabolized++;
		}
		return result;
	}

	async queryEntityTagsForBackfill(): Promise<Array<{ id: string; entity_tags: string[] }>> {
		const rows = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));
		return rows
			.filter(o => !o.entity_id && Array.isArray(o.entity_tags) && o.entity_tags.length > 0)
			.map(o => ({ id: o.id, entity_tags: asArray<string>(o.entity_tags) }));
	}

	// ============ PROPOSALS ============

	async createProposal(proposal: Omit<DaemonProposal, "id" | "proposed_at">): Promise<DaemonProposal> {
		const created: DaemonProposal = {
			id: `prop_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
			tenant_id: this.tenant,
			proposal_type: proposal.proposal_type,
			source_id: proposal.source_id,
			target_id: proposal.target_id,
			similarity: proposal.similarity,
			resonance_type: proposal.resonance_type,
			confidence: proposal.confidence,
			rationale: proposal.rationale,
			metadata: proposal.metadata ?? {},
			status: proposal.status,
			feedback_note: proposal.feedback_note,
			proposed_at: nowIso(),
			reviewed_at: proposal.reviewed_at
		};
		const rows = await this.readCollection<DaemonProposal>(KV_KEYS.daemon_proposals);
		rows.push(created);
		await this.writeCollection(KV_KEYS.daemon_proposals, rows);
		return created;
	}

	async listProposals(type?: string, status?: string, limit?: number, order: 'newest' | 'oldest' = 'newest'): Promise<DaemonProposal[]> {
		let rows = await this.readCollection<DaemonProposal>(KV_KEYS.daemon_proposals);
		if (type) rows = rows.filter(r => r.proposal_type === type);
		if (status) rows = rows.filter(r => r.status === status);
		rows.sort((a, b) => order === 'oldest'
			? toMillis(a.proposed_at) - toMillis(b.proposed_at)
			: toMillis(b.proposed_at) - toMillis(a.proposed_at));
		return rows.slice(0, Math.min(limit ?? 50, 200));
	}

	async getProposalById(id: string): Promise<DaemonProposal | null> {
		const rows = await this.readCollection<DaemonProposal>(KV_KEYS.daemon_proposals);
		return rows.find(r => r.id === id) ?? null;
	}

	async reviewProposal(id: string, status: "accepted" | "rejected", feedbackNote?: string): Promise<DaemonProposal> {
		const rows = await this.readCollection<DaemonProposal>(KV_KEYS.daemon_proposals);
		const idx = rows.findIndex(r => r.id === id);
		if (idx < 0) throw new Error("Proposal not found");
		rows[idx] = { ...rows[idx], status, feedback_note: feedbackNote, reviewed_at: nowIso() };
		await this.writeCollection(KV_KEYS.daemon_proposals, rows);
		return rows[idx];
	}

	async getProposalStats(): Promise<Record<string, { total: number; accepted: number; rejected: number; ratio: number }>> {
		const rows = await this.readCollection<DaemonProposal>(KV_KEYS.daemon_proposals);
		const out: Record<string, { total: number; accepted: number; rejected: number; ratio: number }> = {};
		for (const row of rows) {
			if (!out[row.proposal_type]) {
				out[row.proposal_type] = { total: 0, accepted: 0, rejected: 0, ratio: 0 };
			}
			out[row.proposal_type].total += 1;
			if (row.status === "accepted") out[row.proposal_type].accepted += 1;
			if (row.status === "rejected") out[row.proposal_type].rejected += 1;
		}
		for (const value of Object.values(out)) {
			value.ratio = value.total > 0 ? value.accepted / value.total : 0;
		}
		return out;
	}

	async proposalExists(type: string, sourceId: string, targetId: string): Promise<boolean> {
		const rows = await this.readCollection<DaemonProposal>(KV_KEYS.daemon_proposals);
		return rows.some(r => r.proposal_type === type && r.source_id === sourceId && r.target_id === targetId && r.status === "pending");
	}

	async batchProposalExists(checks: Array<{ type: string; sourceId: string; targetId: string }>): Promise<Set<string>> {
		const rows = await this.readCollection<DaemonProposal>(KV_KEYS.daemon_proposals);
		const pending = rows.filter(r => r.status === "pending");
		const set = new Set<string>();
		for (const check of checks) {
			const exists = pending.some(r => r.proposal_type === check.type && r.source_id === check.sourceId && r.target_id === check.targetId);
			if (exists) set.add(proposalKey(check.type, check.sourceId, check.targetId));
		}
		return set;
	}

	async expireStaleProposals(days: number): Promise<number> {
		// ops/ADR-JANITOR.md §1 — DELETE, not "reject" (mirrors postgres.ts). Scoped to
		// EXPIRABLE_PROPOSAL_TYPES ONLY — a module constant, never daemon_config-driven.
		const expirableTypes = new Set<string>(EXPIRABLE_PROPOSAL_TYPES);
		const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
		const rows = await this.readCollection<DaemonProposal>(KV_KEYS.daemon_proposals);

		const toDelete = rows.filter(r => {
			if (!expirableTypes.has(r.proposal_type)) return false;
			if (r.status === "pending") return toMillis(r.proposed_at) < cutoffMs;
			// One-time backfill (idempotent — matches nothing once every future
			// expiry goes through the DELETE above instead of the old
			// status='rejected' UPDATE): reviewed_at IS NULL is the reliable
			// discriminator between an auto-expired tombstone and a real review —
			// every real review path (human, AI reviewer, auto-absorption) goes
			// through reviewProposal(), which always stamps reviewed_at.
			//
			// Historical: safe to delete once last_expiry has shown backfilled: 0 for a
			// full quarter (first cleared 2026-09-06).
			if (r.status === "rejected") return !r.reviewed_at;
			return false;
		});
		if (toDelete.length === 0) return 0;

		const deleteIds = new Set(toDelete.map(r => r.id));
		await this.writeCollection(KV_KEYS.daemon_proposals, rows.filter(r => !deleteIds.has(r.id)));

		const byType: Record<string, number> = {};
		let expiredCount = 0;
		let backfilledCount = 0;
		for (const row of toDelete) {
			byType[row.proposal_type] = (byType[row.proposal_type] ?? 0) + 1;
			// mirrors postgres.ts's two-query split: pending rows came from the
			// go-forward expiry, rejected rows from the one-time backfill.
			if (row.status === "pending") expiredCount++;
			else backfilledCount++;
		}
		await this.updateDaemonConfigData({
			last_expiry: {
				deleted: toDelete.length,
				expired: expiredCount,
				backfilled: backfilledCount,
				by_type: byType,
				at: nowIso()
			}
		});

		return toDelete.length;
	}

	// ============ ORPHANS ============

	async markOrphan(observationId: string): Promise<void> {
		const rows = await this.readCollection<OrphanObservation>(KV_KEYS.orphan_observations);
		const existing = rows.find(r => r.observation_id === observationId);
		if (existing) return;
		rows.push({
			observation_id: observationId,
			tenant_id: this.tenant,
			first_marked: nowIso(),
			rescue_attempts: 0,
			status: "orphaned"
		});
		await this.writeCollection(KV_KEYS.orphan_observations, rows);
	}

	async markOrphans(observationIds: string[]): Promise<number> {
		if (!observationIds.length) return 0;
		const rows = await this.readCollection<OrphanObservation>(KV_KEYS.orphan_observations);
		const seen = new Set(rows.map(r => r.observation_id));
		let inserted = 0;
		for (const observationId of observationIds) {
			if (seen.has(observationId)) continue; // mirrors ON CONFLICT DO NOTHING
			seen.add(observationId);
			rows.push({
				observation_id: observationId,
				tenant_id: this.tenant,
				first_marked: nowIso(),
				rescue_attempts: 0,
				status: "orphaned"
			});
			inserted++;
		}
		if (inserted > 0) await this.writeCollection(KV_KEYS.orphan_observations, rows);
		return inserted;
	}

	async listOrphans(status?: string, limit?: number): Promise<OrphanObservation[]> {
		let rows = await this.readCollection<OrphanObservation>(KV_KEYS.orphan_observations);
		if (status) rows = rows.filter(r => r.status === status);
		// ops/ADR-JANITOR.md §1 — least-recently-attempted first (never-attempted
		// outranks any attempt, however old), matching postgres' ORDER BY
		// last_rescue_attempt ASC NULLS FIRST, first_marked ASC. This is not cosmetic:
		// the caller takes the first 50, so the sort decides WHICH orphans get rescue
		// attempts. first_marked ASC alone worked the SAME 50 oldest orphans every
		// night; once those carried tombstoned proposals, the drain moved zero orphans
		// forever — head-of-line blocking impossible by construction now. first_marked
		// stays the tiebreak among ties (every orphan that has never been attempted),
		// preserving the original FIFO detection order for the common case.
		rows.sort((a, b) => {
			const aAttempt = a.last_rescue_attempt ? toMillis(a.last_rescue_attempt) : null;
			const bAttempt = b.last_rescue_attempt ? toMillis(b.last_rescue_attempt) : null;
			if (aAttempt === null && bAttempt !== null) return -1;
			if (aAttempt !== null && bAttempt === null) return 1;
			if (aAttempt !== null && bAttempt !== null && aAttempt !== bAttempt) return aAttempt - bAttempt;
			return toMillis(a.first_marked) - toMillis(b.first_marked);
		});
		return rows.slice(0, Math.min(limit ?? 50, 200));
	}

	async incrementRescueAttempt(observationId: string): Promise<void> {
		const rows = await this.readCollection<OrphanObservation>(KV_KEYS.orphan_observations);
		const idx = rows.findIndex(r => r.observation_id === observationId);
		if (idx < 0) return;
		rows[idx] = {
			...rows[idx],
			rescue_attempts: rows[idx].rescue_attempts + 1,
			last_rescue_attempt: nowIso()
		};
		await this.writeCollection(KV_KEYS.orphan_observations, rows);
	}

	async incrementRescueAttempts(observationIds: string[]): Promise<number> {
		if (!observationIds.length) return 0;
		const wanted = new Set(observationIds);
		const rows = await this.readCollection<OrphanObservation>(KV_KEYS.orphan_observations);
		let updated = 0;
		for (let i = 0; i < rows.length; i++) {
			if (!wanted.has(rows[i].observation_id)) continue;
			rows[i] = {
				...rows[i],
				rescue_attempts: rows[i].rescue_attempts + 1,
				last_rescue_attempt: nowIso()
			};
			updated++;
		}
		if (updated > 0) await this.writeCollection(KV_KEYS.orphan_observations, rows);
		return updated;
	}

	async updateOrphanStatus(observationId: string, status: "rescued" | "archived"): Promise<void> {
		const rows = await this.readCollection<OrphanObservation>(KV_KEYS.orphan_observations);
		const idx = rows.findIndex(r => r.observation_id === observationId);
		if (idx < 0) return;
		rows[idx] = { ...rows[idx], status };
		await this.writeCollection(KV_KEYS.orphan_observations, rows);
	}

	// ============ DAEMON CONFIG / HEALTH ============

	async readDaemonConfig(): Promise<DaemonConfig> {
		const config = await this.readValue<DaemonConfig | null>(KV_KEYS.daemon_config, null);
		if (!config) return this.defaultDaemonConfig();
		return {
			tenant_id: this.tenant,
			link_proposal_threshold: typeof config.link_proposal_threshold === "number" ? config.link_proposal_threshold : 0.75,
			last_threshold_update: config.last_threshold_update,
			data: config.data ?? {}
		};
	}

	async updateProposalThreshold(threshold: number): Promise<void> {
		const current = await this.readDaemonConfig();
		await this.writeValue(KV_KEYS.daemon_config, {
			...current,
			link_proposal_threshold: threshold,
			last_threshold_update: nowIso()
		});
	}

	async updateDaemonConfigData(data: Record<string, unknown>): Promise<void> {
		const current = await this.readDaemonConfig();
		await this.writeValue(KV_KEYS.daemon_config, {
			...current,
			data: { ...(current.data as Record<string, unknown>), ...data }
		});
	}

	async getEmbeddingCoverage(): Promise<{ total: number; embedded: number }> {
		const rows = (await this.readCollection<StoredObservation>(KV_KEYS.observations)).map(o => this.normalizeObservation(o));
		return {
			total: rows.length,
			embedded: rows.filter(r => Array.isArray(r.embedding) && r.embedding.length > 0).length
		};
	}

	async getOrphanStats(): Promise<{ orphaned: number; rescued: number; archived: number; oldest_days: number }> {
		const rows = await this.readCollection<OrphanObservation>(KV_KEYS.orphan_observations);
		const orphaned = rows.filter(r => r.status === "orphaned");
		const rescued = rows.filter(r => r.status === "rescued").length;
		const archived = rows.filter(r => r.status === "archived").length;
		const oldestMs = orphaned.length ? Math.min(...orphaned.map(r => toMillis(r.first_marked)).filter(Boolean)) : 0;
		const oldestDays = oldestMs ? Math.floor((Date.now() - oldestMs) / (1000 * 60 * 60 * 24)) : 0;
		return { orphaned: orphaned.length, rescued, archived, oldest_days: oldestDays };
	}

	async getOldestPendingProposalDays(): Promise<number | null> {
		// ops/ADR-JANITOR.md §2.1 instance eight — same EXPIRABLE_PROPOSAL_TYPES scope
		// as postgres.ts and expireStaleProposals below; salience_regrade is
		// deliberately non-expirable and deliberately long-pending, so leaving it
		// unscoped here would light this alarm permanently the moment one crosses
		// 21 days.
		const expirableTypes = new Set<string>(EXPIRABLE_PROPOSAL_TYPES);
		const rows = await this.readCollection<DaemonProposal>(KV_KEYS.daemon_proposals);
		const pending = rows.filter(r => r.status === "pending" && expirableTypes.has(r.proposal_type));
		if (!pending.length) return null;
		const oldestMs = Math.min(...pending.map(r => toMillis(r.proposed_at)).filter(Boolean));
		if (!oldestMs) return null;
		return Math.floor((Date.now() - oldestMs) / (1000 * 60 * 60 * 24));
	}

	// ============ VALENCE LEXICON (ops/ADR-VALENCE-FLOOR.md, slice 0) ============

	async readChargeValence(): Promise<ChargeValenceRow[]> {
		return this.readCollection<ChargeValenceRow>(KV_KEYS.charge_valence);
	}

	async upsertChargeValence(rows: ChargeValenceRow[]): Promise<void> {
		if (rows.length === 0) return;
		const existing = await this.readCollection<ChargeValenceRow>(KV_KEYS.charge_valence);
		const byCharge = new Map(existing.map(row => [row.charge, row]));
		for (const row of rows) byCharge.set(row.charge, row);
		await this.writeCollection(KV_KEYS.charge_valence, [...byCharge.values()]);
	}

	async getTopCascadePairs(limit = 20): Promise<Array<{ obs_id_a: string; obs_id_b: string; count: number }>> {
		const rows = await this.readCollection<CascadePair>(KV_KEYS.memory_cascade);
		return rows
			.sort((a, b) => b.count - a.count)
			.slice(0, Math.max(1, Math.min(limit, 200)))
			.map(r => ({ obs_id_a: r.obs_id_a, obs_id_b: r.obs_id_b, count: r.count }));
	}

	// ============ DAEMON SEARCH HELPERS ============

	async findSimilarUnlinked(sourceId: string, limit: number): Promise<Array<{ observation: Observation; territory: string; similarity: number }>> {
		const source = (await this.readCollection<StoredObservation>(KV_KEYS.observations))
			.map(o => this.normalizeObservation(o))
			.find(o => o.id === sourceId);
		if (!source?.embedding?.length) return [];

		const links = await this.readCollection<Link>(KV_KEYS.links);
		const linkedIds = new Set<string>();
		for (const link of links) {
			if (link.source_id === sourceId) linkedIds.add(link.target_id);
			if (link.target_id === sourceId) linkedIds.add(link.source_id);
		}

		const proposals = await this.readCollection<DaemonProposal>(KV_KEYS.daemon_proposals);
		const pending = new Set(
			proposals
				.filter(p => p.status === "pending" && p.proposal_type === "link" && p.source_id === sourceId)
				.map(p => p.target_id)
		);

		const similar = await this.searchSimilar({ embedding: source.embedding, limit: Math.max(limit * 4, 40) });
		return similar
			.filter(s => s.observation.id !== sourceId && !linkedIds.has(s.observation.id) && !pending.has(s.observation.id))
			.slice(0, Math.max(1, limit));
	}

	/**
	 * ops/ADR-JANITOR.md §6.2 — findSimilarUnlinked minus the link/pending-proposal
	 * exclusions, plus minSimilarity pushed straight into searchSimilar's own
	 * min_similarity option (no new filtering logic needed here — the KV-store
	 * backend's searchSimilar already supports a floor).
	 */
	async findSimilarByEmbedding(sourceId: string, limit: number, minSimilarity: number): Promise<Array<{ observation: Observation; territory: string; similarity: number }>> {
		const source = (await this.readCollection<StoredObservation>(KV_KEYS.observations))
			.map(o => this.normalizeObservation(o))
			.find(o => o.id === sourceId);
		if (!source?.embedding?.length) return [];

		const similar = await this.searchSimilar({
			embedding: source.embedding,
			limit: Math.max(limit * 4, 40),
			min_similarity: minSimilarity
		});
		return similar
			.filter(s => s.observation.id !== sourceId)
			.slice(0, Math.max(1, limit));
	}

	async findOrphanCandidates(cutoffDate: StateWindow, limit: number, arrival?: ArrivalBoundary): Promise<Observation[]> {
		assertArrivalNotAfterCutoff(cutoffDate, arrival);
		const cutoff = toMillis(cutoffDate);
		const arrivalMillis = arrival ? toMillis(arrival) : undefined;
		const cap = Math.max(1, Math.min(limit, 500));
		const orphans = await this.readCollection<OrphanObservation>(KV_KEYS.orphan_observations);
		const alreadyMarked = new Set(orphans.map(o => o.observation_id));

		const candidates = (await this.readCollection<StoredObservation>(KV_KEYS.observations))
			.map(o => this.normalizeObservation(o))
			.filter(o => !o.entity_id)
			.filter(o => (o.access_count ?? 0) <= 1)
			.filter(o => toMillis(o.created) <= cutoff)
			.filter(o => arrivalMillis === undefined || Math.max(toMillis(o.created), toMillis(o.last_accessed)) >= arrivalMillis)
			.filter(o => !alreadyMarked.has(o.id))
			.sort((a, b) => toMillis(a.created) - toMillis(b.created))
			.slice(0, cap);

		return candidates.map(c => this.toPublicObservation(c));
	}

	async findSalienceRegradeCandidates(minAgeCutoff: string, surfacedCutoff: string, limit: number): Promise<Observation[]> {
		const minAgeMillis = toMillis(minAgeCutoff);
		const surfacedCutoffMillis = toMillis(surfacedCutoff);
		const cap = Math.max(1, Math.min(limit, 2000));

		const [anchors, links, proposals, consolidations, capturedSkills] = await Promise.all([
			this.readAnchors(),
			this.readCollection<Link>(KV_KEYS.links),
			this.readCollection<DaemonProposal>(KV_KEYS.daemon_proposals),
			this.readCollection<ConsolidationCandidate>(KV_KEYS.consolidation_candidates),
			this.readCollection<CapturedSkillArtifact>(KV_KEYS.captured_skills)
		]);

		const anchorTargets = new Set(
			anchors.map(a => a.triggers_memory_id).filter((id): id is string => Boolean(id))
		);
		const linkedIds = new Set<string>();
		for (const l of links) {
			linkedIds.add(l.source_id);
			linkedIds.add(l.target_id);
		}
		// Any status, not just pending — ops/ADR-JANITOR.md §5.5: rejection of a
		// salience_regrade proposal must be a permanent tombstone, same anti-nag
		// guarantee as the status-blind unique index gives the Postgres backend.
		const priorRegradeIds = new Set(
			proposals.filter(p => p.proposal_type === "salience_regrade").map(p => p.source_id)
		);
		const acceptedConsolidationSourceIds = new Set(
			consolidations.filter(c => c.status === "accepted").flatMap(c => c.source_observation_ids)
		);
		const metabolizedBySkillIds = new Set(
			capturedSkills.flatMap(cs => {
				const ids = (cs.provenance as Record<string, unknown> | undefined)?.metabolized_observation_ids;
				return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
			})
		);

		const candidates = (await this.readCollection<StoredObservation>(KV_KEYS.observations))
			.map(o => this.normalizeObservation(o))
			.filter(o => o.texture?.salience === "foundational")
			.filter(o => o.territory !== "self")
			.filter(o => (o.access_count ?? 0) <= 1)
			.filter(o => toMillis(o.created) < minAgeMillis)
			.filter(o => o.texture?.charge_phase !== "metabolized")
			.filter(o => !o.last_surfaced_at || toMillis(o.last_surfaced_at) < surfacedCutoffMillis)
			.filter(o => !anchorTargets.has(o.id))
			.filter(o => !priorRegradeIds.has(o.id))
			.filter(o => !acceptedConsolidationSourceIds.has(o.id))
			.filter(o => !metabolizedBySkillIds.has(o.id))
			.filter(o => !linkedIds.has(o.id))
			.sort((a, b) => toMillis(a.created) - toMillis(b.created))
			.slice(0, cap);

		return candidates.map(c => this.toPublicObservation(c));
	}

	// ============ VERSIONS / PROCESSING ============

	async createVersion(observationId: string, content: string, texture: Observation["texture"], changeReason?: string): Promise<ObservationVersion> {
		const versions = await this.readCollection<ObservationVersion>(KV_KEYS.observation_versions);
		const versionNum = versions.filter(v => v.observation_id === observationId).length + 1;
		const created: ObservationVersion = {
			id: generateId("ver"),
			tenant_id: this.tenant,
			observation_id: observationId,
			version_num: versionNum,
			content,
			texture,
			change_reason: changeReason,
			created_at: nowIso()
		};
		versions.push(created);
		await this.writeCollection(KV_KEYS.observation_versions, versions);
		return created;
	}

	async getVersionHistory(observationId: string): Promise<ObservationVersion[]> {
		const versions = await this.readCollection<ObservationVersion>(KV_KEYS.observation_versions);
		return versions
			.filter(v => v.observation_id === observationId)
			.sort((a, b) => a.version_num - b.version_num);
	}

	async createProcessingEntry(entry: Omit<ProcessingEntry, "id" | "tenant_id" | "created_at">): Promise<ProcessingEntry> {
		const created: ProcessingEntry = {
			id: generateId("proc"),
			tenant_id: this.tenant,
			observation_id: entry.observation_id,
			processing_note: entry.processing_note,
			charge_at_processing: asArray<string>(entry.charge_at_processing),
			somatic_at_processing: entry.somatic_at_processing,
			created_at: nowIso()
		};
		const rows = await this.readCollection<ProcessingEntry>(KV_KEYS.processing_log);
		rows.push(created);
		await this.writeCollection(KV_KEYS.processing_log, rows);
		return created;
	}

	async listProcessingEntries(observationId: string, limit = 20): Promise<ProcessingEntry[]> {
		const rows = await this.readCollection<ProcessingEntry>(KV_KEYS.processing_log);
		return rows
			.filter(r => r.observation_id === observationId)
			.sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at))
			.slice(0, Math.max(1, Math.min(limit, 200)));
	}

	async incrementProcessingCount(observationId: string): Promise<number> {
		let count = 0;
		await this.withObservations(async all => {
			const target = all.find(o => o.id === observationId);
			if (!target) return;
			target.processing_count = (target.processing_count ?? 0) + 1;
			count = target.processing_count;
		});
		return count;
	}

	async advanceChargePhase(observationId: string): Promise<{ advanced: boolean; new_phase?: string }> {
		const PHASE_ORDER = ["fresh", "active", "processing", "metabolized"] as const;
		let outcome: { advanced: boolean; new_phase?: string } = { advanced: false };

		const loops = await this.readCollection<OpenLoop>(KV_KEYS.open_loops);
		await this.withObservations(async all => {
			const target = all.find(o => o.id === observationId);
			if (!target) return;
			const processingCount = target.processing_count ?? 0;
			if (processingCount < 1) return;

			const current = (target.texture?.charge_phase ?? "fresh") as typeof PHASE_ORDER[number];
			const idx = PHASE_ORDER.indexOf(current);
			if (idx < 0 || idx >= PHASE_ORDER.length - 1) return;

			let threshold = 3;
			if (target.entity_id) {
				const accelerated = loops.some(loop =>
					loop.status === "burning" &&
					loop.mode === "paradox" &&
					Array.isArray(loop.linked_entity_ids) &&
					loop.linked_entity_ids.includes(target.entity_id!)
				);
				if (accelerated) threshold = 2;
			}

			if (processingCount < threshold) return;

			const nextPhase = PHASE_ORDER[idx + 1];
			target.texture = { ...target.texture, charge_phase: nextPhase };
			outcome = { advanced: true, new_phase: nextPhase };
		});

		return outcome;
	}

	// ============ CONSOLIDATION ============

	async createConsolidationCandidate(candidate: Omit<ConsolidationCandidate, "id" | "tenant_id" | "created_at" | "reviewed_at">): Promise<ConsolidationCandidate> {
		const created: ConsolidationCandidate = {
			id: generateId("cons"),
			tenant_id: this.tenant,
			source_observation_ids: asArray<string>(candidate.source_observation_ids),
			pattern_description: candidate.pattern_description,
			suggested_territory: candidate.suggested_territory,
			suggested_type: candidate.suggested_type,
			status: candidate.status,
			created_at: nowIso()
		};
		const rows = await this.readCollection<ConsolidationCandidate>(KV_KEYS.consolidation_candidates);
		rows.push(created);
		await this.writeCollection(KV_KEYS.consolidation_candidates, rows);
		return created;
	}

	async listConsolidationCandidates(status?: string, limit?: number): Promise<ConsolidationCandidate[]> {
		let rows = await this.readCollection<ConsolidationCandidate>(KV_KEYS.consolidation_candidates);
		if (status) rows = rows.filter(r => r.status === status);
		rows.sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at));
		return rows.slice(0, Math.min(limit ?? 50, 200));
	}

	async reviewConsolidationCandidate(id: string, status: "accepted" | "rejected" | "deferred"): Promise<ConsolidationCandidate> {
		const rows = await this.readCollection<ConsolidationCandidate>(KV_KEYS.consolidation_candidates);
		const idx = rows.findIndex(r => r.id === id);
		if (idx < 0) throw new Error("Consolidation candidate not found");
		rows[idx] = { ...rows[idx], status, reviewed_at: nowIso() };
		await this.writeCollection(KV_KEYS.consolidation_candidates, rows);
		return rows[idx];
	}

	// ============ DISPATCH FEEDBACK ============

	async recordDispatch(entry: Omit<DispatchFeedback, "id" | "tenant_id" | "dispatched_at">): Promise<DispatchFeedback> {
		const created: DispatchFeedback = {
			id: generateId("dispatch"),
			tenant_id: this.tenant,
			agent_entity_id: entry.agent_entity_id,
			task_type: entry.task_type,
			domain: entry.domain,
			environment: entry.environment,
			session_id: entry.session_id,
			dispatched_at: nowIso(),
			outcome: entry.outcome,
			findings_count: entry.findings_count ?? 0,
			findings_acted: entry.findings_acted ?? 0,
			confidence_avg: entry.confidence_avg,
			predicted_confidence: entry.predicted_confidence,
			outcome_score: entry.outcome_score,
			revision_cost: entry.revision_cost,
			needed_rescue: entry.needed_rescue,
			rescue_agent_id: entry.rescue_agent_id,
			time_to_usable_ms: entry.time_to_usable_ms,
			notes: entry.notes,
			reviewed_at: entry.reviewed_at
		};
		const rows = await this.readCollection<DispatchFeedback>(KV_KEYS.dispatch_feedback);
		rows.push(created);
		await this.writeCollection(KV_KEYS.dispatch_feedback, rows);
		return created;
	}

	async getDispatchStats(agentEntityId?: string): Promise<DispatchStat[]> {
		let rows = await this.readCollection<DispatchFeedback>(KV_KEYS.dispatch_feedback);
		if (agentEntityId) rows = rows.filter(r => r.agent_entity_id === agentEntityId);

		const grouped = new Map<string, DispatchFeedback[]>();
		for (const row of rows) {
			const list = grouped.get(row.task_type) ?? [];
			list.push(row);
			grouped.set(row.task_type, list);
		}

		const stats: DispatchStat[] = [];
		for (const [task_type, list] of grouped) {
			const total = list.length;
			const effective = list.filter(r => r.outcome === "effective").length;
			const partial = list.filter(r => r.outcome === "partial").length;
			const ineffective = list.filter(r => r.outcome === "ineffective").length;
			const redirected = list.filter(r => r.outcome === "redirected").length;
			const avg = (vals: Array<number | undefined>) => {
				const xs = vals.filter((v): v is number => typeof v === "number");
				return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
			};
			const rescueRate = total ? list.filter(r => r.needed_rescue).length / total : 0;
			stats.push({
				task_type,
				total,
				effective,
				partial,
				ineffective,
				redirected,
				avg_confidence: avg(list.map(r => r.confidence_avg)),
				avg_predicted_confidence: avg(list.map(r => r.predicted_confidence)),
				avg_outcome_score: avg(list.map(r => r.outcome_score)),
				avg_revision_cost: avg(list.map(r => r.revision_cost)),
				rescue_rate: rescueRate
			});
		}

		stats.sort((a, b) => b.total - a.total);
		return stats;
	}

	// ============ TASKS ============

	async createTask(task: Omit<Task, "id" | "tenant_id" | "created_at" | "updated_at">): Promise<Task> {
		const now = nowIso();
		const created: Task = {
			id: generateId("task"),
			tenant_id: this.tenant,
			assigned_tenant: task.assigned_tenant,
			title: task.title,
			description: task.description,
			status: task.status ?? "open",
			priority: task.priority ?? "normal",
			estimated_effort: task.estimated_effort,
			scheduled_wake: task.scheduled_wake,
			source: task.source,
			linked_observation_ids: asArray<string>(task.linked_observation_ids),
			linked_entity_ids: asArray<string>(task.linked_entity_ids),
			depends_on: task.depends_on ? asArray<string>(task.depends_on) : undefined,
			completion_note: task.completion_note,
			created_at: now,
			updated_at: now,
			completed_at: task.completed_at
		};
		const rows = await this.readCollection<Task>(KV_KEYS.tasks);
		rows.push(created);
		await this.writeCollection(KV_KEYS.tasks, rows);
		return created;
	}

	async listTasks(status?: string, priority?: string, limit?: number, includeAssigned?: boolean): Promise<Task[]> {
		let rows = await this.readCollection<Task>(KV_KEYS.tasks);
		rows = rows.filter(r => r.tenant_id === this.tenant || (includeAssigned && r.assigned_tenant === this.tenant));
		if (status) rows = rows.filter(r => r.status === status);
		if (priority) rows = rows.filter(r => r.priority === priority);
		if (status === "scheduled") {
			rows.sort((a, b) => {
				const sa = toMillis(a.scheduled_wake) || Number.MAX_SAFE_INTEGER;
				const sb = toMillis(b.scheduled_wake) || Number.MAX_SAFE_INTEGER;
				if (sa !== sb) return sa - sb;
				return toMillis(b.created_at) - toMillis(a.created_at);
			});
		} else {
			rows.sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at));
		}
		return rows.slice(0, Math.min(limit ?? 50, 200));
	}

	async listTaskChangesSince(since: string, limit?: number, includeAssigned?: boolean): Promise<Task[]> {
		const ts = toMillis(since);
		let rows = await this.readCollection<Task>(KV_KEYS.tasks);
		rows = rows.filter(r => r.tenant_id === this.tenant || (includeAssigned && r.assigned_tenant === this.tenant));
		rows = rows.filter(r => toMillis(r.updated_at) >= ts);
		rows.sort((a, b) => toMillis(b.updated_at) - toMillis(a.updated_at));
		return rows.slice(0, Math.min(limit ?? 50, 200));
	}

	async updateTask(
		id: string,
		updates: Partial<Pick<Task, "title" | "description" | "status" | "priority" | "estimated_effort" | "scheduled_wake" | "completion_note" | "completed_at">>,
		includeAssigned?: boolean
	): Promise<Task> {
		if (!Object.keys(updates).length) throw new Error("No fields to update");
		const rows = await this.readCollection<Task>(KV_KEYS.tasks);
		const idx = rows.findIndex(r => r.id === id && (r.tenant_id === this.tenant || (includeAssigned && r.assigned_tenant === this.tenant)));
		if (idx < 0) throw new Error("Task not found");
		rows[idx] = { ...rows[idx], ...updates, updated_at: nowIso() };
		await this.writeCollection(KV_KEYS.tasks, rows);
		return rows[idx];
	}

	async openDueScheduledTasks(nowIsoParam?: string, limit?: number): Promise<number> {
		const nowMs = toMillis(nowIsoParam ?? nowIso());
		const cap = Math.max(1, Math.min(limit ?? 200, 500));
		const rows = await this.readCollection<Task>(KV_KEYS.tasks);

		const due = rows
			.map((task, index) => ({ task, index }))
			.filter(({ task }) => task.tenant_id === this.tenant)
			.filter(({ task }) => task.status === "scheduled")
			.filter(({ task }) => task.scheduled_wake && toMillis(task.scheduled_wake) <= nowMs)
			.sort((a, b) => {
				const sa = toMillis(a.task.scheduled_wake);
				const sb = toMillis(b.task.scheduled_wake);
				if (sa !== sb) return sa - sb;
				return toMillis(a.task.created_at) - toMillis(b.task.created_at);
			})
			.slice(0, cap);

		for (const { index } of due) {
			rows[index] = { ...rows[index], status: "open", updated_at: nowIso() };
		}

		if (due.length > 0) {
			await this.writeCollection(KV_KEYS.tasks, rows);
		}

		return due.length;
	}

	async getTask(id: string, includeAssigned?: boolean): Promise<Task | null> {
		const rows = await this.readCollection<Task>(KV_KEYS.tasks);
		return rows.find(r => r.id === id && (r.tenant_id === this.tenant || (includeAssigned && r.assigned_tenant === this.tenant))) ?? null;
	}

	// ============ CAPTURED SKILLS ============

	async createCapturedSkillArtifact(artifact: CapturedSkillArtifactCreate): Promise<CapturedSkillArtifact> {
		const rows = await this.readCollection<CapturedSkillArtifact>(KV_KEYS.captured_skills);
		const version = rows
			.filter(r => r.skill_key === artifact.skill_key)
			.reduce((max, row) => Math.max(max, row.version), 0) + 1;

		const now = nowIso();
		const created: CapturedSkillArtifact = {
			id: generateId("skill"),
			tenant_id: this.tenant,
			skill_key: artifact.skill_key,
			version,
			layer: artifact.layer ?? "captured",
			status: artifact.status ?? "candidate",
			name: artifact.name,
			domain: artifact.domain,
			environment: artifact.environment,
			task_type: artifact.task_type,
			agent_tenant: artifact.agent_tenant,
			source_runtime_run_id: artifact.source_runtime_run_id,
			source_task_id: artifact.source_task_id,
			source_observation_id: artifact.source_observation_id,
			provenance: artifact.provenance ?? {},
			metadata: artifact.metadata ?? {},
			created_at: now,
			updated_at: now
		};
		rows.push(created);
		await this.writeCollection(KV_KEYS.captured_skills, rows);
		return created;
	}

	async getCapturedSkillArtifact(id: string): Promise<CapturedSkillArtifact | null> {
		const rows = await this.readCollection<CapturedSkillArtifact>(KV_KEYS.captured_skills);
		return rows.find(r => r.id === id) ?? null;
	}

	async listCapturedSkillArtifacts(filter?: CapturedSkillArtifactFilter): Promise<CapturedSkillArtifact[]> {
		let rows = await this.readCollection<CapturedSkillArtifact>(KV_KEYS.captured_skills);
		if (filter?.status) rows = rows.filter(r => r.status === filter.status);
		if (filter?.layer) rows = rows.filter(r => r.layer === filter.layer);
		if (filter?.agent_tenant) rows = rows.filter(r => r.agent_tenant === filter.agent_tenant);
		if (filter?.task_type) rows = rows.filter(r => r.task_type === filter.task_type);
		rows.sort((a, b) => toMillis(b.updated_at) - toMillis(a.updated_at));
		return rows.slice(0, Math.min(filter?.limit ?? 20, 100));
	}

	async reviewCapturedSkillArtifact(
		id: string,
		status: CapturedSkillArtifact["status"],
		reviewedBy?: string,
		reviewNote?: string
	): Promise<CapturedSkillArtifact> {
		const rows = await this.readCollection<CapturedSkillArtifact>(KV_KEYS.captured_skills);
		const idx = rows.findIndex(r => r.id === id);
		if (idx < 0) throw new Error("Captured skill not found");
		rows[idx] = {
			...rows[idx],
			status,
			reviewed_by: reviewedBy,
			review_note: reviewNote,
			reviewed_at: nowIso(),
			updated_at: nowIso()
		};
		await this.writeCollection(KV_KEYS.captured_skills, rows);
		return rows[idx];
	}

	async getCapturedSkillRegistryHealth(): Promise<CapturedSkillRegistryHealth> {
		const rows = await this.readCollection<CapturedSkillArtifact>(KV_KEYS.captured_skills);
		const by_status: CapturedSkillRegistryHealth["by_status"] = {
			candidate: 0,
			accepted: 0,
			degraded: 0,
			retired: 0
		};
		const by_layer: CapturedSkillRegistryHealth["by_layer"] = {
			fixed: 0,
			captured: 0,
			derived: 0
		};

		for (const row of rows) {
			by_status[row.status] = (by_status[row.status] ?? 0) + 1;
			by_layer[row.layer] = (by_layer[row.layer] ?? 0) + 1;
		}

		return {
			total: rows.length,
			by_status,
			by_layer,
			with_runtime_provenance: rows.filter(r => Boolean(r.source_runtime_run_id)).length,
			with_task_provenance: rows.filter(r => Boolean(r.source_task_id)).length,
			with_observation_provenance: rows.filter(r => Boolean(r.source_observation_id)).length,
			pending_review: rows.filter(r => r.status === "candidate").length
		};
	}

	// ============ AUTONOMOUS RUNTIME ============

	async upsertAgentRuntimeSession(
		session: Omit<AgentRuntimeSession, "id" | "tenant_id" | "created_at" | "updated_at">
	): Promise<AgentRuntimeSession> {
		const rows = await this.readCollection<AgentRuntimeSession>(KV_KEYS.runtime_sessions);
		const now = nowIso();
		const idx = rows.findIndex(r => r.agent_tenant === session.agent_tenant);
		if (idx >= 0) {
			rows[idx] = {
				...rows[idx],
				session_id: session.session_id,
				status: session.status,
				trigger_mode: session.trigger_mode,
				source_task_id: session.source_task_id,
				metadata: session.metadata ?? {},
				last_resumed_at: session.last_resumed_at,
				updated_at: now
			};
			await this.writeCollection(KV_KEYS.runtime_sessions, rows);
			return rows[idx];
		}

		const created: AgentRuntimeSession = {
			id: generateId("runtime_session"),
			tenant_id: this.tenant,
			agent_tenant: session.agent_tenant,
			session_id: session.session_id,
			status: session.status,
			trigger_mode: session.trigger_mode,
			source_task_id: session.source_task_id,
			metadata: session.metadata ?? {},
			last_resumed_at: session.last_resumed_at,
			created_at: now,
			updated_at: now
		};
		rows.push(created);
		await this.writeCollection(KV_KEYS.runtime_sessions, rows);
		return created;
	}

	async getAgentRuntimeSession(agentTenant: string): Promise<AgentRuntimeSession | null> {
		const rows = await this.readCollection<AgentRuntimeSession>(KV_KEYS.runtime_sessions);
		return rows.find(r => r.agent_tenant === agentTenant) ?? null;
	}

	async createAgentRuntimeRun(
		run: Omit<AgentRuntimeRun, "id" | "tenant_id" | "created_at">
	): Promise<AgentRuntimeRun> {
		const created: AgentRuntimeRun = {
			id: generateId("runtime_run"),
			tenant_id: this.tenant,
			agent_tenant: run.agent_tenant,
			session_id: run.session_id,
			trigger_mode: run.trigger_mode,
			task_id: run.task_id,
			status: run.status,
			started_at: run.started_at,
			completed_at: run.completed_at,
			next_wake_at: run.next_wake_at,
			summary: run.summary,
			error: run.error,
			metadata: run.metadata ?? {},
			created_at: nowIso()
		};
		const rows = await this.readCollection<AgentRuntimeRun>(KV_KEYS.runtime_runs);
		rows.push(created);
		await this.writeCollection(KV_KEYS.runtime_runs, rows);
		return created;
	}

	async listAgentRuntimeRuns(agentTenant: string, limit = 20): Promise<AgentRuntimeRun[]> {
		const rows = await this.readCollection<AgentRuntimeRun>(KV_KEYS.runtime_runs);
		return rows
			.filter(r => r.agent_tenant === agentTenant)
			.sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at))
			.slice(0, Math.max(1, Math.min(limit, 100)));
	}

	async upsertAgentRuntimePolicy(
		policy: Omit<AgentRuntimePolicy, "id" | "tenant_id" | "created_at" | "updated_at">
	): Promise<AgentRuntimePolicy> {
		const rows = await this.readCollection<AgentRuntimePolicy>(KV_KEYS.runtime_policies);
		const now = nowIso();
		const idx = rows.findIndex(r => r.agent_tenant === policy.agent_tenant);
		if (idx >= 0) {
			rows[idx] = {
				...rows[idx],
				execution_mode: policy.execution_mode,
				daily_wake_budget: policy.daily_wake_budget,
				impulse_wake_budget: policy.impulse_wake_budget,
				reserve_wakes: policy.reserve_wakes,
				min_impulse_interval_minutes: policy.min_impulse_interval_minutes,
				max_tool_calls_per_run: policy.max_tool_calls_per_run,
				max_parallel_delegations: policy.max_parallel_delegations,
				require_priority_clear_for_impulse: policy.require_priority_clear_for_impulse,
				updated_by: policy.updated_by,
				metadata: policy.metadata ?? {},
				updated_at: now
			};
			await this.writeCollection(KV_KEYS.runtime_policies, rows);
			return rows[idx];
		}

		const created: AgentRuntimePolicy = {
			id: generateId("runtime_policy"),
			tenant_id: this.tenant,
			agent_tenant: policy.agent_tenant,
			execution_mode: policy.execution_mode,
			daily_wake_budget: policy.daily_wake_budget,
			impulse_wake_budget: policy.impulse_wake_budget,
			reserve_wakes: policy.reserve_wakes,
			min_impulse_interval_minutes: policy.min_impulse_interval_minutes,
			max_tool_calls_per_run: policy.max_tool_calls_per_run,
			max_parallel_delegations: policy.max_parallel_delegations,
			require_priority_clear_for_impulse: policy.require_priority_clear_for_impulse,
			updated_by: policy.updated_by,
			metadata: policy.metadata ?? {},
			created_at: now,
			updated_at: now
		};
		rows.push(created);
		await this.writeCollection(KV_KEYS.runtime_policies, rows);
		return created;
	}

	async getAgentRuntimePolicy(agentTenant: string): Promise<AgentRuntimePolicy | null> {
		const rows = await this.readCollection<AgentRuntimePolicy>(KV_KEYS.runtime_policies);
		return rows.find(r => r.agent_tenant === agentTenant) ?? null;
	}

	async getAgentRuntimeUsage(agentTenant: string, since: string): Promise<AgentRuntimeUsage> {
		const sinceMs = toMillis(since);
		const rows = (await this.readCollection<AgentRuntimeRun>(KV_KEYS.runtime_runs))
			.filter(r => r.agent_tenant === agentTenant)
			.filter(r => toMillis(r.created_at) >= sinceMs);

		const wakeKind = (run: AgentRuntimeRun): string => {
			const meta = run.metadata ?? {};
			const kind = meta.wake_kind;
			return typeof kind === "string" ? kind : "duty";
		};

		const dutyRuns = rows.filter(r => wakeKind(r) === "duty");
		const impulseRuns = rows.filter(r => wakeKind(r) === "impulse");
		const lastRun = rows.sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at))[0];
		const lastImpulse = impulseRuns.sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at))[0];

		return {
			agent_tenant: agentTenant,
			since,
			total_runs: rows.length,
			duty_runs: dutyRuns.length,
			impulse_runs: impulseRuns.length,
			last_run_at: lastRun?.created_at,
			last_impulse_run_at: lastImpulse?.created_at
		};
	}

	// ============ AGENT HOUSE TRUST LAYER (v1.8) ============

	async recordAgentLease(
		lease: Omit<AgentLeaseRecord, "id" | "tenant_id" | "created_at" | "updated_at">
	): Promise<AgentLeaseRecord> {
		const rows = await this.readCollection<AgentLeaseRecord>(KV_KEYS.agent_leases);
		const now = nowIso();
		const existingIndex = rows.findIndex(row => row.lease_id === lease.lease_id);
		const next: AgentLeaseRecord = {
			id: existingIndex >= 0 ? rows[existingIndex].id : generateId("lease_rec"),
			tenant_id: this.tenant,
			lease_id: lease.lease_id,
			agent_id: lease.agent_id,
			platform: lease.platform,
			session_id: lease.session_id,
			run_id: lease.run_id,
			parent_lease_id: lease.parent_lease_id,
			delegation_chain: lease.delegation_chain ?? [],
			capabilities: lease.capabilities ?? [],
			scope: lease.scope ?? {},
			status: lease.status ?? "active",
			issued_at: lease.issued_at,
			expires_at: lease.expires_at,
			last_heartbeat_at: lease.last_heartbeat_at,
			process_id: lease.process_id,
			metadata: lease.metadata ?? {},
			created_at: existingIndex >= 0 ? rows[existingIndex].created_at : now,
			updated_at: now
		};
		if (existingIndex >= 0) rows[existingIndex] = next;
		else rows.push(next);
		await this.writeCollection(KV_KEYS.agent_leases, rows);
		return next;
	}

	async getAgentLease(leaseId: string): Promise<AgentLeaseRecord | null> {
		const rows = await this.readCollection<AgentLeaseRecord>(KV_KEYS.agent_leases);
		return rows.find(row => row.lease_id === leaseId) ?? null;
	}

	async heartbeatAgentLease(leaseId: string, processId?: string): Promise<AgentLeaseRecord | null> {
		const rows = await this.readCollection<AgentLeaseRecord>(KV_KEYS.agent_leases);
		const idx = rows.findIndex(row => row.lease_id === leaseId && row.status === "active");
		if (idx < 0) return null;
		rows[idx] = {
			...rows[idx],
			last_heartbeat_at: nowIso(),
			process_id: processId ?? rows[idx].process_id,
			updated_at: nowIso()
		};
		await this.writeCollection(KV_KEYS.agent_leases, rows);
		return rows[idx];
	}

	async expireAgentLeasesForProcess(processId: string, status: "expired" | "revoked" = "expired"): Promise<number> {
		const rows = await this.readCollection<AgentLeaseRecord>(KV_KEYS.agent_leases);
		const now = nowIso();
		let changed = 0;
		const next = rows.map(row => {
			if (row.process_id === processId && row.status === "active") {
				changed += 1;
				return { ...row, status, updated_at: now };
			}
			return row;
		});
		if (changed > 0) await this.writeCollection(KV_KEYS.agent_leases, next);
		return changed;
	}

	async reapExpiredAgentLeases(nowIsoValue?: string): Promise<number> {
		const rows = await this.readCollection<AgentLeaseRecord>(KV_KEYS.agent_leases);
		const now = nowIsoValue ?? nowIso();
		const nowMs = toMillis(now);
		let changed = 0;
		const next = rows.map(row => {
			if (row.status === "active" && toMillis(row.expires_at) <= nowMs) {
				changed += 1;
				return { ...row, status: "expired" as const, updated_at: now };
			}
			return row;
		});
		if (changed > 0) await this.writeCollection(KV_KEYS.agent_leases, next);
		return changed;
	}

	async createAgentAuditEvent(
		event: Omit<AgentAuditEvent, "id" | "tenant_id" | "created_at">
	): Promise<AgentAuditEvent> {
		const created: AgentAuditEvent = {
			id: generateId("audit_evt"),
			tenant_id: this.tenant,
			event_type: event.event_type,
			actor_agent_id: event.actor_agent_id,
			lease_id: event.lease_id,
			platform: event.platform,
			session_id: event.session_id,
			run_id: event.run_id,
			delegation_chain: event.delegation_chain ?? [],
			operation: event.operation,
			tool_name: event.tool_name,
			resource: event.resource ?? {},
			result: event.result,
			reason: event.reason,
			payload_hash: event.payload_hash,
			diff: event.diff ?? {},
			metadata: event.metadata ?? {},
			created_at: nowIso()
		};
		const rows = await this.readCollection<AgentAuditEvent>(KV_KEYS.agent_audit_events);
		rows.push(created);
		await this.writeCollection(KV_KEYS.agent_audit_events, rows);
		return created;
	}

	async listAgentAuditEvents(filter: AgentAuditEventFilter = {}): Promise<AgentAuditEvent[]> {
		const createdAfterMs = filter.created_after ? toMillis(filter.created_after) : 0;
		const cap = Math.max(1, Math.min(filter.limit ?? 50, 200));
		let rows = await this.readCollection<AgentAuditEvent>(KV_KEYS.agent_audit_events);
		if (filter.event_type) rows = rows.filter(row => row.event_type === filter.event_type);
		if (filter.actor_agent_id) rows = rows.filter(row => row.actor_agent_id === filter.actor_agent_id);
		if (filter.lease_id) rows = rows.filter(row => row.lease_id === filter.lease_id);
		if (filter.result) rows = rows.filter(row => row.result === filter.result);
		if (createdAfterMs > 0) rows = rows.filter(row => toMillis(row.created_at) >= createdAfterMs);
		return rows
			.sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at))
			.slice(0, cap);
	}
	// ============ LIMBIC CONFIG (Phase 1) ============

	async getLimbicConfig(): Promise<{ enabled: boolean; natal: unknown } | null> {
		// SQLite uses kv_store — limbic_config key stores a JSON object.
		// No row = null (feature off). natal is TEXT (JSON-encoded) vs JSONB in Postgres.
		return this.readValue<{ enabled: boolean; natal: unknown } | null>(
			KV_KEYS.limbic_config,
			null
		);
	}
}

export function createSQLiteStorage(sqlitePath: string, tenant: string, allowedTenants?: readonly string[]): SQLiteBrainStorage {
	const normalizedAllowedTenants = normalizeAllowedTenants(allowedTenants);
	if (!isAllowedTenant(tenant, normalizedAllowedTenants)) throw new Error(`Invalid tenant: ${tenant}`);
	if (sqlitePath.includes("\0")) {
		throw new Error("Invalid sqlite path");
	}
	return new SQLiteBrainStorage(sqlitePath, tenant, undefined, normalizedAllowedTenants);
}
