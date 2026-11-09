# Bộ công cụ nén video cá nhân (GitHub Actions + Cloudflare Worker)

Bộ công cụ xử lý media mã nguồn mở **dùng cá nhân của chủ repo**. Không phải dịch vụ cho người khác.

Luồng: dán link vào trang web (GitHub Pages) → trang nhận diện storage → chọn tuỳ chọn → "Lưu vào hàng đợi" → **Cloudflare Worker** (xác thực password) ghi `queue.json` → GitHub Actions nén bằng **ab-av1** (tìm CRF nhỏ nhất đạt VMAF mục tiêu) trên ffmpeg tĩnh → up lên **GitHub Release** → xác nhận file đã lên → mới xóa mục khỏi hàng đợi.

## Cảnh báo quan trọng (đọc trước khi dùng)

- **Điều khoản GitHub.** Với runner do GitHub cung cấp, Actions không được dùng cho việc không liên quan tới sản xuất/kiểm thử/triển khai/xuất bản phần mềm của chính repo, không dùng như CDN hay serverless, và không gây tải quá mức. Một dịch vụ nén video có thể bị coi là vi phạm và bị hạn chế. Các biện pháp trong repo (hạn mức thấp, chỉ chủ repo dùng được, `runner_label` đổi được sang self-hosted) chỉ **giảm** rủi ro, **không loại bỏ**: điều khoản nói về bản chất công việc, không chỉ về ai bấm nút. Muốn an toàn hơn, chuyển sang self-hosted runner (mục dưới).
- **Riêng tư.** Repo public: log Actions, lịch sử git, release đều công khai. Link đã xóa khỏi `queue.json` **vẫn còn trong lịch sử commit vĩnh viễn**. Chỉ dùng link bạn chấp nhận để lộ (ví dụ link "bất kỳ ai có link").
- **Bản quyền.** Chỉ xử lý video bạn có quyền xử lý và phân phối, vì release là công khai.

## Dùng cá nhân

- Không thêm collaborator nào. Người ngoài xem được repo/trang/release nhưng không thêm hay kích hoạt được gì.
- Bật Settings → Actions → General → **Require approval for all outside collaborators**.
- Workflow không chạy theo `pull_request`, `pull_request_target`, `issues`, `fork`. Job `plan` chỉ chạy khi `github.actor` là chủ repo hoặc `github-actions[bot]` (vòng tự gọi lại). **Repo thuộc tổ chức**: `github.repository_owner` là tên tổ chức nên điều kiện `if` ở job `plan` sẽ chặn; hãy thay bằng tên tài khoản của bạn.
- Nhánh mặc định không phải `main`: sửa `branches: [main]` trong `.github/workflows/compress.yml` và `GH_BRANCH` của Worker.

## Cài đặt

1. Tạo repo **public**, đẩy toàn bộ thư mục này lên nhánh mặc định.
2. Settings → Pages → nguồn: nhánh mặc định, thư mục `/docs`.
3. Settings → Actions → General → Workflow permissions: **Read and write permissions**.
4. Tạo **fine-grained PAT** chỉ cho repo này: Contents *Read and write*, Actions *Read and write*, Metadata *Read*.
5. Triển khai Worker theo `worker/README.md`, rồi điền địa chỉ Worker vào `docs/config.js`.
6. Nếu Worker dùng tên miền riêng, sửa `connect-src` trong thẻ CSP của `docs/index.html` thành đúng địa chỉ Worker.
7. Mở trang Pages, nhập password, dán thử một link nhỏ, bấm "Lưu vào hàng đợi".
8. Chạy thử không nén: Actions → "Nén video theo hàng đợi" → Run workflow → `mode = dry_run`.

Kiểm thử: `node --test "tests/*.test.mjs" "worker/test/*.test.mjs"` (Node ≥ 20, không cần `npm install`).

## Storage được hỗ trợ

| Provider | Nhóm | Ghi chú |
|---|---|---|
| GitHub Release | Ổn định | Link `…/releases/download/<tag>/<file>` |
| GitHub (file trong repo) | Ổn định | Nhánh 1 đoạn hoặc SHA 40 ký tự; file LFS bị từ chối rõ ràng |
| Google Drive | Ổn định | Cần "bất kỳ ai có link"; dùng `gdown`; lỗi quota → `drive_quota` |
| Dropbox | Ổn định | Link `/scl/fi/…?rlkey=…` hoặc `/s/…` |
| pCloud | Ổn định | Link `publink/show?code=…` (thử cả hai vùng US/EU) |
| Hugging Face | Ổn định | Repo public |
| Internet Archive | Ổn định | `archive.org/download/<id>/<file>` |
| Link trực tiếp | Ổn định | Chỉ host trong `config/allowed-hosts.json` |
| Trang video (yt-dlp) | **Thử nghiệm** | Trang không có link tải thẳng; chỉ host bật `"ytdlp": true` trong `config/allowed-hosts.json` |
| OneDrive cá nhân | **Thử nghiệm** | Thử 3 cách, có thể thất bại → `onedrive_unsupported` |

