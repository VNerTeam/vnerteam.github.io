// Phát hành NGAY từng video khi vừa xong (chạy bên trong job nén, không đợi job finalize):
//   1) cập nhật release mục lục + body/tiêu đề release ngày (có kiểm tra lại sau khi ghi, vì nhiều job chạy song song);
//   2) xoá mục khỏi queue.json bằng GitHub Contents API (có sha nên xung đột thì đọc lại và thử lại).
// Thứ tự cố ý: file đã lên release và được xác nhận → mục lục → xoá khỏi hàng đợi. Nếu job bị dừng giữa chừng thì
// hoặc mục còn trong hàng đợi (lần sau tự nhận ra đã xong nhờ findExisting), hoặc mục đã xong hẳn: không bao giờ
// có chuyện đã release mà link vẫn nằm trong hàng đợi chờ nén lại.
// Mọi lỗi ở đây chỉ ghi cảnh báo, không làm hỏng mục (finalize vẫn là lưới an toàn cuối cùng).
import fs from 'node:fs';
import path from 'node:path';
import { gh, sleep } from './util.mjs';
import { syncCatalog, loadCatalog } from './catalog-sync.mjs';
import { parseQueue, serializeQueue } from '../docs/lib/schema.mjs';
import { toEntry } from '../docs/lib/catalog.mjs';

// Hàm thuần: bỏ mục `id` khỏi nội dung queue.json. Trả { text, removed }.
export function removeFromQueueText(text, id) {
  const q = parseQueue(text);
  const before = q.items.length;
  q.items = q.items.filter((i) => !(i && i.id === id));
  return { text: serializeQueue(q), removed: before - q.items.length };
}

// Xoá mục khỏi queue.json trên nhánh mặc định. Idempotent: không còn mục thì coi như xong.
export async function removeFromQueue({ repo, branch, id, dir, ghFn = gh, maxTries = 6 }) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= maxTries; i++) {
    const g = await ghFn(['api', `repos/${repo}/contents/queue.json?ref=${encodeURIComponent(branch)}`]);
    if (g.code !== 0) throw new Error(`Không đọc được queue.json: ${String(g.stderr).slice(0, 160)}`);
    const meta = JSON.parse(g.stdout);
    let raw = meta.encoding === 'base64' && meta.content ? Buffer.from(meta.content, 'base64').toString('utf8') : null;
    if (raw === null) {
      // file > 1 MB: Contents API không trả nội dung, đọc qua blob
      const b = await ghFn(['api', `repos/${repo}/git/blobs/${meta.sha}`]);
      if (b.code !== 0) throw new Error(`Không đọc được blob queue.json: ${String(b.stderr).slice(0, 160)}`);
      raw = Buffer.from(JSON.parse(b.stdout).content, 'base64').toString('utf8');
    }
    const { text, removed } = removeFromQueueText(raw, id);
    if (!removed) return 'absent';
    const body = path.join(dir, 'queue-put.json');
    fs.writeFileSync(body, JSON.stringify({ message: `Đã phát hành ${id}: xoá khỏi hàng đợi`, content: Buffer.from(text, 'utf8').toString('base64'), sha: meta.sha, branch }));
    const p = await ghFn(['api', '-X', 'PUT', `repos/${repo}/contents/queue.json`, '--input', body]);
    if (p.code === 0) return 'removed';
    // 409/422: sha đã đổi (Worker hoặc job khác vừa ghi) → đọc lại rồi thử lại
    await sleep(process.env.NODE_TEST_CONTEXT ? 5 : 700 * i + Math.random() * 1000);
  }
  throw new Error(`Không xoá được ${id} khỏi queue.json sau ${maxTries} lần (xung đột liên tục).`);
}

// Cập nhật mục lục cho 1 kết quả và kiểm tra video đã nằm trong catalog.json (các job song song có thể ghi đè nhau → thử lại).
export async function publishCatalog({ repo, tz, branch, result, dir, syncFn = syncCatalog, loadFn = loadCatalog, ghFn = gh, maxTries = 5 }) {
  let last = null;
  for (let i = 1; i <= maxTries; i++) {
    last = await syncFn({ repo, tz, branch, results: [result], dir });
    const cat = await loadFn(repo, dir, ghFn).catch(() => null);
    const want = toEntry(result);
    const have = cat && cat.find((c) => c.id === want.id);
    // đủ khi video có trong catalog, và nếu có bản điện thoại thì cũng đã có
    if (have && (!want.phone || have.phone)) return { ok: true, tries: i, total: last.total, warnings: last.warnings };
    await sleep(process.env.NODE_TEST_CONTEXT ? 5 : 1500 * i + Math.random() * 2000);
  }
  return { ok: false, tries: maxTries, total: last ? last.total : 0, warnings: [...(last ? last.warnings : []), 'Mục lục chưa xác nhận được video này (finalize sẽ đồng bộ lại).'] };
}

// Gọi sau khi bản thường (hoặc bản điện thoại) đã lên release và được xác nhận.
// removeQueue: true ở lần đầu (ngay sau bản thường); lần sau (đã có bản điện thoại) chỉ cập nhật mục lục.
export async function publishNow({ repo, tz, branch, result, workDir, removeQueue, log = console.log }) {
  const dir = path.join(workDir, 'publish');
  const out = { catalog: false, queue: null };
  try {
    const c = await publishCatalog({ repo, tz, branch, result, dir: path.join(dir, 'catalog') });
    out.catalog = c.ok;
    for (const w of c.warnings) log(`::warning::${w}`);
    log(c.ok ? `Đã cập nhật mục lục ngay (${c.total} video, thử ${c.tries} lần).` : 'Chưa cập nhật được mục lục trong job; finalize sẽ làm tiếp.');
  } catch (e) {
    log(`::warning::Cập nhật mục lục trong job lỗi: ${String(e.message || e).slice(0, 200)}`);
  }
  if (removeQueue) {
    try {
      out.queue = await removeFromQueue({ repo, branch, id: result.id, dir });
      log(out.queue === 'removed' ? `Đã xoá ${result.id} khỏi hàng đợi.` : `${result.id} đã không còn trong hàng đợi.`);
    } catch (e) {
      log(`::warning::${String(e.message || e).slice(0, 200)} (finalize sẽ xoá khi chạy xong).`);
    }
  }
  return out;
}
