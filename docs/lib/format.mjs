// Định dạng số liệu dùng chung (không phụ thuộc Node/trình duyệt).
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
