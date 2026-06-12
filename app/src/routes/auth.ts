import { Router } from 'express';
import { csrfProtection, csrfToken } from '../middleware/csrf';
import { HttpError } from '../middleware/errors';
import { loginLimiter } from '../middleware/rateLimit';
import {
  findAdminByUsername,
  recordLogin,
  verifyPassword,
  logAction,
  upsertGoogleAdmin,
} from '../services/admins';
import {
  adminRedirectUri,
  allowedAdminEmails,
  buildAuthUrl,
  exchangeCode,
  googleEnabled,
} from '../services/googleAuth';
import { generateUrlToken } from '../util/crypto';
import { loginSchema } from '../util/validate';

export const authRouter = Router();

authRouter.get('/login', csrfToken, (req, res) => {
  if (req.session.adminId) {
    res.redirect('/admin');
    return;
  }
  res.render('admin/login', { title: 'Admin sign in', error: null, googleEnabled: googleEnabled() });
});

// ── Google Sign-In (when configured) ────────────────────────────────────────
authRouter.get('/auth/google', (req, res, next) => {
  if (!googleEnabled()) return next(new HttpError(404, 'Not found.'));
  const state = generateUrlToken(16);
  req.session.oauthState = state;
  res.redirect(buildAuthUrl(state, adminRedirectUri()));
});

authRouter.get('/auth/google/callback', async (req, res, next) => {
  try {
    if (!googleEnabled()) return next(new HttpError(404, 'Not found.'));

    const renderError = (msg: string) =>
      res.status(403).render('admin/login', { title: 'Admin sign in', error: msg, googleEnabled: true });

    if (req.query.error) return renderError('Google sign-in was cancelled.');

    const state = String(req.query.state || '');
    if (!state || state !== req.session.oauthState) {
      return renderError('Sign-in session expired or was invalid. Please try again.');
    }
    delete req.session.oauthState;

    const code = String(req.query.code || '');
    const identity = code ? await exchangeCode(code, adminRedirectUri()) : null;
    if (!identity || !identity.emailVerified) {
      return renderError('Could not verify your Google account. Please try again.');
    }
    if (!allowedAdminEmails().includes(identity.email)) {
      return renderError('That Google account is not authorised to access the admin area.');
    }

    const adminId = await upsertGoogleAdmin(identity.email);
    req.session.regenerate(async (err) => {
      if (err) return next(err);
      req.session.adminId = adminId;
      req.session.adminUsername = identity.email;
      await recordLogin(adminId);
      await logAction({ adminId, action: 'login_google', ip: req.ip });
      res.redirect('/admin');
    });
  } catch (err) {
    next(err);
  }
});

// ── Password login (fallback only when Google is NOT configured) ────────────
authRouter.post('/login', loginLimiter, csrfProtection, async (req, res, next) => {
  try {
    if (googleEnabled()) {
      res.status(403).render('admin/login', {
        title: 'Admin sign in',
        error: 'Password login is disabled. Please sign in with Google.',
        googleEnabled: true,
      });
      return;
    }
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render('admin/login', {
        title: 'Admin sign in',
        error: 'Please enter your username and password.',
        googleEnabled: false,
      });
      return;
    }
    const { username, password } = parsed.data;
    const admin = await findAdminByUsername(username);
    const ok = admin
      ? await verifyPassword(admin, password)
      : await verifyPassword(
          { password_hash: '$2a$12$0000000000000000000000000000000000000000000000000000' } as any,
          password,
        );
    if (!admin || !ok) {
      res.status(401).render('admin/login', {
        title: 'Admin sign in',
        error: 'Invalid username or password.',
        googleEnabled: false,
      });
      return;
    }
    req.session.regenerate(async (err) => {
      if (err) return next(err);
      req.session.adminId = admin.id;
      req.session.adminUsername = admin.username;
      await recordLogin(admin.id);
      await logAction({ adminId: admin.id, action: 'login', ip: req.ip });
      res.redirect('/admin');
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', csrfProtection, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});
