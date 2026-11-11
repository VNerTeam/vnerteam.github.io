// Giao diện quản lý hàng đợi. Mọi chuỗi động hiển thị bằng textContent (không innerHTML).
import { WORKER_URL } from './config.js';
import { parseLink, PROVIDERS } from './lib/providers.mjs';
import { OPTION_CHOICES, OPTION_LABELS, VMAF_RANGE, defaultOptions, validateOptions, validateLabel, validateRefPage, validateLinkMatch } from './lib/schema.mjs';
import { fmtDur } from './lib/format.mjs';

const $ = (id) => document.getElementById(id);
const DEFAULTS_KEY = 'vc_defaults';
const PW_KEY = 'vc_password'; // password ghi nhớ trên thiết bị (tự đăng nhập). PIN thì KHÔNG bao giờ được lưu trên máy.
const OLD_VAULT_KEY = 'vc_vault'; // két PIN cục bộ của bản cũ: không còn dùng, chỉ để xoá
const PIN_RE = /^\d{4,12}$/;

// Tuỳ chọn mặc định cho mục mới được nhớ theo từng thiết bị. Hỏng hoặc có khoá lạ → dùng mặc định.
function loadDefaults() {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    if (!raw) return defaultOptions();
    const v = validateOptions(JSON.parse(raw));
    return v.ok ? v.value : defaultOptions();
  } catch { return defaultOptions(); }
}
function saveDefaults(o) { try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(o)); } catch { /* storage đầy hoặc bị chặn */ } }

// state.auth = { kind: 'password' | 'pin', secret } chỉ nằm trong bộ nhớ. edits: id → { options, referer } là các thay đổi trong hàng đợi chưa lưu.
const state = { auth: null, pinSet: null, drafts: [], queue: [], hosts: [], defaults: loadDefaults(), nextId: 1, edits: new Map() };

const ERROR_TEXT = {
  drive_quota: 'Google Drive đang giới hạn lượt tải file này. Thử lại sau vài giờ.',
  drive_private: 'File Drive chưa chia sẻ "bất kỳ ai có link".',
  not_direct_video: 'Link không trỏ tới file video (có thể là trang web hoặc cần đăng nhập).',
  not_a_video: 'File tải về không phải video hợp lệ.',
  too_long: 'Video quá dài để nén trong giới hạn thời gian, kể cả ở tốc độ nhanh nhất.',
  too_big: 'File sau khi nén vẫn lớn hơn 2 GiB (giới hạn của Release).',
  no_gain: 'Nén xong không nhỏ hơn bản gốc nên không đăng lên.',
  timeout: 'Hết thời gian xử lý. Lần sau sẽ dùng tốc độ nhanh hơn.',
  job_failed: 'Job lỗi trước khi nén xong (thường ở bước cài công cụ hoặc tải). Mở log của lần chạy để xem bước nào đỏ.',
  no_result: 'Job bị dừng giữa chừng, chưa có kết quả.',
  cancelled: 'Job bị hủy.',
  input_too_big: 'File nguồn lớn hơn giới hạn max_input_gb.',
  no_disk: 'Không đủ chỗ trống trên runner.',
  not_found: 'Link không còn tồn tại (404).',
  access_denied: 'Không có quyền tải file (web chặn; nếu dùng "Chỉ tải thường" hãy thử "Tự động" hoặc "Luôn dùng trình duyệt").',
  rate_limited: 'Nguồn đang giới hạn tốc độ, thử lại sau.',
  onedrive_unsupported: 'OneDrive không cho tải trực tiếp link này.',
  link_deleted: 'Link pCloud đã bị xóa.',
  link_expired: 'Link pCloud đã hết hạn.',
  pcloud_traffic: 'Link pCloud đã hết lượt tải/băng thông.',
  pcloud_bad_code: 'Mã link pCloud sai.',
  folder_not_supported: 'Link là thư mục, không phải file.',
  lfs_pointer: 'Đây là con trỏ Git LFS, không phải video thật.',
  crf_not_found: 'Không đạt được mức VMAF yêu cầu. Thử hạ VMAF tối thiểu.',
  crf_search_failed: 'Bước tìm mức nén (ab-av1) thất bại. Xem log của lần chạy.',
  encode_failed: 'ffmpeg báo lỗi khi nén. Xem log của lần chạy.',
  verify_failed: 'File nén không qua bước kiểm tra (thời lượng/luồng âm thanh).',
  upload_failed: 'Upload lên Release không được xác nhận.',
  release_failed: 'Không tạo được Release.',
  gh_error: 'Không đọc được Release từ GitHub. Thử lại sau.',
  download_failed: 'Tải file nguồn thất bại.',
  ytdlp_unsupported: 'yt-dlp không hỗ trợ trang này (đã thử cả bản mới nhất).',
  drm_protected: 'Video có bảo vệ DRM, không tải được.',
  link_not_found: 'Không tìm thấy thẻ a có class đã cấu hình (hoặc không link nào chứa "Lọc link"). Kiểm tra link_class trong allowed-hosts.json và ô "Lọc link".',
  browser_failed: 'Trình duyệt thật gặp lỗi khi mở trang hoặc tải (mục này được tự thử lại theo max_attempts). Xem log của lần chạy.',
  browser_no_video: 'Mở được trang nhưng không thấy luồng video tải được (hoặc chỉ có blob:). Thử dán link tới file video, hoặc điền "Trang mở trước".',
  browser_unavailable: 'Runner không dùng được Chrome/Playwright/xvfb. Xem log của bước cài trình duyệt.',
};
const errText = (c) => (c && c.startsWith('invalid_schema') ? 'Mục sai định dạng nên bị bỏ qua.' : ERROR_TEXT[c] || c || '');

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const clear = (el) => el.replaceChildren();
const msg = (el, text, kind = '') => { el.textContent = text || ''; el.className = `msg ${kind}`; };
const fmtSize = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GiB` : `${(n / (1 << 20)).toFixed(1)} MiB`);
const fmtDate = (s) => { try { return new Date(s).toLocaleString('vi-VN'); } catch { return s || ''; } };
// Chỉ cho phép link tới github.com (dữ liệu đến từ Worker nhưng vẫn kiểm tra trước khi gán vào href).
const safeUrl = (u) => (typeof u === 'string' && u.startsWith('https://github.com/') ? u : '#');
const normOpts = (o) => { const v = validateOptions(o); return v.ok ? v.value : { ...o }; };
const sameOpts = (a, b) => Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);

// ---------- gọi Worker ----------
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(WORKER_URL + path, { method, headers: { Authorization: state.auth.kind === 'pin' ? `Pin ${state.auth.secret}` : `Bearer ${state.auth.secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Không kết nối được Worker. Kiểm tra mạng và địa chỉ trong config.js.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* không có JSON */ }
  if (res.status === 401) { const wasPin = state.auth && state.auth.kind === 'pin'; onUnauthorized(); const e = new Error(wasPin ? 'Sai PIN.' : 'Sai password.'); e.code = 'unauthorized'; throw e; }
  if (!res.ok) throw new Error(data.message || `Lỗi ${res.status}`);
  return data;
}

