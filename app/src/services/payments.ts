import { pool } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { HttpError } from '../middleware/errors';
import { generateUrlToken } from '../util/crypto';
import { Election } from './types';
import { quoteForVoters, Quote } from './pricing';
import { monnifyConfigured, initTransaction, getTransactionStatus } from './monnify';

const PAYSTACK_API = 'https://api.paystack.co';

export type Provider = 'monnify' | 'paystack';

function paystackConfigured(): boolean {
  return Boolean(config.PAYSTACK_SECRET_KEY);
}

/**
 * The rail to use: the configured preference (Monnify primary) when available,
 * otherwise the other rail as an automatic fallback. Returns null when neither
 * is configured.
 */
export function activeProvider(): Provider | null {
  const prefer = config.PAYMENT_PROVIDER;
  if (prefer === 'monnify') {
    if (monnifyConfigured()) return 'monnify';
    if (paystackConfigured()) return 'paystack';
  } else {
    if (paystackConfigured()) return 'paystack';
    if (monnifyConfigured()) return 'monnify';
  }
  return null;
}

export function paymentsEnabled(): boolean {
  // Requires the master switch AND at least one configured rail, so leaving keys
  // in place doesn't paywall elections until you explicitly turn it on.
  return config.PAYMENTS_ENABLED && activeProvider() !== null;
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
    provider: (r.provider as Provider) || 'paystack',
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
 * returns the hosted checkout URL. Routes to the active provider (Monnify
 * primary, Paystack fallback).
 */
export async function initializePayment(opts: InitPaymentOpts): Promise<string> {
  const provider = activeProvider();
  if (!provider) throw new HttpError(503, 'Payments are not configured.');
  if (opts.amountSubunits <= 0) {
    throw new HttpError(400, 'This election is in the free tier — no payment is required.');
  }

  const reference = `vote-${opts.electionId}-${generateUrlToken(8)}`;
  const currency = config.PAYMENT_CURRENCY;
  const callbackBase = config.PAYMENT_CALLBACK_URL || config.PAYSTACK_CALLBACK_URL || config.PUBLIC_BASE_URL;
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
    return await initializePaystack({ reference, amount: opts.amountSubunits, currency, email: opts.email, callbackUrl, electionId: opts.electionId, customerId: opts.customerId });
  } catch (err) {
    await pool.query(`UPDATE paystack_payments SET status='failed' WHERE reference=$1`, [reference]);
    throw err;
  }
}

async function initializePaystack(opts: {
  reference: string;
  amount: number;
  currency: string;
  email: string;
  callbackUrl: string;
  electionId: number;
  customerId: number;
}): Promise<string> {
  const resp = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: opts.email,
      amount: opts.amount,
      currency: opts.currency,
      reference: opts.reference,
      callback_url: opts.callbackUrl,
      metadata: { election_id: opts.electionId, customer_id: opts.customerId },
    }),
  });
  const json = (await resp.json().catch(() => null)) as
    | { status?: boolean; data?: { authorization_url?: string } }
    | null;
  if (!json?.status || !json.data?.authorization_url) {
    logger.error({ reference: opts.reference, json }, 'Paystack initialize failed');
    throw new HttpError(502, 'Could not start payment. Please try again.');
  }
  return json.data.authorization_url;
}

// ── Verify (authoritative) ──────────────────────────────────────────────────
/**
 * Verify a transaction with its provider. Marks the payment confirmed and the
 * election paid on success. Idempotent.
 */
export async function verifyPayment(
  reference: string,
): Promise<{ ok: boolean; electionId: number | null }> {
  const pay = await getPaymentByReference(reference);
  if (!pay) return { ok: false, electionId: null };
  const electionId = pay.electionId;
  if (pay.status === 'confirmed') return { ok: true, electionId };

  const success =
    pay.provider === 'monnify'
      ? await verifyMonnify(pay)
      : await verifyPaystack(pay);

  if (success.ok) {
    await pool.query(
      `UPDATE paystack_payments SET status='confirmed', paystack_status=$2, confirmed_at=now()
        WHERE reference=$1`,
      [reference, success.raw],
    );
    await pool.query(`UPDATE elections SET paid = TRUE WHERE id = $1`, [electionId]);
    return { ok: true, electionId };
  }

  await pool.query(
    `UPDATE paystack_payments SET status='failed', paystack_status=$2
      WHERE reference=$1 AND status <> 'confirmed'`,
    [reference, success.raw],
  );
  return { ok: false, electionId };
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

async function verifyPaystack(pay: PaymentRow): Promise<{ ok: boolean; raw: string }> {
  if (!config.PAYSTACK_SECRET_KEY) return { ok: false, raw: 'unconfigured' };
  const resp = await fetch(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(pay.reference)}`, {
    headers: { Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}` },
  });
  const json = (await resp.json().catch(() => null)) as
    | { status?: boolean; data?: { status?: string; amount?: number; currency?: string } }
    | null;
  const data = json?.data;
  const ok =
    Boolean(json?.status) &&
    data?.status === 'success' &&
    Number(data?.amount) >= pay.amountSubunits &&
    data?.currency === pay.currency;
  return { ok, raw: data?.status ?? 'failed' };
}
