// Xử lý 1 mục hàng đợi. Mục truyền qua biến môi trường ITEM_JSON (không bao giờ ghép vào shell).
// Mỗi job chỉ chạy MỘT tiến trình nén tại một thời điểm.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, loadProfiles, loadAllowedHosts, readJson, run, gh, spawnStream, killAll, log, mask, fmtBytes, fmtDur, slugify, tzParts, sha256File, freeBytes, sleep, getReleaseByTag } from './util.mjs';
import { validateItem } from '../docs/lib/schema.mjs';
import { PROVIDERS } from '../docs/lib/providers.mjs';
import { Fail, resolve, probeUrl, fetchFollow, headCheck, secretsOf, fileHead } from './resolvers.mjs';
import { UA, browserHeaders, curlHeaderArgs, shouldFallbackToBrowser, probeVerdict, assessDownloadedHead, RETRYABLE_ERRORS, extractAnchors, pickLink, nameFromUrl, cookieHeaderFrom, handoffReferer } from './fetch-core.mjs';
import { ensureBrowser } from './browser-setup.mjs';
import { parseCrfSearch } from './parse.mjs';
import { makePlan, buildPhoneArgs, verifyPhone, displaySize, CORRUPT_RE, summarizeDecodeErrors, tolerantInputArgs, ffErrTail } from './encode-plan.mjs';
import { dayTagOf, dayTitle, dateDash, assetNames, phoneAssetName, parseMainName, isPhoneOf, isMainAsset, tzHM, downloadUrl } from '../docs/lib/catalog.mjs';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const ASSET_LIMIT = 2 * GiB - 16 * MiB; // giới hạn 2 GiB/asset, trừ biên an toàn
const HARD_CAP_MS = 340 * 60 * 1000; // trần 6 giờ của GitHub, chừa 20 phút

const settings = loadSettings();
const profiles = loadProfiles();
const REPO = process.env.GITHUB_REPOSITORY;
const BRANCH = process.env.DEFAULT_BRANCH || 'main';
const START = Number(process.env.JOB_START_EPOCH) * 1000 || Date.now();
const Q_LABEL = { good: 'Tốt', balanced: 'Cân bằng', strong: 'Mạnh' };
const MAX_DL_TRIES = 3; // số lần tải tối đa khi file nguồn tải về bị hỏng
let allowResume = true; // curl -C - (tải tiếp khi đứt). Tắt sau khi phát hiện file hỏng, vì ghép sai khi resume là nguyên nhân hay gặp

const budgetMs = () => START + settings.time_budget_min * 60000 - Date.now() - settings.reserve_min * 60000; // thời gian còn dùng cho tải+nén
const hardMs = () => START + HARD_CAP_MS - Date.now();

let workDir = null;
const result = { ok: false };

function cleanupSync() {
  try {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(path.join(os.homedir(), '.cache', 'gdown'), { recursive: true, force: true });
  } catch { /* bỏ qua */ }
}
function writeResult() {
  if (!result.id) return;
  fs.mkdirSync('results', { recursive: true });
  fs.writeFileSync(`results/result-${result.id}.json`, JSON.stringify(result));
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    killAll();
    result.ok = false;
    result.error = 'cancelled';
    result.retryable = true;
    cleanupSync();
    writeResult();
    process.exit(130);
  });
}

// ---------- ffprobe ----------
async function ffprobe(file) {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) throw new Fail('not_a_video', `ffprobe không đọc được file: ${r.stderr.split('\n')[0]}`);
  return JSON.parse(r.stdout);
}
const rate = (s) => {
  const [a, b] = String(s || '0/1').split('/').map(Number);
  return b ? a / b : 0;
};
function analyze(j) {
  const st = j.streams || [];
  const v = st.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Fail('not_a_video', 'File không có luồng video.');
  const duration = Number(j.format && j.format.duration) || Number(v.duration);
  if (!(duration > 0)) throw new Fail('not_a_video', 'Không đọc được thời lượng.');
  const rot = Math.abs(Number(((v.side_data_list || []).find((x) => x.rotation !== undefined) || {}).rotation ?? (v.tags && v.tags.rotate) ?? 0)) % 180 === 90;
  return {
    v, duration, fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate), width: v.width, height: v.height, rotated: rot,
    audio: st.filter((s) => s.codec_type === 'audio').map((s) => ({ index: s.index, codec: s.codec_name, channels: s.channels || 2 })),
    subs: st.filter((s) => s.codec_type === 'subtitle').map((s) => ({ index: s.index, codec: s.codec_name })),
    hdr: ['smpte2084', 'arib-std-b67'].includes(v.color_transfer),
    pixFmt: v.pix_fmt, codec: v.codec_name,
  };
}

// ---------- kế hoạch nén ----------
function buildLadder(codec, quality) {
  const q = profiles.qualities[quality];
  return profiles.ladder[codec].map((s) => ({ encoder: s.encoder, preset: s.preset === '@quality' ? (s.encoder === 'libsvtav1' ? q.svtav1_preset : q.x265_preset) : s.preset }));
}

// ---------- ab-av1 crf-search ----------
let helpText = '';
const hasFlag = (f) => helpText.includes(f);
const withTime = (cmd, args) => (fs.existsSync('/usr/bin/time') ? ['/usr/bin/time', ['-v', cmd, ...args]] : [cmd, args]);
function logPeakRam(stderr, what) {
  const m = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr || '');
  if (m) log(`RAM đỉnh (${what}): ${fmtBytes(Number(m[1]) * 1024)}`);
}

async function crfSearch({ input, encoder, preset, minVmaf, vf, pixFmt, tmp, timeoutMs }) {
  const args = ['crf-search', '-i', input, '--min-vmaf', String(minVmaf), '--preset', String(preset), '--encoder', encoder];
  if (hasFlag('--max-encoded-percent')) args.push('--max-encoded-percent', '100');
  if (vf) args.push('--vfilter', vf);
  if (pixFmt && hasFlag('--pix-format')) args.push('--pix-format', pixFmt);
  log(`crf-search: ${encoder} preset ${preset}, VMAF ≥ ${minVmaf}${vf ? `, vfilter ${vf}` : ''}`);
  fs.mkdirSync(tmp, { recursive: true });
  const [cmd, a] = withTime('ab-av1', args);
  const r = await spawnStream(cmd, a, { env: { AB_AV1_TEMP_DIR: tmp }, timeoutMs, onLine: (l, w) => w === 'out' && log(`  ${l.slice(0, 200)}`) });
  logPeakRam(r.stderr, 'crf-search');
  if (r.timedOut) throw new Fail('timeout', 'Hết thời gian ở bước tìm CRF.');
  const text = `${r.stdout}\n${r.stderr}`;
  if (/Failed to find a suitable crf/i.test(text)) throw new Fail('crf_not_found', `Không tìm được CRF đạt VMAF ${minVmaf}.`);
  const best = parseCrfSearch(r.stdout, minVmaf) || parseCrfSearch(text, minVmaf);
  if (!best) {
    const line = text.split('\n').filter((x) => /error|fail|invalid|unexpected/i.test(x)).slice(-1)[0] || text.trim().split('\n').slice(-1)[0] || '';
    throw new Fail('crf_search_failed', `ab-av1 crf-search không cho kết quả đọc được: ${line.slice(0, 160)}`);
  }
  log(`→ CRF ${best.crf}, VMAF ${best.vmaf}, dự đoán ${fmtBytes(best.bytes)} (${best.pct}%), nén khoảng ${best.seconds == null ? '?' : fmtDur(best.seconds)}`);
  return best;
}

