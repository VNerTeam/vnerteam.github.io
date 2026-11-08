// Đọc kết quả `ab-av1 crf-search` (dạng chữ). Tách riêng để test được, không có tác dụng phụ.
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const UNIT = { B: 1, KiB: 1024, MiB, GiB, TiB: 1024 ** 4, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
const TIME_UNIT = { s: 1, sec: 1, second: 1, m: 60, min: 60, minute: 60, h: 3600, hr: 3600, hour: 3600, d: 86400, day: 86400 };

// "taking 1 hour 5 minutes" → giây
export function parseTaking(s) {
  let t = 0;
  let any = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|s|m|h|d)\b/gi)) {
    const u = m[2].toLowerCase();
    const k = u.length > 1 ? u.replace(/s$/, '') : u;
    if (TIME_UNIT[k]) {
      t += Number(m[1]) * TIME_UNIT[k];
      any = true;
    }
  }
  return any ? t : null;
}

// Chọn CRF lớn nhất vẫn đạt VMAF mục tiêu (file nhỏ nhất). null nếu không có dòng nào đạt.
export function parseCrfSearch(text, minVmaf) {
  const re = /crf\s+(\d+(?:\.\d+)?)\s+VMAF\s+(\d+(?:\.\d+)?)\s+predicted\s+(?:video\s+stream\s+|encoded\s+)?size\s+(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)\b[^\n]*?\(\s*(\d+(?:\.\d+)?)%\s*\)\s*taking\s+([^\n]+)/gi;
  const all = [...text.matchAll(re)].map((m) => ({ crf: Number(m[1]), vmaf: Number(m[2]), bytes: Number(m[3]) * (UNIT[m[4]] || 1), pct: Number(m[5]), seconds: parseTaking(m[6]) }));
  const ok = all.filter((x) => x.vmaf >= minVmaf - 0.001);
  return ok.length ? ok.reduce((a, b) => (b.crf > a.crf ? b : a)) : null;
}
export { GiB };
