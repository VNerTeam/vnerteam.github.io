# Cloudflare Worker – cổng ghi duy nhất

Trang web không giữ token GitHub. Mọi thao tác ghi đi qua Worker này; PAT chỉ nằm trong secret của Worker.

## Triển khai

```bash
cd worker
npm install -g wrangler          # hoặc: npx wrangler ...
wrangler login
wrangler kv namespace create RATE   # chép id vào wrangler.toml
# sửa wrangler.toml: GH_OWNER, GH_REPO, GH_BRANCH, ALLOWED_ORIGIN (https://<tên>.github.io, không có đường dẫn)
node scripts/hash-password.mjs --generate     # sinh password ngẫu nhiên + SALT + HASH
wrangler secret put PASSWORD_SALT
wrangler secret put PASSWORD_HASH
wrangler secret put GITHUB_PAT
wrangler deploy
```
Điền địa chỉ Worker vào `docs/config.js`. (`wrangler.toml` vẫn được hỗ trợ; nếu bạn dùng `wrangler.jsonc`, chuyển các khoá tương ứng.) Worker import `docs/lib/*.mjs`, nên luôn chạy `wrangler deploy` từ thư mục `worker/` của repo đầy đủ.

## Password

- Dùng password **ngẫu nhiên, dài ≥ 20 ký tự** (trình tạo mật khẩu của trình duyệt, hoặc `--generate`). Không dùng password ngắn dễ nhớ.
- Worker chỉ lưu SHA-256(salt + password), so sánh theo thời gian hằng số. Vì password dài, ngẫu nhiên nên dùng băm nhanh là đủ (KDF chậm sẽ vướng giới hạn CPU của gói free).
- Đổi password: chạy lại `hash-password.mjs`, đặt lại hai secret, đăng nhập lại trên trang.
- Chống dò: từ 5 lần sai trong 15 phút theo IP → HTTP 429 kèm `Retry-After`. KV chỉ được ghi khi nhập sai. Nên thêm rate limiting rule của Cloudflare cho `/api/*` nếu gói của bạn cho phép.

## PAT

Fine-grained PAT, **chỉ cấp cho đúng repo này**: Contents *Read and write*, Actions *Read and write*, Metadata *Read*. PAT có hạn dùng: khi GitHub trả 401/403 Worker báo "PAT hết hạn hoặc thiếu quyền". Đổi PAT: `wrangler secret put GITHUB_PAT`.

## API

Mọi `/api/*` cần `Authorization: Bearer <password>` và `Origin` đúng `ALLOWED_ORIGIN`.

| Phương thức | Đường dẫn | Việc |
|---|---|---|
| POST | `/api/queue/add` | `{ items: [{ url, options, label? }] }`, tối đa 50 mục; Worker tự parse `url`, bỏ qua mọi `provider/ref` client gửi; một commit |
| GET | `/api/queue` | `queue.json` + số mục theo trạng thái |
| PATCH | `/api/queue/item/:id` | Sửa `options`/`label` |
| DELETE | `/api/queue/item/:id` | Xóa mục |
| POST | `/api/queue/retry/:id` | `failed` → `pending` |
| POST | `/api/run` | `workflow_dispatch` (`mode`, `only_id`) |
| GET | `/api/status` | Các lần chạy gần nhất + release video (cache ~30 giây) |
| GET | `/api/config` | `allowed_hosts` đọc từ repo |

Giới hạn: body ≤ 64 KB, ≤ 200 mục trong queue, `queue.json` ≤ 1 MB. Xung đột sha khi ghi được đọc lại và áp lại tối đa 5 lần.

## Kiểm thử

```bash
node --test "worker/test/*.test.mjs"
```