// ---------- ffmpeg encode ----------
function buildFfmpegArgs({ input, output, a, plan, opt, step, crf, tolerant }) {
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats', ...(tolerant ? tolerantInputArgs() : []), '-i', input, '-map', `0:${a.v.index}`];
  for (const s of plan.audio) args.push('-map', `0:${s.index}`);
  for (const i of plan.subs) args.push('-map', `0:${i}`);
  if (plan.attach) args.push('-map', '0:t?');
  args.push('-map_chapters', '0', '-map_metadata', '0', '-fps_mode', 'passthrough');
  args.push('-c:v', step.encoder, '-crf', String(crf), '-preset', String(step.preset), '-pix_fmt', plan.pixFmt);
  if (plan.vf) args.push('-vf', plan.vf);
  if (step.encoder === 'libsvtav1') {
    if (a.duration > 180) args.push('-g', String(Math.max(1, Math.round((plan.fpsCap || a.fps || 30) * 10))), '-svtav1-params', 'scd=1');
  } else {
    args.push('-x265-params', 'log-level=error');
    if (opt.container === 'mp4') args.push('-tag:v', 'hvc1');
  }
  args.push(...plan.color);
  plan.audio.forEach((s, n) => {
    if (s.copy) return args.push(`-c:a:${n}`, 'copy');
    args.push(`-c:a:${n}`, s.codec, `-b:a:${n}`, `${s.kbps}k`);
    if (s.codec === 'libopus' && s.channels === 6) args.push(`-filter:a:${n}`, 'aformat=channel_layouts=5.1'); // libopus không nhận 5.1(side)
  });
  if (plan.subs.length) args.push('-c:s', opt.container === 'mp4' ? 'mov_text' : 'copy');
  if (plan.attach) args.push('-c:t', 'copy');
  args.push('-max_muxing_queue_size', '4096', output);
  return args;
}

async function encode(ctx, crf, step) {
  const args = buildFfmpegArgs({ ...ctx, crf, step });
  let lastLog = 0;
  const [cmd, a] = withTime('ffmpeg', args);
  const timeoutMs = Math.min(budgetMs(), hardMs() - 5 * 60000);
  if (timeoutMs < 60000) throw new Fail('timeout', 'Không còn đủ thời gian để nén.');
  log(`ffmpeg: ${step.encoder} -crf ${crf} -preset ${step.preset}`);
  const r = await spawnStream(cmd, a, {
    timeoutMs,
    onLine: (l, w) => {
      const m = /^out_time_us=(\d+)/.exec(l);
      if (w === 'out' && m && Date.now() - lastLog > 120000) {
        lastLog = Date.now();
        log(`  tiến độ ${Math.min(99, (Number(m[1]) / 1e6 / ctx.a.duration) * 100).toFixed(1)}%`);
      } else if (w === 'err' && !l.startsWith('\t') && !l.startsWith('Command ')) log(`  ffmpeg: ${l.slice(0, 200)}`);
    },
  });
  logPeakRam(r.stderr, 'ffmpeg');
  if (r.timedOut) throw new Fail('timeout', 'Nén vượt thời gian cho phép.');
  if (r.code !== 0) {
    // Lỗi do dữ liệu nguồn hỏng (NAL/AAC sai…) khác lỗi cấu hình nén: báo riêng để mục được tải lại ở lần thử sau.
    if (CORRUPT_RE.test(r.stderr)) throw new Fail('source_corrupt', `File nguồn bị hỏng dữ liệu nên ffmpeg dừng (mã ${r.code}): ${ffErrTail(r.stderr)}`);
    throw new Fail('encode_failed', `ffmpeg lỗi (mã ${r.code}): ${ffErrTail(r.stderr)}`);
  }
}

// ---------- kiểm tra file nguồn sau khi tải ----------
// Giải mã thử TOÀN BỘ file (không ghi ra đâu) để bắt file hỏng giữa chừng. crf-search chỉ lấy vài đoạn mẫu nên không phát hiện được.
// Trả { count, sample }, hoặc null nếu bỏ qua (không đủ thời gian / hết giờ).
async function scanSource(file) {
  const timeoutMs = Math.min(15 * 60000, budgetMs() * 0.1, hardMs() - 30 * 60000);
  if (timeoutMs < 60000) {
    log('Bỏ qua kiểm tra toàn vẹn file nguồn: không đủ thời gian.');
    return null;
  }
  log('Kiểm tra toàn vẹn file nguồn (giải mã thử toàn bộ)…');
  const t0 = Date.now();
  const lines = [];
  const r = await spawnStream('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'],
    { timeoutMs, onLine: (l, w) => w === 'err' && lines.length < 5000 && lines.push(l) });
  if (r.timedOut) {
    log('::warning::Kiểm tra toàn vẹn file nguồn quá lâu, bỏ qua.');
    return null;
  }
  const s = summarizeDecodeErrors(lines);
  log(`Kiểm tra xong trong ${fmtDur((Date.now() - t0) / 1000)}: ${s.count ? `${s.count} dòng lỗi` : 'không lỗi'}.`);
  return s;
}

// ---------- tải ----------
const budgetDl = () => Math.min(budgetMs(), hardMs() - 10 * 60000);

