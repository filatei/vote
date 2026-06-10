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
];

export async function runMigrations(): Promise<void> {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
  logger.info(`migrations applied (${STATEMENTS.length} statement(s))`);
}
