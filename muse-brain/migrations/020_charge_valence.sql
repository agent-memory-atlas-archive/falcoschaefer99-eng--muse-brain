-- ============================================================
-- Brain v5 — Migration 020: Charge Valence Lexicon (ADR-VALENCE-FLOOR §Slice 0)
-- ============================================================
-- Valence is a property of the charge VOCABULARY, not of any single memory —
-- one row per distinct charge string, classified once, reused by every
-- observation that carries it. See ops/ADR-VALENCE-FLOOR.md.
--
-- No `valence` column on `observations`: correcting a lexicon row instantly
-- corrects every memory that uses that charge, by design.

CREATE TABLE IF NOT EXISTS charge_valence (
    tenant_id          TEXT NOT NULL,
    charge             TEXT NOT NULL,
    valence            TEXT NOT NULL
                       CHECK (valence IN ('positive', 'negative', 'mixed', 'neutral')),
    method             TEXT NOT NULL
                       CHECK (method IN ('llm', 'manual')),
    model              TEXT NOT NULL,
    classified_at      TIMESTAMPTZ NOT NULL,
    observation_count  INT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, charge)
);

CREATE INDEX IF NOT EXISTS idx_charge_valence_tenant_valence
    ON charge_valence(tenant_id, valence);
