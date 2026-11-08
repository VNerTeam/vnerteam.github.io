import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaking, parseCrfSearch } from '../scripts/parse.mjs';

test('parseTaking', () => {
  assert.equal(parseTaking('3 minutes'), 180);
  assert.equal(parseTaking('45 seconds'), 45);
  assert.equal(parseTaking('1 hour 5 minutes'), 3900);
  assert.equal(parseTaking('2h 30m'), 9000);
  assert.equal(parseTaking('không rõ'), null);
});

test('parseCrfSearch chọn CRF lớn nhất còn đạt VMAF', () => {
  const out = [
    '- crf 28 VMAF 96.20 predicted video stream size 400.00 MiB (40%) taking 2 minutes',
    '- crf 36 VMAF 93.10 predicted video stream size 210.00 MiB (21%) taking 2 minutes',
    '- crf 32 VMAF 95.10 predicted video stream size 1.25 GiB (30%) taking 1 hour 5 minutes',
  ].join('\n');
  const r = parseCrfSearch(out, 95);
  assert.equal(r.crf, 32);
  assert.equal(r.pct, 30);
  assert.equal(r.seconds, 3900);
  assert.equal(Math.round(r.bytes / 1024 ** 2), 1280);
  assert.equal(parseCrfSearch(out, 99), null);
  assert.equal(parseCrfSearch('không có gì', 95), null);
});
