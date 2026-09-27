import { describe, expect, it, vi } from 'vitest';
import { createStorage } from '../src/storage/factory';
import { handleTool as handleWakeTool } from '../src/tools-v2/wake';
import type { Anchor, Observation } from '../src/types';
import type { BrainLease } from '../src/security/leases';

// Real sqlite-backed storage (not mocks) — the foundation lane leans on a new
// storage-layer seam (touchAnchors, readFoundationalObservations) that a mock would
// just echo back uncritically. Driving the real backend catches wiring bugs a
// same-substrate mock re-implementation would hide.
function freshStorage() {
	const dbPath = `/tmp/muse-brain-test-wake-foundation-${crypto.randomUUID()}.sqlite`;
	return createStorage({ backend: 'sqlite', sqlitePath: dbPath }, 'companion');
}

function hoursAgo(h: number): string {
	return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function daysAgo(d: number): string {
	return hoursAgo(d * 24);
}

function makeAnchor(overrides: Partial<Anchor> = {}): Anchor {
	return {
		id: overrides.id ?? `anchor_${crypto.randomUUID()}`,
		type: 'anchor',
		anchor_type: overrides.anchor_type ?? 'lexical',
		content: overrides.content ?? 'a short resonance point',
		charge: overrides.charge ?? [],
		triggers_memory_id: overrides.triggers_memory_id,
		created: overrides.created ?? hoursAgo(1),
		activation_count: overrides.activation_count ?? 0,
		last_activated: overrides.last_activated
	};
}

// grip defaults to 'present' — deliberately NOT 'iron' (which would land it in the
// `pulling` lane via runQuickWake's ironGrip pool) and NOT 'strong'-within-7-days
// (which would land it in `recent_grip`). Foundational-lane fixtures need to earn
// their spot without accidentally getting deduped away by their own presence in
// another lane, unless a test explicitly wants to exercise that dedupe.
function makeFoundationalObservation(overrides: Partial<Observation> = {}): Observation {
	return {
		id: overrides.id ?? `obs_${crypto.randomUUID()}`,
		content: overrides.content ?? 'A foundational truth about who we are.',
		territory: overrides.territory ?? 'self',
		created: overrides.created ?? daysAgo(200),
		texture: overrides.texture ?? { salience: 'foundational', vividness: 'crystalline', charge: ['identity'], grip: 'present' },
		access_count: overrides.access_count ?? 1
	};
}

function makeLease(capabilities: string[]): BrainLease {
	return {
		lease_id: `lease_${crypto.randomUUID()}`,
		agent_id: 'test-agent',
		platform: 'claude_code',
		delegation_chain: ['test-agent'],
		capabilities: capabilities as BrainLease['capabilities'],
		scope: { tenant: 'companion', allow_all: capabilities.includes('system.root') || capabilities.includes('*') },
		issued_at: hoursAgo(1),
		expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
	};
}

describe('wake — foundation lane lease gating (mind_anchor requires identity.read; the lane must too)', () => {
	async function seededStorage() {
		const storage = freshStorage();
		await storage.writeAnchors([makeAnchor({ id: 'anchor_gated', content: 'gated resonance point' })]);
		await storage.appendToTerritory('self', makeFoundationalObservation({ id: 'obs_gated' }));
		return storage;
	}

	it('lease with identity.read → anchors present', async () => {
		const storage = await seededStorage();
		const lease = makeLease(['identity.read']);

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any, lease });

		expect(result.foundation.anchors).toHaveLength(1);
		expect(result.foundation.anchors[0].id).toBe('anchor_gated');
		expect(result.foundation.anchors_omitted).toBeUndefined();
		expect(result.foundation.foundational.map((o: any) => o.id)).toContain('obs_gated');
	});

	it('lease with only memory.read → anchors omitted + reason, foundational still present', async () => {
		const storage = await seededStorage();
		const lease = makeLease(['memory.read']);

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any, lease });

		expect(result.foundation.anchors).toBeUndefined();
		expect(result.foundation.anchors_omitted).toBe('lease lacks identity.read');
		expect(result.foundation.foundational.map((o: any) => o.id)).toContain('obs_gated');
	});

	it('lease with only memory.read → the PERSISTED wake log records anchor_ids as null with anchors_omitted populated, not []', async () => {
		const storage = await seededStorage();
		const lease = makeLease(['memory.read']);

		await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any, lease });

		const loggedEntry = await storage.readLatestWakeLog();
		expect(loggedEntry).not.toBeNull();
		// null, not [] — "never queried" must stay distinguishable from "queried, found
		// nothing" on the log a forensic reader actually consults, not just on the payload.
		expect(loggedEntry!.anchor_ids).toBeNull();
		expect(loggedEntry!.anchors_omitted).toBe('lease lacks identity.read');
		// foundational lane isn't lease-gated — it still logs real ids for this wake.
		expect(loggedEntry!.foundation_ids).toContain('obs_gated');
	});

	it('lease with identity.read → the persisted wake log records real anchor_ids, no anchors_omitted key at all', async () => {
		const storage = await seededStorage();
		const lease = makeLease(['identity.read']);

		await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any, lease });

		const loggedEntry = await storage.readLatestWakeLog();
		expect(loggedEntry!.anchor_ids).toEqual(['anchor_gated']);
		expect('anchors_omitted' in loggedEntry!).toBe(false);
	});

	it('root lease (system.root) → anchors present', async () => {
		const storage = await seededStorage();
		const lease = makeLease(['system.root']);

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any, lease });

		expect(result.foundation.anchors).toHaveLength(1);
		expect(result.foundation.anchors_omitted).toBeUndefined();
	});

	it('no lease presented on context (daemon-internal / direct call) → treated as trusted, anchors present', async () => {
		const storage = await seededStorage();

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.foundation.anchors).toHaveLength(1);
		expect(result.foundation.anchors_omitted).toBeUndefined();
	});
});

