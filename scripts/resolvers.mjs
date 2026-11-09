// resolve(provider, ref) → { kind: 'http', url, nameHint } | { kind: 'gdown', id, resourcekey }
// Thêm provider mới: thêm 1 entry vào RESOLVERS (và matcher/check trong docs/lib/providers.mjs).
import fs from 'node:fs';

export class Fail extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.code = code;
    Object.assign(this, extra);
  }
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const e = encodeURIComponent;
const encPath = (p) => p.split('/').map(e).join('/');
const base = (p) => p.split('/').pop();
// Tên file gốc của link trực tiếp: ưu tiên tham số download_filename, nếu không thì đoạn cuối (không rỗng) của đường dẫn
function directName(r) {
  const dl = new URLSearchParams(r.query || '').get('download_filename');
  if (dl) return dl;
  let p = r.path;
  try { p = decodeURIComponent(r.path); } catch { /* giữ nguyên */ }
  return p.split('/').filter(Boolean).pop() || null;
}
const http = (url, nameHint = null) => ({ kind: 'http', url, nameHint });

// ---- mạng: chỉ https, tối đa 5 lần chuyển hướng ----
export async function fetchFollow(url, { headers = {}, maxRedirects = 5, stopAt = null } = {}) {
  let cur = url;
  const chain = [];
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(cur, { headers: { 'User-Agent': UA, ...headers }, redirect: 'manual', signal: AbortSignal.timeout(45000) });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, cur);
      if (next.protocol !== 'https:') throw new Fail('not_direct_video', 'Link chuyển hướng sang địa chỉ không phải https.');
      await res.body?.cancel().catch(() => {});
      chain.push(next.href);
      cur = next.href;
      if (stopAt && stopAt(next)) return { res: null, finalUrl: cur, chain };
      continue;
    }
    return { res, finalUrl: cur, chain };
  }
  throw new Fail('too_many_redirects', 'Link chuyển hướng quá 5 lần.');
}

// Nhận diện container video từ vài KB đầu. Trả về phần mở rộng hoặc null.
export function sniffContainer(b) {
  if (b.length < 12) return null;
  const s4 = b.subarray(4, 8).toString('latin1');
  if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(s4)) return 'mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'mkv';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'AVI ') return 'avi';
  if (b.subarray(0, 3).toString('latin1') === 'FLV') return 'flv';
  if (b.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return 'wmv';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0xba) return 'mpg';
  if (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47) && (b.length < 377 || b[376] === 0x47)) return 'ts';
  return null;
}
export function sniffText(b) {
  const t = b.subarray(0, 64).toString('utf8').trimStart();
  if (t.startsWith('version https://git-lfs')) return 'lfs';
  if (/^<(!doctype|html|\?xml|head|body)/i.test(t) || t.startsWith('<')) return 'html';
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  return null;
}
export function headCheck(buf) {
  const ext = sniffContainer(buf);
  if (ext) return { video: true, ext };
  const kind = sniffText(buf);
  if (kind === 'lfs') throw new Fail('lfs_pointer', 'Đây là con trỏ Git LFS, không phải file video thật. Hãy dùng link release hoặc media.githubusercontent.com.');
  return { video: false, kind: kind || 'unknown' };
}

// Gửi request, đọc vài KB đầu, lấy Content-Type/Length và nhận diện magic bytes.
export async function probeUrl(url, headers = {}) {
  const { res, finalUrl } = await fetchFollow(url, { headers: { Range: 'bytes=0-4095', ...headers } });
  if (res.status === 404 || res.status === 410) throw new Fail('not_found', 'Link không còn tồn tại (404).');
  if (res.status === 401 || res.status === 403) throw new Fail('access_denied', `Không có quyền tải (HTTP ${res.status}).`);
  if (res.status === 429) throw new Fail('rate_limited', 'Nguồn đang giới hạn tốc độ (HTTP 429), thử lại sau.');
  if (res.status >= 400) throw new Fail(`http_${res.status}`, `Nguồn trả lỗi HTTP ${res.status}.`);
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  const cr = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
  const size = cr ? Number(cr[1]) : res.status === 200 && res.headers.get('content-length') ? Number(res.headers.get('content-length')) : null;
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  while (n < 4096) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    n += value.length;
  }
  await reader.cancel().catch(() => {});
  const head = Buffer.concat(parts);
  const c = headCheck(head);
  return { ...c, ctype, size, finalUrl, head };
}

async function getJson(url) {
  const { res } = await fetchFollow(url);
  if (!res || res.status >= 400) throw new Fail('resolve_failed', `Không đọc được thông tin tải (HTTP ${res ? res.status : '?'}).`);
  return res.json();
}

