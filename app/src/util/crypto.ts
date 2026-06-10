import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { config } from '../config';

// Crockford base32-ish alphabet: no I, L, O, U, 1, 0 to avoid confusion when
// codes are read aloud / typed from a printed slip.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomString(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/**
 * Generate a human-friendly, high-entropy voting code formatted in groups.
 * Default: 4 groups of 4 chars = 16 chars over a 30-symbol alphabet
 * ≈ 16 * log2(30) ≈ 78 bits of entropy — infeasible to brute force, especially
 * with rate limiting in front.
 */
export function generateVotingCode(groups = 4, groupLen = 4): string {
  const parts: string[] = [];
  for (let i = 0; i < groups; i++) parts.push(randomString(groupLen));
  return parts.join('-');
}

/** A receipt code voters use to verify their ballot on the public board. */
export function generateReceiptCode(): string {
  return `${randomString(4)}-${randomString(4)}-${randomString(4)}`;
}

/** Normalise user-entered codes: uppercase, strip spaces, unify separators. */
export function normalizeCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^0-9A-Z-]/g, '')
    .replace(/-+/g, '-');
}

/**
 * Keyed hash of a voting code using the server-side pepper. We store only this
 * hash. The pepper means a stolen database alone cannot be used to brute-force
 * codes offline.
 */
export function hashCode(code: string): string {
  return createHmac('sha256', config.CODE_PEPPER).update(normalizeCode(code)).digest('hex');
}

/**
 * Best-effort device fingerprint for open-link elections. A keyed hash of the
 * client IP + user-agent + language. Not foolproof (clearing cookies and
 * switching networks defeats it), but combined with a persistent cookie it
 * stops casual double-voting. Stored only as this hash.
 */
export function deviceFingerprint(parts: {
  ip?: string;
  ua?: string;
  lang?: string;
}): string {
  const raw = `device|${parts.ip ?? ''}|${parts.ua ?? ''}|${parts.lang ?? ''}`;
  return createHmac('sha256', config.CODE_PEPPER).update(raw).digest('hex');
}

/** Constant-time string comparison helper. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
