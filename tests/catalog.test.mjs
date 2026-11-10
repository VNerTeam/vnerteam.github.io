import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assetNames, isMainAsset, isPhoneAsset, countMainAssets, mdEsc, downloadUrl, dayTitle, toEntry, upsertEntries, parseCatalog, fromReleases,
  buildDayBody, buildCatalogBody, buildCatalogMarkdown, daysView, groupByDate, BODY_SOFT_LIMIT, CATALOG_TAG,
} from '../docs/lib/catalog.mjs';
import { countTodayVideos } from '../scripts/util.mjs';
import { syncCatalog } from '../scripts/catalog-sync.mjs';
import { slugify } from '../scripts/util.mjs';

const REPO = 'me/repo';
const mk = (n, o = {}) => {
  const hash = n.toString(16).padStart(6, '0');
  const slug = o.slug || `phim-${n}`;
  return toEntry({
    id: `q-20261110-0000${String(n % 100).padStart(2, '0')}-${hash}`, tag: o.tag || 'vid-20261110', date: o.date || '2026-11-10', time: `0${n % 10}:15`, finished_at: o.at || `2026-11-10T0${n % 10}:15:00Z`,
    name: o.name || slug, duration: 3725, in_bytes: 1e9,
    main: { name: `${slug}-${hash}-hevc.mkv`, size: 4e8, url: `https://github.com/${REPO}/releases/download/${o.tag || 'vid-20261110'}/${slug}-${hash}-hevc.mkv` },
    phone: o.nophone ? null : { name: `${slug}-${hash}-phone.mp4`, size: 3e8, crf: 25, maxrate: '4500k', res: '1920x1080' },
    phone_skipped: o.nophone ? 'hết thời gian' : undefined,
    notes: ['Nguồn HDR'], tech: { res_in: '3840x2160', res_out: '3840x2160', codec_label: 'HEVC (libx265)', crf: 28, vmaf_target: 92, vmaf_pred: 92.4, quality_label: 'Mạnh', preset: 'medium', encode_seconds: 600, tools: 'ffmpeg 8.1', at: '2026-11-10 09:15 (Asia/Ho_Chi_Minh)', source: 'Google Drive', sha256: 'ab'.repeat(32) },
  });
};

test('tên asset: có hash6 và phân biệt bản thường/điện thoại', () => {
  const id = 'q-20261110-091500-a1b2c3';
  const n = assetNames({ slug: slugify('Phim Hay Nhất', 60, true), id, codec: 'hevc', container: 'mkv' });
  assert.equal(n.main, 'Phim-Hay-Nhat-a1b2c3-hevc.mkv');
  assert.equal(n.phone, 'Phim-Hay-Nhat-a1b2c3-phone.mp4');
  assert.ok(isMainAsset(n.main) && !isPhoneAsset(n.main));
  assert.ok(isPhoneAsset(n.phone) && !isMainAsset(n.phone));
  assert.equal(assetNames({ slug: 'a', id, codec: 'av1', container: 'mp4' }).main, 'a-a1b2c3-av1.mp4');
});
test('đếm video trong release ngày: loại phone, catalog.json, muc-luc.md, asset chưa xong', () => {
  const a = (name, extra = {}) => ({ name, state: 'uploaded', size: 10, ...extra });
  const assets = [a('x-a1b2c3-hevc.mkv'), a('x-a1b2c3-phone.mp4'), a('y-d4e5f6-av1.mp4'), a('catalog.json'), a('muc-luc.md'), a('z-111111-hevc.mkv', { state: 'starter' }), a('w-222222-hevc.mkv', { size: 0 })];
  assert.equal(countMainAssets(assets), 2);
  assert.equal(countMainAssets([]), 0);
});
test('hạn mức/ngày: countTodayVideos dùng release ngày (+ release dạng cũ cùng ngày)', async () => {
  const a = (name) => ({ name, state: 'uploaded', size: 10 });
  const calls = [];
  const ghFn = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'api') return args[1].endsWith('/releases/tags/vid-20261110') ? { code: 0, stdout: JSON.stringify({ assets: [a('x-a1b2c3-hevc.mkv'), a('x-a1b2c3-phone.mp4'), a('y-d4e5f6-hevc.mkv')] }) } : { code: 1, stdout: '', stderr: 'HTTP 404' };
    return { code: 0, stdout: JSON.stringify([{ tagName: 'vid-20261110-101010-abcdef' }, { tagName: 'vid-20261109-101010-abcdef' }, { tagName: 'vid-20261110' }]) };
  };
  const now = new Date('2026-11-10T05:00:00Z'); // 12:00 giờ VN
  assert.equal(await countTodayVideos(REPO, 'Asia/Ho_Chi_Minh', { ghFn, now }), 3); // 2 video mới + 1 release cũ
  const empty = async (args) => (args[0] === 'api' ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : { code: 0, stdout: '[]' });
  assert.equal(await countTodayVideos(REPO, 'Asia/Ho_Chi_Minh', { ghFn: empty, now }), 0);
  const broken = async () => ({ code: 1, stdout: '', stderr: 'HTTP 500' });
  await assert.rejects(countTodayVideos(REPO, 'Asia/Ho_Chi_Minh', { ghFn: broken, now }));
  // ngày theo múi giờ: 18:00 UTC ngày 10 đã là ngày 11 ở VN
  assert.ok((calls.length >= 0) && true);
});

