// Lấy TÊN GỐC của file cho các mục vừa thêm (status "naming"), điền vào tên hiển thị rồi chuyển sang "pending".
// Chạy bởi workflow names.yml (Worker gọi ngay sau khi thêm link). Làm ở đây thay vì trong Worker để nhiều link không làm Worker vượt giới hạn.
// Làm hết sức: không lấy được tên thì mục vẫn sang "pending" với tên trống, lúc nén sẽ lấy tên từ file tải về.
import { readQueue, writeQueue, loadAllowedHosts, run, sleep, log } from './util.mjs';
import { validateItem, validateLabel } from '../docs/lib/schema.mjs';
import { resolve, fetchFollow } from './resolvers.mjs';
import {
  browserHeaders, extractAnchors, pickLink, filenameFromResponse, filenameFromUrl, looksLikeVideoName, displayNameFromFile,
} from './fetch-core.mjs';

const POOL = 6;
const PER_ITEM_MS = 60000;

const decode = (t) => t.replace(/&(amp|quot|apos|lt|gt|#39);/g, (_, n) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', '#39': "'" }[n]));
async function readText(res, max = 2 * 1024 * 1024) {
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  while (n < max) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    n += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(parts).toString('utf8');
}

// Trả về tên file gốc (có đuôi) hoặc null. Chỉ GET nhẹ (Range 0-0), không tải file; link kiểu trang có nút tải chỉ đọc href chứ không gọi, để token dùng một lần không bị tiêu.
export async function fileNameFor(item, allowedHosts) {
  const plan = await resolve(item.provider, item.ref, { allowedHosts });
  if (plan.kind === 'http') {
    let fromReq = null;
    try {
      const { res, finalUrl } = await fetchFollow(plan.url, { hop: (u, i, prev) => ({ Range: 'bytes=0-0', ...browserHeaders(u, { ref: item.referer, first: plan.url, prev }) }) });
      await res.body?.cancel().catch(() => {});
      fromReq = res.status < 400 ? filenameFromResponse(res.headers.get('content-disposition'), finalUrl) : (looksLikeVideoName(filenameFromUrl(finalUrl)) ? filenameFromUrl(finalUrl) : null);
    } catch { /* mạng lỗi/chặn: dùng tên từ link */ }
    if (fromReq) return fromReq;
    const own = filenameFromUrl(plan.url);
    if (looksLikeVideoName(own)) return own;
    return plan.nameHint && looksLikeVideoName(plan.nameHint) ? plan.nameHint : null; // tham số download_filename chỉ là phương án cuối
  }
  if (plan.kind === 'gdown') {
    const rk = plan.resourcekey ? `?resourcekey=${encodeURIComponent(plan.resourcekey)}` : '';
    const { res } = await fetchFollow(`https://drive.google.com/file/d/${encodeURIComponent(plan.id)}/view${rk}`, { hop: (u, i, prev) => browserHeaders(u, { first: u, prev, doc: true }) });
    if (res.status >= 400) return null;
    const m = /<title>([^<]*)<\/title>/i.exec(await readText(res, 256 * 1024));
    const t = m ? decode(m[1]).replace(/\s+-\s+Google Drive\s*$/i, '').trim() : '';
    return t && !/^(Google Drive|Sign in|Error|Not Found|Đăng nhập)/i.test(t) ? t : null;
  }
  if (plan.kind === 'page') {
    const { res, finalUrl } = await fetchFollow(plan.url, { hop: (u, i, prev) => browserHeaders(u, { ref: item.referer, first: plan.url, prev, doc: true }) });
    if (res.status >= 400) return null;
    const pick = pickLink(extractAnchors(await readText(res), plan.linkClass, finalUrl), item.link_match);
    const n = pick.url ? filenameFromUrl(pick.url) : null;
    return looksLikeVideoName(n) ? n : null;
  }
  return null; // yt-dlp: tên lấy lúc nén
}

async function withTimeout(p, ms) {
  let t;
  try {
    return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('quá thời gian')), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

export async function resolveAll(items, allowedHosts, worker = fileNameFor) {
  const out = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, async () => {
    while (next < items.length) {
      const it = items[next++];
      let label = null;
      try {
        const name = await withTimeout(worker(it, allowedHosts), PER_ITEM_MS);
        const d = displayNameFromFile(name);
        const v = d ? validateLabel(d) : { ok: false };
        label = v.ok ? v.value : null;
      } catch (e) {
        log(`Mục ${it.id}: không lấy được tên (${String(e.code || e.message).slice(0, 60)}).`);
      }
      out.set(it.id, label);
    }
  }));
  return out;
}

// Áp kết quả lên queue: chỉ mục còn "naming"; không ghi đè tên người dùng đã nhập.
export function applyNames(queue, names) {
  let changed = false;
  for (const it of queue.items) {
    if (!it || it.status !== 'naming' || !names.has(it.id)) continue;
    const label = names.get(it.id);
    if (label && !it.label) it.label = label;
    it.status = 'pending';
    changed = true;
  }
  return changed;
}

async function commitWithRetry(names) {
  const branch = process.env.DEFAULT_BRANCH || 'main';
  await run('git', ['config', 'user.name', 'github-actions[bot]']);
  await run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  for (let i = 1; i <= 5; i++) {
    const f = await run('git', ['fetch', '--depth=1', 'origin', branch]);
    if (f.code !== 0) throw new Error(`git fetch lỗi: ${f.stderr.slice(0, 200)}`);
    await run('git', ['reset', '--hard', `origin/${branch}`]);
    const q = readQueue();
    if (!applyNames(q, names)) return 'unchanged';
    writeQueue(q);
    await run('git', ['add', 'queue.json']);
    const c = await run('git', ['commit', '-m', `Lấy tên gốc cho ${[...names.values()].filter(Boolean).length}/${names.size} mục`]);
    if (c.code !== 0) throw new Error(`git commit lỗi: ${c.stderr.slice(0, 200)}`);
    const p = await run('git', ['push', 'origin', `HEAD:${branch}`]);
    if (p.code === 0) return 'committed';
    console.log(`Push bị từ chối (lần ${i}/5), thử lại: ${p.stderr.split('\n')[0]}`);
    await sleep(1000 * i + Math.random() * 1000);
  }
  throw new Error('Không push được queue.json sau 5 lần.');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const allowedHosts = loadAllowedHosts();
  const todo = [];
  for (const raw of readQueue().items) {
    if (!raw || raw.status !== 'naming') continue;
    const v = validateItem(raw, { allowedHosts });
    todo.push(v.ok ? v.value : raw); // mục hỏng vẫn được chuyển sang pending để plan.mjs báo lỗi đúng chỗ
  }
  log(`Cần lấy tên cho ${todo.length} mục.`);
  if (!todo.length) process.exit(0);
  const valid = todo.filter((i) => validateItem(i, { allowedHosts }).ok);
  const names = await resolveAll(valid, allowedHosts);
  for (const i of todo) if (!names.has(i.id)) names.set(i.id, null);
  log(`Lấy được tên: ${[...names.values()].filter(Boolean).length}/${names.size}.`);
  log(`Kết quả ghi hàng đợi: ${await commitWithRetry(names)}.`);
}
