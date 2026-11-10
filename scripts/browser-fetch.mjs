// Mức 2: mở link bằng Chrome thật (Playwright) để lấy cookie/phiên và tìm đúng link tải.
// Chạy như tiến trình con của process-item.mjs. Nhận việc qua biến môi trường BF_JOB (JSON), KHÔNG nhận qua dòng lệnh.
// Dòng CUỐI của stdout là một dòng JSON {"bf":1,...} (xem emit). Mọi URL phải qua mask() trước khi in; không bao giờ in cookie.
//
// Hai chế độ:
//   mặc định  → tìm link tải (sự kiện download hoặc luồng video trên trang), ghi cookie ra file Netscape (quyền 600), trả "bàn giao" cho curl/yt-dlp.
//   save:true → (dự phòng cho link dùng một lần) tải thẳng bằng chính trình duyệt về job.dest.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromeUA, chromeMajorOf, pickMediaUrl, toNetscapeCookies, isExecutableName, describeCookies, handoffReferer } from './fetch-core.mjs';
import { validateRefPage } from '../docs/lib/schema.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (v) => {
  if (typeof v === 'string' && v.length >= 4 && !/[\r\n]/.test(v)) console.log(`::add-mask::${v}`);
};
const log = (m) => console.log(`[trình duyệt] ${m}`);
class BfError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}
const emit = (obj) => console.log(JSON.stringify({ bf: 1, ...obj }));

let job;
try {
  job = JSON.parse(process.env.BF_JOB || '');
} catch {
  emit({ ok: false, code: 'browser_failed', message: 'BF_JOB không hợp lệ.' });
  process.exit(1);
}

function totalLen(h) {
  const cr = /\/(\d+)\s*$/.exec(h['content-range'] || '');
  if (cr) return Number(cr[1]);
  const n = Number(h['content-length']);
  return Number.isFinite(n) ? n : 0;
}

async function saveDownload(dl, dest, maxBytes, dlDir, deadlineMs) {
  let over = false;
  const timer = setInterval(() => {
    try {
      for (const f of fs.readdirSync(dlDir)) {
        const sz = fs.statSync(path.join(dlDir, f)).size;
        if (maxBytes && sz > maxBytes && !over) {
          over = true;
          dl.cancel().catch(() => {});
        }
      }
    } catch { /* thư mục chưa có file */ }
  }, 2000);
  let guard;
  try {
    const tooLong = new Promise((_, rej) => {
      guard = setTimeout(() => rej(new BfError('timeout', 'Hết thời gian khi tải bằng trình duyệt.')), Math.max(1000, deadlineMs - Date.now()));
    });
    let p;
    try {
      p = await Promise.race([dl.path(), tooLong]);
    } catch (e) {
      if (over) throw new BfError('input_too_big', 'File nguồn lớn hơn giới hạn dung lượng.');
      if (e instanceof BfError) {
        await dl.cancel().catch(() => {});
        throw e;
      }
      throw new BfError('browser_failed', `Trình duyệt tải lỗi: ${String(e.message || e).split('\n')[0].slice(0, 120)}`);
    }
    if (over) throw new BfError('input_too_big', 'File nguồn lớn hơn giới hạn dung lượng.');
    // Chuyển (không sao chép) để không tốn gấp đôi dung lượng đĩa; thư mục tải nằm cùng ổ với dest.
    try {
      fs.renameSync(p, dest);
    } catch {
      fs.copyFileSync(p, dest);
      fs.rmSync(p, { force: true });
    }
  } finally {
    clearInterval(timer);
    clearTimeout(guard);
  }
}