// ---------- màn hình: password / PIN dự phòng / ứng dụng ----------
// Password: ghi nhớ được trên thiết bị → lần sau vào thẳng. PIN: lưu ở Cloudflare (dùng được từ mọi máy), chỉ để vào khi quên password,
// không bao giờ lưu trên máy: mỗi lần mở trang lại hiện màn hình nhập password.
function showScreen(name) { for (const id of ['lock', 'pinlock', 'app']) $(id).hidden = id !== name; }
function toPassword(text, kind) { showScreen('lock'); $('pw').value = ''; msg($('lockmsg'), text, kind); }
function toPin(text, kind) { showScreen('pinlock'); $('pin').value = ''; msg($('pinmsg'), text, kind); $('pin').focus(); }

// Worker báo 401: xoá password đã nhớ (nếu là password) và về màn hình đăng nhập tương ứng.
function onUnauthorized() {
  const wasPin = state.auth && state.auth.kind === 'pin';
  state.auth = null; state.pinSet = null;
  if (wasPin) return toPin('Sai PIN hoặc PIN đã bị đổi.', 'bad');
  localStorage.removeItem(PW_KEY);
  toPassword('Sai password hoặc password đã đổi. Hãy nhập lại.', 'bad');
}

// Thử đăng nhập với Worker. Trả về null nếu được, hoặc Error (UI đã xử lý nếu là 401).
async function connect(kind, secret) {
  if (WORKER_URL.includes('TEN-WORKER')) return new Error('Chưa cấu hình: hãy điền địa chỉ Worker vào docs/config.js.');
  state.auth = { kind, secret };
  try {
    const cfg = await api('/api/config');
    state.hosts = cfg.allowed_hosts || [];
    try { state.pinSet = (await api('/api/auth')).pin_set === true; } catch (e) { if (e.code === 'unauthorized') throw e; state.pinSet = null; /* Worker bản cũ chưa có PIN */ }
    return null;
  } catch (e) {
    if (e.code !== 'unauthorized') state.auth = null;
    return e;
  }
}
function enterApp() { showScreen('app'); renderAuthBar(); loadQueue(); loadStatus(); }

