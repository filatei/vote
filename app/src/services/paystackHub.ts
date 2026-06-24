/**
 * Paystack webhook hub — fan-out for a single Paystack account shared by several
 * apps (tpay, neflo, otuburu, …).
 *
 * Paystack permits only ONE webhook URL per account. This app receives that
 * single webhook at /webhooks/paystack-hub, verifies the HMAC-SHA512 signature
 * once, then forwards each event to the owning app's regular Paystack webhook
 * (configured via PAYSTACK_DOWNSTREAMS). Downstream apps share the same Paystack
 * secret, so they re-verify the forwarded (untouched) body + signature exactly
 * as if Paystack had called them directly.
 *
 * Reuses the Downstream type + routing logic from the Squad hub; only the
 * signature header (x-paystack-signature) and the env var differ.
 */

import { type Downstream, parseDownstreams, resolveTargets } from './squadHub';

export { type Downstream, resolveTargets };

let cached: Downstream[] | null = null;

/** Parse PAYSTACK_DOWNSTREAMS from the environment once. */
export function paystackDownstreams(): Downstream[] {
  if (cached) return cached;
  cached = parseDownstreams(process.env.PAYSTACK_DOWNSTREAMS);
  return cached;
}

/** Forward the original, signature-bearing request to a downstream app. */
export async function forwardPaystack(
  target: Downstream,
  raw: Buffer,
  signature: string,
): Promise<void> {
  try {
    const resp = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': signature,
        'x-forwarded-by': 'paystack-hub',
      },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      // eslint-disable-next-line no-console
      console.error(`Paystack hub forward to ${target.name} returned ${resp.status}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Paystack hub forward to ${target.name} failed`, err);
  }
}
