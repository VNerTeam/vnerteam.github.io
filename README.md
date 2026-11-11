# Bộ công cụ nén video cá nhân (GitHub Actions + Cloudflare Worker)

Bộ công cụ xử lý media mã nguồn mở **dùng cá nhân của chủ repo**. Không phải dịch vụ cho người khác.

Luồng: dán link vào trang web (GitHub Pages) → trang nhận diện storage → chọn tuỳ chọn → "Lưu vào hàng đợi" (**chỉ lưu, chưa chạy**) → **Cloudflare Worker** (xác thực password) ghi `queue.json` → bấm **"Chạy ngay"** → GitHub Actions nén bằng **ab-av1** (tìm CRF nhỏ nhất đạt VMAF mục tiêu) trên ffmpeg tĩnh → (tuỳ chọn) làm thêm bản **H.264 cho điện thoại** → up lên **GitHub Release theo ngày** → xác nhận từng file đã lên → mới xóa mục khỏi hàng đợi và cập nhật **release mục lục**.

## Khi nào workflow chạy

Workflow `compress.yml` **không có trigger `push`**. Lưu hoặc sửa hàng đợi (Worker ghi `queue.json`) **không** làm workflow tự chạy. Nó chỉ chạy khi:

1. bấm **"Chạy ngay"** trên trang (Worker gọi `workflow_dispatch`), hoặc
2. bấm **Run workflow** trong tab Actions, hoặc
3. job `finalize` tự gọi lại chính nó để làm tiếp phần còn lại của hàng đợi (có giới hạn `max_chain` và hạn mức ngày).

Nếu đang có lần chạy `queued`/`in_progress`, trang sẽ hỏi lại trước khi gửi lệnh (workflow có `concurrency` nên các lần chạy không bao giờ chồng nhau).

## Cảnh báo quan trọng (đọc trước khi dùng)

- **Điều khoản GitHub.** Với runner do GitHub cung cấp, Actions không được dùng cho việc không liên quan tới sản xuất/kiểm thử/triển khai/xuất bản phần mềm của chính repo, không dùng như CDN hay serverless, và không gây tải quá mức. Một dịch vụ nén video có thể bị coi là vi phạm và bị hạn chế. Các biện pháp trong repo (hạn mức thấp, chỉ chủ repo dùng được, `runner_label` đổi được sang self-hosted) chỉ **giảm** rủi ro, **không loại bỏ**: điều khoản nói về bản chất công việc, không chỉ về ai bấm nút. Muốn an toàn hơn, chuyển sang self-hosted runner (mục dưới).
- **Riêng tư.** Repo public: log Actions, lịch sử git, release đều công khai. Link đã xóa khỏi `queue.json` **vẫn còn trong lịch sử commit vĩnh viễn**. Chỉ dùng link bạn chấp nhận để lộ (ví dụ link "bất kỳ ai có link").
- **Bản quyền.** Chỉ xử lý video bạn có quyền xử lý và phân phối, vì release là công khai.

## Dùng cá nhân

- Không thêm collaborator nào. Người ngoài xem được repo/trang/release nhưng không thêm hay kích hoạt được gì.
- Bật Settings → Actions → General → **Require approval for all outside collaborators**.
- Workflow không chạy theo `pull_request`, `pull_request_target`, `issues`, `fork`. Job `plan` chỉ chạy với `workflow_dispatch` khi `github.actor` là chủ repo (PAT của Worker, hoặc bấm tay) hoặc `github-actions[bot]` (vòng tự gọi lại). **Repo thuộc tổ chức**: `github.repository_owner` là tên tổ chức nên điều kiện `if` ở job `plan` sẽ chặn; hãy thay bằng tên tài khoản của bạn.
- Nhánh mặc định không phải `main`: sửa `GH_BRANCH` của Worker (và `branches: [main]` trong `pages.yml`). `compress.yml` không còn phụ thuộc tên nhánh: job `plan` chỉ chạy trên nhánh mặc định.

## Cài đặt

