// Kiểm tra giao thức của scripts/browser-fetch.mjs bằng một playwright-core GIẢ (không cần Chrome thật, không cần mạng).
// Phần chạy với Chrome thật trên runner KHÔNG được kiểm chứng ở đây.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const FAKE_PW = `
const sc = JSON.parse(process.env.FAKE || '{}');
class Dl { constructor(d) { this.d = d || sc.download; } url() { return this.d.url; } suggestedFilename() { return this.d.name; } async cancel() {} async path() { return this.d.file; } }
class Page {
  constructor() { this.h = {}; this.cur = 'about:blank'; this.n = 0; }
  on(ev, fn) { this.h[ev] = fn; }
  url() { return this.cur; }
  async goto(url, o) {
    this.n++;
    if (sc.anchorDl && sc.anchors && sc.anchors.some((a) => a.href === url)) { this.cur = url; this.h.download(new Dl(sc.anchorDl)); throw new Error('page.goto: Download is starting'); }
    if (sc.refGoto === false && this.n === 1 && sc.hasRef) throw new Error('net::ERR_FAILED');
    if (url !== sc.target) { this.cur = url; return { status: () => 200 }; }
    if (sc.download) { this.h.download(new Dl()); throw new Error('page.goto: Download is starting'); }
    this.cur = url;
    for (const r of sc.responses || []) this.h.response({ status: () => 200, url: () => r.url, headers: () => ({ 'content-type': r.type, 'content-length': String(r.len || 0) }) });
    return { status: () => sc.status || 200 };
  }
  async waitForLoadState() {}
  frames() { return [{ evaluate: async (fn, arg) => (arg ? (sc.anchors || []).filter((a) => arg.every((c) => a.classes.includes(c))).map((a) => a.href) : sc.domVideos || []) }]; }
}
exports.chromium = { async launch(o) {
  if (sc.launchFail) throw new Error('boom');
  return { version: () => '141.0.7390.54', async close() {}, async newContext(c) {
    if (!/Chrome\\/141\\.0\\.0\\.0/.test(c.userAgent)) throw new Error('UA không khớp phiên bản Chrome: ' + c.userAgent);
    return { async route() {}, async newPage() { return new Page(); }, async cookies() { return sc.cookies || []; } };
  } };
} };
`;

function runBf(scenario, jobExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-test-'));
  const pw = path.join(dir, 'pw');
  fs.mkdirSync(path.join(pw, 'node_modules', 'playwright-core'), { recursive: true });
  fs.writeFileSync(path.join(pw, 'node_modules', 'playwright-core', 'index.js'), FAKE_PW);
  fs.writeFileSync(path.join(pw, 'node_modules', 'playwright-core', 'package.json'), '{"name":"playwright-core","version":"0.0.0","main":"index.js"}');
  const job = { url: scenario.target, ref: scenario.ref || null, dir: path.join(dir, 'run'), pwDir: pw, headed: false, phaseMs: 20000, totalMs: 20000, maxBytes: 0, ...jobExtra };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/browser-fetch.mjs')], { env: { ...process.env, BF_JOB: JSON.stringify(job), FAKE: JSON.stringify({ ...scenario, hasRef: !!scenario.ref }) }, encoding: 'utf8', timeout: 60000 });
  const line = r.stdout.split('\n').reverse().find((l) => l.startsWith('{"bf":1'));
  return { res: line ? JSON.parse(line) : null, stdout: r.stdout, dir, code: r.status };
}

test('link trả file (sự kiện download): bàn giao URL cuối + cookie 0600 + Referer, không in cookie', () => {
  const sc = { target: 'https://site.example/dl/1', ref: 'https://site.example/xem/1', download: { url: 'https://cdn.example/f/clip.mp4?sig=ABC', name: 'clip.mp4' },
    cookies: [{ name: 'sid', value: 'GIATRI-BIMAT-123', domain: '.cdn.example', path: '/', expires: 1900000000, secure: true, httpOnly: true }] };
  const { res, stdout, dir } = runBf(sc);
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'file');
  assert.equal(res.url, 'https://cdn.example/f/clip.mp4?sig=ABC');
  assert.equal(res.referer, 'https://site.example/xem/1'); // người dùng chủ động chỉ định trang mở trước → giữ nguyên làm Referer
  assert.match(res.ua, /Chrome\/141\.0\.0\.0/);
  const st = fs.statSync(res.cookiesFile);
  assert.equal(st.mode & 0o777, 0o600);
  assert.match(fs.readFileSync(res.cookiesFile, 'utf8'), /#HttpOnly_\.cdn\.example\tTRUE\t\/\tTRUE\t1900000000\tsid\tGIATRI-BIMAT-123/);
  assert.ok(!stdout.includes('GIATRI-BIMAT-123'), 'cookie không được xuất hiện trên stdout');
  assert.ok(stdout.includes('::add-mask::https://site.example/dl/1') && stdout.includes('::add-mask::https://cdn.example/f/clip.mp4?sig=ABC'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('link là trang HTML có video: chọn file video/* lớn nhất, bỏ blob:', () => {
  const sc = { target: 'https://site.example/watch/9', responses: [{ url: 'https://cdn.example/a.mp4', type: 'video/mp4', len: 100 }, { url: 'https://cdn.example/b.mp4', type: 'video/mp4', len: 9000 }], domVideos: ['blob:https://site.example/xyz'] };
  const { res, dir } = runBf(sc);
  assert.equal(res.ok, true); assert.equal(res.kind, 'file'); assert.equal(res.url, 'https://cdn.example/b.mp4');
  assert.equal(res.cookiesFile, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('trang chỉ có m3u8 → kind stream; chỉ có blob: → browser_no_video; không có gì → browser_no_video', () => {
  let r = runBf({ target: 'https://site.example/live/1', responses: [{ url: 'https://cdn.example/live/index.m3u8', type: 'application/vnd.apple.mpegurl' }] });
  assert.equal(r.res.ok, true); assert.equal(r.res.kind, 'stream'); assert.equal(r.res.url, 'https://cdn.example/live/index.m3u8');
  fs.rmSync(r.dir, { recursive: true, force: true });
  r = runBf({ target: 'https://site.example/live/2', domVideos: ['blob:https://site.example/xyz'] }, { phaseMs: 6000 });
  assert.equal(r.res.ok, false); assert.equal(r.res.code, 'browser_no_video'); assert.match(r.res.message, /blob:/);
  fs.rmSync(r.dir, { recursive: true, force: true });
  r = runBf({ target: 'https://site.example/live/3' }, { phaseMs: 6000 });
  assert.equal(r.res.code, 'browser_no_video'); assert.equal(r.code, 1);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('từ chối file thực thi, link không phải https, 403 cả với trình duyệt, Chrome không mở được', () => {
  let r = runBf({ target: 'https://site.example/dl/2', download: { url: 'https://cdn.example/setup.exe', name: 'setup.exe' } });
  assert.equal(r.res.ok, false); assert.equal(r.res.code, 'not_a_video');
  fs.rmSync(r.dir, { recursive: true, force: true });
  r = runBf({ target: 'http://site.example/dl/3' });
  assert.equal(r.res.code, 'browser_failed');
  fs.rmSync(r.dir, { recursive: true, force: true });
  r = runBf({ target: 'https://site.example/dl/4', status: 403 });
  assert.equal(r.res.code, 'access_denied'); assert.equal(r.res.blocked, true);
  fs.rmSync(r.dir, { recursive: true, force: true });
  r = runBf({ target: 'https://site.example/dl/5', launchFail: true });
  assert.equal(r.res.code, 'browser_unavailable');
  fs.rmSync(r.dir, { recursive: true, force: true });
  r = runBf({ target: 'https://site.example/dl/6', ref: 'https://10.0.0.1/x' });
  assert.equal(r.res.code, 'browser_failed'); assert.match(r.res.message, /nội bộ/);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('chế độ save: chuyển file trình duyệt đã tải về đường dẫn đích', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-save-'));
  const src = path.join(tmp, 'guid-123'); fs.writeFileSync(src, 'VIDEO');
  const dest = path.join(tmp, 'input.bin');
  const { res, dir } = runBf({ target: 'https://site.example/dl/7', download: { url: 'https://cdn.example/x.mp4', name: 'x.mp4', file: src } }, { save: true, dest });
  assert.equal(res.ok, true); assert.equal(res.kind, 'saved');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'VIDEO');
  assert.ok(!fs.existsSync(src));
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true });
});

test('page_link: lấy href của thẻ a theo class + lọc link; cookie bàn giao, Referer là trang', () => {
  const sc = { target: 'https://site.example/video/9', cookies: [{ name: 'sid', value: 'GIATRI-BIMAT-9', domain: 'site.example', path: '/' }], anchors: [
    { classes: ['dl', 'btn'], href: 'https://cdn.example/f/shenhe8_1080p.mp4?tok=1' },
    { classes: ['dl', 'btn'], href: 'https://cdn.example/f/shenhe8_2160p.mp4?tok=2' },
    { classes: ['other'], href: 'https://cdn.example/f/quangcao_2160p.mp4' } ] };
  let r = runBf(sc, { linkClass: ['dl'], linkMatch: '2160P.MP4' });
  assert.equal(r.res.ok, true); assert.equal(r.res.kind, 'file');
  assert.equal(r.res.url, 'https://cdn.example/f/shenhe8_2160p.mp4?tok=2');
  assert.equal(r.res.name, 'shenhe8_2160p');
  assert.equal(r.res.referer, 'https://site.example/'); // trang khác origin với link tải → chỉ origin
  assert.ok(!r.stdout.includes('GIATRI-BIMAT-9'));
  assert.ok(r.stdout.includes('::add-mask::https://cdn.example/f/shenhe8_2160p.mp4?tok=2'));
  fs.rmSync(r.dir, { recursive: true, force: true });
  r = runBf(sc, { linkClass: ['dl', 'btn'] }); // không lọc → link đầu tiên
  assert.equal(r.res.url, 'https://cdn.example/f/shenhe8_1080p.mp4?tok=1');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('page_link: không có thẻ a / không link nào khớp → link_not_found', () => {
  const sc = { target: 'https://site.example/video/10', anchors: [{ classes: ['dl'], href: 'https://cdn.example/f/a_720p.mp4' }] };
  let r = runBf(sc, { linkClass: ['khongco'], phaseMs: 6000 });
  assert.equal(r.res.ok, false); assert.equal(r.res.code, 'link_not_found'); assert.match(r.res.message, /khongco/);
  fs.rmSync(r.dir, { recursive: true, force: true });
  r = runBf(sc, { linkClass: ['dl'], linkMatch: '2160p', phaseMs: 6000 });
  assert.equal(r.res.code, 'link_not_found'); assert.match(r.res.message, /Có 1 link/);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('page_link ở chế độ save: bấm link lấy từ trang rồi lưu file trình duyệt tải về', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-pl-'));
  const src = path.join(tmp, 'guid-1'); fs.writeFileSync(src, 'VIDEO2');
  const dest = path.join(tmp, 'input.bin');
  const href = 'https://cdn.example/f/clip_2160p.mp4?tok=7';
  const { res, dir } = runBf({ target: 'https://site.example/video/11', anchors: [{ classes: ['dl'], href }], anchorDl: { url: href, name: 'clip_2160p.mp4', file: src } }, { linkClass: ['dl'], save: true, dest });
  assert.equal(res.ok, true); assert.equal(res.kind, 'saved');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'VIDEO2');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true });
});