async function loginWithPassword() {
  const pw = $('pw').value;
  if (!pw) return msg($('lockmsg'), 'Hãy nhập password.', 'bad');
  $('login').disabled = true; msg($('lockmsg'), 'Đang kiểm tra…');
  try {
    const err = await connect('password', pw);
    if (err) { if (err.code !== 'unauthorized') toPassword(err.message, 'bad'); return; }
    if ($('remember').checked) { try { localStorage.setItem(PW_KEY, pw); } catch { /* storage bị chặn: vẫn vào được, chỉ không nhớ */ } } else localStorage.removeItem(PW_KEY);
    enterApp();
  } finally { $('login').disabled = false; $('pw').value = ''; }
}
async function loginWithPin() {
  const pin = $('pin').value;
  if (!PIN_RE.test(pin)) return msg($('pinmsg'), 'PIN gồm 4–12 chữ số.', 'bad');
  $('unlock').disabled = true; msg($('pinmsg'), 'Đang kiểm tra…');
  try {
    const err = await connect('pin', pin);
    if (err) { if (err.code !== 'unauthorized') toPin(err.message, 'bad'); return; }
    enterApp(); // KHÔNG lưu gì trên máy: lần sau mở trang sẽ lại hỏi password
  } finally { $('unlock').disabled = false; $('pin').value = ''; }
}
function logout() {
  const dirty = state.drafts.length || state.edits.size;
  if (dirty && !confirm('Đăng xuất sẽ mất các nháp và thay đổi chưa lưu. Tiếp tục?')) return;
  state.drafts = []; state.edits.clear(); state.auth = null; state.pinSet = null;
  localStorage.removeItem(PW_KEY);
  renderDrafts(); toPassword('', '');
}

// Thanh trạng thái đăng nhập + khung quản lý PIN (chỉ khi đăng nhập bằng password; PIN không tự đổi được PIN).
function renderAuthBar() {
  const viaPin = state.auth && state.auth.kind === 'pin';
  $('authnote').textContent = viaPin ? 'Đang vào bằng PIN dự phòng (phiên này, không được nhớ trên máy).' : '';
  $('authnote').hidden = !viaPin;
  $('pinsec').hidden = viaPin;
  $('pinstate').textContent = state.pinSet === null ? 'Chưa kiểm tra được (Worker có thể chưa được cập nhật: chạy wrangler deploy).' : state.pinSet ? 'PIN dự phòng: đã đặt (lưu ở Cloudflare, dùng được từ máy khác).' : 'PIN dự phòng: chưa đặt.';
  $('delpin').hidden = state.pinSet !== true;
}
async function savePin() {
  const a = $('pin1').value; const b = $('pin2').value;
  if (!PIN_RE.test(a)) return msg($('pinsetmsg'), 'PIN phải gồm 4–12 chữ số (nên dùng 6 số trở lên).', 'bad');
  if (a !== b) return msg($('pinsetmsg'), 'Hai lần nhập PIN không khớp.', 'bad');
  $('savepin').disabled = true; msg($('pinsetmsg'), 'Đang lưu…');
  try {
    await api('/api/auth/pin', { method: 'POST', body: { pin: a } });
    state.pinSet = true; $('pin1').value = ''; $('pin2').value = '';
    msg($('pinsetmsg'), 'Đã lưu PIN lên Cloudflare. Quên password thì bấm \"Quên password\" ở màn hình đăng nhập rồi nhập PIN.', 'ok'); renderAuthBar();
  } catch (e) { if (e.code !== 'unauthorized') msg($('pinsetmsg'), e.message, 'bad'); } finally { $('savepin').disabled = false; }
}
async function removePin() {
  if (!confirm('Xoá PIN dự phòng? Sau đó chỉ vào được bằng password.')) return;
  try {
    await api('/api/auth/pin', { method: 'DELETE' });
    state.pinSet = false; msg($('pinsetmsg'), 'Đã xoá PIN.', 'ok'); renderAuthBar();
  } catch (e) { if (e.code !== 'unauthorized') msg($('pinsetmsg'), e.message, 'bad'); }
}