// Kiểm tra vài KB đầu của file vừa tải. HTML/JSON (web trả mã 200 kèm trang chặn) → xoá file, báo "bị chặn" để logic chọn mức biết.
function checkDownloaded(dest) {
  try {
    assessDownloadedHead(headCheck(fileHead(dest)), (c, m, x) => new Fail(c, m, x));
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
}

// Mức 1: curl có header giống trình duyệt, tải tiếp được khi đứt (-C -).
async function curlGet({ url, dest, maxBytes, timeoutMs, headers, ua = UA, cookiesFile = null, cookieString = '' }) {
  const args = ['--fail', '--location', '--max-redirs', '5', '--proto', '=https', '--proto-redir', '=https', '--retry', '5', '--retry-all-errors', '--retry-delay', '5',
    ...(allowResume ? ['-C', '-'] : []), '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '180', '--silent', '--show-error', '-A', ua, ...curlHeaderArgs(headers)];
  if (cookiesFile) args.push('-b', cookiesFile);
  else if (cookieString) args.push('-b', cookieString); // chuỗi "a=b; c=d" lấy từ Set-Cookie của trang (không bao giờ log)
  if (maxBytes) args.push('--max-filesize', String(maxBytes));
  args.push('-o', dest, url);
  const r = await spawnStream('curl', args, { timeoutMs });
  if (r.timedOut) throw new Fail('timeout', 'Hết thời gian khi tải.');
  if (r.code === 63) throw new Fail('input_too_big', `File nguồn lớn hơn ${settings.max_input_gb} GB.`);
  if (r.code !== 0) {
    const m = /error: (\d{3})/.exec(r.stderr);
    const code = m ? Number(m[1]) : 0;
    if (code === 404 || code === 410) throw new Fail('not_found', 'Link không còn tồn tại.');
    if (code === 401 || code === 403) throw new Fail('access_denied', 'Không có quyền tải file.', { blocked: true });
    if (code === 429) throw new Fail('rate_limited', 'Nguồn giới hạn tốc độ, thử lại sau.');
    throw new Fail('download_failed', `curl lỗi ${r.code}: ${r.stderr.trim().split('\n').slice(-1)[0].slice(0, 160)}`);
  }
  checkDownloaded(dest);
}

// Mức 2: Chrome thật qua Playwright (scripts/browser-fetch.mjs), chạy như tiến trình con.
const BF_PASS = new Set(['link_not_found', 'browser_failed', 'browser_no_video', 'browser_unavailable', 'access_denied', 'not_found', 'rate_limited', 'timeout', 'input_too_big', 'not_a_video']);
async function runBrowser(setup, job, timeoutMs) {
  const [cmd, args] = setup.headed ? [setup.xvfb, ['-a', process.execPath, 'scripts/browser-fetch.mjs']] : [process.execPath, ['scripts/browser-fetch.mjs']];
  const r = await spawnStream(cmd, args, {
    env: { BF_JOB: JSON.stringify(job), ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}) },
    timeoutMs,
    // Lệnh che (::add-mask::) do tiến trình con in ra phải được chuyển tiếp lên log của runner thì mới có tác dụng.
    onLine: (l) => {
      if (l.startsWith('::add-mask::')) console.log(l);
      else if (l.startsWith('[trình duyệt]')) log(l);
    },
  });
  if (r.timedOut) throw new Fail('browser_failed', 'Hết thời gian ở bước trình duyệt.');
  const line = r.stdout.split('\n').reverse().find((l) => l.startsWith('{"bf":1'));
  let res = null;
  try {
    res = line ? JSON.parse(line) : null;
  } catch { /* để xuống phần lỗi */ }
  if (!res) throw new Fail('browser_failed', `Trình duyệt thoát (mã ${r.code}) mà không trả kết quả.`);
  for (const k of ['url', 'referer']) if (typeof res[k] === 'string') mask(res[k]);
  if (!res.ok) throw new Fail(BF_PASS.has(res.code) ? res.code : 'browser_failed', String(res.message || '').slice(0, 200), res.blocked ? { blocked: true } : {});
  return res;
}

async function browserDownload(plan, dest, maxBytes, ctx) {
  const bdir = path.join(workDir, 'bf'); // nằm trong thư mục tạm của mục nên được dọn cùng
  const version = readJson('config/tools.json').playwright_core?.version;
  if (!version) throw new Fail('browser_unavailable', 'Thiếu playwright_core.version trong config/tools.json.');
  const setup = await ensureBrowser({ dir: bdir, version, wantHeaded: settings.browser_headed });
  const phaseMs = Math.min(settings.browser_phase_min * 60000, budgetDl());
  if (phaseMs < 60000) throw new Fail('timeout', 'Không còn đủ thời gian để mở trình duyệt.');
  const job = { url: plan.url, ref: ctx.referer, dir: path.join(bdir, 'run'), chrome: setup.chrome, pwDir: setup.pwDir, headed: setup.headed, noSandbox: process.env.GITHUB_ACTIONS === 'true', maxBytes: maxBytes || ctx.maxIn, phaseMs, linkClass: plan.linkClass || null, linkMatch: ctx.linkMatch || null };
  const res = await runBrowser(setup, job, phaseMs + 60000);
  const dropCookies = () => { if (res.cookiesFile) fs.rmSync(res.cookiesFile, { force: true }); };
  try {
    if (res.kind === 'stream') {
      // HLS/DASH: giao cho yt-dlp, kèm Referer/User-Agent/cookie lấy từ trình duyệt.
      const extra = ['--add-header', `Referer:${res.referer}`, '--user-agent', res.ua, ...(res.cookiesFile ? ['--cookies', res.cookiesFile] : [])];
      const y = await downloadYtdlp({ kind: 'ytdlp', url: res.url }, workDir, ctx.maxIn, extra);
      return { method: 'ytdlp', file: y.file, nameHint: y.title };
    }
    try {
      await curlGet({ url: res.url, dest, maxBytes, timeoutMs: budgetDl(), headers: browserHeaders(res.url, { ref: res.referer }), ua: res.ua, cookiesFile: res.cookiesFile });
      return { method: 'browser', file: dest, nameHint: res.name || null };
    } catch (e) {
      if (!(e instanceof Fail) || e.blocked !== true) throw e;
      // Link dùng một lần (token): để chính trình duyệt tải thẳng về đĩa.
      log('Bàn giao cho curl vẫn bị chặn → tải thẳng bằng trình duyệt.');
      fs.rmSync(dest, { force: true });
      const r2 = await runBrowser(setup, { ...job, save: true, dest, totalMs: budgetDl() }, budgetDl() + 60000);
      checkDownloaded(dest);
      return { method: 'browser', file: dest, nameHint: r2.name || res.name || null };
    }
  } finally {
    dropCookies();
  }
}

// Chọn mức theo fetch_mode: auto = curl trước, bị chặn thì trình duyệt; curl = không bao giờ dùng trình duyệt; browser = bỏ qua mức 1.
async function downloadHttp(plan, dest, maxBytes, ctx) {
  if (ctx.mode !== 'browser' && !ctx.deferred) {
    const url = (ctx.probe && ctx.probe.finalUrl) || plan.url;
    const redirected = url !== plan.url;
    const headers = browserHeaders(url, { ref: ctx.referer, first: plan.url, prev: redirected ? ctx.probe.prevUrl : null });
    try {
      await curlGet({ url, dest, maxBytes, timeoutMs: budgetDl(), headers });
      return { method: 'curl', file: dest };
    } catch (e) {
      if (!(e instanceof Fail) || !shouldFallbackToBrowser(e, ctx.mode)) throw e;
      log(`Tải thường bị chặn (${e.code}) → chuyển sang trình duyệt thật.`);
      fs.rmSync(dest, { force: true });
    }
  } else if (ctx.mode === 'auto') log('Bước kiểm tra cho thấy link bị chặn hoặc là trang web → dùng thẳng trình duyệt thật.');
  return browserDownload(plan, dest, maxBytes, ctx);
}

// ---------- trang có nút tải (page_link): tìm thẻ <a> theo class, lấy href ngay lúc tải (token còn mới) ----------
const readText = async (res, max = 2 * 1024 * 1024) => {
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
};
const noLink = (reason, total, classes, match) => (reason === 'nomatch'
  ? new Fail('link_not_found', `Có ${total} link trong thẻ a class "${classes.join(' ')}" nhưng không link nào chứa "${match}".`)
  : new Fail('link_not_found', `Không thấy thẻ a nào có class "${classes.join(' ')}" (trang có thể tải link bằng JavaScript hoặc bị chặn).`));