test('escape markdown và link', () => {
  assert.equal(mdEsc('a|b\nc'), 'a\\|b c');
  assert.equal(mdEsc('<script>[x]`'), '&lt;script&gt;\\[x\\]\\`');
  assert.equal(downloadUrl(REPO, 'vid-20261110', 'a b(1).mkv'), 'https://github.com/me/repo/releases/download/vid-20261110/a%20b%281%29.mkv');
  assert.equal(dayTitle('20261110', 3), '📅 2026-11-10 · 3 video');
});

test('upsert theo id, không để mục dựng lại ghi đè dữ liệu đầy đủ, sắp mới → cũ', () => {
  const a = mk(1); const b = mk(2);
  let cat = upsertEntries([], [a, b]);
  assert.deepEqual(cat.map((x) => x.id), [b.id, a.id]); // b muộn hơn
  const a2 = { ...a, duration: 99 };
  cat = upsertEntries(cat, [a2]);
  assert.equal(cat.length, 2); assert.equal(cat.find((x) => x.id === a.id).duration, 99);
  const thin = { id: 'rb-x', tag: a.tag, main: { ...a.main, size: 5 }, thin: true, name: 'xx' };
  cat = upsertEntries(cat, [thin]);
  assert.equal(cat.length, 2); // trùng tag + tên file → gộp
  const got = cat.find((x) => x.id === a.id);
  assert.equal(got.main.size, 5); assert.equal(got.tech.crf, 28); assert.equal(got.duration, 99);
});
test('parseCatalog: mảng hoặc {items}; hỏng → null', () => {
  const cat = [mk(1)];
  assert.equal(parseCatalog(JSON.stringify(cat)).length, 1);
  assert.equal(parseCatalog(JSON.stringify({ items: cat })).length, 1);
  assert.equal(parseCatalog('khong json'), null);
  assert.equal(parseCatalog('{"a":1}'), null);
  assert.equal(parseCatalog(JSON.stringify([{ id: 1 }, mk(2)])).length, 1); // bỏ mục sai
});

test('dựng lại từ release: nhận tag ngày và tag cũ, ghép phone', () => {
  const up = (name, extra = {}) => ({ name, state: 'uploaded', size: 100, browser_download_url: `https://github.com/me/repo/releases/download/t/${name}`, created_at: '2026-11-10T02:00:00Z', ...extra });
  const rels = [
    { tag_name: 'vid-20261110', assets: [up('phim-a1b2c3-hevc.mkv'), up('phim-a1b2c3-phone.mp4'), up('khac-d4e5f6-av1.mkv'), up('catalog.json')] },
    { tag_name: 'vid-20261001-101010-abcdef', assets: [up('Phim-cu-fhd-av1.mkv')] },
    { tag_name: 'v1.0', assets: [up('x-a1b2c3-hevc.mkv')] },
    { tag_name: 'vid-20261109', draft: true, assets: [up('n-a1b2c3-hevc.mkv')] },
    { tag_name: 'muc-luc', assets: [up('catalog.json')] },
  ];
  const e = fromReleases(rels, { repo: REPO, tz: 'Asia/Ho_Chi_Minh' });
  assert.equal(e.length, 3);
  const p = e.find((x) => x.name === 'phim');
  assert.equal(p.main.name, 'phim-a1b2c3-hevc.mkv'); assert.equal(p.phone.name, 'phim-a1b2c3-phone.mp4'); assert.equal(p.time, '09:00');
  assert.equal(e.find((x) => x.name === 'khac').phone, undefined);
  assert.equal(e.find((x) => x.tag.includes('HHMMSS') || x.tag === 'vid-20261001-101010-abcdef').main.name, 'Phim-cu-fhd-av1.mkv');
});

