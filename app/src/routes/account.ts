import fs from 'fs';
import { Request, Router } from 'express';
import { config } from '../config';
import { csrfProtection, csrfToken } from '../middleware/csrf';
import { requireCustomer, customerLocals } from '../middleware/auth';
import { magicLinkLimiter } from '../middleware/rateLimit';
import { HttpError } from '../middleware/errors';
import { uploadContestantImage, uploadContestantMedia, uploadPath } from '../middleware/upload';
import { sendMail } from '../mailer';
import {
  createMagicToken,
  consumeMagicToken,
  findOrCreateCustomerByEmail,
  getCustomerById,
} from '../services/customers';
import {
  cancelSubscription,
  createCheckout,
  getCustomerSubscription,
  hasActiveSubscription,
  resumeSubscription,
  subscriptionPriceLabel,
  subscriptionsEnabled,
} from '../services/subscriptions';
import {
  accountRedirectUri,
  buildAuthUrl,
  exchangeCode,
  googleEnabled,
} from '../services/googleAuth';
import { generateUrlToken } from '../util/crypto';
import {
  allowElectionDelete,
  canDeleteElection,
  clearOptionFlag,
  clearOptionImage,
  createElection,
  deleteElection,
  getElectionById,
  getElectionWithOptions,
  getOptionById,
  listElectionsByOwner,
  ownsElection,
  setElectionLogo,
  setOptionFlag,
  setOptionParty,
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
  priceLabelForElection,
  quoteElection,
  reconcilePendingPayment,
  setProviderReference,
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

// Expose whether Google sign-in is available to every auth view.
accountAuthRouter.use((_req, res, next) => {
  res.locals.googleEnabled = googleEnabled();
  next();
});

accountAuthRouter.get('/login', csrfToken, (req, res) => {
  if (req.session.customerId) return res.redirect('/account');
  res.render('account/login', { title: 'Sign in', error: null });
});

// ── Google Sign-In for election creators (no allowlist — open self-service) ──
accountAuthRouter.get('/auth/google', (req, res, next) => {
  if (!googleEnabled()) return next(new HttpError(404, 'Not found.'));
  if (req.session.customerId) return res.redirect('/account');
  const state = generateUrlToken(16);
  req.session.oauthState = state;
  res.redirect(buildAuthUrl(state, accountRedirectUri()));
});

accountAuthRouter.get('/auth/google/callback', csrfToken, async (req, res, next) => {
  try {
    if (!googleEnabled()) return next(new HttpError(404, 'Not found.'));

    const renderError = (msg: string) =>
      res.status(403).render('account/login', { title: 'Sign in', error: msg });

    if (req.query.error) return renderError('Google sign-in was cancelled.');

    const state = String(req.query.state || '');
    if (!state || state !== req.session.oauthState) {
      return renderError('Sign-in session expired or was invalid. Please try again.');
    }
    delete req.session.oauthState;

    const code = String(req.query.code || '');
    const identity = code ? await exchangeCode(code, accountRedirectUri()) : null;
    if (!identity || !identity.emailVerified) {
      return renderError('Could not verify your Google account. Please try again.');
    }

    const customer = await findOrCreateCustomerByEmail(identity.email);
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
        subject: `Your ${config.APP_NAME} sign-in link`,
        text: `Click to sign in to ${config.APP_NAME}:\n\n${link}\n\nThis link expires in 20 minutes. If you didn't request it, ignore this email.`,
        html: `<p>Click to sign in to ${config.APP_NAME}:</p><p><a href="${link}">Sign in</a></p><p>This link expires in 20 minutes. If you didn't request it, ignore this email.</p>`,
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
      electionType: req.body.electionType,
      enrolledVoters: req.body.enrolledVoters,
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
          `Your election "${parsed.data.title}" has been created on ${config.APP_NAME}.\n\n` +
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
  let election = await loadOwned(req);
  // Verify-on-view safety net: the Monnify/Paystack webhook lives on another
  // app (one webhook per account), so re-check a pending payment on reload in
  // case the payer never returned to the callback. Best-effort — a provider
  // outage must not break the page.
  if (paymentsEnabled() && !election.paid) {
    try {
      const becamePaid = await reconcilePendingPayment(election.id);
      if (becamePaid) {
        if (election.status === 'draft') await setStatus(election.id, 'open');
        election = await loadOwned(req); // refresh paid/status
      }
    } catch (err) {
      logger.error({ err, electionId: election.id }, 'verify-on-view reconcile failed');
    }
  }
  const codeStats = await getCodeStats(election.id);
  const tally = await tallyElection(election.id);
  const paid = req.query.paid;
  const subEnabled = subscriptionsEnabled();
  const subActive = subEnabled ? hasActiveSubscription(await getCustomerSubscription(req.session.customerId!)) : true;
  const quote = quoteElection(election);
  res.render('admin/election_view', {
    title: election.title,
    election,
    codeStats,
    tally,
    audit: [], // customers don't see the admin audit trail
    baseUrl: config.PUBLIC_BASE_URL,
    generatedCodes,
    canDelete: canDeleteElection(election, allowElectionDelete()),
    allowDeleteAny: allowElectionDelete(),
    paymentsEnabled: paymentsEnabled(),
    quote,
    priceLabel: priceLabelForElection(election),
    formatAmount,
    payFlash: paid === '1' ? 'ok' : paid === '0' ? 'fail' : null,
    subRequired: subEnabled && !subActive,
    subPriceLabel: subscriptionPriceLabel(),
  });
}

// Billing / subscription page.
accountRouter.get('/billing', async (req, res, next) => {
  try {
    const sub = await getCustomerSubscription(req.session.customerId!);
    res.render('account/billing', {
      title: 'Billing',
      sub,
      active: hasActiveSubscription(sub),
      enabled: subscriptionsEnabled(),
      priceLabel: subscriptionPriceLabel(),
      justSubscribed: req.query.sub === 'success',
      needed: req.query.need === '1',
      checkoutError: req.query.err === '1',
      justCancelled: req.query.cancelled === '1',
      justResumed: req.query.resumed === '1',
    });
  } catch (err) {
    next(err);
  }
});

// Start a Lemon Squeezy checkout for the monthly subscription.
accountRouter.post('/subscribe', csrfProtection, async (req, res, next) => {
  try {
    if (!subscriptionsEnabled()) {
      res.redirect('/account/billing');
      return;
    }
    const customer = await getCustomerById(req.session.customerId!);
    if (!customer) {
      res.redirect('/account/login');
      return;
    }
    const url = await createCheckout(customer);
    res.redirect(url || '/account/billing?err=1');
  } catch (err) {
    next(err);
  }
});

// Cancel the subscription (stays active until the period ends).
accountRouter.post('/cancel-subscription', csrfProtection, async (req, res, next) => {
  try {
    const sub = await getCustomerSubscription(req.session.customerId!);
    if (sub.subscriptionId) await cancelSubscription(req.session.customerId!, sub.subscriptionId);
    res.redirect('/account/billing?cancelled=1');
  } catch (err) {
    next(err);
  }
});

// Resume a cancelled-but-not-yet-expired subscription.
accountRouter.post('/resume-subscription', csrfProtection, async (req, res, next) => {
  try {
    const sub = await getCustomerSubscription(req.session.customerId!);
    if (sub.subscriptionId) await resumeSubscription(req.session.customerId!, sub.subscriptionId);
    res.redirect('/account/billing?resumed=1');
  } catch (err) {
    next(err);
  }
});

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
    // Opening requires an active subscription (free to try, pay to launch).
    if (status === 'open' && subscriptionsEnabled()) {
      const sub = await getCustomerSubscription(req.session.customerId!);
      if (!hasActiveSubscription(sub)) {
        res.redirect('/account/billing?need=1');
        return;
      }
    }
    // Pay-before-launch: opening requires payment unless the election is in the
    // free voter tier (price = 0) or already paid.
    if (status === 'open' && paymentsEnabled() && !election.paid && !quoteElection(election).free) {
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
    const quote = quoteElection(election);
    if (quote.free) {
      // Free tier — nothing to pay; just open it.
      if (election.status === 'draft') await setStatus(election.id, 'open');
      res.redirect(`/account/elections/${election.id}`);
      return;
    }
    const url = await initializePayment({
      electionId: election.id,
      customerId: req.session.customerId!,
      email: req.session.customerEmail!,
      customerName: req.session.customerEmail!,
      amountSubunits: quote.subunits,
      voters: quote.voters,
    });
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

// The gateway returns here after checkout. Verify is authoritative.
//   • Squad — our reference is carried in `?ref=…` (we baked it into the link's
//     redirect URL); Squad appends its own transaction ref alongside it.
//   • Monnify — returns our paymentReference (verify-on-view is the safety net).
accountRouter.get('/pay/callback', async (req, res, next) => {
  try {
    const reference = String(
      req.query.ref || req.query.paymentReference || req.query.reference || req.query.trxref || '',
    );
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
    // Squad payment-link payments use a gateway-generated transaction ref; grab
    // it from the redirect so the authoritative verify can run.
    if (pay.provider === 'squad') {
      const gwRef = String(
        req.query.transaction_ref || req.query.transactionRef || req.query.reference || '',
      );
      if (gwRef && gwRef !== reference) await setProviderReference(reference, gwRef);
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
          subject: `Payment receipt — ${config.APP_NAME}`,
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

accountRouter.post('/elections/:id/options/:optionId', uploadContestantMedia, csrfProtection, async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    const optionId = Number(req.params.optionId);
    const option = await getOptionById(optionId);
    if (!option || option.election_id !== election.id) throw new HttpError(404, 'Contestant not found.');
    const description = String(req.body.description || '').trim().slice(0, 5000);
    const party = String(req.body.party || '').trim().slice(0, 120);
    const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
    const imageFile = files?.image?.[0];
    const flagFile = files?.flag?.[0];
    const rm = (p: string | null) => {
      if (p) fs.promises.unlink(uploadPath(p)).catch(() => undefined);
    };
    await setOptionParty(optionId, party);

    // Photo (and bio).
    if (req.body.removePhoto === '1') {
      rm(await clearOptionImage(optionId));
      await updateOptionContent(optionId, description);
    } else if (imageFile) {
      const old = option.image_path;
      await updateOptionContent(optionId, description, imageFile.filename);
      rm(old);
    } else {
      await updateOptionContent(optionId, description);
    }

    // Party flag (independent of the photo).
    if (req.body.removeFlag === '1') {
      rm(await clearOptionFlag(optionId));
    } else if (flagFile) {
      const oldFlag = option.flag_path;
      await setOptionFlag(optionId, flagFile.filename);
      rm(oldFlag);
    }

    res.redirect(`/account/elections/${election.id}/contestants`);
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/elections/:id/delete', csrfProtection, async (req, res, next) => {
  try {
    const election = await loadOwned(req);
    if (!canDeleteElection(election, allowElectionDelete())) {
      throw new HttpError(403, 'This election has been opened and can no longer be deleted — close it instead.');
    }
    await logAction({ adminId: null, action: 'delete_election_self_service', electionId: null, detail: { title: election.title }, ip: req.ip });
    await deleteElection(election.id);
    res.redirect('/account');
  } catch (err) {
    next(err);
  }
});