async function main() {
  const { url, ref = null, dir, chrome, pwDir, headed = false, noSandbox = false, save = false, dest = null, maxBytes = 0, phaseMs = 180000, totalMs = 600000 } = job;
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new BfError('browser_failed', 'Link không hợp lệ.');
  }
  if (u.protocol !== 'https:') throw new BfError('browser_failed', 'Chỉ mở link https.');
  const rp = validateRefPage(ref);
  if (!rp.ok) throw new BfError('browser_failed', rp.message);
  mask(url);
  if (rp.value) mask(rp.value);

  let playwright;
  try {
    playwright = createRequire(path.join(pwDir, 'x.js'))('playwright-core');
  } catch {
    throw new BfError('browser_unavailable', 'Chưa có playwright-core.');
  }
  fs.mkdirSync(dir, { recursive: true });
  const dlDir = path.join(dir, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });

  const args = ['--deny-permission-prompts', '--disable-notifications', '--no-first-run', '--no-default-browser-check'];
  // Runner dùng một lần và chỉ mở link https đã kiểm tra; Ubuntu 24.04 hạn chế user namespace nên Chrome không bật được sandbox ở đó.
  if (noSandbox) args.push('--no-sandbox');
  let browser;
  try {
    browser = await playwright.chromium.launch({ executablePath: chrome || undefined, headless: !headed, args, downloadsPath: dlDir, timeout: 60000 });
  } catch (e) {
    throw new BfError('browser_unavailable', `Không mở được Chrome: ${String(e.message || e).split('\n')[0].slice(0, 140)}`);
  }
  try {
    const major = chromeMajorOf(browser.version());
    const ua = chromeUA(major || undefined);
    log(`Chrome ${browser.version()} (${headed ? 'có giao diện qua xvfb' : 'headless'})`);
    const context = await browser.newContext({ userAgent: ua, locale: 'en-US', acceptDownloads: true, viewport: { width: 1366, height: 768 }, permissions: [] });
    await context.route(/^(?!https:|blob:|data:|about:)/i, (r) => r.abort()); // chỉ cho https
    const page = await context.newPage();
    const deadline = Date.now() + (save ? totalMs : phaseMs);
    const left = () => Math.max(5000, deadline - Date.now());

    let download = null;
    page.on('download', (d) => {
      download = d;
    });
    const cands = [];
    page.on('response', (r) => {
      try {
        const st = r.status();
        if (st !== 200 && st !== 206) return;
        const h = r.headers();
        const type = (h['content-type'] || '').toLowerCase();
        const rurl = r.url();
        if (!rurl.startsWith('https://')) return;
        if (type.startsWith('video/') || /mpegurl|dash\+xml|octet-stream/.test(type) || /\.(mp4|webm|mkv|mov|m4v|m3u8|mpd)(?:$|[?#])/i.test(rurl)) {
          cands.push({ url: rurl, type, length: totalLen(h) });
        }
      } catch { /* bỏ qua response lỗi */ }
    });

    // 1) mở "trang mở trước" để lấy cookie/phiên
    if (rp.value) {
      try {
        await page.goto(rp.value, { waitUntil: 'domcontentloaded', timeout: Math.min(45000, left()) });
        await sleep(3000);
        log('Đã mở trang mở trước.');
      } catch (e) {
        log(`Không mở được trang mở trước (${String(e.message || e).split('\n')[0].slice(0, 80)}), vẫn thử tiếp.`);
      }
    }

    // 2) mở link
    let resp = null;
    try {
      resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(60000, left()) });
    } catch (e) {
      if (!/download is starting|ERR_ABORTED/i.test(String(e.message))) throw new BfError('browser_failed', `Không mở được link: ${String(e.message || e).split('\n')[0].slice(0, 120)}`);
    }
    if (!resp) for (let i = 0; i < 24 && !download; i++) await sleep(250);

    if (download) {
      const name = download.suggestedFilename() || '';
      if (isExecutableName(name)) {
        await download.cancel().catch(() => {});
        throw new BfError('not_a_video', 'Từ chối: link tải về file chương trình, không phải video.');
      }
      const finalUrl = download.url();
      mask(finalUrl);
      if (save) {
        if (!dest) throw new BfError('browser_failed', 'Thiếu đường dẫn lưu.');
        await saveDownload(download, dest, maxBytes, dlDir, deadline);
        return { ok: true, kind: 'saved', name: name.slice(0, 120) };
      }
      const cookies = await context.cookies(finalUrl);
      await download.cancel().catch(() => {});
      return finish({ kind: 'file', url: finalUrl, name, cookies, referer: handoffReferer(page.url(), finalUrl, rp.value), ua });
    }
    if (save) throw new BfError('browser_failed', 'Lần mở lại không thấy tải về (link có thể chỉ dùng được một lần).');

    if (resp && (resp.status() === 401 || resp.status() === 403)) throw new BfError('access_denied', `Trang trả HTTP ${resp.status()} cả với trình duyệt thật (có thể bị chặn theo IP hoặc cần đăng nhập).`, { blocked: true });
    if (resp && (resp.status() === 404 || resp.status() === 410)) throw new BfError('not_found', 'Link không còn tồn tại (404).');
    if (resp && resp.status() === 429) throw new BfError('rate_limited', 'Nguồn giới hạn tốc độ (HTTP 429).');

    // 3) trang HTML: chờ trang tải, gom luồng video
    await page.waitForLoadState('networkidle', { timeout: Math.min(12000, left()) }).catch(() => {});
    for (let round = 0; round < 3; round++) {
      for (const fr of page.frames()) {
        try {
          const srcs = await fr.evaluate(() => [...document.querySelectorAll('video, video source')].map((e) => e.currentSrc || e.src || '').filter(Boolean));
          for (const s of srcs) cands.push({ url: s, type: 'video/dom', length: 0 });
        } catch { /* khung chéo origin không đọc được */ }
      }
      if (pickMediaUrl(cands) || Date.now() > deadline - 5000) break;
      await sleep(2500);
    }
    for (const c of cands) mask(c.url);
    const pick = pickMediaUrl(cands);
    if (!pick) {
      const onlyBlob = cands.some((c) => String(c.url).startsWith('blob:'));
      throw new BfError('browser_no_video', onlyBlob ? 'Trang chỉ phát video qua blob: (MSE), không có link tải được.' : 'Mở được trang nhưng không thấy luồng video tải được.');
    }
    const cookies = await context.cookies(pick.url);
    return finish({ kind: pick.kind === 'stream' ? 'stream' : 'file', url: pick.url, name: '', cookies, referer: handoffReferer(page.url(), pick.url, rp.value), ua });
  } finally {
    await browser.close().catch(() => {});
  }
}

// Ghi cookie ra file riêng (quyền 600); process-item xoá ngay sau khi dùng. Kết quả chỉ chứa đường dẫn, không chứa cookie.
function finish({ kind, url, name, cookies, referer, ua }) {
  let cookiesFile = null;
  if (cookies && cookies.length) {
    cookiesFile = path.join(job.dir, 'cookies.txt');
    fs.writeFileSync(cookiesFile, toNetscapeCookies(cookies), { mode: 0o600 });
    fs.chmodSync(cookiesFile, 0o600);
  }
  log(`Tìm thấy ${kind === 'stream' ? 'luồng HLS/DASH' : 'link tải'}; ${describeCookies(cookies)}.`);
  return { ok: true, kind, url, name: (name || '').slice(0, 120), cookiesFile, referer, ua };
}

try {
  emit(await main());
  process.exit(0);
} catch (e) {
  const code = e instanceof BfError ? e.code : 'browser_failed';
  const message = e instanceof BfError ? e.message : `Trình duyệt gặp lỗi: ${String(e && e.message).split('\n')[0].slice(0, 140)}`;
  emit({ ok: false, code, message, ...(e instanceof BfError ? e.extra : {}) });
  process.exit(1);
}
