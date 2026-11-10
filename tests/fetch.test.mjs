import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UA, chromeUA, chromeMajorOf, browserHeaders, curlHeaderArgs, shouldFallbackToBrowser, probeVerdict, RETRYABLE_ERRORS, isExecutableName,
  pickMediaUrl, toNetscapeCookies, describeCookies, assessDownloadedHead, handoffReferer, extractAnchors, pickLink, nameFromUrl, cookieHeaderFrom,
} from '../scripts/fetch-core.mjs';
import { Fail, headCheck, probeUrl } from '../scripts/resolvers.mjs';

test('UA: một nguồn, dựng theo phiên bản Chrome thật', () => {
  assert.match(UA, /Chrome\/\d+\.0\.0\.0 Safari/);
  assert.equal(chromeUA(150), 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');
  assert.equal(chromeUA('x; rm -rf'), UA); // giá trị lạ → mặc định, không chèn chuỗi tuỳ ý vào header
  assert.equal(chromeMajorOf('140.0.7339.16'), 140);
  assert.equal(chromeMajorOf('Google Chrome 141.0.7390.54 '), 141);
  assert.equal(chromeMajorOf(''), null);
});

test('browserHeaders: không có ref → Referer là origin, same-origin', () => {
  const h = browserHeaders('https://cdn.site.example/v/a.mp4?t=1');
  assert.equal(h.Referer, 'https://cdn.site.example/');
  assert.equal(h['Sec-Fetch-Site'], 'same-origin');
  assert.equal(h['Sec-Fetch-Dest'], 'video');
  assert.equal(h['Sec-Fetch-Mode'], 'no-cors');
  assert.equal(h['Accept-Language'], 'en-US,en;q=0.9,vi;q=0.8');
  assert.equal(h.Connection, 'keep-alive');
  assert.ok(h.Accept.startsWith('video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5'));
});
test('browserHeaders: có ref → Referer = ref; khác origin → cross-site, cùng origin → same-origin', () => {
  const cross = browserHeaders('https://cdn.example/a.mp4', { ref: 'https://site.example/xem/1' });
  assert.equal(cross.Referer, 'https://site.example/xem/1');
  assert.equal(cross['Sec-Fetch-Site'], 'cross-site');
  const same = browserHeaders('https://site.example/a.mp4', { ref: 'https://site.example/xem/1' });
  assert.equal(same['Sec-Fetch-Site'], 'same-origin');
});
test('browserHeaders: sau chuyển hướng sang host khác KHÔNG lộ ref', () => {
  const first = 'https://site.example/dl/1';
  const ref = 'https://site.example/xem/1?token=BIMAT';
  const h1 = browserHeaders(first, { ref, first });
  assert.equal(h1.Referer, ref);
  const h2 = browserHeaders('https://cdn.other.example/f.mp4', { ref, first, prev: first });
  assert.equal(h2.Referer, 'https://site.example/');
  assert.ok(!JSON.stringify(h2).includes('BIMAT'));
  assert.equal(h2['Sec-Fetch-Site'], 'cross-site');
  const h3 = browserHeaders('https://site.example/dl/2', { ref, first, prev: first }); // cùng origin: giữ ref
  assert.equal(h3.Referer, ref);
});
test('curlHeaderArgs: Referer đi bằng -e, không có -H Referer/User-Agent', () => {
  const a = curlHeaderArgs(browserHeaders('https://a.example/x.mp4', { ref: 'https://b.example/p' }));
  const i = a.indexOf('-e');
  assert.equal(a[i + 1], 'https://b.example/p');
  assert.ok(!a.some((x) => /^(Referer|User-Agent):/i.test(x)));
  assert.ok(a.includes('Sec-Fetch-Dest: video'));
});

test('probeUrl: header giống trình duyệt ở bước đầu, ref không sang host khác sau chuyển hướng', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    if (String(url).startsWith('https://site.example/')) return new Response(null, { status: 302, headers: { location: 'https://cdn.other.example/f.mp4' } });
    return new Response(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(40)]), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-63/1000' } });
  };
  try {
    const p = await probeUrl('https://site.example/dl/1', { ref: 'https://site.example/xem/1' });
    assert.equal(p.video, true);
    assert.equal(p.size, 1000);
    assert.equal(p.finalUrl, 'https://cdn.other.example/f.mp4');
    assert.equal(seen[0].headers.Referer, 'https://site.example/xem/1');
    assert.equal(seen[0].headers['User-Agent'], UA);
    assert.equal(seen[0].headers.Range, 'bytes=0-4095');
    assert.equal(seen[1].headers.Referer, 'https://site.example/');
  } finally { globalThis.fetch = realFetch; }
});
test('probeUrl: 403 → access_denied có cờ blocked', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('no', { status: 403 });
  try {
    await assert.rejects(() => probeUrl('https://site.example/a.mp4'), (e) => e instanceof Fail && e.code === 'access_denied' && e.blocked === true);
  } finally { globalThis.fetch = realFetch; }
});

