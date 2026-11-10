// Cập nhật release mục lục `muc-luc` và body/tiêu đề các release ngày. CHỈ `finalize` (chạy tuần tự) được gọi hàm này.
// Mọi lỗi đều được gom vào `warnings`, hàm không ném lỗi để không làm hỏng việc cập nhật queue.json.
import fs from 'node:fs';
import path from 'node:path';
import { gh, getReleaseByTag, tzParts } from './util.mjs';
import {
  CATALOG_TAG, CATALOG_TITLE, CATALOG_JSON, CATALOG_MD, DAY_TAG_RE, dayTagOf, dayTitle,
  toEntry, upsertEntries, parseCatalog, fromReleases, buildDayBody, buildCatalogBody, buildCatalogMarkdown,
} from '../docs/lib/catalog.mjs';

const dayTagsNearNow = (tz, now) => [now, new Date(now.getTime() - 86400000)].map((d) => { const p = tzParts(d, tz); return dayTagOf(`${p.y}${p.mo}${p.d}`); });

// Liệt kê release (phân trang tay, tối đa 1000) rồi chỉ giữ release ngày để dựng lại catalog.
async function listDayReleases(repo, ghFn) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const r = await ghFn(['api', `repos/${repo}/releases?per_page=100&page=${page}`]);
    if (r.code !== 0) throw new Error(`Không liệt kê được release: ${String(r.stderr).slice(0, 160)}`);
    const arr = JSON.parse(r.stdout || '[]');
    all.push(...arr);
    if (arr.length < 100) break;
  }
  return all.filter((x) => DAY_TAG_RE.test(x.tag_name));
}

async function loadCatalog(repo, dir, ghFn) {
  const rel = await getReleaseByTag(repo, CATALOG_TAG, ghFn);
  const asset = rel && (rel.assets || []).find((a) => a.name === CATALOG_JSON && a.state === 'uploaded');
  if (!asset) return null;
  fs.rmSync(path.join(dir, CATALOG_JSON), { force: true });
  const d = await ghFn(['release', 'download', CATALOG_TAG, '--repo', repo, '--pattern', CATALOG_JSON, '--dir', dir, '--clobber']);
  if (d.code !== 0) return null;
  try {
    return parseCatalog(fs.readFileSync(path.join(dir, CATALOG_JSON), 'utf8'));
  } catch {
    return null;
  }
}

export async function syncCatalog({ repo, tz, branch, results, dir = 'catalog-out', ghFn = gh, now = new Date() }) {
  const warnings = [];
  const warn = (m) => warnings.push(String(m).slice(0, 240));
  const out = { warnings, total: 0, updatedDays: [], rebuilt: false };
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 1) nạp catalog; hỏng/thiếu thì dựng lại từ các release ngày
    let catalog = null;
    try {
      catalog = await loadCatalog(repo, dir, ghFn);
    } catch (e) {
      warn(`Không đọc được catalog: ${e.message}`);
    }
    if (!catalog) {
      out.rebuilt = true;
      catalog = fromReleases(await listDayReleases(repo, ghFn), { repo, tz });
      warn(`catalog.json chưa có hoặc hỏng, đã dựng lại từ release ngày (${catalog.length} video, thiếu một phần siêu dữ liệu).`);
    }
    const touched = new Set();
    // 2) tự sửa: video có trong release hôm nay/hôm qua nhưng chưa có trong catalog (lần cập nhật trước bị lỗi)
    const fresh = results.map(toEntry).filter((e) => e.id && e.tag && DAY_TAG_RE.test(e.tag) && e.main);
    for (const e of fresh) touched.add(e.tag);
    for (const tag of dayTagsNearNow(tz, now)) {
      try {
        const rel = await getReleaseByTag(repo, tag, ghFn);
        if (!rel) continue;
        const thin = fromReleases([rel], { repo, tz });
        const known = new Set(catalog.filter((c) => c.tag === tag).map((c) => c.main.name));
        if (thin.some((t) => !known.has(t.main.name))) touched.add(tag);
        catalog = upsertEntries(catalog, thin);
      } catch (e) {
        warn(`Không đối chiếu được release ${tag}: ${e.message}`);
      }
    }
    // 3) áp kết quả mới (dữ liệu đầy đủ ghi đè bản dựng lại)
    catalog = upsertEntries(catalog, fresh);
    out.total = catalog.length;

    // 4) release mục lục: catalog.json + muc-luc.md + body
    fs.writeFileSync(path.join(dir, CATALOG_JSON), `${JSON.stringify(catalog)}\n`);
    fs.writeFileSync(path.join(dir, CATALOG_MD), buildCatalogMarkdown(catalog, { repo }));
    const bodyFile = path.join(dir, 'catalog-body.md');
    fs.writeFileSync(bodyFile, buildCatalogBody(catalog, { repo }));
    const exist = await getReleaseByTag(repo, CATALOG_TAG, ghFn);
    if (!exist) {
      const c = await ghFn(['release', 'create', CATALOG_TAG, '--repo', repo, '--title', CATALOG_TITLE, '--notes-file', bodyFile, '--target', branch, '--latest=false']);
      if (c.code !== 0) throw new Error(`Không tạo được release ${CATALOG_TAG}: ${String(c.stderr).slice(0, 160)}`);
    }
    const u = await ghFn(['release', 'upload', CATALOG_TAG, path.join(dir, CATALOG_JSON), path.join(dir, CATALOG_MD), '--repo', repo, '--clobber']);
    if (u.code !== 0) throw new Error(`Upload mục lục lỗi: ${String(u.stderr).slice(0, 160)}`);
    const e = await ghFn(['release', 'edit', CATALOG_TAG, '--repo', repo, '--title', CATALOG_TITLE, '--notes-file', bodyFile, '--latest=false']);
    if (e.code !== 0) throw new Error(`Cập nhật body mục lục lỗi: ${String(e.stderr).slice(0, 160)}`);

    // 5) body + tiêu đề các release ngày bị ảnh hưởng
    for (const tag of touched) {
      try {
        const items = catalog.filter((c) => c.tag === tag);
        if (!items.length) continue;
        const f = path.join(dir, `body-${tag}.md`);
        fs.writeFileSync(f, buildDayBody(items, { repo }));
        const r = await ghFn(['release', 'edit', tag, '--repo', repo, '--title', dayTitle(tag.slice(4), items.length), '--notes-file', f, '--latest=false']);
        if (r.code !== 0) warn(`Không cập nhật được release ${tag}: ${String(r.stderr).slice(0, 120)}`);
        else out.updatedDays.push(tag);
      } catch (err) {
        warn(`Lỗi khi cập nhật release ${tag}: ${err.message}`);
      }
    }
  } catch (err) {
    warn(`Cập nhật mục lục lỗi: ${err.message}. Lần chạy sau sẽ tự đồng bộ lại.`);
  }
  return out;
}