describe('wake — foundation lane', () => {
	it('quick wake carries anchors (full content) and foundational observations', async () => {
		const storage = freshStorage();
		const anchor = makeAnchor({ id: 'anchor_1', content: 'when Falco says "I don\'t know", stop and ground' });
		await storage.writeAnchors([anchor]);

		const obs = makeFoundationalObservation({ id: 'obs_foundational_1', content: 'Foundational: the vow, verbatim.' });
		await storage.appendToTerritory('self', obs);

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.foundation.anchors).toHaveLength(1);
		expect(result.foundation.anchors[0]).toMatchObject({
			id: 'anchor_1',
			anchor_type: 'lexical',
			content: anchor.content,
			charge: []
		});
		expect(result.foundation.foundational).toHaveLength(1);
		expect(result.foundation.foundational[0]).toMatchObject({
			id: 'obs_foundational_1',
			territory: 'self',
			snippet: obs.content
		});
		expect(result.foundation.foundational[0].essence).toBeTruthy();
	});

	it('full wake also carries the foundation lane', async () => {
		const storage = freshStorage();
		await storage.writeAnchors([makeAnchor({ id: 'anchor_full' })]);
		await storage.appendToTerritory('self', makeFoundationalObservation({ id: 'obs_full' }));

		const result = await handleWakeTool('mind_wake', { depth: 'full', run_decay: false, run_consolidate: false }, { storage: storage as any });

		expect(result.wake.foundation.anchors.map((a: any) => a.id)).toContain('anchor_full');
		expect(result.wake.foundation.foundational.map((o: any) => o.id)).toContain('obs_full');
	});

	it('bumps each surfaced anchor activation_count by exactly one per wake, persisted', async () => {
		const storage = freshStorage();
		await storage.writeAnchors([makeAnchor({ id: 'anchor_bump', activation_count: 3 })]);

		const first = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });
		expect(first.foundation.anchors[0].activation_count).toBe(4);

		const persistedAfterFirst = await storage.readAnchors();
		expect(persistedAfterFirst[0].activation_count).toBe(4);

		const second = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });
		expect(second.foundation.anchors[0].activation_count).toBe(5);

		const persistedAfterSecond = await storage.readAnchors();
		expect(persistedAfterSecond[0].activation_count).toBe(5);
	});

	it('anchors are newest-first and capped at 12', async () => {
		const storage = freshStorage();
		const anchors = Array.from({ length: 15 }, (_, i) => makeAnchor({
			id: `anchor_${i}`,
			created: hoursAgo(15 - i) // anchor_14 is newest
		}));
		await storage.writeAnchors(anchors);

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.foundation.anchors).toHaveLength(12);
		expect(result.foundation.anchors[0].id).toBe('anchor_14');
		expect(result.foundation.anchors.map((a: any) => a.id)).not.toContain('anchor_0');
		expect(result.foundation.anchors.map((a: any) => a.id)).not.toContain('anchor_1');
		expect(result.foundation.anchors.map((a: any) => a.id)).not.toContain('anchor_2');
	});

	it('ranks foundational observations by pull strength, caps at 5, and dedupes against pulling/recent_grip', async () => {
		const storage = freshStorage();

		// obs_pulling_dupe: iron grip lands it in runQuickWake's ironGrip pool, which
		// becomes `pulling` — even though it's ALSO foundational, it must not double-surface.
		const pullingDupe = makeFoundationalObservation({
			id: 'obs_pulling_dupe',
			created: hoursAgo(1),
			texture: { salience: 'foundational', vividness: 'crystalline', charge: ['identity', 'vow', 'home'], grip: 'iron' }
		});
		// obs_recent_grip_dupe: strong grip within the 7-day window lands it in the
		// dedicated `recent_grip` lane (buildRecencyLanes) — must not double-surface either.
		const recentGripDupe = makeFoundationalObservation({
			id: 'obs_recent_grip_dupe',
			created: daysAgo(2),
			texture: { salience: 'foundational', vividness: 'vivid', charge: [], grip: 'strong' }
		});
		// obs_strong: strong grip but OUTSIDE the 7-day window — safe from recent_grip,
		// safe from pulling (not iron). Higher pull than obs_weak_old below.
		const strongCandidate = makeFoundationalObservation({
			id: 'obs_strong',
			created: daysAgo(10),
			texture: { salience: 'foundational', vividness: 'vivid', charge: ['identity'], grip: 'strong' }
		});
		const weakOldCandidate = makeFoundationalObservation({
			id: 'obs_weak_old',
			created: daysAgo(400),
			texture: { salience: 'foundational', vividness: 'fragmentary', charge: [], grip: 'loose' }
		});

		await storage.appendToTerritory('self', pullingDupe);
		await storage.appendToTerritory('self', recentGripDupe);
		await storage.appendToTerritory('self', strongCandidate);
		await storage.appendToTerritory('self', weakOldCandidate);

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		const pullingIds = result.pulling.map((p: any) => p.id);
		expect(pullingIds).toContain('obs_pulling_dupe');
		const recentGripIds = result.recent_grip.map((r: any) => r.id);
		expect(recentGripIds).toContain('obs_recent_grip_dupe');

		const foundationalIds = result.foundation.foundational.map((o: any) => o.id);
		expect(foundationalIds).not.toContain('obs_pulling_dupe');
		expect(foundationalIds).not.toContain('obs_recent_grip_dupe');
		expect(foundationalIds).toContain('obs_strong');
		expect(foundationalIds).toContain('obs_weak_old');
		// Higher pull (strong, older-but-not-ancient) ranks ahead of lower pull (loose, ancient).
		expect(foundationalIds.indexOf('obs_strong')).toBeLessThan(foundationalIds.indexOf('obs_weak_old'));
		expect(result.foundation.foundational.length).toBeLessThanOrEqual(5);
	});

	it('truncates foundational snippets before dropping anchors under the char cap', async () => {
		const storage = freshStorage();

		// A big-but-under-budget anchor (7,200 of the 8,000-char cap), leaving only 800
		// chars for the (up to 5) foundational items. Each foundational snippet is already
		// pre-sliced to FOUNDATION_SNIPPET_LEN (240 chars, +3 for "...") by buildFoundationLane
		// before it ever reaches capFoundationLane, so 5 raw 1000-char observations alone
		// (5 * 243 = 1,215) can't force truncation on their own at an 8,000-char cap — the
		// anchor has to eat most of the budget first for the char-cap logic to actually engage.
		await storage.writeAnchors([makeAnchor({ id: 'anchor_big', content: 'a'.repeat(7200) })]);

		// Five foundational observations — with only 800 chars of budget left, the 4th gets
		// truncated mid-snippet and the 5th is dropped outright (budget hits 0 before it's reached).
		for (let i = 0; i < 5; i++) {
			await storage.appendToTerritory('self', makeFoundationalObservation({
				id: `obs_big_${i}`,
				content: 'x'.repeat(1000),
				created: daysAgo(10 + i),
				texture: { salience: 'foundational', vividness: 'vivid', charge: [], grip: 'strong' }
			}));
		}

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		// Anchor survives untouched — foundational is the lever that gets truncated/dropped first.
		expect(result.foundation.anchors).toHaveLength(1);
		expect(result.foundation.anchors[0].content).toHaveLength(7200);

		const totalChars =
			result.foundation.anchors.reduce((sum: number, a: any) => sum + a.content.length, 0) +
			result.foundation.foundational.reduce((sum: number, o: any) => sum + o.snippet.length, 0);

		expect(totalChars).toBeLessThanOrEqual(8000);
		// The 5th item got dropped outright under the tight remaining budget.
		expect(result.foundation.foundational.length).toBeLessThan(5);
		// At least one surviving snippet was truncated shorter than the pre-sliced 243-char snippet.
		expect(result.foundation.foundational.some((o: any) => o.snippet.length < 243)).toBe(true);
	});

	// Fischer LOW: a remaining budget of 1 or 2 chars still fit the OLD bare-"..."
	// fallback (3 chars) — overshooting the cap it exists to enforce. Below the
	// boundary, the item must be dropped whole, never partially rendered.
	it.each([1, 2])('drops a foundational item outright when the remaining char budget is %i (too small even for "...")', async (leftoverBudget) => {
		const storage = freshStorage();

		// One anchor sized to leave exactly `leftoverBudget` chars of the lane's 8,000-char cap.
		const anchorLength = 8000 - leftoverBudget;
		await storage.writeAnchors([makeAnchor({ id: 'anchor_boundary', content: 'a'.repeat(anchorLength) })]);

		// A foundational item whose snippet is well over the tiny leftover budget.
		await storage.appendToTerritory('self', makeFoundationalObservation({
			id: 'obs_boundary',
			content: 'this observation cannot possibly fit in one or two characters',
			created: hoursAgo(1),
			texture: { salience: 'foundational', vividness: 'vivid', charge: [], grip: 'strong' }
		}));

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.foundation.anchors).toHaveLength(1);
		expect(result.foundation.anchors[0].content).toHaveLength(anchorLength);
		expect(result.foundation.foundational).toEqual([]);

		const totalChars =
			result.foundation.anchors.reduce((sum: number, a: any) => sum + a.content.length, 0) +
			result.foundation.foundational.reduce((sum: number, o: any) => sum + o.snippet.length, 0);
		expect(totalChars).toBeLessThanOrEqual(8000);
	});

	it('foundation lane is absent from delta — the spine is constant, not a change feed', async () => {
		const storage = freshStorage();
		await storage.writeAnchors([makeAnchor({ id: 'anchor_delta' })]);

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.delta).not.toHaveProperty('foundation');
		expect(result.foundation).toBeDefined();
	});
});

