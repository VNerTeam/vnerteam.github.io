// Két mã hoá password bằng PIN (phía trình duyệt). Dùng Web Crypto nên chạy được cả trên trình duyệt và Node (để test).
// PBKDF2-SHA256 (≥ 600.000 vòng, salt 16 byte) → AES-GCM (IV 12 byte). Đây là khoá trên máy, KHÔNG thay password của Worker.
export const VAULT_KEY = 'vc_vault';
export const LEGACY_KEY = 'vc_password'; // khoá cũ lưu password dạng thô, bị xoá sau khi chuyển sang két
export const ITERATIONS = 600000;
export const MIN_ITER = 100000; // chặn dữ liệu bị sửa để gây treo máy (iter quá lớn) hoặc làm yếu khoá (iter quá nhỏ)
export const MAX_ITER = 5000000;
export const MAX_FAILS = 5;
export const PIN_RE = /^\d{4,6}$/;
const AAD = new TextEncoder().encode('vc_vault:1');

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'bad_pin' | 'corrupt' | 'bad_pin_format'
  }
}

const b64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new VaultError('corrupt', 'Dữ liệu két bị hỏng.');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const subtle = () => globalThis.crypto.subtle;

async function deriveKey(pin, salt, iter) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export const validPin = (pin) => typeof pin === 'string' && PIN_RE.test(pin);

// Kiểm tra hình dạng két đọc từ localStorage (dữ liệu không đáng tin). Trả về két sạch hoặc null.
export function parseVault(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || v.v !== 1) return null;
  if (!Number.isInteger(v.iter) || v.iter < MIN_ITER || v.iter > MAX_ITER) return null;
  if (!Number.isInteger(v.fails) || v.fails < 0 || v.fails > 1000) return null;
  try {
    if (unb64(v.salt).length !== 16 || unb64(v.iv).length !== 12 || unb64(v.ct).length < 17) return null;
  } catch {
    return null;
  }
  return { v: 1, iter: v.iter, salt: v.salt, iv: v.iv, ct: v.ct, fails: v.fails };
}

export async function createVault(pin, secret, { iter = ITERATIONS } = {}) {
  if (!validPin(pin)) throw new VaultError('bad_pin_format', 'PIN phải gồm 4–6 chữ số.');
  if (typeof secret !== 'string' || !secret) throw new VaultError('corrupt', 'Không có password để lưu.');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt, iter);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(secret)));
  return { v: 1, iter, salt: b64(salt), iv: b64(iv), ct: b64(ct), fails: 0 };
}

// Giải mã. Sai PIN (hoặc dữ liệu bị sửa) → VaultError('bad_pin'); cấu trúc hỏng → VaultError('corrupt').
export async function openVault(vault, pin) {
  const clean = parseVault(JSON.stringify(vault));
  if (!clean) throw new VaultError('corrupt', 'Dữ liệu két bị hỏng.');
  if (!validPin(pin)) throw new VaultError('bad_pin', 'PIN không đúng.');
  try {
    const key = await deriveKey(pin, unb64(clean.salt), clean.iter);
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(clean.iv), additionalData: AAD }, key, unb64(clean.ct));
    return new TextDecoder().decode(pt);
  } catch {
    throw new VaultError('bad_pin', 'PIN không đúng.');
  }
}

// ---- lưu trữ (truyền vào localStorage hoặc đối tượng giả khi test) ----
export function readVault(storage) {
  let raw = null;
  try {
    raw = storage.getItem(VAULT_KEY);
  } catch { /* storage không dùng được */ }
  return raw ? parseVault(raw) : null;
}
export function writeVault(storage, vault) {
  storage.setItem(VAULT_KEY, JSON.stringify(vault));
}
export function clearVault(storage) {
  try {
    storage.removeItem(VAULT_KEY);
  } catch { /* bỏ qua */ }
}
// Ghi nhận 1 lần nhập sai PIN. Trả về số lần sai; đủ MAX_FAILS thì xoá két (cần nhập lại password).
export function recordBadPin(storage, vault) {
  const fails = vault.fails + 1;
  if (fails >= MAX_FAILS) {
    clearVault(storage);
    return { fails, wiped: true };
  }
  writeVault(storage, { ...vault, fails });
  return { fails, wiped: false };
}
// Nhập đúng PIN: đặt lại bộ đếm sai.
export function recordGoodPin(storage, vault) {
  if (vault.fails) writeVault(storage, { ...vault, fails: 0 });
}
