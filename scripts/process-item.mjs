// Xử lý 1 mục hàng đợi. Mục truyền qua biến môi trường ITEM_JSON (không bao giờ ghép vào shell).
// Mỗi job chỉ chạy MỘT tiến trình nén tại một thời điểm.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, loadProfiles, loadAllowedHosts, run, gh, spawnStream, killAll, log, mask, fmtBytes, fmtDur, slugify, tzParts, sha256File, freeBytes, sleep } from './util.mjs';
import { validateItem } from '../docs/lib/schema.mjs';
import { PROVIDERS } from '../docs/lib/providers.mjs';
import { Fail, resolve, probeUrl, headCheck, secretsOf, fileHead } from './resolvers.mjs';
import { parseCrfSearch } from './parse.mjs';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const ASSET_LIMIT = 2 * GiB - 16 * MiB; // giới hạn 2 GiB/asset, trừ biên an toàn
const HARD_CAP_MS = 340 * 60 * 1000; // trần 6 giờ của GitHub, chừa 20 phút
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const settings = loadSettings();
const profiles = loadProfiles();
const REPO = process.env.GITHUB_REPOSITORY;
const BRANCH = process.env.DEFAULT_BRANCH || 'main';
const START = Number(process.env.JOB_START_EPOCH) * 1000 || Date.now();
const RES_LABEL = { original: 'Gốc', hd: 'HD', fhd: 'FHD', '2k': '2K', '4k': '4K' };
const Q_LABEL = { good: 'Tốt', balanced: 'Cân bằng', strong: 'Mạnh' };

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
function makePlan(opt, a) {
  const targetH = profiles.resolutions[opt.resolution].height;
  const effH = a.rotated ? a.width : a.height;
  const scaleH = targetH && effH > targetH ? targetH : null; // chỉ thu nhỏ
  const fpsCap = opt.fps_cap && a.fps > opt.fps_cap + 0.5 ? opt.fps_cap : null;
  const vf = [scaleH ? `scale=-2:${scaleH}:flags=lanczos` : null, fpsCap ? `fps=${fpsCap}` : null].filter(Boolean).join(',') || null;
  const notes = [];
  const color = [];
  if (a.hdr) {
    for (const [k, v] of [['color_primaries', a.v.color_primaries], ['color_trc', a.v.color_transfer], ['colorspace', a.v.color_space]]) {
      if (v && /^[a-z0-9_-]+$/.test(v) && v !== 'unknown') color.push(`-${k}`, v);
    }
    notes.push('Nguồn HDR: giữ 10-bit và thẻ màu, không tone-map. Siêu dữ liệu HDR tĩnh (mastering display) có thể không được giữ.');
  }
  const audio = a.audio.map((s) => {
    let mode = opt.audio;
    if (mode === 'copy') {
      if (opt.container === 'mp4' && !['aac', 'mp3', 'ac3', 'eac3', 'opus', 'alac', 'flac'].includes(s.codec)) {
        mode = 'aac_128';
        notes.push(`Âm thanh ${s.codec} không vào được MP4 nên đã chuyển sang AAC.`);
      } else return { index: s.index, copy: true };
    }
    const p = profiles.audio[mode];
    return { index: s.index, copy: false, codec: p.codec, kbps: Math.round(p.kbps * Math.max(1, s.channels / 2)), channels: s.channels };
  });
  const textSubs = ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'];
  let subs = a.subs.map((s) => s.index);
  if (opt.container === 'mp4') {
    const dropped = a.subs.filter((s) => !textSubs.includes(s.codec)).length;
    subs = a.subs.filter((s) => textSubs.includes(s.codec)).map((s) => s.index);
    if (dropped) notes.push(`Đã bỏ ${dropped} phụ đề dạng ảnh vì MP4 không chứa được.`);
  }
  if (a.v.codec_name && a.hdr === false && a.pixFmt && /422|444/.test(a.pixFmt)) notes.push('Nguồn 4:2:2/4:4:4 được đổi về 4:2:0.');
  return { scaleH, fpsCap, vf, color, audio, subs, attach: opt.container === 'mkv', pixFmt: 'yuv420p10le', notes };
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
function buildFfmpegArgs({ input, output, a, plan, opt, step, crf }) {
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats', '-i', input, '-map', `0:${a.v.index}`];
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
  if (r.code !== 0) throw new Fail('encode_failed', `ffmpeg lỗi (mã ${r.code}): ${r.stderr.split('\n').filter((x) => x.trim()).slice(-2).join(' | ').slice(0, 200)}`);
}

// ---------- tải ----------
async function download(plan, dest, maxBytes, timeoutMs) {
  if (plan.kind === 'http') {
    const args = ['--fail', '--location', '--max-redirs', '5', '--proto', '=https', '--proto-redir', '=https', '--retry', '5', '--retry-all-errors', '--retry-delay', '5',
      '-C', '-', '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '180', '--silent', '--show-error', '-A', UA];
    if (maxBytes) args.push('--max-filesize', String(maxBytes));
    args.push('-o', dest, plan.url);
    const r = await spawnStream('curl', args, { timeoutMs });
    if (r.timedOut) throw new Fail('timeout', 'Hết thời gian khi tải.');
    if (r.code === 63) throw new Fail('input_too_big', `File nguồn lớn hơn ${settings.max_input_gb} GB.`);
    if (r.code !== 0) {
      const m = /error: (\d{3})/.exec(r.stderr);
      const code = m ? Number(m[1]) : 0;
      if (code === 404 || code === 410) throw new Fail('not_found', 'Link không còn tồn tại.');
      if (code === 401 || code === 403) throw new Fail('access_denied', 'Không có quyền tải file.');
      if (code === 429) throw new Fail('rate_limited', 'Nguồn giới hạn tốc độ, thử lại sau.');
      throw new Fail('download_failed', `curl lỗi ${r.code}: ${r.stderr.trim().split('\n').slice(-1)[0].slice(0, 160)}`);
    }
    return;
  }
  const url = `https://drive.google.com/uc?id=${plan.id}${plan.resourcekey ? `&resourcekey=${plan.resourcekey}` : ''}`;
  mask(url);
  const r = await spawnStream('gdown', ['-q', '-O', dest, url], { timeoutMs });
  if (r.timedOut) throw new Fail('timeout', 'Hết thời gian khi tải.');
  const t = `${r.stdout}\n${r.stderr}`;
  if (/too many users|quota/i.test(t)) throw new Fail('drive_quota', 'Google Drive đang giới hạn lượt tải của file này. Thử lại sau vài giờ.');
  if (r.code !== 0 || !fs.existsSync(dest)) {
    if (/cannot retrieve the public link|permission|access denied|failed to retrieve file url/i.test(t)) throw new Fail('drive_private', 'File Drive chưa chia sẻ "bất kỳ ai có link".');
    throw new Fail('download_failed', `gdown lỗi: ${t.trim().split('\n').slice(-1)[0].slice(0, 160)}`);
  }
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
async function ytdlpOnce(plan, dir, maxBytes) {
  const timeoutMs = Math.min(budgetMs(), hardMs() - 10 * 60000);
  if (timeoutMs < 60000) throw new Fail('timeout', 'Không còn đủ thời gian để tải.');
  const titleFile = path.join(dir, 'title.txt');
  const args = ['--ignore-config', '--no-playlist', '--no-cache-dir', '--no-mtime', '--no-progress', '--socket-timeout', '30', '--retries', '5', '--fragment-retries', '5',
    '--js-runtimes', 'node', '-f', 'bv*+ba/b', '--merge-output-format', 'mkv', '--max-filesize', String(maxBytes), '--print-to-file', '%(title)s', titleFile,
    '-o', path.join(dir, 'input.%(ext)s'), '--', plan.url];
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
async function downloadYtdlp(plan, dir, maxBytes) {
  let a = await ytdlpOnce(plan, dir, maxBytes);
  if (!a.ok && YTDLP_RETRY.includes(a.code)) {
    log(`Tải lỗi (${a.code}). Thử cập nhật yt-dlp lên bản mới nhất rồi tải lại…`);
    const nb = await updateYtdlp();
    if (nb) {
      ytdlpBin = nb;
      for (const f of fs.readdirSync(dir)) if (f.startsWith('input.')) fs.rmSync(path.join(dir, f), { force: true });
      a = await ytdlpOnce(plan, dir, maxBytes);
    }
  }
  if (!a.ok) throw new Fail(a.code, a.message);
  return a;
}

// ---------- release ----------
async function findExistingRelease(hash6) {
  const r = await gh(['release', 'list', '--repo', REPO, '--limit', '300', '--json', 'tagName,isDraft']);
  if (r.code !== 0) throw new Fail('gh_error', `Không đọc được release: ${r.stderr.slice(0, 160)}`);
  for (const h of JSON.parse(r.stdout || '[]').filter((x) => x.tagName.startsWith('vid-') && x.tagName.endsWith(`-${hash6}`))) {
    if (h.isDraft) {
      await gh(['release', 'delete', h.tagName, '--repo', REPO, '--yes', '--cleanup-tag']); // bản nháp dở dang của lần trước
      continue;
    }
    const v = await gh(['release', 'view', h.tagName, '--repo', REPO, '--json', 'assets']);
    if (v.code === 0 && (JSON.parse(v.stdout).assets || []).some((x) => x.state === 'uploaded' && x.size > 0)) return h.tagName;
  }
  return null;
}
async function assetOk(tag, name, size) {
  const v = await gh(['release', 'view', tag, '--repo', REPO, '--json', 'assets']);
  if (v.code !== 0) return false;
  const a = (JSON.parse(v.stdout).assets || []).find((x) => x.name === name);
  return !!a && a.state === 'uploaded' && a.size === size;
}
function tagFor(id) {
  const p = tzParts(new Date(), settings.timezone);
  return { tag: `vid-${p.y}${p.mo}${p.d}-${p.h}${p.mi}${p.s}-${id.slice(-6)}`, date: `${p.y}-${p.mo}-${p.d}`, at: `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi} (${settings.timezone})` };
}

async function publishRelease({ id, assetPath, assetName, title, notes, sha, size }) {
  const { tag } = tagFor(id);
  const notesFile = path.join(workDir, 'notes.md');
  fs.writeFileSync(notesFile, notes);
  await gh(['release', 'delete', tag, '--repo', REPO, '--yes', '--cleanup-tag']); // dọn bản trùng tag (nếu có)
  const c = await gh(['release', 'create', tag, '--repo', REPO, '--draft', '--title', title, '--notes-file', notesFile, '--target', BRANCH, '--latest=false']);
  if (c.code !== 0) throw new Fail('release_failed', `Không tạo được release: ${c.stderr.slice(0, 160)}`);
  let good = false;
  for (let i = 1; i <= 3 && !good; i++) {
    if (hardMs() < 2 * 60000) throw new Fail('timeout', 'Hết thời gian khi upload.');
    log(`Upload asset (lần ${i}/3)…`);
    const u = await spawnStream('gh', ['release', 'upload', tag, assetPath, '--repo', REPO, '--clobber'], { timeoutMs: hardMs() - 60000 });
    good = u.code === 0 && (await assetOk(tag, assetName, size));
    if (!good) {
      log(`Upload/xác nhận lần ${i} chưa đạt: ${(u.stderr || '').trim().slice(-160)}`);
      await sleep(5000 * i);
    }
  }
  const cleanFail = async (code, msg) => {
    await gh(['release', 'delete', tag, '--repo', REPO, '--yes', '--cleanup-tag']);
    throw new Fail(code, msg);
  };
  if (!good) await cleanFail('upload_failed', 'Upload asset không được xác nhận sau 3 lần.');
  const p = await gh(['release', 'edit', tag, '--repo', REPO, '--draft=false', '--latest=false']);
  if (p.code !== 0) await cleanFail('release_failed', `Không công khai được release: ${p.stderr.slice(0, 160)}`);
  // Xác nhận lần cuối qua API (digest SHA256 nếu có)
  const api = await gh(['api', `repos/${REPO}/releases/tags/${tag}`]);
  if (api.code !== 0) await cleanFail('upload_failed', 'Không đọc lại được release sau khi công khai.');
  const asset = (JSON.parse(api.stdout).assets || []).find((x) => x.name === assetName);
  if (!asset || asset.state !== 'uploaded' || asset.size !== size) await cleanFail('upload_failed', 'Asset trên release không khớp dung lượng.');
  if (asset.digest && asset.digest !== `sha256:${sha}`) await cleanFail('upload_failed', 'SHA256 của asset không khớp file cục bộ.');
  log(`Đã xác nhận release ${tag}${asset.digest ? ' (khớp SHA256)' : ''}.`);
  return tag;
}

// ---------- luồng chính ----------
let ytdlpVer = null;
async function processItem(item) {
  const opt = item.options;
  const q = profiles.qualities[opt.quality];
  const hash6 = item.id.slice(-6);
  for (const s of secretsOf(item.provider, item.ref)) mask(s);
  log(`Mục ${item.id} • ${PROVIDERS[item.provider].label} • ${opt.resolution}/${opt.quality}/${opt.codec}`);

  const existing = await findExistingRelease(hash6);
  if (existing) {
    log(`Đã có release ${existing} cho mục này, bỏ qua nén lại.`);
    Object.assign(result, { ok: true, tag: existing, skipped: true });
    return;
  }

  helpText = (await run('ab-av1', ['crf-search', '--help'])).stdout;
  const toolVer = { ffmpeg: ((await run('ffmpeg', ['-version'])).stdout.split('\n')[0] || '').replace(/ Copyright.*/, ''), abav1: (await run('ab-av1', ['--version'])).stdout.trim() };

  // resolve + kiểm tra link
  const plan0 = await resolve(item.provider, item.ref);
  for (const s of [plan0.url, ...(plan0.secrets || [])]) mask(s);
  let remote = null;
  if (plan0.kind === 'http') {
    const p = await probeUrl(plan0.url);
    if (!p.video) throw new Fail('not_direct_video', `Link không trỏ tới file video (nhận được ${p.ctype || p.kind}).`);
    remote = p.size;
  }
  const maxIn = settings.max_input_gb * GiB;
  if (remote && remote > maxIn) throw new Fail('input_too_big', `File nguồn ${fmtBytes(remote)} lớn hơn giới hạn ${settings.max_input_gb} GB.`);
  const need = (remote || maxIn) * 2 + 2 * GiB;
  const free = freeBytes(workDir);
  if (free < need) throw new Fail('no_disk', `Đĩa trống ${fmtBytes(free)}, cần ít nhất ${fmtBytes(need)}. Bật free_disk_space hoặc giảm max_input_gb.`);

  // tải
  let raw = path.join(workDir, 'input.bin');
  const dlStart = Date.now();
  if (plan0.kind === 'ytdlp') {
    const y = await downloadYtdlp(plan0, workDir, maxIn);
    raw = y.file;
    plan0.nameHint = y.title;
    ytdlpVer = await ytdlpVersion(ytdlpBin);
  } else await download(plan0, raw, remote ? null : maxIn, Math.min(budgetMs(), hardMs() - 10 * 60000));
  const inSize = fs.statSync(raw).size;
  if (inSize > maxIn) throw new Fail('input_too_big', `File nguồn ${fmtBytes(inSize)} lớn hơn giới hạn ${settings.max_input_gb} GB.`);
  const hc = headCheck(fileHead(raw));
  if (!hc.video) throw new Fail('not_direct_video', `Nội dung tải về không phải video (${hc.kind}).`);
  const input = path.join(workDir, `input.${hc.ext}`);
  fs.renameSync(raw, input);
  log(`Đã tải ${fmtBytes(inSize)} trong ${fmtDur((Date.now() - dlStart) / 1000)}`);

  const a = analyze(await ffprobe(input));
  log(`Nguồn: ${a.width}x${a.height} @${a.fps.toFixed(2)}fps, ${a.codec}, ${a.pixFmt}, ${fmtDur(a.duration)}, ${a.audio.length} âm thanh${a.hdr ? ', HDR' : ''}`);
  const plan = makePlan(opt, a);
  const ladder = buildLadder(opt.codec, opt.quality);
  const outPath = path.join(workDir, `out.${opt.container}`);
  const tmp = path.join(workDir, 'ab-av1-tmp');
  const ctx = { input, output: outPath, a, plan, opt };

  let minVmaf = opt.min_vmaf ?? q.min_vmaf;
  let stepIdx = Math.min(item.ladder_start || 0, ladder.length - 1);
  let search;
  let encStart;
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
    break;
  }
  result.in_bytes = inSize;
  fs.rmSync(input, { force: true }); // lấy lại chỗ trước khi upload

  // release
  const sha = await sha256File(outPath);
  const step = ladder[stepIdx];
  const { date, at } = tagFor(item.id);
  const nameBase = item.label || (plan0.nameHint ? plan0.nameHint.replace(/\.[A-Za-z0-9]{2,4}$/, '') : 'video');
  const assetName = `${slugify(nameBase, 80)}-${opt.resolution}-${opt.codec}.${opt.container}`;
  const title = `[${date}] ${item.label || nameBase} · ${RES_LABEL[opt.resolution]} · ${Q_LABEL[opt.quality]} · ${opt.codec.toUpperCase()}`;
  const o2 = analyze(await ffprobe(outPath));
  const saved = ((1 - result.out_bytes / inSize) * 100).toFixed(1);
  const notes = [
    '| Mục | Giá trị |', '|---|---|',
    `| Dung lượng | ${fmtBytes(inSize)} → ${fmtBytes(result.out_bytes)} (giảm ${saved}%) |`,
    `| Thời lượng | ${fmtDur(a.duration)} |`,
    `| Độ phân giải | ${a.width}x${a.height} → ${o2.width}x${o2.height} |`,
    `| Codec | ${opt.codec.toUpperCase()} (${step.encoder}) |`,
    `| CRF | ${search.crf} |`,
    `| VMAF mục tiêu / dự đoán | ≥ ${minVmaf} / ${search.vmaf} |`,
    `| Mức / preset | ${Q_LABEL[opt.quality]} / ${step.preset} |`,
    `| Thời gian nén | ${fmtDur((Date.now() - encStart) / 1000)} |`,
    `| Phiên bản | ${toolVer.ffmpeg}; ab-av1 ${toolVer.abav1}${ytdlpVer ? `; yt-dlp ${ytdlpVer}` : ''} |`,
    `| Thời điểm | ${at} |`,
    `| Nguồn | ${PROVIDERS[item.provider].label} |`,
    `| SHA256 | \`${sha}\` |`,
    ...(plan.notes.length ? ['', ...plan.notes.map((n) => `- ${n}`)] : []),
    '', '_Tạo tự động từ hàng đợi cá nhân của chủ repo._',
  ].join('\n');
  result.tag = await publishRelease({ id: item.id, assetPath: outPath, assetName, title, notes, sha, size: result.out_bytes });
  result.ok = true;
  fs.rmSync(outPath, { force: true }); // chỉ xóa file ra sau khi đã xác nhận release
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
        console.error(`::error::${result.error}: ${result.detail}`);
  } finally {
    cleanupSync();
    log(fs.existsSync(workDir) ? `⚠️ Chưa dọn được ${workDir}` : `Đã dọn thư mục tạm của mục ${item.id}.`);
    writeResult();
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