// ---- pCloud ----
const PC_API = { us: 'api.pcloud.com', eu: 'eapi.pcloud.com' };
const PC_ERR = { 7002: 'link_deleted', 7004: 'link_expired', 7005: 'pcloud_traffic', 7006: 'pcloud_traffic' };
async function resolvePcloud(r) {
  const order = r.region === 'auto' ? ['us', 'eu'] : [r.region, r.region === 'us' ? 'eu' : 'us'];
  let last = null;
  for (const reg of order) {
    const j = await getJson(`https://${PC_API[reg]}/getpublinkdownload?code=${e(r.code)}`);
    if (j.result === 0) {
      const host = j.hosts && j.hosts[0];
      if (!host || !j.path) throw new Fail('folder_not_supported', 'Link pCloud này là thư mục hoặc không có file tải.');
      if (!/^[a-z0-9.-]+\.(pcloud\.com|pcloud\.link)$/.test(host)) throw new Fail('resolve_failed', 'pCloud trả về máy chủ lạ.');
      return http(`https://${host}${j.path}`, base(String(j.path)));
    }
    last = j.result;
    if (PC_ERR[j.result]) throw new Fail(PC_ERR[j.result], `pCloud báo lỗi ${j.result}.`);
  }
  throw new Fail(last === 7001 ? 'pcloud_bad_code' : `pcloud_error_${last}`, `pCloud báo lỗi ${last}.`);
}

// ---- OneDrive (thử nghiệm): thử lần lượt 3 cách, lấy cách đầu tiên ra dữ liệu video ----
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function resolveOnedrive(r) {
  const candidates = [];
  const shareUrl = r.kind === 'short' ? `https://1drv.ms${r.path}` : `https://onedrive.live.com/?resid=${e(r.resid)}${r.authkey ? `&authkey=${e(r.authkey)}` : ''}`;
  if (r.kind === 'short') {
    try {
      const { finalUrl } = await fetchFollow(shareUrl, { stopAt: (u) => u.hostname === 'onedrive.live.com' });
      const u = new URL(finalUrl);
      if (u.hostname === 'onedrive.live.com') {
        candidates.push(finalUrl);
        if (u.pathname.startsWith('/redir')) candidates.push(`https://onedrive.live.com/download${u.search}`);
      }
    } catch { /* thử cách tiếp theo */ }
  }
  candidates.push(`https://api.onedrive.com/v1.0/shares/u!${b64url(shareUrl)}/root/content`);
  if (r.kind === 'live') candidates.push(`https://onedrive.live.com/download?resid=${e(r.resid)}${r.authkey ? `&authkey=${e(r.authkey)}` : ''}`);
  const tried = [];
  for (const url of candidates) {
    try {
      const p = await probeUrl(url);
      if (p.video) return { ...http(p.finalUrl || url), secrets: [url, p.finalUrl] };
      tried.push(`${new URL(url).hostname}: ${p.kind}`);
    } catch (err) {
      tried.push(`${new URL(url).hostname}: ${err.code || err.message}`);
    }
  }
  throw new Fail('onedrive_unsupported', `OneDrive không cho tải trực tiếp (${tried.join('; ')}).`);
}

export const RESOLVERS = {
  github_release: async (r) => http(`https://github.com/${e(r.owner)}/${e(r.repo)}/releases/download/${e(r.tag)}/${e(r.asset)}`, r.asset),
  github_repo: async (r) => http(`https://raw.githubusercontent.com/${e(r.owner)}/${e(r.repo)}/${e(r.ref)}/${encPath(r.path)}`, base(r.path)),
  gdrive: async (r) => ({ kind: 'gdown', id: r.id, resourcekey: r.resourcekey, nameHint: null }),
  dropbox: async (r) => http(`https://www.dropbox.com/${r.kind === 'scl' ? 'scl/fi' : 's'}/${e(r.id)}/${e(r.name)}?${r.rlkey ? `rlkey=${e(r.rlkey)}&` : ''}dl=1`, r.name),
  pcloud: resolvePcloud,
  huggingface: async (r) => {
    const prefix = r.type === 'dataset' ? 'datasets/' : r.type === 'space' ? 'spaces/' : '';
    return http(`https://huggingface.co/${prefix}${r.repo}/resolve/${e(r.rev)}/${encPath(r.path)}`, base(r.path));
  },
  internet_archive: async (r) => http(`https://archive.org/download/${e(r.identifier)}/${encPath(r.file)}`, base(r.file)),
  direct_url: async (r) => http(`https://${r.host}${r.path}${r.query ? `?${r.query}` : ''}`, directName(r)),
  ytdlp: async (r) => ({ kind: 'ytdlp', url: `https://${r.host}${r.path}${r.query ? `?${r.query}` : ''}`, nameHint: null }),
  onedrive: resolveOnedrive,
};

export async function resolve(provider, ref) {
  const fn = RESOLVERS[provider];
  if (!fn) throw new Fail('unsupported', `Provider ${provider} chưa có resolver.`);
  const out = await fn(ref);
  if (out.kind !== 'gdown' && !out.url.startsWith('https://')) throw new Fail('resolve_failed', 'Link tải không phải https.');
  return out;
}

// Các giá trị bí mật cần che trong log công khai
const SECRET_KEYS = { gdrive: ['id', 'resourcekey'], dropbox: ['rlkey'], pcloud: ['code'], onedrive: ['path', 'resid', 'authkey'], direct_url: ['query'], ytdlp: ['path', 'query'] };
export function secretsOf(provider, ref) {
  return (SECRET_KEYS[provider] || []).map((k) => ref[k]).filter((v) => typeof v === 'string' && v.length >= 4);
}

export function fileHead(path, n = 4096) {
  const fd = fs.openSync(path, 'r');
  try {
    const b = Buffer.alloc(n);
    const r = fs.readSync(fd, b, 0, n, 0);
    return b.subarray(0, r);
  } finally {
    fs.closeSync(fd);
  }
}
