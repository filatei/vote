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
  getElectionById,
  getElectionWithOptions,
  getOptionById,
  listElectionsByOwner,
  ownsElection,
  setElectionLogo,
  setStatus,
  updateElectionDraft,
  updateOptionContent,
  updateSchedule,
} from '../services/elections';
import { editDataFromElection, parseEditForm } from '../util/electionEdit';
import { logger } from '../logger';
import {
  formatAmount,
  getPaymentByReference,
  initializePayment,
  paymentsEnabled,
  verifyPayment,
} from '../services/payments';
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

accountAuthRouter.post('/login', magicLinkLimiter, csrfProtection, csrfToken, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    // Reasonable email check: local@domain.tld, sane lengths.
    const validEmail = email.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
    if (!validEmail) {
      res.status(400).render('account/login', {
        title: 'Sign in',
        error: 'Please enter a valid email address (e.g. you@example.com).',
      });
      return;
    }
    try {
      const token = await createMagicToken(email);
      const link = `${config.PUBLIC_BASE_URL}/account/verify?token=${encodeURIComponent(token)}`;
      await sendMail({
        to: email,
        subject: 'Your Torama Vote sign-in link',
        text: `Click to sign in to Torama Vote:\n\n${link}\n\nThis link expires in 20 minutes. If you didn't request it, ignore this email.`,
        html: `<p>Click to sign in to Torama Vote:</p><p><a href="${link}">Sign in</a></p><p>This link expires in 20 minutes. If you didn't request it, ignore this email.</p>`,
      });
    } catch (mailErr) {
      logger.error({ err: mailErr }, 'magic-link send failed');
      res.status(503).render('account/login', {
        title: 'Sign in',
        error: "We couldn't send the sign-in email right now. Please check the address and try again shortly.",
      });
      return;
    }
    res.render('account/check_email', { title: 'Check your email', email });
  } catch (err) {
    next(err);
  }
});

accountAuthRouter.get('/verify', csrfToken, async (req, res, next) => {
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
    // Email the organiser their links (best-effort).
    try {
      const manage = `${config.PUBLIC_BASE_URL}/account/elections/${id}`;
      await sendMail({
        to: req.session.customerEmail!,
        subject: `Your election "${parsed.data.title}" is set up`,
        text:
          `Your election "${parsed.data.title}" has been created on Torama Vote.\n\n` +
          `Manage it (add candidates, generate codes, open voting): ${manage}\n\n` +
          `Once you open it, share the voter link shown on that page.`,
      });
    } catch (mailErr) {
      logger.error({ err: mailErr }, 'election-setup email failed');
    }
    res.redirect(`/account/elections/${id}`);
  } catch (err) {
    next(err);
  }
});

async function renderElectionView(req: Request, res: import('express').Response, generatedCodes: string[] | null) {
  const election = await loadOwned(req);
  const codeStats = await getCodeStats(election.id);
  const tally = await tallyElection(election.id);
  const paid = req.query.paid;
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
    paymentsEnabled: paymentsEnabled(),
    payFlash: paid === '1' ? 'ok' : paid === '0' ? 'fail' : null,
  });
}

accountRouter.get('/elections/:id', async (req, res, next) => {
  try {
    await renderElectionView(req, res, null);
  } catch (err) {
    next(err);
  }
});

