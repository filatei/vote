import assert from 'node:assert';
import { test } from 'node:test';

process.env.POSTGRES_PASSWORD ||= 'test';
process.env.SESSION_SECRET ||= 'x'.repeat(32);
process.env.CSRF_SECRET ||= 'y'.repeat(32);
process.env.CODE_PEPPER ||= 'z'.repeat(32);

import { validateSelection } from './ballots';

const options = [{ id: 1 }, { id: 2 }, { id: 3 }];

test('single-choice accepts exactly one valid option', () => {
  assert.deepStrictEqual(validateSelection({ ballot_type: 'single', max_selections: 1 }, options, [2]), [2]);
});

test('single-choice rejects multiple selections', () => {
  assert.throws(
    () => validateSelection({ ballot_type: 'single', max_selections: 1 }, options, [1, 2]),
    /exactly one/,
  );
});

test('rejects empty selection', () => {
  assert.throws(
    () => validateSelection({ ballot_type: 'single', max_selections: 1 }, options, []),
    /at least one/,
  );
});

test('rejects an option that is not on the ballot', () => {
  assert.throws(
    () => validateSelection({ ballot_type: 'multiple', max_selections: 3 }, options, [99]),
    /Invalid option/,
  );
});

test('multiple-choice accepts up to the max', () => {
  assert.deepStrictEqual(
    validateSelection({ ballot_type: 'multiple', max_selections: 2 }, options, [1, 3]).sort(),
    [1, 3],
  );
});

test('multiple-choice rejects more than the max', () => {
  assert.throws(
    () => validateSelection({ ballot_type: 'multiple', max_selections: 2 }, options, [1, 2, 3]),
    /at most 2/,
  );
});

test('de-duplicates repeated selections before counting', () => {
  // [1,1] collapses to [1], which is valid for single choice.
  assert.deepStrictEqual(validateSelection({ ballot_type: 'single', max_selections: 1 }, options, [1, 1]), [1]);
});