// ---------- tuỳ chọn ----------
function optionsEditor(opts, onChange) {
  const wrap = h('div', { class: 'opts' });
  const set = (k, v) => { opts[k] = v; onChange && onChange(opts); };
  for (const [k, choices] of Object.entries(OPTION_CHOICES)) {
    const sel = h('select', { onchange: (e) => set(k, JSON.parse(e.target.value)) },
      choices.map(([v, label]) => h('option', { value: JSON.stringify(v), selected: opts[k] === v }, label)));
    wrap.append(h('label', {}, OPTION_LABELS[k], sel));
  }
  const vm = h('input', { type: 'number', min: VMAF_RANGE[0], max: VMAF_RANGE[1], step: '0.5', placeholder: 'theo mức chất lượng', value: opts.min_vmaf ?? '',
    onchange: (e) => set('min_vmaf', e.target.value === '' ? null : Number(e.target.value)) });
  wrap.append(h('label', {}, `${OPTION_LABELS.min_vmaf} (${VMAF_RANGE[0]}–${VMAF_RANGE[1]})`, vm));
  return wrap;
}
const chipText = (o, k) => { const t = OPTION_CHOICES[k].find(([v]) => v === o[k])?.[1] ?? String(o[k]); return k === 'phone' ? `Điện thoại: ${t}` : k === 'fetch_mode' ? `Cách tải: ${t}` : t; };
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const chips = (o, referer, linkMatch) => h('div', { class: 'chips' }, Object.keys(OPTION_CHOICES).map((k) => h('span', {}, chipText(o, k))), o.min_vmaf != null ? h('span', {}, `VMAF ≥ ${o.min_vmaf}`) : null, referer ? h('span', {}, `Trang mở trước: ${hostOf(referer)}`) : null, linkMatch ? h('span', {}, `Lọc link: ${linkMatch}`) : null);
// Ô nhập "Trang mở trước" (không bắt buộc). Chỉ hiện thông báo lỗi tại chỗ; việc kiểm tra thật nằm ở schema/Worker.
function refererInput(value, onChange) {
  const note = h('span', { class: 'muted' }, '');
  const inp = h('input', { type: 'url', maxlength: 2048, placeholder: 'https://… (tuỳ chọn)', value: value || '', spellcheck: 'false', style: 'width:100%',
    oninput: (e) => { const v = validateRefPage(e.target.value); note.textContent = v.ok ? '' : v.message; note.className = v.ok ? 'muted' : 'msg bad'; onChange(e.target.value); } });
  return h('label', { class: 'muted' }, 'Trang mở trước (tuỳ chọn): trang web chứa link này, dùng làm Referer hoặc để trình duyệt mở trước lấy phiên', inp, note);
}
const providerBadges = (p) => [h('span', { class: 'badge' }, PROVIDERS[p]?.label || p), PROVIDERS[p]?.experimental ? h('span', { class: 'badge exp' }, ' Thử nghiệm') : null];

// Ô "Lọc link" cho link kiểu "trang có nút tải": nhiều thẻ a cùng class (vd mỗi độ phân giải một link) thì gõ phần có trong link cần lấy.
function linkMatchInput(value, onChange) {
  const note = h('span', { class: 'muted' }, '');
  const inp = h('input', { maxlength: 200, placeholder: 'vd: 2160p.mp4 hoặc shenhe8_2160p', value: value || '', spellcheck: 'false', style: 'width:100%',
    oninput: (e) => { const v = validateLinkMatch(e.target.value); note.textContent = v.ok ? '' : v.message; note.className = v.ok ? 'muted' : 'msg bad'; onChange(e.target.value); } });
  return h('label', { class: 'muted' }, 'Lọc link (tuỳ chọn): chỉ lấy thẻ a có href chứa chuỗi này (không phân biệt hoa thường)', inp, note);
}

// ---------- xem trước khi dán ----------
function parseLines() {
  return $('links').value.split('\n').map((s) => s.trim()).filter(Boolean).map((url) => ({ url, r: parseLink(url, { allowedHosts: state.hosts }) }));
}
function renderPreview() {
  const box = $('preview'); clear(box);
  for (const { url, r } of parseLines().slice(0, 50)) {
    box.append(h('p', { class: `msg ${r.ok ? (r.warning ? 'warn' : 'ok') : 'bad'}` },
      r.ok ? [`${r.label}${r.experimental ? ' (thử nghiệm)' : ''}: ${r.summary}`, r.warning ? ` — ${r.warning}` : ''] : [`Từ chối "${url.slice(0, 50)}${url.length > 50 ? '…' : ''}": ${r.message}`]));
  }
}

