import { pool } from './db';
import { logger } from './logger';

/**
 * Idempotent schema migrations run on every boot. Each statement must be safe
 * to run repeatedly (IF NOT EXISTS etc.) so it works on both a freshly
 * initialised database and an already-running one.
 */
const STATEMENTS: string[] = [
  // Contestant photo for each option (Phase 1: photos + bios).
  `ALTER TABLE options ADD COLUMN IF NOT EXISTS image_path TEXT`,

  // Access mode: 'code' = pre-issued voting codes (default), 'open' = anyone
  // with the link can vote, limited to one vote per device.
  `ALTER TABLE elections ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'code'`,

  // Per-device markers for open-link elections. Stores only a hashed device
  // fingerprint (+ coarse date), never the ballot — so it can't be linked to a
  // vote, exactly like voting_codes.
  `CREATE TABLE IF NOT EXISTS device_votes (
     id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     election_id BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
     fingerprint TEXT NOT NULL,
     created_on  DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
     UNIQUE (election_id, fingerprint)
   )`,

  // Phase 2: self-service customer accounts (passwordless magic-link).
  `CREATE TABLE IF NOT EXISTS customers (
     id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_login_at TIMESTAMPTZ
   )`,
  `CREATE TABLE IF NOT EXISTS magic_tokens (
     id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     email      TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     expires_at TIMESTAMPTZ NOT NULL,
     used_at    TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Elections can be owned by a customer (admin-created ones have NULL owner).
  `ALTER TABLE elections ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES customers(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS idx_elections_owner ON elections(owner_id)`,
];

export async function runMigrations(): Promise<void> {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
  logger.info(`migrations applied (${STATEMENTS.length} statement(s))`);
}
