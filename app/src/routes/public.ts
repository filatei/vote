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
import { verifyElectionChain } from '../services/integrity';
import { formatWat } from '../util/datetime';
import { castBallot } from '../services/ballots';
import { bulletinBoard, determineWinner, findReceipt, tallyElection } from '../services/tally';
import { healthCheck } from '../db';
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
  res.render('public/home', {
    title: `${config.APP_NAME} — free & fair online elections`,
    error: null,
    electionId: null,
    publicPage: true,
    ogDescription:
      'Run a secret-ballot election online in minutes, with verifiable receipts so every voter can confirm their vote was counted.',
  });
});

// Static content / trust pages.
publicRouter.get('/terms', (_req, res) => res.render('public/terms', { title: 'Terms of Service' }));
publicRouter.get('/privacy', (_req, res) => res.render('public/privacy', { title: 'Privacy Policy' }));
publicRouter.get('/trust', (_req, res) => res.render('public/trust', { title: 'How we keep votes fair' }));
publicRouter.get('/status', async (_req, res, next) => {
  try {
    res.render('public/status', { title: 'System status', dbOk: await healthCheck() });
  } catch (err) {
    next(err);
  }
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
        title: config.APP_NAME,
        error: 'Please enter the election link/ID and your voting code.',
        electionId: publicId || null,
      });
      return;
    }
    const election = await getElectionWithOptionsByPublicId(publicId);
    if (!election) {
      res.status(404).render('public/home', {
        title: config.APP_NAME,
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
        title: config.APP_NAME,
        error: msg,
        electionId: publicId,
      });
      return;
    }
    res.render('public/vote', { title: election.title, election, code, codeMode: 'hidden', error: null, publicPage: true });
  } catch (err) {
    next(err);
  }
});

/** How the ballot's code field renders for a given access mode. */
function ballotCodeMode(accessMode: string): 'hidden' | 'optional' | 'none' {
  if (accessMode === 'code') return 'hidden';
  if (accessMode === 'hybrid') return 'optional';
  return 'none';
}

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

    const am = election.access_mode;
    const hasCode = code.length > 0;
    // Use the device (open) path for open elections, and for hybrid when no code
    // is entered; otherwise spend a code.
    const useOpen = am === 'open' || (am === 'hybrid' && !hasCode);
    const codeMode = ballotCodeMode(am);

    // For the open path, block a device that already voted. In hybrid, keep the
    // voter on the ballot so they can still enter a code to vote.
    if (useOpen && (await deviceAlreadyVoted(req, election))) {
      if (am === 'hybrid') {
        res.status(409).render('public/vote', {
          title: election.title,
          election,
          code,
          codeMode,
          error: 'This device has already voted. If you have a voting code, enter it to vote again.',
        });
      } else {
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
      }
      return;
    }

    try {
      const { receipt } = await castBallot({
        election,
        options: election.options,
        selectedOptionIds,
        credential: useOpen
          ? {
              mode: 'open',
              fingerprint: fingerprintFor(req),
              ip: req.ip,
              userAgent: String(req.headers['user-agent'] || ''),
            }
          : { mode: 'code', rawCode: code },
      });
      if (useOpen) setVotedCookie(res, election.public_id);
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
        // recoverable (e.g. nothing selected, or an invalid code in hybrid mode).
        res.status(err.status).render('public/vote', {
          title: election.title,
          election,
          code,
          codeMode,
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
    const am = election.access_mode;

    // Link-accessible modes show the ballot directly when votable.
    if ((am === 'open' || am === 'hybrid') && state.open) {
      // Open mode blocks a device that already voted; hybrid still shows the
      // ballot (the voter may have a code).
      if (am === 'open' && (await deviceAlreadyVoted(req, election))) {
        res.render('public/election', {
          title: election.title,
          election,
          state,
          openMode: true,
          alreadyVoted: true,
          opensWat: formatWat(election.opens_at),
          closesWat: formatWat(election.closes_at),
          error: null,
          publicPage: true,
        });
        return;
      }
      res.render('public/vote', {
        title: election.title,
        election,
        code: '',
        codeMode: ballotCodeMode(am),
        error: null,
        publicPage: true,
      });
      return;
    }

    // Code mode, or any mode that isn't currently open → the landing page.
    res.render('public/election', {
      title: election.title,
      election,
      state,
      openMode: am !== 'code',
      alreadyVoted: false,
      opensWat: formatWat(election.opens_at),
      closesWat: formatWat(election.closes_at),
      error: null,
      publicPage: true,
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
      res.render('public/results_hidden', { title: election.title, election, publicPage: true });
      return;
    }
    const tally = await tallyElection(election.id);
    const board = await bulletinBoard(election.id);
    res.render('public/results', {
      title: `Results — ${election.title}`,
      election,
      tally,
      board,
      win: determineWinner(tally),
      closedWat: election.closes_at ? formatWat(election.closes_at) : null,
      publicPage: true,
      ogTitle: `${election.title} — live results`,
      ogDescription: 'See the live tally and verify every ballot. Cast your vote and watch the results update in real time.',
    });
  } catch (err) {
    next(err);
  }
});

// Certificate of Return for the winner — available once voting has closed.
publicRouter.get('/e/:publicId/certificate', async (req, res, next) => {
  try {
    const election = await getElectionWithOptionsByPublicId(req.params.publicId);
    if (!election) throw new HttpError(404, 'Election not found.');
    if (election.status !== 'closed') {
      res.redirect(`/e/${election.public_id}/results`);
      return;
    }
    const tally = await tallyElection(election.id);
    const win = determineWinner(tally);
    if (!win.winner) {
      // No clear winner (a tie or no votes) — nothing to certify.
      res.redirect(`/e/${election.public_id}/results`);
      return;
    }
    res.render('public/certificate', {
      title: `Certificate of Return — ${election.title}`,
      election,
      win,
      closedWat: election.closes_at ? formatWat(election.closes_at) : null,
    });
  } catch (err) {
    next(err);
  }
});

// Verify the tamper-evident ballot hash-chain (public, independently checkable).
publicRouter.get('/e/:publicId/integrity', async (req, res, next) => {
  try {
    const election = await getElectionWithOptionsByPublicId(req.params.publicId);
    if (!election) throw new HttpError(404, 'Election not found.');
    const result = await verifyElectionChain(election.id, election.public_id);
    res.render('public/integrity', { title: `Integrity — ${election.title}`, election, result });
  } catch (err) {
    next(err);
  }
});

// Live tally as JSON (for streaming the results page). Only returns data when
// results are public; otherwise reports hidden so the client stops polling.
publicRouter.get('/e/:publicId/results.json', async (req, res, next) => {
  try {
    const election = await getElectionWithOptionsByPublicId(req.params.publicId);
    if (!election) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!resultsArePublic(election)) {
      res.json({ hidden: true, status: election.status });
      return;
    }
    const tally = await tallyElection(election.id);
    res.json({ status: election.status, totalBallots: tally.totalBallots, rows: tally.rows });
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
