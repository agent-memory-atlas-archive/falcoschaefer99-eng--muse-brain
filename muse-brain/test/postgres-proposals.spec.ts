import { describe, expect, it, vi } from 'vitest';
import { createPostgresStorage } from '../src/storage/postgres';

function proposalRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'prop_existing',
		tenant_id: 'rainer',
		proposal_type: 'orphan_rescue',
		source_id: 'obs_orphan',
		target_id: 'obs_anchor',
		similarity: null,
		resonance_type: null,
		confidence: 0.9,
		rationale: 'existing rationale',
		metadata: { kept: true },
		status: 'pending',
		feedback_note: null,
		proposed_at: new Date('2026-08-02T03:00:00.000Z'),
		reviewed_at: null,
		...overrides
	};
}

function makeSqlSequence(responses: Array<Array<Record<string, unknown>> | Error>) {
	const calls: Array<{ strings: readonly string[]; values: unknown[] }> = [];
	const json = vi.fn((value: unknown) => ({ __postgresJson: value }));
	const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
		calls.push({ strings, values });
		const response = responses.shift() ?? [];
		if (response instanceof Error) throw response;
		return response;
	}) as any;
	sql.json = json;
	return { sql, calls, json };
}

const payload = {
	tenant_id: 'rainer',
	proposal_type: 'orphan_rescue' as const,
	source_id: 'obs_orphan',
	target_id: 'obs_anchor',
	confidence: 0.7,
	rationale: 'new rationale must not overwrite existing',
	metadata: { new: true },
	status: 'pending' as const
};