// Mức 1 của page_link: tải HTML bằng fetch có header giống trình duyệt rồi đọc thẻ <a>. Giữ cookie của trang để gửi kèm khi tải file.
async function plainPageLink(plan, ctx) {
  const { res, finalUrl } = await fetchFollow(plan.url, { hop: (u, i, prev) => browserHeaders(u, { ref: ctx.referer, first: plan.url, prev, doc: true }) });
  if (res.status === 404 || res.status === 410) throw new Fail('not_found', 'Trang không còn tồn tại (404).');
  if (res.status === 401 || res.status === 403) throw new Fail('access_denied', `Trang không cho mở (HTTP ${res.status}).`, { blocked: true });
  if (res.status === 429) throw new Fail('rate_limited', 'Nguồn giới hạn tốc độ (HTTP 429), thử lại sau.');
  if (res.status >= 400) throw new Fail(`http_${res.status}`, `Nguồn trả lỗi HTTP ${res.status}.`);
  const cookieString = cookieHeaderFrom(typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []);
  const html = await readText(res);
  const pick = pickLink(extractAnchors(html, plan.linkClass, finalUrl), ctx.linkMatch);
  if (!pick.url) throw noLink(pick.reason, pick.total, plan.linkClass, ctx.linkMatch);
  mask(pick.url);
  log(`Tìm thấy ${pick.matched ?? pick.total}/${pick.total} link khớp class${pick.matched > 1 ? ' (lấy link đầu tiên, hãy thêm "Lọc link" nếu cần đúng link khác)' : ''}.`);
  return { url: pick.url, pageUrl: finalUrl, cookieString };
}

async function downloadPage(plan, dest, maxBytes, ctx) {
  if (ctx.mode !== 'browser') {
    let got = null;
    try {
      got = await plainPageLink(plan, ctx);
    } catch (e) {
      if (!(e instanceof Fail) || ctx.mode === 'curl' || !(e.blocked === true || e.code === 'access_denied' || e.code === 'link_not_found')) throw e;
      log(`Mở trang bằng cách thường chưa lấy được link (${e.code}) → dùng trình duyệt thật.`);
    }
    if (got) {
      try {
        const headers = browserHeaders(got.url, { ref: handoffReferer(got.pageUrl, got.url, null) });
        await curlGet({ url: got.url, dest, maxBytes, timeoutMs: budgetDl(), headers, cookieString: got.cookieString });
        return { method: 'curl', file: dest, nameHint: nameFromUrl(got.url) };
      } catch (e) {
        if (!(e instanceof Fail) || !shouldFallbackToBrowser(e, ctx.mode)) throw e;
        log(`Tải link vừa lấy bị chặn (${e.code}) → dùng trình duyệt thật.`);
        fs.rmSync(dest, { force: true });
      }
    }
  }
  return browserDownload(plan, dest, maxBytes, ctx);
}

async function downloadGdown(plan, dest, timeoutMs) {
  const url = `https://drive.google.com/uc?id=${plan.id}${plan.resourcekey ? `&resourcekey=${plan.resourcekey}` : ''}`;
  mask(url);
  // -O <thư mục>/ để gdown giữ nguyên tên file gốc trên Drive (dùng làm tên gợi ý cho video)
  const gdDir = path.join(path.dirname(dest), 'gd');
  fs.rmSync(gdDir, { recursive: true, force: true });
  fs.mkdirSync(gdDir, { recursive: true });
  const r = await spawnStream('gdown', ['-q', '-O', `${gdDir}${path.sep}`, url], { timeoutMs });
  if (r.timedOut) throw new Fail('timeout', 'Hết thời gian khi tải.');
  const t = `${r.stdout}\n${r.stderr}`;
  if (/too many users|quota/i.test(t)) throw new Fail('drive_quota', 'Google Drive đang giới hạn lượt tải của file này. Thử lại sau vài giờ.');
  const got = fs.existsSync(gdDir) ? fs.readdirSync(gdDir).filter((f) => !f.startsWith('.')) : [];
  if (r.code !== 0 || got.length !== 1) {
    if (/cannot retrieve the public link|permission|access denied|failed to retrieve file url/i.test(t)) throw new Fail('drive_private', 'File Drive chưa chia sẻ "bất kỳ ai có link".');
    throw new Fail('download_failed', `gdown lỗi: ${t.trim().split('\n').slice(-1)[0].slice(0, 160) || 'không thấy file tải về'}`);
  }
  fs.renameSync(path.join(gdDir, got[0]), dest);
  fs.rmSync(gdDir, { recursive: true, force: true });
  plan.nameHint = got[0];
  log(`Tên file gốc trên Drive: ${got[0]}`);
}


// ---------- yt-dlp (trang không có link tải thẳng) ----------
let ytdlpBin = 'yt-dlp';
const YTDLP_RETRY = ['download_failed', 'ytdlp_unsupported', 'access_denied']; // lỗi có thể do bản yt-dlp đã cũ
function classifyYtdlp(t) {
  if (/unsupported url/i.test(t)) return ['ytdlp_unsupported', 'yt-dlp không hỗ trợ trang này.'];
  if (/drm/i.test(t)) return ['drm_protected', 'Video có bảo vệ DRM, không tải được.'];
  if (/larger than max-filesize|larger than --max-filesize/i.test(t)) return ['input_too_big', `File nguồn lớn hơn ${settings.max_input_gb} GB.`];
  if (/http error 429|too many requests/i.test(t)) return ['rate_limited', 'Trang đang giới hạn tốc độ, thử lại sau.'];
  if (/private video|sign in|log ?in required|members-only|not a bot|age-restricted|http error 40[13]|forbidden/i.test(t)) return ['access_denied', 'Trang không cho tải (riêng tư, cần đăng nhập hoặc bị chặn).'];
  if (/http error 404|video unavailable|has been removed|does not exist|not found/i.test(t)) return ['not_found', 'Video không còn tồn tại.'];
  const last = t.split('\n').filter((x) => /^ERROR/i.test(x)).slice(-1)[0] || t.trim().split('\n').slice(-1)[0] || '';
  return ['download_failed', `yt-dlp lỗi: ${last.slice(0, 160)}`];
}
async function ytdlpVersion(bin) {
  return (await run(bin, ['--version'])).stdout.trim();
}
// Tải bản yt-dlp mới nhất (stable hoặc nightly theo settings) vào thư mục tạm của mục. Trả về đường dẫn hoặc null nếu không mới hơn.
async function updateYtdlp() {
  const repo = settings.ytdlp_update_channel === 'nightly' ? 'yt-dlp/yt-dlp-nightly-builds' : 'yt-dlp/yt-dlp';
  const dir = path.join(workDir, 'ytdlp-latest');
  const r = await gh(['release', 'download', '--repo', repo, '--pattern', 'yt-dlp_linux', '--dir', dir, '--clobber']);
  const bin = path.join(dir, 'yt-dlp_linux');
  if (r.code !== 0 || !fs.existsSync(bin)) {
    log(`Không tải được yt-dlp mới nhất: ${r.stderr.slice(0, 160)}`);
    return null;
  }
  fs.chmodSync(bin, 0o755);
  const [oldV, newV] = [await ytdlpVersion(ytdlpBin), await ytdlpVersion(bin)];
  if (!newV || oldV === newV) {
    log(`yt-dlp đã là bản mới nhất (${oldV}), không có gì để cập nhật.`);
    return null;
  }
  log(`::warning::yt-dlp ${oldV} đã cũ, dùng bản mới nhất ${newV}. Hãy cập nhật yt_dlp.tag trong config/tools.json.`);
  result.ytdlp_updated_to = newV;
  return bin;
}
async function ytdlpOnce(plan, dir, maxBytes, extra = []) {
  const timeoutMs = Math.min(budgetMs(), hardMs() - 10 * 60000);
  if (timeoutMs < 60000) throw new Fail('timeout', 'Không còn đủ thời gian để tải.');
  const titleFile = path.join(dir, 'title.txt');
  const args = ['--ignore-config', '--no-playlist', '--no-cache-dir', '--no-mtime', '--no-progress', '--socket-timeout', '30', '--retries', '5', '--fragment-retries', '5',
    '--js-runtimes', 'node', '-f', 'bv*+ba/b', '--merge-output-format', 'mkv', '--max-filesize', String(maxBytes), '--print-to-file', '%(title)s', titleFile,
    ...extra, '-o', path.join(dir, 'input.%(ext)s'), '--', plan.url];
  const r = await spawnStream(ytdlpBin, args, { timeoutMs, onLine: (l) => /^(ERROR|WARNING)/.test(l) && log(`  yt-dlp: ${l.slice(0, 200)}`) });
  if (r.timedOut) throw new Fail('timeout', 'Hết thời gian khi tải.');
  const text = `${r.stdout}\n${r.stderr}`;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('input.') && !/\.(part|ytdl|temp)$/.test(f));
  const pick = files.includes('input.mkv') ? 'input.mkv' : files.sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0];
  if (r.code !== 0 || !pick) {
    const [code, message] = classifyYtdlp(text);
    return { ok: false, code, message };
  }
  let title = null;
  try {
    title = fs.readFileSync(titleFile, 'utf8').split('\n')[0].trim().slice(0, 80) || null;
  } catch { /* không có tiêu đề */ }
  return { ok: true, file: path.join(dir, pick), title };
}
async function downloadYtdlp(plan, dir, maxBytes, extra = []) {
  let a = await ytdlpOnce(plan, dir, maxBytes, extra);
  if (!a.ok && YTDLP_RETRY.includes(a.code)) {
    log(`Tải lỗi (${a.code}). Thử cập nhật yt-dlp lên bản mới nhất rồi tải lại…`);
    const nb = await updateYtdlp();
    if (nb) {
      ytdlpBin = nb;
      for (const f of fs.readdirSync(dir)) if (f.startsWith('input.')) fs.rmSync(path.join(dir, f), { force: true });
      a = await ytdlpOnce(plan, dir, maxBytes, extra);
    }
  }
  if (!a.ok) throw new Fail(a.code, a.message);
  return a;
}

