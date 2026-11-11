import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  extractTitleText, displayNameFromTitle, filenameFromContentDisposition, filenameFromUrl, filenameFromResponse, displayNameFromFile, cleanFileName, looksLikeVideoName,
} from '../scripts/fetch-core.mjs';
import { fileNameFor, nameFor, resolveAll, applyNames } from '../scripts/resolve-names.mjs';
import { parseTitleSelector } from '../docs/lib/providers.mjs';
import { slugify } from '../scripts/util.mjs';
import { validateItem, STATUSES } from '../docs/lib/schema.mjs';

test('Content-Disposition: filename*, filename="", không ngoặc, mạng UTF-8 vỡ latin1, chống đường dẫn', () => {
  assert.equal(filenameFromContentDisposition('attachment; filename="Phim A_2160p.mp4"'), 'Phim A_2160p.mp4');
  assert.equal(filenameFromContentDisposition("attachment; filename*=UTF-8''Phim%20T%E1%BA%ADp%201.mkv"), 'Phim Tập 1.mkv');
  assert.equal(filenameFromContentDisposition("attachment; filename=\"x.mp4\"; filename*=UTF-8''Th%E1%BA%ADt.mp4"), 'Thật.mp4'); // filename* thắng
  assert.equal(filenameFromContentDisposition('attachment; filename=clip.mp4; size=3'), 'clip.mp4');
  assert.equal(filenameFromContentDisposition(`attachment; filename="${Buffer.from('Tập 1.mp4', 'utf8').toString('latin1')}"`), 'Tập 1.mp4');
  assert.equal(filenameFromContentDisposition('attachment; filename="../../etc/passwd"'), 'passwd');
  assert.equal(filenameFromContentDisposition('attachment; filename="..\\\\..\\\\a.mp4"'), 'a.mp4');
  assert.equal(filenameFromContentDisposition('attachment'), null);
  assert.equal(filenameFromContentDisposition(null), null);
  assert.equal(cleanFileName('..'), null);
  assert.equal(cleanFileName('a\nb.mp4'), 'ab.mp4');
});
test('tên từ phản hồi: Content-Disposition > đuôi video của URL cuối; KHÔNG dùng query', () => {
  assert.equal(filenameFromResponse('attachment; filename="goc.mp4"', 'https://cdn.example/x/khac.mp4'), 'goc.mp4');
  assert.equal(filenameFromResponse(null, 'https://cdn.example/x/Phim%20Hay_1080p.mp4?download_filename=SAI.mp4'), 'Phim Hay_1080p.mp4');
  assert.equal(filenameFromResponse(null, 'https://cdn.example/get_file/123?download_filename=SAI.mp4'), null);
  assert.equal(filenameFromUrl('https://cdn.example/'), null);
  assert.equal(looksLikeVideoName('a.MKV'), true); assert.equal(looksLikeVideoName('a.txt'), false);
});
test('tên hiển thị giữ dấu cách, bỏ đuôi, ≤ 80 ký tự; tên Release đổi dấu cách thành "-"', () => {
  assert.equal(displayNameFromFile('Phim Hay   Tập 1.mp4'), 'Phim Hay Tập 1');
  assert.equal(displayNameFromFile('shenhe8_2160p.mp4'), 'shenhe8_2160p');
  assert.equal(displayNameFromFile('a'.repeat(120) + '.mkv').length, 80);
  assert.equal(displayNameFromFile('.mp4'), null);
  assert.equal(displayNameFromFile(5), null);
  assert.equal(slugify(displayNameFromFile('Phim Hay Tập 1.mp4'), 60, true), 'Phim-Hay-Tap-1');
});

const hosts = [{ host: 'phim.example', allow_query: false, link_class: 'dl' }, { host: 'files.example', allow_query: true }];
const mockFetch = (handler) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  return () => { globalThis.fetch = real; };
};
const direct = (q = null) => ({ id: 'q-20261111-101010-a1b2c3', provider: 'direct_url', ref: { host: 'files.example', path: '/v/clip.mp4', query: q }, referer: null, link_match: null, label: null, status: 'naming' });

