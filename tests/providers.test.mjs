import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, validateRef, PROVIDER_IDS, matchAllowedHost } from '../docs/lib/providers.mjs';

const allowedHosts = [{ host: 'cdn.example.com', allow_query: false }, { host: '*.r2.dev', allow_query: false }, { host: 'files.mysite.io', allow_query: true }];
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

// [provider, [link hợp lệ...], [link bị từ chối...]]
const CASES = {
  github_release: [
    ['https://github.com/me/repo/releases/download/v1.0/video.mp4', 'https://github.com/me/repo/releases/download/vid-2026/a%20b.mkv', 'https://www.github.com/o-r/r.x/releases/download/t_1/x.mov'],
    ['https://github.com/me/repo/releases/tag/v1.0', 'https://github.com/me/repo/releases/download/v1.0', 'https://github.com/me/repo/releases/download/v1.0/..%2Fx.mp4'],
  ],
  github_repo: [
    ['https://github.com/me/repo/blob/main/v/clip.mp4', 'https://github.com/me/repo/raw/' + 'a'.repeat(40) + '/clip.mkv', 'https://raw.githubusercontent.com/me/repo/main/dir/a.mp4'],
    ['https://github.com/me/repo/tree/main/videos', 'https://raw.githubusercontent.com/me/repo/refs/heads/main/a.mp4', 'https://github.com/me/repo/blob/main/a/../b.mp4'],
  ],
  gdrive: [
    [`https://drive.google.com/file/d/${ID}/view?usp=sharing`, `https://drive.google.com/open?id=${ID}`, `https://docs.google.com/uc?id=${ID}&export=download`, `https://drive.google.com/uc?id=${ID}&resourcekey=0-AbCdEf1234`],
    ['https://drive.google.com/drive/folders/' + ID, `https://docs.google.com/document/d/${ID}/edit`, 'https://drive.google.com/file/d/short/view'],
  ],
  dropbox: [
    ['https://www.dropbox.com/scl/fi/abc123xyz/video.mp4?rlkey=k3yk3yk3y&st=abc&dl=0', 'https://dropbox.com/s/abcdef123/clip.mov?dl=0', 'https://www.dropbox.com/scl/fi/abc123xyz/a%20b.mp4?rlkey=zzzzzzzz'],
    ['https://www.dropbox.com/scl/fo/abc123/xyz?rlkey=abcdef', 'https://www.dropbox.com/sh/abc123/xyz', 'https://www.dropbox.com/scl/fi/abc123xyz/video.mp4'],
  ],
  pcloud: [
    ['https://u.pcloud.link/publink/show?code=XZabcdefghijklmnop1234', 'https://my.pcloud.com/publink/show?code=XZabcdefghijklmnop1234', 'https://e.pcloud.link/publink/show?code=XZabcdefghijklmnop1234'],
    ['https://u.pcloud.link/publink/show', 'https://u.pcloud.link/other?code=XZabcdefghijklmnop1234', 'https://u.pcloud.link/publink/show?code=bad!code'],
  ],
  huggingface: [
    ['https://huggingface.co/me/model/resolve/main/v/a.mp4', 'https://huggingface.co/datasets/me/ds/blob/main/a.mkv?download=true', 'https://huggingface.co/spaces/me/sp/resolve/' + 'b'.repeat(40) + '/x.mp4'],
    ['https://huggingface.co/me/model/tree/main', 'https://huggingface.co/me/model', 'https://huggingface.co/me/model/resolve/main/../a.mp4'],
  ],
  internet_archive: [
    ['https://archive.org/download/my-item_1/video.mp4', 'https://archive.org/download/item2/sub/dir/a.mkv', 'https://www.archive.org/download/Item3/x%20y.avi'],
    ['https://archive.org/details/my-item_1', 'https://archive.org/download/item2', 'https://archive.org/download/item2/../a.mp4'],
  ],
  direct_url: [
    ['https://cdn.example.com/v/a.mp4', 'https://bucket.r2.dev/a/b.mkv', 'https://files.mysite.io/a.mp4?token=abc123&e=1'],
    ['https://other.example.org/a.mp4', 'https://r2.dev/a.mp4', 'https://cdn.example.com/a.mp4?X-Amz-Signature=abc'],
  ],
  onedrive: [
    ['https://1drv.ms/u/s!AbCdEfGhIjK', 'https://1drv.ms/u/c/0123456789abcdef/EaBcDeFgHiJ', 'https://onedrive.live.com/?resid=ABCDEF123456789%21123&authkey=%21AbCd123'],
    ['https://1drv.ms/f/s!AbCdEfGhIjK', 'https://company-my.sharepoint.com/:v:/g/personal/x/y', 'https://onedrive.live.com/?cid=abc'],
  ],
};