// ---------- release theo ngày ----------
const okAsset = (x) => !!x && x.state === 'uploaded' && x.size > 0;
const relErr = (e) => new Fail('gh_error', String(e.message || e).slice(0, 200));
function dayInfo(date = new Date()) {
  const p = tzParts(date, settings.timezone);
  const ymd = `${p.y}${p.mo}${p.d}`;
  return { ymd, tag: dayTagOf(ymd), date: `${p.y}-${p.mo}-${p.d}`, time: `${p.h}:${p.mi}`, at: `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi} (${settings.timezone})` };
}

// Chống làm lại: tìm trong release ngày hôm nay và hôm qua xem đã có bản thường (tên chứa -hash6-, uploaded, size > 0) chưa.
async function findExisting(hash6) {
  const now = Date.now();
  for (const t of [now, now - 86400000]) {
    const info = dayInfo(new Date(t));
    let rel;
    try {
      rel = await getReleaseByTag(REPO, info.tag);
    } catch (e) {
      throw relErr(e);
    }
    if (!rel) continue;
    const assets = (rel.assets || []).filter(okAsset);
    const main = assets.find((x) => isMainAsset(x.name) && x.name.includes(`-${hash6}-`));
    if (!main) continue;
    const phone = assets.find((x) => isPhoneOf(main.name, x.name));
    return { tag: info.tag, ymd: info.tag.slice(4), main, phone };
  }
  return null;
}

// Tạo release ngày nếu chưa có, chịu được race giữa các job chạy song song.
async function ensureDayRelease(info) {
  let last = '';
  for (let i = 1; i <= 5; i++) {
    const v = await gh(['release', 'view', info.tag, '--repo', REPO, '--json', 'tagName']);
    if (v.code === 0) return;
    const c = await gh(['release', 'create', info.tag, '--repo', REPO, '--title', dayTitle(info.ymd, 1), '--notes', 'Danh sách video của ngày này sẽ được cập nhật khi lượt chạy hoàn tất.', '--target', BRANCH, '--latest=false']);
    if (c.code === 0) return;
    last = (c.stderr || '').trim().slice(-160);
    log(`  tạo release ${info.tag} chưa được (lần ${i}/5): ${last}`); // thường là job khác vừa tạo xong ("already exists"); vòng sau xem lại
    await sleep(1000 * i + Math.random() * 1000);
  }
  throw new Fail('release_failed', `Không tạo/đọc được release ${info.tag}: ${last}`);
}

const deleteAsset = (tag, name) => gh(['release', 'delete-asset', tag, name, '--repo', REPO, '--yes']); // chỉ xoá asset của mục này, không bao giờ xoá release ngày

async function getAsset(tag, name) {
  let rel;
  try {
    rel = await getReleaseByTag(REPO, tag);
  } catch (e) {
    log(`  ${String(e.message).slice(0, 160)}`);
    return null;
  }
  if (!rel) {
    log(`  chưa thấy release ${tag}`);
    return null;
  }
  const a = (rel.assets || []).find((x) => x.name === name);
  if (!a) log(`  release chưa có asset ${name} (hiện có ${(rel.assets || []).length} asset)`);
  return a || null;
}
async function assetOk(tag, name, size) {
  const a = await getAsset(tag, name);
  if (!a) return false;
  if (a.state !== 'uploaded' || a.size !== size) {
    log(`  asset ${name}: state=${a.state}, size=${a.size} (cần ${size})`);
    return false;
  }
  return true;
}

// Upload 1 asset vào release ngày, xác nhận từng asset (state, size, digest). Lỗi thì chỉ xoá asset này.
async function uploadAsset(tag, filePath, assetName, size, sha) {
  // gh lấy tên asset từ TÊN FILE, nên đặt đúng tên bằng hard link (không tốn thêm dung lượng đĩa)
  const staged = path.join(workDir, assetName);
  fs.rmSync(staged, { force: true });
  try {
    fs.linkSync(filePath, staged);
  } catch {
    fs.copyFileSync(filePath, staged);
  }
  const bail = async (code, msg) => {
    await deleteAsset(tag, assetName);
    throw new Fail(code, msg);
  };
  let good = false;
  try {
    for (let i = 1; i <= 3 && !good; i++) {
      if (hardMs() < 2 * 60000) await bail('timeout', 'Hết thời gian khi upload.');
      log(`Upload ${assetName} (lần ${i}/3)…`);
      const u = await spawnStream('gh', ['release', 'upload', tag, staged, '--repo', REPO, '--clobber'], { timeoutMs: hardMs() - 60000 });
      good = u.code === 0 && (await assetOk(tag, assetName, size));
      if (!good) {
        log(`Upload/xác nhận lần ${i} chưa đạt (gh mã ${u.code}): ${(u.stderr || '').trim().slice(-160)}`);
        await sleep(5000 * i);
      }
    }
  } finally {
    fs.rmSync(staged, { force: true });
  }
  if (!good) await bail('upload_failed', `Upload ${assetName} không được xác nhận sau 3 lần.`);
  const asset = await getAsset(tag, assetName);
  if (!asset || asset.state !== 'uploaded' || asset.size !== size) await bail('upload_failed', `Asset ${assetName} trên release không khớp dung lượng.`);
  if (asset.digest && asset.digest !== `sha256:${sha}`) await bail('upload_failed', `SHA256 của ${assetName} không khớp file cục bộ.`);
  log(`Đã xác nhận ${assetName} trên ${tag}${asset.digest ? ' (khớp SHA256)' : ''}.`);
  return { name: assetName, size, url: asset.browser_download_url || downloadUrl(REPO, tag, assetName) };
}

