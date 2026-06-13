import { pool } from '../db';
import { config } from '../config';
import { getBoolSetting } from './settings';
import { Election, ElectionWithOptions, Option } from './types';

// ── Election templates ──────────────────────────────────────────────────────
export type ElectionType = 'candidates' | 'association' | 'committee' | 'poll';

export interface ElectionTypeConfig {
  key: ElectionType;
  name: string; // shown in the chooser
  hint: string;
  itemNoun: string; // singular, lower-case (candidate / option)
  manageNoun: string; // editor page heading (Candidates / Options)
  manageVerb: string; // button label (Manage candidates / Manage options)
  showProfiles: boolean; // photos + bios + the management page at all
  showBio: boolean;
  showAffiliation: boolean;
  affiliationLabel: string;
  affiliationPlaceholder: string;
  showLogo: boolean;
  logoLabel: string;
}

const ELECTION_TYPES: Record<ElectionType, ElectionTypeConfig> = {
  candidates: {
    key: 'candidates', name: 'Candidates / people',
    hint: 'People running for office — photos, bios, optional party/affiliation and logo.',
    itemNoun: 'candidate', manageNoun: 'Candidates', manageVerb: 'Manage candidates',
    showProfiles: true, showBio: true,
    showAffiliation: true, affiliationLabel: 'Party / affiliation', affiliationPlaceholder: 'e.g. Labour Party',
    showLogo: true, logoLabel: 'Party logo / emblem',
  },
  association: {
    key: 'association', name: 'Professional body / association',
    hint: 'Candidates contesting a position — photos and bios, no party.',
    itemNoun: 'candidate', manageNoun: 'Candidates', manageVerb: 'Manage candidates',
    showProfiles: true, showBio: true,
    showAffiliation: true, affiliationLabel: 'Position / affiliation', affiliationPlaceholder: 'e.g. Lagos Branch',
    showLogo: false, logoLabel: '',
  },
  committee: {
    key: 'committee', name: 'Club / society committee',
    hint: 'Members standing for committee roles — photos and bios.',
    itemNoun: 'candidate', manageNoun: 'Candidates', manageVerb: 'Manage candidates',
    showProfiles: true, showBio: true,
    showAffiliation: false, affiliationLabel: '', affiliationPlaceholder: '',
    showLogo: false, logoLabel: '',
  },
  poll: {
    key: 'poll', name: 'Simple poll / decision',
    hint: 'Just options to choose between (venues, dates, yes/no) — no photos or bios.',
    itemNoun: 'option', manageNoun: 'Options', manageVerb: 'Edit options',
    showProfiles: false, showBio: false,
    showAffiliation: false, affiliationLabel: '', affiliationPlaceholder: '',
    showLogo: false, logoLabel: '',
  },
};

export function electionTypeConfig(type: string | null | undefined): ElectionTypeConfig {
  return ELECTION_TYPES[(type as ElectionType)] ?? ELECTION_TYPES.candidates;
}

export function electionTypeList(): ElectionTypeConfig[] {
  return [ELECTION_TYPES.candidates, ELECTION_TYPES.association, ELECTION_TYPES.committee, ELECTION_TYPES.poll];
}

/** Runtime master switch for election deletion (admin-toggleable; .env default). */
export function allowElectionDelete(): boolean {
  return getBoolSetting('allow_election_delete', config.ALLOW_ELECTION_DELETE);
}

// Postgres returns BIGINT columns as strings; coerce numeric fields so the
// Election object matches its declared types and id comparisons are reliable.
function coerceElection(r: Election): Election {
  return {
    ...r,
    id: Number(r.id),
    owner_id: r.owner_id == null ? null : Number(r.owner_id),
    max_selections: Number(r.max_selections),
    enrolled_voters: Number(r.enrolled_voters ?? 0),
  };
}

export async function listElections(): Promise<Election[]> {
  const { rows } = await pool.query<Election>(
    `SELECT * FROM elections ORDER BY created_at DESC`,
  );
  return rows.map(coerceElection);
}

export async function listElectionsByOwner(ownerId: number): Promise<Election[]> {
  const { rows } = await pool.query<Election>(
    `SELECT * FROM elections WHERE owner_id = $1 ORDER BY created_at DESC`,
    [ownerId],
  );
  return rows.map(coerceElection);
}

/** True if the given customer owns this election. Both sides are coerced to
 * Number because Postgres returns BIGINT columns (and our session id) as strings. */
export function ownsElection(election: Election, customerId: number | string): boolean {
  return Number(election.owner_id) === Number(customerId);
}

export async function getElectionById(id: number): Promise<Election | null> {
  const { rows } = await pool.query<Election>(`SELECT * FROM elections WHERE id = $1`, [id]);
  return rows[0] ? coerceElection(rows[0]) : null;
}

