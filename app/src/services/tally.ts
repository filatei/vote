import { pool } from '../db';
import { Tally } from './types';

/** Count votes per option from the anonymous ballots. Fully reproducible. */
export async function tallyElection(electionId: number): Promise<Tally> {
  const totalRes = await pool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM ballots WHERE election_id = $1`,
    [electionId],
  );
  const totalBallots = Number(totalRes.rows[0].c);

  const { rows } = await pool.query<{
    option_id: number;
    label: string;
    description: string;
    image_path: string | null;
    votes: string;
  }>(
    `SELECT o.id AS option_id, o.label, o.description, o.image_path,
            COUNT(bs.id) AS votes
       FROM options o
       LEFT JOIN ballot_selections bs ON bs.option_id = o.id
       LEFT JOIN ballots b ON b.id = bs.ballot_id AND b.election_id = $1
      WHERE o.election_id = $1
      GROUP BY o.id, o.label, o.description, o.image_path, o.position
      ORDER BY o.position, o.id`,
    [electionId],
  );

  return {
    totalBallots,
    rows: rows.map((r) => ({
      option_id: Number(r.option_id),
      label: r.label,
      description: r.description,
      image_path: r.image_path,
      votes: Number(r.votes),
    })),
  };
}

export interface BulletinEntry {
  receipt_code: string;
  cast_date: string;
  chain_hash?: string | null;
  options: string[];
}

/** Public bulletin board: every anonymous ballot's receipt + choices + chain hash. */
export async function bulletinBoard(electionId: number): Promise<BulletinEntry[]> {
  const { rows } = await pool.query<{
    receipt_code: string;
    cast_date: string;
    chain_hash: string | null;
    options: string[] | null;
  }>(
    `SELECT b.receipt_code,
            to_char(b.cast_date, 'YYYY-MM-DD') AS cast_date,
            b.chain_hash,
            array_agg(o.label ORDER BY o.position) AS options
       FROM ballots b
       LEFT JOIN ballot_selections bs ON bs.ballot_id = b.id
       LEFT JOIN options o ON o.id = bs.option_id
      WHERE b.election_id = $1
      GROUP BY b.id, b.receipt_code, b.cast_date, b.chain_hash
      ORDER BY b.receipt_code`,
    [electionId],
  );
  return rows.map((r) => ({
    receipt_code: r.receipt_code,
    cast_date: r.cast_date,
    chain_hash: r.chain_hash,
    options: (r.options ?? []).filter((x) => x !== null),
  }));
}

/** Look up a single receipt for voter verification. */
export async function findReceipt(
  electionId: number,
  receiptCode: string,
): Promise<BulletinEntry | null> {
  const { rows } = await pool.query<{
    receipt_code: string;
    cast_date: string;
    options: string[] | null;
  }>(
    `SELECT b.receipt_code,
            to_char(b.cast_date, 'YYYY-MM-DD') AS cast_date,
            array_agg(o.label ORDER BY o.position) AS options
       FROM ballots b
       LEFT JOIN ballot_selections bs ON bs.ballot_id = b.id
       LEFT JOIN options o ON o.id = bs.option_id
      WHERE b.election_id = $1 AND b.receipt_code = $2
      GROUP BY b.id, b.receipt_code, b.cast_date`,
    [electionId, receiptCode],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    receipt_code: r.receipt_code,
    cast_date: r.cast_date,
    options: (r.options ?? []).filter((x) => x !== null),
  };
}
