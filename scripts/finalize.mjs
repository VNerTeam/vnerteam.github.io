// Gom kết quả → cập nhật queue.json theo từng id → commit (thử lại khi xung đột) → gọi lại workflow nếu còn việc.
import fs from 'node:fs';
import { loadSettings, loadAllowedHosts, readQueue, writeQueue, run, gh, summary, sleep, countTodayVideos, fmtBytes } from './util.mjs';
import { syncCatalog } from './catalog-sync.mjs';
import { validateItem } from '../docs/lib/schema.mjs';

const settings = loadSettings();
const repo = process.env.GITHUB_REPOSITORY;
const branch = process.env.DEFAULT_BRANCH || 'main';
const mode = process.env.MODE || 'process';
const chain = Number.parseInt(process.env.CHAIN || '0', 10) || 0;
const parse = (s, d) => {
  try {
    return JSON.parse(s || '');
  } catch {
    return d;
  }
};
const planned = parse(process.env.PLAN_MATRIX, { include: [] }).include.map((x) => x.id);
const invalid = parse(process.env.PLAN_INVALID, []);

// đọc kết quả từng mục
const results = new Map();
if (fs.existsSync('results')) {
  for (const f of fs.readdirSync('results')) {
    if (!/^result-q-\d{8}-\d{6}-[0-9a-f]{6}\.json$/.test(f)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(`results/${f}`, 'utf8'));
      if (r && typeof r.id === 'string') results.set(r.id, r);
    } catch { /* bỏ qua file hỏng, mục sẽ bị tính là no_result */ }
  }
}
const changes = [];
for (const id of planned) {
  const r = results.get(id);
  changes.push(r ? { id, ...r } : { id, ok: false, error: 'no_result', retryable: true });
}
for (const x of invalid) changes.push({ id: x.id, ok: false, error: x.error, invalid: true });

function apply(queue) {
  let changed = false;
  for (const c of changes) {
    const idx = queue.items.findIndex((i) => i && i.id === c.id);
    if (idx < 0) continue; // đã bị xóa trong lúc chạy
    const it = queue.items[idx];
    if (c.ok) {
      queue.items.splice(idx, 1);
    } else if (c.invalid) {
      Object.assign(it, { status: 'failed', last_error: String(c.error).slice(0, 200) });
    } else {
      const attempts = (Number.isInteger(it.attempts) ? it.attempts : 0) + 1;
      const giveUp = !c.retryable || attempts >= settings.max_attempts;
      it.attempts = attempts;
      it.last_error = String(c.error || 'unknown').slice(0, 200);
      if (giveUp) it.status = 'failed';
      if (Number.isInteger(c.ladder_start)) it.ladder_start = Math.max(it.ladder_start || 0, Math.min(10, c.ladder_start));
    }
    changed = true;
  }
  return changed;
}

async function commitWithRetry() {
  await run('git', ['config', 'user.name', 'github-actions[bot]']);
  await run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  const ok = changes.filter((c) => c.ok).length;
  const failed = changes.length - ok;
  for (let i = 1; i <= 5; i++) {
    // luôn đọc lại queue mới nhất từ nhánh mặc định rồi chỉ áp thay đổi theo id
    const f = await run('git', ['fetch', '--depth=1', 'origin', branch]);
    if (f.code !== 0) throw new Error(`git fetch lỗi: ${f.stderr.slice(0, 200)}`);
    await run('git', ['reset', '--hard', `origin/${branch}`]);
    const q = readQueue();
    if (!apply(q)) return 'unchanged';
    writeQueue(q);
    await run('git', ['add', 'queue.json']);
    const c = await run('git', ['commit', '-m', `Cập nhật hàng đợi: ${ok} xong, ${failed} lỗi/chưa xong`]);
    if (c.code !== 0) throw new Error(`git commit lỗi: ${c.stderr.slice(0, 200)}`);
    const p = await run('git', ['push', 'origin', `HEAD:${branch}`]);
    if (p.code === 0) return 'committed';
    console.log(`Push bị từ chối (lần ${i}/5), thử lại: ${p.stderr.split('\n')[0]}`);
    await sleep(1000 * i + Math.random() * 1000);
  }
  throw new Error('Không push được queue.json sau 5 lần.');
}

const rows = changes.map((c) => {
  const r = results.get(c.id) || {};
  const state = c.ok ? '✅ xong' : `❌ ${c.error}`;
  const size = r.in_bytes && r.out_bytes ? `${fmtBytes(r.in_bytes)} → ${fmtBytes(r.out_bytes)}${r.phone ? ` (+ điện thoại ${fmtBytes(r.phone.size)})` : r.phone_skipped ? ' (bỏ bản điện thoại)' : ''}` : '';
  return `| \`${c.id}\` | ${state} | ${size} | ${r.tag ? `\`${r.tag}\`` : ''} |`;
});
const outcome = changes.length ? await commitWithRetry() : 'unchanged';
summary(['### Kết quả', '', `Hàng đợi: ${outcome}`, '', '| Mục | Kết quả | Dung lượng | Release |', '|---|---|---|---|', ...rows].join('\n'));

// Cập nhật release mục lục + body các release ngày. Chạy SAU khi đã commit queue.json và không bao giờ làm hỏng bước đó:
// nếu lỗi thì chỉ ghi cảnh báo, lần chạy sau tự đồng bộ lại (đối chiếu release hôm nay/hôm qua, dựng lại catalog nếu hỏng).
if (mode !== 'dry_run' && planned.length > 0) {
  const okResults = changes.filter((c) => c.ok).map((c) => results.get(c.id)).filter(Boolean);
  const cat = await syncCatalog({ repo, tz: settings.timezone, branch, results: okResults });
  const lines = [`### Mục lục`, '', cat.warnings.length ? `⚠️ Cập nhật chưa trọn vẹn (${cat.total} video trong catalog).` : `✅ Đã cập nhật mục lục (${cat.total} video), ${cat.updatedDays.length} release ngày.`];
  for (const w of cat.warnings) lines.push(`- ${w}`);
  summary(lines.join('\n'));
  for (const w of cat.warnings) console.log(`::warning::${w}`);
}

// Gọi lại workflow nếu còn mục chờ, chưa chạm hạn mức ngày và chưa vượt số lần nối tiếp.
if (mode !== 'dry_run' && mode !== 'force' && planned.length > 0) { // ép nén (1 mục thủ công) không tự gọi lại workflow
  const q = readQueue();
  const hosts = loadAllowedHosts();
  const pendingLeft = q.items.filter((i) => validateItem(i, { allowedHosts: hosts }).ok && i.status === 'pending').length;
  const todayCount = await countTodayVideos(repo, settings.timezone);
  const dayFull = todayCount >= settings.max_items_per_day;
  if (pendingLeft > 0 && !dayFull && chain + 1 < settings.max_chain) {
    const r = await gh(['workflow', 'run', 'compress.yml', '--repo', repo, '--ref', branch, '-f', 'mode=process', '-f', `chain=${chain + 1}`]);
    summary(r.code === 0 ? `➡️ Còn ${pendingLeft} mục chờ, đã gọi lại workflow (lần nối tiếp ${chain + 1}).` : `⚠️ Không gọi lại được workflow: ${r.stderr.slice(0, 200)}`);
  } else if (pendingLeft > 0) {
    summary(dayFull ? `⏸️ Còn ${pendingLeft} mục chờ nhưng đã chạm hạn mức ngày. Bấm "Chạy ngay" vào ngày sau.` : `⏸️ Còn ${pendingLeft} mục chờ; dừng nối tiếp để tránh vòng lặp (đã ${chain + 1} lần).`);
  }
}
