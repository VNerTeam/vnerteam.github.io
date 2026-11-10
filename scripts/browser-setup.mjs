// Cài đặt LƯỜI cho mức 2 (trình duyệt): chỉ chạy khi có một mục thật sự cần, để các lần chạy thường không tốn thêm thời gian.
//   - playwright-core (ghim phiên bản trong config/tools.json) cài vào thư mục tạm của mục.
//   - Dùng Google Chrome có sẵn trên runner; không có thì thử `npx playwright-core install chromium`.
//   - Chế độ có giao diện qua xvfb (qua được nhiều web phát hiện headless); thiếu xvfb thì cài, không cài được thì lùi về headless và cảnh báo.
import fs from 'node:fs';
import path from 'node:path';
import { run, log } from './util.mjs';
import { Fail } from './resolvers.mjs';

const which = async (bin) => {
  const r = await run('which', [bin]);
  return r.code === 0 ? r.stdout.trim().split('\n')[0] : null;
};

export async function findChrome() {
  for (const b of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const p = await which(b);
    if (p) return p;
  }
  return null;
}

async function installPlaywright(dir, version) {
  const marker = path.join(dir, 'node_modules', 'playwright-core', 'package.json');
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"bf","private":true}\n');
  log(`Cài playwright-core@${version} (chỉ khi cần trình duyệt)…`);
  const r = await run('npm', ['i', '--prefix', dir, `playwright-core@${version}`, '--no-audit', '--no-fund', '--silent', '--ignore-scripts'], { timeout: 180000 });
  if (r.code !== 0 || !fs.existsSync(marker)) throw new Fail('browser_unavailable', `Không cài được playwright-core: ${String(r.stderr).trim().split('\n').slice(-1)[0].slice(0, 140)}`);
}

// Trả về { pwDir, chrome, headed, xvfb } hoặc ném Fail('browser_unavailable').
export async function ensureBrowser({ dir, version, wantHeaded }) {
  await installPlaywright(dir, version);
  let chrome = await findChrome();
  if (!chrome) {
    log('Runner không có Chrome, thử cài Chromium của Playwright…');
    const r = await run('node', [path.join(dir, 'node_modules', 'playwright-core', 'cli.js'), 'install', 'chromium'], { timeout: 300000, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(dir, 'pw-browsers') } });
    if (r.code !== 0) throw new Fail('browser_unavailable', 'Runner không có Chrome và không cài được Chromium.');
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(dir, 'pw-browsers'); // để playwright tự tìm bản vừa cài (chrome = null)
  }
  let headed = false;
  let xvfb = null;
  if (wantHeaded) {
    xvfb = await which('xvfb-run');
    if (!xvfb) {
      log('Cài xvfb (chỉ khi cần trình duyệt có giao diện)…');
      const r = await run('sudo', ['apt-get', 'install', '-y', '-qq', 'xvfb'], { timeout: 240000 });
      if (r.code === 0) xvfb = await which('xvfb-run');
    }
    headed = !!xvfb;
    if (!headed) log('::warning::Không cài được xvfb, lùi về Chrome headless (có thể bị một số web phát hiện).');
  }
  return { pwDir: dir, chrome, headed, xvfb };
}
