// Cloudflare Worker: cổng ghi duy nhất vào hệ thống. PAT GitHub chỉ nằm trong secret của Worker.
// Luật lọc link/tuỳ chọn dùng chung với trình duyệt và workflow (docs/lib/*.mjs).
import { parseLink } from '../../docs/lib/providers.mjs';
import { validateOptions, validateLabel, validateRefPage, validateLinkMatch, newItemId, dedupeKey, parseQueue, serializeQueue, LIMITS, ID_RE } from '../../docs/lib/schema.mjs';
import { CATALOG_TAG, CATALOG_JSON, parseCatalog, fromReleases, daysView } from '../../docs/lib/catalog.mjs';

const enc = new TextEncoder();
const FAIL_MAX = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ---- bộ nhớ đệm trong isolate (đủ cho cache 30–60 giây) ----
const cache = { status: null, hosts: null, catalog: null };
export function _resetCaches() {
  cache.status = null;
  cache.hosts = null;
  cache.catalog = null;
}

// ---- tiện ích ----
const cors = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
});
function reply(env, status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(env), ...extra },
  });
}
const toB64 = (s) => {
  const b = enc.encode(s);
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromB64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- chống dò password / PIN (đếm theo IP trong KV, chỉ ghi khi nhập sai) ----
const PIN_RE = /^\d{4,12}$/;
const PIN_KEY = 'auth:pin'; // { salt, hash } của PIN dự phòng, lưu trong KV của Cloudflare (dùng được từ mọi thiết bị)
const PIN_GLOBAL_KEY = 'fail:pin-global'; // PIN ngắn nên có thêm trần chung cho mọi IP
const PIN_GLOBAL_MAX = 20;
const PIN_GLOBAL_WINDOW_MS = 60 * 60 * 1000;

async function readFails(env, key) {
  const raw = await env.RATE.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function lockError(f, max, windowMs, what) {
  if (f && f.count >= max && Date.now() - f.first < windowMs) {
    const wait = Math.ceil((windowMs - (Date.now() - f.first)) / 1000);
    return new HttpError(429, 'too_many_attempts', `${what} sai quá nhiều lần. Thử lại sau ${Math.ceil(wait / 60)} phút.`, { retry_after: wait });
  }
  return null;
}
async function recordFail(env, key, prev, windowMs) {
  const now = Date.now();
  const fresh = !prev || now - prev.first >= windowMs;
  const rec = fresh ? { count: 1, first: now } : { count: prev.count + 1, first: prev.first };
  await env.RATE.put(key, JSON.stringify(rec), { expirationTtl: Math.max(60, Math.ceil(windowMs / 1000)) });
}
async function checkLock(env, ip) {
  const f = await readFails(env, `fail:${ip}`);
  const e = lockError(f, FAIL_MAX, FAIL_WINDOW_MS, 'Nhập');
  if (e) throw e;
  return f;
}

async function readPin(env) {
  const raw = await env.RATE.get(PIN_KEY);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return typeof j.salt === 'string' && typeof j.hash === 'string' ? j : null;
  } catch {
    return null;
  }
}
export async function hashPin(pin, salt) {
  return sha256Hex(`pin:${salt}:${pin}`);
}

// Trả về { kind: 'password' | 'pin' }. Credential nằm trong header Authorization:
//   Bearer <password>   (mặc định; trang ghi nhớ được trên thiết bị)
//   Pin <mã PIN>        (đăng nhập dự phòng khi quên password; KHÔNG ghi nhớ trên thiết bị)
async function authenticate(request, env) {
  if (!env.PASSWORD_HASH || !env.PASSWORD_SALT) throw new HttpError(500, 'not_configured', 'Worker chưa được cấu hình password.');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const prev = await checkLock(env, ip);
  const header = request.headers.get('Authorization') || '';
  const mp = /^Bearer (.{1,256})$/.exec(header);
  if (mp) {
    const ok = safeEqual(await sha256Hex(env.PASSWORD_SALT + mp[1]), String(env.PASSWORD_HASH).toLowerCase());
    if (!ok) {
      await recordFail(env, `fail:${ip}`, prev, FAIL_WINDOW_MS);
      throw new HttpError(401, 'unauthorized', 'Sai password.');
    }
    if (prev) await env.RATE.delete(`fail:${ip}`);
    return { kind: 'password' };
  }
  const mn = /^Pin (.{1,32})$/.exec(header);
  if (mn) {
    const glob = await readFails(env, PIN_GLOBAL_KEY);
    const gl = lockError(glob, PIN_GLOBAL_MAX, PIN_GLOBAL_WINDOW_MS, 'PIN');
    if (gl) throw gl;
    const stored = await readPin(env);
    // Luôn băm một lần (kể cả khi chưa đặt PIN) để thời gian phản hồi không lộ việc PIN đã được đặt hay chưa.
    const salt = stored ? stored.salt : 'none';
    const got = await hashPin(mn[1], salt);
    const ok = !!stored && PIN_RE.test(mn[1]) && safeEqual(got, stored.hash);
    if (!ok) {
      await recordFail(env, `fail:${ip}`, prev, FAIL_WINDOW_MS);
      if (stored) await recordFail(env, PIN_GLOBAL_KEY, glob, PIN_GLOBAL_WINDOW_MS);
      throw new HttpError(401, 'unauthorized', 'Sai PIN.');
    }
    if (prev) await env.RATE.delete(`fail:${ip}`);
    return { kind: 'pin' };
  }
  await recordFail(env, `fail:${ip}`, prev, FAIL_WINDOW_MS);
  throw new HttpError(401, 'unauthorized', 'Thiếu thông tin đăng nhập.');
}

// Đặt / đổi / xoá PIN dự phòng. Chỉ cho phép khi đăng nhập bằng PASSWORD (PIN không tự đổi được PIN).
async function setPin(env, request, auth) {
  if (auth.kind !== 'password') throw new HttpError(403, 'password_required', 'Cần đăng nhập bằng password để đổi PIN.');
  const body = await readBody(request);
  if (typeof body.pin !== 'string' || !PIN_RE.test(body.pin)) throw new HttpError(400, 'bad_pin', 'PIN phải gồm 4–12 chữ số (khuyên dùng 6 số trở lên).');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.RATE.put(PIN_KEY, JSON.stringify({ salt, hash: await hashPin(body.pin, salt), at: new Date().toISOString() }));
  await env.RATE.delete(PIN_GLOBAL_KEY);
  return { ok: true, pin_set: true };
}
async function deletePin(env, auth) {
  if (auth.kind !== 'password') throw new HttpError(403, 'password_required', 'Cần đăng nhập bằng password để xoá PIN.');
  await env.RATE.delete(PIN_KEY);
  return { ok: true, pin_set: false };
}

// ---- GitHub API ----
async function ghRequest(env, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      'User-Agent': 'video-compress-gateway',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  if (res.status !== 204) {
    try {
      data = await res.json();
    } catch { /* không có JSON */ }
  }
  return { status: res.status, data, headers: res.headers };
}
function ghFail(res, what) {
  if (res.status === 401) return new HttpError(502, 'pat_invalid', 'PAT hết hạn hoặc thiếu quyền. Hãy tạo lại PAT và chạy: wrangler secret put GITHUB_PAT');
  if (res.status === 403) {
    if (res.headers.get('x-ratelimit-remaining') === '0') return new HttpError(502, 'github_rate_limited', 'GitHub đang giới hạn tốc độ, thử lại sau.');
    return new HttpError(502, 'pat_invalid', 'PAT hết hạn hoặc thiếu quyền (cần Contents và Actions: Read and write).');
  }
  return new HttpError(502, 'github_error', `GitHub báo lỗi ${res.status} khi ${what}.`);
}
const repoPath = (env) => `/repos/${encodeURIComponent(env.GH_OWNER)}/${encodeURIComponent(env.GH_REPO)}`;

async function readFile(env, file) {
  const res = await ghRequest(env, 'GET', `${repoPath(env)}/contents/${file}?ref=${encodeURIComponent(env.GH_BRANCH)}`);
  if (res.status === 404) return null;
  if (res.status !== 200) throw ghFail(res, `đọc ${file}`);
  if (typeof res.data.content !== 'string' || res.data.encoding !== 'base64') throw new HttpError(502, 'file_too_large', `${file} quá lớn để đọc qua API.`);
  return { text: fromB64(res.data.content), sha: res.data.sha };
}

async function getAllowedHosts(env) {
  if (cache.hosts && Date.now() - cache.hosts.at < 60000) return cache.hosts.list;
  const f = await readFile(env, 'config/allowed-hosts.json');
  let list = [];
  if (f) {
    try {
      const j = JSON.parse(f.text);
      if (Array.isArray(j.hosts)) list = j.hosts.filter((h) => h && typeof h.host === 'string').map((h) => ({ host: h.host, allow_query: h.allow_query === true, ytdlp: h.ytdlp === true, link_class: typeof h.link_class === 'string' ? h.link_class : null }));
    } catch { /* file hỏng → coi như rỗng */ }
  }
  cache.hosts = { at: Date.now(), list };
  return list;
}

// Đọc queue → áp thay đổi → PUT kèm sha; xung đột (409/422) thì đọc lại và áp lại, tối đa 5 lần.
async function mutateQueue(env, message, fn) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const f = await readFile(env, 'queue.json');
    let queue;
    try {
      queue = f ? parseQueue(f.text) : { version: 1, items: [] };
    } catch (e) {
      throw new HttpError(500, 'queue_corrupt', e.message);
    }
    const { changed, out } = fn(queue);
    if (!changed) return out;
    const text = serializeQueue(queue);
    if (enc.encode(text).length > LIMITS.maxQueueBytes) throw new HttpError(413, 'queue_too_large', 'queue.json vượt 1 MB.');
    const res = await ghRequest(env, 'PUT', `${repoPath(env)}/contents/queue.json`, {
      message, content: toB64(text), branch: env.GH_BRANCH, ...(f ? { sha: f.sha } : {}),
    });
    if (res.status === 200 || res.status === 201) return out;
    if (res.status === 409 || res.status === 422) {
      await sleep(150 * attempt);
      continue;
    }
    throw ghFail(res, 'ghi queue.json');
  }
  throw new HttpError(503, 'queue_busy', 'Không ghi được queue.json sau 5 lần (xung đột). Thử lại.');
}

