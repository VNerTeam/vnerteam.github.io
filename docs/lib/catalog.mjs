// Release theo ngày + release mục lục. Chỉ chứa logic thuần (không gọi mạng/đĩa) để dùng chung
// cho script trên runner, Cloudflare Worker và test.
import { fmtBytes, fmtDur } from './format.mjs';

export const CATALOG_TAG = 'muc-luc';
export const CATALOG_TITLE = '📚 Mục lục video';
export const CATALOG_JSON = 'catalog.json';
export const CATALOG_MD = 'muc-luc.md';
export const BODY_SOFT_LIMIT = 110000; // GitHub cho tối đa ~125.000 ký tự trong phần mô tả
export const DAY_TAG_RE = /^vid-(\d{4})(\d{2})(\d{2})$/;
export const LEGACY_TAG_RE = /^vid-(\d{8})-(\d{6})-([0-9a-f]{6})$/;
// Tên asset: {slug}-{hash6}[-{cao}p[{fps}]]-{codec}.{ext} (bản thường) và {slug}-{hash6}[-{cao}p[{fps}]][-h264]-phone.mp4 (bản điện thoại).
// Phần độ phân giải/codec là tuỳ chọn trong regex để vẫn nhận ra các asset đặt tên kiểu cũ ({slug}-{hash6}-{codec}.{ext}, {slug}-{hash6}-phone.mp4).
const RES_PART = '(?:-\\d{3,4}p(?:\\d{2,3})?)?';
const MAIN_RE = new RegExp(`^(.+)-([0-9a-f]{6})${RES_PART}-(av1|hevc)\\.(mkv|mp4)$`);
const PHONE_RE = new RegExp(`^(.+)-([0-9a-f]{6})${RES_PART}(?:-h264)?-phone\\.mp4$`);
const VIDEO_EXT_RE = /\.(mkv|mp4|webm|mov)$/i;

// ---------- tag, tên asset ----------
export const dayTagOf = (yyyymmdd) => `vid-${yyyymmdd}`;
export const dateDash = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
export const dayTitle = (yyyymmdd, n) => `📅 ${dateDash(yyyymmdd)} · ${n} video`;
export const hash6Of = (id) => String(id).slice(-6);
// Phần thông số trong tên file: chiều cao THỰC của video ra (cạnh ngắn, vd 2160p/1080p), kèm fps nếu có giới hạn fps (vd 1080p30). Thiếu chiều cao thì bỏ phần này.
export const resTag = (height, fps) => (Number.isFinite(height) && height > 0 ? `-${Math.round(height)}p${Number.isFinite(fps) && fps > 0 ? Math.round(fps) : ''}` : '');
// Bản thường: {slug}-{hash6}-{cao}p[fps]-{codec}.{ext}. Bản điện thoại có độ phân giải RIÊNG (thường bị ép về ≤ 1920 cạnh dài) nên truyền phoneHeight riêng.
export function phoneAssetName({ slug, id, height, fps }) {
  return `${slug}-${hash6Of(id)}${resTag(height, fps)}${Number.isFinite(height) && height > 0 ? '-h264' : ''}-phone.mp4`;
}
export function assetNames({ slug, id, codec, container, height, fps, phoneHeight }) {
  return { main: `${slug}-${hash6Of(id)}${resTag(height, fps)}-${codec}.${container}`, phone: phoneAssetName({ slug, id, height: phoneHeight, fps }) };
}
export const isPhoneAsset = (name) => PHONE_RE.test(name);
export const isMainAsset = (name) => MAIN_RE.test(name);
// Tách tên bản thường → { slug, hash6 }, hoặc null nếu không đúng dạng.
export function parseMainName(name) {
  const m = MAIN_RE.exec(String(name));
  return m ? { slug: m[1], hash6: m[2], codec: m[3], container: m[4] } : null;
}
// Bản điện thoại có đi cùng bản thường này không (cùng slug + hash6; độ phân giải/codec trong tên có thể khác nhau).
export function isPhoneOf(mainName, phoneName) {
  const m = MAIN_RE.exec(String(mainName));
  const p = PHONE_RE.exec(String(phoneName));
  return !!m && !!p && m[1] === p[1] && m[2] === p[2];
}
// Số VIDEO trong release ngày = số asset bản thường đã upload xong (không tính -phone.mp4, catalog.json, muc-luc.md)
export function countMainAssets(assets) {
  return (assets || []).filter((a) => isMainAsset(a.name) && (a.state === undefined || a.state === 'uploaded') && (a.size === undefined || a.size > 0)).length;
}