test('fileNameFor direct_url: Content-Disposition của phản hồi thật thắng tên trong query', async () => {
  const back = mockFetch(() => new Response(null, { status: 206, headers: { 'content-disposition': 'attachment; filename="Ten Goc.mp4"' } }));
  try { assert.equal(await fileNameFor(direct('download_filename=SAI.mp4'), hosts), 'Ten Goc.mp4'); } finally { back(); }
});
test('fileNameFor direct_url: bị chặn 403 thì dùng đuôi video trong đường dẫn, không thì tham số query là phương án cuối', async () => {
  let back = mockFetch(() => new Response('no', { status: 403 }));
  try { assert.equal(await fileNameFor(direct(), hosts), 'clip.mp4'); } finally { back(); }
  const it = { ...direct('download_filename=Ten%20Query.mp4'), ref: { host: 'files.example', path: '/get/123', query: 'download_filename=Ten%20Query.mp4' } };
  back = mockFetch(() => { throw new Error('mạng lỗi'); });
  try { assert.equal(await fileNameFor(it, hosts), 'Ten Query.mp4'); } finally { back(); }
});
test('fileNameFor page_link: tên từ href của thẻ a khớp "Lọc link", không gọi link tải (token)', async () => {
  const calls = [];
  const html = '<a class="dl" href="https://cdn.example/f/Phim_1080p.mp4?tok=1">1080</a><a class="dl" href="https://cdn.example/f/Phim_2160p.mp4?tok=2">4K</a>';
  const back = mockFetch((u) => { calls.push(u); return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }); });
  try {
    const it = { ...direct(), provider: 'page_link', ref: { host: 'phim.example', path: '/video/1', query: null }, link_match: '2160p' };
    assert.equal(await fileNameFor(it, hosts), 'Phim_2160p.mp4');
    assert.deepEqual(calls, ['https://phim.example/video/1']); // chỉ mở trang, không đụng link tải
  } finally { back(); }
});
test('fileNameFor gdrive: lấy từ <title>, bỏ hậu tố; trang đăng nhập → null', async () => {
  const it = { ...direct(), provider: 'gdrive', ref: { id: 'A'.repeat(25), resourcekey: null } };
  let back = mockFetch(() => new Response('<html><title>Phim &amp; Co.mp4 - Google Drive</title>', { status: 200 }));
  try { assert.equal(await fileNameFor(it, hosts), 'Phim & Co.mp4'); } finally { back(); }
  back = mockFetch(() => new Response('<title>Sign in - Google Accounts</title>', { status: 200 }));
  try { assert.equal(await fileNameFor(it, hosts), null); } finally { back(); }
});

test('resolveAll + applyNames: điền tên, lỗi từng mục không ảnh hưởng mục khác, không đè tên người dùng, mục naming nào cũng sang pending', async () => {
  const items = ['a', 'b', 'c'].map((x, i) => ({ ...direct(), id: `q-20261111-10101${i}-aaaaa${i}` }));
  const names = await resolveAll(items, hosts, async (it) => { if (it.id.endsWith('1')) throw new Error('hỏng'); return it.id.endsWith('2') ? { name: 'x'.repeat(100) + '.mp4', source: 'file' } : { name: 'Ten  Dep.mkv', source: 'file' }; });
  assert.deepEqual(names.get(items[0].id), { label: 'Ten Dep', source: 'file' });
  assert.deepEqual(names.get(items[1].id), { label: null, source: 'none' });
  assert.equal(names.get(items[2].id).label.length, 80);
  const queue = { version: 1, items: [{ ...items[0] }, { ...items[1] }, { ...items[2], label: 'Tui tự đặt' }, { ...items[0], id: 'q-20261111-999999-ffffff', status: 'pending' }] };
  assert.equal(applyNames(queue, names), true);
  assert.deepEqual(queue.items.map((i) => [i.status, i.label]), [['pending', 'Ten Dep'], ['pending', null], ['pending', 'Tui tự đặt'], ['pending', null]]);
  assert.equal(applyNames(queue, names), false);
  assert.ok(STATUSES.includes('naming'));
});

