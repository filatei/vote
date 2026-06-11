import { config } from '../config';
import { withSerializableTx } from '../db';
import { HttpError } from '../middleware/errors';
import { generateReceiptCode, hashCode } from '../util/crypto';
import { votingState } from './elections';
import { Election, Option } from './types';

export interface CastResult {
  receipt: string;
}

/**
 * Pure validation of a voter's selection against the ballot rules. Returns the
 * de-duplicated, validated list of option ids, or throws an HttpError. Kept
 * side-effect-free so it can be unit tested without a database.
 */
export function validateSelection(
  election: Pick<Election, 'ballot_type' | 'max_selections'>,
  options: Pick<Option, 'id'>[],
  selectedOptionIds: number[],
): number[] {
  // Coerce both sides to Number before comparing. Postgres returns BIGINT
  // columns (option ids) as strings, while form-submitted ids arrive as
  // numbers — without this, every option would look invalid.
  const selected = Array.from(new Set(selectedOptionIds.map((n) => Number(n))));
  if (selected.length === 0) {
    throw new HttpError(400, 'Please select at least one option.');
  }
  const validOptionIds = new Set(options.map((o) => Number(o.id)));
  for (const id of selected) {
    if (!Number.isInteger(id) || !validOptionIds.has(id)) {
      throw new HttpError(400, 'Invalid option selected.');
    }
  }
  if (election.ballot_type === 'single' && selected.length !== 1) {
    throw new HttpError(400, 'This ballot allows exactly one choice.');
  }
  if (election.ballot_type === 'multiple' && selected.length > election.max_selections) {
    throw new HttpError(400, `You may select at most ${election.max_selections} option(s).`);
  }
  return selected;
}

/**
 * Cast a ballot. This is the integrity-critical path.
 *
 * Inside ONE serializable transaction we:
 *   1. find the voting code by its hash and lock it (FOR UPDATE);
 *   2. reject if missing or already used;
 *   3. flip it to used (recording only a coarse DATE, never the choice);
 *   4. validate the selected options against the ballot rules;
 *   5. insert an ANONYMOUS ballot + selections with a fresh receipt.
 *
 * The voting-code row and the ballot row share no key, so the ballot cannot be
 * traced back to the code or the voter. Serializable isolation + the row lock
 * guarantee a code is spent at most once even under concurrent submits.
 */
/**
 * How the voter is authorised:
 *  - code: redeem a pre-issued voting code (spent exactly once).
 *  - open: anyone with the link; limited to one ballot per device fingerprint.
 */
export type Credential =
  | { mode: 'code'; rawCode: string }
  | { mode: 'open'; fingerprint: string; ip?: string; userAgent?: string };

export async function castBallot(params: {
  election: Election;
  options: Option[];
  selectedOptionIds: number[];
  credential: Credential;
}): Promise<CastResult> {
  const { election, options, selectedOptionIds, credential } = params;

  const state = votingState(election);
  if (!state.open) {
    const msg =
      state.reason === 'before'
        ? 'Voting has not opened yet for this election.'
        : state.reason === 'after'
          ? 'Voting has closed for this election.'
          : 'This election is not currently open for voting.';
    throw new HttpError(409, msg);
  }

  const selected = validateSelection(election, options, selectedOptionIds);

  return withSerializableTx<CastResult>(async (client) => {
    if (credential.mode === 'code') {
      // Lock the code row so concurrent attempts serialize on it.
      const codeRes = await client.query<{ id: number; used: boolean }>(
        `SELECT id, used FROM voting_codes
          WHERE election_id = $1 AND code_hash = $2
          FOR UPDATE`,
        [election.id, hashCode(credential.rawCode)],
      );
      const codeRow = codeRes.rows[0];
      if (!codeRow) {
        throw new HttpError(400, 'That voting code is not valid for this election.');
      }
      if (codeRow.used) {
        throw new HttpError(409, 'This voting code has already been used.');
      }
      // Spend the code. Record only a coarse date (anti-correlation).
      await client.query(
        `UPDATE voting_codes SET used = TRUE, used_on = (now() AT TIME ZONE 'UTC')::date
          WHERE id = $1`,
        [codeRow.id],
      );
    } else {
      // Open mode: claim this device fingerprint. The UNIQUE constraint makes
      // the insert fail (0 rows) if it already voted — atomic one-per-device.
      // When the platform device audit is enabled, also record IP + user-agent
      // (still unlinked from the ballot).
      const claim = config.DEVICE_AUDIT_ENABLED
        ? await client.query(
            `INSERT INTO device_votes (election_id, fingerprint, ip, user_agent, created_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (election_id, fingerprint) DO NOTHING
             RETURNING id`,
            [election.id, credential.fingerprint, credential.ip ?? null, credential.userAgent ?? null],
          )
        : await client.query(
            `INSERT INTO device_votes (election_id, fingerprint)
             VALUES ($1, $2)
             ON CONFLICT (election_id, fingerprint) DO NOTHING
             RETURNING id`,
            [election.id, credential.fingerprint],
          );
      if (claim.rowCount === 0) {
        throw new HttpError(409, 'A vote has already been recorded from this device.');
      }
    }

    // Insert the anonymous ballot with a unique receipt (retry on rare clash).
    let receipt = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      receipt = generateReceiptCode();
      const ins = await client.query<{ id: number }>(
        `INSERT INTO ballots (election_id, receipt_code)
         VALUES ($1, $2)
         ON CONFLICT (election_id, receipt_code) DO NOTHING
         RETURNING id`,
        [election.id, receipt],
      );
      if (ins.rowCount === 1) {
        const ballotId = ins.rows[0].id;
        for (const optionId of selected) {
          await client.query(
            `INSERT INTO ballot_selections (ballot_id, option_id) VALUES ($1, $2)`,
            [ballotId, optionId],
          );
        }
        return { receipt };
      }
    }
    // Should essentially never happen with 60-bit receipts.
    throw new HttpError(500, 'Could not record your ballot. Please try again.');
  });
}