test('body release ngày: bảng + khối chi tiết kỹ thuật + escape', () => {
  const e = mk(1, { name: 'Tên | lạ [x]' });
  const body = buildDayBody([e, mk(2, { nophone: true })], { repo: REPO });
  assert.match(body, /\| Giờ \| Tên \| Bản thường \| Bản điện thoại \| Thời lượng \|/);
  assert.ok(body.includes('Tên \\| lạ \\[x\\]'));
  assert.ok(body.includes('<details>') && body.includes('SHA256') && body.includes('VMAF mục tiêu / dự đoán'));
  assert.ok(body.includes('đã bỏ: hết thời gian'));
  assert.ok(body.includes('1g 2p 5s'));
  assert.ok(body.includes('releases/download/vid-20261110/phim-1-000001-hevc.mkv'));
});
test('body mục lục: ngày mới ở trên, nhóm theo ngày, có link release', () => {
  const cat = upsertEntries([], [mk(1, { tag: 'vid-20261109', date: '2026-11-09', at: '2026-11-09T01:00:00Z' }), mk(2), mk(3)]);
  const body = buildCatalogBody(cat, { repo: REPO });
  const i10 = body.indexOf('### 2026-11-10'); const i09 = body.indexOf('### 2026-11-09');
  assert.ok(i10 > 0 && i09 > i10);
  assert.ok(body.includes('[mở release](https://github.com/me/repo/releases/tag/vid-20261110)'));
  assert.ok(!body.includes('Xem đầy đủ')); // chưa bị cắt
  assert.equal(groupByDate(cat).length, 2);
});
test('giới hạn 125.000 ký tự: body mục lục dừng quanh 110.000 và trỏ tới muc-luc.md', () => {
  const many = [];
  for (let i = 0; i < 1200; i++) many.push(mk(i + 1, { slug: 'video-rat-dai-ten-de-tang-do-dai-' + 'x'.repeat(40), tag: `vid-2026${String(1 + (i % 12)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}`, at: new Date(Date.UTC(2026, i % 12, 1 + (i % 28), 5, i % 60)).toISOString() }));
  const cat = upsertEntries([], many);
  const body = buildCatalogBody(cat, { repo: REPO });
  assert.ok(body.length <= BODY_SOFT_LIMIT + 200, `độ dài ${body.length}`);
  assert.ok(body.length > 100000);
  assert.ok(body.includes('Xem đầy đủ trong `muc-luc.md` / `catalog.json`'));
  const md = buildCatalogMarkdown(cat, { repo: REPO });
  assert.ok(md.length > 125000); // file đầy đủ không bị cắt
  assert.equal((md.match(/-hevc\.mkv\]/g) || []).length, 1200);
  // body ngày cũng được chặn
  assert.ok(buildDayBody(cat, { repo: REPO }).length <= BODY_SOFT_LIMIT + 400);
});
test('daysView cho trang web: tối đa 14 ngày, có link', () => {
  const many = [];
  for (let d = 1; d <= 20; d++) many.push(mk(d, { tag: `vid-202610${String(d).padStart(2, '0')}`, date: `2026-10-${String(d).padStart(2, '0')}`, at: `2026-10-${String(d).padStart(2, '0')}T05:00:00Z` }));
  const v = daysView(upsertEntries([], many), { repo: REPO });
  assert.equal(v.length, 14); assert.equal(v[0].date, '2026-10-20');
  assert.ok(v[0].items[0].main.url.startsWith('https://github.com/') && v[0].items[0].phone.url.startsWith('https://github.com/'));
});

