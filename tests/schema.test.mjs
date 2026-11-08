import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateOptions, defaultOptions, validateItem, validateLabel, newItemId, ID_RE, dedupeKey, parseQueue, serializeQueue, OPTION_CHOICES } from '../docs/lib/schema.mjs';

const profiles = JSON.parse(fs.readFileSync(new URL('../config/profiles.json', import.meta.url), 'utf8'));
const goodItem = () => ({
  id: 'q-20261108-153012-a1b2c3', provider: 'gdrive', ref: { id: '1AbCdEfGhIjKlMnOpQrStUv', resourcekey: null },
  label: null, options: defaultOptions(), status: 'pending', attempts: 0, ladder_start: 0, last_error: null, added_at: '2026-11-08T15:30:12.000Z',
});

test('menu khớp profiles.json', () => {
  assert.deepEqual(OPTION_CHOICES.resolution.map((x) => x[0]).sort(), Object.keys(profiles.resolutions).sort());
  assert.deepEqual(OPTION_CHOICES.quality.map((x) => x[0]).sort(), Object.keys(profiles.qualities).sort());
  for (const [v] of OPTION_CHOICES.audio) if (v !== 'copy') assert.ok(profiles.audio[v], v);
});

test('validateOptions', () => {
  assert.equal(validateOptions(undefined).ok, true);
  assert.equal(validateOptions({ resolution: '4k', min_vmaf: 90.26 }).value.min_vmaf, 90.3);
  for (const bad of [{ resolution: '8k' }, { codec: 'h264' }, { fps_cap: 120 }, { min_vmaf: 50 }, { min_vmaf: '95' }, { ffmpeg_args: '-x' }, [], 'x']) {
    assert.equal(validateOptions(bad).ok, false, JSON.stringify(bad));
  }
});

test('validateItem', () => {
  assert.equal(validateItem(goodItem()).ok, true);
  const mut = (f) => { const i = goodItem(); f(i); return validateItem(i).ok; };
  assert.equal(mut((i) => { i.id = 'q-1'; }), false);
  assert.equal(mut((i) => { i.provider = 'mega'; }), false);
  assert.equal(mut((i) => { i.ref.id = '$(reboot)'; }), false);
  assert.equal(mut((i) => { i.cmd = 'rm -rf /'; }), false);
  assert.equal(mut((i) => { i.options.extra_args = '-vf x'; }), false);
  assert.equal(mut((i) => { i.status = 'running'; }), false);
  assert.equal(mut((i) => { i.attempts = -1; }), false);
  assert.equal(mut((i) => { i.label = 'a'.repeat(81); }), false);
});

test('label, id, dedupe, queue', () => {
  assert.equal(validateLabel('  ').value, null);
  assert.equal(validateLabel('a\nb').ok, false);
  assert.match(newItemId(), ID_RE);
  const a = dedupeKey('gdrive', { id: 'x', resourcekey: null }, { a: 1, b: 2 });
  assert.equal(a, dedupeKey('gdrive', { resourcekey: null, id: 'x' }, { b: 2, a: 1 }));
  const q = parseQueue('{"version":1,"items":[]}');
  assert.equal(serializeQueue(q), '{\n  "version": 1,\n  "items": []\n}\n');
  assert.throws(() => parseQueue('{"version":2,"items":[]}'));
  assert.throws(() => parseQueue('khong json'));
});
