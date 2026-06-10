import { doubleCsrf } from 'csrf-csrf';
import { config } from '../config';

const { doubleCsrfProtection, generateToken } = doubleCsrf({
  getSecret: () => config.CSRF_SECRET,
  cookieName: config.isProd ? '__Host-vote.x-csrf' : 'vote.x-csrf',
  cookieOptions: {
    sameSite: 'lax',
    path: '/',
    secure: config.isProd,
  },
  size: 64,
  getTokenFromRequest: (req) => (req.body && req.body._csrf) || req.headers['x-csrf-token'],
});

export const csrfProtection = doubleCsrfProtection;

/** Expose a fresh token to templates as res.locals.csrfToken. */
export function csrfToken(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  res.locals.csrfToken = generateToken(req, res);
  next();
}
