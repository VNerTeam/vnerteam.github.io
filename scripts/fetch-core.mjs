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
export function browserHeaders(url, { ref = null, first = null, prev = null, doc = false } = {}) {
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
  if (doc) { // mở một trang web (không phải tải file media)
    return {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
      Referer: referer,
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': site,
      Connection: 'keep-alive',
    };
  }
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

// ---- trang có nút tải (provider page_link) ----
const ENT = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
const decodeEntities = (t) => t.replace(/&(?:#(\d{1,6})|#x([0-9a-f]{1,6})|(amp|quot|apos|lt|gt|nbsp));/gi, (_, d, x, n) => (n ? ENT[n.toLowerCase()] : String.fromCodePoint(d ? Number(d) : parseInt(x, 16))));

// Lấy href (đã đổi thành URL tuyệt đối) của mọi thẻ <a> có ĐỦ các class trong `classes`. Không dùng thư viện HTML nên chỉ đọc thẻ mở <a ...>.
export function extractAnchors(html, classes, baseUrl) {
  const need = (classes || []).filter(Boolean);
  const out = [];
  if (!need.length || typeof html !== 'string') return out;
  for (const m of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    if (attrs.href === undefined || attrs.class === undefined) continue;
    const have = new Set(decodeEntities(attrs.class).split(/\s+/).filter(Boolean));
    if (!need.every((c) => have.has(c))) continue;
    const href = decodeEntities(attrs.href).trim();
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data|blob):/i.test(href)) continue;
    try {
      out.push(new URL(href, baseUrl).href);
    } catch { /* href hỏng: bỏ qua */ }
  }
  return out;
}

// Chọn link từ danh sách href. match: chuỗi con (không phân biệt hoa thường, so cả bản đã giải mã %xx). Chỉ nhận https.
// Trả về { url, total, matched } hoặc { url: null, reason: 'none' | 'nomatch', total }.
export function pickLink(hrefs, match) {
  const list = [...new Set((hrefs || []).filter((h) => typeof h === 'string'))].filter((h) => {
    try {
      return new URL(h).protocol === 'https:';
    } catch {
      return false;
    }
  });
  if (!list.length) return { url: null, reason: 'none', total: 0 };
  const m = String(match || '').trim().toLowerCase();
  if (!m) return { url: list[0], total: list.length, matched: list.length };
  const ok = list.filter((h) => {
    let d = h;
    try {
      d = decodeURIComponent(h);
    } catch { /* giữ nguyên */ }
    return h.toLowerCase().includes(m) || d.toLowerCase().includes(m);
  });
  if (!ok.length) return { url: null, reason: 'nomatch', total: list.length };
  return { url: ok[0], total: list.length, matched: ok.length };
}

// Gợi ý tên video từ đường dẫn của link tải (bỏ đuôi file).
export function nameFromUrl(u) {
  try {
    let p = new URL(u).pathname.split('/').filter(Boolean).pop() || '';
    try {
      p = decodeURIComponent(p);
    } catch { /* giữ nguyên */ }
    return p.replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || null;
  } catch {
    return null;
  }
}

// Set-Cookie của trang → chuỗi "a=b; c=d" cho curl -b (chỉ lấy cặp tên=giá trị, bỏ thuộc tính). Không bao giờ đem chuỗi này ra log.
export function cookieHeaderFrom(setCookies) {
  const pairs = [];
  for (const c of setCookies || []) {
    const kv = String(c).split(';')[0].trim();
    if (/^[^=\s;,]+=[^\r\n]*$/.test(kv)) pairs.push(kv);
  }
  return pairs.join('; ');
}

// ---- tên file gốc ----
const VIDEO_NAME = /\.(mp4|mkv|mov|webm|avi|m4v|ts|m2ts|wmv|flv|mpg|mpeg|3gp|ogv)$/i;
export const looksLikeVideoName = (n) => VIDEO_NAME.test(String(n || ''));
// Header HTTP được Node đọc theo latin1: tên UTF-8 gửi thô sẽ bị vỡ chữ, thử đọc lại thành UTF-8.
const fixLatin1 = (t) => {
  if (!/[\u0080-\u00ff]/.test(t) || /[^\u0000-\u00ff]/.test(t)) return t;
  const u = Buffer.from(t, 'latin1').toString('utf8');
  return u.includes('\ufffd') ? t : u;
};
// Chỉ lấy tên cuối (bỏ mọi đường dẫn / và \), bỏ ký tự điều khiển; "." và ".." không hợp lệ.
export function cleanFileName(raw) {
  const n = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop().trim();
  return !n || n === '.' || n === '..' ? null : n.slice(0, 200);
}
export function filenameFromContentDisposition(v) {
  if (typeof v !== 'string') return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(v); // RFC 5987: filename*=UTF-8''%E2%80%A6
  if (star) {
    try {
      return cleanFileName(decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')));
    } catch { /* thử dạng filename= bên dưới */ }
  }
  const q = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(v) || /filename\s*=\s*([^;]+)/i.exec(v);
  return q ? cleanFileName(fixLatin1(q[1].replace(/\\(.)/g, '$1').trim())) : null;
}
export function filenameFromUrl(u) {
  try {
    const seg = new URL(u).pathname.split('/').filter(Boolean).pop() || '';
    try {
      return cleanFileName(decodeURIComponent(seg));
    } catch {
      return cleanFileName(seg);
    }
  } catch {
    return null;
  }
}
// Tên file gốc của một phản hồi: Content-Disposition (đáng tin nhất), rồi đoạn cuối của URL cuối nếu có đuôi video. Không dùng tham số query.
export function filenameFromResponse(contentDisposition, finalUrl) {
  const cd = filenameFromContentDisposition(contentDisposition);
  if (cd) return cd;
  const u = filenameFromUrl(finalUrl);
  return u && looksLikeVideoName(u) ? u : null;
}
// Tên file → tên hiển thị: bỏ đuôi, giữ dấu cách/ký tự gốc (tên Release tự đổi dấu cách thành "-" khi nén), tối đa 80 ký tự.
export function displayNameFromFile(name) {
  if (typeof name !== 'string') return null;
  const t = name.replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return t || null;
}

// ---- tên lấy từ chữ trong một thẻ (theo thẻ + class cấu hình trong allowed-hosts.json) ----
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
function classOf(attrText) {
  const m = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrText);
  return new Set(decodeEntities(m ? (m[1] ?? m[2] ?? m[3] ?? '') : '').split(/\s+/).filter(Boolean));
}
// Lấy CHỮ nằm trong thẻ đầu tiên có đủ class (và đúng tên thẻ nếu có `tag`): <h1 class="title">Name</h1> → "Name".
// Bỏ các thẻ con (giữ chữ của chúng), bỏ <script>/<style>, giải mã &amp; …, gộp khoảng trắng. Không tìm thấy hoặc rỗng → null.
export function extractTitleText(html, { tag = null, classes = [] } = {}) {
  const need = (classes || []).filter(Boolean);
  if (typeof html !== 'string' || !need.length) return null;
  const src = html.slice(0, 2 * 1024 * 1024);
  const open = tag ? new RegExp(`<${tag}\\b([^>]*)>`, 'gi') : /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  for (const m of src.matchAll(open)) {
    const name = (tag || m[1]).toLowerCase();
    const attrs = tag ? m[1] : m[2];
    if (VOID.has(name) || /\/\s*$/.test(attrs)) continue;
    const have = classOf(attrs);
    if (!need.every((c) => have.has(c))) continue;
    const start = m.index + m[0].length;
    const re = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi'); // tìm thẻ đóng tương ứng, tính cả thẻ cùng tên lồng bên trong
    re.lastIndex = start;
    let depth = 1;
    let end = -1;
    for (let r = re.exec(src); r; r = re.exec(src)) {
      if (r[1]) {
        depth--;
        if (!depth) { end = r.index; break; }
      } else if (!/\/\s*>$/.test(r[0])) depth++;
    }
    if (end < 0) continue;
    const inner = src.slice(start, end).replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ');
    const text = decodeEntities(inner).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 300);
  }
  return null;
}
// Tên lấy từ tiêu đề: giữ nguyên (KHÔNG cắt "đuôi file" như tên file, vì "Phim v2.0 Final.Cut" là tiêu đề chứ không phải đuôi), tối đa 80 ký tự.
export function displayNameFromTitle(t) {
  if (typeof t !== 'string') return null;
  const x = t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return x || null;
}
