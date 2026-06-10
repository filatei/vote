import { Request, Response, Router } from 'express';
import { csrfProtection, csrfToken } from '../middleware/csrf';
import { codeAttemptLimiter } from '../middleware/rateLimit';
import { HttpError } from '../middleware/errors';
import { config } from '../config';
import { deviceFingerprint, normalizeCode } from '../util/crypto';
import { toArray } from '../util/validate';
import {
  getElectionWithOptionsByPublicId,
  resultsArePublic,
  votingState,
} from '../services/elections';
import { deviceHasVoted } from '../services/devices';
import { formatWat } from '../util/datetime';
import { castBallot } from '../services/ballots';
import { bulletinBoard, findReceipt, tallyElection } from '../services/tally';
import { Election } from '../services/types';

export const publicRouter = Router();

/** Cookie name marking that this browser already voted in an open election. */
function votedCookieName(publicId: string): string {
  return `vd_${publicId.replace(/[^a-zA-Z0-9]/g, '')}`;
}

function fingerprintFor(req: Request): string {
  return deviceFingerprint({
    ip: req.ip,
    ua: req.headers['user-agent'],
    lang: req.headers['accept-language'],
  });
}

/** True if this device already voted (cookie marker or server-side fingerprint). */
async function deviceAlreadyVoted(req: Request, election: Election): Promise<boolean> {
  if (req.cookies?.[votedCookieName(election.public_id)]) return true;
  return deviceHasVoted(election.id, fingerprintFor(req));
}

function setVotedCookie(res: Response, publicId: string): void {
  res.cookie(votedCookieName(publicId), '1', {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year
  });
}

// Landing page: enter a voting code.
publicRouter.get('/', csrfToken, (_req, res) => {
  res.render('public/home', { title: 'Torama Vote', error: null, electionId: null });
});

/**
 * Step 1 — voter submits a code. We DON'T mark it used yet; we only check the
 * election is votable and render the ballot. The code is carried forward in a
 * hidden field and only spent on final submit.
 */
publicRouter.post('/vote', codeAttemptLimiter, csrfProtection, csrfToken, async (req, res, next) => {
  try {
    const publicId = String(req.body.election || '').trim();
    const code = normalizeCode(String(req.body.code || ''));
    if (!publicId || !code) {
      res.status(400).render('public/home', {
        title: 'Torama Vote',
        error: 'Please enter the election link/ID and your voting code.',
        electionId: publicId || null,
      });
      return;
    }
    const election = await getElectionWithOptionsByPublicId(publicId);
    if (!election) {
      res.status(404).render('public/home', {
        title: 'Torama Vote',
        error: 'No election found for that ID.',
        electionId: publicId,
      });
      return;
    }
    const state = votingState(election);
    if (!state.open) {
      const msg =
        state.reason === 'before'
          ? `Voting has not opened yet${election.opens_at ? ` — it opens ${formatWat(election.opens_at)}.` : '.'}`
          : state.reason === 'after'
            ? 'Voting has closed for that election.'
            : 'That election is not open for voting right now.';
      res.status(409).render('public/home', {
        title: 'Torama Vote',
        error: msg,
        electionId: publicId,
      });
      return;
    }
    res.render('public/vote', { title: election.title, election, code, openMode: false, error: null });
  } catch (err) {
    next(err);
  }
});

/**
 * Step 2 — voter confirms their selection. This is where the code is actually
 * spent and the anonymous ballot is recorded.
 */
publicRouter.post('/cast', codeAttemptLimiter, csrfProtection, csrfToken, async (req, res, next) => {
  try {
    const publicId = String(req.body.election || '').trim();
    const code = normalizeCode(String(req.body.code || ''));
    const selectedOptionIds = toArray(req.body.option).map((v) => Number(v)).filter((n) => Number.isInteger(n));

    const election = await getElectionWithOptionsByPublicId(publicId);
    if (!election) throw new HttpError(404, 'Election not found.');

    const openMode = election.access_mode === 'open';

    // Open mode: short-circuit if this device already has a cookie marker.
    if (openMode && (await deviceAlreadyVoted(req, election))) {
      res.status(409).render('public/election', {
        title: election.title,
        election,
        state: votingState(election),
        openMode: true,
        alreadyVoted: true,
        opensWat: formatWat(election.opens_at),
        closesWat: formatWat(election.closes_at),
        error: null,
      });
      return;
    }

    try {
      const { receipt } = await castBallot({
        election,
        options: election.options,
        selectedOptionIds,
        credential: openMode
          ? { mode: 'open', fingerprint: fingerprintFor(req) }
          : { mode: 'code', rawCode: code },
      });
      if (openMode) setVotedCookie(res, election.public_id);
      const verifyUrl = `/e/${election.public_id}/verify`;
      res.render('public/receipt', {
        title: 'Vote recorded',
        election,
        receipt,
        verifyUrl,
      });
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) {
        // Re-render the ballot with the error so the voter can retry if it was
        // recoverable (e.g. nothing selected).
        res.status(err.status).render('public/vote', {
          title: election.title,
          election,
          code,
          openMode,
          error: err.message,
        });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// Per-election public landing (shareable link).
publicRouter.get('/e/:publicId', csrfToken, async (req, res, next) => {
  try {
    const election = await getElectionWithOptionsByPublicId(req.params.publicId);
    if (!election) throw new HttpError(404, 'Election not found.');
    const state = votingState(election);
    const openMode = election.access_mode === 'open';

    // Open + currently votable + this device hasn't voted → show ballot directly.
    if (openMode && state.open && !(await deviceAlreadyVoted(req, election))) {
      res.render('public/vote', { title: election.title, election, code: '', openMode: true, error: null });
      return;
    }

    res.render('public/election', {
      title: election.title,
      election,
      state,
      openMode,
      alreadyVoted: openMode && state.open ? await deviceAlreadyVoted(req, election) : false,
      opensWat: formatWat(election.opens_at),
      closesWat: formatWat(election.closes_at),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// Public results board.
publicRouter.get('/e/:publicId/results', async (req, res, next) => {
  try {
    const election = await getElectionWithOptionsByPublicId(req.params.publicId);
    if (!election) throw new HttpError(404, 'Election not found.');
    if (!resultsArePublic(election)) {
      res.render('public/results_hidden', { title: election.title, election });
      return;
    }
    const tally = await tallyElection(election.id);
    const board = await bulletinBoard(election.id);
    res.render('public/results', { title: `Results — ${election.title}`, election, tally, board });
  } catch (err) {
    next(err);
  }
});

// Receipt verification.
publicRouter.get('/e/:publicId/verify', csrfToken, async (req, res, next) => {
  try {
    const election = await getElectionWithOptionsByPublicId(req.params.publicId);
    if (!election) throw new HttpError(404, 'Election not found.');
    res.render('public/verify', { title: 'Verify your vote', election, result: undefined, query: '' });
  } catch (err) {
    next(err);
  }
});

publicRouter.post('/e/:publicId/verify', csrfProtection, csrfToken, async (req, res, next) => {
  try {
    const election = await getElectionWithOptionsByPublicId(req.params.publicId);
    if (!election) throw new HttpError(404, 'Election not found.');
    const query = normalizeCode(String(req.body.receipt || ''));
    const result = query ? await findReceipt(election.id, query) : null;
    res.render('public/verify', { title: 'Verify your vote', election, result, query });
  } catch (err) {
    next(err);
  }
});
