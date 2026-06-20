import { pool } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { sendMail } from '../mailer';
import { HttpError } from '../middleware/errors';
import { generateUrlToken } from '../util/crypto';
import { Election } from './types';
import { quoteForVoters, Quote } from './pricing';
import { monnifyConfigured, initTransaction, getTransactionStatus } from './monnify';
import { squadConfigured, createPaymentLink, verifyTransaction } from './squad';
import { getBoolSetting } from './settings';

export type Provider = 'squad' | 'monnify';

/**
 * The rail to use: the configured preference (Squad primary) when available,
 * otherwise the other rail as an automatic fallback. Returns null when neither
 * is configured.
 */
export function activeProvider(): Provider | null {
  const prefer = config.PAYMENT_PROVIDER;
  if (prefer === 'monnify') {
    if (monnifyConfigured()) return 'monnify';
    if (squadConfigured()) return 'squad';
  } else {
    if (squadConfigured()) return 'squad';
    if (monnifyConfigured()) return 'monnify';
  }
  return null;
}

/**
 * Admin runtime switch for monetisation ("MONETISE"). Defaults to the .env
 * value (PAYMENTS_ENABLED) until an admin flips it from /admin. This is the
 * pay-before-open model: creating an election is always free; opening one
 * requires paying the per-voter launch fee (unless it's in the free tier).
 */
export function paymentsToggledOn(): boolean {
  return getBoolSetting('payments_enabled', config.PAYMENTS_ENABLED);
}

/** True when monetisation is ON *and* a payment rail is actually configured. */
export function paymentsEnabled(): boolean {
  return paymentsToggledOn() && activeProvider() !== null;
}

/** Whether any payment rail (Squad/Monnify) has credentials configured. */
export function paymentProviderConfigured(): boolean {
  return activeProvider() !== null;
}

// ── Per-voter metering ──────────────────────────────────────────────────────
/** Quote an election's launch price from its enrolled-voter count. */
export function quoteElection(election: Pick<Election, 'enrolled_voters'>): Quote {
  return quoteForVoters(election.enrolled_voters, config.PAYMENT_CURRENCY);
}

/** Human label for an election's launch price (e.g. "₦72,000"). */
export function priceLabelForElection(election: Pick<Election, 'enrolled_voters'>): string {
  return formatAmount(quoteElection(election).subunits, config.PAYMENT_CURRENCY);
}

