// Cloudflare Worker: cổng ghi duy nhất vào hệ thống. PAT GitHub chỉ nằm trong secret của Worker.
// Luật lọc link/tuỳ chọn dùng chung với trình duyệt và workflow (docs/lib/*.mjs).
import { parseLink } from '../../docs/lib/providers.mjs';
import { validateOptions, validateLabel, newItemId, dedupeKey, parseQueue, serializeQueue, LIMITS, ID_RE } from '../../docs/lib/schema.mjs';

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
const cache = { status: null, hosts: null };
export function _resetCaches() {
  cache.status = null;
  cache.hosts = null;
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

// ---- chống dò password (đếm theo IP trong KV, chỉ ghi khi nhập sai) ----
async function readFails(env, ip) {
  const raw = await env.RATE.get(`fail:${ip}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function checkLock(env, ip) {
  const f = await readFails(env, ip);
  if (f && f.count >= FAIL_MAX && Date.now() - f.first < FAIL_WINDOW_MS) {
    const wait = Math.ceil((FAIL_WINDOW_MS - (Date.now() - f.first)) / 1000);
    throw new HttpError(429, 'too_many_attempts', `Nhập sai quá nhiều lần. Thử lại sau ${Math.ceil(wait / 60)} phút.`, { retry_after: wait });
  }
  return f;
}
async function recordFail(env, ip, prev) {
  const now = Date.now();
  const fresh = !prev || now - prev.first >= FAIL_WINDOW_MS;
  const rec = fresh ? { count: 1, first: now } : { count: prev.count + 1, first: prev.first };
  await env.RATE.put(`fail:${ip}`, JSON.stringify(rec), { expirationTtl: Math.max(60, Math.ceil(FAIL_WINDOW_MS / 1000)) });
}
async function authenticate(request, env) {
  if (!env.PASSWORD_HASH || !env.PASSWORD_SALT) throw new HttpError(500, 'not_configured', 'Worker chưa được cấu hình password.');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const prev = await checkLock(env, ip);
  const m = /^Bearer (.{1,256})$/.exec(request.headers.get('Authorization') || '');
  const ok = !!m && safeEqual(await sha256Hex(env.PASSWORD_SALT + m[1]), String(env.PASSWORD_HASH).toLowerCase());
  if (!ok) {
    await recordFail(env, ip, prev);
    throw new HttpError(401, 'unauthorized', 'Sai password.');
  }
  if (prev) await env.RATE.delete(`fail:${ip}`);
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
      if (Array.isArray(j.hosts)) list = j.hosts.filter((h) => h && typeof h.host === 'string').map((h) => ({ host: h.host, allow_query: h.allow_query === true, ytdlp: h.ytdlp === true }));
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
const countOf = (q) => ({ total: q.items.length, pending: q.items.filter((i) => i.status === 'pending').length, failed: q.items.filter((i) => i.status === 'failed').length });

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
    // Bỏ qua mọi provider/ref do client gửi: Worker tự parse lại từ url.
    const p = parseLink(it.url, { allowedHosts });
    if (!p.ok) return reject(p.code, p.message);
    const o = validateOptions(it.options);
    if (!o.ok) return reject('bad_options', o.message);
    const l = validateLabel(it.label);
    if (!l.ok) return reject('bad_label', l.message);
    cands.push({ index, id: newItemId(now), provider: p.provider, ref: p.ref, options: o.value, label: l.value });
  });
  if (!cands.length) return { results, added: 0, ...countOf({ items: [] }) };

  const out = await mutateQueue(env, `Thêm ${cands.length} mục vào hàng đợi`, (queue) => {
    const keys = new Set(queue.items.filter((i) => i && i.status === 'pending').map((i) => dedupeKey(i.provider, i.ref, i.options)));
    const res = [];
    let added = 0;
    for (const c of cands) {
      const key = dedupeKey(c.provider, c.ref, c.options);
      if (keys.has(key)) res.push({ index: c.index, ok: false, reason: 'duplicate', message: 'Đã có mục giống hệt đang chờ trong hàng đợi.' });
      else if (queue.items.length >= LIMITS.maxQueue) res.push({ index: c.index, ok: false, reason: 'queue_full', message: `Hàng đợi đã đầy (${LIMITS.maxQueue} mục).` });
      else {
        queue.items.push({ id: c.id, provider: c.provider, ref: c.ref, label: c.label, options: c.options, status: 'pending', attempts: 0, ladder_start: 0, last_error: null, added_at: now.toISOString() });
        keys.add(key);
        res.push({ index: c.index, ok: true, id: c.id, provider: c.provider });
        added++;
      }
    }
    return { changed: added > 0, out: { res, added, counts: countOf(queue) } };
  });
  for (const r of out.res) results[r.index] = r;
  return { results, added: out.added, counts: out.counts };
}

async function patchItem(env, request, id) {
  const body = await readBody(request);
  if (!('options' in body) && !('label' in body)) throw new HttpError(400, 'bad_request', 'Cần gửi options hoặc label.');
  return mutateQueue(env, `Sửa mục ${id}`, (queue) => {
    const it = queue.items.find((i) => i && i.id === id);
    if (!it) throw new HttpError(404, 'not_found', 'Không tìm thấy mục.');
    if (!['pending', 'failed'].includes(it.status)) throw new HttpError(409, 'item_busy', 'Mục không ở trạng thái sửa được.');
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
    }
    return { changed: true, out: { ok: true, item: it } };
  });
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
  const res = await ghRequest(env, 'POST', `${repoPath(env)}/actions/workflows/${encodeURIComponent(env.WORKFLOW_FILE)}/dispatches`, { ref: env.GH_BRANCH, inputs });
  if (res.status === 204) return { ok: true };
  if (res.status === 404) throw new HttpError(502, 'workflow_not_found', 'Không tìm thấy workflow (hoặc PAT thiếu quyền Actions).');
  throw ghFail(res, 'kích hoạt workflow');
}

async function status(env) {
  if (cache.status && Date.now() - cache.status.at < 30000) return cache.status.data;
  const [runs, rels] = await Promise.all([
    ghRequest(env, 'GET', `${repoPath(env)}/actions/workflows/${encodeURIComponent(env.WORKFLOW_FILE)}/runs?per_page=5&branch=${encodeURIComponent(env.GH_BRANCH)}`),
    ghRequest(env, 'GET', `${repoPath(env)}/releases?per_page=30`),
  ]);
  if (runs.status !== 200) throw ghFail(runs, 'đọc các lần chạy');
  if (rels.status !== 200) throw ghFail(rels, 'đọc release');
  const data = {
    runs: (runs.data.workflow_runs || []).map((r) => ({ id: r.id, number: r.run_number, status: r.status, conclusion: r.conclusion, event: r.event, created_at: r.created_at, url: r.html_url })),
    releases: (rels.data || []).filter((r) => typeof r.tag_name === 'string' && r.tag_name.startsWith('vid-') && !r.draft).slice(0, 15).map((r) => ({
      tag: r.tag_name, name: r.name, url: r.html_url, published_at: r.published_at,
      assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
    })),
  };
  cache.status = { at: Date.now(), data };
  return data;
}

async function route(request, env, url) {
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
  if (p === '/api/config' && m === 'GET') return { allowed_hosts: await getAllowedHosts(env), limits: { max_batch: LIMITS.maxBatch, max_queue: LIMITS.maxQueue } };
  if (p === '/api/queue/add' && m === 'POST') return addItems(env, request);
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
    await authenticate(request, env);
    return reply(env, 200, await route(request, env, url));
  } catch (e) {
    if (e instanceof HttpError) {
      return reply(env, e.status, { error: e.code, message: e.message, ...e.extra }, e.extra.retry_after ? { 'Retry-After': String(e.extra.retry_after) } : {});
    }
    console.error('Lỗi không mong đợi:', e && e.message); // không log password/PAT/link
    return reply(env, 500, { error: 'internal', message: 'Lỗi nội bộ của Worker.' });
  }
}

export default { fetch: (request, env) => handle(request, env) };
