// Giao diện quản lý hàng đợi. Mọi chuỗi động hiển thị bằng textContent (không innerHTML).
import { WORKER_URL } from './config.js';
import { parseLink, suggestName, PROVIDERS } from './lib/providers.mjs';
import { OPTION_CHOICES, OPTION_LABELS, VMAF_RANGE, defaultOptions, validateOptions, validateLabel } from './lib/schema.mjs';
import { fmtDur } from './lib/format.mjs';
import { VAULT_KEY, LEGACY_KEY, MAX_FAILS, VaultError, validPin, createVault, openVault, readVault, writeVault, clearVault, recordBadPin, recordGoodPin } from './lib/vault.mjs';

const $ = (id) => document.getElementById(id);
const DEFAULTS_KEY = 'vc_defaults';

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

// state.password chỉ nằm trong bộ nhớ. edits: id → { options } là các thay đổi trong hàng đợi chưa lưu.
const state = { password: null, pendingPw: null, legacy: false, drafts: [], queue: [], hosts: [], defaults: loadDefaults(), nextId: 1, edits: new Map() };

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
  access_denied: 'Không có quyền tải file.',
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
    res = await fetch(WORKER_URL + path, { method, headers: { Authorization: `Bearer ${state.password}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Không kết nối được Worker. Kiểm tra mạng và địa chỉ trong config.js.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* không có JSON */ }
  if (res.status === 401) { onUnauthorized(); const e = new Error('Sai password.'); e.code = 'unauthorized'; throw e; }
  if (!res.ok) throw new Error(data.message || `Lỗi ${res.status}`);
  return data;
}

// ---------- màn hình: password / PIN / đặt PIN / ứng dụng ----------
function showScreen(name) { for (const id of ['lock', 'pinlock', 'pinset', 'app']) $(id).hidden = id !== name; }
function toPassword(text, kind) { showScreen('lock'); $('pw').value = ''; msg($('lockmsg'), text, kind); }
function toPin(text, kind) { showScreen('pinlock'); $('pin').value = ''; msg($('pinmsg'), text, kind); $('pin').focus(); }
function vaultButtons() { $('lockbtn').hidden = !readVault(localStorage); }

// Worker báo 401 (đổi password hoặc password sai): xoá két và về màn hình nhập password.
function onUnauthorized() {
  state.password = null; state.pendingPw = null;
  clearVault(localStorage); localStorage.removeItem(LEGACY_KEY);
  toPassword('Sai password hoặc password đã đổi. Hãy nhập lại.', 'bad');
}

// Thử password với Worker. Trả về null nếu được, hoặc Error (UI đã xử lý nếu là 401).
async function connect(pw) {
  if (WORKER_URL.includes('TEN-WORKER')) return new Error('Chưa cấu hình: hãy điền địa chỉ Worker vào docs/config.js.');
  state.password = pw;
  try {
    const cfg = await api('/api/config');
    state.hosts = cfg.allowed_hosts || [];
    return null;
  } catch (e) {
    if (e.code !== 'unauthorized') state.password = null;
    return e;
  }
}
function enterApp() { showScreen('app'); vaultButtons(); loadQueue(); loadStatus(); }

async function loginWithPassword() {
  const pw = $('pw').value;
  if (!pw) return msg($('lockmsg'), 'Hãy nhập password.', 'bad');
  $('login').disabled = true; msg($('lockmsg'), 'Đang kiểm tra…');
  try {
    const err = await connect(pw);
    if (err) { if (err.code !== 'unauthorized') toPassword(err.message, 'bad'); return; }
    if ($('remember').checked) { state.pendingPw = pw; state.legacy = false; showPinSet(); } else enterApp();
  } finally { $('login').disabled = false; $('pw').value = ''; }
}

function showPinSet() {
  showScreen('pinset'); $('pin1').value = ''; $('pin2').value = '';
  msg($('pinsetmsg'), state.legacy ? 'Password đang được lưu dạng thô trên máy này. Hãy đặt PIN để mã hoá nó.' : '', state.legacy ? 'warn' : '');
  $('pin1').focus();
}
async function savePin() {
  const a = $('pin1').value; const b = $('pin2').value;
  if (!validPin(a)) return msg($('pinsetmsg'), 'PIN phải gồm 4–6 chữ số.', 'bad');
  if (a !== b) return msg($('pinsetmsg'), 'Hai lần nhập PIN không khớp.', 'bad');
  if (!state.pendingPw) return toPassword('Phiên đã hết, hãy nhập lại password.', 'bad');
  $('savepin').disabled = true; msg($('pinsetmsg'), 'Đang mã hoá…');
  try {
    writeVault(localStorage, await createVault(a, state.pendingPw));
    localStorage.removeItem(LEGACY_KEY); // không còn lưu password dạng thô
    state.pendingPw = null; state.legacy = false;
    $('pin1').value = ''; $('pin2').value = '';
    enterApp();
  } catch (e) { msg($('pinsetmsg'), e.message || 'Không lưu được PIN.', 'bad'); } finally { $('savepin').disabled = false; }
}
function cancelPinSet() {
  state.password = null; state.pendingPw = null;
  if (state.legacy) localStorage.removeItem(LEGACY_KEY); // không đặt PIN thì không giữ password thô
  state.legacy = false;
  toPassword('Chưa lưu gì trên máy này. Bỏ tick "Ghi nhớ" nếu không muốn đặt PIN.', 'warn');
}

async function unlock() {
  const vault = readVault(localStorage);
  if (!vault) { clearVault(localStorage); return toPassword('Không còn PIN được lưu. Hãy nhập password.', 'warn'); }
  const pin = $('pin').value;
  if (!validPin(pin)) return msg($('pinmsg'), 'PIN gồm 4–6 chữ số.', 'bad');
  $('unlock').disabled = true; msg($('pinmsg'), 'Đang mở khoá…');
  try {
    let pw;
    try {
      pw = await openVault(vault, pin);
    } catch (e) {
      if (!(e instanceof VaultError)) throw e;
      if (e.code === 'corrupt') { clearVault(localStorage); return toPassword('Dữ liệu PIN bị hỏng. Hãy nhập lại password.', 'bad'); }
      const r = recordBadPin(localStorage, vault);
      if (r.wiped) return toPassword(`Nhập sai PIN ${MAX_FAILS} lần. Đã xoá PIN trên máy này, hãy nhập lại password.`, 'bad');
      $('pin').value = '';
      return msg($('pinmsg'), `PIN không đúng (sai ${r.fails}/${MAX_FAILS} lần; sai ${MAX_FAILS} lần sẽ phải nhập lại password).`, 'bad');
    }
    recordGoodPin(localStorage, vault);
    const err = await connect(pw);
    if (!err) { $('pin').value = ''; return enterApp(); }
    if (err.code !== 'unauthorized') toPin(err.message, 'bad'); // lỗi mạng: giữ két, cho thử lại
  } catch (e) { msg($('pinmsg'), e.message || 'Không mở khoá được.', 'bad'); } finally { $('unlock').disabled = false; }
}
function forgotPin() {
  clearVault(localStorage); state.password = null;
  $('remember').checked = true;
  toPassword('Đã xoá PIN cũ. Nhập password rồi đặt PIN mới.', '');
}
// Khoá: xoá password khỏi bộ nhớ, giữ két (cần PIN để vào lại).
function lockNow() { state.password = null; if (readVault(localStorage)) toPin('Đã khoá. Nhập PIN để mở.', ''); else toPassword('', ''); }
function logout() {
  const dirty = state.drafts.length || state.edits.size;
  if (dirty && !confirm('Đăng xuất sẽ mất các nháp và thay đổi chưa lưu. Tiếp tục?')) return;
  state.drafts = []; state.edits.clear(); state.password = null;
  clearVault(localStorage); localStorage.removeItem(LEGACY_KEY);
  renderDrafts(); toPassword('', '');
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
const chipText = (o, k) => { const t = OPTION_CHOICES[k].find(([v]) => v === o[k])?.[1] ?? String(o[k]); return k === 'phone' ? `Điện thoại: ${t}` : t; };
const chips = (o) => h('div', { class: 'chips' }, Object.keys(OPTION_CHOICES).map((k) => h('span', {}, chipText(o, k))), o.min_vmaf != null ? h('span', {}, `VMAF ≥ ${o.min_vmaf}`) : null);
const providerBadges = (p) => [h('span', { class: 'badge' }, PROVIDERS[p]?.label || p), PROVIDERS[p]?.experimental ? h('span', { class: 'badge exp' }, ' Thử nghiệm') : null];

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
    state.drafts.push({ key: state.nextId++, url, parsed: r, options: { ...state.defaults }, label: suggestName(r.provider, r.ref) || '', error: null });
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
      chips(d.options),
      h('details', {}, h('summary', {}, 'Sửa tuỳ chọn'),
        h('label', { class: 'muted' }, 'Tên hiển thị (tuỳ chọn) ', h('input', { maxlength: 80, value: d.label, oninput: (e) => { d.label = e.target.value; } })),
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
      const o = validateOptions(d.options); const l = validateLabel(d.label);
      if (!o.ok || !l.ok) { d.error = (o.ok ? l : o).message; continue; }
      d.error = null; items.push({ url: d.url, options: o.value, label: l.value }); sent.push(d);
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
    $('qsummary').textContent = `${d.counts.pending} đang chờ, ${d.counts.failed} lỗi.`;
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
    const work = state.edits.has(it.id) ? state.edits.get(it.id).options : { ...base };
    let chipEl = chips(work);
    const dirtyNote = h('span', { class: 'badge exp', hidden: !state.edits.has(it.id) }, 'Chưa lưu');
    const card = h('div', { class: `item${failed ? ' failed' : ''}${state.edits.has(it.id) ? ' dirty' : ''}` });
    const onEdit = () => {
      if (sameOpts(work, base)) state.edits.delete(it.id); else state.edits.set(it.id, { options: work });
      const dirty = state.edits.has(it.id);
      card.classList.toggle('dirty', dirty); dirtyNote.hidden = !dirty;
      const fresh = chips(work); chipEl.replaceWith(fresh); chipEl = fresh;
      updateEditBar();
    };
    card.append(
      h('div', { class: 'row' }, providerBadges(it.provider), h('strong', { class: 'grow' }, it.label || it.id), dirtyNote, h('span', { class: 'badge' }, failed ? 'Lỗi' : 'Đang chờ')),
      chipEl,
      failed ? h('p', { class: 'msg bad' }, `${errText(it.last_error)} (đã thử ${it.attempts} lần)`) : (it.last_error ? h('p', { class: 'msg warn' }, errText(it.last_error)) : null),
      h('p', { class: 'muted' }, `Thêm lúc ${fmtDate(it.added_at)} • mã ${it.id}`),
      h('details', {}, h('summary', {}, 'Sửa tuỳ chọn'), optionsEditor(work, onEdit),
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
    if (Object.keys(diff).length) changes.push({ id, options: diff }); else state.edits.delete(id);
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
  const targets = state.queue.filter((i) => ['pending', 'failed'].includes(i.status));
  if (!targets.length) return msg($('qmsg'), 'Hàng đợi không có mục chờ hoặc mục lỗi để áp dụng.', 'warn');
  if (!confirm(`Đặt tuỳ chọn mặc định (mục "Tuỳ chọn cho mục mới") cho ${targets.length} mục đang chờ/lỗi? Mới chỉ đánh dấu; bấm "Lưu tất cả thay đổi" để lưu.`)) return;
  for (const it of targets) {
    const w = { ...state.defaults };
    if (sameOpts(w, normOpts(it.options))) state.edits.delete(it.id); else state.edits.set(it.id, { options: w });
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
    if (!state.queue.some((i) => i.status === 'pending')) return msg($('qmsg'), 'Không có mục nào đang chờ để chạy. Mục lỗi: bấm "Thử lại" trước.', 'warn');
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
$('unlock').addEventListener('click', unlock);
$('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
$('forgot').addEventListener('click', forgotPin);
$('savepin').addEventListener('click', savePin);
$('pin2').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePin(); });
$('pin1').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pin2').focus(); });
$('cancelpin').addEventListener('click', cancelPinSet);
$('lockbtn').addEventListener('click', lockNow);
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
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) { // password thô của bản cũ: dùng để đăng nhập, ép đặt PIN rồi xoá khoá cũ
    const err = await connect(legacy);
    if (!err) { state.pendingPw = legacy; state.legacy = true; return showPinSet(); }
    if (err.code !== 'unauthorized') toPassword(err.message, 'bad');
    return;
  }
  if (readVault(localStorage)) return toPin('', '');
  if (localStorage.getItem(VAULT_KEY)) clearVault(localStorage); // két hỏng
  toPassword('', '');
})();
