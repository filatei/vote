import { pool } from '../db';
import { Election, ElectionWithOptions, Option } from './types';

export async function listElections(): Promise<Election[]> {
  const { rows } = await pool.query<Election>(
    `SELECT * FROM elections ORDER BY created_at DESC`,
  );
  return rows;
}

export async function getElectionById(id: number): Promise<Election | null> {
  const { rows } = await pool.query<Election>(`SELECT * FROM elections WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getElectionByPublicId(publicId: string): Promise<Election | null> {
  const { rows } = await pool.query<Election>(`SELECT * FROM elections WHERE public_id = $1`, [
    publicId,
  ]);
  return rows[0] ?? null;
}

export async function getOptions(electionId: number): Promise<Option[]> {
  const { rows } = await pool.query<Option>(
    `SELECT * FROM options WHERE election_id = $1 ORDER BY position, id`,
    [electionId],
  );
  return rows;
}

export async function getElectionWithOptions(
  id: number,
): Promise<ElectionWithOptions | null> {
  const election = await getElectionById(id);
  if (!election) return null;
  const options = await getOptions(id);
  return { ...election, options };
}

export async function getElectionWithOptionsByPublicId(
  publicId: string,
): Promise<ElectionWithOptions | null> {
  const election = await getElectionByPublicId(publicId);
  if (!election) return null;
  const options = await getOptions(election.id);
  return { ...election, options };
}

interface CreateElectionInput {
  title: string;
  description: string;
  ballotType: 'single' | 'multiple';
  maxSelections: number;
  resultsVisibility: 'live' | 'after_close';
  options: string[];
  createdBy: number;
}

export async function createElection(input: CreateElectionInput): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const maxSel = input.ballotType === 'single' ? 1 : Math.max(1, input.maxSelections);
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO elections
         (title, description, ballot_type, max_selections, results_visibility, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.title,
        input.description,
        input.ballotType,
        maxSel,
        input.resultsVisibility,
        input.createdBy,
      ],
    );
    const electionId = rows[0].id;
    let pos = 0;
    for (const label of input.options) {
      await client.query(
        `INSERT INTO options (election_id, label, position) VALUES ($1, $2, $3)`,
        [electionId, label, pos++],
      );
    }
    await client.query('COMMIT');
    return electionId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Move an election between draft/open/closed. Codes can only be generated in
 * draft or open; ballots only accepted while open (enforced in ballots service). */
export async function setStatus(
  electionId: number,
  status: 'draft' | 'open' | 'closed',
): Promise<void> {
  const cols: string[] = ['status = $2'];
  if (status === 'open') cols.push('opens_at = COALESCE(opens_at, now())');
  if (status === 'closed') cols.push('closes_at = now()');
  await pool.query(`UPDATE elections SET ${cols.join(', ')} WHERE id = $1`, [electionId, status]);
}

/** Whether results may be shown publicly right now. */
export function resultsArePublic(election: Election): boolean {
  if (election.results_visibility === 'live') return true;
  return election.status === 'closed';
}
