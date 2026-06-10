import { pool } from '../db';
import { Election, ElectionWithOptions, Option } from './types';

export async function listElections(): Promise<Election[]> {
  const { rows } = await pool.query<Election>(
    `SELECT * FROM elections ORDER BY created_at DESC`,
  );
  return rows;
}

export async function listElectionsByOwner(ownerId: number): Promise<Election[]> {
  const { rows } = await pool.query<Election>(
    `SELECT * FROM elections WHERE owner_id = $1 ORDER BY created_at DESC`,
    [ownerId],
  );
  return rows;
}

/** True if the given customer owns this election. */
export function ownsElection(election: Election, customerId: number): boolean {
  return Number(election.owner_id) === customerId;
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
  // Postgres returns BIGINT as a string; coerce numeric columns so Option.id
  // is a real number throughout the app (matches the declared type).
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    election_id: Number(r.election_id),
    position: Number(r.position),
  }));
}

export async function getOptionById(optionId: number): Promise<Option | null> {
  const { rows } = await pool.query<Option>(`SELECT * FROM options WHERE id = $1`, [optionId]);
  const r = rows[0];
  if (!r) return null;
  return { ...r, id: Number(r.id), election_id: Number(r.election_id), position: Number(r.position) };
}

/** Update a contestant's bio (description) and optionally their photo path. */
export async function updateOptionContent(
  optionId: number,
  description: string,
  imagePath?: string | null,
): Promise<void> {
  if (imagePath === undefined) {
    await pool.query(`UPDATE options SET description = $2 WHERE id = $1`, [optionId, description]);
  } else {
    await pool.query(`UPDATE options SET description = $2, image_path = $3 WHERE id = $1`, [
      optionId,
      description,
      imagePath,
    ]);
  }
}

/** Clear a contestant's photo. Returns the previous path so the file can be deleted. */
export async function clearOptionImage(optionId: number): Promise<string | null> {
  const before = await pool.query<{ image_path: string | null }>(
    `SELECT image_path FROM options WHERE id = $1`,
    [optionId],
  );
  const old = before.rows[0]?.image_path ?? null;
  await pool.query(`UPDATE options SET image_path = NULL WHERE id = $1`, [optionId]);
  return old;
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
  accessMode: 'code' | 'open';
  resultsVisibility: 'live' | 'after_close';
  options: string[];
  opensAt: Date | null;
  closesAt: Date | null;
  createdBy: number | null;
  ownerId?: number | null;
}

export async function createElection(input: CreateElectionInput): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const maxSel = input.ballotType === 'single' ? 1 : Math.max(1, input.maxSelections);
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO elections
         (title, description, ballot_type, max_selections, access_mode,
          results_visibility, opens_at, closes_at, created_by, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        input.title,
        input.description,
        input.ballotType,
        maxSel,
        input.accessMode,
        input.resultsVisibility,
        input.opensAt,
        input.closesAt,
        input.createdBy,
        input.ownerId ?? null,
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

/** Set or clear the scheduled WAT voting window (stored as UTC). */
export async function updateSchedule(
  electionId: number,
  opensAt: Date | null,
  closesAt: Date | null,
): Promise<void> {
  await pool.query(`UPDATE elections SET opens_at = $2, closes_at = $3 WHERE id = $1`, [
    electionId,
    opensAt,
    closesAt,
  ]);
}

/** Permanently delete an election. FK cascades remove its options, codes and
 * (anonymous) ballots. Callers must gate this with canDeleteElection(). */
export async function deleteElection(electionId: number): Promise<void> {
  await pool.query(`DELETE FROM elections WHERE id = $1`, [electionId]);
}

/**
 * Whether an election may be deleted. During testing (allowDelete) any election
 * can be removed. In production only an unopened 'draft' can be deleted — once
 * opened it can only be closed, so its record is preserved.
 */
export function canDeleteElection(election: Election, allowDelete: boolean): boolean {
  if (allowDelete) return true;
  return election.status === 'draft';
}

export type VotingReason = 'draft' | 'closed' | 'before' | 'after' | 'open';

/**
 * Effective voting state, combining the admin status with the scheduled WAT
 * window. Voting is accepted only when the admin has opened the election AND
 * the current time is within [opens_at, closes_at] (when those are set).
 */
export function votingState(
  election: Election,
  now: Date = new Date(),
): { open: boolean; reason: VotingReason } {
  if (election.status === 'closed') return { open: false, reason: 'closed' };
  if (election.status === 'draft') return { open: false, reason: 'draft' };
  if (election.opens_at && now < new Date(election.opens_at)) {
    return { open: false, reason: 'before' };
  }
  if (election.closes_at && now >= new Date(election.closes_at)) {
    return { open: false, reason: 'after' };
  }
  return { open: true, reason: 'open' };
}

/** Whether results may be shown publicly right now. */
export function resultsArePublic(election: Election): boolean {
  if (election.results_visibility === 'live') return true;
  if (election.status === 'closed') return true;
  // Also treat a passed close time as closed for results purposes.
  return votingState(election).reason === 'after';
}