test('HTML mã 200 sau khi tải → not_direct_video có blocked:true; JSON cũng vậy; video thì qua', () => {
  const mk = (c, m, x) => new Fail(c, m, x);
  const html = Buffer.from('<!doctype html><html><body>Please verify</body></html>'.padEnd(200, ' '));
  assert.throws(() => assessDownloadedHead(headCheck(html), mk), (e) => e.code === 'not_direct_video' && e.blocked === true);
  assert.throws(() => assessDownloadedHead(headCheck(Buffer.from('{"error":"forbidden"}'.padEnd(64, ' '))), mk), (e) => e.code === 'not_direct_video' && e.blocked === true);
  assert.throws(() => assessDownloadedHead(headCheck(Buffer.alloc(64, 7)), mk), (e) => e.code === 'not_direct_video' && e.blocked === undefined);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(40)]);
  assert.equal(assessDownloadedHead(headCheck(mp4), mk).video, true);
});

test('shouldFallbackToBrowser: bảng quyết định theo mode và mã lỗi', () => {
  const E = (code, extra = {}) => new Fail(code, 'x', extra);
  for (const e of [E('access_denied'), E('not_direct_video', { blocked: true }), E('download_failed')]) {
    assert.equal(shouldFallbackToBrowser(e, 'curl'), false, `curl ${e.code}`);
    assert.equal(shouldFallbackToBrowser(e, 'browser'), true, `browser ${e.code}`);
  }
  assert.equal(shouldFallbackToBrowser(E('access_denied'), 'auto'), true);
  assert.equal(shouldFallbackToBrowser(E('access_denied', { blocked: true }), 'auto'), true);
  assert.equal(shouldFallbackToBrowser(E('not_direct_video', { blocked: true }), 'auto'), true);
  assert.equal(shouldFallbackToBrowser(E('not_direct_video'), 'auto'), false); // link sai thật sự, không phải bị chặn
  for (const c of ['not_found', 'rate_limited', 'timeout', 'input_too_big', 'lfs_pointer', 'download_failed', 'not_a_video']) assert.equal(shouldFallbackToBrowser(E(c), 'auto'), false, c);
  assert.equal(shouldFallbackToBrowser(E('not_found', { blocked: true }), 'auto'), false); // 404 không bao giờ fallback
  assert.equal(shouldFallbackToBrowser(null, 'auto'), false);
});

test('probeVerdict: auto/browser không từ chối sớm 403 hoặc HTML, curl thì vẫn từ chối', () => {
  for (const mode of ['auto', 'browser']) {
    assert.equal(probeVerdict({ error: 'access_denied' }, mode), 'defer', mode);
    assert.equal(probeVerdict({ video: false, kind: 'html' }, mode), 'defer', mode);
    assert.equal(probeVerdict({ video: false, kind: 'json' }, mode), 'defer', mode);
    assert.equal(probeVerdict({ error: 'not_found' }, mode), 'reject', mode);
    assert.equal(probeVerdict({ error: 'rate_limited' }, mode), 'reject', mode);
    assert.equal(probeVerdict({ video: false, kind: 'unknown' }, mode), 'reject', mode);
    assert.equal(probeVerdict({ video: true }, mode), 'accept', mode);
  }
  assert.equal(probeVerdict({ error: 'access_denied' }, 'curl'), 'reject');
  assert.equal(probeVerdict({ video: false, kind: 'html' }, 'curl'), 'reject');
  assert.equal(probeVerdict({ error: 'not_found' }, 'curl'), 'reject');
  assert.equal(probeVerdict({ video: true }, 'curl'), 'accept');
});

test('mã lỗi mới: chỉ browser_failed được thử lại', () => {
  assert.deepEqual([...RETRYABLE_ERRORS], ['browser_failed']);
  assert.equal(RETRYABLE_ERRORS.has('browser_no_video'), false);
  assert.equal(RETRYABLE_ERRORS.has('browser_unavailable'), false);
});

