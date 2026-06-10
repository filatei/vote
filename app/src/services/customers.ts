import { pool, withSerializableTx } from '../db';
import { generateUrlToken, hashToken } from '../util/crypto';
import { Customer } from './types';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function getCustomerById(id: number): Promise<Customer | null> {
  const { rows } = await pool.query<Customer>(`SELECT id, email FROM customers WHERE id = $1`, [id]);
  const r = rows[0];
  return r ? { id: Number(r.id), email: r.email } : null;
}

/** Issue a magic-link token for an email. Returns the raw token (emailed). */
export async function createMagicToken(email: string): Promise<string> {
  const raw = generateUrlToken();
  await pool.query(
    `INSERT INTO magic_tokens (email, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '20 minutes')`,
    [normalizeEmail(email), hashToken(raw)],
  );
  return raw;
}

/**
 * Consume a magic-link token: if valid, unused and unexpired, mark it used and
 * return (creating if needed) the customer. One-time use, enforced in a
 * serializable transaction.
 */
export async function consumeMagicToken(raw: string): Promise<Customer | null> {
  const hash = hashToken(raw);
  return withSerializableTx(async (client) => {
    const { rows } = await client.query<{ id: number; email: string }>(
      `SELECT id, email FROM magic_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [hash],
    );
    const tok = rows[0];
    if (!tok) return null;
    await client.query(`UPDATE magic_tokens SET used_at = now() WHERE id = $1`, [tok.id]);
    const cust = await client.query<Customer>(
      `INSERT INTO customers (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET last_login_at = now()
       RETURNING id, email`,
      [tok.email],
    );
    const r = cust.rows[0];
    return { id: Number(r.id), email: r.email };
  });
}