Từ chối ngay: không phải https, có `user:pass@`, host là IP, cổng lạ, thư mục/trang xem, `ref` chứa `..`. Hệ thống **chỉ lưu `ref`, không lưu URL gốc**.

### Thêm một storage mới
1. `docs/lib/providers.mjs`: thêm vào `PROVIDERS`, thêm 1 matcher vào `MATCHERS`, 1 hàm kiểm tra vào `CHECKS`.
2. `scripts/resolvers.mjs`: thêm entry vào `RESOLVERS` (và khoá bí mật vào `SECRET_KEYS` nếu có).
3. Thêm ≥ 3 link hợp lệ và ≥ 3 link bị từ chối vào `tests/providers.test.mjs`.

### yt-dlp (trang không có link tải thẳng)

Bật cho từng trang trong `config/allowed-hosts.json` bằng cờ `"ytdlp": true`:
```json
{ "hosts": [ { "host": "www.example-video.com", "allow_query": true, "ytdlp": true } ] }
```
- Chỉ các host trong danh sách mới được gửi cho yt-dlp (chống lạm dụng/SSRF). `allow_query` thường cần `true` vì nhiều trang dùng `?v=...`; phần `?...` sẽ được lưu công khai trong `queue.json`.
- yt-dlp được ghim phiên bản trong `config/tools.json` (`yt_dlp`, bản dựng sẵn `yt-dlp_linux`), tải từ nguồn gốc và cache giống ffmpeg.
- **Tự cập nhật khi lỗi:** nếu tải lỗi (`download_failed`, `ytdlp_unsupported`, `access_denied`), job tải yt-dlp bản **mới nhất** rồi tải lại đúng một lần và ghi cảnh báo để bạn cập nhật `yt_dlp.tag`. Nếu bản mới nhất trùng bản đang dùng thì không thử lại vô ích. Đặt `"ytdlp_update_channel": "nightly"` trong `config/settings.json` để lấy bản nightly (sửa lỗi trang web sớm hơn).
- Với YouTube, yt-dlp cần runtime JavaScript; workflow dùng Node có sẵn trên runner (`--js-runtimes node`).
- Không tải playlist (`--no-playlist`), không dùng cookie, không vượt DRM. Video có DRM báo `drm_protected`.
- **Lưu ý pháp lý:** tải từ trang web có thể vi phạm điều khoản của trang đó, và việc đăng lên release công khai làm rủi ro về bản quyền cao hơn. Chỉ dùng cho video bạn có quyền tải và phân phối. Tên file/tiêu đề release lấy từ tiêu đề video nếu bạn không đặt tên hiển thị, nên hãy đặt tên riêng nếu tiêu đề gốc không nên công khai.

### allowed-hosts.json
```json
{ "hosts": [ { "host": "cdn.example.com", "allow_query": false }, { "host": "*.r2.dev", "allow_query": false } ] }
```
`*.suffix` chỉ khớp tên miền con. Worker đọc file này từ repo (cache 60 giây), không cần triển khai lại.

## Tuỳ chỉnh

- `config/settings.json`: `max_parallel` (mặc định 2, tối đa 20), `max_items_per_run`, `max_items_per_day`, `time_budget_min` (240–300), `reserve_min`, `max_input_gb`, `min_vmaf_floor`, `free_disk_space`, `timezone`, `max_attempts`, `max_chain`, `runner_label`.
- `config/profiles.json`: chiều cao từng mức độ phân giải, VMAF + preset từng mức chất lượng, ladder tốc độ, bitrate âm thanh. Tên khoá phải khớp menu trong `docs/lib/schema.mjs` (có test kiểm tra).
- `config/tools.json`: ghim phiên bản ffmpeg (BtbN), ab-av1, gdown; có trường `sha256` tuỳ chọn (điền kết quả `sha256sum` để kiểm tra toàn vẹn).

### Cập nhật ffmpeg đã ghim
BtbN giữ bản cuối mỗi tháng trong 2 năm và 14 bản daily gần nhất. Chọn bản cuối tháng của nhánh phát hành ổn định bằng `gh release list --repo BtbN/FFmpeg-Builds`, rồi sửa `tag` và `asset` trong `config/tools.json`. Nếu tag bị xóa, workflow cảnh báo rõ và dùng tag `latest` của cùng nhánh.

### Đổi sang self-hosted runner
Đặt `"runner_label": "self-hosted"` (hoặc một mảng nhãn). Chỉ dùng trigger `push` (nhánh mặc định) và `workflow_dispatch`; **không bao giờ** thêm `pull_request`. Bật "Require approval for all outside collaborators". Máy cần có `gh`, `curl`, `node` ≥ 20, `python3/pip`, `tar`, `zstd`; ổ đĩa tồn tại lâu nên script tự dọn `item-*` cũ khi bắt đầu job.

## Bảng lỗi (`last_error`)