describe('wake — foundation/anchor ids recorded on the wake log (observability, not selection)', () => {
	it('logs what was actually SERVED after char-cap truncation drops an item, not what was considered before it', async () => {
		const storage = freshStorage();

		// Same fixture as the char-cap truncation test above: a big anchor eats most of
		// the 8,000-char budget, forcing the 5th foundational item to be dropped outright.
		await storage.writeAnchors([makeAnchor({ id: 'anchor_big', content: 'a'.repeat(7200) })]);
		for (let i = 0; i < 5; i++) {
			await storage.appendToTerritory('self', makeFoundationalObservation({
				id: `obs_big_${i}`,
				content: 'x'.repeat(1000),
				created: daysAgo(10 + i),
				texture: { salience: 'foundational', vividness: 'vivid', charge: [], grip: 'strong' }
			}));
		}

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });
		// Sanity: the cap really did drop at least one of the 5 candidates.
		expect(result.foundation.foundational.length).toBeLessThan(5);

		const loggedEntry = await storage.readLatestWakeLog();
		expect(loggedEntry).not.toBeNull();
		// The logged list must be the SHORTER, post-truncation list — exactly the ids
		// that survived capFoundationLane, in the same order the payload shipped them.
		expect(loggedEntry!.foundation_ids).toEqual(result.foundation.foundational.map((o: any) => o.id));
		expect(loggedEntry!.foundation_ids!.length).toBeLessThan(5);
		// The anchor survived the cap whole — anchor_ids reflects that too.
		expect(loggedEntry!.anchor_ids).toEqual(['anchor_big']);
	});

	it('anchor cap (12 of 15) is reflected in anchor_ids on the wake log, not just the payload', async () => {
		const storage = freshStorage();
		const anchors = Array.from({ length: 15 }, (_, i) => makeAnchor({
			id: `anchor_${i}`,
			created: hoursAgo(15 - i) // anchor_14 is newest
		}));
		await storage.writeAnchors(anchors);

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		const loggedEntry = await storage.readLatestWakeLog();
		expect(loggedEntry!.anchor_ids).toHaveLength(12);
		expect(loggedEntry!.anchor_ids).toEqual(result.foundation.anchors.map((a: any) => a.id));
		expect(loggedEntry!.anchor_ids).not.toContain('anchor_0');
	});

	it('a wake that genuinely serves nothing logs empty arrays — present, not absent', async () => {
		const storage = freshStorage();

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.foundation.foundational).toEqual([]);
		expect(result.foundation.anchors).toEqual([]);

		const loggedEntry = await storage.readLatestWakeLog();
		expect(loggedEntry!.foundation_ids).toEqual([]);
		expect(loggedEntry!.anchor_ids).toEqual([]);
		// The distinguishing bit: these keys are actually PRESENT on the entry, not
		// merely absent-and-defaulting-to-undefined.
		expect('foundation_ids' in loggedEntry!).toBe(true);
		expect('anchor_ids' in loggedEntry!).toBe(true);
	});

	it('a pre-existing wake log row with no foundation_ids/anchor_ids reads back without throwing, and stays "unknown" rather than "empty"', async () => {
		const storage = freshStorage();

		// Simulate a row written before this field existed — appendWakeLog directly,
		// bypassing mind_wake entirely, exactly as an old stored row would look.
		await storage.appendWakeLog({
			id: 'wake_legacy',
			timestamp: hoursAgo(2),
			summary: 'auto quick wake',
			actions: [],
			iron_pulls: [],
			phase: 'day',
			kind: 'auto',
			depth: 'quick'
		} as any);

		const logs = await storage.readWakeLog();
		const legacy = logs.find(entry => entry.id === 'wake_legacy');

		expect(legacy).toBeDefined();
		// Missing, not an empty array — a reader must be able to tell "unknown" (this
		// field didn't exist yet) apart from "recorded and genuinely zero" (previous test).
		expect(legacy!.foundation_ids).toBeUndefined();
		expect(legacy!.anchor_ids).toBeUndefined();
		expect('foundation_ids' in legacy!).toBe(false);

		// readLatestWakeLog must also tolerate the legacy shape without throwing.
		const latest = await storage.readLatestWakeLog();
		expect(latest).not.toBeNull();
	});
});

