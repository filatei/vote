import { Router } from 'express';
import { csrfProtection, csrfToken } from '../middleware/csrf';
import { loginLimiter } from '../middleware/rateLimit';
import { findAdminByUsername, recordLogin, verifyPassword, logAction } from '../services/admins';
import { loginSchema } from '../util/validate';

export const authRouter = Router();

authRouter.get('/login', csrfToken, (req, res) => {
  if (req.session.adminId) {
    res.redirect('/admin');
    return;
  }
  res.render('admin/login', { title: 'Admin sign in', error: null });
});

authRouter.post('/login', loginLimiter, csrfProtection, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render('admin/login', {
        title: 'Admin sign in',
        error: 'Please enter your username and password.',
      });
      return;
    }
    const { username, password } = parsed.data;
    const admin = await findAdminByUsername(username);
    // Always run a comparison to reduce username-enumeration timing signal.
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
