import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makePlan, shortSideScale, phoneOutDims, phoneBitrate, phoneFilter, buildPhoneArgs, verifyPhone, PHONE_TONEMAP } from '../scripts/encode-plan.mjs';
import { defaultOptions } from '../docs/lib/schema.mjs';

const profiles = JSON.parse(fs.readFileSync(new URL('../config/profiles.json', import.meta.url), 'utf8'));
const src = (w, h, extra = {}) => ({ width: w, height: h, rotated: false, fps: 30, hdr: false, v: { codec_name: 'h264' }, audio: [], subs: [], pixFmt: 'yuv420p', ...extra });
const plan = (res, a) => makePlan({ ...defaultOptions(), resolution: res }, a, profiles);

test('F: cạnh ngắn là chuẩn; video ngang và dọc đều đúng', () => {
  assert.equal(plan('fhd', src(1920, 1080)).scaleH, null); // đã đúng 1080p
  assert.equal(plan('fhd', src(1080, 1920)).scaleH, null); // dọc 1080×1920: KHÔNG thu về 608×1080 như lỗi cũ
  assert.equal(plan('fhd', src(3840, 2160)).scaleH, 1080);
  assert.equal(plan('fhd', src(2160, 3840)).scaleH, 1080);
  assert.equal(plan('fhd', src(1280, 720)).scaleH, null); // nhỏ hơn mức chọn: không phóng to
  assert.equal(plan('4k', src(1920, 1080)).scaleH, null);
  assert.equal(plan('original', src(3840, 2160)).vf, null);
});
test('F: video có rotation 90 (khung lưu ngang, hiển thị dọc)', () => {
  const a = src(1920, 1080, { rotated: true }); // hiển thị 1080×1920
  assert.equal(plan('fhd', a).scaleH, null);
  assert.equal(plan('hd', a).scaleH, 720);
  const b = src(3840, 2160, { rotated: true }); // hiển thị 2160×3840
  assert.equal(plan('fhd', b).scaleH, 1080);
});
test('F: biểu thức scale dùng cạnh ngắn và có fps_cap', () => {
  assert.equal(shortSideScale(1080), "scale='if(gt(iw,ih),-2,1080)':'if(gt(iw,ih),1080,-2)':flags=lanczos");
  const p = makePlan({ ...defaultOptions(), resolution: 'fhd', fps_cap: 30 }, src(3840, 2160, { fps: 60 }), profiles);
  assert.equal(p.vf, `${shortSideScale(1080)},fps=30`);
});

test('B: bản điện thoại giữ độ phân giải, trần cạnh dài 1920, mức bitrate theo đầu ra', () => {
  assert.deepEqual(phoneOutDims(3840, 2160, 1920), { w: 1920, h: 1080, long: 1920 });
  assert.deepEqual(phoneOutDims(2160, 3840, 1920), { w: 1080, h: 1920, long: 1920 });
  assert.deepEqual(phoneOutDims(1280, 720, 1920), { w: 1280, h: 720, long: 1280 });
  assert.deepEqual(phoneBitrate(profiles.phone, 1280), { maxrate: '2500k', bufsize: '5000k' });
  assert.deepEqual(phoneBitrate(profiles.phone, 1920), { maxrate: '4500k', bufsize: '9000k' });
  assert.deepEqual(phoneBitrate(profiles.phone, 1281), { maxrate: '4500k', bufsize: '9000k' });
});
test('B: lệnh ffmpeg bản điện thoại đúng thông số bat', () => {
  const o = { width: 3840, height: 2160, rotated: false };
  const { args, maxrate, bufsize } = buildPhoneArgs({ input: 'in.mkv', output: 'phone.mp4', o, hdr: false, tonemap: true, profile: profiles.phone });
  const get = (k) => args[args.indexOf(k) + 1];
  assert.equal(maxrate, '4500k'); assert.equal(bufsize, '9000k');
  assert.equal(get('-c:v'), 'libx264'); assert.equal(get('-preset'), 'medium'); assert.equal(get('-crf'), '25');
  assert.equal(get('-c:a'), 'aac'); assert.equal(get('-b:a'), '128k'); assert.equal(get('-ac'), '2');
  assert.equal(get('-pix_fmt'), 'yuv420p'); assert.equal(get('-movflags'), '+faststart');
  assert.ok(args.includes('0:v:0') && args.includes('0:a:0?'));
  assert.ok(!args.join(' ').includes('zscale')); // nguồn SDR: không tone-map
  assert.ok(!args.includes('-color_trc'));
  assert.equal(args.at(-1), 'phone.mp4');
});
test('B: nguồn HDR có tone-map; thiếu zscale thì bỏ tone-map', () => {
  const o = { width: 1920, height: 1080, rotated: false };
  const withTm = buildPhoneArgs({ input: 'i', output: 'o.mp4', o, hdr: true, tonemap: true, profile: profiles.phone }).args;
  assert.ok(withTm.join(' ').includes(PHONE_TONEMAP));
  assert.equal(withTm[withTm.indexOf('-color_trc') + 1], 'bt709');
  const noTm = buildPhoneArgs({ input: 'i', output: 'o.mp4', o, hdr: true, tonemap: false, profile: profiles.phone }).args;
  assert.ok(!noTm.join(' ').includes('zscale'));
  assert.equal(phoneFilter({ maxEdge: 1920, tonemap: false }).endsWith('format=yuv420p'), true);
});
test('B: xác minh bản điện thoại', () => {
  const s = { duration: 100, audio: [{}] };
  const ok = { codec: 'h264', pixFmt: 'yuv420p', duration: 100.4, audio: [{}] };
  assert.equal(verifyPhone(ok, s), null);
  assert.match(verifyPhone({ ...ok, codec: 'hevc' }, s), /h264/);
  assert.match(verifyPhone({ ...ok, pixFmt: 'yuv420p10le' }, s), /yuv420p/);
  assert.match(verifyPhone({ ...ok, duration: 103 }, s), /lệch/);
  assert.match(verifyPhone({ ...ok, audio: [] }, s), /âm thanh/);
  assert.equal(verifyPhone({ ...ok, duration: 2.027 }, { duration: 2, audio: [{}] }), null); // clip 2 giây: đệm AAC không bị coi là lỗi
  assert.match(verifyPhone({ ...ok, duration: 3 }, { duration: 2, audio: [{}] }), /lệch/);
  assert.equal(verifyPhone({ ...ok, audio: [] }, { duration: 100, audio: [] }), null); // nguồn không có tiếng
});
