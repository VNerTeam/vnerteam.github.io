import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateOptions, defaultOptions, validateItem, validateLabel, validateRefPage, newItemId, ID_RE, dedupeKey, parseQueue, serializeQueue, OPTION_CHOICES } from '../docs/lib/schema.mjs';

const profiles = JSON.parse(fs.readFileSync(new URL('../config/profiles.json', import.meta.url), 'utf8'));
const goodItem = () => ({
  id: 'q-20261108-153012-a1b2c3', provider: 'gdrive', ref: { id: '1AbCdEfGhIjKlMnOpQrStUv', resourcekey: null },
  label: null, options: defaultOptions(), status: 'pending', attempts: 0, ladder_start: 0, last_error: null, added_at: '2026-11-08T15:30:12.000Z',
});

test('menu khớp profiles.json', () => {
  assert.deepEqual(OPTION_CHOICES.resolution.map((x) => x[0]).sort(), Object.keys(profiles.resolutions).sort());
  assert.ok(OPTION_CHOICES.phone.some(([v]) => v === true) && OPTION_CHOICES.phone.some(([v]) => v === false));
  assert.ok(profiles.phone && profiles.phone.crf === 25 && profiles.phone.caps.length === 2 && profiles.phone.max_long_edge === 1920);
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

test('mặc định mới và tuỳ chọn phone', () => {
  assert.deepEqual(defaultOptions(), { resolution: 'original', quality: 'strong', codec: 'hevc', fps_cap: null, audio: 'opus_128', container: 'mkv', phone: true, fetch_mode: 'auto', min_vmaf: null });
  assert.equal(validateOptions({ phone: false }).value.phone, false);
  for (const bad of [{ phone: 'true' }, { phone: 1 }, { phone: null }]) assert.equal(validateOptions(bad).ok, false, JSON.stringify(bad));
});
test('dữ liệu cũ chưa có khoá phone vẫn hợp lệ và KHÔNG bị đổi theo mặc định mới', () => {
  const old = { resolution: 'fhd', quality: 'balanced', codec: 'av1', fps_cap: null, audio: 'opus_128', container: 'mkv', min_vmaf: null };
  const item = { ...goodItem(), options: old };
  const v = validateItem(item);
  assert.equal(v.ok, true);
  assert.deepEqual(v.value.options, { ...old, phone: true, fetch_mode: 'auto' });
  assert.equal(v.value.options.resolution, 'fhd'); assert.equal(v.value.options.codec, 'av1');
});
test('dedupeKey với boolean', () => {
  const o = defaultOptions();
  assert.notEqual(dedupeKey('gdrive', { id: 'x' }, { ...o, phone: true }), dedupeKey('gdrive', { id: 'x' }, { ...o, phone: false }));
  assert.equal(dedupeKey('gdrive', { id: 'x' }, { ...o }), dedupeKey('gdrive', { id: 'x' }, { ...o }));
});

test('fetch_mode: hợp lệ / không hợp lệ, dữ liệu cũ không có khoá vẫn hợp lệ (nhận auto)', () => {
  for (const m of ['auto', 'curl', 'browser']) assert.equal(validateOptions({ fetch_mode: m }).value.fetch_mode, m);
  for (const bad of ['', 'Browser', 'chrome', null, 1, true]) assert.equal(validateOptions({ fetch_mode: bad }).ok, false, String(bad));
  assert.equal(validateOptions({}).value.fetch_mode, 'auto');
  assert.deepEqual(OPTION_CHOICES.fetch_mode.map((x) => x[0]), ['auto', 'curl', 'browser']);
  assert.deepEqual(OPTION_CHOICES.fetch_mode.map((x) => x[1]), ['Tự động', 'Chỉ tải thường', 'Luôn dùng trình duyệt']);
});
test('dedupeKey: fetch_mode và referer làm hai mục khác nhau', () => {
  const o = defaultOptions();
  assert.notEqual(dedupeKey('gdrive', { id: 'x' }, o), dedupeKey('gdrive', { id: 'x' }, { ...o, fetch_mode: 'browser' }));
  assert.notEqual(dedupeKey('direct_url', { a: 1 }, o), dedupeKey('direct_url', { a: 1 }, o, 'https://a.example/p'));
  assert.equal(dedupeKey('direct_url', { a: 1 }, o), dedupeKey('direct_url', { a: 1 }, o, null)); // mục cũ không có referer giữ nguyên khoá
});
test('validateRefPage: https, độ dài, ký tự lạ, host nội bộ', () => {
  assert.deepEqual(validateRefPage(undefined), { ok: true, value: null });
  assert.deepEqual(validateRefPage('  '), { ok: true, value: null });
  assert.equal(validateRefPage(' https://site.example/xem/1?a=2 ').value, 'https://site.example/xem/1?a=2');
  const bad = ['http://site.example/', 'ftp://site.example/', 'javascript:alert(1)', 'site.example/x', 'https://site.example/a b', 'https://site.example/a\nb', `https://site.example/${'a'.repeat(2048)}`,
    'https://localhost/x', 'https://app.localhost/', 'https://127.0.0.1/', 'https://10.0.0.5/', 'https://192.168.1.2/', 'https://172.16.0.1/', 'https://169.254.169.254/', 'https://100.64.0.1/',
    'https://[::1]/', 'https://intranet/x', 'https://nas.local/', 'https://svc.internal/', 'https://user:pw@site.example/', 'https://2130706433/', 'https://0x7f000001/'];
  for (const b of bad) assert.equal(validateRefPage(b).ok, false, b);
  assert.equal(validateRefPage(5).ok, false);
});
test('validateItem: nhận referer hợp lệ, từ chối referer xấu, mục cũ không có referer vẫn hợp lệ', () => {
  const ok = validateItem({ ...goodItem(), referer: 'https://site.example/p' });
  assert.equal(ok.ok, true); assert.equal(ok.value.referer, 'https://site.example/p');
  const old = validateItem(goodItem());
  assert.equal(old.ok, true); assert.equal(old.value.referer, null);
  assert.equal(validateItem({ ...goodItem(), referer: 'http://x.example/' }).ok, false);
  assert.equal(validateItem({ ...goodItem(), cookie: 'a=b' }).ok, false); // không có trường cookie
});