// ---------- bản điện thoại ----------
let ffCaps = null;
async function getFfCaps() {
  if (ffCaps) return ffCaps;
  const enc = (await run('ffmpeg', ['-hide_banner', '-encoders'])).stdout;
  const fil = (await run('ffmpeg', ['-hide_banner', '-filters'])).stdout;
  ffCaps = { x264: /\blibx264\b/.test(enc), aac: /^\s*A\S*\s+aac\s/m.test(enc), zscale: /\bzscale\b/.test(fil), tonemap: /\btonemap\b/.test(fil) };
  return ffCaps;
}

// Làm bản H.264 cho điện thoại TỪ BẢN THƯỜNG (không làm từ nguồn). Mọi lỗi đều trả về { ok:false, reason }, không bao giờ làm hỏng cả mục.
async function makePhone({ normalPath, src }) {
  const profile = profiles.phone;
  if (!profile) return { ok: false, reason: 'thiếu khoá "phone" trong config/profiles.json' };
  const caps = await getFfCaps();
  if (!caps.x264 || !caps.aac) return { ok: false, reason: 'ffmpeg thiếu libx264 hoặc aac' };
  const timeoutMs = Math.min(budgetMs(), hardMs() - 5 * 60000);
  if (timeoutMs < Math.max(60000, src.duration * 1000 * 0.3)) return { ok: false, reason: 'không còn đủ thời gian trong ngân sách' };
  const out = path.join(workDir, 'phone.mp4');
  try {
    const o = analyze(await ffprobe(normalPath));
    const tonemap = caps.zscale && caps.tonemap;
    const built = buildPhoneArgs({ input: normalPath, output: out, o, hdr: src.hdr, tonemap, profile });
    const notes = [];
    if (src.hdr) notes.push(tonemap ? 'Bản điện thoại: đã tone-map HDR → SDR (hable).' : 'Bản điện thoại: ffmpeg thiếu zscale/tonemap nên không tone-map, màu có thể nhạt.');
    log(`ffmpeg (điện thoại): libx264 -crf ${profile.crf} -preset ${profile.preset} maxrate ${built.maxrate}${src.hdr ? (tonemap ? ', tone-map HDR' : ', KHÔNG tone-map (thiếu zscale)') : ''}`);
    let lastLog = 0;
    const [cmd, a] = withTime('ffmpeg', built.args);
    const r = await spawnStream(cmd, a, {
      timeoutMs,
      onLine: (l, w) => {
        const m = /^out_time_us=(\d+)/.exec(l);
        if (w === 'out' && m && Date.now() - lastLog > 120000) {
          lastLog = Date.now();
          log(`  điện thoại: ${Math.min(99, (Number(m[1]) / 1e6 / src.duration) * 100).toFixed(1)}%`);
        } else if (w === 'err' && !l.startsWith('\t') && !l.startsWith('Command ')) log(`  ffmpeg: ${l.slice(0, 200)}`);
      },
    });
    logPeakRam(r.stderr, 'ffmpeg điện thoại');
    if (r.timedOut) return { ok: false, reason: 'hết thời gian khi làm bản điện thoại' };
    if (r.code !== 0) return { ok: false, reason: `ffmpeg lỗi (mã ${r.code}): ${ffErrTail(r.stderr, 1)}`.slice(0, 200) };
    const p = analyze(await ffprobe(out));
    const bad = verifyPhone(p, src);
    if (bad) return { ok: false, reason: `không qua kiểm tra: ${bad}` };
    const size = fs.statSync(out).size;
    if (size <= 0) return { ok: false, reason: 'file điện thoại rỗng' };
    if (size >= ASSET_LIMIT) return { ok: false, reason: `file ${fmtBytes(size)} ≥ 2 GiB, không đăng được` };
    const pd = displaySize(p);
    return { ok: true, path: out, size, res: `${p.width}x${p.height}`, height: Math.min(pd.w, pd.h), maxrate: built.maxrate, notes };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 200) };
  }
}

