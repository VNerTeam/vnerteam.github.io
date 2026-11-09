// Tiện ích dùng chung cho script chạy trên runner (Node thuần, không cần npm install).
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseQueue, serializeQueue } from '../docs/lib/schema.mjs';

const execFileP = promisify(execFile);

export const DEFAULT_SETTINGS = {
  runner_label: 'ubuntu-latest', max_parallel: 2, max_items_per_run: 10, max_items_per_day: 10, time_budget_min: 270, reserve_min: 20,
  max_input_gb: 6, min_vmaf_floor: 88, free_disk_space: false, timezone: 'Asia/Ho_Chi_Minh', max_attempts: 3, max_chain: 30, ytdlp_update_channel: 'stable',
};

export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...readJson('config/settings.json') };
  s.max_parallel = Math.min(Math.max(1, Math.floor(s.max_parallel)), 20); // trần 20 của plan Free
  s.time_budget_min = Math.min(Math.max(240, s.time_budget_min), 300);
  return s;
}
export const loadProfiles = () => readJson('config/profiles.json');
export const loadAllowedHosts = () => {
  try {
    const j = readJson('config/allowed-hosts.json');
    return Array.isArray(j.hosts) ? j.hosts : [];
  } catch {
    return [];
  }
};

// Lớp truy cập queue (QUEUE_BACKEND=file là mặc định; chừa chỗ cho backend khác ở giai đoạn 2).
export const readQueue = () => parseQueue(fs.readFileSync('queue.json', 'utf8'));
export const writeQueue = (q) => fs.writeFileSync('queue.json', serializeQueue(q));

// ---- chạy lệnh ----
export async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { maxBuffer: 256 * 1024 * 1024, ...opts });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '', stderr: e.stderr || String(e.message) };
  }
}
export const gh = (args, opts) => run('gh', args, opts);

const children = new Set();
export function killAll() {
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch { /* đã thoát */ }
  }
}

// Chạy tiến trình, đọc luồng theo dòng. Hết timeoutMs thì SIGTERM, 15 giây sau SIGKILL.
export function spawnStream(cmd, args, { env, cwd, onLine, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let out = '';
    let err = '';
    let timedOut = false;
    let killTimer = null;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), 15000);
        }, Math.max(1000, timeoutMs))
      : null;
    const feed = (which) => {
      let buf = '';
      return (d) => {
        const t = d.toString('utf8');
        if (which === 'out') out = (out + t).slice(-2_000_000);
        else err = (err + t).slice(-2_000_000);
        if (onLine) {
          buf += t;
          const parts = buf.split(/\r|\n/);
          buf = parts.pop();
          for (const l of parts) if (l) onLine(l, which);
        }
      };
    };
    child.stdout.on('data', feed('out'));
    child.stderr.on('data', feed('err'));
    const done = (code, signal) => {
      children.delete(child);
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, signal, timedOut, stdout: out, stderr: err });
    };
    child.on('error', (e) => {
      err += String(e.message);
      done(127, null);
    });
    child.on('close', done);
  });
}

// ---- log / GitHub Actions ----
export const log = (...a) => console.log(...a);
export function mask(v) {
  if (typeof v === 'string' && v.length >= 4 && !/[\r\n]/.test(v)) console.log(`::add-mask::${v}`);
}
export function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (!f) return console.log(`[output] ${name}=${v.slice(0, 200)}`);
  const d = `EOF_${crypto.randomBytes(8).toString('hex')}`;
  fs.appendFileSync(f, `${name}<<${d}\n${v}\n${d}\n`);
}
export function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  else console.log(md);
}

// ---- định dạng ----
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 2 : 0)} ${u[i]}`;
}
export function fmtDur(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}g ${m}p ${s}s` : m ? `${m}p ${s}s` : `${s}s`;
}
export function slugify(s, max = 60) {
  const t = String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
  return t || 'video';
}
export function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}
export const todayStr = (tz, now = new Date()) => {
  const p = tzParts(now, tz);
  return `${p.y}${p.mo}${p.d}`;
};

export function sha256File(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex')));
  });
}

export function freeBytes(dir) {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

// Số release video đã tạo trong ngày hôm nay (theo múi giờ cấu hình), dựa trên tag vid-YYYYMMDD-*
export async function countTodayReleases(repo, tz) {
  const r = await gh(['release', 'list', '--repo', repo, '--limit', '200', '--json', 'tagName']);
  if (r.code !== 0) throw new Error(`Không đọc được danh sách release: ${r.stderr.slice(0, 200)}`);
  const prefix = `vid-${todayStr(tz)}-`;
  return JSON.parse(r.stdout || '[]').filter((x) => x.tagName.startsWith(prefix)).length;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
