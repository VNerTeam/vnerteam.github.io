// Phân tích link → { provider, ref }. Không gọi mạng.
// Dùng chung cho trình duyệt, Cloudflare Worker và Node (workflow).
// Thêm provider mới: thêm 1 entry vào PROVIDERS, 1 matcher vào MATCHERS, 1 hàm kiểm tra vào CHECKS
// (và 1 resolver trong scripts/resolvers.mjs).

export const PROVIDERS = {
  github_release: { label: 'GitHub Release', experimental: false },
  github_repo: { label: 'GitHub (file trong repo)', experimental: false },
  gdrive: { label: 'Google Drive', experimental: false },
  dropbox: { label: 'Dropbox', experimental: false },
  pcloud: { label: 'pCloud', experimental: false },
  huggingface: { label: 'Hugging Face', experimental: false },
  internet_archive: { label: 'Internet Archive', experimental: false },
  direct_url: { label: 'Link trực tiếp', experimental: false },
  onedrive: { label: 'OneDrive (cá nhân)', experimental: true },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS);

class RefError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const bad = (code, message) => {
  throw new RefError(code, message);
};

const RE = {
  owner: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,
  repo: /^[A-Za-z0-9._-]{1,100}$/,
  name: /^[A-Za-z0-9._+@-]{1,100}$/,
  sha40: /^[0-9a-f]{40}$/,
  gid: /^[A-Za-z0-9_-]{10,100}$/,
  key: /^[A-Za-z0-9_-]{4,100}$/,
  dbid: /^[A-Za-z0-9_-]{6,64}$/,
  pcode: /^[A-Za-z0-9]{10,100}$/,
  ia: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
  odseg: /^[A-Za-z0-9!_.~-]{1,200}$/,
  odshort: /^\/[uv](\/[A-Za-z0-9!_.~-]{1,200}){1,4}$/,
  odtoken: /^[A-Za-z0-9!_.%-]{3,100}$/,
  host: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
  dpath: /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/,
  dquery: /^[A-Za-z0-9\-._~%!$&'()*+,;=:@/?]*$/,
};

// ---- kiểm tra từng trường ----
function need(re, v, what) {
  if (typeof v !== 'string' || !re.test(v) || v.includes('..')) bad('bad_ref', `${what} không hợp lệ.`);
}
function seg(s, what) {
  if (typeof s !== 'string' || s.length < 1 || s.length > 255 || /[/\\\u0000-\u001f\u007f]/.test(s) || s.includes('..') || s === '.') {
    bad('bad_ref', `${what} không hợp lệ.`);
  }
}
function pathOf(p, what = 'Đường dẫn') {
  if (typeof p !== 'string' || p.length < 1 || p.length > 1500) bad('bad_ref', `${what} không hợp lệ.`);
  const parts = p.split('/');
  if (parts.length > 30) bad('bad_ref', `${what} quá sâu.`);
  parts.forEach((x) => seg(x, what));
}
function exact(r, keys) {
  const a = Object.keys(r).sort().join(',');
  const b = [...keys].sort().join(',');
  if (a !== b) bad('bad_ref', 'Cấu trúc ref không đúng.');
}
function oneOf(v, list, what) {
  if (!list.includes(v)) bad('bad_ref', `${what} không hợp lệ.`);
}
function revOf(v) {
  if (!(typeof v === 'string' && RE.sha40.test(v))) need(RE.name, v, 'Nhánh/tag/revision');
}

export function matchAllowedHost(host, list) {
  for (const e of list || []) {
    const h = String((e && e.host) || '').toLowerCase();
    if (!h) continue;
    if (h.startsWith('*.')) {
      if (host.endsWith(h.slice(1)) && host.length > h.length - 1) return e;
    } else if (host === h) return e;
  }
  return null;
}

const CHECKS = {
  github_release(r) {
    exact(r, ['owner', 'repo', 'tag', 'asset']);
    need(RE.owner, r.owner, 'Owner');
    need(RE.repo, r.repo, 'Repo');
    need(RE.name, r.tag, 'Tag');
    seg(r.asset, 'Tên file');
  },
  github_repo(r) {
    exact(r, ['owner', 'repo', 'ref', 'path']);
    need(RE.owner, r.owner, 'Owner');
    need(RE.repo, r.repo, 'Repo');
    revOf(r.ref);
    pathOf(r.path);
  },
  gdrive(r) {
    exact(r, ['id', 'resourcekey']);
    need(RE.gid, r.id, 'ID Google Drive');
    if (r.resourcekey !== null) need(RE.key, r.resourcekey, 'resourcekey');
  },
  dropbox(r) {
    exact(r, ['kind', 'id', 'name', 'rlkey']);
    oneOf(r.kind, ['scl', 's'], 'Loại link Dropbox');
    need(RE.dbid, r.id, 'ID Dropbox');
    seg(r.name, 'Tên file');
    if (r.rlkey === null) {
      if (r.kind === 'scl') bad('bad_ref', 'Link Dropbox thiếu rlkey.');
    } else need(RE.key, r.rlkey, 'rlkey');
  },
  pcloud(r) {
    exact(r, ['code', 'region']);
    need(RE.pcode, r.code, 'Mã pCloud');
    oneOf(r.region, ['eu', 'us', 'auto'], 'Vùng pCloud');
  },
  huggingface(r) {
    exact(r, ['type', 'repo', 'rev', 'path']);
    oneOf(r.type, ['model', 'dataset', 'space'], 'Loại repo');
    const p = typeof r.repo === 'string' ? r.repo.split('/') : [];
    if (p.length !== 2) bad('bad_ref', 'Tên repo không hợp lệ.');
    need(RE.repo, p[0], 'Owner');
    need(RE.repo, p[1], 'Repo');
    revOf(r.rev);
    pathOf(r.path);
  },
  internet_archive(r) {
    exact(r, ['identifier', 'file']);
    need(RE.ia, r.identifier, 'Identifier');
    pathOf(r.file, 'Tên file');
  },
  direct_url(r, ctx) {
    exact(r, ['host', 'path', 'query']);
    need(RE.host, r.host, 'Máy chủ');
    if (typeof r.path !== 'string' || r.path.length > 1500 || !RE.dpath.test(r.path) || r.path.includes('..') || r.path.includes('//')) {
      bad('bad_ref', 'Đường dẫn không hợp lệ.');
    }
    const entry = matchAllowedHost(r.host, ctx && ctx.allowedHosts);
    if (!entry) bad('host_not_allowed', 'Máy chủ này chưa nằm trong config/allowed-hosts.json.');
    if (r.query !== null) {
      if (!entry.allow_query) bad('query_not_allowed', 'Máy chủ này không cho phép tham số sau dấu ?.');
      if (typeof r.query !== 'string' || r.query.length > 1500 || !RE.dquery.test(r.query) || r.query.includes('..')) bad('bad_ref', 'Tham số không hợp lệ.');
    }
  },
  onedrive(r) {
    if (r && r.kind === 'short') {
      exact(r, ['kind', 'path']);
      if (typeof r.path !== 'string' || !RE.odshort.test(r.path) || r.path.includes('..')) bad('bad_ref', 'Link rút gọn OneDrive không hợp lệ.');
    } else if (r && r.kind === 'live') {
      exact(r, ['kind', 'resid', 'authkey']);
      need(RE.odtoken, r.resid, 'resid');
      if (r.authkey !== null) need(RE.odtoken, r.authkey, 'authkey');
    } else bad('bad_ref', 'Loại link OneDrive không hợp lệ.');
  },
};

export function validateRef(provider, ref, ctx = {}) {
  try {
    if (!Object.prototype.hasOwnProperty.call(CHECKS, provider)) bad('unsupported', 'Provider không được hỗ trợ.');
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) bad('bad_ref', 'ref không hợp lệ.');
    CHECKS[provider](ref, ctx);
    return { ok: true };
  } catch (e) {
    if (e instanceof RefError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}

// ---- tách link ----
function precheck(raw) {
  if (typeof raw !== 'string') bad('bad_url', 'Link không hợp lệ.');
  const s = raw.trim();
  if (!s) bad('empty', 'Link trống.');
  if (s.length > 2048) bad('too_long', 'Link quá dài (tối đa 2048 ký tự).');
  if (/[\s\u0000-\u001f\u007f]/.test(s)) bad('bad_url', 'Link không được chứa khoảng trắng hoặc ký tự điều khiển.');
  // URL() tự gom ".." nên phải chặn ngay trên chuỗi gốc
  if (/(\.|%2e){2}/i.test(s)) bad('bad_ref', 'Link chứa ".." nên không được nhận.');
  let u;
  try {
    u = new URL(s);
  } catch {
    bad('bad_url', 'Không đọc được link. Hãy dán đầy đủ, bắt đầu bằng https://');
  }
  if (u.protocol !== 'https:') bad('not_https', 'Chỉ nhận link https://');
  if (u.username || u.password) bad('credentials', 'Link có user:pass@, không được nhận.');
  if (u.port && u.port !== '443') bad('bad_port', 'Link dùng cổng lạ, không được nhận.');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) bad('ip_host', 'Link trỏ tới địa chỉ IP, không được nhận.');
  if (!RE.host.test(host)) bad('bad_url', 'Tên máy chủ không hợp lệ.');
  let parts = null;
  const ctx = {
    u,
    host,
    q: u.searchParams,
    get segs() {
      if (!parts) {
        parts = u.pathname
          .split('/')
          .slice(1)
          .map((x) => {
            try {
              return decodeURIComponent(x);
            } catch {
              return bad('bad_url', 'Link có ký tự mã hoá sai.');
            }
          });
        if (parts.length && parts[parts.length - 1] === '') parts.pop();
      }
      return parts;
    },
  };
  return ctx;
}

const FOLDER = 'Đây là thư mục hoặc trang xem, không phải file video. Hãy dán link tới đúng một file.';
const SHA_WARN = 'Chỉ nhận nhánh/tag không có dấu "/" hoặc mã SHA đầy đủ (40 ký tự).';

function repoRef(owner, repo, ref, rest) {
  if (!rest.length) bad('folder', FOLDER);
  const sha = RE.sha40.test(ref);
  return { provider: 'github_repo', ref: { owner, repo, ref, path: rest.join('/') }, warning: sha ? null : SHA_WARN };
}

const MATCHERS = [
  // GitHub
  (c) => {
    const { host, segs: s } = c;
    if (host === 'raw.githubusercontent.com') {
      if (s.length < 4) bad('folder', FOLDER);
      if (s[2] === 'refs') bad('bad_ref', 'Dạng /refs/heads/... chưa hỗ trợ. Dùng link .../<nhánh>/<đường dẫn>.');
      return repoRef(s[0], s[1], s[2], s.slice(3));
    }
    if (host !== 'github.com' && host !== 'www.github.com') return null;
    if (s.length >= 4 && s[2] === 'releases') {
      if (s[3] === 'download') {
        if (s.length !== 6) bad('bad_ref', 'Link release phải có dạng .../releases/download/<tag>/<tên file>.');
        return { provider: 'github_release', ref: { owner: s[0], repo: s[1], tag: s[4], asset: s[5] } };
      }
      bad('tag_page', 'Đây là trang release, không có tên file. Hãy dán link tải trực tiếp (.../releases/download/<tag>/<file>).');
    }
    if (s.length >= 4 && (s[2] === 'blob' || s[2] === 'raw')) {
      if (s[3] === 'refs') bad('bad_ref', 'Dạng /refs/heads/... chưa hỗ trợ.');
      return repoRef(s[0], s[1], s[3], s.slice(4));
    }
    if (s[2] === 'tree') bad('folder', FOLDER);
    bad('unsupported', 'Link GitHub này không phải file release hoặc file trong repo.');
  },
  // Google Drive
  (c) => {
    const { host, segs: s, q } = c;
    if (host !== 'drive.google.com' && host !== 'docs.google.com') return null;
    let id = null;
    if (host === 'docs.google.com') {
      if (['document', 'spreadsheets', 'presentation', 'forms', 'drawings'].includes(s[0])) bad('gdoc', 'Google Docs/Sheets/Slides không phải file video.');
      if (s[0] !== 'uc') bad('unsupported', 'Link Google này không phải file Drive.');
      id = q.get('id');
    } else {
      if (s.includes('folders') || s[0] === 'drive') bad('folder', FOLDER);
      if (s[0] === 'file') {
        const i = s.indexOf('d');
        id = i > 0 ? s[i + 1] : null;
      } else if (s[0] === 'open' || s[0] === 'uc') id = q.get('id');
      else bad('unsupported', 'Link Google Drive này không nhận diện được.');
    }
    if (!id) bad('bad_ref', 'Không tìm thấy ID file trong link.');
    return { provider: 'gdrive', ref: { id, resourcekey: q.get('resourcekey') || null } };
  },
  // Dropbox
  (c) => {
    const { host, segs: s, q } = c;
    if (host !== 'dropbox.com' && host !== 'www.dropbox.com') return null;
    if ((s[0] === 'scl' && s[1] === 'fo') || s[0] === 'sh') bad('folder', FOLDER);
    if (s[0] === 'scl' && s[1] === 'fi' && s.length === 4) return { provider: 'dropbox', ref: { kind: 'scl', id: s[2], name: s[3], rlkey: q.get('rlkey') || null } };
    if (s[0] === 's' && s.length === 3) return { provider: 'dropbox', ref: { kind: 's', id: s[1], name: s[2], rlkey: q.get('rlkey') || null } };
    bad('unsupported', 'Link Dropbox này không nhận diện được (cần dạng /scl/fi/... hoặc /s/...).');
  },
  // pCloud
  (c) => {
    const { host, segs: s, q } = c;
    if (!['u.pcloud.link', 'e.pcloud.link', 'my.pcloud.com'].includes(host)) return null;
    if (!(s[0] === 'publink' && s[1] === 'show')) bad('unsupported', 'Link pCloud phải có dạng .../publink/show?code=...');
    const code = q.get('code');
    if (!code) bad('bad_ref', 'Link pCloud thiếu tham số code.');
    const region = host === 'e.pcloud.link' ? 'eu' : host === 'u.pcloud.link' ? 'us' : 'auto';
    return { provider: 'pcloud', ref: { code, region } };
  },
  // Hugging Face
  (c) => {
    const { host, segs } = c;
    if (host !== 'huggingface.co') return null;
    let s = segs;
    let type = 'model';
    if (s[0] === 'datasets' || s[0] === 'spaces') {
      type = s[0] === 'datasets' ? 'dataset' : 'space';
      s = s.slice(1);
    }
    if (s[2] === 'tree') bad('folder', FOLDER);
    if (s.length < 5 || (s[2] !== 'resolve' && s[2] !== 'blob')) bad('bad_ref', 'Link Hugging Face phải có dạng .../resolve/<nhánh>/<đường dẫn> hoặc .../blob/...');
    return { provider: 'huggingface', ref: { type, repo: `${s[0]}/${s[1]}`, rev: s[3], path: s.slice(4).join('/') } };
  },
  // Internet Archive
  (c) => {
    const { host, segs: s } = c;
    if (host !== 'archive.org' && host !== 'www.archive.org') return null;
    if (s[0] === 'details') bad('details_page', 'Đây là trang mô tả, không có tên file. Hãy dùng link dạng archive.org/download/<id>/<tên file>.');
    if (s[0] !== 'download' || s.length < 3) bad('unsupported', 'Link Internet Archive phải có dạng archive.org/download/<id>/<file>.');
    return { provider: 'internet_archive', ref: { identifier: s[1], file: s.slice(2).join('/') } };
  },
  // OneDrive (thử nghiệm)
  (c) => {
    const { host, segs: s, q, u } = c;
    if (host.endsWith('.sharepoint.com')) bad('sharepoint', 'SharePoint/OneDrive công ty chưa được hỗ trợ (chỉ OneDrive cá nhân).');
    if (host === '1drv.ms') {
      if (s[0] === 'f') bad('folder', FOLDER);
      if (!['u', 'v'].includes(s[0]) || s.length < 2 || s.length > 5 || !s.every((x) => RE.odseg.test(x))) bad('unsupported', 'Link 1drv.ms không nhận diện được.');
      return { provider: 'onedrive', ref: { kind: 'short', path: u.pathname } };
    }
    if (host === 'onedrive.live.com') {
      const resid = q.get('resid');
      if (!resid) bad('bad_ref', 'Link OneDrive thiếu resid (có thể là thư mục).');
      return { provider: 'onedrive', ref: { kind: 'live', resid, authkey: q.get('authkey') || null } };
    }
    return null;
  },
];

export function summarize(provider, r) {
  const cut = (s, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  switch (provider) {
    case 'github_release': return cut(`${r.owner}/${r.repo} • ${r.asset}`);
    case 'github_repo': return cut(`${r.owner}/${r.repo} • ${r.path}`);
    case 'gdrive': return `ID …${r.id.slice(-8)}`;
    case 'dropbox': return cut(r.name);
    case 'pcloud': return `mã …${r.code.slice(-6)}`;
    case 'huggingface': return cut(`${r.repo} • ${r.path}`);
    case 'internet_archive': return cut(`${r.identifier} • ${r.file}`);
    case 'direct_url': return cut(`${r.host}${r.path}`);
    case 'onedrive': return r.kind === 'short' ? cut(`1drv.ms${r.path}`) : `resid …${r.resid.slice(-6)}`;
    default: return '';
  }
}

export function parseLink(raw, { allowedHosts = [] } = {}) {
  try {
    const c = precheck(raw);
    let found = null;
    for (const m of MATCHERS) {
      found = m(c);
      if (found) break;
    }
    if (!found) {
      const entry = matchAllowedHost(c.host, allowedHosts);
      if (!entry) bad('host_not_allowed', `Máy chủ ${c.host} chưa được hỗ trợ. Nếu là máy chủ của bạn, hãy thêm vào config/allowed-hosts.json.`);
      const query = c.u.search ? c.u.search.slice(1) : null;
      if (query && !entry.allow_query) bad('query_not_allowed', 'Link có tham số sau dấu ? (thường là link ký sẵn, sẽ hết hạn). Máy chủ này không bật allow_query.');
      found = { provider: 'direct_url', ref: { host: c.host, path: c.u.pathname, query } };
    }
    CHECKS[found.provider](found.ref, { allowedHosts });
    const meta = PROVIDERS[found.provider];
    return {
      ok: true,
      provider: found.provider,
      label: meta.label,
      experimental: meta.experimental,
      ref: found.ref,
      warning: found.warning || null,
      summary: summarize(found.provider, found.ref),
    };
  } catch (e) {
    if (e instanceof RefError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}
