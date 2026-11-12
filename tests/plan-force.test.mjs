import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const ID = 'q-20261111-122541-bddf0e';
const mkItem = (id, status) => ({
  id, provider: 'direct_url', ref: { host: 'cdn.example.com', path: '/v.mp4', query: null }, referer: null, link_match: null, label: 'Phim', status, attempts: 2, ladder_start: 1, last_error: 'timeout', added_at: '2026-11-11T12:25:41.173Z',
  options: { resolution: 'original', quality: 'strong', codec: 'hevc', fps_cap: null, audio: 'opus_128', container: 'mp4', phone: true, fetch_mode: 'auto', min_vmaf: null },
});
function runPlan(items, onlyId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  fs.cpSync(path.join(ROOT, 'config'), path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config/allowed-hosts.json'), JSON.stringify({ hosts: [{ host: 'cdn.example.com', allow_query: false }] }));
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ version: 1, items }));
  const out = path.join(dir, 'out.txt');
  fs.writeFileSync(out, '');
  const r = spawnSync('node', [path.join(ROOT, 'scripts/plan-force.mjs')], { cwd: dir, env: { ...process.env, ONLY_ID: onlyId, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(dir, 'sum.md') }, encoding: 'utf8' });
  const o = {};
  for (const m of fs.readFileSync(out, 'utf8').matchAll(/^(\w+)<<(EOF_\w+)\n([\s\S]*?)\n\2$/gm)) o[m[1]] = m[3];
  return { code: r.status, o };
}

test('ép nén: lấy đúng 1 mục, kể cả mục failed (không kiểm tra hạn mức ngày)', () => {
  const r = runPlan([mkItem('q-20261111-000000-aaaaaa', 'pending'), mkItem(ID, 'failed')], ID);
  assert.equal(r.code, 0);
  assert.equal(r.o.has_items, 'true');
  const m = JSON.parse(r.o.matrix);
  assert.deepEqual(m.include.map((x) => x.id), [ID]);
  assert.equal(m.include[0].item.ladder_start, 1); // giữ nấc tốc độ đã lưu
  assert.equal(m.include[0].item.status, undefined);
});
test('ép nén: id sai định dạng hoặc không có trong hàng đợi thì báo lỗi, không chạy', () => {
  assert.equal(runPlan([mkItem(ID, 'pending')], 'abc').code, 1);
  const r = runPlan([mkItem(ID, 'pending')], 'q-20261111-999999-ffffff');
  assert.equal(r.code, 1);
  assert.equal(r.o.has_items, 'false');
});
