import { describe, it, expect, vi } from 'vitest';

import { createStorage } from '../src/storage/factory';
import { SQLiteBrainStorage } from '../src/storage/sqlite';
import { getRetrievalProfileConfig } from '../src/retrieval/query-signals';
import type { HybridScoreBreakdown } from '../src/retrieval/scoring';
import type { Texture } from '../src/types';

describe('sqlite storage backend', () => {
	it('boots with defaults and persists observations', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');

		const state = await storage.readBrainState();
		expect(state.current_mood).toBe('neutral');

		const obsId = `obs_${Date.now()}`;
		await storage.appendToTerritory('craft', {
			id: obsId,
			content: 'sqlite backend smoke memory',
			territory: 'craft',
			created: new Date().toISOString(),
			texture: {
				salience: 'active',
				vividness: 'vivid',
				charge: ['clarity'],
				grip: 'present',
				charge_phase: 'fresh'
			},
			access_count: 0
		});

		const found = await storage.findObservation(obsId);
		expect(found?.observation.content).toContain('sqlite backend smoke memory');

		const queried = await storage.queryObservations({ territory: 'craft', limit: 10 });
		expect(queried.some(row => row.observation.id === obsId)).toBe(true);
	});

	it('supports task and runtime policy flows', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');

		const task = await storage.createTask({
			title: 'ship sqlite',
			status: 'open',
			priority: 'high',
			linked_observation_ids: [],
			linked_entity_ids: []
		});
		expect(task.id).toMatch(/^task_/);

		const openTasks = await storage.listTasks('open', undefined, 20, false);
		expect(openTasks.some(t => t.id === task.id)).toBe(true);

		const policy = await storage.upsertAgentRuntimePolicy({
			agent_tenant: 'companion',
			execution_mode: 'balanced',
			daily_wake_budget: 9,
			impulse_wake_budget: 4,
			reserve_wakes: 1,
			min_impulse_interval_minutes: 90,
			max_tool_calls_per_run: 20,
			max_parallel_delegations: 1,
			require_priority_clear_for_impulse: true,
			updated_by: 'test',
			metadata: {}
		});
		expect(policy.execution_mode).toBe('balanced');

		await storage.createAgentRuntimeRun({
			agent_tenant: 'companion',
			trigger_mode: 'manual',
			status: 'succeeded',
			metadata: { wake_kind: 'duty' }
		});

		const usage = await storage.getAgentRuntimeUsage('companion', new Date(Date.now() - 60_000).toISOString());
		expect(usage.total_runs).toBe(1);
		expect(usage.duty_runs).toBe(1);
	});

	it('persists agent leases and audit events for the trust layer', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'rainer');
		const issued = '2026-05-11T12:00:00.000Z';
		const expires = '2026-05-11T13:00:00.000Z';

		const lease = await storage.recordAgentLease({
			lease_id: 'lease_sqlite_test',
			agent_id: 'salem',
			platform: 'codex',
			session_id: 'session_1',
			run_id: 'run_1',
			delegation_chain: ['falco', 'rainer', 'salem'],
			capabilities: ['memory.read'],
			scope: { tenant: 'rainer', territories: ['craft'] },
			status: 'active',
			issued_at: issued,
			expires_at: expires,
			process_id: 'proc_1',
			metadata: { source: 'test' }
		});

		expect(lease.lease_id).toBe('lease_sqlite_test');
		expect((await storage.getAgentLease('lease_sqlite_test'))?.agent_id).toBe('salem');

		const heartbeat = await storage.heartbeatAgentLease('lease_sqlite_test', 'proc_2');
		expect(heartbeat?.process_id).toBe('proc_2');
		expect(heartbeat?.last_heartbeat_at).toBeDefined();

		await storage.createAgentAuditEvent({
			event_type: 'lease_denied',
			actor_agent_id: 'salem',
			lease_id: 'lease_sqlite_test',
			platform: 'codex',
			session_id: 'session_1',
			run_id: 'run_1',
			delegation_chain: ['falco', 'rainer', 'salem'],
			operation: 'observe.write',
			tool_name: 'mind_observe',
			resource: { territory: 'craft' },
			result: 'denied',
			reason: 'lease capability denied',
			diff: {},
			metadata: { enforcement_mode: 'required' }
		});

		const denied = await storage.listAgentAuditEvents({ result: 'denied', lease_id: 'lease_sqlite_test' });
		expect(denied).toHaveLength(1);
		expect(denied[0].diff).toEqual({});

		const expiredCount = await storage.expireAgentLeasesForProcess('proc_2');
		expect(expiredCount).toBe(1);
		expect((await storage.getAgentLease('lease_sqlite_test'))?.status).toBe('expired');
	});

	it('keeps non-entity matches when entity_id is set and includes entity-only candidates', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');

		const now = new Date().toISOString();
		await storage.appendToTerritory('craft', {
			id: 'obs_entity_keyword',
			content: 'alpha project update',
			territory: 'craft',
			created: now,
			entity_id: 'entity_alpha',
			texture: { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' },
			access_count: 0
		});
		await storage.appendToTerritory('craft', {
			id: 'obs_non_entity_keyword',
			content: 'alpha notes without linked entity',
			territory: 'craft',
			created: now,
			texture: { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' },
			access_count: 0
		});
		await storage.appendToTerritory('craft', {
			id: 'obs_entity_only',
			content: 'unrelated text body',
			territory: 'craft',
			created: now,
			entity_id: 'entity_alpha',
			texture: { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' },
			access_count: 0
		});

		const results = await storage.hybridSearch({
			query: 'alpha',
			entity_id: 'entity_alpha',
			limit: 10,
			min_similarity: 0.1
		});

		const ids = results.map(r => r.observation.id);
		expect(ids).toContain('obs_non_entity_keyword');
		expect(ids).toContain('obs_entity_only');
	});

	it('applies retrieval profiles, signal boosts, and profile-sized candidate pools', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');
		const now = new Date().toISOString();

		for (let i = 0; i < 60; i++) {
			await storage.appendToTerritory('craft', {
				id: `obs_bulk_${i}`,
				content: `atlas memo ${i}`,
				territory: 'craft',
				created: now,
				texture: { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' },
				access_count: 0
			});
		}
		await storage.appendToTerritory('craft', {
			id: 'obs_quoted_target',
			content: 'atlas note with exact memory palace phrase',
			territory: 'craft',
			created: now,
			type: 'assistant_response',
			tags: ['assistant'],
			texture: { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' },
			access_count: 0
		});

		// "legacy" (candidate_pool 50/30, frozen) vs "fused" (default, candidate_pool
		// 100/60) — native/balanced/benchmark all collapsed into "fused" as aliases
		// (ADR-RETRIEVAL-FUSION-RETUNE §9), so a pool-size comparison needs legacy vs
		// fused now, not native vs benchmark.
		const legacyRun = await storage.hybridSearch({
			query: 'what did you say about "memory palace" atlas',
			retrieval_profile: 'legacy',
			limit: 50,
			min_similarity: 0.01
		});
		const fusedRun = await storage.hybridSearch({
			query: 'what did you say about "memory palace" atlas',
			retrieval_profile: 'fused',
			limit: 50,
			min_similarity: 0.01
		});

		expect(legacyRun.length).toBeLessThan(fusedRun.length);
		expect(fusedRun[0].observation.id).toBe('obs_quoted_target');
		expect(fusedRun[0].score_breakdown?.profile).toBe('fused');
		expect(fusedRun[0].match_sources).toContain('quoted_phrase');
	});

	it('IDF-weights signal_idf.proper_name through the real hybridSearch — near the full config weight when the signal is rare, ~0 when it is ubiquitous (Reeve LOW wiring coverage, ADR §3)', async () => {
		const texture: Texture = { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' };
		const SET_SIZE = 15; // comfortably under fused's entity candidate_pool of 20.
		const properNameWeight = getRetrievalProfileConfig('fused').query_signal_boosts.proper_name;

		// Case 1: proper name "Mira" matches exactly 1 of 15 candidates in the merged
		// set (entity_id links all 15 into the candidate pool regardless of content) —
		// idf_w = 1 - 1/15 ≈ 0.93, so signal_idf.proper_name should sit close to the
		// full, un-discounted config weight.
		const rareDbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const rareStorage = createStorage({ backend: 'sqlite', sqlitePath: rareDbPath }, 'companion');
		for (let i = 0; i < SET_SIZE - 1; i++) {
			await rareStorage.appendToTerritory('craft', {
				id: `obs_rare_filler_${i}`, content: `unrelated filler note ${i}`, territory: 'craft',
				created: '2026-08-01T00:00:00.000Z', entity_id: 'entity_rare', texture, access_count: 0
			});
		}
		await rareStorage.appendToTerritory('craft', {
			id: 'obs_rare_mira', content: 'Mira said something interesting today', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', entity_id: 'entity_rare', texture, access_count: 0
		});
		const rareResults = await rareStorage.hybridSearch({
			query: 'tell me about Mira',
			entity_id: 'entity_rare',
			retrieval_profile: 'fused',
			limit: 50,
			min_similarity: 0.001
		});
		const rareMatch = rareResults.find(r => r.observation.id === 'obs_rare_mira');
		expect(rareMatch).toBeDefined();
		expect(rareMatch?.score_breakdown?.profile).toBe('fused');
		const rareBreakdown = rareMatch!.score_breakdown as HybridScoreBreakdown;
		expect(rareBreakdown.layer_a.signal_idf.proper_name).toBeGreaterThan(properNameWeight * 0.85);

		// Case 2: "Mira" matches all 15 of 15 candidates — idf_w = 0, so
		// signal_idf.proper_name collapses to ~0 for every one of them.
		const commonDbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const commonStorage = createStorage({ backend: 'sqlite', sqlitePath: commonDbPath }, 'companion');
		for (let i = 0; i < SET_SIZE; i++) {
			await commonStorage.appendToTerritory('craft', {
				id: `obs_common_mira_${i}`, content: `Mira note filler ${i}`, territory: 'craft',
				created: '2026-08-01T00:00:00.000Z', entity_id: 'entity_common', texture, access_count: 0
			});
		}
		const commonResults = await commonStorage.hybridSearch({
			query: 'tell me about Mira',
			entity_id: 'entity_common',
			retrieval_profile: 'fused',
			limit: 50,
			min_similarity: 0.001
		});
		expect(commonResults.length).toBeGreaterThan(0);
		for (const r of commonResults) {
			expect(r.score_breakdown?.profile).toBe('fused');
			const breakdown = r.score_breakdown as HybridScoreBreakdown;
			expect(breakdown.layer_a.signal_idf.proper_name).toBeCloseTo(0, 6);
		}
	});

	it('applies the resolved profile min_score as the default floor when the caller passes no min_similarity (band migration, ADR §1)', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');
		const texture: Texture = { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' };

		// Entity-only match, no vector/keyword/hint overlap with the query at all —
		// scores exactly lane_weights.entity (0.07 for fused) times the Layer B
		// multiplier, comfortably between fused's min_score (0.02) and the old
		// blanket min_similarity default (0.3) this replaces.
		await storage.appendToTerritory('craft', {
			id: 'obs_entity_low_score', content: 'zzz completely unrelated body zzz', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', entity_id: 'entity_low', texture, access_count: 0
		});

		const fused = await storage.hybridSearch({
			query: 'qqq no overlap qqq',
			entity_id: 'entity_low',
			retrieval_profile: 'fused'
			// no min_similarity — must fall back to fused's own min_score (0.02).
		});
		expect(fused.some(r => r.observation.id === 'obs_entity_low_score')).toBe(true);

		// Legacy's own default-min_similarity value (still 0.3, unchanged) is proven
		// precisely at the pure-function level in retrieval-scoring.spec.ts ("defaults
		// min_similarity to 0.3 when omitted"); this call just confirms the storage
		// layer still routes retrieval_profile: "legacy" end to end.
		const legacy = await storage.hybridSearch({
			query: 'qqq no overlap qqq',
			entity_id: 'entity_low',
			retrieval_profile: 'legacy'
		});
		const legacyResult = legacy.find(r => r.observation.id === 'obs_entity_low_score');
		expect(legacyResult?.score_breakdown?.profile).toBe('legacy');
	});

	it('applies profile_overrides.rrf_k only to the "fused" profile, never to "flat" (ADR §1 Rook\'s note sweep is fused-only)', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');
		const texture: Texture = { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' };

		// Two keyword-matched candidates at distinct ranks (rank 1 and rank 2) so a
		// change in K actually moves the rank-2 candidate's score — rank 1 alone is
		// K-invariant (I4: rank-1 in a lane always scores exactly that lane's weight).
		await storage.appendToTerritory('craft', {
			id: 'obs_rank1', content: 'zeta override rank probe alpha alpha alpha', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
		});
		await storage.appendToTerritory('craft', {
			id: 'obs_rank2', content: 'zeta override rank probe', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
		});

		const scoreFor = async (profile: 'fused' | 'flat', rrfK: number | undefined) => {
			const results = await storage.hybridSearch({
				query: 'zeta override rank probe',
				retrieval_profile: profile,
				min_similarity: 0,
				profile_overrides: rrfK !== undefined ? { rrf_k: rrfK } : undefined
			});
			return results.find(r => r.observation.id === 'obs_rank2')?.score;
		};

		const fusedDefault = await scoreFor('fused', undefined);
		const fusedOverridden = await scoreFor('fused', 1);
		const flatDefault = await scoreFor('flat', undefined);
		const flatOverridden = await scoreFor('flat', 1);

		expect(fusedDefault).toBeDefined();
		expect(flatDefault).toBeDefined();
		// K=1 vs K=60 (default) changes the RRF denominator materially — fused's
		// rank-2 candidate score MUST move when the override is applied.
		expect(fusedOverridden).not.toBeCloseTo(fusedDefault!, 6);
		// The same override, applied to "flat", must be a no-op — the storage layer
		// only merges profile_overrides when the resolved profile is "fused".
		expect(flatOverridden).toBeCloseTo(flatDefault!, 10);
	});

	it('rejects a malformed profile_overrides at the merge point instead of silently merging it (Michael LOW — programming-error boundary)', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');

		await expect(storage.hybridSearch({
			query: 'zeta override rank probe',
			retrieval_profile: 'fused',
			profile_overrides: { rrf_k: 0 }
		})).rejects.toThrow(/rrf_k/);

		await expect(storage.hybridSearch({
			query: 'zeta override rank probe',
			retrieval_profile: 'fused',
			profile_overrides: { lane_weights: { vector: 0.5, keyword: 0.5, entity: 0.5, hint: 0.5 } }
		})).rejects.toThrow(/sum to 1/);

		// The same malformed override, applied to "flat", must never reach
		// validateProfileOverrides at all — only "fused" merges profile_overrides.
		const flatResults = await storage.hybridSearch({
			query: 'zeta override rank probe',
			retrieval_profile: 'flat',
			profile_overrides: { rrf_k: 0 }
		});
		expect(flatResults).toBeInstanceOf(Array);
	});

	it('surfaces hint-only temporal candidates in balanced/benchmark retrieval', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');

		await storage.appendToTerritory('craft', {
			id: 'obs_temporal_hint_only',
			content: 'meeting recap with no explicit month token',
			territory: 'craft',
			created: '2026-04-09T10:00:00.000Z',
			texture: { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' },
			access_count: 0
		});

		const results = await storage.hybridSearch({
			query: 'what happened in april 2026',
			retrieval_profile: 'benchmark',
			limit: 10,
			min_similarity: 0.01
		});

		expect(results.some(result => result.observation.id === 'obs_temporal_hint_only')).toBe(true);
		const target = results.find(result => result.observation.id === 'obs_temporal_hint_only');
		expect(target?.match_sources).toContain('hint');
		expect(target?.match_sources).toContain('temporal_hint');
		expect(target?.lane_ranks?.hint).toBe(1);
	});

	it('attaches 1-based lane_ranks per candidate, distinct from the keyword_rank magnitude', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');
		const texture: Texture = { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' };

		// Vector lane: two candidates, ranked by cosine similarity to the query embedding.
		await storage.appendToTerritory('craft', {
			id: 'obs_vec_best', content: 'vector-only content alpha', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
		});
		await storage.updateObservationEmbedding('obs_vec_best', [1, 0, 0]);
		await storage.appendToTerritory('craft', {
			id: 'obs_vec_second', content: 'vector-only content beta', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
		});
		await storage.updateObservationEmbedding('obs_vec_second', [0.9, 0.1, 0]);

		// Keyword lane: two candidates with different token-overlap magnitude against the query.
		await storage.appendToTerritory('craft', {
			id: 'obs_kw_best', content: 'atlas migration timeline plan', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
		});
		await storage.appendToTerritory('craft', {
			id: 'obs_kw_second', content: 'atlas migration notes only', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
		});

		// Entity lane: two candidates linked to the same entity, ranked by created_at desc.
		await storage.appendToTerritory('craft', {
			id: 'obs_entity_newer', content: 'unrelated body text one', territory: 'craft',
			created: '2026-08-02T00:00:00.000Z', entity_id: 'entity_zeta', texture, access_count: 0
		});
		await storage.appendToTerritory('craft', {
			id: 'obs_entity_older', content: 'unrelated body text two', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', entity_id: 'entity_zeta', texture, access_count: 0
		});

		const results = await storage.hybridSearch({
			query: 'atlas migration timeline plan',
			embedding: [1, 0, 0],
			entity_id: 'entity_zeta',
			limit: 20,
			min_similarity: 0.01
		});
		const byId = new Map(results.map(r => [r.observation.id, r]));

		expect(byId.get('obs_vec_best')?.lane_ranks?.vector).toBe(1);
		expect(byId.get('obs_vec_second')?.lane_ranks?.vector).toBe(2);
		// Not in the keyword lane at all — no key, not a rank of 0.
		expect(byId.get('obs_vec_best')?.lane_ranks?.keyword).toBeUndefined();

		expect(byId.get('obs_kw_best')?.lane_ranks?.keyword).toBe(1);
		expect(byId.get('obs_kw_second')?.lane_ranks?.keyword).toBe(2);
		// keyword_rank is the untouched ts_rank-equivalent magnitude (0-1 match ratio here),
		// never the position — the two must not collide on the same field.
		expect(byId.get('obs_kw_best')?.keyword_rank).toBe(1);
		expect(byId.get('obs_kw_second')?.keyword_rank).toBeCloseTo(0.5, 5);

		expect(byId.get('obs_entity_newer')?.lane_ranks?.entity).toBe(1);
		expect(byId.get('obs_entity_older')?.lane_ranks?.entity).toBe(2);
	});

	it('probeLanes locates requested ids within vector/keyword pools at a given depth, null when absent', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');
		const texture: Texture = { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' };

		await storage.appendToTerritory('craft', {
			id: 'obs_a', content: 'alpha beta gamma', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
		});
		await storage.updateObservationEmbedding('obs_a', [1, 0, 0]);
		await storage.appendToTerritory('craft', {
			id: 'obs_b', content: 'alpha only', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
		});
		await storage.updateObservationEmbedding('obs_b', [0.5, 0.5, 0]);
		// obs_c: no embedding, no keyword overlap with the query — reachable in neither lane.
		await storage.appendToTerritory('craft', {
			id: 'obs_c', content: 'totally unrelated content', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
		});

		const result = await storage.probeLanes({
			query: 'alpha beta gamma',
			embedding: [1, 0, 0],
			ids: ['obs_a', 'obs_b', 'obs_c', 'obs_missing'],
			depth: 10
		});

		expect(result.depth).toBe(10);
		const byId = new Map(result.items.map(item => [item.id, item]));

		expect(byId.get('obs_a')?.vector_position).toBe(1);
		expect(byId.get('obs_a')?.vector_similarity).toBeCloseTo(1, 5);
		expect(byId.get('obs_a')?.keyword_position).toBe(1);
		expect(byId.get('obs_a')?.keyword_ts_rank).toBeCloseTo(1, 5);

		expect(byId.get('obs_b')?.vector_position).toBe(2);
		expect(byId.get('obs_b')?.keyword_position).toBe(2);
		expect(byId.get('obs_b')?.keyword_ts_rank).toBeCloseTo(1 / 3, 5);

		// Not reachable in either lane, and a wholly unknown id — both come back null, not 0/undefined.
		expect(byId.get('obs_c')?.vector_position).toBeNull();
		expect(byId.get('obs_c')?.vector_similarity).toBeNull();
		expect(byId.get('obs_c')?.keyword_position).toBeNull();
		expect(byId.get('obs_missing')?.vector_position).toBeNull();
		expect(byId.get('obs_missing')?.keyword_position).toBeNull();

		expect(result.lanes.vector.returned).toBe(2);
		expect(result.lanes.vector.top1).toBe(1);
		expect(result.lanes.vector.at_depth).toBe(2);
		expect(result.lanes.keyword.returned).toBe(2);
		expect(result.lanes.keyword.top1).toBe(1);
		expect(result.lanes.keyword.at_depth).toBe(2);
	});

	it('probeLanes: an item ranked one past depth is null at that boundary, not truncation noise', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');
		const texture: Texture = { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' };

		// obs_near: cosine-closest to the query, lands at vector position 1 (within depth 1).
		await storage.appendToTerritory('craft', {
			id: 'obs_near', content: 'alpha beta gamma', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
		});
		await storage.updateObservationEmbedding('obs_near', [1, 0, 0]);
		// obs_far: less similar, would land at vector position 2 — one past a depth of 1.
		await storage.appendToTerritory('craft', {
			id: 'obs_far', content: 'alpha beta gamma', territory: 'craft',
			created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
		});
		await storage.updateObservationEmbedding('obs_far', [0, 1, 0]);

		const result = await storage.probeLanes({
			query: 'alpha beta gamma',
			embedding: [1, 0, 0],
			ids: ['obs_near', 'obs_far'],
			depth: 1
		});

		const byId = new Map(result.items.map(item => [item.id, item]));
		expect(byId.get('obs_near')?.vector_position).toBe(1);
		// Ranked at position 2, past a depth-1 pool — null, not a stale/leaked position.
		expect(byId.get('obs_far')?.vector_position).toBeNull();
		expect(result.lanes.vector.returned).toBe(1);
		expect(result.lanes.vector.at_depth).toBe(1);
	});

	it('probeLanes clamps an oversized depth to 5000', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');

		const result = await storage.probeLanes({
			query: 'alpha',
			ids: ['obs_missing'],
			depth: 999999
		});

		expect(result.depth).toBe(5000);
	});

	it('rejects invalid tenant at constructor boundary', () => {
		expect(() => new SQLiteBrainStorage('/tmp/muse-brain-test.sqlite', 'invalid-tenant')).toThrow(/Invalid tenant/);
	});

	// ops/ADR-JANITOR.md §5.1 — sqlite counterpart to postgres-foundation-ranking.spec.ts.
	// readFoundationalObservations() here routes through the same shared
	// rankFoundationalByPullStrength helper as postgres.ts, but until now nothing in this
	// file drove it — a backend with no test on the shared helper is exactly where the two
	// backends could silently drift back onto different rankings. Drives the real storage
	// method against a real sqlite file (createStorage), not a mock.
	describe('readFoundationalObservations — ranks by pull strength, not recency', () => {
		const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

		it('an old, high-pull-strength row ranks ahead of a new, low-pull-strength row', async () => {
			const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
			const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');

			// Insertion order deliberately puts the recency-favored row first — if this
			// ever regressed to ordering by created/last_accessed before ranking, the
			// new-but-dormant row would lead.
			await storage.appendToTerritory('self', {
				id: 'obs_new_dormant',
				content: 'a new but dormant foundational memory',
				territory: 'self',
				created: daysAgo(0),
				last_accessed: daysAgo(0),
				texture: { salience: 'foundational', vividness: 'faded', charge: [], grip: 'dormant' },
				access_count: 0
			});
			await storage.appendToTerritory('self', {
				id: 'obs_old_alive',
				content: 'an old but high-pull-strength foundational memory',
				territory: 'self',
				created: daysAgo(400),
				last_accessed: daysAgo(400),
				texture: { salience: 'foundational', vividness: 'crystalline', charge: ['identity', 'vow', 'home', 'grief'], grip: 'iron' },
				access_count: 20
			});

			const result = await storage.readFoundationalObservations();
			const ids = result.map(r => r.observation.id);

			expect(ids).toEqual(['obs_old_alive', 'obs_new_dormant']);
		});

		it('truncation past the cap drops the least-alive row, keeping an old-but-alive row over a new-but-dormant one', async () => {
			const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
			const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');

			// 200 filler rows at a middling pull strength, all newer and less "alive" than
			// obs_old_alive but more alive than obs_new_dormant — enough rows that the cap
			// (FOUNDATIONAL_LANE_CAP = 200) has to actually drop someone. This is the case
			// that matters: a high-pull-strength old row surviving where a recency-first
			// ordering would have dropped it before the ranker ever saw it.
			for (let i = 0; i < 200; i++) {
				await storage.appendToTerritory('self', {
					id: `obs_filler_${i}`,
					content: `filler foundational memory ${i}`,
					territory: 'self',
					created: daysAgo(5),
					last_accessed: daysAgo(5),
					texture: { salience: 'foundational', vividness: 'vivid', charge: ['a', 'b'], grip: 'strong' },
					access_count: 3
				});
			}
			await storage.appendToTerritory('self', {
				id: 'obs_old_alive',
				content: 'an old but high-pull-strength foundational memory',
				territory: 'self',
				created: daysAgo(400),
				last_accessed: daysAgo(400),
				texture: { salience: 'foundational', vividness: 'crystalline', charge: ['identity', 'vow', 'home', 'grief'], grip: 'iron' },
				access_count: 20
			});
			await storage.appendToTerritory('self', {
				id: 'obs_new_dormant',
				content: 'a new but dormant foundational memory',
				territory: 'self',
				created: daysAgo(0),
				last_accessed: daysAgo(0),
				texture: { salience: 'foundational', vividness: 'faded', charge: [], grip: 'dormant' },
				access_count: 0
			});

			const result = await storage.readFoundationalObservations();
			const ids = new Set(result.map(r => r.observation.id));

			expect(result.length).toBe(200);
			// The high-pull-strength row survives despite being the oldest by far.
			expect(ids.has('obs_old_alive')).toBe(true);
			// The newest row is the one that gets dropped, because it's the least alive —
			// the exact inversion of a recency-first ordering.
			expect(ids.has('obs_new_dormant')).toBe(false);
		});
	});

	// ops/ADR-JANITOR.md §6.2 — findSimilarUnlinked minus the link/pending-proposal
	// exclusions, plus a minSimilarity floor. Real sqlite backend, not a mock —
	// same rationale as this file's other describe blocks: sqlite is the only
	// backend where JS-side filtering semantics can be exercised end to end.
	describe('findSimilarByEmbedding', () => {
		it('excludes the source id, respects minSimilarity, and does NOT exclude an already-linked candidate', async () => {
			const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
			const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');
			const texture: Texture = { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' };

			await storage.appendToTerritory('craft', {
				id: 'obs_source', content: 'source memory', territory: 'craft',
				created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
			});
			await storage.updateObservationEmbedding('obs_source', [1, 0, 0]);

			// Already linked to the source — findSimilarUnlinked would exclude this;
			// findSimilarByEmbedding must NOT (§0.4 item 3 — a linked duplicate pair
			// is exactly what dedup needs to see).
			await storage.appendToTerritory('craft', {
				id: 'obs_linked', content: 'a near-duplicate that is already linked', territory: 'craft',
				created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
			});
			await storage.updateObservationEmbedding('obs_linked', [0.99, 0.01, 0]);
			await storage.appendLink({
				id: 'link_1', source_id: 'obs_source', target_id: 'obs_linked',
				resonance_type: 'semantic', strength: 'present', origin: 'daemon',
				created: '2026-08-01T00:00:00.000Z', last_activated: '2026-08-01T00:00:00.000Z'
			});

			// Below the floor — must not appear.
			await storage.appendToTerritory('craft', {
				id: 'obs_far', content: 'an unrelated memory', territory: 'craft',
				created: '2026-08-01T00:00:00.000Z', texture, access_count: 0
			});
			await storage.updateObservationEmbedding('obs_far', [0, 1, 0]);

			const results = await storage.findSimilarByEmbedding!('obs_source', 5, 0.5);
			const ids = results.map(r => r.observation.id);

			expect(ids).toContain('obs_linked');
			expect(ids).not.toContain('obs_source');
			expect(ids).not.toContain('obs_far');
		});

		it('returns [] when the source observation has no embedding', async () => {
			const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
			const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');
			await storage.appendToTerritory('craft', {
				id: 'obs_no_embedding', content: 'never embedded', territory: 'craft',
				created: '2026-08-01T00:00:00.000Z',
				texture: { salience: 'active', vividness: 'vivid', charge: [], grip: 'present', charge_phase: 'fresh' },
				access_count: 0
			});

			const results = await storage.findSimilarByEmbedding!('obs_no_embedding', 5, 0.5);

			expect(results).toEqual([]);
		});
	});
});

describe('readValue — corrupted stored JSON', () => {
	it('logs the key name and parse error before falling back to the empty default, without changing the fallback itself', async () => {
		const dbPath = `/tmp/muse-brain-test-corrupt-${crypto.randomUUID()}.sqlite`;
		const storage = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');

		// Trigger table creation via a normal call before reaching in directly below.
		await storage.readWakeLog();

		const sqliteModule: any = await import('node:sqlite');
		const raw = new sqliteModule.DatabaseSync(dbPath);
		raw.prepare(
			"INSERT INTO kv_store (tenant_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
		).run('companion', 'wake_log', '{not valid json', '2026-01-01T00:00:00.000Z');
		raw.close();

		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const logs = await storage.readWakeLog();

			// Fallback behavior is unchanged — corruption still reads back as the empty
			// collection, never thrown, never mistaken for something it isn't.
			expect(logs).toEqual([]);
			expect(errorSpy).toHaveBeenCalledTimes(1);
			const [message] = errorSpy.mock.calls[0];
			expect(message).toContain('wake_log');
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe('charge_valence (ops/ADR-VALENCE-FLOOR.md, slice 0)', () => {
	function freshStorage() {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		return createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');
	}

	it('reads an empty array before any row is written', async () => {
		const storage = freshStorage();
		expect(await storage.readChargeValence!()).toEqual([]);
	});

	it('round-trips a written row', async () => {
		const storage = freshStorage();
		await storage.upsertChargeValence!([{
			charge: 'creative fire',
			valence: 'positive',
			method: 'llm',
			model: '@cf/meta/llama-3.2-3b-instruct',
			classified_at: '2026-09-17T00:00:00.000Z',
			observation_count: 4
		}]);

		const rows = await storage.readChargeValence!();
		expect(rows).toEqual([{
			charge: 'creative fire',
			valence: 'positive',
			method: 'llm',
			model: '@cf/meta/llama-3.2-3b-instruct',
			classified_at: '2026-09-17T00:00:00.000Z',
			observation_count: 4
		}]);
	});

	it('upserting an existing charge overwrites in place rather than duplicating', async () => {
		const storage = freshStorage();
		await storage.upsertChargeValence!([{
			charge: 'grief', valence: 'negative', method: 'llm', model: 'm1',
			classified_at: '2026-09-01T00:00:00.000Z', observation_count: 1
		}]);
		await storage.upsertChargeValence!([{
			charge: 'grief', valence: 'negative', method: 'manual', model: 'm1',
			classified_at: '2026-09-02T00:00:00.000Z', observation_count: 5
		}]);

		const rows = await storage.readChargeValence!();
		expect(rows).toHaveLength(1);
		expect(rows[0].method).toBe('manual');
		expect(rows[0].observation_count).toBe(5);
	});

	it('is tenant-scoped — a different tenant sees no rows', async () => {
		const dbPath = `/tmp/muse-brain-test-${crypto.randomUUID()}.sqlite`;
		const companion = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');
		const rainer = createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'rainer');

		await companion.upsertChargeValence!([{
			charge: 'joy', valence: 'positive', method: 'llm', model: 'm1',
			classified_at: '2026-09-01T00:00:00.000Z', observation_count: 1
		}]);

		expect(await companion.readChargeValence!()).toHaveLength(1);
		expect(await rainer.readChargeValence!()).toEqual([]);
	});
});
