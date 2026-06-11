import { pool } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { HttpError } from '../middleware/errors';
import { generateUrlToken } from '../util/crypto';

const PAYSTACK_API = 'https://api.paystack.co';

export function paymentsEnabled(): boolean {
  // Requires BOTH a configured secret key AND the master switch, so leaving the
  // keys in place doesn't paywall elections until you explicitly turn it on.
  return Boolean(config.PAYSTACK_SECRET_KEY) && config.PAYMENTS_ENABLED;
}

/** Paystack amounts are in the currency's subunit (kobo / cents). */
export function amountSubunits(): number {
  return Math.round(config.PAYMENT_AMOUNT * 100);
}

export function priceLabel(): string {
  const sym = config.PAYMENT_CURRENCY === 'NGN' ? '₦' : config.PAYMENT_CURRENCY === 'USD' ? '$' : '';
  const amount = config.PAYMENT_AMOUNT.toLocaleString('en-US');
  return sym ? `${sym}${amount}` : `${amount} ${config.PAYMENT_CURRENCY}`;
}

/**
 * Start a Paystack transaction for launching an election. Inserts a pending
 * paystack_payments row and returns the hosted checkout URL.
 */
export async function initializePayment(opts: {
  electionId: number;
  customerId: number;
  email: string;
}): Promise<string> {
  if (!config.PAYSTACK_SECRET_KEY) throw new HttpError(503, 'Payments are not configured.');

  const reference = `vote-${opts.electionId}-${generateUrlToken(8)}`;
  const amount = amountSubunits();
  await pool.query(
    `INSERT INTO paystack_payments
       (reference, election_id, customer_id, email, amount_subunits, currency)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [reference, opts.electionId, opts.customerId, opts.email, amount, config.PAYMENT_CURRENCY],
  );

  const callbackBase = config.PAYSTACK_CALLBACK_URL || config.PUBLIC_BASE_URL;
  const resp = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: opts.email,
      amount,
      currency: config.PAYMENT_CURRENCY,
      reference,
      callback_url: `${callbackBase}/account/pay/callback`,
      metadata: { election_id: opts.electionId, customer_id: opts.customerId },
    }),
  });
  const json = (await resp.json().catch(() => null)) as
    | { status?: boolean; data?: { authorization_url?: string } }
    | null;

  if (!json?.status || !json.data?.authorization_url) {
    await pool.query(`UPDATE paystack_payments SET status='failed' WHERE reference=$1`, [reference]);
    logger.error({ reference, json }, 'Paystack initialize failed');
    throw new HttpError(502, 'Could not start payment. Please try again.');
  }
  return json.data.authorization_url;
}

/**
 * Verify a transaction with Paystack (the authoritative path when the account's
 * single webhook URL belongs to another app). Marks the payment confirmed and
 * the election paid on success. Idempotent.
 */
export async function verifyPayment(
  reference: string,
): Promise<{ ok: boolean; electionId: number | null }> {
  if (!config.PAYSTACK_SECRET_KEY) return { ok: false, electionId: null };

  const { rows } = await pool.query<{
    election_id: string;
    amount_subunits: string;
    currency: string;
    status: string;
  }>(
    `SELECT election_id, amount_subunits, currency, status
       FROM paystack_payments WHERE reference = $1`,
    [reference],
  );
  const pay = rows[0];
  if (!pay) return { ok: false, electionId: null };
  const electionId = Number(pay.election_id);
  if (pay.status === 'confirmed') return { ok: true, electionId };

  const resp = await fetch(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}` },
  });
  const json = (await resp.json().catch(() => null)) as
    | { status?: boolean; data?: { status?: string; amount?: number; currency?: string } }
    | null;
  const data = json?.data;

  const success =
    Boolean(json?.status) &&
    data?.status === 'success' &&
    Number(data?.amount) >= Number(pay.amount_subunits) &&
    data?.currency === pay.currency;

  if (success) {
    await pool.query(
      `UPDATE paystack_payments SET status='confirmed', paystack_status=$2, confirmed_at=now()
        WHERE reference=$1`,
      [reference, data?.status ?? 'success'],
    );
    await pool.query(`UPDATE elections SET paid = TRUE WHERE id = $1`, [electionId]);
    return { ok: true, electionId };
  }

  await pool.query(
    `UPDATE paystack_payments SET status='failed', paystack_status=$2
      WHERE reference=$1 AND status <> 'confirmed'`,
    [reference, data?.status ?? 'failed'],
  );
  return { ok: false, electionId };
}
