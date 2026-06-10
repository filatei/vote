import { Router } from 'express';
import { csrfProtection, csrfToken } from '../middleware/csrf';
import { requireAdmin, adminLocals } from '../middleware/auth';
import { HttpError } from '../middleware/errors';
import { config } from '../config';
import {
  createElectionSchema,
  generateCodesSchema,
  toArray,
} from '../util/validate';
import {
  createElection,
  getElectionWithOptions,
  listElections,
  setStatus,
} from '../services/elections';
import { generateCodes, getCodeStats } from '../services/codes';
import { tallyElection } from '../services/tally';
import { getAuditLog, logAction } from '../services/admins';

export const adminRouter = Router();

// Auth gate + expose admin + a CSRF token to every admin template (the header
// sign-out form needs one on every page).
adminRouter.use(requireAdmin, adminLocals, csrfToken);

// Dashboard
adminRouter.get('/', async (_req, res, next) => {
  try {
    const elections = await listElections();
    res.render('admin/dashboard', { title: 'Dashboard', elections });
  } catch (err) {
    next(err);
  }
});

// New election form
adminRouter.get('/elections/new', csrfToken, (_req, res) => {
  res.render('admin/election_new', { title: 'New election', error: null, form: null });
});

adminRouter.post('/elections', csrfProtection, async (req, res, next) => {
  try {
    const payload = {
      title: req.body.title,
      description: req.body.description,
      ballotType: req.body.ballotType,
      maxSelections: req.body.maxSelections,
      resultsVisibility: req.body.resultsVisibility,
      options: toArray(req.body.option).map((s) => s.trim()).filter((s) => s.length > 0),
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
    const id = await createElection({
      ...parsed.data,
      createdBy: req.session.adminId!,
    });
    await logAction({
      adminId: req.session.adminId!,
      action: 'create_election',
      electionId: id,
      detail: { title: parsed.data.title },
      ip: req.ip,
    });
    res.redirect(`/admin/elections/${id}`);
  } catch (err) {
    next(err);
  }
});

// View / manage one election
adminRouter.get('/elections/:id', csrfToken, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const election = await getElectionWithOptions(id);
    if (!election) throw new HttpError(404, 'Election not found.');
    const codeStats = await getCodeStats(id);
    const tally = await tallyElection(id);
    const audit = await getAuditLog(id);
    res.render('admin/election_view', {
      title: election.title,
      election,
      codeStats,
      tally,
      audit,
      baseUrl: config.PUBLIC_BASE_URL,
      generatedCodes: null,
    });
  } catch (err) {
    next(err);
  }
});

// Change status (open/close/draft)
adminRouter.post('/elections/:id/status', csrfProtection, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const status = String(req.body.status);
    if (!['draft', 'open', 'closed'].includes(status)) {
      throw new HttpError(400, 'Invalid status.');
    }
    await setStatus(id, status as 'draft' | 'open' | 'closed');
    await logAction({
      adminId: req.session.adminId!,
      action: `set_status_${status}`,
      electionId: id,
      ip: req.ip,
    });
    res.redirect(`/admin/elections/${id}`);
  } catch (err) {
    next(err);
  }
});

// Generate codes — renders them ONCE for download/copy.
adminRouter.post('/elections/:id/codes', csrfProtection, csrfToken, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const election = await getElectionWithOptions(id);
    if (!election) throw new HttpError(404, 'Election not found.');
    if (election.status === 'closed') {
      throw new HttpError(409, 'Cannot generate codes for a closed election.');
    }
    const parsed = generateCodesSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'Enter a valid number of codes (1–50000).');
    }
    const codes = await generateCodes(id, parsed.data.count);
    await logAction({
      adminId: req.session.adminId!,
      action: 'generate_codes',
      electionId: id,
      detail: { requested: parsed.data.count, created: codes.length },
      ip: req.ip,
    });
    const codeStats = await getCodeStats(id);
    const tally = await tallyElection(id);
    const audit = await getAuditLog(id);
    res.render('admin/election_view', {
      title: election.title,
      election,
      codeStats,
      tally,
      audit,
      baseUrl: config.PUBLIC_BASE_URL,
      generatedCodes: codes,
    });
  } catch (err) {
    next(err);
  }
});

// Download generated codes as CSV (posted back from the one-time display).
adminRouter.post('/elections/:id/codes.csv', csrfProtection, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const election = await getElectionWithOptions(id);
    if (!election) throw new HttpError(404, 'Election not found.');
    const codes = toArray(req.body.code);
    const header = 'voting_code,election_id,vote_url\n';
    const url = `${config.PUBLIC_BASE_URL}/e/${election.public_id}`;
    const body = codes.map((c) => `${c},${election.public_id},${url}`).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="voting-codes-${election.public_id}.csv"`,
    );
    res.send(header + body + '\n');
  } catch (err) {
    next(err);
  }
});
