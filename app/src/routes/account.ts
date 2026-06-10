import fs from 'fs';
import { Request, Router } from 'express';
import { config } from '../config';
import { csrfProtection, csrfToken } from '../middleware/csrf';
import { requireCustomer, customerLocals } from '../middleware/auth';
import { magicLinkLimiter } from '../middleware/rateLimit';
import { HttpError } from '../middleware/errors';
import { uploadContestantImage, uploadPath } from '../middleware/upload';
import { sendMail } from '../mailer';
import { createMagicToken, consumeMagicToken } from '../services/customers';
import {
  canDeleteElection,
  clearOptionImage,
  createElection,
  deleteElection,
  getElectionWithOptions,
  getOptionById,
  listElectionsByOwner,
  ownsElection,
  setStatus,
  updateOptionContent,
  updateSchedule,
} from '../services/elections';
import { generateCodes, getCodeStats } from '../services/codes';
import { tallyElection } from '../services/tally';
import { logAction } from '../services/admins';
import { ElectionWithOptions } from '../services/types';
import { createElectionSchema, generateCodesSchema, scheduleSchema, toArray } from '../util/validate';
import { watInputToUtc } from '../util/datetime';

// ── Auth (unauthenticated) ──────────────────────────────────────────────────
export const accountAuthRouter = Router();

accountAuthRouter.get('/login', csrfToken, (req, res) => {
  if (req.session.customerId) return res.redirect('/account');
  res.render('account/login', { title: 'Sign in', error: null });
});

accountAuthRouter.post('/login', magicLinkLimiter, csrfProtection, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).render('account/login', { title: 'Sign in', error: 'Enter a valid email address.' });
      return;
    }
    const token = await createMagicToken(email);
    const link = `${config.PUBLIC_BASE_URL}/account/verify?token=${encodeURIComponent(token)}`;
    await sendMail({
      to: email,
      subject: 'Your Torama Vote sign-in link',
      text: `Click to sign in to Torama Vote:\n\n${link}\n\nThis link expires in 20 minutes. If you didn't request it, ignore this email.`,
      html: `<p>Click to sign in to Torama Vote:</p><p><a href="${link}">Sign in</a></p><p>This link expires in 20 minutes. If you didn't request it, ignore this email.</p>`,
    });
    res.render('account/check_email', { title: 'Check your email', email });
  } catch (err) {
    next(err);
  }
});

accountAuthRouter.get('/verify', async (req, res, next) => {
  try {
    const token = String(req.query.token || '');
    const customer = token ? await consumeMagicToken(token) : null;
    if (!customer) {
      res.status(400).render('account/login', {
        title: 'Sign in',
        error: 'That sign-in link is invalid or has expired. Please request a new one.',
      });
      return;
    }
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.customerId = customer.id;
      req.session.customerEmail = customer.email;
      res.redirect('/account');
    });
  } catch (err) {
    next(err);
  }
});

accountAuthRouter.post('/logout', csrfProtection, (req, res) => {
  req.session.destroy(() => res.redirect('/account/login'));
});

// ── Protected customer area ─────────────────────────────────────────────────
export const accountRouter = Router();
accountRouter.use(requireCustomer, customerLocals, csrfToken);

async function loadOwned(req: Request): Promise<ElectionWithOptions> {
  const id = Number(req.params.id);
  const election = await getElectionWithOptions(id);
  if (!election || !ownsElection(election, req.session.customerId!)) {
    throw new HttpError(404, 'Election not found.');
  }
  return election;
}

accountRouter.get('/', async (req, res, next) => {
  try {
    const elections = await listElectionsByOwner(req.session.customerId!);
    res.render('account/dashboard', { title: 'My elections', elections });
  } catch (err) {
    next(err);
  }
});

accountRouter.get('/elections/new', (_req, res) => {
  res.render('admin/election_new', { title: 'New election', error: null, form: null });
});

