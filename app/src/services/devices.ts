import { pool } from '../db';

/** Has this device fingerprint already voted in the given open election? */
export async function deviceHasVoted(
  electionId: number,
  fingerprint: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM device_votes WHERE election_id = $1 AND fingerprint = $2`,
    [electionId, fingerprint],
  );
  return (rowCount ?? 0) > 0;
}