// ---------- nháp ----------
function addDrafts() {
  let n = 0;
  for (const { url, r } of parseLines()) {
    if (!r.ok) continue;
    state.drafts.push({ key: state.nextId++, url, parsed: r, options: { ...state.defaults }, label: '', referer: '', link_match: '', error: null });
    n++;
  }
  if (n) { $('links').value = ''; renderPreview(); }
  renderDrafts();
}
function dupKeys() {
  const seen = new Map();
  for (const d of state.drafts) { const k = `${d.parsed.provider}|${JSON.stringify(d.parsed.ref)}|${JSON.stringify(d.options)}`; seen.set(k, (seen.get(k) || 0) + 1); }
  return (d) => seen.get(`${d.parsed.provider}|${JSON.stringify(d.parsed.ref)}|${JSON.stringify(d.options)}`) > 1;
}
function renderDrafts() {
  const box = $('drafts'); clear(box);
  const isDup = dupKeys();
  state.drafts.forEach((d) => {
    const rerender = () => renderDrafts();
    box.append(h('div', { class: `item${d.error ? ' err' : ''}` },
      h('div', { class: 'row' }, providerBadges(d.parsed.provider), h('span', { class: 'ref grow' }, d.parsed.summary), h('button', { class: 'danger', onclick: () => { state.drafts = state.drafts.filter((x) => x !== d); rerender(); } }, 'Xóa')),
      chips(d.options, d.referer, d.link_match),
      h('details', {}, h('summary', {}, 'Sửa tuỳ chọn'),
        h('label', { class: 'muted' }, 'Tên hiển thị (tuỳ chọn, cho phép dấu cách; để trống thì hệ thống tự lấy tên file gốc) ', h('input', { maxlength: 80, value: d.label, placeholder: 'Để trống: tự lấy tên file gốc từ link', oninput: (e) => { d.label = e.target.value; } })),
        refererInput(d.referer, (v) => { d.referer = v; }),
        d.parsed.provider === 'page_link' ? linkMatchInput(d.link_match, (v) => { d.link_match = v; }) : null,
        optionsEditor(d.options, rerender)),
      isDup(d) ? h('p', { class: 'msg warn' }, 'Trùng với một nháp khác.') : null,
      d.parsed.warning ? h('p', { class: 'msg warn' }, d.parsed.warning) : null,
      d.error ? h('p', { class: 'msg bad' }, d.error) : null));
  });
  $('draftcount').textContent = state.drafts.length ? `(${state.drafts.length})` : '';
  if (!state.drafts.length) box.append(h('p', { class: 'muted' }, 'Chưa có nháp. Dán link ở trên rồi bấm "Thêm vào nháp".'));
  $('savebar').style.display = state.drafts.length ? 'block' : 'none';
  $('savetext').textContent = `${state.drafts.length} mục chưa lưu`;
}
async function saveDrafts() {
  const btn = $('save'); btn.disabled = true; clear($('saveresult'));
  try {
    const items = []; const sent = [];
    for (const d of state.drafts) {
      const o = validateOptions(d.options); const l = validateLabel(d.label); const rp = validateRefPage(d.referer); const lm = validateLinkMatch(d.link_match);
      if (!o.ok || !l.ok || !rp.ok || !lm.ok) { d.error = (!o.ok ? o : !l.ok ? l : !rp.ok ? rp : lm).message; continue; }
      d.error = null; items.push({ url: d.url, options: o.value, label: l.value, referer: rp.value, link_match: lm.value }); sent.push(d);
    }
    if (!items.length) { renderDrafts(); return; }
    if (items.length > 50) throw new Error('Mỗi lần chỉ lưu tối đa 50 mục. Hãy xóa bớt nháp.');
    const data = await api('/api/queue/add', { method: 'POST', body: { items } });
    const keep = [];
    let saved = 0;
    data.results.forEach((r, i) => {
      const d = sent[i];
      $('saveresult').append(h('p', { class: `msg ${r.ok ? 'ok' : 'bad'}` }, r.ok ? `Đã nhận: ${d.parsed.summary}` : `Bị từ chối (${d.parsed.summary}): ${r.message}`));
      if (r.ok) saved++; else { d.error = r.message; keep.push(d); }
    });
    if (saved) $('saveresult').append(h('p', { class: 'msg ok' }, h('strong', {}, 'Đã lưu, chưa chạy.'), ' Bấm "Chạy ngay" ở mục Hàng đợi để bắt đầu.'));
    if (data.names === 'started') {
      $('saveresult').append(h('p', { class: 'msg' }, 'Đang lấy tên file gốc cho các link chưa đặt tên (khoảng 1 phút), danh sách sẽ tự cập nhật.'));
      for (const ms of [20000, 45000, 90000]) setTimeout(() => { if (state.auth) loadQueue(); }, ms);
    } else if (data.names === 'failed') $('saveresult').append(h('p', { class: 'msg warn' }, 'Không gọi được workflow lấy tên gốc (PAT thiếu quyền Actions, hoặc chưa có names.yml trên repo). Các mục vẫn được lưu, tên trống sẽ lấy từ file lúc nén.'));
    state.drafts = [...state.drafts.filter((d) => !sent.includes(d)), ...keep];
    renderDrafts(); loadQueue();
  } catch (e) {
    $('saveresult').append(h('p', { class: 'msg bad' }, e.message));
  } finally { btn.disabled = false; }
}