| Mã | Ý nghĩa | Cách xử lý |
|---|---|---|
| `drive_quota` | Drive giới hạn lượt tải | Thử lại sau vài giờ |
| `drive_private` | File chưa chia sẻ công khai | Chia sẻ "bất kỳ ai có link" |
| `not_direct_video`, `not_a_video` | Link không phải file video | Kiểm tra link |
| `lfs_pointer` | Con trỏ Git LFS | Dùng link release |
| `not_found`, `access_denied`, `rate_limited` | Lỗi từ nguồn | Kiểm tra link/quyền, thử lại sau |
| `ytdlp_unsupported`, `drm_protected` | yt-dlp không hỗ trợ trang, hoặc video có DRM | Thử `ytdlp_update_channel: nightly`; DRM thì không tải được |
| `input_too_big`, `no_disk` | Vượt `max_input_gb` hoặc hết đĩa | Tăng giới hạn, bật `free_disk_space`, hoặc self-hosted |
| `too_long` | Hết ladder tốc độ vẫn vượt ngân sách | Dùng self-hosted hoặc chia nhỏ video |
| `timeout` | Hết thời gian | Bấm "Thử lại" (lần sau bắt đầu ở nấc nhanh hơn) |
| `crf_not_found` | Không đạt VMAF yêu cầu | Hạ `min_vmaf` |
| `crf_search_failed`, `encode_failed` | Lỗi ab-av1/ffmpeg | Xem log; so với `ab-av1 … --help` đã lưu |
| `verify_failed` | Kết quả lệch thời lượng/luồng | Xem log |
| `no_gain` | Nén xong không nhỏ hơn gốc | Không đăng; bỏ mục hoặc đổi tuỳ chọn |
| `too_big` | Vẫn ≥ 2 GiB sau khi hạ VMAF tới sàn | Hạ độ phân giải |
| `upload_failed`, `release_failed` | Release không xác nhận được | Thử lại |
| `onedrive_unsupported`, `pcloud_*`, `link_deleted`, `link_expired` | Link storage hỏng/hết hạn | Tạo link mới |
| `no_result`, `cancelled` | Job bị dừng giữa chừng | Mục giữ nguyên, tự chạy lại tới `max_attempts` |
| `invalid_schema…` | Mục sai định dạng | Xóa và thêm lại |

Mục `failed` **không tự chạy lại**; bấm "Thử lại" trên trang hoặc chạy `mode=retry_failed`.

## Giả định và khác biệt so với đặc tả (ghi theo thông tin đã xác minh)

- **ab-av1 v0.11.2**, asset `ab-av1-v0.11.2-x86_64-unknown-linux-musl.tar.zst`. **ffmpeg** BtbN `autobuild-2026-10-31-12-59`, nhánh 8.1. **gdown 5.2.0**. Action: `checkout@v7`, `cache@v6`, `upload-artifact@v7`, `download-artifact@v8`.
- **Chưa kiểm chứng được trên runner thật** (bạn nên chạy thử một video ngắn đầu tiên): ffmpeg BtbN có `libvmaf` hay không (script tự kiểm tra và chuyển sang ffmpeg của Ubuntu nếu thiếu); định dạng chữ cụ thể của `ab-av1 crf-search` (`parse.mjs` đọc dòng "crf N VMAF X predicted video stream size … taking …" và có test; nếu phiên bản đổi định dạng thì job báo `crf_search_failed`, `--help` được lưu để đối chiếu); cách `--vfilter` áp dụng cho bước VMAF khi có scale (README ab-av1 mô tả `--vfilter` áp dụng lên đầu vào trước khi nén).
- **Bước nén cuối dùng ffmpeg trực tiếp** với CRF do ab-av1 tìm ra (cùng preset, vfilter, pix_fmt), thay vì `ab-av1 encode`, để kiểm soát đầy đủ ánh xạ luồng (mọi audio/phụ đề/phông/chương), âm thanh theo từng luồng và thẻ màu HDR.
- Menu trên trang dựng từ `schema.mjs` (không đọc `profiles.json` vì GitHub Pages chỉ phục vụ `/docs`); `profiles.json` giữ các giá trị số.
- Trang nhận danh sách `allowed_hosts` qua `GET /api/config` của Worker.
- Mục `timeout`/lỗi thông thường chuyển sang `failed`; chỉ `no_result` và `cancelled` giữ `pending` (tăng `attempts`, thành `failed` khi chạm `max_attempts`).
- `id` và `added_at` dùng giờ UTC; tag release và ngày trong tiêu đề dùng `settings.timezone`.
- Release được tạo ở dạng **draft**, upload và xác nhận xong mới công khai (không có release dở dang); nếu có `digest` SHA256 trên API thì đối chiếu thêm.
- Vòng tự gọi lại bị chặn bởi hạn mức ngày và `max_chain` (mặc định 30).
- Đầu ra video luôn là 10-bit 4:2:0 (nguồn 4:2:2/4:4:4 bị đổi về 4:2:0, có ghi chú trong release); chỉ lấy luồng video chính đầu tiên.
- Giai đoạn 2 (chưa làm, đã chừa chỗ): chia video thành đoạn nén song song, hàng đợi riêng tư bằng repository variable (`QUEUE_BACKEND`), MEGA/Wistia (yt-dlp có thể xử lý HLS/streaming ở những trang bạn bật), thông báo khi xong.