// Edit a draft election (title, candidates, parameters)
accountRouter.get('/elections/:id/edit', async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    if (election.status !== 'draft') {
      throw new HttpError(409, 'This election can only be edited while it is a draft.');
    }
    res.render('admin/election_edit', {
      title: 'Edit election',
      election,
      data: editDataFromElection(election),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/elections/:id/edit', csrfProtection, async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    if (election.status !== 'draft') {
      throw new HttpError(409, 'This election can only be edited while it is a draft.');
    }
    const result = parseEditForm(req);
    if (!result.ok) {
      res.status(400).render('admin/election_edit', {
        title: 'Edit election',
        election,
        data: result.data,
        error: result.error,
      });
      return;
    }
    const removed = await updateElectionDraft(election.id, result.data);
    for (const p of removed) fs.promises.unlink(uploadPath(p)).catch(() => undefined);
    res.redirect(`/account/elections/${election.id}`);
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/elections/:id/status', csrfProtection, async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    const status = String(req.body.status);
    if (!['draft', 'open', 'closed'].includes(status)) throw new HttpError(400, 'Invalid status.');
    // Opening requires the launch fee to be paid (when payments are enabled).
    if (status === 'open' && paymentsEnabled() && !election.paid) {
      throw new HttpError(402, 'Please pay the launch fee before opening this election.');
    }
    await setStatus(election.id, status as 'draft' | 'open' | 'closed');
    res.redirect(`/account/elections/${election.id}`);
  } catch (err) {
    next(err);
  }
});

// Start payment for launching this election → redirect to Paystack checkout.
accountRouter.post('/elections/:id/pay', csrfProtection, async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    if (!paymentsEnabled()) throw new HttpError(503, 'Payments are not configured yet.');
    if (election.paid) {
      res.redirect(`/account/elections/${election.id}`);
      return;
    }
    const url = await initializePayment({
      electionId: election.id,
      customerId: req.session.customerId!,
      email: req.session.customerEmail!,
    });
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

// Paystack returns here after checkout. Verify is authoritative.
accountRouter.get('/pay/callback', async (req, res, next) => {
  try {
    const reference = String(req.query.reference || req.query.trxref || '');
    if (!reference) {
      res.redirect('/account');
      return;
    }
    // Ownership check: the payment must belong to the signed-in customer.
    const pay = await getPaymentByReference(reference);
    if (!pay || Number(pay.customerId) !== Number(req.session.customerId)) {
      res.redirect('/account');
      return;
    }
    const result = await verifyPayment(reference);
    if (result.ok && result.electionId) {
      const el = await getElectionById(result.electionId);
      if (el && el.status === 'draft') await setStatus(result.electionId, 'open');
      // Email a receipt (best-effort).
      try {
        const amt = formatAmount(pay.amountSubunits, pay.currency);
        await sendMail({
          to: pay.email,
          subject: 'Payment receipt — Torama Vote',
          text:
            `Thank you. Your payment has been received.\n\n` +
            `Election: ${el ? el.title : '—'}\n` +
            `Amount: ${amt}\n` +
            `Reference: ${pay.reference}\n` +
            `Date: ${new Date().toISOString().slice(0, 10)}\n\n` +
            `Your election is now open. Manage it at ${config.PUBLIC_BASE_URL}/account/elections/${result.electionId}`,
        });
      } catch (mailErr) {
        logger.error({ err: mailErr }, 'payment receipt email failed');
      }
      res.redirect(`/account/elections/${result.electionId}?paid=1`);
    } else {
      res.redirect(result.electionId ? `/account/elections/${result.electionId}?paid=0` : '/account');
    }
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

// Election branding logo upload (owner)
accountRouter.post('/elections/:id/logo', uploadContestantImage, csrfProtection, async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    if (req.body.removeLogo === '1') {
      const old = await setElectionLogo(election.id, null);
      if (old) fs.promises.unlink(uploadPath(old)).catch(() => undefined);
    } else if (req.file) {
      const old = await setElectionLogo(election.id, req.file.filename);
      if (old) fs.promises.unlink(uploadPath(old)).catch(() => undefined);
    }
    res.redirect(`/account/elections/${election.id}`);
  } catch (err) {
    next(err);
  }
});

// Results CSV export (owner)
accountRouter.get('/elections/:id/results.csv', async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    const tally = await tallyElection(election.id);
    const total = tally.rows.reduce((s, r) => s + r.votes, 0);
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'candidate,votes,percentage\n';
    const body = tally.rows
      .slice()
      .sort((a, b) => b.votes - a.votes)
      .map((r) => [r.label, r.votes, total ? `${((r.votes / total) * 100).toFixed(1)}%` : '0%'].map(esc).join(','))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="results-${election.public_id}.csv"`);
    res.send(`${header}${body}\n`);
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
