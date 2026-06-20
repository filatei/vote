import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';
import { logger } from '../logger';
import { HttpError } from '../middleware/errors';

/**
 * Squad rail (primary NGN provider — GTBank / HabariPay).
 *
 * We use Squad's **Payment Link** API: for each election launch we create a
 * one-off hosted payment link (POST /payment_link/otp) for the exact metered
 * amount, then redirect the organiser to https://pay.squadco.com/<hash>. This
 * keeps the dashboard "products / payment link" experience the merchant set up
 * (support email, phone, T&Cs and return policy all render on the link) while
 * still charging Verita's variable per-voter price.
 *
 * Auth: the secret key is sent as a Bearer token. Amounts are in the LOWEST
 * currency unit (kobo for NGN, cents for USD) — the same subunit we store.
 *
 * Reconciliation is authoritative server-side: the redirect callback and the
 * webhook both end in a GET /transaction/verify/<ref> before we mark an
 * election paid. Webhooks are signed HMAC-SHA512 (uppercase hex) in the
 * `x-squad-encrypted-body` header.
 */

export function squadConfigured(): boolean {
  return Boolean(config.SQUAD_SECRET_KEY);
}

function apiBase(): string {
  return config.SQUAD_BASE_URL.replace(/\/+$/, '');
}

/** Base of the hosted checkout page the link hash is appended to. */
function payBase(): string {
  return config.SQUAD_PAY_BASE_URL.replace(/\/+$/, '');
}

async function squadFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${config.SQUAD_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
}

// ── Create a one-off payment link → hosted checkout URL ────────────────────
export interface CreateLinkParams {
  reference: string; // our unique reference; doubles as the link hash
  amountSubunits: number; // kobo / cents
  currency: string; // NGN | USD
  description: string;
  customerEmail: string;
  redirectUrl: string; // where Squad sends the payer after payment
}

export interface CreateLinkResult {
  checkoutUrl: string;
  hash: string;
}

/**
 * Create a Simple Payment Link for the exact amount. The `hash` is our own
 * reference, so the resulting URL is deterministic: <payBase>/<reference>.
 */
export async function createPaymentLink(p: CreateLinkParams): Promise<CreateLinkResult> {
  // Squad hashes must be URL-safe and <= 255 chars; our reference already is.
  const hash = p.reference;
  const expireBy = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const resp = await squadFetch('/payment_link/otp', {
    method: 'POST',
    body: JSON.stringify({
      name: `${config.APP_NAME} election launch`,
      hash,
      link_status: 1,
      expire_by: expireBy,
      amounts: [{ amount: p.amountSubunits, currency_id: p.currency }],
      description: p.description.slice(0, 250),
      redirect_link: p.redirectUrl,
      return_msg: 'Payment received — your election is launching.',
    }),
  });

  const json = (await resp.json().catch(() => null)) as
    | { success?: boolean; message?: string; data?: { hash?: string } }
    | null;

  if (!resp.ok || json?.success === false || !json?.data?.hash) {
    logger.error({ status: resp.status, json, reference: p.reference }, 'Squad payment-link create failed');
    throw new HttpError(502, 'Could not start payment. Please try again.');
  }

  return { checkoutUrl: `${payBase()}/${json.data.hash}`, hash: json.data.hash };
}

// ── Verify a transaction (authoritative) ───────────────────────────────────
export interface SquadVerify {
  paid: boolean;
  amountSubunits: number; // amount actually paid, in subunits
  currency: string | null;
  raw: string; // provider's transaction_status
}

/**
 * Verify a transaction by Squad's transaction reference. Safe to call from both
 * the redirect callback and the webhook; Squad returns the settled amount in
 * subunits.
 */
export async function verifyTransaction(transactionRef: string): Promise<SquadVerify> {
  const resp = await squadFetch(`/transaction/verify/${encodeURIComponent(transactionRef)}`, {
    method: 'GET',
  });
  const json = (await resp.json().catch(() => null)) as
    | {
        success?: boolean;
        data?: {
          transaction_status?: string;
          transaction_amount?: number | string;
          transaction_currency_id?: string;
          currency?: string;
        };
      }
    | null;

  const data = json?.data;
  const status = String(data?.transaction_status ?? '').toLowerCase();
  return {
    paid: Boolean(json?.success) && status.includes('success'),
    amountSubunits: data?.transaction_amount != null ? Math.round(Number(data.transaction_amount)) : 0,
    currency: data?.transaction_currency_id ?? data?.currency ?? null,
    raw: data?.transaction_status ?? 'unknown',
  };
}

// ── Webhook signature ──────────────────────────────────────────────────────
/**
 * Validate a Squad webhook. The signature is the uppercase hex HMAC-SHA512 of
 * the RAW request body, sent in the `x-squad-encrypted-body` header.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const secret = config.SQUAD_SECRET_KEY;
  if (!secret) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex').toUpperCase();
  const a = Buffer.from(expected);
  const b = Buffer.from((signature || '').toUpperCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SquadWebhookEvent {
  event: string;
  transactionRef: string;
  status: string;
  email: string | null;
  amountSubunits: number;
  currency: string | null;
}

/** Parse the relevant fields out of a (already signature-checked) webhook. */
export function parseWebhook(raw: Buffer): SquadWebhookEvent | null {
  try {
    const evt = JSON.parse(raw.toString('utf8')) as {
      Event?: string;
      TransactionRef?: string;
      Body?: {
        transaction_ref?: string;
        transaction_status?: string;
        email?: string;
        amount?: number | string;
        currency?: string;
      };
    };
    const body = evt.Body || {};
    const transactionRef = body.transaction_ref || evt.TransactionRef || '';
    if (!transactionRef) return null;
    return {
      event: evt.Event || '',
      transactionRef,
      status: String(body.transaction_status ?? '').toLowerCase(),
      email: body.email ?? null,
      amountSubunits: body.amount != null ? Math.round(Number(body.amount)) : 0,
      currency: body.currency ?? null,
    };
  } catch {
    return null;
  }
}