// ---- xử lý yêu cầu ----
async function readBody(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > LIMITS.maxBody) throw new HttpError(413, 'body_too_large', 'Nội dung gửi lên quá lớn (tối đa 64 KB).');
  const text = await request.text();
  if (enc.encode(text).length > LIMITS.maxBody) throw new HttpError(413, 'body_too_large', 'Nội dung gửi lên quá lớn (tối đa 64 KB).');
  try {
    const j = JSON.parse(text || '{}');
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('x');
    return j;
  } catch {
    throw new HttpError(400, 'bad_json', 'Nội dung gửi lên không phải JSON hợp lệ.');
  }
}
const countOf = (q) => ({ total: q.items.length, pending: q.items.filter((i) => i.status === 'pending').length, naming: q.items.filter((i) => i.status === 'naming').length, failed: q.items.filter((i) => i.status === 'failed').length });

function dispatchWorkflow(env, file, inputs) {
  return ghRequest(env, 'POST', `${repoPath(env)}/actions/workflows/${encodeURIComponent(file)}/dispatches`, { ref: env.GH_BRANCH, inputs });
}
const releaseNaming = (env, ids) => mutateQueue(env, 'Bỏ qua bước lấy tên gốc (không gọi được workflow)', (queue) => {
  let n = 0;
  for (const it of queue.items) if (it && it.status === 'naming' && ids.includes(it.id)) { it.status = 'pending'; n++; }
  return { changed: n > 0, out: { released: n } };
});

