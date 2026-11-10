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

## PIN dự phòng

PIN (4–12 chữ số) lưu trong KV `RATE` khoá `auth:pin` dưới dạng `SHA-256` có salt (không lưu PIN thô), nên dùng được từ mọi thiết bị. Đặt/đổi/xoá qua trang (đăng nhập bằng password) hoặc API: `POST /api/auth/pin {"pin":"123456"}`, `DELETE /api/auth/pin`; đăng nhập bằng PIN nhận `403 password_required`. `GET /api/auth` → `{ kind: "password"|"pin", pin_set }`. Chống dò: 5 lần sai/15 phút theo IP, cộng trần chung 20 lần sai/giờ cho PIN (khoá `fail:pin-global`); password không bị ảnh hưởng. Muốn tắt hẳn PIN: xoá trên trang, hoặc xoá khoá `auth:pin` trong KV.

## PAT

Fine-grained PAT, **chỉ cấp cho đúng repo này**: Contents *Read and write*, Actions *Read and write*, Metadata *Read*. PAT có hạn dùng: khi GitHub trả 401/403 Worker báo "PAT hết hạn hoặc thiếu quyền". Đổi PAT: `wrangler secret put GITHUB_PAT`.

## API

Mọi `/api/*` cần `Origin` đúng `ALLOWED_ORIGIN` và một trong hai: `Authorization: Bearer <password>` hoặc `Authorization: Pin <mã PIN>` (PIN dự phòng, xem dưới).

| Phương thức | Đường dẫn | Việc |
|---|---|---|
| POST | `/api/queue/add` | `{ items: [{ url, options, label?, referer?, link_match? }] }` (`link_match` chỉ có tác dụng với link trang có nút tải, nếu không sẽ bị bỏ; `referer` = "Trang mở trước", https, không phải host nội bộ), tối đa 50 mục; Worker tự parse `url`, bỏ qua mọi `provider/ref` client gửi; một commit |
| GET | `/api/queue` | `queue.json` + số mục theo trạng thái |
| PATCH | `/api/queue/item/:id` | Sửa `options`/`label`/`referer`/`link_match` của một mục |
| PATCH | `/api/queue/batch` | `{ changes: [{ id, options?, label?, referer?, link_match? }] }`, tối đa 200 mục, áp trong **một lần ghi (một commit)**; mục sai/không tồn tại được báo riêng trong `results`, các mục còn lại vẫn áp. Trả `{ results, updated, counts }` |
| DELETE | `/api/queue/item/:id` | Xóa mục |
| POST | `/api/queue/retry/:id` | `failed` → `pending` |
| POST | `/api/run` | `workflow_dispatch` (`mode`, `only_id`) |
| GET | `/api/status` | Các lần chạy gần nhất + `days` (khoảng 14 ngày gần nhất, mỗi video có link bản thường/bản điện thoại) đọc từ `catalog.json` của release `muc-luc`, kèm `catalog_url` (cache ~30 giây). Nếu chưa có hoặc hỏng catalog thì tạm liệt kê các release `vid-` (nhận cả tag ngày lẫn tag cũ), `source` là `releases` |
| GET | `/api/auth` | Cách đăng nhập hiện tại và đã đặt PIN chưa |
| POST / DELETE | `/api/auth/pin` | Đặt / xoá PIN dự phòng (chỉ khi đăng nhập bằng password) |
| GET | `/api/config` | `allowed_hosts` đọc từ repo (kèm `link_class` nếu có) |

`/api/queue/batch` chỉ ghi `queue.json`, **không** kích hoạt workflow; chỉ `POST /api/run` (nút "Chạy ngay") mới chạy.

Biến `TIMEZONE` trong `wrangler.toml` (mặc định `Asia/Ho_Chi_Minh`) chỉ dùng để hiển thị giờ khi phải dựng danh sách từ release; nên trùng `config/settings.json`.

Giới hạn: body ≤ 64 KB, ≤ 200 mục trong queue, `queue.json` ≤ 1 MB. Xung đột sha khi ghi được đọc lại và áp lại tối đa 5 lần.

## Cập nhật Worker

Worker import `docs/lib/*.mjs`. Mỗi khi đổi mã trong `worker/` hoặc `docs/lib/`, chạy lại `wrangler deploy` trong `worker/`.

## Kiểm thử

```bash
node --test "worker/test/*.test.mjs"
```