accountRouter.post('/elections', csrfProtection, async (req, res, next) => {
  try {
    const payload = {
      title: req.body.title,
      description: req.body.description,
      ballotType: req.body.ballotType,
      maxSelections: req.body.maxSelections,
      accessMode: req.body.accessMode,
      resultsVisibility: req.body.resultsVisibility,
      options: toArray(req.body.option).map((s) => s.trim()).filter((s) => s.length > 0),
      opensAt: req.body.opensAt,
      closesAt: req.body.closesAt,
    };
    const parsed = createElectionSchema.safeParse(payload);
    if (!parsed.success) {
      res.status(400).render('admin/election_new', {
        title: 'New election',
        error: parsed.error.issues.map((i) => i.message).join('; '),
        form: payload,
      });
      return;
    }
    const opensAt = watInputToUtc(parsed.data.opensAt);
    const closesAt = watInputToUtc(parsed.data.closesAt);
    if (opensAt && closesAt && closesAt <= opensAt) {
      res.status(400).render('admin/election_new', {
        title: 'New election',
        error: 'The closing time must be after the opening time.',
        form: payload,
      });
      return;
    }
    const id = await createElection({
      ...parsed.data,
      opensAt,
      closesAt,
      createdBy: null,
      ownerId: req.session.customerId!,
    });
    res.redirect(`/account/elections/${id}`);
  } catch (err) {
    next(err);
  }
});

async function renderElectionView(req: Request, res: import('express').Response, generatedCodes: string[] | null) {
  const election = await loadOwned(req);
  const codeStats = await getCodeStats(election.id);
  const tally = await tallyElection(election.id);
  res.render('admin/election_view', {
    title: election.title,
    election,
    codeStats,
    tally,
    audit: [], // customers don't see the admin audit trail
    baseUrl: config.PUBLIC_BASE_URL,
    generatedCodes,
    canDelete: canDeleteElection(election, config.ALLOW_ELECTION_DELETE),
    allowDeleteAny: config.ALLOW_ELECTION_DELETE,
  });
}

accountRouter.get('/elections/:id', async (req, res, next) => {
  try {
    await renderElectionView(req, res, null);
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/elections/:id/status', csrfProtection, async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    const status = String(req.body.status);
    if (!['draft', 'open', 'closed'].includes(status)) throw new HttpError(400, 'Invalid status.');
    await setStatus(election.id, status as 'draft' | 'open' | 'closed');
    res.redirect(`/account/elections/${election.id}`);
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/elections/:id/schedule', csrfProtection, async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid date/time.');
    const opensAt = watInputToUtc(parsed.data.opensAt);
    const closesAt = watInputToUtc(parsed.data.closesAt);
    if (opensAt && closesAt && closesAt <= opensAt) {
      throw new HttpError(400, 'The closing time must be after the opening time.');
    }
    await updateSchedule(election.id, opensAt, closesAt);
    res.redirect(`/account/elections/${election.id}`);
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/elections/:id/codes', csrfProtection, async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    if (election.status === 'closed') throw new HttpError(409, 'Cannot generate codes for a closed election.');
    const parsed = generateCodesSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Enter a valid number of codes (1–50000).');
    const codes = await generateCodes(election.id, parsed.data.count);
    await renderElectionView(req, res, codes);
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/elections/:id/codes.csv', csrfProtection, async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    const codes = toArray(req.body.code);
    const url = `${config.PUBLIC_BASE_URL}/e/${election.public_id}`;
    const body = codes.map((c) => `${c},${election.public_id},${url}`).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="voting-codes-${election.public_id}.csv"`);
    res.send(`voting_code,election_id,vote_url\n${body}\n`);
  } catch (err) {
    next(err);
  }
});

accountRouter.get('/elections/:id/contestants', async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    res.render('admin/contestants', { title: `Contestants — ${election.title}`, election });
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/elections/:id/options/:optionId', uploadContestantImage, csrfProtection, async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    const optionId = Number(req.params.optionId);
    const option = await getOptionById(optionId);
    if (!option || option.election_id !== election.id) throw new HttpError(404, 'Contestant not found.');
    const description = String(req.body.description || '').trim().slice(0, 5000);
    if (req.body.removePhoto === '1') {
      const old = await clearOptionImage(optionId);
      await updateOptionContent(optionId, description);
      if (old) fs.promises.unlink(uploadPath(old)).catch(() => undefined);
    } else if (req.file) {
      const oldPath = option.image_path;
      await updateOptionContent(optionId, description, req.file.filename);
      if (oldPath) fs.promises.unlink(uploadPath(oldPath)).catch(() => undefined);
    } else {
      await updateOptionContent(optionId, description);
    }
    res.redirect(`/account/elections/${election.id}/contestants`);
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/elections/:id/delete', csrfProtection, async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    if (!canDeleteElection(election, config.ALLOW_ELECTION_DELETE)) {
      throw new HttpError(403, 'This election has been opened and can no longer be deleted — close it instead.');
    }
    await logAction({ adminId: null, action: 'delete_election_self_service', electionId: null, detail: { title: election.title }, ip: req.ip });
    await deleteElection(election.id);
    res.redirect('/account');
  } catch (err) {
    next(err);
  }
});
