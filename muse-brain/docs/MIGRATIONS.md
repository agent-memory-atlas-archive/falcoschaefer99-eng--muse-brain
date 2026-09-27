# Migration Guide

Run SQL files in numeric order.

There is no automated migration runner — numbering is documentation, not a ledger.
When in doubt, verify by CONTENT, not by number: every file is written idempotent-safe
(`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, guarded `ALTER`s), so
re-running a file you already applied is harmless and is the recommended way to
re-check a database's state.

## ⚠️ v1.9.1 renumbering note (duplicate 015/016 resolved)

The v1.9.0 merge of the private and public lines brought in migrations from both
sides with clashing numbers: two 015s and two 016s. v1.9.1 renumbers to a single
linear sequence. **No file contents changed — only names.**

| Old name (pre-v1.9.1) | New name | Origin line |
|---|---|---|
| `015_limbic_config.sql` | `015_limbic_config.sql` (unchanged) | both |
| `016_proposal_similarity_nullable.sql` | `016_proposal_similarity_nullable.sql` (unchanged) | private |
| `015_retrieval_reliability.sql` | `017_retrieval_reliability.sql` | public |
| `016_retrieval_hints_trgm_index.sql` | `018_retrieval_hints_trgm_index.sql` | public |
| `017_agent_house_trust_layer.sql` | `019_agent_house_trust_layer.sql` | public |

Why this mapping: `015_limbic_config` existed on both lines under the same number,
and the production deployment already applied `016_proposal_similarity_nullable`
as 016 — so those two keep their numbers. The public-only trio moves to 017–019,
preserving its internal order (`retrieval_reliability` must precede
`retrieval_hints_trgm_index`, which indexes a table it creates).

If you followed the **public** line you may have already applied 017–019 under
their old names (015/016/017). That is fine: re-run them under the new names or
just verify by content — they are idempotent-safe. Never assume a number means
"applied"; check for the objects the file creates. Note that for public-line
followers `016_proposal_similarity_nullable.sql` is the one file genuinely NEW
to you in this sequence (it only ever existed on the private line) — apply it.

## Files (current)

1. `001_initial_schema.sql`
2. `002_fts_and_columns.sql`
3. `003_surface_count.sql`
4. `004_entity_model.sql`
5. `005_daemon_intelligence.sql`
6. `006_sprint6_foundation.sql`
7. `007_project_dossiers_and_wake_delta.sql`
8. `008_dispatch_calibration_and_agent_manifests.sql`
9. `009_predeploy_perf_and_integrity.sql`
10. `010_batch_entity_observations_index.sql`
11. `011_autonomous_runtime_ledger.sql`
12. `012_runtime_policy_and_budgeting.sql`
13. `013_captured_skill_registry.sql`
14. `014_captured_skill_registry_perf.sql`
15. `015_limbic_config.sql`
16. `016_proposal_similarity_nullable.sql`
17. `017_retrieval_reliability.sql`
18. `018_retrieval_hints_trgm_index.sql`
19. `019_agent_house_trust_layer.sql`

## Option A — psql (recommended)

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST/DB?sslmode=require'

for f in $(ls migrations/*.sql | sort); do
  echo "Applying $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

## Option B — Neon SQL editor

Open each file and run in order (001 → 019).

## Verify

Quick sanity checks:

```sql
-- runtime ledger table
select count(*) from agent_runtime_runs;

-- captured skill registry
select count(*) from captured_skills;

-- proposal table
select count(*) from daemon_proposals;

-- retrieval reliability (017)
select count(*) from project_index;

-- agent house trust layer (019)
select count(*) from agent_leases;
```

## Notes

- Keep `ON_ERROR_STOP=1` so failures stop the run.
- Do not skip files; later migrations assume earlier schema.
- Back up production DB before applying new migrations.