describe('wake — foundation lane truncation visibility (foundational_total vs foundational_considered)', () => {
	// Fully mocked storage (not the real sqlite backend) — the point here is the
	// wiring between readFoundationalObservations' 200-row cap and the separate
	// countFoundationalObservations query, which is cheapest to control precisely
	// through mocks rather than actually seeding 200+ rows.
	function baseMockStorage(overrides: Record<string, unknown> = {}) {
		return {
			getTenant: vi.fn(() => 'companion'),
			readOverviews: vi.fn(async () => []),
			readIronGripIndex: vi.fn(async () => []),
			readLetters: vi.fn(async () => []),
			readOpenLoops: vi.fn(async () => []),
			readBrainState: vi.fn(async () => ({
				current_mood: 'focused', energy_level: 0.5, last_updated: hoursAgo(1),
				momentum: { current_charges: [], intensity: 0, last_updated: hoursAgo(1) },
				afterglow: { residue_charges: [] }
			})),
			readSubconscious: vi.fn(async () => null),
			listTasks: vi.fn(async () => []),
			readAllTerritories: vi.fn(async () => []),
			readLatestWakeLog: vi.fn(async () => null),
			listTaskChangesSince: vi.fn(async () => []),
			listProjectDossiers: vi.fn(async () => []),
			getLimbicConfig: vi.fn(async () => null),
			readAnchors: vi.fn(async () => []),
			touchAnchors: vi.fn(async () => undefined),
			getEmbeddingCoverage: vi.fn(async () => ({ total: 0, embedded: 0 })),
			readDaemonConfig: vi.fn(async () => ({ tenant_id: 'companion', link_proposal_threshold: 0, data: {} })),
			appendWakeLog: vi.fn(async () => undefined),
			...overrides
		};
	}

	it('reports total > considered and warns once when the 200-row cap truncates', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const consideredRows = [
			makeFoundationalObservation({ id: 'obs_a' }),
			makeFoundationalObservation({ id: 'obs_b' })
		].map(o => ({ observation: o, territory: 'self' }));

		const storage = baseMockStorage({
			readFoundationalObservations: vi.fn(async () => consideredRows),
			countFoundationalObservations: vi.fn(async () => 5)
		});

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.foundation.foundational_considered).toBe(2);
		expect(result.foundation.foundational_total).toBe(5);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toMatch(/truncated/);
		warnSpy.mockRestore();
	});

	it('does not warn when nothing was truncated', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const storage = baseMockStorage({
			readFoundationalObservations: vi.fn(async () => [{ observation: makeFoundationalObservation({ id: 'obs_a' }), territory: 'self' }]),
			countFoundationalObservations: vi.fn(async () => 1)
		});

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.foundation.foundational_considered).toBe(1);
		expect(result.foundation.foundational_total).toBe(1);
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it('falls back to considered === total when the backend lacks countFoundationalObservations', async () => {
		const storage = baseMockStorage({
			readFoundationalObservations: vi.fn(async () => [{ observation: makeFoundationalObservation({ id: 'obs_a' }), territory: 'self' }])
			// no countFoundationalObservations key — mirrors an older backend/mock
		});

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.foundation.foundational_considered).toBe(1);
		expect(result.foundation.foundational_total).toBe(1);
	});
});

