// Giao diện quản lý hàng đợi. Mọi chuỗi động hiển thị bằng textContent (không innerHTML).
import { WORKER_URL } from './config.js';
import { parseLink, PROVIDERS } from './lib/providers.mjs';
import { OPTION_CHOICES, OPTION_LABELS, VMAF_RANGE, defaultOptions, validateOptions, validateLabel } from './lib/schema.mjs';

const $ = (id) => document.getElementById(id);
const KEY = 'vc_password';
const state = { password: null, drafts: [], queue: [], hosts: [], defaults: defaultOptions(), nextId: 1 };

const ERROR_TEXT = {
  drive_quota: 'Google Drive đang giới hạn lượt tải file này. Thử lại sau vài giờ.',
  drive_private: 'File Drive chưa chia sẻ "bất kỳ ai có link".',
  not_direct_video: 'Link không trỏ tới file video (có thể là trang web hoặc cần đăng nhập).',
  not_a_video: 'File tải về không phải video hợp lệ.',
  too_long: 'Video quá dài để nén trong giới hạn thời gian, kể cả ở tốc độ nhanh nhất.',
  too_big: 'File sau khi nén vẫn lớn hơn 2 GiB (giới hạn của Release).',
  no_gain: 'Nén xong không nhỏ hơn bản gốc nên không đăng lên.',
  timeout: 'Hết thời gian xử lý. Lần sau sẽ dùng tốc độ nhanh hơn.',
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
  if (res.status === 401) { logout(true); throw new Error('Sai password.'); }
  if (!res.ok) throw new Error(data.message || `Lỗi ${res.status}`);
  return data;
}

// ---------- khóa bằng password ----------
function showLock(text, kind) { $('app').hidden = true; $('lock').hidden = false; msg($('lockmsg'), text, kind); }
function logout(keepMsg) { state.password = null; localStorage.removeItem(KEY); showLock(keepMsg ? 'Sai password hoặc phiên đã hết.' : '', 'bad'); }
async function login(pw, remember) {
  if (WORKER_URL.includes('TEN-WORKER')) return showLock('Chưa cấu hình: hãy điền địa chỉ Worker vào docs/config.js.', 'bad');
  state.password = pw;
  try {
    const cfg = await api('/api/config');
    state.hosts = cfg.allowed_hosts || [];
  } catch (e) {
    if (state.password) { state.password = null; showLock(e.message, 'bad'); }
    return;
  }
  if (remember) localStorage.setItem(KEY, pw); else localStorage.removeItem(KEY);
  $('lock').hidden = true; $('app').hidden = false;
  loadQueue(); loadStatus();
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
const chips = (o) => h('div', { class: 'chips' }, Object.keys(OPTION_CHOICES).map((k) => h('span', {}, OPTION_CHOICES[k].find(([v]) => v === o[k])?.[1] ?? o[k])), o.min_vmaf != null ? h('span', {}, `VMAF ≥ ${o.min_vmaf}`) : null);
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
    state.drafts.push({ key: state.nextId++, url, parsed: r, options: { ...state.defaults }, label: '', error: null });
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
    data.results.forEach((r, i) => {
      const d = sent[i];
      $('saveresult').append(h('p', { class: `msg ${r.ok ? 'ok' : 'bad'}` }, r.ok ? `Đã nhận: ${d.parsed.summary}` : `Bị từ chối (${d.parsed.summary}): ${r.message}`));
      if (!r.ok) { d.error = r.message; keep.push(d); }
    });
    state.drafts = [...state.drafts.filter((d) => !sent.includes(d)), ...keep];
    renderDrafts(); loadQueue();
  } catch (e) {
    $('saveresult').append(h('p', { class: 'msg bad' }, e.message));
  } finally { btn.disabled = false; }
}