// ---------- hàng đợi (sửa nhiều rồi lưu một lần) ----------
async function loadQueue() {
  try {
    const d = await api('/api/queue');
    state.queue = d.queue.items;
    for (const id of [...state.edits.keys()]) if (!state.queue.some((i) => i.id === id)) state.edits.delete(id); // mục đã xong/bị xóa
    $('qsummary').textContent = `${d.counts.pending} đang chờ${d.counts.naming ? `, ${d.counts.naming} đang lấy tên` : ''}, ${d.counts.failed} lỗi.`;
    msg($('qmsg'), '');
    renderQueue();
  } catch (e) { if (e.code !== 'unauthorized') msg($('qmsg'), e.message, 'bad'); }
}
async function act(fn, okText) {
  try { await fn(); msg($('qmsg'), okText, 'ok'); await loadQueue(); } catch (e) { if (e.code !== 'unauthorized') msg($('qmsg'), e.message, 'bad'); }
}
function updateEditBar() {
  const n = state.edits.size;
  $('saveall').disabled = n === 0;
  $('saveall').textContent = n ? `Lưu tất cả thay đổi (${n})` : 'Lưu tất cả thay đổi';
  $('discard').hidden = n === 0;
  $('applyq').disabled = !state.queue.length;
}
function renderQueue() {
  const box = $('queue'); clear(box);
  if (!state.queue.length) box.append(h('p', { class: 'muted' }, 'Hàng đợi trống.'));
  for (const it of state.queue) {
    const failed = it.status === 'failed';
    const base = normOpts(it.options);
    const baseRef = it.referer || '';
    const baseMatch = it.link_match || '';
    const work = state.edits.has(it.id) ? state.edits.get(it.id).options : { ...base };
    const ed = state.edits.get(it.id);
    const cur = { referer: ed ? ed.referer : baseRef, linkMatch: ed ? ed.linkMatch : baseMatch };
    let chipEl = chips(work, cur.referer, cur.linkMatch);
    const dirtyNote = h('span', { class: 'badge exp', hidden: !state.edits.has(it.id) }, 'Chưa lưu');
    const card = h('div', { class: `item${failed ? ' failed' : ''}${state.edits.has(it.id) ? ' dirty' : ''}` });
    const onEdit = () => {
      if (sameOpts(work, base) && cur.referer === baseRef && cur.linkMatch === baseMatch) state.edits.delete(it.id); else state.edits.set(it.id, { options: work, referer: cur.referer, linkMatch: cur.linkMatch });
      const dirty = state.edits.has(it.id);
      card.classList.toggle('dirty', dirty); dirtyNote.hidden = !dirty;
      const fresh = chips(work, cur.referer, cur.linkMatch); chipEl.replaceWith(fresh); chipEl = fresh;
      updateEditBar();
    };
    card.append(
      h('div', { class: 'row' }, providerBadges(it.provider), h('strong', { class: 'grow' }, it.label || (it.status === 'naming' ? 'Đang lấy tên file gốc…' : it.id)), dirtyNote, h('span', { class: 'badge' }, failed ? 'Lỗi' : it.status === 'naming' ? 'Đang lấy tên' : 'Đang chờ')),
      chipEl,
      failed ? h('p', { class: 'msg bad' }, `${errText(it.last_error)} (đã thử ${it.attempts} lần)`) : (it.last_error ? h('p', { class: 'msg warn' }, errText(it.last_error)) : null),
      h('p', { class: 'muted' }, `Thêm lúc ${fmtDate(it.added_at)} • mã ${it.id}`),
      h('details', {}, h('summary', {}, 'Sửa tuỳ chọn'), refererInput(cur.referer, (v) => { cur.referer = v; onEdit(); }), it.provider === 'page_link' ? linkMatchInput(cur.linkMatch, (v) => { cur.linkMatch = v; onEdit(); }) : null, optionsEditor(work, onEdit),
        h('p', { class: 'muted' }, 'Thay đổi chỉ lưu sau khi bấm "Lưu tất cả thay đổi".')),
      h('div', { class: 'row', style: 'margin-top:8px' },
        failed ? h('button', { class: 'primary', onclick: () => act(() => api(`/api/queue/retry/${it.id}`, { method: 'POST' }), 'Đã chuyển về hàng chờ.') }, 'Thử lại') : null,
        h('button', { class: 'danger', onclick: () => { if (confirm('Xóa mục này khỏi hàng đợi?')) { state.edits.delete(it.id); act(() => api(`/api/queue/item/${it.id}`, { method: 'DELETE' }), 'Đã xóa.'); } } }, 'Xóa')));
    box.append(card);
  }
  updateEditBar();
}
async function saveAll() {
  const changes = [];
  for (const [id, e] of [...state.edits]) {
    const it = state.queue.find((x) => x.id === id);
    if (!it) { state.edits.delete(id); continue; }
    const base = normOpts(it.options); const diff = {};
    for (const k of Object.keys(e.options)) if (e.options[k] !== base[k]) diff[k] = e.options[k];
    const ch = { id };
    if (Object.keys(diff).length) ch.options = diff;
    if ((e.referer ?? '') !== (it.referer || '')) {
      const rp = validateRefPage(e.referer);
      if (!rp.ok) return msg($('qmsg'), `Mục ${it.label || it.id}: ${rp.message}`, 'bad');
      ch.referer = rp.value;
    }
    if (it.provider === 'page_link' && (e.linkMatch ?? '') !== (it.link_match || '')) {
      const lm = validateLinkMatch(e.linkMatch);
      if (!lm.ok) return msg($('qmsg'), `Mục ${it.label || it.id}: ${lm.message}`, 'bad');
      ch.link_match = lm.value;
    }
    if (ch.options || 'referer' in ch || 'link_match' in ch) changes.push(ch); else state.edits.delete(id);
  }
  if (!changes.length) { updateEditBar(); return msg($('qmsg'), 'Không có thay đổi nào cần lưu.', 'warn'); }
  $('saveall').disabled = true;
  try {
    const data = await api('/api/queue/batch', { method: 'PATCH', body: { changes } });
    const bad = [];
    for (const r of data.results) { if (r.ok) state.edits.delete(r.id); else bad.push(r.message); }
    if (bad.length) msg($('qmsg'), `Đã lưu ${data.updated} mục, ${bad.length} mục lỗi: ${[...new Set(bad)].join(' ')}`, 'warn');
    else msg($('qmsg'), `Đã lưu ${data.updated} mục. Chưa chạy: bấm "Chạy ngay" để bắt đầu.`, 'ok');
    await loadQueue();
  } catch (e) { if (e.code !== 'unauthorized') msg($('qmsg'), e.message, 'bad'); updateEditBar(); }
}
function applyDefaultsToQueue() {
  const targets = state.queue.filter((i) => ['pending', 'failed', 'naming'].includes(i.status));
  if (!targets.length) return msg($('qmsg'), 'Hàng đợi không có mục chờ hoặc mục lỗi để áp dụng.', 'warn');
  if (!confirm(`Đặt tuỳ chọn mặc định (mục "Tuỳ chọn cho mục mới") cho ${targets.length} mục đang chờ/lỗi? Mới chỉ đánh dấu; bấm "Lưu tất cả thay đổi" để lưu.`)) return;
  for (const it of targets) {
    const w = { ...state.defaults };
    const prev = state.edits.get(it.id);
    const ref = prev ? prev.referer : (it.referer || '');
    const lmv = prev ? prev.linkMatch : (it.link_match || '');
    if (sameOpts(w, normOpts(it.options)) && ref === (it.referer || '') && lmv === (it.link_match || '')) state.edits.delete(it.id); else state.edits.set(it.id, { options: w, referer: ref, linkMatch: lmv });
  }
  renderQueue();
  msg($('qmsg'), 'Đã đánh dấu thay đổi. Bấm "Lưu tất cả thay đổi" để lưu.', 'warn');
}
function discardEdits() { if (!state.edits.size || confirm('Bỏ tất cả thay đổi chưa lưu?')) { state.edits.clear(); renderQueue(); msg($('qmsg'), ''); } }