// ---------- link, escape ----------
const encPath = (s) => encodeURIComponent(s).replace(/[()']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const downloadUrl = (repo, tag, name) => `https://github.com/${repo}/releases/download/${encPath(tag)}/${encPath(name)}`;
export const releaseUrl = (repo, tag) => `https://github.com/${repo}/releases/tag/${encPath(tag)}`;
const MD_MAP = { '|': '\\|', '[': '\\[', ']': '\\]', '<': '&lt;', '>': '&gt;', '`': '\\`', '\\': '\\\\' };
export const mdEsc = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/[|[\]<>`\\]/g, (c) => MD_MAP[c]);

// ---------- thời gian theo múi giờ ----------
export function tzHM(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(d)) o[p.type] = p.value;
  return `${o.hour}:${o.minute}`;
}

// ---------- mục trong catalog ----------
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : undefined);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
function cleanFile(f) {
  if (!f || typeof f !== 'object' || typeof f.name !== 'string') return null;
  return clean({ name: f.name.slice(0, 200), size: num(f.size), url: str(f.url, 500), res: str(f.res, 30), codec: str(f.codec, 30), crf: num(f.crf), vmaf: num(f.vmaf), maxrate: str(f.maxrate, 20), preset: str(f.preset, 20) });
}
// Chuẩn hoá kết quả của job nén thành mục catalog (chỉ giữ trường biết trước, cắt độ dài).
export function toEntry(r) {
  const tech = r.tech && typeof r.tech === 'object' ? Object.fromEntries(Object.entries(r.tech).filter(([, v]) => ['string', 'number'].includes(typeof v)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 300) : v])) : undefined;
  return clean({
    id: r.id, tag: r.tag, date: str(r.date, 10), time: str(r.time, 5), finished_at: str(r.finished_at, 40), name: str(r.name, 120), duration: num(r.duration), in_bytes: num(r.in_bytes),
    main: cleanFile(r.main), phone: cleanFile(r.phone), phone_skipped: str(r.phone_skipped, 200),
    notes: Array.isArray(r.notes) ? r.notes.filter((x) => typeof x === 'string').slice(0, 10).map((x) => x.slice(0, 300)) : undefined,
    tech: tech && Object.keys(tech).length ? tech : undefined, thin: r.thin === true ? true : undefined,
  });
}

export function sortEntries(list) {
  return [...list].sort((a, b) => String(b.finished_at || '').localeCompare(String(a.finished_at || '')) || String(b.id).localeCompare(String(a.id)));
}

// Thêm hoặc cập nhật theo id (hoặc theo cùng tag + tên file chính). Mục "thin" (dựng lại từ release) không ghi đè dữ liệu đầy đủ.
export function upsertEntries(catalog, entries) {
  const list = [...catalog];
  for (const raw of entries) {
    const { thin, ...e } = raw;
    const i = list.findIndex((x) => x.id === e.id || (x.tag === e.tag && x.main && e.main && x.main.name === e.main.name));
    if (i < 0) list.push(e);
    else if (thin) list[i] = { ...list[i], ...clean({ tag: e.tag, main: e.main, phone: e.phone }) };
    else list[i] = { ...list[i], ...e };
  }
  return sortEntries(list);
}

// Đọc catalog.json (mảng, hoặc object có items). Trả null nếu hỏng để nơi gọi dựng lại.
export function parseCatalog(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const arr = Array.isArray(j) ? j : j && Array.isArray(j.items) ? j.items : null;
  if (!arr) return null;
  return sortEntries(arr.filter((e) => e && typeof e.id === 'string' && typeof e.tag === 'string' && DAY_TAG_RE.test(e.tag) && e.main && typeof e.main.name === 'string'));
}

// Dựng mục từ danh sách release GitHub (API releases). Dùng khi chưa có/hỏng catalog.json và làm phương án dự phòng cho /api/status.
// Chấp nhận tag ngày `vid-YYYYMMDD` và tag cũ `vid-YYYYMMDD-HHMMSS-hash`. Thiếu siêu dữ liệu thì để trống.
export function fromReleases(releases, { repo, tz }) {
  const out = [];
  for (const rel of releases || []) {
    if (!rel || rel.draft || typeof rel.tag_name !== 'string') continue;
    const tag = rel.tag_name;
    const day = DAY_TAG_RE.exec(tag);
    const legacy = LEGACY_TAG_RE.exec(tag);
    if (!day && !legacy) continue;
    const ymd = day ? tag.slice(4) : legacy[1];
    const assets = (rel.assets || []).filter((a) => a && a.state === 'uploaded' && a.size > 0);
    const file = (a) => ({ name: a.name, size: a.size, url: a.browser_download_url || downloadUrl(repo, tag, a.name) });
    const made = (hash, slug, mainA, phoneA) => {
      const when = mainA.created_at || mainA.updated_at || rel.published_at || '';
      return {
        id: `rb-${ymd}-${hash}`, tag, date: dateDash(ymd), time: when ? tzHM(when, tz) : '', finished_at: when || `${dateDash(ymd)}T00:00:00Z`,
        name: slug, main: file(mainA), ...(phoneA ? { phone: file(phoneA) } : {}), thin: true,
      };
    };
    if (day) {
      for (const a of assets) {
        const m = MAIN_RE.exec(a.name);
        if (!m) continue;
        const phoneA = assets.find((p) => isPhoneOf(a.name, p.name));
        out.push(made(m[2], m[1], a, phoneA));
      }
    } else {
      for (const a of assets) if (VIDEO_EXT_RE.test(a.name)) out.push(made(legacy[3], a.name.replace(VIDEO_EXT_RE, ''), a, null));
    }
  }
  return sortEntries(out);
}

// ---------- bảng ----------
export function groupByDate(entries) {
  const m = new Map();
  for (const e of entries) {
    const d = e.date || (DAY_TAG_RE.test(e.tag) ? dateDash(e.tag.slice(4)) : '');
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(e);
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, items]) => ({ date, tag: items[0].tag, items: sortEntries(items) }));
}
const sizeOf = (f) => (Number.isFinite(f.size) ? fmtBytes(f.size) : '');
function fileCell(f, repo, tag) {
  if (!f) return '—';
  const url = f.url || downloadUrl(repo, tag, f.name);
  return `[${mdEsc(f.name)}](${url.replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)})${sizeOf(f) ? ` · ${sizeOf(f)}` : ''}`;
}
const TABLE_HEAD = ['| Giờ | Tên | Bản thường | Bản điện thoại | Thời lượng |', '|---|---|---|---|---|'];
export function entryRow(e, repo) {
  return `| ${mdEsc(e.time || '')} | ${mdEsc(e.name || e.main.name)} | ${fileCell(e.main, repo, e.tag)} | ${fileCell(e.phone, repo, e.tag)} | ${Number.isFinite(e.duration) ? fmtDur(e.duration) : ''} |`;
}

const FETCH_METHOD_LABEL = { curl: 'Tải thường (curl)', browser: 'Trình duyệt thật', ytdlp: 'yt-dlp', gdown: 'gdown' };

// Khối kỹ thuật cho từng video (bảng cũ của release).
export function techDetails(e) {
  if (!e.tech && !e.phone_skipped && !(e.notes && e.notes.length)) return '';
  const t = e.tech || {};
  const rows = [];
  const add = (k, v) => {
    if (v !== undefined && v !== null && v !== '') rows.push(`| ${k} | ${v} |`);
  };
  if (Number.isFinite(e.in_bytes) && e.main && Number.isFinite(e.main.size)) add('Dung lượng', `${fmtBytes(e.in_bytes)} → ${fmtBytes(e.main.size)} (giảm ${((1 - e.main.size / e.in_bytes) * 100).toFixed(1)}%)`);
  if (Number.isFinite(e.duration)) add('Thời lượng', fmtDur(e.duration));
  if (t.res_in) add('Độ phân giải', `${mdEsc(t.res_in)} → ${mdEsc(t.res_out || '?')}`);
  add('Codec', t.codec_label ? mdEsc(t.codec_label) : '');
  add('CRF', t.crf);
  if (t.vmaf_target !== undefined) add('VMAF mục tiêu / dự đoán', `≥ ${t.vmaf_target} / ${t.vmaf_pred ?? '?'}`);
  add('Mức / preset', t.quality_label ? `${mdEsc(t.quality_label)} / ${mdEsc(t.preset)}` : '');
  if (Number.isFinite(t.encode_seconds)) add('Thời gian nén', fmtDur(t.encode_seconds));
  if (e.phone) add('Bản điện thoại', `H.264, CRF ${e.phone.crf ?? '?'}, maxrate ${mdEsc(e.phone.maxrate || '?')}, ${mdEsc(e.phone.res || '')}${Number.isFinite(e.phone.size) ? `, ${fmtBytes(e.phone.size)}` : ''}`);
  else if (e.phone_skipped) add('Bản điện thoại', `đã bỏ: ${mdEsc(e.phone_skipped)}`);
  add('Phiên bản', t.tools ? mdEsc(t.tools) : '');
  add('Thời điểm', t.at ? mdEsc(t.at) : '');
  add('Nguồn', t.source ? mdEsc(t.source) : '');
  add('Cách tải', FETCH_METHOD_LABEL[t.fetch_method] || '');
  add('SHA256', t.sha256 ? `\`${String(t.sha256).replace(/[^0-9a-f]/gi, '')}\`` : '');
  const notes = (e.notes || []).map((n) => `- ${mdEsc(n)}`);
  const body = [...(rows.length ? ['| Mục | Giá trị |', '|---|---|', ...rows] : []), ...(notes.length ? ['', ...notes] : [])].join('\n');
  return `<details><summary>${mdEsc(e.name || e.main.name)}</summary>\n\n${body}\n\n</details>`;
}