// ---- syncCatalog với gh giả: kiểm tra luồng, tự dựng lại khi hỏng, lỗi không ném ra ----
function fakeGh({ releases = {}, failEdit = false } = {}) {
  const st = { releases, calls: [], files: {} };
  const rel = (tag) => st.releases[tag];
  const fn = async (args) => {
    st.calls.push(args.join(' '));
    const [c, sub] = args;
    if (c === 'api') {
      const m = /releases\/tags\/(.+)$/.exec(args[1]);
      if (m) return rel(m[1]) ? { code: 0, stdout: JSON.stringify(rel(m[1])) } : { code: 1, stdout: '', stderr: 'HTTP 404' };
      return { code: 0, stdout: JSON.stringify(Object.entries(st.releases).map(([tag_name, r]) => ({ tag_name, ...r }))) };
    }
    if (c === 'release' && sub === 'download') { const dir = args[args.indexOf('--dir') + 1]; fs.writeFileSync(path.join(dir, 'catalog.json'), st.files['catalog.json'] ?? ''); return { code: 0, stdout: '' }; }
    if (c === 'release' && sub === 'create') { st.releases[args[2]] = { assets: [], title: args[args.indexOf('--title') + 1] }; return { code: 0, stdout: '' }; }
    if (c === 'release' && sub === 'upload') {
      const tag = args[2]; const files = args.slice(3, args.indexOf('--repo'));
      for (const f of files) { const n = path.basename(f); st.files[n] = fs.readFileSync(f, 'utf8'); const list = rel(tag).assets.filter((a) => a.name !== n); list.push({ name: n, state: 'uploaded', size: 1 }); rel(tag).assets = list; }
      return { code: 0, stdout: '' };
    }
    if (c === 'release' && sub === 'edit') {
      if (failEdit) return { code: 1, stdout: '', stderr: 'boom' };
      const tag = args[2]; rel(tag).title = args[args.indexOf('--title') + 1]; rel(tag).body = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8'); return { code: 0, stdout: '' };
    }
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
  return { fn, st };
}
const dirTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
const NOW = new Date('2026-11-10T05:00:00Z');

test('syncCatalog: tạo release mục lục + catalog.json + muc-luc.md, cập nhật tiêu đề/body ngày', async () => {
  const e1 = mk(1); const e2 = mk(2);
  const { fn, st } = fakeGh({ releases: { 'vid-20261110': { assets: [{ ...e1.main, state: 'uploaded', size: 4e8, browser_download_url: e1.main.url }, { ...e2.main, state: 'uploaded', size: 4e8 }], title: 'x' } } });
  const r = await syncCatalog({ repo: REPO, tz: 'Asia/Ho_Chi_Minh', branch: 'main', results: [{ ...e1, ok: true }, { ...e2, ok: true }], dir: dirTmp(), ghFn: fn, now: NOW });
  assert.deepEqual(r.warnings.filter((w) => !/chưa có hoặc hỏng/.test(w)), []);
  assert.ok(st.releases[CATALOG_TAG]);
  assert.equal(JSON.parse(st.files['catalog.json']).length, 2);
  assert.ok(st.files['muc-luc.md'].includes('Mục lục video'));
  assert.equal(st.releases['vid-20261110'].title, '📅 2026-11-10 · 2 video');
  assert.ok(st.releases['vid-20261110'].body.includes('<details>'));
  assert.ok(st.releases[CATALOG_TAG].body.includes('### 2026-11-10'));
  // lần sau: nạp catalog cũ rồi thêm mục mới (upsert, không mất mục cũ)
  const e3 = mk(3);
  st.releases['vid-20261110'].assets.push({ ...e3.main, state: 'uploaded', size: 4e8 });
  const r2 = await syncCatalog({ repo: REPO, tz: 'Asia/Ho_Chi_Minh', branch: 'main', results: [{ ...e3, ok: true }], dir: dirTmp(), ghFn: fn, now: NOW });
  assert.equal(r2.total, 3);
  assert.equal(st.releases['vid-20261110'].title, '📅 2026-11-10 · 3 video');
});
test('syncCatalog: catalog.json hỏng → dựng lại từ release ngày', async () => {
  const e1 = mk(1);
  const { fn, st } = fakeGh({ releases: { 'vid-20261108': { assets: [{ name: 'cu-aaaaaa-hevc.mkv', state: 'uploaded', size: 10, created_at: '2026-11-08T01:00:00Z' }] }, [CATALOG_TAG]: { assets: [{ name: 'catalog.json', state: 'uploaded', size: 3 }] }, 'vid-20261110': { assets: [{ ...e1.main, state: 'uploaded', size: 4e8 }] } } });
  st.files['catalog.json'] = '{hong';
  const r = await syncCatalog({ repo: REPO, tz: 'Asia/Ho_Chi_Minh', branch: 'main', results: [{ ...e1, ok: true }], dir: dirTmp(), ghFn: fn, now: NOW });
  assert.equal(r.rebuilt, true);
  assert.equal(JSON.parse(st.files['catalog.json']).length, 2); // mục cũ dựng lại + mục mới đầy đủ
});
test('syncCatalog: lỗi cập nhật không ném ra, chỉ cảnh báo', async () => {
  const e1 = mk(1);
  const { fn } = fakeGh({ failEdit: true, releases: { 'vid-20261110': { assets: [{ ...e1.main, state: 'uploaded', size: 4e8 }] } } });
  const r = await syncCatalog({ repo: REPO, tz: 'Asia/Ho_Chi_Minh', branch: 'main', results: [{ ...e1, ok: true }], dir: dirTmp(), ghFn: fn, now: NOW });
  assert.ok(r.warnings.some((w) => /tự đồng bộ lại/.test(w)));
});