1. Tạo repo **public**, đẩy toàn bộ thư mục này lên nhánh mặc định.
2. Settings → Pages → nguồn: nhánh mặc định, thư mục `/docs`.
3. Settings → Actions → General → Workflow permissions: **Read and write permissions**.
4. Tạo **fine-grained PAT** chỉ cho repo này: Contents *Read and write*, Actions *Read and write*, Metadata *Read*.
5. Triển khai Worker theo `worker/README.md`, rồi điền địa chỉ Worker vào `docs/config.js`.
6. Nếu Worker dùng tên miền riêng, sửa `connect-src` trong thẻ CSP của `docs/index.html` thành đúng địa chỉ Worker.
7. Mở trang Pages, nhập password (tick "Ghi nhớ" để lần sau tự vào; có thể đặt PIN dự phòng trong mục "PIN dự phòng"), dán thử một link nhỏ, bấm "Lưu vào hàng đợi", sau đó bấm **"Chạy ngay"**.
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

### Tải bằng trình duyệt thật (3 mức, tự leo thang)

Một số web chỉ cho trình duyệt thật tải. Mỗi link có tuỳ chọn **"Cách tải"** và ô **"Trang mở trước"** (không bắt buộc):

1. **Mức 1 – `curl` có header giống trình duyệt** (Accept, Accept-Language, Referer, Sec-Fetch-*, User-Agent Chrome). Nhanh, tải tiếp được khi đứt. Nếu web trả trang HTML/JSON với mã 200 thì file bị xoá và coi là "bị chặn".
2. **Mức 2 – Chrome thật qua Playwright** (`scripts/browser-fetch.mjs`): mở "Trang mở trước" (nếu có) để lấy cookie/phiên, rồi mở link; thấy file thì bàn giao cho `curl` kèm cookie, thấy trang có video thì lấy luồng video. Link dùng một lần: để chính trình duyệt tải thẳng về đĩa. Luồng HLS/DASH giao cho `yt-dlp` kèm Referer/cookie.
3. **Mức 3 – `yt-dlp`** cho trang không có link tải thẳng (như trước).

"Cách tải": **Tự động** (mặc định: mức 1, bị chặn thì mức 2) / **Chỉ tải thường** (không bao giờ dùng trình duyệt) / **Luôn dùng trình duyệt**. Trường của mục tên `referer` (khoá `ref` đã dành cho tham chiếu của storage). Không có ô nhập cookie: cookie là bí mật mà `queue.json` lưu công khai trong repo. Kết quả ghi `fetch_method` (`curl`/`browser`/`ytdlp`/`gdown`), hiện ở cột "Cách tải" của mục lục, không ghi URL.

Cấu hình: `config/tools.json` → `playwright_core.version` (cài lười, chỉ khi một mục cần); `config/settings.json` → `browser_headed` (mặc định `true`, chạy Chrome có giao diện qua `xvfb`; thiếu xvfb thì cài, không được thì lùi về headless và cảnh báo) và `browser_phase_min` (mặc định 3 phút cho phần mở trang + bắt link). Dùng Chrome có sẵn trên runner (không có thì thử cài Chromium của Playwright). Chrome chạy với `--no-sandbox` trên GitHub Actions vì Ubuntu 24.04 hạn chế user namespace; runner dùng một lần và chỉ mở link `https` đã kiểm tra, từ chối tải về file chương trình (`.exe`, `.sh`, `.apk`, `.msi`…).

**Giới hạn thật:** web chặn theo **IP datacenter của GitHub runner** thì trình duyệt cũng không giúp được; không vượt được đăng nhập hay captcha; chế độ trình duyệt tốn thêm khoảng 1–2 phút; link token dùng một lần có thể hỏng nếu đã bị dùng ở bước dò; chỉ tải nội dung bạn có quyền tải. Phần trình duyệt chỉ được kiểm thử bằng Playwright giả; **chưa kiểm chứng trên runner thật**.

### Tên hiển thị = tên file gốc (workflow "Lấy tên gốc")

Ô "Tên hiển thị" **để trống** thì hệ thống tự lấy tên file gốc của chính link đó (không còn đoán từ tham số query nên không bị nhầm):