test('pickMediaUrl: ưu tiên file đơn video/* lớn nhất; bỏ blob:/data:/http; chỉ m3u8; không có ứng viên', () => {
  const big = { url: 'https://cdn.example/big.mp4', type: 'video/mp4', length: 900 };
  const small = { url: 'https://cdn.example/small.mp4', type: 'video/mp4', length: 100 };
  assert.deepEqual(pickMediaUrl([small, big]), { kind: 'file', url: big.url });
  assert.deepEqual(pickMediaUrl([{ url: 'blob:https://x.example/abc', type: 'video/mp4', length: 99999 }, { url: 'data:video/mp4;base64,AAAA', type: 'video/mp4', length: 99999 }, { url: 'http://cdn.example/a.mp4', type: 'video/mp4', length: 99999 }, small]), { kind: 'file', url: small.url });
  assert.deepEqual(pickMediaUrl([{ url: 'https://cdn.example/x/get_file/123', type: 'application/octet-stream', length: 500 }]), null); // octet-stream không có đuôi video
  assert.deepEqual(pickMediaUrl([{ url: 'https://cdn.example/v/clip.mkv?sig=1', type: 'application/octet-stream', length: 500 }]), { kind: 'file', url: 'https://cdn.example/v/clip.mkv?sig=1' });
  const m3u8 = { url: 'https://cdn.example/live/index.m3u8', type: 'application/vnd.apple.mpegurl' };
  assert.deepEqual(pickMediaUrl([m3u8, { url: 'https://cdn.example/live/seg1.ts', type: 'video/mp2t', length: 5000 }]), { kind: 'stream', url: m3u8.url });
  assert.deepEqual(pickMediaUrl([{ url: 'https://cdn.example/m.mpd', type: '' }]), { kind: 'stream', url: 'https://cdn.example/m.mpd' });
  assert.deepEqual(pickMediaUrl([m3u8, small]), { kind: 'file', url: small.url }); // có file đơn thì ưu tiên file
  assert.equal(pickMediaUrl([]), null);
  assert.equal(pickMediaUrl(undefined), null);
  assert.equal(pickMediaUrl([{ url: 'blob:https://x.example/abc', type: 'video/mp4' }]), null);
  assert.equal(pickMediaUrl([{ url: 'not a url', type: 'video/mp4' }, null, {}]), null);
});

test('toNetscapeCookies: đúng định dạng, không cho chèn dòng giả, httpOnly có tiền tố', () => {
  const t = toNetscapeCookies([
    { name: 'sid', value: 'abc123', domain: '.site.example', path: '/', expires: 1900000000.7, httpOnly: false, secure: true },
    { name: 'sess', value: 'x', domain: 'cdn.site.example', path: '/v', expires: -1, httpOnly: true, secure: false },
    { name: 'evil', value: 'a\tb\nc.example\tTRUE\t/\tTRUE\t0\tx\ty', domain: 'ok.example', path: '/', expires: 0 },
    { name: '', value: 'x', domain: 'a.example' },
    { name: 'n', value: 'v', domain: 'bad domain\n' },
  ]);
  const lines = t.trimEnd().split('\n');
  assert.equal(lines[0], '# Netscape HTTP Cookie File');
  assert.equal(lines[1], '.site.example\tTRUE\t/\tTRUE\t1900000000\tsid\tabc123');
  assert.equal(lines[2], '#HttpOnly_cdn.site.example\tFALSE\t/v\tFALSE\t0\tsess\tx');
  assert.equal(lines.length, 4); // dòng "evil" chỉ là một dòng, hai cookie hỏng bị bỏ
  assert.equal(lines[3].split('\t').length, 7);
  assert.ok(!t.includes('bad domain'));
});
test('cookie không rò vào log: chỉ nêu số lượng', () => {
  const cookies = [{ name: 'sid', value: 'GIATRI-BIMAT', domain: '.a.example' }];
  const d = describeCookies(cookies);
  assert.ok(!d.includes('GIATRI-BIMAT') && !d.includes('sid'));
  assert.match(d, /^1 cookie/);
  assert.match(describeCookies(null), /^0 cookie/);
});