// ---------- luồng chính ----------
let ytdlpVer = null;
async function processItem(item) {
  const opt = item.options;
  const q = profiles.qualities[opt.quality];
  const hash6 = item.id.slice(-6);
  for (const s of secretsOf(item.provider, item.ref)) mask(s);
  log(`Mục ${item.id} • ${PROVIDERS[item.provider].label} • ${opt.resolution}/${opt.quality}/${opt.codec}`);

  const existing = await findExisting(hash6);
  if (existing) {
    log(`Đã có bản thường của mục này trong release ${existing.tag}, bỏ qua nén lại.`);
    const m = parseMainName(existing.main.name);
    const f = (x) => ({ name: x.name, size: x.size, url: x.browser_download_url || downloadUrl(REPO, existing.tag, x.name) });
    const when = existing.main.created_at || new Date().toISOString();
    Object.assign(result, {
      ok: true, skipped: true, thin: true, tag: existing.tag, date: dateDash(existing.ymd), time: tzHM(when, settings.timezone), finished_at: when,
      name: m ? m.slug : item.label || 'video', out_bytes: existing.main.size, main: f(existing.main), phone: existing.phone ? f(existing.phone) : null,
    });
    return;
  }

  helpText = (await run('ab-av1', ['crf-search', '--help'])).stdout;
  const toolVer = { ffmpeg: ((await run('ffmpeg', ['-version'])).stdout.split('\n')[0] || '').replace(/ Copyright.*/, ''), abav1: (await run('ab-av1', ['--version'])).stdout.trim() };

  // resolve + kiểm tra link
  const plan0 = await resolve(item.provider, item.ref, { allowedHosts: loadAllowedHosts() });
  for (const s of [plan0.url, ...(plan0.secrets || [])]) mask(s);
  const mode = opt.fetch_mode || 'auto';
  const referer = item.referer || null;
  if (referer) mask(referer);
  let remote = null;
  let probe = null;
  let deferred = false;
  if (plan0.kind === 'http' && mode !== 'browser') {
    let outcome;
    let perr = null;
    try {
      probe = await probeUrl(plan0.url, { ref: referer });
      if (probe.finalUrl) mask(probe.finalUrl);
      outcome = probe.video ? { video: true } : { video: false, kind: probe.kind };
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      perr = e;
      outcome = { error: e.code };
    }
    const verdict = probeVerdict(outcome, mode);
    if (verdict === 'reject') {
      if (perr) throw perr;
      throw new Fail('not_direct_video', `Link không trỏ tới file video (nhận được ${probe.ctype || probe.kind}).`);
    }
    if (verdict === 'defer') {
      // Chưa chắc chắn (403 hoặc nhận trang web): để bước tải quyết định thay vì từ chối ngay.
      deferred = true;
      probe = null;
      log('Bước kiểm tra chưa chắc chắn (bị chặn hoặc nhận trang web), để bước tải quyết định.');
    } else {
      remote = probe.size;
      if (probe.filename) plan0.nameHint = probe.filename; // tên file gốc (Content-Disposition/đuôi URL cuối) thắng tên đoán từ query
    }
  }
  const maxIn = settings.max_input_gb * GiB;
  if (remote && remote > maxIn) throw new Fail('input_too_big', `File nguồn ${fmtBytes(remote)} lớn hơn giới hạn ${settings.max_input_gb} GB.`);
  // Đỉnh dùng đĩa: nguồn + bản thường (lúc nén), hoặc bản thường + bản điện thoại (nguồn đã xoá). Mỗi bản ra < 2 GiB.
  const need = Math.max((remote || maxIn) * 2, 2 * ASSET_LIMIT) + 2 * GiB;
  const free = freeBytes(workDir);
  if (free < need) throw new Fail('no_disk', `Đĩa trống ${fmtBytes(free)}, cần ít nhất ${fmtBytes(need)}. Bật free_disk_space hoặc giảm max_input_gb.`);

  // tải (một lần). Gọi lại được: dọn file input.* của lần trước rồi tải từ đầu.
  const fetchSource = async () => {
    for (const f of fs.readdirSync(workDir)) if (f.startsWith('input.')) fs.rmSync(path.join(workDir, f), { recursive: true, force: true });
    let raw = path.join(workDir, 'input.bin');
    const dlStart = Date.now();
    if (plan0.kind === 'ytdlp') {
      const y = await downloadYtdlp(plan0, workDir, maxIn);
      raw = y.file;
      plan0.nameHint = y.title;
      ytdlpVer = await ytdlpVersion(ytdlpBin);
      result.fetch_method = 'ytdlp';
    } else if (plan0.kind === 'page') {
      const d = await downloadPage(plan0, raw, maxIn, { mode, referer, linkMatch: item.link_match, maxIn });
      raw = d.file;
      if (d.nameHint) plan0.nameHint = d.nameHint;
      if (d.method === 'ytdlp') ytdlpVer = await ytdlpVersion(ytdlpBin);
      result.fetch_method = d.method;
    } else if (plan0.kind === 'gdown') {
      await downloadGdown(plan0, raw, Math.min(budgetMs(), hardMs() - 10 * 60000));
      result.fetch_method = 'gdown';
    } else {
      const d = await downloadHttp(plan0, raw, remote ? null : maxIn, { mode, referer, probe, deferred, maxIn });
      raw = d.file;
      if (d.nameHint) plan0.nameHint = d.nameHint;
      if (d.method === 'ytdlp') ytdlpVer = await ytdlpVersion(ytdlpBin);
      result.fetch_method = d.method;
    }
    log(`Cách tải: ${result.fetch_method}`);
    const size = fs.statSync(raw).size;
    if (size > maxIn) throw new Fail('input_too_big', `File nguồn ${fmtBytes(size)} lớn hơn giới hạn ${settings.max_input_gb} GB.`);
    const hc = headCheck(fileHead(raw));
    if (!hc.video) throw new Fail('not_direct_video', `Nội dung tải về không phải video (${hc.kind}).`);
    const file = path.join(workDir, `input.${hc.ext}`);
    fs.renameSync(raw, file);
    const ms = Date.now() - dlStart;
    log(`Đã tải ${fmtBytes(size)} trong ${fmtDur(ms / 1000)}`);
    return { input: file, inSize: size, dlMs: ms };
  };

  // Tải → giải mã thử toàn bộ. File hỏng (do tải đứt/ghép sai) thì tải lại từ đầu, KHÔNG resume, tối đa MAX_DL_TRIES lần.
  // Hai lần tải ra cùng một file hỏng (SHA256 giống nhau) nghĩa là lỗi nằm sẵn ở nguồn: nén tiếp ở chế độ bỏ qua khung hỏng thay vì tải lại vô ích.
  if ((item.attempts || 0) > 0) allowResume = false; // lần thử lại của mục: không dùng resume ngay từ đầu
  const srcNotes = [];
  let src;
  let tolerant = false;
  let badSha = null;
  for (let attempt = 1; ; attempt++) {
    src = await fetchSource();
    const scan = await scanSource(src.input);
    if (!scan || scan.count === 0) break;
    log(`::warning::File nguồn có ${scan.count} dòng lỗi dữ liệu (lần tải ${attempt}/${MAX_DL_TRIES}): ${scan.sample}`);
    const sha = await sha256File(src.input);
    if (badSha === sha) {
      tolerant = true;
      srcNotes.push('Nguồn có lỗi dữ liệu sẵn trong file gốc (tải lại vẫn ra đúng file đó): đã bỏ qua khung hỏng khi nén, có thể có vài khung/đoạn âm thanh bị lỗi.');
      log('::warning::Hai lần tải cho cùng một file hỏng → lỗi nằm ở nguồn. Nén tiếp ở chế độ bỏ qua khung hỏng.');
      break;
    }
    if (attempt >= MAX_DL_TRIES) throw new Fail('source_corrupt', `File nguồn vẫn bị hỏng sau ${MAX_DL_TRIES} lần tải (${scan.count} dòng lỗi, vd: ${scan.sample}).`);
    if (budgetMs() < src.dlMs * 2 + 20 * 60000) throw new Fail('source_corrupt', `File nguồn bị hỏng (${scan.count} dòng lỗi) và không còn đủ thời gian để tải lại.`);
    badSha = sha;
    allowResume = false;
    log('Tải lại từ đầu (không resume)…');
  }
  const { input, inSize } = src;

  const a = analyze(await ffprobe(input));
  log(`Nguồn: ${a.width}x${a.height} @${a.fps.toFixed(2)}fps, ${a.codec}, ${a.pixFmt}, ${fmtDur(a.duration)}, ${a.audio.length} âm thanh${a.hdr ? ', HDR' : ''}`);
  const plan = makePlan(opt, a, profiles);
  const ladder = buildLadder(opt.codec, opt.quality);
  const outPath = path.join(workDir, `out.${opt.container}`);
  const tmp = path.join(workDir, 'ab-av1-tmp');
  const ctx = { input, output: outPath, a, plan, opt, tolerant };

  let minVmaf = opt.min_vmaf ?? q.min_vmaf;
  let stepIdx = Math.min(item.ladder_start || 0, ladder.length - 1);
  let search;
  let encStart;
  let encSeconds = 0;
  for (;;) {
    // tìm CRF, hạ nấc tốc độ nếu dự đoán vượt ngân sách
    let lastPred = null;
    search = null;
    for (let i = stepIdx; i < ladder.length; i++) {
      const left = budgetMs();
      if (left < 60000) throw new Fail('too_long', 'Không còn đủ thời gian trong ngân sách.', { ladder_start: Math.min(i, ladder.length - 1) });
      const s = await crfSearch({ input, encoder: ladder[i].encoder, preset: ladder[i].preset, minVmaf, vf: plan.vf, pixFmt: plan.pixFmt, tmp, timeoutMs: left });
      const remaining = budgetMs();
      if (s.seconds == null || s.seconds * 1.2 * 1000 <= remaining) {
        search = s;
        stepIdx = i;
        break;
      }
      lastPred = s.seconds;
      log(`Dự đoán ${fmtDur(s.seconds)} (×1,2) vượt ngân sách còn ${fmtDur(remaining / 1000)} → hạ nấc tốc độ.`);
    }
    if (!search) throw new Fail('too_long', `Dự đoán nén ${fmtDur(lastPred)} vượt ngân sách thời gian, đã hết các nấc tốc độ.`, { ladder_start: ladder.length - 1 });
    const step = ladder[stepIdx];
    encStart = Date.now();
    try {
      await encode(ctx, search.crf, step);
    } catch (e) {
      if (e.code === 'timeout') e.ladder_start = Math.min(stepIdx + 1, ladder.length - 1);
      throw e;
    }

    // kiểm tra kết quả
    const o = analyze(await ffprobe(outPath));
    const diff = Math.abs(o.duration - a.duration) / a.duration;
    if (diff > 0.01) throw new Fail('verify_failed', `Thời lượng lệch ${(diff * 100).toFixed(2)}% so với nguồn.`);
    if (o.audio.length !== plan.audio.length) throw new Fail('verify_failed', `Số luồng âm thanh ${o.audio.length} khác kế hoạch ${plan.audio.length}.`);
    const outSize = fs.statSync(outPath).size;
    if (outSize >= inSize) throw new Fail('no_gain', `File nén ${fmtBytes(outSize)} không nhỏ hơn nguồn ${fmtBytes(inSize)}.`);
    if (outSize >= ASSET_LIMIT) {
      fs.rmSync(outPath, { force: true });
      minVmaf -= 2;
      if (minVmaf < settings.min_vmaf_floor) throw new Fail('too_big', 'File ra vẫn ≥ 2 GiB dù đã hạ VMAF tới mức sàn.');
      log(`File ra ${fmtBytes(outSize)} ≥ 2 GiB → nén lại với VMAF ≥ ${minVmaf}`);
      continue;
    }
    result.out_bytes = outSize;
    result.crf = search.crf;
    result.ladder_step = stepIdx;
    result.final_vmaf_target = minVmaf;
    encSeconds = Math.round((Date.now() - encStart) / 1000);
    break;
  }
  result.in_bytes = inSize;
  fs.rmSync(input, { force: true }); // lấy lại chỗ: bản điện thoại làm từ bản thường nên không cần nguồn nữa

  // ---- bản thường: lên release của ngày ----
  const sha = await sha256File(outPath);
  const step = ladder[stepIdx];
  const info = dayInfo();
  const o2 = analyze(await ffprobe(outPath));
  const nameBase = item.label || (plan0.nameHint ? plan0.nameHint.replace(/\.[A-Za-z0-9]{2,4}$/, '') : 'video');
  const slug = slugify(nameBase, 60, true);
  const od = displaySize(o2);
  // Tên file = tên + hash6 + độ phân giải THỰC của file ra (cạnh ngắn) + codec; fps chỉ thêm khi có giới hạn fps. Bản điện thoại đặt tên theo độ phân giải riêng của nó (xem bên dưới).
  const names = assetNames({ slug, id: item.id, codec: opt.codec, container: opt.container, height: Math.min(od.w, od.h), fps: plan.fpsCap });
  await ensureDayRelease(info);
  const mainUp = await uploadAsset(info.tag, outPath, names.main, result.out_bytes, sha);
  Object.assign(result, {
    ok: true, tag: info.tag, date: info.date, time: info.time, finished_at: new Date().toISOString(), name: nameBase.slice(0, 120), duration: Math.round(a.duration),
    main: { ...mainUp, res: `${o2.width}x${o2.height}`, codec: opt.codec, crf: search.crf, vmaf: search.vmaf, preset: String(step.preset) },
    notes: [...plan.notes, ...srcNotes],
    tech: {
      res_in: `${a.width}x${a.height}`, res_out: `${o2.width}x${o2.height}`, codec_label: `${opt.codec.toUpperCase()} (${step.encoder})`, crf: search.crf, vmaf_target: minVmaf, vmaf_pred: search.vmaf,
      quality_label: Q_LABEL[opt.quality], fetch_method: result.fetch_method, preset: String(step.preset), encode_seconds: encSeconds,
      tools: `${toolVer.ffmpeg}; ab-av1 ${toolVer.abav1}${ytdlpVer ? `; yt-dlp ${ytdlpVer}` : ''}`, at: info.at, source: PROVIDERS[item.provider].label, sha256: sha,
    },
  });

  // ---- bản điện thoại (tuỳ chọn): lỗi ở đây KHÔNG làm hỏng mục, chỉ bỏ bản điện thoại ----
  result.phone = null;
  if (opt.phone) {
    let ph;
    try {
      ph = await makePhone({ normalPath: outPath, src: a });
      if (ph.ok) {
        const psha = await sha256File(ph.path);
        const phoneName = phoneAssetName({ slug, id: item.id, height: ph.height, fps: plan.fpsCap });
        const up = await uploadAsset(info.tag, ph.path, phoneName, ph.size, psha);
        result.phone = { ...up, res: ph.res, codec: 'h264', crf: profiles.phone.crf, maxrate: ph.maxrate, preset: profiles.phone.preset };
        result.notes.push(...ph.notes);
      }
    } catch (e) {
      ph = { ok: false, reason: e instanceof Fail ? e.message : `lỗi bất ngờ: ${String(e.message || e)}` };
    }
    if (!ph.ok) {
      result.phone_skipped = String(ph.reason).slice(0, 200);
      log(`::warning::Bỏ bản điện thoại: ${result.phone_skipped}`);
    }
  }
  fs.rmSync(outPath, { force: true }); // chỉ xoá file ra sau khi đã xác nhận trên release
}

