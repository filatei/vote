-- ============================================================================
-- Torama Vote — database schema
-- Secret ballot + verifiable receipt, pre-issued anonymous voting codes.
--
-- Integrity design notes:
--   * voting_codes stores ONLY a salted/peppered hash of each code, plus a
--     `used` flag. It NEVER stores the choice that was cast.
--   * ballots stores the choice(s) and a random receipt. It has NO foreign key
--     or other reference back to voting_codes, the voter, or the code's row id.
--   * The two writes happen in one SERIALIZABLE transaction so a code cannot be
--     used twice, but the rows are deliberately unlinked so the ballot cannot
--     be traced to the code/voter.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ── Admins ──────────────────────────────────────────────────────────────────
CREATE TABLE admins (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    email         TEXT,
    password_hash TEXT NOT NULL,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

-- ── Elections ───────────────────────────────────────────────────────────────
-- status: draft | open | closed
-- ballot_type: single | multiple
-- results_visibility: live | after_close
CREATE TABLE elections (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    title              TEXT NOT NULL,
    description        TEXT NOT NULL DEFAULT '',
    ballot_type        TEXT NOT NULL DEFAULT 'single'
                         CHECK (ballot_type IN ('single', 'multiple')),
    max_selections     INTEGER NOT NULL DEFAULT 1 CHECK (max_selections >= 1),
    -- 'code' = pre-issued voting codes; 'open' = anyone with the link (one vote
    -- per device); 'hybrid' = either a code OR a per-device link vote.
    access_mode        TEXT NOT NULL DEFAULT 'code'
                         CHECK (access_mode IN ('code', 'open', 'hybrid')),
    status             TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'open', 'closed')),
    results_visibility TEXT NOT NULL DEFAULT 'after_close'
                         CHECK (results_visibility IN ('live', 'after_close')),
    opens_at           TIMESTAMPTZ,
    closes_at          TIMESTAMPTZ,
    created_by         BIGINT REFERENCES admins(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Options (candidates / choices) ──────────────────────────────────────────
CREATE TABLE options (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    election_id BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    image_path  TEXT,
    flag_path   TEXT,
    party       TEXT NOT NULL DEFAULT '',
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_options_election ON options(election_id, position);

-- ── Voting codes ────────────────────────────────────────────────────────────
-- One row per issued code. Stores ONLY the hash + used flag.
-- NOTHING here records which option was chosen.
CREATE TABLE voting_codes (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    election_id BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    code_hash   TEXT NOT NULL,            -- HMAC-SHA256(code, pepper), hex
    used        BOOLEAN NOT NULL DEFAULT FALSE,
    -- Coarse DATE only (not a precise timestamp) so a "used" code cannot be
    -- time-correlated with an anonymous ballot by anyone with DB access.
    used_on     DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (election_id, code_hash)
);
CREATE INDEX idx_codes_lookup ON voting_codes(election_id, code_hash);

-- ── Ballots ─────────────────────────────────────────────────────────────────
-- Anonymous. Deliberately NOT linked to voting_codes or any voter.
-- For 'single' ballots there is exactly one ballot_selections row.
-- For 'multiple' ballots there are 1..max_selections rows.
CREATE TABLE ballots (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    election_id  BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    receipt_code TEXT NOT NULL,           -- random, shown to voter + published
    -- Coarse DATE only, deliberately no precise timestamp (anti-correlation).
    cast_date    DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
    -- Tamper-evident chain: chain_hash = SHA256(prev_hash|election|receipt|options|date).
    prev_hash    TEXT,
    chain_hash   TEXT,
    UNIQUE (election_id, receipt_code)
);
CREATE INDEX idx_ballots_election ON ballots(election_id);

CREATE TABLE ballot_selections (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ballot_id  BIGINT NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
    option_id  BIGINT NOT NULL REFERENCES options(id) ON DELETE CASCADE,
    UNIQUE (ballot_id, option_id)
);
CREATE INDEX idx_selections_option ON ballot_selections(option_id);
CREATE INDEX idx_selections_ballot ON ballot_selections(ballot_id);

-- ── Device markers (open-link elections) ────────────────────────────────────
-- One row per device that has voted in an 'open' election. Hashed fingerprint
-- only; no link to the ballot, preserving secrecy.
CREATE TABLE device_votes (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    election_id BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    -- Forensic columns, populated only when DEVICE_AUDIT_ENABLED (platform-admin
    -- audit). Still unlinked from any ballot.
    ip          TEXT,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ,
    created_on  DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
    UNIQUE (election_id, fingerprint)
);

-- ── Audit log ───────────────────────────────────────────────────────────────
-- Administrative actions only. Never records voter identity or ballot content.
CREATE TABLE audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    admin_id    BIGINT REFERENCES admins(id),
    action      TEXT NOT NULL,
    election_id BIGINT REFERENCES elections(id) ON DELETE SET NULL,
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip          TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_election ON audit_log(election_id, created_at);

-- keep updated_at fresh on elections
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_elections_touch
    BEFORE UPDATE ON elections
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