// Body release của MỘT ngày: bảng + khối kỹ thuật từng mục (dừng thêm khối kỹ thuật khi sắp chạm giới hạn).
export function buildDayBody(entries, { repo, limit = BODY_SOFT_LIMIT }) {
  const items = sortEntries(entries);
  const tail = `\n\n_Tạo tự động từ hàng đợi cá nhân của chủ repo._\n`;
  const note = `\n\n_Một số mục/khối kỹ thuật bị lược bớt do giới hạn độ dài; xem \`${CATALOG_JSON}\` ở release \`${CATALOG_TAG}\`._`;
  const room = limit - tail.length - note.length;
  let out = TABLE_HEAD.join('\n');
  let cut = false;
  for (const e of items) { // bảng luôn đủ nếu có thể; quá giới hạn thì dừng
    const r = `\n${entryRow(e, repo)}`;
    if (out.length + r.length > room) {
      cut = true;
      break;
    }
    out += r;
  }
  if (!cut) {
    for (const e of [...items].reverse()) { // khối kỹ thuật, giờ sớm trước
      const d = techDetails(e);
      if (!d) continue;
      if (out.length + d.length + 2 > room) {
        cut = true;
        break;
      }
      out += `\n\n${d}`;
    }
  }
  return `${out}${cut ? note : ''}${tail}`;
}