describe('wake — brain_health', () => {
	it('reports full embedding coverage and an ok daemon run with no warning', async () => {
		const storage = freshStorage();
		const obsId = 'obs_embedded';
		await storage.appendToTerritory('craft', {
			id: obsId,
			content: 'embedded observation',
			territory: 'craft',
			created: hoursAgo(1),
			texture: { salience: 'active', vividness: 'vivid', charge: [], grip: 'present' },
			access_count: 0
		});
		// Give it an embedding so coverage reads 100%.
		await storage.updateObservationEmbedding(obsId, new Array(768).fill(0.01));

		await storage.updateDaemonConfigData({
			// ops/ADR-JANITOR.md §2.1: steady-mode orphan_flow is healthy by
			// construction now (DETECT_LIMIT_STEADY 6 × SLOTS_PER_ORPHAN_STEADY 4 = 24
			// < RESCUE_LIMIT_STEADY 50), so this test no longer needs the backlog_mode
			// workaround it used to carry — it runs in steady mode as intended.
			last_daemon_run: {
				started_at: hoursAgo(9),
				completed_stages: ['decay', 'consolidate', 'daemon-tasks'],
				finished_at: hoursAgo(8)
			}
		});

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.brain_health).toBeDefined();
		expect(result.brain_health.total).toBe(1);
		expect(result.brain_health.last_daemon).toEqual({
			finished_at: expect.any(String),
			ok: true,
			completed_stages: 3,
			failed_stages: []
		});
		expect(result.brain_health.retrieval_profile).toBe('fused');
		expect(result.brain_health.warning).toBeUndefined();
	});

	it('warns when embedding coverage is low', async () => {
		const storage = freshStorage();
		for (let i = 0; i < 5; i++) {
			await storage.appendToTerritory('craft', {
				id: `obs_${i}`,
				content: 'unembedded observation',
				territory: 'craft',
				created: hoursAgo(1),
				texture: { salience: 'active', vividness: 'vivid', charge: [], grip: 'present' },
				access_count: 0
			});
		}
		await storage.updateDaemonConfigData({
			last_daemon_run: { started_at: hoursAgo(9), completed_stages: ['decay'], finished_at: hoursAgo(8) }
		});

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.brain_health.embedding_coverage_pct).toBeLessThan(90);
		expect(result.brain_health.warning).toMatch(/embedding coverage/);
	});

	it('warns when the last daemon run never finished (Cloudflare budget kill)', async () => {
		const storage = freshStorage();
		await storage.updateDaemonConfigData({
			last_daemon_run: { started_at: hoursAgo(9), completed_stages: ['decay'], finished_at: null }
		});

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.brain_health.last_daemon).toEqual({ finished_at: null, ok: false, completed_stages: 1, failed_stages: [] });
		expect(result.brain_health.warning).toMatch(/daemon run did not finish cleanly/);
	});

	it('warns when a stage failed but the run still finished cleanly on the outside (finished_at + error → ok:false)', async () => {
		const storage = freshStorage();
		await storage.updateDaemonConfigData({
			last_daemon_run: {
				started_at: hoursAgo(9),
				completed_stages: ['ai-review', 'daemon-tasks', 'decay'],
				finished_at: hoursAgo(8),
				error: 'decay: connection terminated',
				failed_stages: ['decay']
			}
		});

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.brain_health.last_daemon).toEqual({
			finished_at: expect.any(String),
			ok: false,
			completed_stages: 3,
			failed_stages: ['decay']
		});
		expect(result.brain_health.warning).toMatch(/daemon run did not finish cleanly/);
	});

	it('warns when no daemon run has ever been recorded', async () => {
		const storage = freshStorage();

		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		expect(result.brain_health.last_daemon).toBeNull();
		expect(result.brain_health.warning).toMatch(/no nightly daemon run has ever completed/);
	});

	it('brain_health never carries a delta key', async () => {
		const storage = freshStorage();
		const result = await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });
		expect(result.delta).not.toHaveProperty('brain_health');
	});
});

