import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault, openVault, parseVault, validPin, VaultError, readVault, writeVault, clearVault, recordBadPin, recordGoodPin, MAX_FAILS, VAULT_KEY } from '../docs/lib/vault.mjs';

const ITER = 100000; // đủ nhanh cho test; mặc định thật là 600.000
const fakeStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test('mã hoá rồi giải mã đúng; không lộ password trong dữ liệu lưu', async () => {
  const v = await createVault('123456', 'mat-khau-bi-mat', { iter: ITER });
  assert.deepEqual(Object.keys(v).sort(), ['ct', 'fails', 'iter', 'iv', 'salt', 'v']);
  assert.ok(!JSON.stringify(v).includes('mat-khau-bi-mat'));
  assert.equal(await openVault(v, '123456'), 'mat-khau-bi-mat');
  const v2 = await createVault('123456', 'mat-khau-bi-mat', { iter: ITER });
  assert.notEqual(v.salt, v2.salt); assert.notEqual(v.ct, v2.ct); // salt/IV ngẫu nhiên
});
test('iter mặc định ≥ 600.000', async () => {
  const v = await createVault('1234', 'x');
  assert.ok(v.iter >= 600000);
});
test('sai PIN thất bại', async () => {
  const v = await createVault('1234', 'pw', { iter: ITER });
  for (const bad of ['1235', '0000', '', 'abcd', '12345']) await assert.rejects(openVault(v, bad), (e) => e instanceof VaultError && e.code === 'bad_pin');
});
test('định dạng PIN', async () => {
  assert.ok(validPin('1234') && validPin('123456'));
  for (const p of ['123', '1234567', '12a4', '', ' 1234', null]) assert.equal(validPin(p), false);
  await assert.rejects(createVault('12', 'pw', { iter: ITER }), (e) => e.code === 'bad_pin_format');
});
test('dữ liệu hỏng hoặc bị sửa', async () => {
  const v = await createVault('1234', 'pw', { iter: ITER });
  const flip = { ...v, ct: v.ct.slice(0, -4) + (v.ct.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA') };
  await assert.rejects(openVault(flip, '1234'), (e) => e instanceof VaultError);
  for (const bad of [null, {}, { ...v, iter: 5 }, { ...v, iter: 1e9 }, { ...v, salt: 'xx' }, { ...v, iv: '!!!' }, { ...v, v: 2 }, { ...v, fails: -1 }]) {
    assert.equal(parseVault(JSON.stringify(bad)), null);
    await assert.rejects(openVault(bad, '1234'), (e) => e.code === 'corrupt');
  }
  assert.equal(parseVault('khong json'), null);
});
test('đếm sai PIN: 5 lần thì xoá két; đúng thì đặt lại', async () => {
  const st = fakeStorage();
  const v = await createVault('1234', 'pw', { iter: ITER });
  writeVault(st, v);
  let cur = readVault(st);
  for (let i = 1; i < MAX_FAILS; i++) { const r = recordBadPin(st, cur); assert.deepEqual([r.fails, r.wiped], [i, false]); cur = readVault(st); assert.equal(cur.fails, i); }
  recordGoodPin(st, cur);
  assert.equal(readVault(st).fails, 0);
  cur = readVault(st);
  let last;
  for (let i = 0; i < MAX_FAILS; i++) { last = recordBadPin(st, cur); cur = readVault(st) || cur; }
  assert.equal(last.wiped, true);
  assert.equal(st.m.has(VAULT_KEY), false);
  assert.equal(readVault(st), null);
  st.setItem(VAULT_KEY, '{hong'); assert.equal(readVault(st), null);
  clearVault(st);
});