test('handoffReferer & isExecutableName', () => {
  assert.equal(handoffReferer('https://site.example/p?x=1', 'https://site.example/f.mp4', null), 'https://site.example/p?x=1');
  assert.equal(handoffReferer('https://site.example/p?token=BIMAT', 'https://cdn.example/f.mp4', null), 'https://site.example/');
  assert.equal(handoffReferer('https://site.example/xem/1', 'https://cdn.example/f.mp4', 'https://site.example/xem/1'), 'https://site.example/xem/1'); // người dùng chỉ định
  assert.equal(handoffReferer('about:blank', 'https://cdn.example/f.mp4', null), 'https://cdn.example/');
  for (const n of ['a.exe', 'setup.MSI', 'run.sh', 'app.apk', 'x.jar', 'inst.AppImage']) assert.equal(isExecutableName(n), true, n);
  for (const n of ['clip.mp4', 'film.mkv', 'notes.txt', '', null]) assert.equal(isExecutableName(n), false, String(n));
});

const PAGE = `<html><body>
  <a class="btn dl" href="/files/shenhe8_1080p.mp4?t=a&amp;u=1">1080p</a>
  <a class='dl btn primary' href='https://cdn.example/files/shenhe8_2160p.mp4'>4K</a>
  <a class="dlx" href="/files/khac.mp4">sai class</a>
  <a href="/files/khong-class.mp4">không class</a>
  <a class="dl" href="#">neo</a><a class="dl" href="javascript:void(0)">js</a><a class="dl" href="mailto:a@b.c">mail</a>
  <a class=dl href=/files/khongngoac_720p.mp4>720p</a>
</body></html>`;
test('extractAnchors: đủ class, đổi URL tuyệt đối, giải mã &amp;, bỏ #/javascript/mailto', () => {
  const urls = extractAnchors(PAGE, ['dl'], 'https://site.example/video/1');
  assert.deepEqual(urls, ['https://site.example/files/shenhe8_1080p.mp4?t=a&u=1', 'https://cdn.example/files/shenhe8_2160p.mp4', 'https://site.example/files/khongngoac_720p.mp4']);
  assert.deepEqual(extractAnchors(PAGE, ['dl', 'primary'], 'https://site.example/'), ['https://cdn.example/files/shenhe8_2160p.mp4']);
  assert.deepEqual(extractAnchors(PAGE, ['khongco'], 'https://site.example/'), []);
  assert.deepEqual(extractAnchors(PAGE, [], 'https://site.example/'), []);
  assert.deepEqual(extractAnchors(null, ['dl'], 'https://site.example/'), []);
});
test('pickLink: lọc theo chuỗi (không phân biệt hoa thường, cả bản giải mã), mặc định lấy link đầu, chỉ https', () => {
  const l = ['https://cdn.example/a_1080p.mp4', 'https://cdn.example/a_2160p.mp4', 'https://cdn.example/a_2160p.mp4', 'http://cdn.example/a_4k.mp4', 'https://cdn.example/t%C3%AAn_2160P.mp4'];
  assert.deepEqual(pickLink(l, '2160p.mp4'), { url: 'https://cdn.example/a_2160p.mp4', total: 3, matched: 2 });
  assert.equal(pickLink(l, 'shenhe').url, null);
  assert.equal(pickLink(l, 'shenhe').reason, 'nomatch');
  assert.equal(pickLink(l, 'tên_2160p').url, 'https://cdn.example/t%C3%AAn_2160P.mp4');
  assert.equal(pickLink(l, '').url, 'https://cdn.example/a_1080p.mp4');
  assert.equal(pickLink(['http://x.example/a.mp4'], null).reason, 'none');
  assert.equal(pickLink([], 'x').reason, 'none');
});
test('browserHeaders doc, nameFromUrl, cookieHeaderFrom', () => {
  const h = browserHeaders('https://site.example/video/1', { doc: true });
  assert.equal(h['Sec-Fetch-Dest'], 'document'); assert.equal(h['Sec-Fetch-Mode'], 'navigate'); assert.match(h.Accept, /^text\/html/);
  assert.equal(nameFromUrl('https://cdn.example/f/shenhe8_2160p.mp4?tok=1'), 'shenhe8_2160p');
  assert.equal(nameFromUrl('https://cdn.example/'), null);
  assert.equal(cookieHeaderFrom(['sid=abc; Path=/; HttpOnly', 'x=1; Secure', 'rac\nroi=1', '=bad']), 'sid=abc; x=1');
  assert.equal(cookieHeaderFrom(undefined), '');
});