const RUN_TEXT = { queued: 'đang xếp hàng', in_progress: 'đang chạy', completed: 'xong' };
const CONC_TEXT = { success: 'thành công', failure: 'có lỗi', cancelled: 'bị hủy', skipped: 'bỏ qua' };
async function runNow() {
  $('runnow').disabled = true;
  try {
    if (!state.queue.some((i) => i.status === 'pending')) return msg($('qmsg'), state.queue.some((i) => i.status === 'naming') ? 'Các mục đang được lấy tên gốc, đợi khoảng 1 phút rồi bấm lại (hoặc bấm Làm mới).' : 'Không có mục nào đang chờ để chạy. Mục lỗi: bấm "Thử lại" trước.', 'warn');
    if (state.edits.size && !confirm(`Còn ${state.edits.size} thay đổi chưa lưu. Nếu chạy ngay, hệ thống dùng tuỳ chọn đã lưu trên GitHub (không có các thay đổi này). Vẫn chạy?`)) return;
    let active = null;
    try {
      active = (await api('/api/status')).runs.find((r) => r.status === 'queued' || r.status === 'in_progress');
    } catch (e) { if (e.code === 'unauthorized') return; /* không kiểm tra được thì vẫn cho chạy */ }
    if (active && !confirm(`Đang có lần chạy #${active.number} (${RUN_TEXT[active.status]}). Lệnh mới sẽ chờ lần đó xong rồi mới chạy (không chạy chồng). Vẫn gửi lệnh?`)) return;
    await api('/api/run', { method: 'POST', body: { mode: 'process' } });
    msg($('qmsg'), 'Đã gửi lệnh chạy. Xem tiến độ ở mục Trạng thái.', 'ok'); setTimeout(loadStatus, 4000);
  } catch (e) { if (e.code !== 'unauthorized') msg($('qmsg'), e.message, 'bad'); } finally { $('runnow').disabled = false; }
}

