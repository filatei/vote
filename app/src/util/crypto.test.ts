import assert from 'node:assert';
import { test } from 'node:test';

// CODE_PEPPER etc. must exist for config to load before importing crypto.
process.env.POSTGRES_PASSWORD ||= 'test';
process.env.SESSION_SECRET ||= 'x'.repeat(32);
process.env.CSRF_SECRET ||= 'y'.repeat(32);
process.env.CODE_PEPPER ||= 'z'.repeat(32);

// eslint-disable-next-line @typescript-eslint/no-var-requires
import {
  generateVotingCode,
  hashCode,
  normalizeCode,
  generateReceiptCode,
  deviceFingerprint,
} from './crypto';

test('voting codes are formatted in 4 groups of 4', () => {
  const code = generateVotingCode();
  assert.match(code, /^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
});

test('generated codes are unique across a large sample', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) seen.add(generateVotingCode());
  assert.strictEqual(seen.size, 5000);
});

test('normalizeCode is case- and whitespace-insensitive', () => {
  assert.strictEqual(normalizeCode('  ab2c-def3 '), 'AB2C-DEF3');
  assert.strictEqual(normalizeCode('ab2cdef3'), 'AB2CDEF3');
});

test('hashCode is stable and matches across equivalent inputs', () => {
  const a = hashCode('ab2c-def3');
  const b = hashCode('  AB2C-DEF3 ');
  assert.strictEqual(a, b);
  assert.strictEqual(a.length, 64); // sha256 hex
});

test('receipt codes have the expected shape', () => {
  assert.match(generateReceiptCode(), /^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
});

test('deviceFingerprint is deterministic and sensitive to inputs', () => {
  const a = deviceFingerprint({ ip: '1.2.3.4', ua: 'Mozilla', lang: 'en' });
  const b = deviceFingerprint({ ip: '1.2.3.4', ua: 'Mozilla', lang: 'en' });
  const c = deviceFingerprint({ ip: '5.6.7.8', ua: 'Mozilla', lang: 'en' });
  assert.strictEqual(a, b); // same device -> same hash
  assert.notStrictEqual(a, c); // different IP -> different hash
  assert.strictEqual(a.length, 64); // sha256 hex
});