async function addItems(env, request) {
  const body = await readBody(request);
  if (!Array.isArray(body.items) || body.items.length < 1) throw new HttpError(400, 'bad_request', 'Cần gửi mảng items (ít nhất 1 mục).');
  if (body.items.length > LIMITS.maxBatch) throw new HttpError(400, 'too_many_items', `Tối đa ${LIMITS.maxBatch} mục mỗi lần lưu.`);
  const allowedHosts = await getAllowedHosts(env);
  const results = new Array(body.items.length);
  const cands = [];
  const now = new Date();
  body.items.forEach((it, index) => {
    const reject = (code, message) => {
      results[index] = { index, ok: false, reason: code, message };
    };
    if (!it || typeof it !== 'object') return reject('bad_item', 'Mục không hợp lệ.');
    // Bỏ qua mọi provider/ref do client gửi (còn `referer` là trường riêng, được validate): Worker tự parse lại từ url.
    const p = parseLink(it.url, { allowedHosts });
    if (!p.ok) return reject(p.code, p.message);
    const o = validateOptions(it.options);
    if (!o.ok) return reject('bad_options', o.message);
    const l = validateLabel(it.label);
    if (!l.ok) return reject('bad_label', l.message);
    const rp = validateRefPage(it.referer);
    if (!rp.ok) return reject('bad_referer', rp.message);
    const lm = validateLinkMatch(it.link_match);
    if (!lm.ok) return reject('bad_link_match', lm.message);
    cands.push({ index, id: newItemId(now), provider: p.provider, ref: p.ref, options: o.value, label: l.value, referer: rp.value, link_match: p.provider === 'page_link' ? lm.value : null });
  });
  if (!cands.length) return { results, added: 0, ...countOf({ items: [] }) };

  const out = await mutateQueue(env, `Thêm ${cands.length} mục vào hàng đợi`, (queue) => {
    // chuẩn hoá tuỳ chọn của mục cũ (thiếu khoá mới như phone) để so khớp đúng với mục mới
    const norm = (o) => { const v = validateOptions(o); return v.ok ? v.value : o; };
    const keys = new Set(queue.items.filter((i) => i && (i.status === 'pending' || i.status === 'naming')).map((i) => dedupeKey(i.provider, i.ref, norm(i.options), i.referer || null, i.link_match || null)));
    const res = [];
    let added = 0;
    for (const c of cands) {
      const key = dedupeKey(c.provider, c.ref, c.options, c.referer, c.link_match);
      if (keys.has(key)) res.push({ index: c.index, ok: false, reason: 'duplicate', message: 'Đã có mục giống hệt đang chờ trong hàng đợi.' });
      else if (queue.items.length >= LIMITS.maxQueue) res.push({ index: c.index, ok: false, reason: 'queue_full', message: `Hàng đợi đã đầy (${LIMITS.maxQueue} mục).` });
      else {
        queue.items.push({ id: c.id, provider: c.provider, ref: c.ref, referer: c.referer, link_match: c.link_match, label: c.label, options: c.options, status: c.label ? 'pending' : 'naming', attempts: 0, ladder_start: 0, last_error: null, added_at: now.toISOString() });
        keys.add(key);
        res.push({ index: c.index, ok: true, id: c.id, provider: c.provider, naming: !c.label });
        added++;
      }
    }
    return { changed: added > 0, out: { res, added, counts: countOf(queue) } };
  });
  for (const r of out.res) results[r.index] = r;
  // Mục chưa có tên hiển thị: nhờ workflow "Lấy tên gốc" điền (làm ở đó để nhiều link không làm Worker quá tải).
  const namingIds = out.res.filter((r) => r.ok && r.naming).map((r) => r.id);
  let names = 'none';
  if (namingIds.length) {
    let ok = false;
    try {
      ok = (await dispatchWorkflow(env, env.NAMES_WORKFLOW_FILE || 'names.yml', {})).status === 204;
    } catch { /* xử lý như thất bại bên dưới */ }
    names = ok ? 'started' : 'failed';
    if (!ok) { // không gọi được workflow: thả các mục sang pending (tên trống) để không kẹt ở "naming"
      try { await releaseNaming(env, namingIds); } catch { /* plan.mjs vẫn tự nhận mục naming quá 15 phút */ }
    }
  }
  return { results, added: out.added, counts: out.counts, names };
}

