import { NextFunction, Request, Response } from 'express';
import { logger } from '../logger';

/** A thrown error carrying an HTTP status and a user-safe message. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).render('error', {
    title: 'Not found',
    status: 404,
    message: 'The page you were looking for does not exist.',
  });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const status = err instanceof HttpError ? err.status : 500;
  const message =
    err instanceof HttpError ? err.message : 'Something went wrong on our end. Please try again.';

  if (status >= 500) {
    logger.error({ err }, 'Request failed');
  }

  // CSRF library throws with this code.
  if ((err as { code?: string }).code === 'EBADCSRFTOKEN') {
    res.status(403).render('error', {
      title: 'Session expired',
      status: 403,
      message: 'Your form session expired or was invalid. Please go back and try again.',
    });
    return;
  }

  res.status(status).render('error', { title: 'Error', status, message });
}
