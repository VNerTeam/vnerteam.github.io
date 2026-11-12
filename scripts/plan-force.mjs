// Kế hoạch cho workflow ép nén: lấy ĐÚNG 1 mục theo id (mọi trạng thái: pending/failed/naming), không kiểm tra hạn mức ngày.
// Chỉ đọc, không ghi queue. Xuất cùng định dạng với plan.mjs để dùng lại các bước của job nén.
import { loadSettings, loadAllowedHosts, readQueue, setOutput, summary } from './util.mjs';
import { validateItem, ID_RE } from '../docs/lib/schema.mjs';

function fail(msg) {
  console.log(`::error::${msg}`);
  summary(`### ❌ Ép nén không chạy\n\n${msg}`);
  setOutput('has_items', 'false');
  setOutput('matrix', { include: [] });
  setOutput('invalid', []);
  process.exit(1);
}

const settings = loadSettings();
const id = (process.env.ONLY_ID || '').trim();
if (!ID_RE.test(id)) fail(`id "${id.slice(0, 60)}" không đúng định dạng (ví dụ q-20261111-122541-bddf0e).`);

const raw = readQueue().items.find((i) => i && i.id === id);
if (!raw) fail(`Không có mục ${id} trong hàng đợi (có thể đã xong hoặc đã bị xoá).`);
const v = validateItem(raw, { allowedHosts: loadAllowedHosts() });
if (!v.ok) fail(`Mục ${id} sai định dạng: ${v.message}`);
const i = v.value;

setOutput('has_items', 'true');
setOutput('matrix', { include: [{ id: i.id, item: { id: i.id, provider: i.provider, ref: i.ref, referer: i.referer, link_match: i.link_match, label: i.label, options: i.options, attempts: i.attempts, ladder_start: i.ladder_start } }] });
setOutput('runner', JSON.stringify(settings.runner_label));
setOutput('free_disk', settings.free_disk_space ? 'true' : 'false');
setOutput('invalid', []);
summary([`### Ép nén 1 mục`, '', `- Mục: \`${i.id}\` ${i.label ? `• ${i.label}` : ''}`, `- Nguồn: ${i.provider} • ${i.options.resolution}/${i.options.quality}/${i.options.codec} (trạng thái hiện tại: ${i.status}, bắt đầu từ nấc tốc độ ${i.ladder_start || 0})`,
  '- Bỏ qua: kiểm tra thời gian nén, hạ nấc tốc độ, quét nguồn, hạn mức ngày. Giới hạn cứng còn lại: 6 giờ của GitHub cho 1 job.'].join('\n'));
