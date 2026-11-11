// Lấy TÊN GỐC của file cho các mục vừa thêm (status "naming"), điền vào tên hiển thị rồi chuyển sang "pending".
// Chạy bởi workflow names.yml (Worker gọi ngay sau khi thêm link). Làm ở đây thay vì trong Worker để nhiều link không làm Worker vượt giới hạn.
// Làm hết sức: không lấy được tên thì mục vẫn sang "pending" với tên trống, lúc nén sẽ lấy tên từ file tải về.
import { readQueue, writeQueue, loadAllowedHosts, run, sleep, log } from './util.mjs';
import { validateItem, validateLabel } from '../docs/lib/schema.mjs';
import { resolve, fetchFollow } from './resolvers.mjs';
import { matchAllowedHost, parseTitleSelector } from '../docs/lib/providers.mjs';
import {
  browserHeaders, extractAnchors, pickLink, filenameFromResponse, filenameFromUrl, looksLikeVideoName, displayNameFromFile, displayNameFromTitle, extractTitleText,
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
export async function fileNameFor(item, allowedHosts, planIn = null) {
  const plan = planIn || await resolve(item.provider, item.ref, { allowedHosts });
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

// Tiêu đề trang theo thẻ + class cấu hình (title_tag/title_class của host trong allowed-hosts.json). Chỉ đọc HTML thường, không chạy JavaScript.
async function titleFromPage(url, item, sel) {
  const { res } = await fetchFollow(url, { hop: (u, i, prev) => browserHeaders(u, { ref: item.referer, first: url, prev, doc: true }) });
  if (res.status >= 400) return null;
  return extractTitleText(await readText(res), sel);
}

// Thứ tự: (1) chữ trong thẻ+class cấu hình (chỉ link kiểu trang: page_link, yt-dlp), (2) tên file gốc của link, (3) không có.
// Trả về { name, source: 'title' | 'file' | 'none' }.
export async function nameFor(item, allowedHosts) {
  const plan = await resolve(item.provider, item.ref, { allowedHosts });
  if (plan.kind === 'page' || plan.kind === 'ytdlp') {
    const sel = parseTitleSelector(matchAllowedHost(item.ref.host, allowedHosts));
    if (sel) {
      try {
        const t = await titleFromPage(plan.url, item, sel);
        if (t) return { name: t, source: 'title' };
      } catch { /* chặn/mạng lỗi: xuống tên file */ }
    }
  }
  const f = await fileNameFor(item, allowedHosts, plan);
  return { name: f, source: f ? 'file' : 'none' };
}

async function withTimeout(p, ms) {
  let t;
  try {
    return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('quá thời gian')), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

export async function resolveAll(items, allowedHosts, worker = nameFor) {
  const out = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, async () => {
    while (next < items.length) {
      const it = items[next++];
      let label = null;
      let source = 'none';
      try {
        const r = await withTimeout(worker(it, allowedHosts), PER_ITEM_MS);
        const d = r.source === 'title' ? displayNameFromTitle(r.name) : displayNameFromFile(r.name);
        const v = d ? validateLabel(d) : { ok: false };
        if (v.ok) { label = v.value; source = r.source; }
      } catch (e) {
        log(`Mục ${it.id}: không lấy được tên (${String(e.code || e.message).slice(0, 60)}).`);
      }
      out.set(it.id, { label, source });
    }
  }));
  return out;
}

// Áp kết quả lên queue. Mặc định chỉ mục còn "naming" và không đè tên đã có.
// overwrite=true (chạy tay): ghi đè tên hiển thị của MỌI mục trong `names` nếu lấy được tên mới (không lấy được thì giữ tên cũ, không xoá).
export function applyNames(queue, names, { overwrite = false } = {}) {
  let changed = false;
  for (const it of queue.items) {
    if (!it || !names.has(it.id)) continue;
    const { label } = names.get(it.id);
    if (overwrite) {
      if (label && it.label !== label) { it.label = label; changed = true; }
    } else if (it.status === 'naming') {
      if (label && !it.label) it.label = label;
    } else continue;
    if (it.status === 'naming') { it.status = 'pending'; changed = true; }
  }
  return changed;
}

async function commitWithRetry(names, overwrite) {
  const branch = process.env.DEFAULT_BRANCH || 'main';
  await run('git', ['config', 'user.name', 'github-actions[bot]']);
  await run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  for (let i = 1; i <= 5; i++) {
    const f = await run('git', ['fetch', '--depth=1', 'origin', branch]);
    if (f.code !== 0) throw new Error(`git fetch lỗi: ${f.stderr.slice(0, 200)}`);
    await run('git', ['reset', '--hard', `origin/${branch}`]);
    const q = readQueue();
    if (!applyNames(q, names, { overwrite })) return 'unchanged';
    writeQueue(q);
    await run('git', ['add', 'queue.json']);
    const c = await run('git', ['commit', '-m', `${overwrite ? 'Ghi đè tên hiển thị' : 'Lấy tên gốc'} cho ${[...names.values()].filter((n) => n.label).length}/${names.size} mục`]);
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
  const overwrite = String(process.env.OVERWRITE || '').toLowerCase() === 'true';
  // Mặc định: chỉ mục "naming". overwrite: mọi mục hợp lệ trong hàng đợi (kể cả đã có tên hiển thị).
  const todo = [];
  for (const raw of readQueue().items) {
    if (!raw || (!overwrite && raw.status !== 'naming')) continue;
    const v = validateItem(raw, { allowedHosts });
    if (v.ok) todo.push(v.value);
    else if (!overwrite) todo.push(raw); // mục hỏng vẫn được chuyển sang pending để plan.mjs báo lỗi đúng chỗ
  }
  log(`${overwrite ? 'GHI ĐÈ: ' : ''}cần lấy tên cho ${todo.length} mục.`);
  if (!todo.length) process.exit(0);
  const names = await resolveAll(todo.filter((i) => validateItem(i, { allowedHosts }).ok), allowedHosts);
  for (const i of todo) if (!names.has(i.id)) names.set(i.id, { label: null, source: 'none' });
  const by = { title: 0, file: 0, none: 0 };
  for (const n of names.values()) by[n.source]++;
  log(`Nguồn tên: tiêu đề trên trang ${by.title}, tên file gốc ${by.file}, không lấy được ${by.none}.`);
  const none = [...names].filter(([, n]) => n.source === 'none').map(([id]) => id);
  if (none.length) log(`Chưa lấy được tên (xem link_class/title_class trong allowed-hosts.json): ${none.slice(0, 20).join(', ')}${none.length > 20 ? '…' : ''}`);
  log(`Kết quả ghi hàng đợi: ${await commitWithRetry(names, overwrite)}.`);
}
