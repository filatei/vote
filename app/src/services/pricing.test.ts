import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteForVoters } from './pricing';

// Worked examples from the money spec §6 (NGN). Amounts are in subunits (kobo).
test('free tier (1–10 voters) prices to zero', () => {
  const q = quoteForVoters(10);
  assert.equal(q.free, true);
  assert.equal(q.subunits, 0);
  assert.equal(q.perVoterMajor, 0);
});

test('boundary: 11 voters falls into the ₦120 bracket', () => {
  const q = quoteForVoters(11);
  assert.equal(q.perVoterMajor, 120);
  assert.equal(q.subunits, 11 * 120 * 100);
  assert.equal(q.free, false);
});

test('800-member body → ₦72,000 (bracket 501–2,500 @ ₦90)', () => {
  const q = quoteForVoters(800);
  assert.equal(q.perVoterMajor, 90);
  assert.equal(q.subunits, 72_000 * 100);
});

test('8,000-member association → ₦440,000 (bracket @ ₦55)', () => {
  const q = quoteForVoters(8000);
  assert.equal(q.perVoterMajor, 55);
  assert.equal(q.subunits, 440_000 * 100);
});

test('30,000-voter union → ₦1,050,000 (bracket @ ₦35)', () => {
  const q = quoteForVoters(30000);
  assert.equal(q.perVoterMajor, 35);
  assert.equal(q.subunits, 1_050_000 * 100);
});

test('200,000-vote award show → enterprise/custom bracket (~₦22)', () => {
  const q = quoteForVoters(200000);
  assert.equal(q.custom, true);
  assert.equal(q.perVoterMajor, 22);
  assert.equal(q.subunits, 200000 * 22 * 100);
});

test('exact bracket ceilings stay in the lower (cheaper) bracket', () => {
  assert.equal(quoteForVoters(500).perVoterMajor, 120);
  assert.equal(quoteForVoters(2500).perVoterMajor, 90);
  assert.equal(quoteForVoters(10000).perVoterMajor, 55);
  assert.equal(quoteForVoters(50000).perVoterMajor, 35);
});

test('zero / negative voters is a free zero quote', () => {
  assert.equal(quoteForVoters(0).subunits, 0);
  assert.equal(quoteForVoters(-5).subunits, 0);
  assert.equal(quoteForVoters(0).free, true);
});

test('USD rate card prices in cents', () => {
  const q = quoteForVoters(800, 'USD');
  assert.equal(q.currency, 'USD');
  assert.equal(q.perVoterMajor, 0.18);
  assert.equal(q.subunits, Math.round(800 * 0.18 * 100));
});
