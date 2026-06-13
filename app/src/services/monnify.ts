import { config } from '../config';
import { logger } from '../logger';
import { HttpError } from '../middleware/errors';

/**
 * Monnify rail (primary NGN provider). Mirrors the sandbox integration proven
 * on otuburu. Monnify charges in MAJOR units (naira) — unlike Paystack which
 * uses kobo — so callers convert subunits → naira before initialising.
 *
 * Auth: POST /api/v1/auth/login with HTTP Basic apiKey:secretKey → a bearer
 * access token (cached in-memory until shortly before it expires).
 */

export function monnifyConfigured(): boolean {
  return Boolean(
    config.MONNIFY_API_KEY && config.MONNIFY_SECRET_KEY && config.MONNIFY_CONTRACT_CODE,
  );
}

function baseUrl(): string {
  return config.MONNIFY_BASE_URL.replace(/\/+$/, '');
}

interface MonnifyEnvelope<T> {
  requestSuccessful?: boolean;
  responseMessage?: string;
  responseCode?: string;
  responseBody?: T;
}

// ── Access-token cache ────────────────────────────────────────────────────
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token;

  const basic = Buffer.from(
    `${config.MONNIFY_API_KEY}:${config.MONNIFY_SECRET_KEY}`,
  ).toString('base64');

  const resp = await fetch(`${baseUrl()}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
  });
  const json = (await resp.json().catch(() => null)) as MonnifyEnvelope<{
    accessToken?: string;
    expiresIn?: number;
  }> | null;

  const token = json?.responseBody?.accessToken;
  if (!json?.requestSuccessful || !token) {
    logger.error({ status: resp.status, json }, 'Monnify auth failed');
    throw new HttpError(502, 'Could not authenticate with the payment provider.');
  }
  const expiresInSec = Number(json.responseBody?.expiresIn) || 3000;
  cachedToken = { token, expiresAt: now + expiresInSec * 1000 };
  return token;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

// ── Initialise transaction → hosted checkout URL ───────────────────────────
export interface InitResult {
  checkoutUrl: string;
  transactionReference: string;
  paymentReference: string;
}

export async function initTransaction(opts: {
  amountMajor: number; // naira
  currency: string;
  customerName: string;
  customerEmail: string;
  paymentReference: string; // our own reference (echoed back on the webhook)
  paymentDescription: string;
  redirectUrl: string;
}): Promise<InitResult> {
  const resp = await authedFetch('/api/v1/merchant/transactions/init-transaction', {
    method: 'POST',
    body: JSON.stringify({
      amount: opts.amountMajor,
      customerName: opts.customerName,
      customerEmail: opts.customerEmail,
      paymentReference: opts.paymentReference,
      paymentDescription: opts.paymentDescription,
      currencyCode: opts.currency,
      contractCode: config.MONNIFY_CONTRACT_CODE,
      redirectUrl: opts.redirectUrl,
      paymentMethods: ['CARD', 'ACCOUNT_TRANSFER', 'USSD'],
    }),
  });
  const json = (await resp.json().catch(() => null)) as MonnifyEnvelope<{
    checkoutUrl?: string;
    transactionReference?: string;
    paymentReference?: string;
  }> | null;

  const body = json?.responseBody;
  if (!json?.requestSuccessful || !body?.checkoutUrl || !body.transactionReference) {
    logger.error({ status: resp.status, json }, 'Monnify init-transaction failed');
    throw new HttpError(502, 'Could not start payment. Please try again.');
  }
  return {
    checkoutUrl: body.checkoutUrl,
    transactionReference: body.transactionReference,
    paymentReference: body.paymentReference || opts.paymentReference,
  };
}

// ── Verify (authoritative) ─────────────────────────────────────────────────
export interface TxStatus {
  paid: boolean;
  amountPaidMajor: number; // naira actually paid
  currency: string | null;
  raw: string; // provider's paymentStatus
}

/**
 * Query a transaction's status by Monnify's transactionReference. Confirms a
 * PAID status before we mark the election launched. Idempotent and safe to call
 * from both the redirect callback and the webhook.
 */
export async function getTransactionStatus(transactionReference: string): Promise<TxStatus> {
  const resp = await authedFetch(
    `/api/v2/transactions/${encodeURIComponent(transactionReference)}`,
    { method: 'GET' },
  );
  const json = (await resp.json().catch(() => null)) as MonnifyEnvelope<{
    paymentStatus?: string;
    amountPaid?: number;
    currencyCode?: string;
    currency?: string;
  }> | null;

  const body = json?.responseBody;
  const status = body?.paymentStatus ?? 'UNKNOWN';
  return {
    paid: Boolean(json?.requestSuccessful) && status === 'PAID',
    amountPaidMajor: Number(body?.amountPaid) || 0,
    currency: body?.currencyCode ?? body?.currency ?? null,
    raw: status,
  };
}