// ---------- hàng đợi ----------
async function loadQueue() {
  try {
    const d = await api('/api/queue');
    state.queue = d.queue.items;
    $('qsummary').textContent = `${d.counts.pending} đang chờ, ${d.counts.failed} lỗi.`;
    msg($('qmsg'), '');
    renderQueue();
  } catch (e) { msg($('qmsg'), e.message, 'bad'); }
}
async function act(fn, okText) {
  try { await fn(); msg($('qmsg'), okText, 'ok'); await loadQueue(); } catch (e) { msg($('qmsg'), e.message, 'bad'); }
}
function renderQueue() {
  const box = $('queue'); clear(box);
  if (!state.queue.length) box.append(h('p', { class: 'muted' }, 'Hàng đợi trống.'));
  for (const it of state.queue) {
    const failed = it.status === 'failed';
    const edit = { ...it.options };
    box.append(h('div', { class: `item${failed ? ' failed' : ''}` },
      h('div', { class: 'row' }, providerBadges(it.provider), h('strong', { class: 'grow' }, it.label || it.id), h('span', { class: 'badge' }, failed ? 'Lỗi' : 'Đang chờ')),
      chips(it.options),
      failed ? h('p', { class: 'msg bad' }, `${errText(it.last_error)} (đã thử ${it.attempts} lần)`) : (it.last_error ? h('p', { class: 'msg warn' }, errText(it.last_error)) : null),
      h('p', { class: 'muted' }, `Thêm lúc ${fmtDate(it.added_at)} • mã ${it.id}`),
      h('details', {}, h('summary', {}, 'Sửa'), optionsEditor(edit),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { onclick: () => act(() => api(`/api/queue/item/${it.id}`, { method: 'PATCH', body: { options: edit } }), 'Đã cập nhật tuỳ chọn.') }, 'Lưu tuỳ chọn'))),
      h('div', { class: 'row', style: 'margin-top:8px' },
        failed ? h('button', { class: 'primary', onclick: () => act(() => api(`/api/queue/retry/${it.id}`, { method: 'POST' }), 'Đã chuyển về hàng chờ.') }, 'Thử lại') : null,
        h('button', { class: 'danger', onclick: () => { if (confirm('Xóa mục này khỏi hàng đợi?')) act(() => api(`/api/queue/item/${it.id}`, { method: 'DELETE' }), 'Đã xóa.'); } }, 'Xóa'))));
  }
}
async function runNow() {
  $('runnow').disabled = true;
  try { await api('/api/run', { method: 'POST', body: { mode: 'process' } }); msg($('qmsg'), 'Đã gửi lệnh chạy. Xem tiến độ ở mục Trạng thái.', 'ok'); setTimeout(loadStatus, 4000); }
  catch (e) { msg($('qmsg'), e.message, 'bad'); }
  finally { $('runnow').disabled = false; }
}

// ---------- trạng thái ----------
const RUN_TEXT = { queued: 'đang xếp hàng', in_progress: 'đang chạy', completed: 'xong' };
const CONC_TEXT = { success: 'thành công', failure: 'có lỗi', cancelled: 'bị hủy', skipped: 'bỏ qua' };
async function loadStatus() {
  const runs = $('runs'); const rel = $('releases'); clear(runs); clear(rel);
  try {
    const d = await api('/api/status');
    if (!d.runs.length) runs.append(h('p', { class: 'muted' }, 'Chưa có lần chạy nào.'));
    for (const r of d.runs) runs.append(h('p', {}, h('a', { href: r.url, target: '_blank', rel: 'noopener' }, `Lần chạy #${r.number}`), ` • ${fmtDate(r.created_at)} • ${r.status === 'completed' ? (CONC_TEXT[r.conclusion] || r.conclusion) : (RUN_TEXT[r.status] || r.status)}`));
    if (!d.releases.length) rel.append(h('p', { class: 'muted' }, 'Chưa có video nào.'));
    for (const r of d.releases) rel.append(h('div', { class: 'item' }, h('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.name || r.tag),
      r.assets.map((a) => h('p', { class: 'muted' }, h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.name), ` • ${fmtSize(a.size)}`))));
  } catch (e) { runs.append(h('p', { class: 'msg bad' }, e.message)); }
}

// ---------- khởi động ----------
$('login').addEventListener('click', () => login($('pw').value, $('remember').checked));
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login').click(); });
$('logout').addEventListener('click', () => { if (!state.drafts.length || confirm('Đăng xuất sẽ mất các nháp chưa lưu. Tiếp tục?')) { state.drafts = []; logout(false); } });
$('links').addEventListener('input', renderPreview);
$('adddraft').addEventListener('click', addDrafts);
$('save').addEventListener('click', saveDrafts);
$('refresh').addEventListener('click', loadQueue);
$('refstatus').addEventListener('click', loadStatus);
$('runnow').addEventListener('click', runNow);
$('applyall').addEventListener('click', () => { state.drafts.forEach((d) => { d.options = { ...state.defaults }; }); renderDrafts(); });
$('defopts').append(optionsEditor(state.defaults));
window.addEventListener('beforeunload', (e) => { if (state.drafts.length) { e.preventDefault(); e.returnValue = ''; } });

renderDrafts();
const saved = localStorage.getItem(KEY);
if (saved) login(saved, true); else showLock('');
