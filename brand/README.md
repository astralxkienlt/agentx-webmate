# AgentX WebMate — lớp thương hiệu

Sản phẩm này là bản tuỳ biến của [webbrain-one/webbrain](https://github.com/webbrain-one/webbrain) (MIT).
Mục tiêu của thư mục `brand/`: **giữ nguyên vẹn toàn bộ upstream để merge tính năng mới mỗi ngày gần như không conflict.**

## Nguyên tắc số một

> **Không bao giờ sửa file trong `src/`.**

`src/chrome/` và `src/firefox/` là bản sao y nguyên upstream. Mọi thay đổi thương hiệu nằm trong `brand/`,
và `scripts/brand-build.mjs` ghép chúng lại lúc build. Nhờ vậy `git merge upstream/main` chỉ đụng tới
những file bạn thật sự sở hữu — hiện tại là 6 file, thay vì 759 file của upstream.

Sửa thẳng vào `src/` sẽ vẫn chạy, nhưng mỗi lần upstream đổi file đó bạn phải giải conflict thủ công.
Đó chính xác là thứ kiến trúc này sinh ra để tránh.

## Thư mục

```
brand/
├── brand.config.json     Tên, mô tả, các rule thay chuỗi, danh sách token phải giữ nguyên
├── theme.css             Ghi đè biến CSS (nối vào cuối sidepanel.css lúc build)
├── icons/                Logo — đè lên src/<target>/icons/
├── overrides/<target>/   Thay nguyên file upstream (cùng đường dẫn tương đối)
├── additions/<target>/   File hoàn toàn mới của bạn
└── patches/<target>/     Diff phẫu thuật, áp bằng `git apply`
```

Thứ tự áp (sau đè trước): copy upstream → overrides → additions → patches → replacements → manifest/icons/theme.

## Lệnh hằng ngày

```bash
npm run brand:build     # dựng brand-dist/chrome và brand-dist/firefox
npm run brand:watch     # build lại mỗi khi sửa src/ hoặc brand/
npm run brand:audit     # liệt kê file còn sót chữ "webbrain", nhiều nhất trước
npm run brand:clean     # xoá brand-dist/
```

Nạp extension khi dev: Chrome → `chrome://extensions` → Load unpacked → chọn **`brand-dist/chrome`**
(không phải `src/chrome`). `brand-dist/` nằm trong `.gitignore`, không commit.

## Build tự kiểm tra 3 lớp

Đây là phần đáng tin nhất của hệ thống — nó fail to, sớm, thay vì ship bản hỏng:

1. **Patch drift** — patch không áp được → build fail kèm tên file. Nghĩa là upstream đã viết lại đoạn code bạn hook vào.
2. **`preserve` guard** — nếu một rule replace vô tình đụng vào token trong danh sách `preserve`
   (`api.webbrain.one`, các storage key…), build fail. Đây là lỗi nguy hiểm nhất của white-label: đổi nhầm
   endpoint API hoặc khoá lưu trữ thì sản phẩm hỏng âm thầm.
3. **`node --check`** — mọi file JS đầu ra phải parse được. Bắt đúng lỗi kinh điển: rule replace lọt vào giữa
   tên biến và biến JS hợp lệ thành lỗi cú pháp.

## Ba loại chuỗi "webbrain" — đừng gộp làm một

Khảo sát repo cho ra 3182 chỗ, và **không phải chỗ nào cũng được thay**:

| Loại | Ví dụ | Xử lý |
|---|---|---|
| Text người dùng thấy | `WebBrain` trong `src/ui/locales/*.js` | ✅ Đã thay (2841 chỗ) |
| Tên biến / hàm | `ensureWebBrainGroup`, `helpImproveWebBrain` | ❌ Giữ — thay vào là lỗi cú pháp |
| Endpoint & storage key | `api.webbrain.one`, `webbrain_cloud`, `WEBBRAIN_CLOUD_PROVIDER_ID` | ❌ Giữ — thay vào là hỏng tính năng cloud |
| Định danh giao thức | `webbrain-tools`, `webbrain-skill` (WebMCP) | ❌ Giữ — trang web bên ngoài dựa vào tên này |

Rule trong `brand.config.json` dùng lookahead/lookbehind để tách đúng 4 nhóm trên. Khi thêm rule mới,
luôn chạy `npm run brand:build` — `preserve` guard và `node --check` sẽ chặn nếu bạn quét quá tay.

## Thêm / bớt tính năng

Chọn cách **thấp nhất còn dùng được** — càng lên cao càng dễ vỡ khi upstream đổi:

1. **`features.exclude`** trong config — loại hẳn file khỏi bản build. Tốt nhất cho tính năng gói gọn 1 file.
   ```json
   "features": { "exclude": ["src/ui/promotion-*.js"] }
   ```
2. **`additions/`** — tính năng mới, file mới. Không bao giờ conflict.
3. **`overrides/`** — thay nguyên một file upstream. Rẻ lúc viết, nhưng bạn **mất mọi cập nhật upstream cho file đó**.
   Chỉ dùng với file nhỏ và ít thay đổi.
4. **`patches/`** — sửa vài dòng giữa file lớn (ví dụ `background.js` 131KB). Giữ được cập nhật upstream,
   đổi lại patch sẽ fail khi upstream viết lại vùng đó — và fail như vậy là đúng mong muốn.

Tạo patch:
```bash
cp src/chrome/src/ui/sidepanel.js /tmp/orig.js
# sửa /tmp/orig.js theo ý bạn
diff -u src/chrome/src/ui/sidepanel.js /tmp/orig.js > brand/patches/chrome/010-sidepanel-xyz.patch
```
Sửa header trong file `.patch` cho đúng đường dẫn tương đối (`src/ui/sidepanel.js`), đánh số thứ tự để kiểm soát thứ tự áp.

## Đồng bộ upstream

`.github/workflows/agentx-sync-upstream.yml` chạy 01:00 giờ VN mỗi ngày:

- Cập nhật nhánh `upstream-sync` = bản sao y hệt upstream/main (không bao giờ conflict, dùng để đối chiếu).
- Thử merge vào `main`:
  - **sạch + `brand:build` pass** → đẩy thẳng lên `main`.
  - **sạch nhưng build fail** → mở PR (thường là patch drift).
  - **conflict** → mở PR để bạn xử lý tay.

Chạy tay: tab **Actions** → *Sync upstream (webbrain)* → *Run workflow*.

Merge tại máy:
```bash
git fetch upstream
git merge upstream/main
npm run brand:build
```

## Còn phải làm trước khi phát hành

Build hiện dùng giá trị tạm. Những mục dưới đây **phải** xử lý trước khi lên store:

- [ ] `brand/icons/` đang trống → thêm `icon16.png`, `icon48.png`, `icon128.png`. Chưa có thì extension vẫn mang logo WebBrain.
- [ ] `product.homepage` đang là `https://example.com`.
- [ ] `product.firefoxId` đang là `agentx-webmate@example.com` — đổi sang domain bạn sở hữu.
- [ ] **Privacy policy**: `https://webbrain.one/privacy` còn xuất hiện 24 chỗ. Chrome Web Store **bắt buộc** có
      privacy policy của chính bạn với bộ quyền này (`debugger`, `<all_urls>`, `tabCapture`…). Trỏ về trang của bạn
      bằng một rule replace URL.
- [ ] `store-review-prompt.js` trỏ tới listing Chrome Web Store / AMO của WebBrain → đổi sang listing của bạn sau khi publish.
- [ ] Quyết định về `api.webbrain.one`: hiện các tính năng cloud vẫn gọi backend của WebBrain. Muốn tách hẳn thì
      phải tự dựng backend rồi mới đổi URL — đừng đổi URL trước.
- [ ] `theme.css` mới chỉ có khung; đặt `--accent` theo bảng màu của bạn.

## Giấy phép

Upstream là **MIT**. Bạn được phép làm sản phẩm thương mại và không phải mở mã phần của mình,
nhưng **bắt buộc giữ lại thông báo bản quyền MIT** khi phân phối. Đừng xoá `LICENSE`
hay `src/chrome/LICENSE` — chúng được copy sang bản build và đó chính là thứ giữ bạn đúng luật.

## Lưu ý về repo này

Clone theo kiểu **partial + sparse** vì repo gốc nặng ~1GB:

- `--filter=blob:none`: đủ lịch sử commit để merge, blob tải theo nhu cầu.
- Sparse checkout **không có `test/`** (6674 file). Cần chạy test tại máy:
  ```bash
  git sparse-checkout add test && npm ci
  ```
- Remote `upstream` đã khoá push (`DISABLED_read_only`) để không lỡ tay đẩy code thương hiệu lên repo gốc.
