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

  // Optional party / affiliation logo image per contestant, shown beside photo.
  `ALTER TABLE options ADD COLUMN IF NOT EXISTS flag_path TEXT`,

  // Optional party / affiliation name per contestant (e.g. "Labour Party").
  `ALTER TABLE options ADD COLUMN IF NOT EXISTS party TEXT NOT NULL DEFAULT ''`,

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
  // Platform-wide runtime settings (admin-toggleable flags), e.g. subscriptions.
  `CREATE TABLE IF NOT EXISTS app_settings (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // Lemon Squeezy subscription state per customer.
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS subscription_status TEXT`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS ls_subscription_id TEXT`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS ls_customer_id TEXT`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS subscription_renews_at TIMESTAMPTZ`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_portal_url TEXT`,
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

  // Phase 3: Paystack payment to launch. Mirrors otuburu's paystack_payments
  // (unique reference; status pending|processing|confirmed|failed).
  `ALTER TABLE elections ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE TABLE IF NOT EXISTS paystack_payments (
     id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     reference       TEXT UNIQUE NOT NULL,
     election_id     BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
     customer_id     BIGINT REFERENCES customers(id) ON DELETE SET NULL,
     email           TEXT NOT NULL,
     amount_subunits BIGINT NOT NULL,
     currency        TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','processing','confirmed','failed')),
     paystack_status TEXT,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
     confirmed_at    TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS idx_paystack_payments_election ON paystack_payments(election_id)`,

  // Optional forensic columns on device_votes (populated only when
  // DEVICE_AUDIT_ENABLED). Still unlinked from any ballot.
  `ALTER TABLE device_votes ADD COLUMN IF NOT EXISTS ip TEXT`,
  `ALTER TABLE device_votes ADD COLUMN IF NOT EXISTS user_agent TEXT`,
  `ALTER TABLE device_votes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ`,

  // Tamper-evident ballot hash-chain.
  `ALTER TABLE ballots ADD COLUMN IF NOT EXISTS prev_hash TEXT`,
  `ALTER TABLE ballots ADD COLUMN IF NOT EXISTS chain_hash TEXT`,

  // Per-customer / per-election branding logo.
  `ALTER TABLE elections ADD COLUMN IF NOT EXISTS logo_path TEXT`,
];

export async function runMigrations(): Promise<void> {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
  logger.info(`migrations applied (${STATEMENTS.length} statement(s))`);
}