async function patchItem(env, request, id) {
  const body = await readBody(request);
  if (!('options' in body) && !('label' in body) && !('referer' in body) && !('link_match' in body)) throw new HttpError(400, 'bad_request', 'Cần gửi options, label, referer hoặc link_match.');
  return mutateQueue(env, `Sửa mục ${id}`, (queue) => {
    const it = queue.items.find((i) => i && i.id === id);
    if (!it) throw new HttpError(404, 'not_found', 'Không tìm thấy mục.');
    if (!['pending', 'failed', 'naming'].includes(it.status)) throw new HttpError(409, 'item_busy', 'Mục không ở trạng thái sửa được.');
    if ('options' in body) {
      if (!body.options || typeof body.options !== 'object') throw new HttpError(400, 'bad_options', 'Tuỳ chọn không hợp lệ.');
      const o = validateOptions({ ...it.options, ...body.options });
      if (!o.ok) throw new HttpError(400, 'bad_options', o.message);
      it.options = o.value;
    }
    if ('label' in body) {
      const l = validateLabel(body.label);
      if (!l.ok) throw new HttpError(400, 'bad_label', l.message);
      it.label = l.value;
      if (it.status === 'naming' && it.label) it.status = 'pending'; // người dùng tự đặt tên thì khỏi chờ lấy tên
    }
    if ('referer' in body) {
      const rp = validateRefPage(body.referer);
      if (!rp.ok) throw new HttpError(400, 'bad_referer', rp.message);
      it.referer = rp.value;
    }
    if ('link_match' in body) {
      if (it.provider !== 'page_link') throw new HttpError(400, 'bad_link_match', 'Lọc link chỉ dùng cho link kiểu "trang có nút tải".');
      const lm = validateLinkMatch(body.link_match);
      if (!lm.ok) throw new HttpError(400, 'bad_link_match', lm.message);
      it.link_match = lm.value;
    }
    return { changed: true, out: { ok: true, item: it } };
  });
}