1. Bấm lưu link: Worker ghi mục với trạng thái **"Đang lấy tên"** (`naming`) rồi gọi workflow `names.yml` (`workflow_dispatch`, cùng PAT và quyền Actions như "Chạy ngay"; tên file ở biến `NAMES_WORKFLOW_FILE` trong `worker/wrangler.toml`).
2. `scripts/resolve-names.mjs` chạy trên runner (6 link song song, tối đa 60 giây/link), điền tên vào mục rồi chuyển sang `pending`. Làm ở workflow thay vì Worker để nhiều link không làm Worker quá tải.
3. Tên lấy theo thứ tự:
   1. **Chữ trong một thẻ trên trang** (cho link kiểu trang: "trang có nút tải" và `yt-dlp`), nếu host có cấu hình `title_class` (xem dưới).
   2. Không có/không lấy được thì dùng **tên file gốc** của link: tên trong `Content-Disposition` của phản hồi thật → đoạn cuối URL cuối cùng (phải có đuôi video) → đoạn cuối URL gốc → tham số `download_filename` (chỉ là phương án cuối). Google Drive lấy từ tiêu đề trang; link "trang có nút tải" lấy từ `href` khớp "Lọc link" (chỉ đọc trang, **không gọi** link tải nên token dùng một lần không bị tiêu).
   3. Vẫn không có thì để trống, lúc nén sẽ lấy tên từ file tải về.
4. **Tên hiển thị giữ nguyên dấu cách** (bỏ đuôi file, tối đa 80 ký tự). Tên file trên Release thì dấu cách và ký tự lạ tự đổi thành `-` (vd `Phim Hay Tập 1` → `Phim-Hay-Tap-1-a1b2c3-hevc.mkv`); phần thêm sau tên chỉ là hậu tố tuỳ chọn (`-hash6-codec`, `-phone`).
5. Bạn tự gõ tên thì dùng tên đó, không bị ghi đè. Lấy tên không được thì mục vẫn sang `pending` với tên trống, và lúc nén sẽ lấy tên từ file tải về (ưu tiên `Content-Disposition`/tên file của trình duyệt).

**Lấy tên từ thẻ + class** (`config/allowed-hosts.json`):

```json
{ "host": "phim.example", "allow_query": false, "link_class": "download-btn", "title_tag": "h1", "title_class": "title video" }
```

- Ví dụ trên lấy chữ trong `<h1 class="title video">Tên Phim</h1>` và chỉ lấy `Tên Phim` (bỏ thẻ con, `<script>`/`<style>`, giải mã `&amp;`…, gộp khoảng trắng; tên giữ nguyên, không bị cắt "đuôi file").
- `title_class` bắt buộc (một hoặc vài class, thẻ phải có đủ). `title_tag` tuỳ chọn: bỏ trống thì thẻ nào có class đó cũng được (vì có web không dùng `h1`). Cấu hình sai định dạng thì bị bỏ qua và quay về tên file gốc.
- Thẻ có class phải nằm trong HTML trả về lúc mở trang bình thường (không chạy JavaScript). Tên do JavaScript dựng ra thì chưa lấy được.
- Link file trực tiếp (`direct_url`) không dùng `title_class`.

**Ghi đè tên thủ công:** Actions → "Lấy tên gốc cho link mới" → Run workflow → bật `overwrite`. Khi bật, workflow lấy lại tên cho **tất cả** mục trong hàng đợi (kể cả mục đã có tên hiển thị hoặc do bạn tự gõ) và ghi đè nếu lấy được tên mới; mục nào lấy không được thì giữ nguyên tên cũ, trạng thái mục không đổi. Mặc định (tắt, và khi Worker tự gọi) thì không đụng tới tên đã có.

Log của workflow ghi rõ nguồn tên ("tiêu đề trên trang N, tên file gốc M, không lấy được K") và id các mục chưa lấy được tên để bạn dễ soi.

An toàn: mục `naming` quá 15 phút (workflow không chạy được) vẫn được nén, không kẹt mãi; Worker không gọi được workflow thì thả mục sang `pending` ngay và báo trên trang.

