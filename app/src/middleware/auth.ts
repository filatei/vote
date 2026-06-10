import { NextFunction, Request, Response } from 'express';

// Augment the session type with our admin + customer fields.
declare module 'express-session' {
  interface SessionData {
    adminId?: number;
    adminUsername?: string;
    customerId?: number;
    customerEmail?: string;
    oauthState?: string;
  }
}

/** Gate admin routes behind a valid logged-in admin session. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session && req.session.adminId) {
    next();
    return;
  }
  res.redirect('/admin/login');
}

/** Make the current admin available to all admin templates + set the area. */
export function adminLocals(req: Request, res: Response, next: NextFunction): void {
  res.locals.adminUsername = req.session?.adminUsername ?? null;
  res.locals.basePath = '/admin';
  res.locals.area = 'admin';
  next();
}

/** Gate customer routes behind a valid logged-in customer session. */
export function requireCustomer(req: Request, res: Response, next: NextFunction): void {
  if (req.session && req.session.customerId) {
    next();
    return;
  }
  res.redirect('/account/login');
}

/** Make the current customer available to all account templates + set the area. */
export function customerLocals(req: Request, res: Response, next: NextFunction): void {
  res.locals.customerEmail = req.session?.customerEmail ?? null;
  res.locals.basePath = '/account';
  res.locals.area = 'account';
  next();
}