// Sửa nhiều mục trong MỘT lần ghi (một commit). Mục lỗi được báo riêng, các mục còn lại vẫn được áp.
async function patchBatch(env, request) {
  const body = await readBody(request);
  if (!Array.isArray(body.changes) || body.changes.length < 1) throw new HttpError(400, 'bad_request', 'Cần gửi mảng changes (ít nhất 1 mục).');
  if (body.changes.length > LIMITS.maxChanges) throw new HttpError(400, 'too_many_items', `Tối đa ${LIMITS.maxChanges} mục mỗi lần lưu.`);
  const out = await mutateQueue(env, `Sửa ${body.changes.length} mục trong hàng đợi`, (queue) => {
    const results = [];
    let updated = 0;
    for (const [index, ch] of body.changes.entries()) {
      const id = ch && typeof ch === 'object' ? ch.id : undefined;
      const no = (reason, message) => results.push({ index, id: typeof id === 'string' ? id.slice(0, 40) : null, ok: false, reason, message });
      if (!ch || typeof ch !== 'object' || Array.isArray(ch)) { no('bad_item', 'Mục không hợp lệ.'); continue; }
      if (typeof id !== 'string' || !ID_RE.test(id)) { no('bad_id', 'id không hợp lệ.'); continue; }
      if (!('options' in ch) && !('label' in ch) && !('referer' in ch) && !('link_match' in ch)) { no('bad_request', 'Cần gửi options, label, referer hoặc link_match.'); continue; }
      const it = queue.items.find((i) => i && i.id === id);
      if (!it) { no('not_found', 'Không tìm thấy mục (có thể đã xong hoặc đã bị xóa).'); continue; }
      if (!['pending', 'failed', 'naming'].includes(it.status)) { no('item_busy', 'Mục không ở trạng thái sửa được.'); continue; }
      let options = it.options;
      let label = it.label;
      let referer = it.referer ?? null;
      let linkMatch = it.link_match ?? null;
      if ('options' in ch) {
        if (!ch.options || typeof ch.options !== 'object' || Array.isArray(ch.options)) { no('bad_options', 'Tuỳ chọn không hợp lệ.'); continue; }
        const o = validateOptions({ ...it.options, ...ch.options });
        if (!o.ok) { no('bad_options', o.message); continue; }
        options = o.value;
      }
      if ('label' in ch) {
        const l = validateLabel(ch.label);
        if (!l.ok) { no('bad_label', l.message); continue; }
        label = l.value;
      }
      if ('referer' in ch) {
        const rp = validateRefPage(ch.referer);
        if (!rp.ok) { no('bad_referer', rp.message); continue; }
        referer = rp.value;
      }
      if ('link_match' in ch) {
        if (it.provider !== 'page_link') { no('bad_link_match', 'Lọc link chỉ dùng cho link kiểu "trang có nút tải".'); continue; }
        const lm = validateLinkMatch(ch.link_match);
        if (!lm.ok) { no('bad_link_match', lm.message); continue; }
        linkMatch = lm.value;
      }
      it.options = options;
      it.label = label;
      if (it.status === 'naming' && label) it.status = 'pending';
      it.referer = referer;
      if (it.provider === 'page_link') it.link_match = linkMatch;
      results.push({ index, id, ok: true });
      updated++;
    }
    return { changed: updated > 0, out: { results, updated, counts: countOf(queue) } };
  });
  return out;
}