// ---------- trạng thái + video đã nén theo ngày ----------
async function copyLink(btn, url) {
  try { await navigator.clipboard.writeText(url); btn.textContent = 'Đã chép'; setTimeout(() => { btn.textContent = 'Chép link'; }, 1500); } catch { window.prompt('Chép link này:', url); }
}
function fileLine(label, f) {
  const url = safeUrl(f.url);
  const btn = h('button', { onclick: () => copyLink(btn, url) }, 'Chép link');
  return h('div', { class: 'row filerow' }, h('span', { class: 'muted tag' }, label), h('a', { href: url, target: '_blank', rel: 'noopener', class: 'grow' }, f.name), h('span', { class: 'muted' }, f.size ? fmtSize(f.size) : ''), btn);
}
function videoRow(v) {
  return h('div', { class: 'vid' },
    h('div', { class: 'row' }, v.time ? h('span', { class: 'muted' }, v.time) : null, h('strong', { class: 'grow' }, v.name), v.duration ? h('span', { class: 'muted' }, fmtDur(v.duration)) : null),
    fileLine('Bản thường', v.main),
    v.phone ? fileLine('Điện thoại', v.phone) : h('p', { class: 'muted' }, v.phone_skipped ? `Điện thoại: đã bỏ (${v.phone_skipped})` : 'Điện thoại: —'));
}
async function loadStatus() {
  const runs = $('runs'); const rel = $('releases'); clear(runs); clear(rel);
  try {
    const d = await api('/api/status');
    if (!d.runs.length) runs.append(h('p', { class: 'muted' }, 'Chưa có lần chạy nào.'));
    for (const r of d.runs) runs.append(h('p', {}, h('a', { href: safeUrl(r.url), target: '_blank', rel: 'noopener' }, `Lần chạy #${r.number}`), ` • ${fmtDate(r.created_at)} • ${r.status === 'completed' ? (CONC_TEXT[r.conclusion] || r.conclusion) : (RUN_TEXT[r.status] || r.status)}`));
    $('catlink').href = safeUrl(d.catalog_url); $('catlink').hidden = false;
    if (d.source === 'releases') rel.append(h('p', { class: 'muted' }, 'Chưa đọc được mục lục nên đang liệt kê tạm từ các release.'));
    if (!d.days.length) rel.append(h('p', { class: 'muted' }, 'Chưa có video nào.'));
    for (const day of d.days) {
      rel.append(h('div', { class: 'item' },
        h('div', { class: 'row' }, h('strong', { class: 'grow' }, `${day.date} · ${day.count} video`), h('a', { href: safeUrl(day.url), target: '_blank', rel: 'noopener' }, 'Mở release ngày')),
        day.items.map(videoRow)));
    }
  } catch (e) { if (e.code !== 'unauthorized') runs.append(h('p', { class: 'msg bad' }, e.message)); }
}

// ---------- khởi động ----------
$('login').addEventListener('click', loginWithPassword);
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') loginWithPassword(); });
$('forgot').addEventListener('click', () => toPin('Nhập PIN dự phòng để vào phiên này.', ''));
$('unlock').addEventListener('click', loginWithPin);
$('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') loginWithPin(); });
$('backpw').addEventListener('click', () => toPassword('', ''));
$('savepin').addEventListener('click', savePin);
$('pin2').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePin(); });
$('pin1').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pin2').focus(); });
$('delpin').addEventListener('click', removePin);
$('logout').addEventListener('click', logout);
$('links').addEventListener('input', renderPreview);
$('adddraft').addEventListener('click', addDrafts);
$('save').addEventListener('click', saveDrafts);
$('refresh').addEventListener('click', loadQueue);
$('refstatus').addEventListener('click', loadStatus);
$('runnow').addEventListener('click', runNow);
$('saveall').addEventListener('click', saveAll);
$('applyq').addEventListener('click', applyDefaultsToQueue);
$('discard').addEventListener('click', discardEdits);
$('applyall').addEventListener('click', () => { state.drafts.forEach((d) => { d.options = { ...state.defaults }; }); renderDrafts(); });
$('defopts').append(optionsEditor(state.defaults, saveDefaults)); // state.defaults đã nạp từ localStorage trước khi dựng, nên ô chọn hiện đúng giá trị đã lưu
window.addEventListener('beforeunload', (e) => { if (state.drafts.length || state.edits.size) { e.preventDefault(); e.returnValue = ''; } });

renderDrafts();
(async function boot() {
  let hadOldVault = false;
  try { hadOldVault = !!localStorage.getItem(OLD_VAULT_KEY); localStorage.removeItem(OLD_VAULT_KEY); } catch { /* storage bị chặn */ }
  let saved = null;
  try { saved = localStorage.getItem(PW_KEY); } catch { /* storage bị chặn */ }
  if (saved) { // đã ghi nhớ password: tự vào luôn
    const err = await connect('password', saved);
    if (!err) return enterApp();
    if (err.code !== 'unauthorized') toPassword(err.message, 'bad'); // lỗi mạng: giữ password đã nhớ, cho thử lại bằng cách tải lại trang
    return;
  }
  toPassword(hadOldVault ? 'Bản mới không còn dùng PIN lưu trên máy. Hãy nhập password (tick \"Ghi nhớ\" để lần sau tự vào). PIN giờ là mã dự phòng lưu ở Cloudflare, đặt trong phần \"PIN dự phòng\" sau khi đăng nhập.' : '', hadOldVault ? 'warn' : '');
})();
