import { NextFunction, Request, Response } from 'express';

// Augment the session type with our admin fields.
declare module 'express-session' {
  interface SessionData {
    adminId?: number;
    adminUsername?: string;
  }
}

/** Gate admin routes behind a valid logged-in session. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session && req.session.adminId) {
    next();
    return;
  }
  res.redirect('/admin/login');
}

/** Make the current admin available to all admin templates. */
export function adminLocals(req: Request, res: Response, next: NextFunction): void {
  res.locals.adminUsername = req.session?.adminUsername ?? null;
  next();
}