const deleteItem = (env, id) =>
  mutateQueue(env, `Xóa mục ${id}`, (queue) => {
    const n = queue.items.length;
    queue.items = queue.items.filter((i) => !(i && i.id === id));
    if (queue.items.length === n) throw new HttpError(404, 'not_found', 'Không tìm thấy mục.');
    return { changed: true, out: { ok: true } };
  });

const retryItem = (env, id) =>
  mutateQueue(env, `Thử lại mục ${id}`, (queue) => {
    const it = queue.items.find((i) => i && i.id === id);
    if (!it) throw new HttpError(404, 'not_found', 'Không tìm thấy mục.');
    if (it.status !== 'failed') throw new HttpError(409, 'not_failed', 'Chỉ thử lại được mục đang ở trạng thái lỗi.');
    Object.assign(it, { status: 'pending', last_error: null, attempts: 0 });
    return { changed: true, out: { ok: true, item: it } };
  });

async function runWorkflow(env, request) {
  const body = await readBody(request);
  const mode = body.mode === undefined ? 'process' : body.mode;
  if (!['process', 'retry_failed', 'dry_run'].includes(mode)) throw new HttpError(400, 'bad_mode', 'Chế độ chạy không hợp lệ.');
  const inputs = { mode };
  if (body.only_id !== undefined && body.only_id !== null && body.only_id !== '') {
    if (typeof body.only_id !== 'string' || !ID_RE.test(body.only_id)) throw new HttpError(400, 'bad_id', 'only_id không hợp lệ.');
    inputs.only_id = body.only_id;
  }
  const res = await dispatchWorkflow(env, env.WORKFLOW_FILE, inputs);
  if (res.status === 204) return { ok: true };
  if (res.status === 404) throw new HttpError(502, 'workflow_not_found', 'Không tìm thấy workflow (hoặc PAT thiếu quyền Actions).');
  throw ghFail(res, 'kích hoạt workflow');
}

const CATALOG_DAYS = 14;
// Đọc catalog.json từ release mục lục (qua browser_download_url, repo public). null nếu chưa có hoặc hỏng.
async function readCatalog(env) {
  const rel = await ghRequest(env, 'GET', `${repoPath(env)}/releases/tags/${CATALOG_TAG}`);
  if (rel.status === 404) return { entries: null, url: null };
  if (rel.status !== 200) throw ghFail(rel, 'đọc release mục lục');
  const url = rel.data.html_url || null;
  const asset = (rel.data.assets || []).find((a) => a.name === CATALOG_JSON && a.state === 'uploaded');
  if (!asset || typeof asset.browser_download_url !== 'string' || !asset.browser_download_url.startsWith('https://github.com/')) return { entries: null, url };
  try {
    const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'video-compress-gateway' }, redirect: 'follow' });
    if (!res.ok) return { entries: null, url };
    return { entries: parseCatalog(await res.text()), url };
  } catch {
    return { entries: null, url };
  }
}
// Phương án dự phòng: liệt kê các release `vid-` (cả tag ngày lẫn tag cũ), tối đa 5 trang × 100.
async function listVideoReleases(env) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const r = await ghRequest(env, 'GET', `${repoPath(env)}/releases?per_page=100&page=${page}`);
    if (r.status !== 200) throw ghFail(r, 'đọc release');
    const arr = Array.isArray(r.data) ? r.data : [];
    all.push(...arr);
    if (arr.length < 100) break;
  }
  return all.filter((r) => typeof r.tag_name === 'string' && r.tag_name.startsWith('vid-') && !r.draft);
}

