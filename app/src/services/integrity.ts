import { pool } from '../db';
import { ballotHash } from '../util/crypto';

export interface ChainResult {
  ok: boolean;
  total: number;
  verified: number;
  brokenReceipt: string | null;
}

/**
 * Recompute the ballot hash-chain for an election and confirm it's intact.
 * Anyone can do this from the public bulletin board data — it proves no ballot
 * was altered, inserted, or removed after the fact.
 */
export async function verifyElectionChain(
  electionId: number,
  publicId: string,
): Promise<ChainResult> {
  const { rows } = await pool.query<{
    receipt_code: string;
    cast_date: string;
    prev_hash: string | null;
    chain_hash: string | null;
    option_ids: number[] | null;
  }>(
    `SELECT b.receipt_code,
            to_char(b.cast_date, 'YYYY-MM-DD') AS cast_date,
            b.prev_hash, b.chain_hash,
            array_agg(bs.option_id ORDER BY bs.option_id) FILTER (WHERE bs.id IS NOT NULL) AS option_ids
       FROM ballots b
       LEFT JOIN ballot_selections bs ON bs.ballot_id = b.id
      WHERE b.election_id = $1
      GROUP BY b.id, b.receipt_code, b.cast_date, b.prev_hash, b.chain_hash
      ORDER BY b.id`,
    [electionId],
  );

  let prev = `GENESIS:${publicId}`;
  let verified = 0;
  for (const r of rows) {
    const optionIds = (r.option_ids ?? []).map((x) => Number(x));
    const expected = ballotHash(prev, electionId, r.receipt_code, optionIds, r.cast_date);
    if (r.prev_hash !== prev || r.chain_hash !== expected) {
      return { ok: false, total: rows.length, verified, brokenReceipt: r.receipt_code };
    }
    verified += 1;
    prev = r.chain_hash as string;
  }
  return { ok: true, total: rows.length, verified, brokenReceipt: null };
}