### allowed-hosts.json
```json
{ "hosts": [ { "host": "cdn.example.com", "allow_query": false }, { "host": "*.r2.dev", "allow_query": false } ] }
```
`*.suffix` chỉ khớp tên miền con. Worker đọc file này từ repo (cache 60 giây), không cần triển khai lại.

#### Trang có nút tải: `link_class` + "Lọc link"

Với web mà link tải nằm trong thẻ `<a>` (thường kèm token nên không dán thẳng được), thêm `link_class` cho host:

```json
{ "host": "phim.example", "allow_query": false, "link_class": "download-btn" }
```

- Dán **link trang** (không phải link file). Khi chạy, hệ thống mở trang, tìm thẻ `<a>` có class đó, lấy `href` **ngay lúc tải** (token còn mới) rồi tải kèm cookie và Referer của trang. Có thể ghi nhiều class cách nhau dấu cách (thẻ phải có đủ các class). `link_class` thắng `ytdlp` nếu host có cả hai; class sai định dạng thì bị bỏ qua và host chạy như thường.
- **Lọc link** (ô nhập riêng cho từng link kiểu này, cạnh "Trang mở trước"): khi nhiều thẻ `<a>` cùng class (vd 3 độ phân giải), gõ phần có trong link cần lấy, vd `2160p.mp4` hoặc `shenhe8_2160p`. So khớp theo chuỗi con, không phân biệt hoa thường. Bỏ trống thì lấy link đầu tiên; không link nào khớp thì báo `link_not_found`. (Đây là trường riêng của mục chứ không phải một lựa chọn trong menu "Tuỳ chọn", vì là chuỗi tự do.)
- Cách tải theo "Cách tải": **Chỉ tải thường** đọc HTML bằng `fetch` (không chạy JavaScript); **Tự động** thử vậy trước, không thấy thẻ hoặc bị chặn thì mở Chrome thật (đọc được cả nút do JavaScript dựng); **Luôn dùng trình duyệt** vào thẳng Chrome. Link token dùng một lần mà vẫn bị chặn thì trình duyệt tự mở lại trang và bấm link mới để tải thẳng về.
- Hạn chế: chỉ đọc thẻ `<a>` trong trang chính (và các khung con khi dùng trình duyệt), không bấm nút qua JavaScript; nút "tải" không phải thẻ `<a>`, đếm ngược chờ vài chục giây, hoặc captcha thì chưa xử lý được. Đổi/xoá `link_class` trong file này thì các mục đang chờ của host đó thành sai định dạng.

## Đầu ra: bản thường + bản điện thoại

Mỗi video cho tối đa **hai file** trong cùng một release:

| File | Tên | Nội dung |
|---|---|---|
| Bản thường | `{slug}-{hash6}-{codec}.{ext}` (vd `phim-a1b2c3-hevc.mkv`) | HEVC/AV1 10-bit theo tuỳ chọn, giữ HDR |
| Bản điện thoại | `{slug}-{hash6}-phone.mp4` | H.264 8-bit `yuv420p`, AAC stereo, `faststart`: có thumbnail và phát mượt trên điện thoại |

`hash6` là 6 ký tự cuối của id mục, nên hai video cùng tên không bao giờ ghi đè nhau.

**Bản điện thoại làm từ chính bản thường** (không làm từ file nguồn), theo thông số của `video_to_fhd.bat`: `libx264 -preset medium -crf 25 -maxrate/-bufsize`, `aac 128k`, `-movflags +faststart`, chỉ lấy 1 video + 1 audio đầu, thêm `-ac 2`. Giữ độ phân giải bạn chọn nhưng **cạnh dài tối đa 1920** (bản thường 2K/4K thì bản điện thoại về FHD; bản thường 720p thì vẫn 720p; không bao giờ phóng to). Mức bitrate chọn theo cạnh dài của khung hình đầu ra: ≤ 1280 → 2500k, còn lại → 4500k (`bufsize` = `maxrate` × 2).