async function status(env) {
  if (cache.status && Date.now() - cache.status.at < 30000) return cache.status.data;
  const repo = `${env.GH_OWNER}/${env.GH_REPO}`;
  const tz = env.TIMEZONE || 'Asia/Ho_Chi_Minh';
  const runsP = ghRequest(env, 'GET', `${repoPath(env)}/actions/workflows/${encodeURIComponent(env.WORKFLOW_FILE)}/runs?per_page=5&branch=${encodeURIComponent(env.GH_BRANCH)}`);
  const catP = readCatalog(env).catch((e) => ({ entries: null, url: null, error: e }));
  const [runs, cat] = await Promise.all([runsP, catP]);
  if (runs.status !== 200) throw ghFail(runs, 'đọc các lần chạy');
  let entries = cat.entries;
  let source = 'catalog';
  if (!entries) {
    // chưa có catalog hoặc đọc lỗi → dựng tạm từ danh sách release
    source = 'releases';
    entries = fromReleases(await listVideoReleases(env), { repo, tz });
  }
  const data = {
    runs: (runs.data.workflow_runs || []).map((r) => ({ id: r.id, number: r.run_number, status: r.status, conclusion: r.conclusion, event: r.event, created_at: r.created_at, url: r.html_url })),
    days: daysView(entries, { repo, limitDays: CATALOG_DAYS }),
    catalog_url: cat.url || `https://github.com/${repo}/releases/tag/${CATALOG_TAG}`,
    source,
  };
  cache.status = { at: Date.now(), data };
  return data;
}

async function route(request, env, url, auth) {
  const m = request.method;
  const p = url.pathname;
  const itemId = (re) => {
    const x = re.exec(p);
    if (!x) return null;
    if (!ID_RE.test(x[1])) throw new HttpError(400, 'bad_id', 'id không hợp lệ.');
    return x[1];
  };
  if (p === '/api/queue' && m === 'GET') {
    const f = await readFile(env, 'queue.json');
    const q = f ? parseQueue(f.text) : { version: 1, items: [] };
    return { queue: q, counts: countOf(q) };
  }
  if (p === '/api/auth' && m === 'GET') return { kind: auth.kind, pin_set: !!(await readPin(env)) };
  if (p === '/api/auth/pin') {
    if (m === 'POST') return setPin(env, request, auth);
    if (m === 'DELETE') return deletePin(env, auth);
    throw new HttpError(405, 'method_not_allowed', 'Phương thức không được hỗ trợ.');
  }
  if (p === '/api/config' && m === 'GET') return { allowed_hosts: await getAllowedHosts(env), limits: { max_batch: LIMITS.maxBatch, max_queue: LIMITS.maxQueue } };
  if (p === '/api/queue/add' && m === 'POST') return addItems(env, request);
  if (p === '/api/queue/batch') {
    if (m === 'PATCH') return patchBatch(env, request);
    throw new HttpError(405, 'method_not_allowed', 'Phương thức không được hỗ trợ.');
  }
  if (p === '/api/run' && m === 'POST') return runWorkflow(env, request);
  if (p === '/api/status' && m === 'GET') return status(env);
  let id = itemId(/^\/api\/queue\/item\/([^/]+)$/);
  if (id) {
    if (m === 'PATCH') return patchItem(env, request, id);
    if (m === 'DELETE') return deleteItem(env, id);
    throw new HttpError(405, 'method_not_allowed', 'Phương thức không được hỗ trợ.');
  }
  id = itemId(/^\/api\/queue\/retry\/([^/]+)$/);
  if (id) {
    if (m === 'POST') return retryItem(env, id);
    throw new HttpError(405, 'method_not_allowed', 'Phương thức không được hỗ trợ.');
  }
  throw new HttpError(404, 'not_found', 'Không có đường dẫn này.');
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin !== env.ALLOWED_ORIGIN) return new Response(JSON.stringify({ error: 'forbidden_origin', message: 'Origin không được phép.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
  if (!url.pathname.startsWith('/api/')) return reply(env, 404, { error: 'not_found', message: 'Không có đường dẫn này.' });
  try {
    const auth = await authenticate(request, env);
    return reply(env, 200, await route(request, env, url, auth));
  } catch (e) {
    if (e instanceof HttpError) {
      return reply(env, e.status, { error: e.code, message: e.message, ...e.extra }, e.extra.retry_after ? { 'Retry-After': String(e.extra.retry_after) } : {});
    }
    console.error('Lỗi không mong đợi:', e && e.message); // không log password/PAT/link
    return reply(env, 500, { error: 'internal', message: 'Lỗi nội bộ của Worker.' });
  }
}

export default { fetch: (request, env) => handle(request, env) };
