// Đọc queue → validate → chọn mục → xuất matrix. Chỉ đọc, không ghi queue.
import { loadSettings, loadAllowedHosts, readQueue, countTodayReleases, setOutput, summary } from './util.mjs';
import { validateItem } from '../docs/lib/schema.mjs';

const settings = loadSettings();
const mode = ['process', 'retry_failed', 'dry_run'].includes(process.env.MODE) ? process.env.MODE : 'process';
const onlyId = (process.env.ONLY_ID || '').trim();
const repo = process.env.GITHUB_REPOSITORY;
const allowedHosts = loadAllowedHosts();

const queue = readQueue();
const valid = [];
const invalid = [];
for (const raw of queue.items) {
  const v = validateItem(raw, { allowedHosts });
  if (v.ok) valid.push(v.value);
  else if (raw && typeof raw.id === 'string') invalid.push({ id: raw.id.slice(0, 40), error: `invalid_schema: ${v.message}`.slice(0, 180) });
}

const wantStatus = mode === 'retry_failed' ? 'failed' : 'pending';
let candidates = valid.filter((i) => i.status === wantStatus);
if (onlyId) candidates = candidates.filter((i) => i.id === onlyId);

let slots = settings.max_items_per_run;
let dayLimit = false;
let usedToday = 0;
if (mode !== 'dry_run') {
  usedToday = await countTodayReleases(repo, settings.timezone);
  const left = settings.max_items_per_day - usedToday;
  if (left < slots) slots = Math.max(0, left);
  dayLimit = left <= 0;
}
const picked = candidates.slice(0, slots);

const matrix = {
  include: picked.map((i) => ({
    id: i.id,
    item: { id: i.id, provider: i.provider, ref: i.ref, label: i.label, options: i.options, attempts: i.attempts, ladder_start: i.ladder_start },
  })),
};
const run = mode !== 'dry_run' && picked.length > 0;

setOutput('has_items', run ? 'true' : 'false');
setOutput('matrix', matrix);
setOutput('runner', JSON.stringify(settings.runner_label));
setOutput('max_parallel', String(settings.max_parallel));
setOutput('free_disk', settings.free_disk_space ? 'true' : 'false');
setOutput('invalid', invalid);
setOutput('day_limit', dayLimit ? 'true' : 'false');

const lines = [`### Kế hoạch (chế độ: \`${mode}\`)`, '',
  `- Mục hợp lệ: ${valid.length} (chờ: ${valid.filter((i) => i.status === 'pending').length}, lỗi: ${valid.filter((i) => i.status === 'failed').length})`,
  `- Sẽ xử lý lần này: **${picked.length}** (tối đa ${settings.max_items_per_run}/lần, ${settings.max_items_per_day}/ngày; hôm nay đã tạo ${usedToday} release)`];
if (dayLimit) lines.push('- ⚠️ Đã chạm hạn mức ngày. Các mục chờ được giữ nguyên, hãy bấm "Chạy ngay" vào ngày mai.');
if (invalid.length) lines.push(`- ⚠️ ${invalid.length} mục sai schema sẽ bị đánh dấu lỗi.`);
if (mode === 'dry_run') for (const i of picked) lines.push(`  - \`${i.id}\` ${i.provider} (${i.options.resolution}/${i.options.quality}/${i.options.codec})`);
summary(lines.join('\n'));
