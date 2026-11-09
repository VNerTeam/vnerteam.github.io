// Chạy cục bộ: node scripts/hash-password.mjs [--generate]
// Sinh PASSWORD_SALT + PASSWORD_HASH (SHA-256 của salt + password). Không gửi đi đâu cả.
import crypto from 'node:crypto';
import readline from 'node:readline/promises';

let password;
if (process.argv.includes('--generate')) {
  password = crypto.randomBytes(24).toString('base64url'); // 32 ký tự ngẫu nhiên
  console.log(`Password mới (hãy lưu vào trình quản lý mật khẩu, chỉ hiện một lần):\n${password}\n`);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Nhập password (≥ 20 ký tự, ngẫu nhiên): ');
  rl.close();
}
if (password.length < 20) {
  console.error('Password quá ngắn (cần ≥ 20 ký tự). Hãy dùng --generate.');
  process.exit(1);
}
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.createHash('sha256').update(salt + password).digest('hex');
console.log(`Chạy lần lượt (dán giá trị khi được hỏi):\n  wrangler secret put PASSWORD_SALT   # ${salt}\n  wrangler secret put PASSWORD_HASH   # ${hash}`);
