import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeFromQueueText, removeFromQueue, publishCatalog } from '../scripts/publish-item.mjs';

const item = (id) => ({ id, provider: 'direct_url', ref: { host: 'a.com', path: '/x.mp4', query: null }, status: 'pending', attempts: 0 });
const A = 'q-20261111-100001-a00001';
const B = 'q-20261111-100002-b00002';
const queueText = (...ids) => `${JSON.stringify({ version: 1, items: ids.map(item) }, null, 2)}\n`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));

test('removeFromQueueText chỉ bỏ đúng mục, giữ nguyên các mục khác', () => {
  const r = removeFromQueueText(queueText(A, B), A);
  assert.equal(r.removed, 1);
  assert.deepEqual(JSON.parse(r.text).items.map((i) => i.id), [B]);
  assert.equal(removeFromQueueText(queueText(B), A).removed, 0);
});

// ghFn giả lập Contents API, có thể bắt PUT đầu tiên thất bại (xung đột sha) để kiểm tra thử lại
function fakeGh({ text, failPuts = 0 }) {
  const st = { text, sha: 's1', puts: 0, calls: [] };
  const fn = async (args) => {
    st.calls.push(args);
    if (args[0] === 'api' && args[1] === '-X' && args[2] === 'PUT') {
      st.puts++;
      const body = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
      if (st.puts <= failPuts || body.sha !== st.sha) {
        st.sha = `s${st.puts + 1}`; // người khác vừa ghi
        return { code: 1, stdout: '', stderr: 'HTTP 409' };
      }
      st.text = Buffer.from(body.content, 'base64').toString('utf8');
      st.sha = `s${st.puts + 100}`;
      return { code: 0, stdout: '{}', stderr: '' };
    }
    return { code: 0, stdout: JSON.stringify({ encoding: 'base64', content: Buffer.from(st.text).toString('base64'), sha: st.sha }), stderr: '' };
  };
  return { fn, st };
}

test('removeFromQueue: xoá mục khỏi queue.json qua Contents API', async () => {
  const { fn, st } = fakeGh({ text: queueText(A, B) });
  assert.equal(await removeFromQueue({ repo: 'me/r', branch: 'main', id: A, dir: tmp(), ghFn: fn }), 'removed');
  assert.deepEqual(JSON.parse(st.text).items.map((i) => i.id), [B]);
});

test('removeFromQueue: xung đột sha thì đọc lại và thử lại, không làm mất mục của job khác', async () => {
  const { fn, st } = fakeGh({ text: queueText(A, B), failPuts: 2 });
  assert.equal(await removeFromQueue({ repo: 'me/r', branch: 'main', id: B, dir: tmp(), ghFn: fn }), 'removed');
  assert.equal(st.puts, 3);
  assert.deepEqual(JSON.parse(st.text).items.map((i) => i.id), [A]);
});

test('removeFromQueue: mục đã không còn thì không ghi gì', async () => {
  const { fn, st } = fakeGh({ text: queueText(B) });
  assert.equal(await removeFromQueue({ repo: 'me/r', branch: 'main', id: A, dir: tmp(), ghFn: fn }), 'absent');
  assert.equal(st.puts, 0);
});

test('removeFromQueue: ném lỗi (không nuốt) nếu xung đột mãi', async () => {
  const { fn } = fakeGh({ text: queueText(A), failPuts: 99 });
  await assert.rejects(removeFromQueue({ repo: 'me/r', branch: 'main', id: A, dir: tmp(), ghFn: fn, maxTries: 2 }), /xung đột/);
});

test('publishCatalog: bị job khác ghi đè mất mục thì ghi lại cho tới khi có trong catalog', async () => {
  const result = { id: A, tag: 'vid-20261111', date: '2026-11-11', time: '10:00', finished_at: '2026-11-11T10:00:00Z', name: 'x', main: { name: 'x-a00001-1080p-hevc.mkv', size: 10, url: 'https://x/y' }, phone: null };
  let syncs = 0;
  const syncFn = async () => { syncs++; return { warnings: [], total: 1 }; };
  const loadFn = async () => (syncs >= 2 ? [{ id: A, main: result.main }] : [{ id: B }]); // lần 1 bị ghi đè mất
  const r = await publishCatalog({ repo: 'me/r', tz: 'Asia/Ho_Chi_Minh', branch: 'main', result, dir: tmp(), syncFn, loadFn, maxTries: 4 });
  assert.equal(r.ok, true);
  assert.equal(syncs, 2);
});
