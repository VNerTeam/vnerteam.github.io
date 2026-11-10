// Dựng kế hoạch nén và lệnh ffmpeg (hàm thuần, không chạy tiến trình) để test được mà không cần ffmpeg thật.

// ---------- bản thường ----------
// Tuỳ chọn 720/1080/1440/2160 là CẠNH NGẮN. Biểu thức do ffmpeg tính sau khi tự xoay theo metadata (autorotate),
// nên cùng một vf đúng cho cả video ngang lẫn dọc: cạnh ngắn bị đặt về H, cạnh dài tự suy ra (-2 = số chẵn).
export const shortSideScale = (H) => `scale='if(gt(iw,ih),-2,${H})':'if(gt(iw,ih),${H},-2)':flags=lanczos`;

export function displaySize(a) {
  return a.rotated ? { w: a.height, h: a.width } : { w: a.width, h: a.height };
}

export function makePlan(opt, a, profiles) {
  const targetH = profiles.resolutions[opt.resolution].height;
  const d = displaySize(a);
  const shortSide = Math.min(d.w, d.h);
  const scaleH = targetH && shortSide > targetH ? targetH : null; // chỉ thu nhỏ, không phóng to
  const fpsCap = opt.fps_cap && a.fps > opt.fps_cap + 0.5 ? opt.fps_cap : null;
  const vf = [scaleH ? shortSideScale(scaleH) : null, fpsCap ? `fps=${fpsCap}` : null].filter(Boolean).join(',') || null;
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

// ---------- bản điện thoại (kiểu video_to_fhd.bat) ----------
// Lệnh gốc của bat: scale 'if(gt(a,1),min(1920,iw),-2)':'if(gt(a,1),-2,min(1920,ih))' → cạnh dài tối đa 1920, không phóng to.
export const PHONE_TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

export function phoneScale(maxEdge) {
  return `scale='if(gt(a,1),min(${maxEdge},iw),-2)':'if(gt(a,1),-2,min(${maxEdge},ih))':flags=lanczos`;
}

// Kích thước đầu ra sau scale của bat (làm tròn xuống số chẵn như -2), dùng để chọn mức bitrate.
export function phoneOutDims(w, h, maxEdge) {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { w, h, long };
  const f = maxEdge / long;
  const ev = (x) => Math.max(2, Math.round((x * f) / 2) * 2);
  const nw = w >= h ? maxEdge : ev(w);
  const nh = w >= h ? ev(h) : maxEdge;
  return { w: nw, h: nh, long: maxEdge };
}

// Chọn maxrate theo CẠNH DÀI của khung hình đầu ra; bufsize = maxrate × bufsize_factor.
export function phoneBitrate(profile, outLong) {
  const caps = [...profile.caps].sort((x, y) => x.max_long_edge - y.max_long_edge);
  const cap = caps.find((c) => outLong <= c.max_long_edge) || caps[caps.length - 1];
  const m = /^(\d+)k$/.exec(cap.maxrate);
  if (!m) throw new Error(`maxrate không hợp lệ: ${cap.maxrate}`);
  return { maxrate: cap.maxrate, bufsize: `${Number(m[1]) * profile.bufsize_factor}k` };
}

export function phoneFilter({ maxEdge, tonemap }) {
  return [phoneScale(maxEdge), ...(tonemap ? [PHONE_TONEMAP] : []), 'format=yuv420p'].join(',');
}

// `o` = phân tích (ffprobe) của BẢN THƯỜNG vì bản điện thoại làm từ bản thường. `hdr` lấy từ nguồn.
export function buildPhoneArgs({ input, output, o, hdr, tonemap, profile }) {
  const d = displaySize(o);
  const dims = phoneOutDims(d.w, d.h, profile.max_long_edge);
  const br = phoneBitrate(profile, dims.long);
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', phoneFilter({ maxEdge: profile.max_long_edge, tonemap: hdr && tonemap }),
    '-c:v', 'libx264', '-preset', profile.preset, '-crf', String(profile.crf), '-maxrate', br.maxrate, '-bufsize', br.bufsize, '-pix_fmt', 'yuv420p'];
  if (hdr && tonemap) args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  args.push('-c:a', 'aac', '-b:a', `${profile.audio_kbps}k`, '-ac', '2', '-movflags', '+faststart', '-max_muxing_queue_size', '4096', output);
  return { args, dims, ...br };
}

// Kiểm tra bản điện thoại bằng kết quả ffprobe đã phân tích. Trả về chuỗi lỗi hoặc null nếu đạt.
export function verifyPhone(p, src) {
  if (p.codec !== 'h264') return `codec ${p.codec} không phải h264`;
  if (p.pixFmt !== 'yuv420p') return `pix_fmt ${p.pixFmt} không phải yuv420p`;
  // Lệch ≤ 1%. Clip rất ngắn thì phần đệm của AAC (~20–30 ms) có thể vượt 1%, nên cho thêm sàn tuyệt đối 0,25 giây.
  const abs = Math.abs(p.duration - src.duration);
  if (abs > 0.25 && abs / src.duration > 0.01) return `thời lượng lệch ${((abs / src.duration) * 100).toFixed(2)}% so với nguồn`;
  const want = src.audio.length > 0 ? 1 : 0;
  if (p.audio.length !== want) return `số luồng âm thanh ${p.audio.length}, cần ${want}`;
  return null;
}