export async function getElectionByPublicId(publicId: string): Promise<Election | null> {
  const { rows } = await pool.query<Election>(`SELECT * FROM elections WHERE public_id = $1`, [
    publicId,
  ]);
  return rows[0] ? coerceElection(rows[0]) : null;
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

/** Set a contestant's party-logo image path. */
export async function setOptionFlag(optionId: number, flagPath: string): Promise<void> {
  await pool.query(`UPDATE options SET flag_path = $2 WHERE id = $1`, [optionId, flagPath]);
}

/** Set a contestant's party name (e.g. "Labour Party"). */
export async function setOptionParty(optionId: number, party: string): Promise<void> {
  await pool.query(`UPDATE options SET party = $2 WHERE id = $1`, [optionId, party]);
}

/** Clear a contestant's party flag. Returns the previous path so it can be deleted. */
export async function clearOptionFlag(optionId: number): Promise<string | null> {
  const before = await pool.query<{ flag_path: string | null }>(
    `SELECT flag_path FROM options WHERE id = $1`,
    [optionId],
  );
  const old = before.rows[0]?.flag_path ?? null;
  await pool.query(`UPDATE options SET flag_path = NULL WHERE id = $1`, [optionId]);
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
  accessMode: 'code' | 'open' | 'hybrid';
  resultsVisibility: 'live' | 'after_close';
  electionType: ElectionType;
  enrolledVoters?: number;
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
          results_visibility, election_type, enrolled_voters, opens_at, closes_at, created_by, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        input.title,
        input.description,
        input.ballotType,
        maxSel,
        input.accessMode,
        input.resultsVisibility,
        input.electionType,
        Math.max(0, Math.floor(input.enrolledVoters ?? 0)),
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

export interface EditOption {
  id: number | null; // null = a new candidate
  label: string;
}

/**
 * Amend a DRAFT election's parameters and candidate list. Existing options are
 * renamed in place (preserving their id, photo and bio); new ones are inserted;
 * omitted ones are deleted. Returns the image paths of any removed candidates so
 * the caller can delete the files. Caller must ensure the election is a draft.
 */
export async function updateElectionDraft(
  electionId: number,
  input: {
    title: string;
    description: string;
    ballotType: 'single' | 'multiple';
    maxSelections: number;
    accessMode: 'code' | 'open' | 'hybrid';
    resultsVisibility: 'live' | 'after_close';
    enrolledVoters?: number;
    options: EditOption[];
  },
): Promise<string[]> {
  const client = await pool.connect();
  const removedImages: string[] = [];
  try {
    await client.query('BEGIN');
    const maxSel = input.ballotType === 'single' ? 1 : Math.max(1, input.maxSelections);
    await client.query(
      `UPDATE elections
          SET title = $2, description = $3, ballot_type = $4, max_selections = $5,
              access_mode = $6, results_visibility = $7,
              enrolled_voters = COALESCE($8, enrolled_voters)
        WHERE id = $1`,
      [
        electionId,
        input.title,
        input.description,
        input.ballotType,
        maxSel,
        input.accessMode,
        input.resultsVisibility,
        input.enrolledVoters == null ? null : Math.max(0, Math.floor(input.enrolledVoters)),
      ],
    );

    const existing = await client.query<{ id: string; image_path: string | null }>(
      `SELECT id, image_path FROM options WHERE election_id = $1`,
      [electionId],
    );
    const existingIds = new Set(existing.rows.map((r) => Number(r.id)));
    const keptIds = new Set<number>();

    let position = 0;
    for (const opt of input.options) {
      if (opt.id != null && existingIds.has(opt.id)) {
        await client.query(`UPDATE options SET label = $2, position = $3 WHERE id = $1`, [
          opt.id,
          opt.label,
          position,
        ]);
        keptIds.add(opt.id);
      } else {
        await client.query(
          `INSERT INTO options (election_id, label, position) VALUES ($1, $2, $3)`,
          [electionId, opt.label, position],
        );
      }
      position += 1;
    }

    for (const row of existing.rows) {
      const idNum = Number(row.id);
      if (!keptIds.has(idNum)) {
        if (row.image_path) removedImages.push(row.image_path);
        await client.query(`DELETE FROM options WHERE id = $1`, [idNum]);
      }
    }

    await client.query('COMMIT');
    return removedImages;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Set or clear the election's branding logo. Returns the previous path. */
export async function setElectionLogo(
  electionId: number,
  path: string | null,
): Promise<string | null> {
  const before = await pool.query<{ logo_path: string | null }>(
    `SELECT logo_path FROM elections WHERE id = $1`,
    [electionId],
  );
  const old = before.rows[0]?.logo_path ?? null;
  await pool.query(`UPDATE elections SET logo_path = $2 WHERE id = $1`, [electionId, path]);
  return old;
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
