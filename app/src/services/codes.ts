import { pool } from '../db';
import { generateVotingCode, hashCode } from '../util/crypto';

export interface CodeStats {
  total: number;
  used: number;
  unused: number;
}

/**
 * Generate `count` voting codes for an election. Returns the plaintext codes
 * (to be shown/exported exactly once); only their hashes are persisted.
 * Hash collisions are astronomically unlikely but handled via ON CONFLICT.
 */
export async function generateCodes(electionId: number, count: number): Promise<string[]> {
  const codes: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let generated = 0;
    let guard = 0;
    while (generated < count && guard < count * 5) {
      guard++;
      const code = generateVotingCode();
      const hash = hashCode(code);
      const res = await client.query(
        `INSERT INTO voting_codes (election_id, code_hash)
         VALUES ($1, $2)
         ON CONFLICT (election_id, code_hash) DO NOTHING`,
        [electionId, hash],
      );
      if (res.rowCount === 1) {
        codes.push(code);
        generated++;
      }
    }
    await client.query('COMMIT');
    return codes;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function getCodeStats(electionId: number): Promise<CodeStats> {
  const { rows } = await pool.query<{ total: string; used: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE used) AS used
       FROM voting_codes WHERE election_id = $1`,
    [electionId],
  );
  const total = Number(rows[0].total);
  const used = Number(rows[0].used);
  return { total, used, unused: total - used };
}
