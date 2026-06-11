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

export interface DeviceVote {
  id: number;
  fingerprint: string;
  ip: string | null;
  user_agent: string | null;
  created_at: Date | null;
  created_on: string;
}

/** Platform-admin device audit: one row per device that voted via the link. */
export async function getDeviceVotes(electionId: number): Promise<DeviceVote[]> {
  const { rows } = await pool.query<DeviceVote>(
    `SELECT id, fingerprint, ip, user_agent, created_at,
            to_char(created_on, 'YYYY-MM-DD') AS created_on
       FROM device_votes WHERE election_id = $1 ORDER BY id`,
    [electionId],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
