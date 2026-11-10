// Các hàm THUẦN cho việc tải "giống trình duyệt" (không gọi mạng, không chạm đĩa) nên test được mà không cần Chrome.
// Dùng chung cho resolvers.mjs, process-item.mjs và browser-fetch.mjs.

// ---- User-Agent: một nguồn duy nhất ----
// Mức 1 (curl/fetch) dùng bản mặc định. Mức 2 (Chrome thật) đọc phiên bản thật rồi dựng UA bằng chromeUA(major)
// và trả lại cho curl khi bàn giao, nên cả hai mức luôn khớp nhau.
export const DEFAULT_CHROME_MAJOR = 140;
export const chromeUA = (major = DEFAULT_CHROME_MAJOR) => {
  const m = Number.isInteger(major) && major >= 100 && major <= 999 ? major : DEFAULT_CHROME_MAJOR;
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Safari/537.36`;
};
export const UA = chromeUA();
export const chromeMajorOf = (versionText) => {
  const m = /(\d{2,3})\.\d+\.\d+/.exec(String(versionText || ''));
  return m ? Number(m[1]) : null;
};

const originOf = (u) => new URL(u).origin;

// ---- header giống trình duyệt cho request tải video ----
// url: địa chỉ sắp gọi. Tuỳ chọn:
//   ref   — "Trang mở trước" của mục (chỉ dùng cho request đầu và các bước cùng origin với request đầu).
//   first — URL của request đầu tiên (để biết đang ở bước chuyển hướng sang host khác hay chưa).
//   prev  — URL của bước ngay trước (khi đang đi theo chuyển hướng).
// Sau khi chuyển hướng sang host khác, Referer chỉ còn là origin của bước trước, KHÔNG bao giờ lộ `ref` sang host lạ.
export function browserHeaders(url, { ref = null, first = null, prev = null } = {}) {
  const origin = originOf(url);
  const sameAsFirst = !first || originOf(first) === origin;
  let referer;
  if (ref && sameAsFirst) referer = ref;
  else if (prev) referer = `${originOf(prev)}/`;
  else referer = `${origin}/`;
  let site = 'cross-site';
  try {
    if (originOf(referer) === origin) site = 'same-origin';
  } catch { /* giữ cross-site */ }
  return {
    Accept: 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
    'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
    Referer: referer,
    'Sec-Fetch-Dest': 'video',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': site,
    Connection: 'keep-alive',
  };
}

// Đổi bộ header thành đối số cho curl: Referer đi bằng -e, các header còn lại bằng -H (User-Agent đi bằng -A ở nơi gọi).
export function curlHeaderArgs(headers) {
  const args = [];
  for (const [k, v] of Object.entries(headers)) {
    if (/^(referer|user-agent)$/i.test(k)) continue;
    args.push('-H', `${k}: ${v}`);
  }
  if (headers.Referer) args.push('-e', headers.Referer);
  return args;
}

// ---- quyết định chuyển mức ----
export const FETCH_MODES = ['auto', 'curl', 'browser'];
// err: lỗi (Fail) của mức 1. Trả về true nếu nên chuyển sang trình duyệt.
export function shouldFallbackToBrowser(err, mode) {
  if (mode === 'curl') return false;
  if (mode === 'browser') return true;
  if (!err) return false;
  if (['not_found', 'rate_limited', 'timeout', 'input_too_big', 'lfs_pointer'].includes(err.code)) return false;
  if (err.blocked === true) return true;
  return err.code === 'access_denied';
}

// Kết luận của bước kiểm tra trước khi tải (probe). outcome:
//   { video: true } | { video: false, kind } | { error: <mã lỗi> }
// 'accept' = cho tải; 'defer' = chưa chắc, để bước tải quyết định; 'reject' = từ chối ngay.
export function probeVerdict(outcome, mode) {
  if (outcome.error) {
    if (outcome.error === 'access_denied' && mode !== 'curl') return 'defer';
    return 'reject';
  }
  if (outcome.video) return 'accept';
  if (mode !== 'curl' && (outcome.kind === 'html' || outcome.kind === 'json')) return 'defer';
  return 'reject';
}

// Chỉ `browser_failed` được thử lại (tính theo max_attempts). Các mã khác là lỗi cố định.
export const RETRYABLE_ERRORS = new Set(['browser_failed']);
export const BROWSER_ERRORS = ['browser_failed', 'browser_no_video', 'browser_unavailable'];

// ---- file thực thi: từ chối ----
const EXEC_EXT = /\.(exe|msi|bat|cmd|com|scr|sh|bash|zsh|apk|dmg|pkg|deb|rpm|jar|ps1|vbs|appimage|run|dll|so|app)$/i;
export const isExecutableName = (name) => typeof name === 'string' && EXEC_EXT.test(name.trim());

// ---- chọn luồng video từ những gì trình duyệt thấy ----
const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v)(?:$|[?#])/i;
const STREAM_EXT = /\.(m3u8|mpd)(?:$|[?#])/i;
const SEGMENT_EXT = /\.(ts|m4s|aac)(?:$|[?#])/i;
// candidates: [{ url, type?, length? }]. Trả về { kind: 'file' | 'stream', url } hoặc null.
export function pickMediaUrl(candidates) {
  let bestFile = null;
  let stream = null;
  for (const c of candidates || []) {
    if (!c || typeof c.url !== 'string') continue;
    let u;
    try {
      u = new URL(c.url);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:') continue; // bỏ blob:, data:, http:
    const type = String(c.type || '').toLowerCase().split(';')[0].trim();
    const path = `${u.pathname}${u.search}`;
    const isStream = STREAM_EXT.test(path) || /mpegurl|dash\+xml/.test(type);
    if (isStream) {
      if (!stream) stream = { kind: 'stream', url: c.url };
      continue;
    }
    if (SEGMENT_EXT.test(u.pathname) || /mp2t|iso\.segment/.test(type)) continue; // mảnh của luồng HLS/DASH
    const isFile = type.startsWith('video/') || (type === 'application/octet-stream' && VIDEO_EXT.test(path)) || (!type && VIDEO_EXT.test(path));
    if (!isFile) continue;
    const len = Number.isFinite(c.length) ? c.length : 0;
    if (!bestFile || len > bestFile.len) bestFile = { kind: 'file', url: c.url, len };
  }
  if (bestFile) return { kind: 'file', url: bestFile.url };
  return stream;
}

// Referer khi bàn giao cho curl: giống trình duyệt (cùng origin thì đầy đủ, khác origin thì chỉ origin); trang người dùng chỉ định giữ nguyên.
export function handoffReferer(pageUrl, target, ref) {
  const base = pageUrl && pageUrl.startsWith('https://') ? pageUrl : ref || null;
  if (!base) return `${originOf(target)}/`;
  if (ref && base === ref) return ref;
  return originOf(base) === originOf(target) ? base : `${originOf(base)}/`;
}

// ---- cookie → file Netscape (cho curl -b và yt-dlp --cookies) ----
const clean = (s) => String(s ?? '').replace(/[\t\r\n]/g, '');
// cookies: mảng dạng Playwright { name, value, domain, path, expires, httpOnly, secure }
export function toNetscapeCookies(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies || []) {
    const name = clean(c && c.name);
    const domain = clean(c && c.domain);
    if (!name || !domain || !/^[A-Za-z0-9.\-_]+$/.test(domain.replace(/^#HttpOnly_/, ''))) continue;
    const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const exp = Number.isFinite(c.expires) && c.expires > 0 ? Math.floor(c.expires) : 0;
    lines.push(`${c.httpOnly ? '#HttpOnly_' : ''}${domain}\t${flag}\t${clean(c.path) || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${exp}\t${name}\t${clean(c.value)}`);
  }
  return `${lines.join('\n')}\n`;
}
// Dùng khi cần ghi log về cookie: chỉ nêu số lượng, KHÔNG bao giờ in tên/giá trị.
export const describeCookies = (cookies) => `${Array.isArray(cookies) ? cookies.length : 0} cookie (không hiển thị nội dung)`;

// Kiểm tra nội dung file vừa tải bằng các byte đầu. sniff: hàm headCheck của resolvers.
// Trả về { video: true, ext } hoặc ném Fail qua callback fail(code, msg, extra).
export function assessDownloadedHead(headInfo, fail) {
  if (headInfo.video) return headInfo;
  const blocked = headInfo.kind === 'html' || headInfo.kind === 'json';
  throw fail('not_direct_video', `Nội dung tải về không phải video (${headInfo.kind}).`, blocked ? { blocked: true } : {});
}