describe('Postgres createProposal', () => {
	it('inserts proposals with replay-safe ON CONFLICT DO NOTHING', async () => {
		const { sql, calls, json } = makeSqlSequence([[proposalRow({ id: 'prop_new', metadata: { new: true } })]]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		const created = await storage.createProposal(payload);

		expect(created.id).toBe('prop_new');
		expect(calls).toHaveLength(1);
		expect(calls[0].strings.join('?')).toContain('ON CONFLICT (tenant_id, proposal_type, source_id, target_id) DO NOTHING');
		expect(json).toHaveBeenCalledWith({ new: true });
	});

	it('returns the existing proposal on dedupe conflict without overwriting it', async () => {
		const existing = proposalRow();
		const { sql, calls } = makeSqlSequence([[], [existing]]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		const result = await storage.createProposal(payload);

		expect(result.id).toBe('prop_existing');
		expect(result.rationale).toBe('existing rationale');
		expect(result.metadata).toEqual({ kept: true });
		expect(calls).toHaveLength(2);
		expect(calls[1].strings.join('?')).toContain('SELECT * FROM daemon_proposals');
		expect(calls.map(call => call.strings.join('?')).join('\n')).not.toContain('UPDATE daemon_proposals');
	});

	it('preserves normal error behavior for non-dedupe failures', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { sql } = makeSqlSequence([new Error('database down')]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		await expect(storage.createProposal(payload)).rejects.toThrow('Failed to create proposal');

		errorSpy.mockRestore();
	});
});

// ops/ADR-JANITOR.md §1, 🔒 Michael flag: a daemon that DELETEs rows is a new
// destructive capability — the type allowlist must be a module constant, never
// daemon_config-driven, and every new DELETE must carry the tenant filter.
describe('Postgres expireStaleProposals', () => {
	it('DELETEs (not UPDATEs) both the go-forward expiry and the legacy backfill, each tenant-scoped and allowlist-scoped', async () => {
		const { sql, calls } = makeSqlSequence([[], []]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		const deleted = await storage.expireStaleProposals(30);

		expect(deleted).toBe(0);
		expect(calls).toHaveLength(2); // no rows returned -> readDaemonConfig/updateDaemonConfigData never called
		const [expireCall, backfillCall] = calls;

		expect(expireCall.strings.join('?')).toContain('DELETE FROM daemon_proposals');
		expect(expireCall.strings.join('?')).toContain("status = 'pending'");
		expect(expireCall.strings.join('?')).not.toContain('UPDATE daemon_proposals');
		// Values-array membership alone only proves 'rainer' was bound as SOME
		// parameter — a refactor could drop the tenant filter and still pass a
		// tenant into an unrelated slot. Assert the predicate text itself so a
		// dropped WHERE clause fails this guard test.
		expect(expireCall.strings.join('?')).toContain('WHERE tenant_id = ');
		expect(expireCall.strings.join('?')).toContain('proposal_type = ANY(');
		expect(expireCall.values).toContain('rainer');
		expect(expireCall.values).toContainEqual(['link', 'orphan_rescue']);

		expect(backfillCall.strings.join('?')).toContain('DELETE FROM daemon_proposals');
		expect(backfillCall.strings.join('?')).toContain("status = 'rejected'");
		expect(backfillCall.strings.join('?')).toContain('reviewed_at IS NULL');
		expect(backfillCall.strings.join('?')).toContain('WHERE tenant_id = ');
		expect(backfillCall.strings.join('?')).toContain('proposal_type = ANY(');
		expect(backfillCall.values).toContain('rainer');
		expect(backfillCall.values).toContainEqual(['link', 'orphan_rescue']);
	});

	it('never reads the allowlist from daemon_config — the breadcrumb write only happens when something was actually deleted', async () => {
		const { sql } = makeSqlSequence([[], []]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;
		const readSpy = vi.spyOn(storage, 'readDaemonConfig');

		await storage.expireStaleProposals(30);

		expect(readSpy).not.toHaveBeenCalled();
	});

	it('writes the last_expiry breadcrumb (merged, not overwriting other data keys) only when rows were deleted', async () => {
		const expiredRow = { id: 'prop_1', proposal_type: 'orphan_rescue' };
		const { sql, calls } = makeSqlSequence([
			[expiredRow],
			[],
			[{ tenant_id: 'rainer', link_proposal_threshold: 0.75, data: { some_other_key: 'kept' } }], // readDaemonConfig
			[] // updateDaemonConfigData
		]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		const deleted = await storage.expireStaleProposals(30);

		expect(deleted).toBe(1);
		expect(calls).toHaveLength(4);
		const updateCall = calls[3];
		expect(updateCall.strings.join('?')).toContain('INSERT INTO daemon_config');
		const payloadArg = updateCall.values.find((v: unknown) => v && typeof v === 'object' && '__postgresJson' in (v as object)) as { __postgresJson: Record<string, unknown> } | undefined;
		expect(payloadArg?.__postgresJson.some_other_key).toBe('kept');
		expect(payloadArg?.__postgresJson.last_expiry).toEqual({
			deleted: 1,
			expired: 1,
			backfilled: 0,
			by_type: { orphan_rescue: 1 },
			at: expect.any(String)
		});
	});

	it('preserves normal error behavior when the DELETE fails', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { sql } = makeSqlSequence([new Error('database down')]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		expect(await storage.expireStaleProposals(30)).toBe(0);

		errorSpy.mockRestore();
	});
});

describe('Postgres listOrphans ordering', () => {
	it('orders by last_rescue_attempt ASC NULLS FIRST, first_marked ASC — never by first_marked alone', async () => {
		const { sql, calls } = makeSqlSequence([[]]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		await storage.listOrphans('orphaned', 50);

		expect(calls[0].strings.join('?')).toContain('ORDER BY last_rescue_attempt ASC NULLS FIRST, first_marked ASC');
	});
});

// ops/ADR-JANITOR.md §2.1 — MIN(first_marked) must be scoped to status='orphaned',
// same as the COUNT columns beside it, or an archived orphan (archiving sets
// status, never deletes the row) holds oldest_days up forever: the metric the
// drain is graded on would read as failure while the drain works perfectly.
describe('Postgres getOrphanStats — oldest_days must not be held up by archived rows', () => {
	it('scopes MIN(first_marked) with FILTER (WHERE status = \'orphaned\'), matching the COUNT columns\' own filters', async () => {
		const { sql, calls } = makeSqlSequence([[{ orphaned: 0, rescued: 0, archived: 0, oldest_days: null }]]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		await storage.getOrphanStats();

		const queryText = calls[0].strings.join('?');
		expect(queryText).toContain("MIN(first_marked) FILTER (WHERE status = 'orphaned')");
	});

	it('returns oldest_days: 0 (not NaN or negative) when every orphan has already been archived — MIN over an empty FILTER is NULL', async () => {
		const { sql } = makeSqlSequence([[{ orphaned: 0, rescued: 0, archived: 5, oldest_days: null }]]);
		const storage = createPostgresStorage('postgres://fake:fake@localhost:1/fake', 'rainer') as any;
		storage.sql = sql;

		const stats = await storage.getOrphanStats();

		expect(stats).toEqual({ orphaned: 0, rescued: 0, archived: 5, oldest_days: 0 });
	});
});
