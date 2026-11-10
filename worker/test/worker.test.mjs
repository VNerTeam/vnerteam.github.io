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
  const st = { files: { 'queue.json': JSON.stringify({ version: 1, items: [] }) }, ver: 1, puts: 0, conflicts: 0, dispatches: [], seen: [], releases: {}, downloads: {}, list: [] };
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
    if (u.host === 'github.com' && st.downloads[u.pathname] !== undefined) return new Response(st.downloads[u.pathname], { status: 200 });
    if (/\/actions\/workflows\/.+\/runs$/.test(u.pathname)) return json(200, { workflow_runs: [{ id: 1, run_number: 7, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', created_at: '2026-11-10T01:00:00Z', html_url: 'https://github.com/me/repo/actions/runs/1' }] });
    const rt = /\/releases\/tags\/(.+)$/.exec(u.pathname);
    if (rt) return st.releases[rt[1]] ? json(200, st.releases[rt[1]]) : json(404, {});
    if (u.pathname.endsWith('/releases')) return json(200, u.searchParams.get('page') === '1' ? st.list : []);
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

const addOne = (env, url = GDRIVE, options) => call(env, '/api/queue/add', { method: 'POST', body: { items: [{ url, options }] } });
const ids = (st) => q(st).items.map((i) => i.id);

test('batch: sửa nhiều mục trong MỘT commit, báo lỗi từng mục', async () => {
  const env = makeEnv(); const st = fakeGithub();
  const G2 = `https://drive.google.com/file/d/2BcDeFgHiJkLmNoPqRsTuVw/view`;
  const G3 = `https://drive.google.com/file/d/3CdEfGhIjKlMnOpQrStUvWx/view`;
  for (const u of [GDRIVE, G2, G3]) await addOne(env, u);
  const [a, b, c] = ids(st);
  const putsBefore = st.puts;
  const r = await call(env, '/api/queue/batch', { method: 'PATCH', body: { changes: [
    { id: a, options: { quality: 'good', phone: false } },
    { id: b, options: { codec: 'av1' }, label: 'Tên B' },
    { id: c, options: { resolution: '8k' } },                // sai tuỳ chọn
    { id: 'q-20260101-000000-ffffff', options: { quality: 'good' } }, // không tồn tại
    { id: 'khong-hop-le', options: {} },
    { id: a },                                               // thiếu options/label
  ] } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(st.puts - putsBefore, 1); // một commit duy nhất
  assert.equal(j.updated, 2);
  assert.deepEqual(j.results.map((x) => x.ok), [true, true, false, false, false, false]);
  assert.deepEqual(j.results.slice(2).map((x) => x.reason), ['bad_options', 'not_found', 'bad_id', 'bad_request']);
  const items = q(st).items;
  assert.equal(items[0].options.quality, 'good'); assert.equal(items[0].options.phone, false);
  assert.equal(items[1].options.codec, 'av1'); assert.equal(items[1].label, 'Tên B');
  assert.equal(items[2].options.resolution, 'original'); // không đổi
});
test('batch: không có gì áp được → không commit; giới hạn 200; sai kiểu → 400', async () => {
  const env = makeEnv(); const st = fakeGithub();
  await addOne(env);
  const puts = st.puts;
  const r = await call(env, '/api/queue/batch', { method: 'PATCH', body: { changes: [{ id: 'q-20260101-000000-ffffff', options: {} }] } });
  assert.equal(r.status, 200); assert.equal((await r.json()).updated, 0); assert.equal(st.puts, puts);
  const many = Array.from({ length: 201 }, () => ({ id: 'q-20260101-000000-ffffff', options: {} }));
  const over = await call(env, '/api/queue/batch', { method: 'PATCH', body: { changes: many } });
  assert.equal(over.status, 400); assert.equal((await over.json()).error, 'too_many_items');
  assert.equal((await call(env, '/api/queue/batch', { method: 'PATCH', body: { changes: [] } })).status, 400);
  assert.equal((await call(env, '/api/queue/batch', { method: 'PATCH', body: {} })).status, 400);
  assert.equal((await call(env, '/api/queue/batch', { method: 'POST', body: { changes: [] } })).status, 405);
  const ok200 = Array.from({ length: 200 }, () => ({ id: 'q-20260101-000000-ffffff', options: {} }));
  assert.equal((await call(env, '/api/queue/batch', { method: 'PATCH', body: { changes: ok200 } })).status, 200);
});
test('add: mục cũ thiếu khoá phone vẫn bị phát hiện trùng', async () => {
  const env = makeEnv(); const st = fakeGithub();
  const o = { resolution: 'original', quality: 'strong', codec: 'hevc', fps_cap: null, audio: 'opus_128', container: 'mkv', min_vmaf: null }; // dạng cũ, không có phone
  st.files['queue.json'] = JSON.stringify({ version: 1, items: [{ id: 'q-20261108-153012-a1b2c3', provider: 'gdrive', ref: { id: ID, resourcekey: null }, label: null, options: o, status: 'pending', attempts: 0, ladder_start: 0, last_error: null, added_at: 'x' }] });
  const r = await (await addOne(env)).json();
  assert.equal(r.added, 0); assert.equal(r.results[0].reason, 'duplicate');
});

const CAT_ENTRY = (n) => ({ id: `q-20261110-00000${n}-00000${n}`, tag: 'vid-20261110', date: '2026-11-10', time: '09:0' + n, finished_at: `2026-11-10T02:0${n}:00Z`, name: `phim ${n}`, duration: 100,
  main: { name: `phim-00000${n}-hevc.mkv`, size: 1000, url: `https://github.com/me/repo/releases/download/vid-20261110/phim-00000${n}-hevc.mkv` }, phone: { name: `phim-00000${n}-phone.mp4`, size: 500 } });
test('status: đọc catalog.json từ release mục lục, nhóm theo ngày, cache 30 giây', async () => {
  const env = makeEnv(); const st = fakeGithub();
  const dl = 'https://github.com/me/repo/releases/download/muc-luc/catalog.json';
  st.releases['muc-luc'] = { html_url: 'https://github.com/me/repo/releases/tag/muc-luc', assets: [{ name: 'catalog.json', state: 'uploaded', browser_download_url: dl }] };
  st.downloads['/me/repo/releases/download/muc-luc/catalog.json'] = JSON.stringify([CAT_ENTRY(1), CAT_ENTRY(2)]);
  const r = await call(env, '/api/status');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.source, 'catalog');
  assert.equal(j.catalog_url, 'https://github.com/me/repo/releases/tag/muc-luc');
  assert.equal(j.days.length, 1); assert.equal(j.days[0].count, 2); assert.equal(j.days[0].date, '2026-11-10');
  assert.ok(j.days[0].items[0].phone.url.includes('phone.mp4'));
  assert.equal(j.runs[0].number, 7);
  const seen = st.seen.length;
  await call(env, '/api/status');
  assert.equal(st.seen.length, seen); // lần 2 lấy từ cache
});
test('status: không có/hỏng catalog → dự phòng liệt kê release vid- (cả 2 dạng tag), không giới hạn 15', async () => {
  const env = makeEnv(); const st = fakeGithub();
  const up = (name) => ({ name, state: 'uploaded', size: 10, browser_download_url: `https://github.com/me/repo/releases/download/t/${name}`, created_at: '2026-11-10T02:00:00Z' });
  st.list = [
    { tag_name: 'vid-20261110', assets: [up('a-aaaaaa-hevc.mkv'), up('a-aaaaaa-phone.mp4')] },
    { tag_name: 'vid-20261001-101010-abcdef', assets: [up('Cu-fhd-av1.mkv')] },
    ...Array.from({ length: 20 }, (_, i) => ({ tag_name: `vid-202609${String(i + 1).padStart(2, '0')}-101010-${String(i).padStart(6, '0')}`, assets: [up(`x${i}-fhd-av1.mkv`)] })),
    { tag_name: 'khong-lien-quan', assets: [] },
  ];
  const j = await (await call(env, '/api/status')).json();
  assert.equal(j.source, 'releases');
  assert.equal(j.days.length, 14); // 22 ngày có video, trang chỉ trả 14 ngày gần nhất (không còn cắt cứng 15 release)
  assert.equal(j.days[0].date, '2026-11-10');
  assert.equal(j.days[0].items[0].phone.name, 'a-aaaaaa-phone.mp4');
  assert.ok(j.days.some((d) => d.date === '2026-10-01'));
  // catalog.json hỏng cũng rơi về dự phòng
  _resetCaches();
  st.releases['muc-luc'] = { assets: [{ name: 'catalog.json', state: 'uploaded', browser_download_url: 'https://github.com/me/repo/releases/download/muc-luc/catalog.json' }] };
  st.downloads['/me/repo/releases/download/muc-luc/catalog.json'] = '{hong';
  assert.equal((await (await call(env, '/api/status')).json()).source, 'releases');
});