const COMMON_BAD = [
  'http://github.com/me/repo/releases/download/v1/a.mp4',
  'https://user:pass@github.com/me/repo/releases/download/v1/a.mp4',
  'https://127.0.0.1/a.mp4',
  'https://192.168.1.5/a.mp4',
  'https://[::1]/a.mp4',
  'https://cdn.example.com:8443/a.mp4',
  'ftp://cdn.example.com/a.mp4',
  'không phải link',
  '',
  'https://cdn.example.com/a b.mp4',
  'https://evil.example.net/a.mp4',
];

for (const [provider, [good, badLinks]] of Object.entries(CASES)) {
  test(`${provider}: link hợp lệ`, () => {
    assert.ok(good.length >= 3);
    for (const url of good) {
      const r = parseLink(url, { allowedHosts });
      assert.equal(r.ok, true, `${url} → ${JSON.stringify(r)}`);
      assert.equal(r.provider, provider, url);
      assert.deepEqual(validateRef(r.provider, r.ref, { allowedHosts }), { ok: true });
    }
  });
  test(`${provider}: link bị từ chối`, () => {
    assert.ok(badLinks.length >= 3);
    for (const url of badLinks) {
      const r = parseLink(url, { allowedHosts });
      assert.equal(r.ok, false, `${url} phải bị từ chối`);
      assert.ok(r.message && r.code);
    }
  });
}

test('mọi provider đều có bộ test', () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...PROVIDER_IDS].sort());
});

test('link chung bị từ chối', () => {
  for (const url of COMMON_BAD) assert.equal(parseLink(url, { allowedHosts }).ok, false, url);
});

test('không lưu URL gốc, ref chuẩn hoá', () => {
  const r = parseLink('https://www.dropbox.com/scl/fi/abc123xyz/video.mp4?rlkey=k3yk3yk3y&st=abc&dl=0');
  assert.deepEqual(r.ref, { kind: 'scl', id: 'abc123xyz', name: 'video.mp4', rlkey: 'k3yk3yk3y' });
  assert.ok(!JSON.stringify(r.ref).includes('st=abc'));
  const g = parseLink(`https://drive.google.com/file/d/${ID}/view`);
  assert.deepEqual(g.ref, { id: ID, resourcekey: null });
});

test('github_repo: nhánh không phải SHA có cảnh báo', () => {
  assert.ok(parseLink('https://github.com/me/repo/blob/main/a.mp4').warning);
  assert.equal(parseLink('https://github.com/me/repo/blob/' + 'a'.repeat(40) + '/a.mp4').warning, null);
});

test('validateRef từ chối ref chứa .. hoặc ký tự lạ', () => {
  assert.equal(validateRef('github_repo', { owner: 'me', repo: 'repo', ref: 'main', path: '../x.mp4' }).ok, false);
  assert.equal(validateRef('github_release', { owner: 'me', repo: 'repo', tag: 'v1;rm -rf', asset: 'a.mp4' }).ok, false);
  assert.equal(validateRef('gdrive', { id: ID + '"; echo', resourcekey: null }).ok, false);
  assert.equal(validateRef('gdrive', { id: ID, resourcekey: null, extra: 1 }).ok, false);
  assert.equal(validateRef('direct_url', { host: 'cdn.example.com', path: '/a/../b.mp4', query: null }, { allowedHosts }).ok, false);
  assert.equal(validateRef('khong_co', {}).ok, false);
});

test('matchAllowedHost', () => {
  assert.ok(matchAllowedHost('x.r2.dev', allowedHosts));
  assert.equal(matchAllowedHost('r2.dev', allowedHosts), null);
  assert.equal(matchAllowedHost('evilr2.dev', allowedHosts), null);
});
