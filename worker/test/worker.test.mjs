import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handle, _resetCaches } from '../src/index.mjs';

const ORIGIN = 'https://me.github.io';
const PASSWORD = 'mat-khau-rat-dai-va-ngau-nhien-123';
const SALT = 'salt123';
const PAT = 'github_pat_SECRET_TOKEN_VALUE';
const ID = '1AbCdEfGhIjKlMnOpQrStUv';

function makeEnv() {
  const kv = new Map();
  return {
    GH_OWNER: 'me', GH_REPO: 'repo', GH_BRANCH: 'main', WORKFLOW_FILE: 'compress.yml', ALLOWED_ORIGIN: ORIGIN,
    GITHUB_PAT: PAT, PASSWORD_SALT: SALT, PASSWORD_HASH: crypto.createHash('sha256').update(SALT + PASSWORD).digest('hex'),
    RATE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) },
  };
}

// GitHub giả: lưu file trong bộ nhớ, sha tăng dần, có thể ép xung đột
function fakeGithub() {
  const st = { files: { 'queue.json': JSON.stringify({ version: 1, items: [] }) }, ver: 1, puts: 0, conflicts: 0, dispatches: [], seen: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    st.seen.push({ url: String(url), headers: init.headers });
    const json = (s, b) => new Response(b === undefined ? null : JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    const m = /\/contents\/(.+)$/.exec(u.pathname);
    if (m && (init.method || 'GET') === 'GET') {
      const f = st.files[decodeURIComponent(m[1])];
      return f === undefined ? json(404, {}) : json(200, { content: Buffer.from(f).toString('base64'), encoding: 'base64', sha: `sha${st.ver}` });
    }
    if (m && init.method === 'PUT') {
      const b = JSON.parse(init.body);
      st.puts++;
      if (st.conflicts > 0) { st.conflicts--; st.ver++; return json(409, {}); }
      if (b.sha !== `sha${st.ver}`) return json(409, {});
      st.files[decodeURIComponent(m[1])] = Buffer.from(b.content, 'base64').toString('utf8');
      st.ver++;
      return json(200, {});
    }
    if (u.pathname.endsWith('/dispatches')) { st.dispatches.push(JSON.parse(init.body)); return json(204); }
    return json(404, {});
  };
  return st;
}

const call = (env, path, { method = 'GET', body, auth = PASSWORD, origin = ORIGIN, ip = '1.1.1.1' } = {}) =>
  handle(new Request(`https://w.example${path}`, {
    method,
    headers: { Origin: origin, 'CF-Connecting-IP': ip, ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env);

const GDRIVE = `https://drive.google.com/file/d/${ID}/view`;
const q = (st) => JSON.parse(st.files['queue.json']);

test.beforeEach(() => _resetCaches());

test('sai password → 401; sai 5 lần → 429; đúng password cũng bị khoá', async () => {
  const env = makeEnv(); fakeGithub();
  assert.equal((await call(env, '/api/queue', { auth: null })).status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await call(env, "/api/queue", { auth: "sai" })).status, 401);
  const r = await call(env, '/api/queue', { auth: 'sai' });
  assert.equal(r.status, 401);
  const locked = await call(env, '/api/queue');
  assert.equal(locked.status, 429);
  assert.ok(locked.headers.get('Retry-After'));
  assert.equal((await call(env, '/api/queue', { ip: '2.2.2.2' })).status, 200); // IP khác không bị ảnh hưởng
});

test('Origin sai hoặc thiếu → 403', async () => {
  const env = makeEnv(); fakeGithub();
  assert.equal((await call(env, '/api/queue', { origin: 'https://evil.example' })).status, 403);
  const noOrigin = await handle(new Request('https://w.example/api/queue', { headers: { Authorization: `Bearer ${PASSWORD}` } }), env);
  assert.equal(noOrigin.status, 403);
  const pre = await call(env, '/api/queue', { method: 'OPTIONS', auth: null });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('add: tự parse lại, bỏ qua provider/ref giả, từ chối link xấu, một commit', async () => {
  const env = makeEnv(); const st = fakeGithub();
  const r = await call(env, '/api/queue/add', { method: 'POST', body: { items: [
    { url: GDRIVE, provider: 'direct_url', ref: { host: 'evil.com', path: '/x' }, options: { resolution: '4k' }, label: 'Thử' },
    { url: 'http://insecure.example/a.mp4' },
    { url: 'https://drive.google.com/drive/folders/' + ID },
    { url: GDRIVE, options: { codec: 'h264' } },
  ] } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.added, 1);
  assert.deepEqual(j.results.map((x) => x.ok), [true, false, false, false]);
  assert.equal(st.puts, 1);
  const item = q(st).items[0];
  assert.equal(item.provider, 'gdrive');
  assert.deepEqual(item.ref, { id: ID, resourcekey: null });
  assert.equal(item.options.resolution, '4k');
  assert.equal(item.status, 'pending');
});

test('add: từ chối trùng', async () => {
  const env = makeEnv(); fakeGithub();
  const add = () => call(env, '/api/queue/add', { method: 'POST', body: { items: [{ url: GDRIVE }] } }).then((r) => r.json());
  assert.equal((await add()).added, 1);
  const second = await add();
  assert.equal(second.added, 0);
  assert.equal(second.results[0].reason, 'duplicate');
});

test('xung đột sha được thử lại đúng', async () => {
  const env = makeEnv(); const st = fakeGithub();
  st.conflicts = 2;
  const r = await call(env, '/api/queue/add', { method: 'POST', body: { items: [{ url: GDRIVE }] } });
  assert.equal(r.status, 200);
  assert.equal(st.puts, 3);
  assert.equal(q(st).items.length, 1);
});

test('xung đột kéo dài → 503', async () => {
  const env = makeEnv(); const st = fakeGithub();
  st.conflicts = 99;
  assert.equal((await call(env, '/api/queue/add', { method: 'POST', body: { items: [{ url: GDRIVE }] } })).status, 503);
});

test('sửa, thử lại, xóa mục; id lạ bị từ chối', async () => {
  const env = makeEnv(); const st = fakeGithub();
  await call(env, '/api/queue/add', { method: 'POST', body: { items: [{ url: GDRIVE }] } });
  const id = q(st).items[0].id;
  let r = await call(env, `/api/queue/item/${id}`, { method: 'PATCH', body: { options: { quality: 'strong' }, label: 'Tên mới' } });
  assert.equal(r.status, 200);
  assert.equal(q(st).items[0].options.quality, 'strong');
  assert.equal((await call(env, `/api/queue/item/${id}`, { method: 'PATCH', body: { options: { codec: 'x' } } })).status, 400);
  assert.equal((await call(env, `/api/queue/retry/${id}`, { method: 'POST' })).status, 409);
  const raw = q(st); raw.items[0].status = 'failed'; raw.items[0].last_error = 'timeout'; st.files['queue.json'] = JSON.stringify(raw); st.ver++;
  assert.equal((await call(env, `/api/queue/retry/${id}`, { method: 'POST' })).status, 200);
  assert.equal(q(st).items[0].status, 'pending');
  assert.equal((await call(env, '/api/queue/item/../x', { method: 'DELETE' })).status, 404);
  assert.equal((await call(env, '/api/queue/item/khong-hop-le', { method: 'DELETE' })).status, 400);
  assert.equal((await call(env, `/api/queue/item/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal(q(st).items.length, 0);
});

test('run kích hoạt workflow, kiểm tra mode', async () => {
  const env = makeEnv(); const st = fakeGithub();
  assert.equal((await call(env, '/api/run', { method: 'POST', body: { mode: 'retry_failed' } })).status, 200);
  assert.deepEqual(st.dispatches[0], { ref: 'main', inputs: { mode: 'retry_failed' } });
  assert.equal((await call(env, '/api/run', { method: 'POST', body: { mode: 'rm -rf' } })).status, 400);
});

test('GET /api/queue; không bao giờ lộ PAT hoặc password; có User-Agent', async () => {
  const env = makeEnv(); const st = fakeGithub();
  await call(env, '/api/queue/add', { method: 'POST', body: { items: [{ url: GDRIVE }] } });
  const bodies = [];
  for (const [p, o] of [['/api/queue', {}], ['/api/config', {}], ['/api/queue', { auth: 'sai' }], ['/api/khong-co', {}], ['/api/queue/add', { method: 'POST', body: { items: [{ url: 'x' }] } }]]) {
    bodies.push(await (await call(env, p, o)).text());
  }
  for (const b of bodies) { assert.ok(!b.includes(PAT)); assert.ok(!b.includes(PASSWORD)); assert.ok(!b.includes(env.PASSWORD_HASH)); }
  assert.ok(st.seen.every((s) => s.headers['User-Agent'] && s.headers.Accept === 'application/vnd.github+json'));
});

test('PAT hết hạn → báo rõ', async () => {
  const env = makeEnv();
  globalThis.fetch = async () => new Response('{}', { status: 401 });
  const r = await call(env, '/api/queue');
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, 'pat_invalid');
});

test('body quá lớn → 413', async () => {
  const env = makeEnv(); fakeGithub();
  const r = await call(env, '/api/queue/add', { method: 'POST', body: { items: [{ url: 'https://x.example/' + 'a'.repeat(70000) }] } });
  assert.equal(r.status, 413);
});
