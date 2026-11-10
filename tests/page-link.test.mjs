import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, parseLinkClass, entryKind, PROVIDER_IDS } from '../docs/lib/providers.mjs';
import { validateItem, validateLinkMatch, defaultOptions, dedupeKey } from '../docs/lib/schema.mjs';
import { RESOLVERS, resolve, Fail } from '../scripts/resolvers.mjs';

const hosts = [
  { host: 'phim.example', allow_query: false, ytdlp: false, link_class: 'download-btn' },
  { host: 'www.youtube.com', allow_query: true, ytdlp: true },
  { host: 'files.example', allow_query: false, ytdlp: false },
  { host: 'xau.example', allow_query: false, ytdlp: false, link_class: 'bad class!' },
  { host: 'uutien.example', allow_query: false, ytdlp: true, link_class: 'dl' },
];

test('parseLinkClass: một hoặc vài class hợp lệ, từ chối chuỗi lạ', () => {
  assert.deepEqual(parseLinkClass('download-btn'), ['download-btn']);
  assert.deepEqual(parseLinkClass('  btn   dl_x '), ['btn', 'dl_x']);
  for (const bad of ['', '  ', '1abc', 'a.b', 'a"b', 'a>b', '.dl', 'a b c d e f', null, 5, undefined]) assert.equal(parseLinkClass(bad), null, String(bad));
});
test('host có link_class → provider page_link; link_class thắng ytdlp; class hỏng thì host chạy như thường', () => {
  assert.ok(PROVIDER_IDS.includes('page_link'));
  const r = parseLink('https://phim.example/video/123', { allowedHosts: hosts });
  assert.equal(r.ok, true); assert.equal(r.provider, 'page_link'); assert.deepEqual(r.ref, { host: 'phim.example', path: '/video/123', query: null });
  assert.equal(parseLink('https://uutien.example/v/1', { allowedHosts: hosts }).provider, 'page_link');
  assert.equal(parseLink('https://xau.example/v/1', { allowedHosts: hosts }).provider, 'direct_url');
  assert.equal(parseLink('https://files.example/a.mp4', { allowedHosts: hosts }).provider, 'direct_url');
  assert.equal(parseLink('https://www.youtube.com/watch?v=abc', { allowedHosts: hosts }).provider, 'ytdlp');
  assert.equal(entryKind(hosts[0]), 'page'); assert.equal(entryKind(hosts[1]), 'ytdlp'); assert.equal(entryKind(hosts[2]), 'direct');
  const q = parseLink('https://phim.example/video/1?x=1', { allowedHosts: hosts });
  assert.equal(q.ok, false); assert.equal(q.code, 'query_not_allowed'); // allow_query vẫn áp dụng
  assert.equal(parseLink('https://la.example/v', { allowedHosts: hosts }).ok, false);
});
test('validateItem page_link: cần host còn link_class; link_match hợp lệ', () => {
  const item = (extra = {}) => ({ id: 'q-20261111-101010-a1b2c3', provider: 'page_link', ref: { host: 'phim.example', path: '/video/1', query: null }, label: null, options: defaultOptions(), status: 'pending', attempts: 0, ladder_start: 0, last_error: null, added_at: '2026-11-11T10:10:10.000Z', ...extra });
  assert.equal(validateItem(item({ link_match: '2160p.mp4' }), { allowedHosts: hosts }).value.link_match, '2160p.mp4');
  assert.equal(validateItem(item(), { allowedHosts: hosts }).value.link_match, null);
  assert.equal(validateItem(item(), { allowedHosts: [] }).ok, false);
  assert.equal(validateItem(item(), { allowedHosts: [{ host: 'phim.example' }] }).ok, false); // host bỏ link_class → mục không còn hợp lệ
  assert.equal(validateItem(item({ link_match: 'a'.repeat(201) }), { allowedHosts: hosts }).ok, false);
  assert.equal(validateItem(item({ link_match: 'a\nb' }), { allowedHosts: hosts }).ok, false);
});
test('validateLinkMatch & dedupeKey', () => {
  assert.deepEqual(validateLinkMatch(undefined), { ok: true, value: null });
  assert.deepEqual(validateLinkMatch('  '), { ok: true, value: null });
  assert.equal(validateLinkMatch(' shenhe8_2160p ').value, 'shenhe8_2160p');
  assert.equal(validateLinkMatch(5).ok, false);
  const o = defaultOptions();
  assert.notEqual(dedupeKey('page_link', { a: 1 }, o, null, '1080p'), dedupeKey('page_link', { a: 1 }, o, null, '2160p'));
  assert.equal(dedupeKey('page_link', { a: 1 }, o), dedupeKey('page_link', { a: 1 }, o, null, null));
});
test('resolver page_link: lấy class từ allowed-hosts, kind page', async () => {
  const ref = { host: 'phim.example', path: '/video/123', query: null };
  const out = await resolve('page_link', ref, { allowedHosts: hosts });
  assert.deepEqual(out, { kind: 'page', url: 'https://phim.example/video/123', linkClass: ['download-btn'], nameHint: null });
  await assert.rejects(() => resolve('page_link', ref, { allowedHosts: [{ host: 'phim.example' }] }), (e) => e instanceof Fail);
  assert.ok(RESOLVERS.page_link);
});
test('plan.mjs truyền referer và link_match sang job nén', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../scripts/plan.mjs', import.meta.url), 'utf8');
  assert.match(src, /referer: i\.referer/); assert.match(src, /link_match: i\.link_match/);
});
