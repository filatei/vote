import assert from 'node:assert';
import { test } from 'node:test';

import { parseVideoUrl } from './video';

test('parses youtu.be short links', () => {
  const v = parseVideoUrl('https://youtu.be/Cafnwp8FElk');
  assert.strictEqual(v.type, 'youtube');
  assert.ok(v.src.includes('youtube-nocookie.com/embed/Cafnwp8FElk'));
});

test('parses youtube.com/watch?v= links', () => {
  const v = parseVideoUrl('https://www.youtube.com/watch?v=Cafnwp8FElk&t=10s');
  assert.strictEqual(v.type, 'youtube');
  assert.ok(v.src.includes('/embed/Cafnwp8FElk'));
});

test('parses youtube embed + shorts links', () => {
  assert.strictEqual(parseVideoUrl('https://www.youtube.com/embed/Cafnwp8FElk').type, 'youtube');
  assert.strictEqual(parseVideoUrl('https://youtube.com/shorts/Cafnwp8FElk').type, 'youtube');
});

test('treats a direct file URL as a file', () => {
  const v = parseVideoUrl('https://vote.torama.money/static/landing.mp4');
  assert.strictEqual(v.type, 'file');
  assert.strictEqual(v.src, 'https://vote.torama.money/static/landing.mp4');
});

test('empty/undefined yields none', () => {
  assert.strictEqual(parseVideoUrl('').type, 'none');
  assert.strictEqual(parseVideoUrl(undefined).type, 'none');
});
