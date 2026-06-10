import { Router } from 'express';
import { csrfProtection, csrfToken } from '../middleware/csrf';
import { codeAttemptLimiter } from '../middleware/rateLimit';
import { HttpError } from '../middleware/errors';
import { normalizeCode } from '../util/crypto';
import { toArray } from '../util/validate';
import {
  getElectionWithOptionsByPublicId,
  resultsArePublic,
  votingState,
} from '../services/elections';
import { formatWat } from '../util/datetime';
import { castBallot } from '../services/ballots';
import { bulletinBoard, findReceipt, tallyElection } from '../services/tally';

export const publicRouter = Router();

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
    res.render('public/vote', { title: election.title, election, code, error: null });
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

    try {
      const { receipt } = await castBallot({
        election,
        options: election.options,
        rawCode: code,
        selectedOptionIds,
      });
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
        // recoverable (e.g. nothing selected). For "already used" we explain.
        res.status(err.status).render('public/vote', {
          title: election.title,
          election,
          code,
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
    res.render('public/election', {
      title: election.title,
      election,
      state: votingState(election),
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
