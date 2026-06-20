import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDownstreams, resolveTargets, Downstream } from './squadHub';

const apps: Downstream[] = parseDownstreams(
  JSON.stringify([
    { name: 'neflo', url: 'https://neflo/webhooks/squad', prefix: 'nf_,cg_' },
    { name: 'otuburu', url: 'https://otu/webhooks/squad', prefix: 'otu-' },
  ]),
);
const names = (t: Downstream[]) => t.map((x) => x.name);

test('parseDownstreams reads name/url/prefixes', () => {
  assert.equal(apps.length, 2);
  assert.deepEqual(apps[0].prefixes, ['nf_', 'cg_']);
  assert.equal(apps[1].url, 'https://otu/webhooks/squad');
});

test('parseDownstreams tolerates empty/invalid input', () => {
  assert.deepEqual(parseDownstreams(undefined), []);
  assert.deepEqual(parseDownstreams(''), []);
  assert.deepEqual(parseDownstreams('{not json'), []);
  assert.deepEqual(parseDownstreams('[{"name":"x"}]'), []); // no url → dropped
});

test('settled-locally events are not forwarded', () => {
  assert.deepEqual(resolveTargets('vote-12-abc', true, apps), []);
});

test('a matching prefix routes to exactly that app', () => {
  assert.deepEqual(names(resolveTargets('nf_98ac', false, apps)), ['neflo']);
  assert.deepEqual(names(resolveTargets('cg_77', false, apps)), ['neflo']);
  assert.deepEqual(names(resolveTargets('otu-55', false, apps)), ['otuburu']);
});

test('an unmatched ref broadcasts to all downstreams', () => {
  assert.deepEqual(names(resolveTargets('SQGRAN755', false, apps)), ['neflo', 'otuburu']);
});

test('no downstreams configured → nothing to forward', () => {
  assert.deepEqual(resolveTargets('SQ123', false, []), []);
});
