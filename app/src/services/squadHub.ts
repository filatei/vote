/**
 * Squad webhook hub — fan-out for a single Squad account shared by several apps
 * (vote, neflo, otuburu, …).
 *
 * Squad permits only ONE webhook URL per account. This app receives that single
 * webhook at /webhooks/squad-hub, verifies the signature once, settles its own
 * payments locally, and forwards everything else to the other apps' regular
 * /webhooks/squad endpoints. Downstream apps share the same Squad secret, so
 * they re-verify the forwarded (untouched) body + signature exactly as if Squad
 * had called them directly — the signature is the auth, no extra shared secret
 * is needed.
 *
 * Kept free of the config/logger graph (both can call process.exit on a bad
 * env) so the routing logic stays unit-testable in isolation.
 */

export interface Downstream {
  name: string;
  url: string;
  prefixes: string[]; // reference prefixes this app owns (may be empty)
}

let cached: Downstream[] | null = null;

/** Parse SQUAD_DOWNSTREAMS from the environment once. */
export function downstreams(): Downstream[] {
  if (cached) return cached;
  cached = parseDownstreams(process.env.SQUAD_DOWNSTREAMS);
  return cached;
}

/** Pure parser (exported for tests). Invalid JSON disables forwarding. */
export function parseDownstreams(raw: string | undefined): Downstream[] {
  if (!raw || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw) as Array<{ name?: string; url?: string; prefix?: string }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((d) => d && typeof d.url === 'string' && d.url)
      .map((d) => ({
        name: d.name || d.url!,
        url: d.url!,
        prefixes: (d.prefix || '')
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      }));
  } catch {
    // eslint-disable-next-line no-console
    console.error('Invalid SQUAD_DOWNSTREAMS JSON — webhook forwarding disabled');
    return [];
  }
}

/**
 * Decide where a webhook should go, given the transaction reference and whether
 * this app already settled it locally.
 *
 *  • settledLocally → []            (it was ours; don't forward)
 *  • a downstream prefix matches    → just that downstream (exact routing)
 *  • no prefix matches anywhere     → every downstream (broadcast; each
 *                                      self-attributes and ignores non-matches)
 */
export function resolveTargets(
  reference: string,
  settledLocally: boolean,
  apps: Downstream[],
): Downstream[] {
  if (settledLocally) return [];
  const ref = reference || '';
  const matched = apps.filter((a) => a.prefixes.some((p) => ref.startsWith(p)));
  if (matched.length) return matched;
  // Nothing claimed it by prefix → broadcast to all (safe + idempotent).
  return apps;
}

/** Forward the original, signature-bearing request to a downstream app. */
export async function forward(target: Downstream, raw: Buffer, signature: string): Promise<void> {
  try {
    const resp = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-squad-encrypted-body': signature,
        'x-forwarded-by': 'squad-hub',
      },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      // eslint-disable-next-line no-console
      console.error(`Squad hub forward to ${target.name} returned ${resp.status}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Squad hub forward to ${target.name} failed`, err);
  }
}
