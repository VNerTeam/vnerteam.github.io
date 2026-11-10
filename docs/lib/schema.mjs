// Validate hàng đợi và tuỳ chọn. Dùng chung trình duyệt, Worker và Node.
import { PROVIDER_IDS, validateRef } from './providers.mjs';

export const LIMITS = { maxQueue: 200, maxBatch: 50, maxChanges: 200, maxBody: 65536, maxQueueBytes: 1048576, labelMax: 80, maxAttempts: 99 };

// [giá trị, nhãn tiếng Việt]. Khoá phải khớp config/profiles.json (có test kiểm tra).
export const OPTION_CHOICES = {
  resolution: [['original', 'Giữ nguyên'], ['hd', 'HD 720p'], ['fhd', 'Full HD 1080p'], ['2k', '2K 1440p'], ['4k', '4K 2160p']],
  quality: [['good', 'Tốt (giảm ít)'], ['balanced', 'Cân bằng'], ['strong', 'Mạnh (nhỏ nhất)']],
  codec: [['av1', 'AV1 (nhỏ nhất)'], ['hevc', 'HEVC (tương thích hơn)']],
  fps_cap: [[null, 'Không giới hạn'], [30, 'Tối đa 30 fps'], [60, 'Tối đa 60 fps']],
  audio: [['copy', 'Giữ nguyên âm thanh'], ['opus_96', 'Opus 96 kbps'], ['opus_128', 'Opus 128 kbps'], ['aac_128', 'AAC 128 kbps']],
  container: [['mkv', 'MKV'], ['mp4', 'MP4']],
  phone: [[true, 'Bật'], [false, 'Tắt']],
  // Cách tải: auto = thử tải thường trước, bị chặn thì tự chuyển sang Chrome thật; curl = không bao giờ dùng trình duyệt; browser = dùng thẳng trình duyệt.
  fetch_mode: [['auto', 'Tự động'], ['curl', 'Chỉ tải thường'], ['browser', 'Luôn dùng trình duyệt']],
};
export const OPTION_LABELS = { resolution: 'Độ phân giải', quality: 'Chất lượng', codec: 'Codec', fps_cap: 'Khung hình', audio: 'Âm thanh', container: 'Định dạng', phone: 'Bản điện thoại (H.264)', fetch_mode: 'Cách tải', min_vmaf: 'VMAF tối thiểu' };
export const VMAF_RANGE = [85, 99];
export const STATUSES = ['pending', 'failed'];

export function defaultOptions() {
  return { resolution: 'original', quality: 'strong', codec: 'hevc', fps_cap: null, audio: 'opus_128', container: 'mkv', phone: true, fetch_mode: 'auto', min_vmaf: null };
}

const fail = (message) => ({ ok: false, message });

export function validateOptions(input) {
  const base = defaultOptions();
  if (input === undefined || input === null) return { ok: true, value: base };
  if (typeof input !== 'object' || Array.isArray(input)) return fail('Tuỳ chọn không hợp lệ.');
  for (const k of Object.keys(input)) if (!(k in base)) return fail(`Tuỳ chọn lạ: ${k}`);
  // Mục cũ trong queue.json đã có đủ khoá tường minh nên đổi mặc định không làm đổi chúng; chỉ khoá mới (phone, fetch_mode) thiếu thì nhận mặc định.
  const o = { ...base, ...input };
  for (const k of Object.keys(OPTION_CHOICES)) {
    if (!OPTION_CHOICES[k].some(([v]) => v === o[k])) return fail(`Giá trị không hợp lệ cho "${OPTION_LABELS[k]}".`);
  }
  if (o.min_vmaf !== null) {
    if (typeof o.min_vmaf !== 'number' || !Number.isFinite(o.min_vmaf) || o.min_vmaf < VMAF_RANGE[0] || o.min_vmaf > VMAF_RANGE[1]) {
      return fail(`VMAF tối thiểu phải nằm trong khoảng ${VMAF_RANGE[0]}–${VMAF_RANGE[1]}.`);
    }
    o.min_vmaf = Math.round(o.min_vmaf * 10) / 10;
  }
  return { ok: true, value: o };
}

export function validateLabel(label) {
  if (label === undefined || label === null) return { ok: true, value: null };
  if (typeof label !== 'string') return fail('Tên hiển thị không hợp lệ.');
  const t = label.trim();
  if (!t) return { ok: true, value: null };
  if (t.length > LIMITS.labelMax) return fail(`Tên hiển thị tối đa ${LIMITS.labelMax} ký tự.`);
  if (/[\u0000-\u001f\u007f]/.test(t)) return fail('Tên hiển thị có ký tự điều khiển.');
  return { ok: true, value: t };
}

