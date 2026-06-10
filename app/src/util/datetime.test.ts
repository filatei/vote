import assert from 'node:assert';
import { test } from 'node:test';

import { watInputToUtc, formatWat, toWatInput } from './datetime';

test('watInputToUtc treats input as WAT (UTC+1)', () => {
  // 09:00 WAT == 08:00 UTC
  const d = watInputToUtc('2026-06-15T09:00');
  assert.ok(d);
  assert.strictEqual(d!.toISOString(), '2026-06-15T08:00:00.000Z');
});

test('watInputToUtc returns null for empty/garbage', () => {
  assert.strictEqual(watInputToUtc(''), null);
  assert.strictEqual(watInputToUtc('not-a-date'), null);
  assert.strictEqual(watInputToUtc(null), null);
});

test('formatWat renders a UTC instant in WAT', () => {
  assert.strictEqual(formatWat(new Date('2026-06-15T08:00:00Z')), '2026-06-15 09:00 WAT');
});

test('toWatInput round-trips with watInputToUtc', () => {
  const original = '2026-12-31T23:30';
  const utc = watInputToUtc(original);
  assert.ok(utc);
  assert.strictEqual(toWatInput(utc), original);
});

test('midnight WAT maps to previous-day 23:00 UTC', () => {
  const d = watInputToUtc('2026-06-15T00:00');
  assert.strictEqual(d!.toISOString(), '2026-06-14T23:00:00.000Z');
});