async function main() {
  let raw;
  try {
    raw = JSON.parse(process.env.ITEM_JSON || '');
  } catch {
    console.error('ITEM_JSON không hợp lệ.');
    process.exit(1);
  }
  const v = validateItem({ status: 'pending', added_at: '-', last_error: null, ...raw }, { allowedHosts: loadAllowedHosts() });
  if (!v.ok) {
    console.error(`Mục không hợp lệ: ${v.message}`);
    process.exit(1);
  }
  const item = v.value;
  result.id = item.id;
  workDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), `item-${item.id}`);
  try {
    fs.mkdirSync(workDir, { recursive: true });
    await processItem(item);
  } catch (e) {
    result.ok = false;
    result.error = e instanceof Fail ? e.code : 'internal';
    result.detail = String(e.message || e).slice(0, 300);
    if (Number.isInteger(e.ladder_start)) result.ladder_start = e.ladder_start;
    if (RETRYABLE_ERRORS.has(result.error)) result.retryable = true; // chỉ browser_failed được thử lại (theo max_attempts)
    console.error(`::error::${result.error}: ${result.detail}`);
  } finally {
    cleanupSync();
    log(fs.existsSync(workDir) ? `⚠️ Chưa dọn được ${workDir}` : `Đã dọn thư mục tạm của mục ${item.id}.`);
    writeResult();
  }
  process.exit(result.ok ? 0 : 1);
}

main();
