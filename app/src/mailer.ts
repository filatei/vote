import nodemailer, { Transporter } from 'nodemailer';
import { config } from './config';
import { logger } from './logger';

export type MailMode = 'smtp' | 'log';

let transporter: Transporter | null = null;
let mode: MailMode = 'log';

if (config.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE, // true for 465; false uses STARTTLS on 587
    requireTLS: !config.SMTP_SECURE, // force STARTTLS on 587 (Google relay needs TLS)
    // EHLO/HELO hostname presented to the relay. Without this, nodemailer greets
    // as the container hostname (e.g. "76dca7848163"), which Google's relay
    // rejects/throttles with "421-4.7.0 Try again later (EHLO)". Use a real FQDN.
    name: config.SMTP_EHLO_NAME,
    // Reuse a single connection instead of opening a new one per email — rapid
    // new connections are what trip the relay's rate limiting.
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    auth:
      config.SMTP_USER && config.SMTP_PASS
        ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
        : undefined, // omit for IP-authorised Google Workspace relay
  });
  mode = 'smtp';
} else {
  // No SMTP configured: log emails instead of sending (dev / pre-SMTP).
  logger.warn('No SMTP_HOST configured — emails will be logged, not sent.');
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Send a transactional email (or log it in "log" mode). */
export async function sendMail(msg: MailMessage): Promise<{ mode: MailMode }> {
  if (!transporter) {
    logger.info(
      { to: msg.to, subject: msg.subject, body: msg.text },
      'EMAIL (log mode — not actually sent)',
    );
    return { mode: 'log' };
  }
  await transporter.sendMail({
    from: config.MAIL_FROM,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
  return { mode: 'smtp' };
}

export function mailMode(): MailMode {
  return mode;
}

/** Describe the active mail configuration for the admin UI. */
export function mailStatus(): { mode: MailMode; host: string | null; from: string; auth: boolean } {
  return {
    mode,
    host: config.SMTP_HOST ?? null,
    from: config.MAIL_FROM,
    auth: Boolean(config.SMTP_USER && config.SMTP_PASS),
  };
}

/** Verify the SMTP connection/handshake (admin-triggered). */
export async function verifyMailer(): Promise<{ ok: boolean; error?: string }> {
  if (!transporter) return { ok: false, error: 'No SMTP configured (log mode).' };
  try {
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