/** Format a subunit amount + currency for display (₦100,000 / $25.00). */
export function formatAmount(subunits: number, currency: string): string {
  const sym = currency === 'NGN' ? '₦' : currency === 'USD' ? '$' : '';
  const major = subunits / 100;
  const amount = major.toLocaleString('en-US', {
    minimumFractionDigits: currency === 'NGN' ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return sym ? `${sym}${amount}` : `${amount} ${currency}`;
}

export interface PaymentRow {
  reference: string;
  electionId: number;
  customerId: number | null;
  email: string;
  amountSubunits: number;
  currency: string;
  status: string;
  provider: Provider;
  providerReference: string | null;
}

export async function getPaymentByReference(reference: string): Promise<PaymentRow | null> {
  const { rows } = await pool.query(
    `SELECT reference, election_id, customer_id, email, amount_subunits, currency, status,
            provider, provider_reference
       FROM paystack_payments WHERE reference = $1`,
    [reference],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    reference: r.reference,
    electionId: Number(r.election_id),
    customerId: r.customer_id == null ? null : Number(r.customer_id),
    email: r.email,
    amountSubunits: Number(r.amount_subunits),
    currency: r.currency,
    status: r.status,
    provider: (r.provider as Provider) || 'squad',
    providerReference: r.provider_reference ?? null,
  };
}

/** Admin reconciliation: recent payments with election title. */
export async function listPayments(limit = 200): Promise<
  Array<{
    reference: string;
    email: string;
    amount_subunits: number;
    currency: string;
    status: string;
    provider: string;
    created_at: Date;
    confirmed_at: Date | null;
    election_title: string | null;
  }>
> {
  const { rows } = await pool.query(
    `SELECT p.reference, p.email, p.amount_subunits, p.currency, p.status, p.provider,
            p.created_at, p.confirmed_at, e.title AS election_title
       FROM paystack_payments p
       LEFT JOIN elections e ON e.id = p.election_id
      ORDER BY p.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ ...r, amount_subunits: Number(r.amount_subunits) }));
}

// ── Verify-on-view reconciliation ───────────────────────────────────────────
// Monnify (like Paystack) allows only one webhook URL per account, and that
// webhook lives on another torama.money app (otuburu). So we don't rely on the
// webhook here: the redirect callback verifies authoritatively, and this is the
// safety net for when a payer closes the checkout tab before redirecting back —
// any time the organiser reloads their election page we re-check a pending
// payment with the provider.

/** Most recent not-yet-settled payment reference for an election, if any. */
export async function latestPendingReference(electionId: number): Promise<string | null> {
  const { rows } = await pool.query<{ reference: string }>(
    `SELECT reference FROM paystack_payments
       WHERE election_id = $1 AND status IN ('pending','processing')
       ORDER BY created_at DESC LIMIT 1`,
    [electionId],
  );
  return rows[0]?.reference ?? null;
}

/**
 * Re-verify any pending payment for an election with its provider. Returns true
 * if the election is now paid. No-ops (false) when there's nothing pending.
 */
export async function reconcilePendingPayment(electionId: number): Promise<boolean> {
  const ref = await latestPendingReference(electionId);
  if (!ref) return false;
  const res = await verifyPayment(ref);
  return res.ok;
}

// ── Initialise a launch payment ─────────────────────────────────────────────
export interface InitPaymentOpts {
  electionId: number;
  customerId: number;
  email: string;
  customerName?: string;
  amountSubunits: number; // metered amount (kobo/cents)
  voters: number; // billed voter count, for reconciliation
  description?: string;
}

/**
 * Start a payment for launching an election. Inserts a pending payments row and
 * returns the hosted checkout URL. Routes to the active provider (Squad
 * primary, Monnify fallback).
 */
export async function initializePayment(opts: InitPaymentOpts): Promise<string> {
  const provider = activeProvider();
  if (!provider) throw new HttpError(503, 'Payments are not configured.');
  if (opts.amountSubunits <= 0) {
    throw new HttpError(400, 'This election is in the free tier — no payment is required.');
  }

  const reference = `vote-${opts.electionId}-${generateUrlToken(8)}`;
  const currency = config.PAYMENT_CURRENCY;
  const callbackBase = config.PAYMENT_CALLBACK_URL || config.PUBLIC_BASE_URL;
  const callbackUrl = `${callbackBase}/account/pay/callback`;
  const description = opts.description || `Election launch — ${opts.voters} voters`;

  await pool.query(
    `INSERT INTO paystack_payments
       (reference, election_id, customer_id, email, amount_subunits, currency, provider, voters)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [reference, opts.electionId, opts.customerId, opts.email, opts.amountSubunits, currency, provider, opts.voters],
  );

  try {
    if (provider === 'monnify') {
      const init = await initTransaction({
        amountMajor: opts.amountSubunits / 100, // Monnify charges in naira
        currency,
        customerName: opts.customerName || opts.email,
        customerEmail: opts.email,
        paymentReference: reference,
        paymentDescription: description,
        redirectUrl: callbackUrl,
      });
      await pool.query(
        `UPDATE paystack_payments SET provider_reference = $2 WHERE reference = $1`,
        [reference, init.transactionReference],
      );
      return init.checkoutUrl;
    }
    // Squad: create a one-off hosted payment link for the exact amount. We carry
    // our own reference back through the redirect (?ref=…) since the link
    // payment's transaction ref is generated by Squad.
    const link = await createPaymentLink({
      reference,
      amountSubunits: opts.amountSubunits,
      currency,
      description,
      customerEmail: opts.email,
      redirectUrl: `${callbackUrl}?ref=${encodeURIComponent(reference)}`,
    });
    return link.checkoutUrl;
  } catch (err) {
    await pool.query(`UPDATE paystack_payments SET status='failed' WHERE reference=$1`, [reference]);
    throw err;
  }
}

// ── Verify (authoritative) ──────────────────────────────────────────────────
/**
 * Verify a transaction with its provider. Marks the payment confirmed and the
 * election paid on success. Idempotent.
 */
export async function verifyPayment(
  reference: string,
): Promise<{ ok: boolean; electionId: number | null; newlyConfirmed: boolean }> {
  const pay = await getPaymentByReference(reference);
  if (!pay) return { ok: false, electionId: null, newlyConfirmed: false };
  const electionId = pay.electionId;
  if (pay.status === 'confirmed') return { ok: true, electionId, newlyConfirmed: false };

  const success =
    pay.provider === 'monnify'
      ? await verifyMonnify(pay)
      : await verifySquad(pay);

  if (success.ok) {
    // Guard the flip with `status <> 'confirmed'` so concurrent callers (redirect
    // callback + webhook) can't both "newly confirm" — only the row that flips
    // it gets newlyConfirmed=true, which gates the one-time receipt email.
    const upd = await pool.query(
      `UPDATE paystack_payments SET status='confirmed', paystack_status=$2, confirmed_at=now()
        WHERE reference=$1 AND status <> 'confirmed'`,
      [reference, success.raw],
    );
    await pool.query(`UPDATE elections SET paid = TRUE WHERE id = $1`, [electionId]);
    return { ok: true, electionId, newlyConfirmed: (upd.rowCount ?? 0) > 0 };
  }

  await pool.query(
    `UPDATE paystack_payments SET status='failed', paystack_status=$2
      WHERE reference=$1 AND status <> 'confirmed'`,
    [reference, success.raw],
  );
  return { ok: false, electionId, newlyConfirmed: false };
}

/**
 * Send the launch payment receipt email (once). Loads the payment + election
 * title directly to avoid an import cycle with the elections service. Called by
 * both the redirect callback and the webhook path, but only when a payment was
 * *newly* confirmed, so the payer gets exactly one receipt.
 */
export async function sendLaunchReceipt(reference: string): Promise<void> {
  const pay = await getPaymentByReference(reference);
  if (!pay) return;
  const { rows } = await pool.query<{ title: string }>(
    `SELECT title FROM elections WHERE id = $1`,
    [pay.electionId],
  );
  const title = rows[0]?.title ?? '—';
  const amt = formatAmount(pay.amountSubunits, pay.currency);
  await sendMail({
    to: pay.email,
    subject: `Payment receipt — ${config.APP_NAME}`,
    text:
      `Thank you. Your payment has been received.\n\n` +
      `Election: ${title}\n` +
      `Amount: ${amt}\n` +
      `Reference: ${pay.reference}\n` +
      `Date: ${new Date().toISOString().slice(0, 10)}\n\n` +
      `Your election is now open. Manage it at ${config.PUBLIC_BASE_URL}/account/elections/${pay.electionId}`,
  });
}

async function verifyMonnify(pay: PaymentRow): Promise<{ ok: boolean; raw: string }> {
  if (!pay.providerReference) return { ok: false, raw: 'missing_reference' };
  try {
    const status = await getTransactionStatus(pay.providerReference);
    const ok =
      status.paid &&
      Math.round(status.amountPaidMajor * 100) >= pay.amountSubunits &&
      (status.currency == null || status.currency === pay.currency);
    return { ok, raw: status.raw };
  } catch (err) {
    logger.error({ err, reference: pay.reference }, 'Monnify verify failed');
    return { ok: false, raw: 'error' };
  }
}

async function verifySquad(pay: PaymentRow): Promise<{ ok: boolean; raw: string }> {
  // The payment-link transaction ref is generated by Squad and learned from the
  // redirect callback or the webhook; without it we can't verify yet.
  if (!pay.providerReference) return { ok: false, raw: 'awaiting_reference' };
  try {
    const v = await verifyTransaction(pay.providerReference);
    const ok =
      v.paid &&
      v.amountSubunits >= pay.amountSubunits &&
      (v.currency == null || v.currency === pay.currency);
    return { ok, raw: v.raw };
  } catch (err) {
    logger.error({ err, reference: pay.reference }, 'Squad verify failed');
    return { ok: false, raw: 'error' };
  }
}

/** Record the gateway's own transaction reference against our payment row. */
export async function setProviderReference(reference: string, providerRef: string): Promise<void> {
  await pool.query(
    `UPDATE paystack_payments SET provider_reference = $2
       WHERE reference = $1 AND provider_reference IS NULL`,
    [reference, providerRef],
  );
}

/**
 * Reconcile a Squad webhook to a pending payment. The link-payment webhook
 * carries Squad's transaction ref + the payer's email + amount but NOT our
 * reference, so we match the most recent pending Squad payment by email +
 * amount, attach the gateway ref, then verify authoritatively. Returns the
 * matched reference + election id + whether this call newly confirmed it.
 */
export async function reconcileSquadWebhook(opts: {
  transactionRef: string;
  email: string | null;
  amountSubunits: number;
}): Promise<{ reference: string; electionId: number; newlyConfirmed: boolean } | null> {
  const { rows } = await pool.query<{ reference: string }>(
    `SELECT reference FROM paystack_payments
       WHERE provider = 'squad'
         AND status IN ('pending','processing')
         AND ($1::text IS NULL OR lower(email) = lower($1))
         AND ($2::bigint = 0 OR amount_subunits <= $2)
       ORDER BY created_at DESC LIMIT 1`,
    [opts.email, opts.amountSubunits],
  );
  const ref = rows[0]?.reference;
  if (!ref) return null;
  await setProviderReference(ref, opts.transactionRef);
  const res = await verifyPayment(ref);
  if (!res.ok || res.electionId == null) return null;
  return { reference: ref, electionId: res.electionId, newlyConfirmed: res.newlyConfirmed };
}