const dayHeading = (g, repo) => `### ${g.date} — [mở release](${releaseUrl(repo, g.tag)})`;
const FOOTER = `_Xem đầy đủ trong \`${CATALOG_MD}\` / \`${CATALOG_JSON}\` (asset của release này)._`;

// Body release mục lục: ngày mới nhất ở trên; dừng ở ~110.000 ký tự rồi trỏ tới muc-luc.md / catalog.json.
export function buildCatalogBody(entries, { repo, limit = BODY_SOFT_LIMIT }) {
  const groups = groupByDate(entries);
  const intro = `Mục lục các video đã nén, ngày mới nhất ở trên. Mỗi ngày có một release riêng (\`vid-YYYYMMDD\`). Tổng: **${entries.length}** video.`;
  let out = intro;
  let truncated = false;
  outer: for (const g of groups) {
    const head = `\n\n${dayHeading(g, repo)}\n\n${TABLE_HEAD.join('\n')}`;
    if (out.length + head.length + FOOTER.length + 4 > limit) {
      truncated = true;
      break;
    }
    out += head;
    for (const e of g.items) {
      const r = `\n${entryRow(e, repo)}`;
      if (out.length + r.length + FOOTER.length + 4 > limit) {
        truncated = true;
        break outer;
      }
      out += r;
    }
  }
  if (!groups.length) out += '\n\n_Chưa có video nào._';
  if (truncated) out += `\n\n${FOOTER}`;
  return `${out}\n`;
}

// File muc-luc.md: bảng đầy đủ, không giới hạn.
export function buildCatalogMarkdown(entries, { repo }) {
  const parts = ['# 📚 Mục lục video', '', `Tổng: **${entries.length}** video. Ngày mới nhất ở trên.`];
  for (const g of groupByDate(entries)) parts.push('', dayHeading(g, repo), '', ...TABLE_HEAD, ...g.items.map((e) => entryRow(e, repo)));
  return `${parts.join('\n')}\n`;
}

// Dạng gọn cho trang web (/api/status): các ngày gần nhất kèm link tải.
export function daysView(entries, { repo, limitDays = 14 }) {
  return groupByDate(entries).slice(0, limitDays).map((g) => ({
    date: g.date, tag: g.tag, url: releaseUrl(repo, g.tag), count: g.items.length,
    items: g.items.map((e) => ({
      id: e.id, name: e.name || e.main.name, time: e.time || '', duration: e.duration ?? null,
      main: { name: e.main.name, size: e.main.size ?? null, url: e.main.url || downloadUrl(repo, e.tag, e.main.name) },
      phone: e.phone ? { name: e.phone.name, size: e.phone.size ?? null, url: e.phone.url || downloadUrl(repo, e.tag, e.phone.name) } : null,
      phone_skipped: e.phone_skipped || null,
    })),
  }));
}