- **Nguồn HDR**: chỉ bản điện thoại được tone-map về SDR (`zscale` + `tonemap=hable`) và gắn thẻ bt709. Bản thường vẫn giữ HDR. Nếu ffmpeg thiếu `zscale`/`tonemap` thì bỏ tone-map và ghi chú "màu có thể nhạt" (`setup-tools.sh` cũng cảnh báo).
- **Kiểm tra** bằng ffprobe: luồng `h264`, `yuv420p`, thời lượng lệch ≤ 1% so với nguồn (clip rất ngắn được thêm sàn 0,25 giây vì phần đệm của AAC), số audio khớp.
- **Lỗi bản điện thoại không làm hỏng mục**: nếu bước này lỗi, hết ngân sách thời gian, hoặc file ≥ 2 GiB thì bỏ bản điện thoại, ghi lý do vào `phone_skipped` (hiện trong release và trên trang), **vẫn đăng bản thường**.
- Tắt được từng mục bằng tuỳ chọn **"Bản điện thoại (H.264)"** (mặc định bật).

Mặc định tuỳ chọn mới: `resolution original, quality strong, codec hevc, audio opus_128, container mkv, phone bật`. Các mục đã nằm trong hàng đợi giữ nguyên tuỳ chọn của chúng (mục cũ chưa có khoá `phone` nhận giá trị bật).

### Cấu trúc `profiles.json` mục `phone`

```json
"phone": { "preset": "medium", "crf": 25, "audio_kbps": 128,
  "caps": [ { "max_long_edge": 1280, "maxrate": "2500k" }, { "max_long_edge": 1920, "maxrate": "4500k" } ],
  "bufsize_factor": 2, "max_long_edge": 1920 }
```

## Release theo ngày và release mục lục

GitHub giới hạn **1000 file đính kèm mỗi release** và 2 GiB mỗi file (không giới hạn tổng dung lượng, và không có giới hạn số release), nên các video được gom theo ngày thay vì mỗi video một release.

- **Release ngày** `vid-YYYYMMDD` (ngày theo `settings.timezone`), tiêu đề `📅 YYYY-MM-DD · N video`. Các job nén chạy song song và **chỉ upload asset** vào đó; release được tạo theo kiểu chịu được race. Body là bảng của ngày đó kèm khối `<details>` kỹ thuật cho từng video (dung lượng, độ phân giải, codec, CRF, VMAF, thời gian nén, phiên bản công cụ, SHA256, ghi chú…).
- **Khi lỗi chỉ xoá asset của mục đó**, không bao giờ xoá release ngày. Chống làm lại: nếu release hôm nay/hôm qua đã có bản thường của mục (tên chứa `-hash6-`, trạng thái `uploaded`, size > 0) thì coi là xong. Mỗi asset được xác nhận lại qua API (`state`, `size`, `digest` nếu có).
- **Release mục lục** `muc-luc` (`📚 Mục lục video`): chỉ job `finalize` (chạy tuần tự) được ghi. Gồm `catalog.json` (mảng đầy đủ, upsert theo `id`, mới → cũ), `muc-luc.md` (bảng đầy đủ) và phần mô tả là bảng nhóm theo ngày, ngày mới ở trên, dừng ở ~110.000 ký tự (giới hạn của GitHub ~125.000) rồi trỏ tới `muc-luc.md` / `catalog.json`. Link tải dạng `https://github.com/<repo>/releases/download/<tag>/<tên>`.
- Nếu `catalog.json` chưa có hoặc hỏng, `finalize` tự dựng lại từ các release ngày (thiếu một phần siêu dữ liệu). Nếu cập nhật mục lục lỗi, `queue.json` vẫn được cập nhật bình thường; chỉ có cảnh báo trong summary và lần chạy sau tự đồng bộ lại (đối chiếu release hôm nay/hôm qua).
- **Hạn mức ngày** `max_items_per_day` đếm **số video** đã đăng hôm nay (số asset bản thường trong release ngày, không tính `-phone.mp4` và file mục lục; cộng thêm release dạng cũ cùng ngày nếu có).
- Release cũ dạng `vid-YYYYMMDD-HHMMSS-hash` **để nguyên**, không migrate; chúng không nằm trong mục lục, xem ở trang Releases của repo.

## Password và PIN dự phòng

