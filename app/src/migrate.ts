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
];

export async function runMigrations(): Promise<void> {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
  logger.info(`migrations applied (${STATEMENTS.length} statement(s))`);
}
