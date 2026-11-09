// Chạy ở cuối job nén (if: always()). Nếu process-item chưa kịp ghi kết quả (job lỗi ở bước cài công cụ, bị hủy...)
// thì ghi kết quả lỗi để finalize biết lý do thật thay vì "no_result".
import fs from 'node:fs';
import { ID_RE } from '../docs/lib/schema.mjs';

let id;
try {
  id = JSON.parse(process.env.ITEM_JSON || '{}').id;
} catch { /* bỏ qua */ }
if (typeof id === 'string' && ID_RE.test(id)) {
  const file = `results/result-${id}.json`;
  if (!fs.existsSync(file)) {
    const status = process.env.JOB_STATUS || 'unknown';
    fs.mkdirSync('results', { recursive: true });
    const cancelled = status === 'cancelled';
    fs.writeFileSync(file, JSON.stringify({
      id, ok: false, error: cancelled ? 'cancelled' : 'job_failed', retryable: cancelled,
      detail: `Job kết thúc (${status}) trước khi xử lý xong. Mở log của job để xem bước nào lỗi.`,
    }));
    console.log(`::warning::Chưa có kết quả cho ${id}, đã ghi lỗi job_failed (${status}).`);
  }
}