test('extractTitleText: chỉ lấy chữ trong thẻ (<h1 class="title">Name</h1> → Name)', () => {
  assert.equal(extractTitleText('<h1 class="title">Name</h1>', { tag: 'h1', classes: ['title'] }), 'Name');
  assert.equal(extractTitleText('<html><h1 class="logo">Site</h1><h1 class="title video main">  Phim &amp; Tập&nbsp;1 </h1></html>', { tag: 'h1', classes: ['title', 'video'] }), 'Phim & Tập 1');
  assert.equal(extractTitleText('<div class="ten"><span>A</span> <b>B</b><script>var x="<i>";</script><br>C</div>', { classes: ['ten'] }), 'A B C'); // không chỉ định thẻ: thẻ nào có class cũng được
  assert.equal(extractTitleText('<div class="t"><div>trong</div>ngoài</div><div class="t">sau</div>', { tag: 'div', classes: ['t'] }), 'trong ngoài'); // thẻ cùng tên lồng nhau
  assert.equal(extractTitleText('<h2 class="title">sai thẻ</h2><h1 class=title>Không ngoặc</h1>', { tag: 'h1', classes: ['title'] }), 'Không ngoặc');
  assert.equal(extractTitleText("<H1 CLASS='title'>Hoa</H1>", { tag: 'h1', classes: ['title'] }), 'Hoa');
  assert.equal(extractTitleText('<h1 class="title">   </h1><h1 class="title">Thứ hai</h1>', { tag: 'h1', classes: ['title'] }), 'Thứ hai'); // bỏ thẻ rỗng
  assert.equal(extractTitleText('<h1 class="titlex">x</h1><h1>y</h1>', { tag: 'h1', classes: ['title'] }), null); // class phải khớp nguyên từ
  assert.equal(extractTitleText('<h1 class="title">chưa đóng', { tag: 'h1', classes: ['title'] }), null);
  assert.equal(extractTitleText('<img class="title" src="a.png"><input class="title">', { classes: ['title'] }), null); // thẻ rỗng bị bỏ qua
  assert.equal(extractTitleText('<h1 class="title">x</h1>', { tag: 'h1', classes: [] }), null);
  assert.equal(extractTitleText(null, { tag: 'h1', classes: ['title'] }), null);
  assert.equal(displayNameFromTitle('  Phim v2.0   Final.Cut \n'), 'Phim v2.0 Final.Cut'); // tiêu đề không bị cắt "đuôi file"
  assert.equal(displayNameFromTitle('x'.repeat(200)).length, 80);
  assert.equal(displayNameFromTitle('  '), null);
});
test('parseTitleSelector: title_class bắt buộc, title_tag tuỳ chọn và phải hợp lệ', () => {
  assert.deepEqual(parseTitleSelector({ title_tag: 'H1', title_class: 'title video' }), { tag: 'h1', classes: ['title', 'video'] });
  assert.deepEqual(parseTitleSelector({ title_class: 'ten' }), { tag: null, classes: ['ten'] });
  assert.deepEqual(parseTitleSelector({ title_tag: '', title_class: 'ten' }), { tag: null, classes: ['ten'] });
  for (const bad of [null, {}, { title_tag: 'h1' }, { title_class: '.x' }, { title_tag: 'h1>', title_class: 'x' }, { title_tag: 'img', title_class: 'x' }, { title_tag: 5, title_class: 'x' }]) assert.equal(parseTitleSelector(bad), null, JSON.stringify(bad));
});

const hostsT = [
  { host: 'phim.example', allow_query: false, link_class: 'dl', title_tag: 'h1', title_class: 'title video' },
  { host: 'video.example', allow_query: false, ytdlp: true, title_class: 'ten' },
  { host: 'files.example', allow_query: true, title_class: 'ten' },
  { host: 'khac.example', allow_query: false, link_class: 'dl' },
];
const pageItem = (host, provider = 'page_link') => ({ ...direct(), provider, ref: { host, path: '/v/1', query: null } });
const pageHtml = '<h1 class="title video">Tên Phim Hay</h1><a class="dl" href="https://cdn.example/f/ten_file_goc.mp4?t=1">tải</a>';

test('nameFor: tiêu đề trong thẻ+class thắng tên file; chỉ đọc trang, không gọi link tải', async () => {
  const calls = [];
  const back = mockFetch((u) => { calls.push(u); return new Response(pageHtml, { status: 200, headers: { 'content-type': 'text/html' } }); });
  try {
    assert.deepEqual(await nameFor(pageItem('phim.example'), hostsT), { name: 'Tên Phim Hay', source: 'title' });
    assert.deepEqual(calls, ['https://phim.example/v/1']);
  } finally { back(); }
});
test('nameFor: không có thẻ+class (hoặc host không cấu hình) thì quay về tên file gốc; không có gì → none', async () => {
  let back = mockFetch(() => new Response('<h1>Không class</h1><a class="dl" href="https://cdn.example/f/ten_file_goc.mp4?t=1">tải</a>', { status: 200 }));
  try {
    assert.deepEqual(await nameFor(pageItem('phim.example'), hostsT), { name: 'ten_file_goc.mp4', source: 'file' });
    assert.deepEqual(await nameFor(pageItem('khac.example'), hostsT), { name: 'ten_file_goc.mp4', source: 'file' }); // host không có title_class
  } finally { back(); }
  back = mockFetch(() => new Response('<p>trống</p>', { status: 200 }));
  try { assert.deepEqual(await nameFor(pageItem('phim.example'), hostsT), { name: null, source: 'none' }); } finally { back(); }
  back = mockFetch(() => new Response('no', { status: 403 }));
  try { assert.deepEqual(await nameFor(pageItem('phim.example'), hostsT), { name: null, source: 'none' }); } finally { back(); }
});
test('nameFor: link yt-dlp cũng lấy tiêu đề theo thẻ+class; link file trực tiếp thì bỏ qua title_class', async () => {
  let back = mockFetch(() => new Response('<span class="ten">Video Từ Trang</span>', { status: 200 }));
  try { assert.deepEqual(await nameFor(pageItem('video.example', 'ytdlp'), hostsT), { name: 'Video Từ Trang', source: 'title' }); } finally { back(); }
  back = mockFetch((u) => (u.includes('files.example') ? new Response(null, { status: 206, headers: { 'content-disposition': 'attachment; filename="goc.mp4"' } }) : new Response('<span class="ten">SAI</span>', { status: 200 })));
  try { assert.deepEqual(await nameFor({ ...direct() }, hostsT), { name: 'goc.mp4', source: 'file' }); } finally { back(); }
});