- **Password** (mặc định): tick "Ghi nhớ trên thiết bị này" thì lần sau mở trang là **tự vào luôn** (password được giữ trong `localStorage` khoá `vc_password` của máy đó; chỉ tick trên máy của bạn). Không tick thì mỗi lần mở trang phải nhập lại.
- **PIN dự phòng** (4–12 chữ số, nên dùng 6 số trở lên) dùng khi **quên password**: ở màn hình đăng nhập bấm **"Quên password"**, nhập PIN là vào. PIN **lưu ở Cloudflare** (KV, dạng băm có salt) nên máy nào cũng dùng được. Vào bằng PIN chỉ có hiệu lực trong phiên đó: **PIN không bao giờ được nhớ trên máy**, lần sau mở trang vẫn hiện màn hình nhập password.
- Đặt/đổi/xoá PIN: đăng nhập bằng **password**, mở mục "PIN dự phòng" trên trang. Vào bằng PIN thì không đổi/xoá được PIN (cần password). Cần chạy `wrangler deploy` một lần để Worker có tính năng này.
- Chống dò PIN: sai 5 lần/15 phút theo IP bị khoá; ngoài ra có trần chung 20 lần sai/giờ cho mọi IP (PIN ngắn nên dễ bị dò từ nhiều IP). Khi chạm trần chung thì PIN tạm ngừng dùng được; password vẫn vào bình thường.
- **Giới hạn cần biết:** PIN có quyền ngang password (kể cả bấm "Chạy ngay"), mà chỉ có vài chữ số nên yếu hơn password dài. Người lấy được dữ liệu KV có thể dò ngược PIN ngay. Nếu thấy rủi ro, đừng đặt PIN hoặc xoá nó. Bản cũ lưu PIN mã hoá ngay trên máy (`vc_vault`): bản này bỏ cách đó và tự xoá khoá cũ.

## Tuỳ chỉnh

- `config/settings.json`: `max_parallel` (mặc định 2, tối đa 20), `max_items_per_run`, `max_items_per_day`, `time_budget_min` (240–300), `reserve_min`, `max_input_gb`, `min_vmaf_floor`, `free_disk_space`, `timezone`, `max_attempts`, `max_chain`, `runner_label`.
- `config/profiles.json`: chiều cao (**cạnh ngắn**) từng mức độ phân giải, VMAF + preset từng mức chất lượng, ladder tốc độ, bitrate âm thanh, và mục `phone` (xem trên). Tên khoá phải khớp menu trong `docs/lib/schema.mjs` (có test kiểm tra).
- `config/tools.json`: ghim phiên bản ffmpeg (BtbN), ab-av1, gdown; có trường `sha256` tuỳ chọn (điền kết quả `sha256sum` để kiểm tra toàn vẹn).

### Cập nhật ffmpeg đã ghim
BtbN giữ bản cuối mỗi tháng trong 2 năm và 14 bản daily gần nhất. Chọn bản cuối tháng của nhánh phát hành ổn định bằng `gh release list --repo BtbN/FFmpeg-Builds`, rồi sửa `tag` và `asset` trong `config/tools.json`. Nếu tag bị xóa, workflow cảnh báo rõ và dùng tag `latest` của cùng nhánh.

### Đổi sang self-hosted runner
Đặt `"runner_label": "self-hosted"` (hoặc một mảng nhãn). Chỉ dùng `workflow_dispatch`; **không bao giờ** thêm `pull_request`. Bật "Require approval for all outside collaborators". Máy cần có `gh`, `curl`, `node` ≥ 20, `python3/pip`, `tar`, `zstd`; ổ đĩa tồn tại lâu nên script tự dọn `item-*` cũ khi bắt đầu job.

## Bảng lỗi (`last_error`)