// "Trang mở trước" (referer): trường riêng của từng mục, không bắt buộc. Dùng làm Referer (tải thường) hoặc trang mà trình duyệt mở trước (lấy cookie/phiên).
// Lưu ý: khoá `ref` của mục đã dành cho tham chiếu của provider nên trường này tên là `referer`.
const REFERER_MAX = 2048;
function privateHost(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (h.startsWith('[') || h.includes(':')) return true; // IPv6 (kể cả ::1): không nhận
  if (!h.includes('.')) return true; // tên không có dấu chấm (máy trong mạng nội bộ)
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (/^[\d.]+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true; // dạng IP viết tắt/hex
  return false;
}
export function validateRefPage(input) {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== 'string') return fail('Trang mở trước không hợp lệ.');
  const t = input.trim();
  if (!t) return { ok: true, value: null };
  if (t.length > REFERER_MAX) return fail(`Trang mở trước tối đa ${REFERER_MAX} ký tự.`);
  if (/[\s\u0000-\u001f\u007f]/.test(t)) return fail('Trang mở trước không được có khoảng trắng hoặc ký tự điều khiển.');
  let u;
  try {
    u = new URL(t);
  } catch {
    return fail('Trang mở trước không phải link hợp lệ.');
  }
  if (u.protocol !== 'https:') return fail('Trang mở trước phải bắt đầu bằng https://');
  if (u.username || u.password) return fail('Trang mở trước không được chứa tên đăng nhập/mật khẩu.');
  if (privateHost(u.hostname)) return fail('Trang mở trước không được trỏ tới địa chỉ nội bộ.');
  return { ok: true, value: t };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
export function newItemId(now = new Date()) {
  const b = new Uint8Array(3);
  globalThis.crypto.getRandomValues(b);
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const d = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const t = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `q-${d}-${t}-${hex}`;
}
export const ID_RE = /^q-\d{8}-\d{6}-[0-9a-f]{6}$/;

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export function dedupeKey(provider, ref, options, referer = null) {
  return `${provider}|${stable(ref)}|${stable(options)}${referer ? `|${referer}` : ''}`;
}

const ITEM_KEYS = ['id', 'provider', 'ref', 'referer', 'label', 'options', 'status', 'attempts', 'ladder_start', 'last_error', 'added_at'];

// Kiểm tra 1 mục trong queue.json (dữ liệu không đáng tin). ctx.allowedHosts dùng cho direct_url.
export function validateItem(item, ctx = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return fail('Mục không phải object.');
  for (const k of Object.keys(item)) if (!ITEM_KEYS.includes(k)) return fail(`Trường lạ: ${k}`);
  if (typeof item.id !== 'string' || !ID_RE.test(item.id)) return fail('id không đúng định dạng.');
  if (!PROVIDER_IDS.includes(item.provider)) return fail('provider không hợp lệ.');
  const r = validateRef(item.provider, item.ref, ctx);
  if (!r.ok) return fail(`ref: ${r.message}`);
  const o = validateOptions(item.options);
  if (!o.ok) return fail(o.message);
  const l = validateLabel(item.label);
  if (!l.ok) return fail(l.message);
  const rp = validateRefPage(item.referer);
  if (!rp.ok) return fail(rp.message);
  if (!STATUSES.includes(item.status)) return fail('status không hợp lệ.');
  const int = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  if (!int(item.attempts, LIMITS.maxAttempts)) return fail('attempts không hợp lệ.');
  if (!int(item.ladder_start, 10)) return fail('ladder_start không hợp lệ.');
  if (item.last_error !== null && !(typeof item.last_error === 'string' && item.last_error.length <= 200)) return fail('last_error không hợp lệ.');
  if (typeof item.added_at !== 'string' || item.added_at.length > 40) return fail('added_at không hợp lệ.');
  return {
    ok: true,
    value: {
      id: item.id, provider: item.provider, ref: item.ref, referer: rp.value, label: l.value, options: o.value, status: item.status,
      attempts: item.attempts, ladder_start: item.ladder_start, last_error: item.last_error, added_at: item.added_at,
    },
  };
}

export function parseQueue(text) {
  let q;
  try {
    q = JSON.parse(text);
  } catch {
    throw new Error('queue.json không phải JSON hợp lệ.');
  }
  if (!q || typeof q !== 'object' || q.version !== 1 || !Array.isArray(q.items)) throw new Error('queue.json sai cấu trúc (cần version=1 và items là mảng).');
  return q;
}
export function serializeQueue(q) {
  return `${JSON.stringify({ version: 1, items: q.items }, null, 2)}\n`;
}