test('applyNames overwrite: ghi đè tên của mọi mục lấy được tên mới, không xoá tên cũ khi lấy không được, giữ nguyên trạng thái', () => {
  const mk = (id, status, label) => ({ ...direct(), id, status, label });
  const queue = { version: 1, items: [mk('q-20261111-100001-a00001', 'pending', 'Tên cũ 1'), mk('q-20261111-100002-a00002', 'failed', 'Tên cũ 2'), mk('q-20261111-100003-a00003', 'naming', null), mk('q-20261111-100004-a00004', 'pending', 'Giữ nguyên')] };
  const names = new Map([
    ['q-20261111-100001-a00001', { label: 'Tên mới 1', source: 'title' }], ['q-20261111-100002-a00002', { label: 'Tên mới 2', source: 'file' }],
    ['q-20261111-100003-a00003', { label: 'Tên mới 3', source: 'title' }], ['q-20261111-100004-a00004', { label: null, source: 'none' }],
  ]);
  const normal = JSON.parse(JSON.stringify(queue));
  assert.equal(applyNames(normal, names), true); // mặc định: chỉ mục naming
  assert.deepEqual(normal.items.map((i) => [i.status, i.label]), [['pending', 'Tên cũ 1'], ['failed', 'Tên cũ 2'], ['pending', 'Tên mới 3'], ['pending', 'Giữ nguyên']]);
  assert.equal(applyNames(queue, names, { overwrite: true }), true);
  assert.deepEqual(queue.items.map((i) => [i.status, i.label]), [['pending', 'Tên mới 1'], ['failed', 'Tên mới 2'], ['pending', 'Tên mới 3'], ['pending', 'Giữ nguyên']]);
  assert.equal(applyNames(queue, names, { overwrite: true }), false);
});
test('names.yml có tham số overwrite (mặc định false) và truyền cho script', () => {
  const y = fs.readFileSync('.github/workflows/names.yml', 'utf8');
  assert.match(y, /inputs:\s+overwrite:[\s\S]*?type: boolean[\s\S]*?default: false/);
  assert.match(y, /OVERWRITE: \$\{\{ inputs\.overwrite \}\}/);
});

test('plan.mjs: mục naming mới thì chờ, quá 15 phút thì vẫn được chọn (không kẹt mãi)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  fs.cpSync(path.resolve('config'), path.join(dir, 'config'), { recursive: true });
  const mk = (id, ago) => ({ id, provider: 'direct_url', ref: { host: 'files.example', path: '/a.mp4', query: null }, label: null,
    options: { resolution: 'original', quality: 'strong', codec: 'hevc', fps_cap: null, audio: 'opus_128', container: 'mkv', phone: true, fetch_mode: 'auto', min_vmaf: null },
    status: 'naming', attempts: 0, ladder_start: 0, last_error: null, added_at: new Date(Date.now() - ago).toISOString() });
  fs.writeFileSync(path.join(dir, 'config/allowed-hosts.json'), JSON.stringify({ hosts: [{ host: 'files.example', allow_query: false }] }));
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ version: 1, items: [mk('q-20261111-100000-aaaaaa', 60 * 1000), mk('q-20261111-100001-bbbbbb', 20 * 60 * 1000)] }));
  const out = path.join(dir, 'out.txt');
  fs.writeFileSync(out, '');
  const r = spawnSync(process.execPath, [path.resolve('scripts/plan.mjs')], { cwd: dir, encoding: 'utf8', env: { ...process.env, MODE: 'dry_run', GITHUB_OUTPUT: out, GITHUB_REPOSITORY: 'o/r', GITHUB_STEP_SUMMARY: path.join(dir, 'sum.md') } });
  assert.equal(r.status, 0, r.stderr);
  const o = fs.readFileSync(out, 'utf8');
  const m = /matrix<<.*\n([\s\S]*?)\n[A-Za-z0-9_=]+\n/.exec(o) || /matrix=(.*)/.exec(o);
  const ids = JSON.parse(m[1]).include.map((x) => x.id);
  assert.deepEqual(ids, ['q-20261111-100001-bbbbbb']);
  fs.rmSync(dir, { recursive: true, force: true });
});