| Mã | Ý nghĩa | Cách xử lý |
|---|---|---|
| `drive_quota` | Drive giới hạn lượt tải | Thử lại sau vài giờ |
| `drive_private` | File chưa chia sẻ công khai | Chia sẻ "bất kỳ ai có link" |
| `not_direct_video`, `not_a_video` | Link không phải file video | Kiểm tra link |
| `lfs_pointer` | Con trỏ Git LFS | Dùng link release |
| `not_found`, `access_denied`, `rate_limited` | Lỗi từ nguồn | Kiểm tra link/quyền, thử lại sau |
| `link_not_found` | Không thấy thẻ `<a>` có class cấu hình (hoặc không link nào chứa "Lọc link") | Kiểm tra `link_class` và ô "Lọc link"; thử "Luôn dùng trình duyệt" nếu nút do JavaScript dựng. Lỗi cố định |
| `browser_failed` | Trình duyệt thật gặp lỗi chung (mở trang/tải) | Tự thử lại tới `max_attempts`; xem log |
| `browser_no_video` | Mở được trang nhưng không thấy luồng video tải được, hoặc chỉ có `blob:` | Dán link tới file video, hoặc điền "Trang mở trước" |
| `browser_unavailable` | Runner không có Chrome/Playwright/xvfb dùng được | Xem log bước cài trình duyệt; đây là lỗi cố định |
| `ytdlp_unsupported`, `drm_protected` | yt-dlp không hỗ trợ trang, hoặc video có DRM | Thử `ytdlp_update_channel: nightly`; DRM thì không tải được |
| `input_too_big`, `no_disk` | Vượt `max_input_gb` hoặc hết đĩa | Tăng giới hạn, bật `free_disk_space`, hoặc self-hosted |
| `too_long` | Hết ladder tốc độ vẫn vượt ngân sách | Dùng self-hosted hoặc chia nhỏ video |
| `timeout` | Hết thời gian | Bấm "Thử lại" (lần sau bắt đầu ở nấc nhanh hơn) |
| `crf_not_found` | Không đạt VMAF yêu cầu | Hạ `min_vmaf` |
| `crf_search_failed`, `encode_failed` | Lỗi ab-av1/ffmpeg | Xem log; so với `ab-av1 … --help` đã lưu |
| `verify_failed` | Kết quả lệch thời lượng/luồng | Xem log |
| `no_gain` | Nén xong không nhỏ hơn gốc | Không đăng; bỏ mục hoặc đổi tuỳ chọn |
| `too_big` | Vẫn ≥ 2 GiB sau khi hạ VMAF tới sàn | Hạ độ phân giải |
| `upload_failed`, `release_failed`, `gh_error` | Release không tạo/xác nhận/đọc được | Thử lại |
| `phone_skipped` (không phải lỗi) | Bản điện thoại bị bỏ (lỗi ffmpeg, hết thời gian, ≥ 2 GiB, không qua kiểm tra); bản thường vẫn đăng. Lý do ghi trong release và trên trang | Xem log; không cần làm gì nếu chấp nhận thiếu bản điện thoại |
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
- Release ngày là release công khai, không phải draft; từng asset được upload rồi xác nhận (`state`, `size`, `digest` SHA256 nếu API có) trước khi tính là xong.
- Bản thường được upload **trước**, bản điện thoại làm và upload sau; nếu job bị dừng giữa chừng sau khi bản thường đã lên, lần chạy lại coi mục là xong (chỉ thiếu bản điện thoại).
- Bản điện thoại chỉ được bắt đầu khi ngân sách thời gian còn ≥ max(1 phút, 30% thời lượng video) (ước lượng của mình, chưa đo trên runner thật).
- Vòng tự gọi lại bị chặn bởi hạn mức ngày và `max_chain` (mặc định 30).
- Bản thường luôn là 10-bit 4:2:0 (nguồn 4:2:2/4:4:4 bị đổi về 4:2:0, có ghi chú trong release); chỉ lấy luồng video chính đầu tiên. Quy ước độ phân giải là **cạnh ngắn** (video dọc 1080×1920 được coi là 1080p, không bị thu nhỏ).
- Giai đoạn 2 (chưa làm, đã chừa chỗ): chia video thành đoạn nén song song, hàng đợi riêng tư bằng repository variable (`QUEUE_BACKEND`), MEGA/Wistia (yt-dlp có thể xử lý HLS/streaming ở những trang bạn bật), thông báo khi xong.