describe('wake — mind_wake_log action=log (manual entries) carry a kind discriminator', () => {
	// This path never touches the foundation lane — the manual row must be distinguishable
	// from BOTH an auto row (kind:"auto", real foundation_ids/anchor_ids) AND a genuine
	// pre-migration legacy row (no kind, no id fields) that predates both fields.
	it('a manually-logged wake is tagged kind:"manual" and never fabricates foundation_ids/anchor_ids', async () => {
		const storage = freshStorage();

		const logResult = await handleWakeTool('mind_wake_log', { action: 'log', summary: 'manual note from a human review' }, { storage: storage as any });
		expect(logResult.logged).toBe(true);

		const loggedEntry = await storage.readLatestWakeLog();
		expect(loggedEntry).not.toBeNull();
		expect(loggedEntry!.kind).toBe('manual');
		// Absent, not fabricated as [] or null — this path structurally never queries the
		// foundation lane, so it must not manufacture a value for either field.
		expect('foundation_ids' in loggedEntry!).toBe(false);
		expect('anchor_ids' in loggedEntry!).toBe(false);
	});

	it('an auto wake is still tagged kind:"auto", distinguishing it from a manual entry', async () => {
		const storage = freshStorage();

		await handleWakeTool('mind_wake', { depth: 'quick' }, { storage: storage as any });

		const loggedEntry = await storage.readLatestWakeLog();
		expect(loggedEntry!.kind).toBe('auto');
	});
});
