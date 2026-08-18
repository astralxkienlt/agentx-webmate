# netMind Extension — lớp thương hiệu

Sản phẩm này là bản tuỳ biến của [webbrain-one/webbrain](https://github.com/webbrain-one/webbrain) (MIT), rebrand thành **netMind Extension**.
Mục tiêu của thư mục `brand/`: **giữ nguyên vẹn toàn bộ upstream để merge tính năng mới mỗi ngày gần như không conflict.**

## Nguyên tắc số một

> **Không bao giờ sửa file trong `src/`.**

`src/chrome/` và `src/firefox/` là bản sao y nguyên upstream. Mọi thay đổi thương hiệu nằm trong `brand/`,
và `scripts/brand-build.mjs` ghép chúng lại lúc build. Nhờ vậy `git merge upstream/main` chỉ đụng tới
những file bạn thật sự sở hữu thay vì hàng trăm file của upstream.

Sửa thẳng vào `src/` sẽ vẫn chạy, nhưng mỗi lần upstream đổi file đó bạn phải giải conflict thủ công.
Đó chính xác là thứ kiến trúc này sinh ra để tránh.

## Thư mục

```
brand/
├── brand.config.json     Tên, mô tả, các rule thay chuỗi, danh sách token phải giữ nguyên
├── fonts.css             @font-face Inter + font-family sản phẩm
├── theme.css             Ghi đè biến CSS (nối vào cuối sidepanel.css lúc build)
├── first-run-install.css Giao diện trang chào mừng sau khi cài extension
├── first-run-onboarding.css
│                         Giao diện coachmark ghim và onboarding 3 bước trong side panel
├── additions/common/fonts/ Inter variable (SIL OFL)
├── icons/                Icon đã sinh từ assets/logo/logo.jpg — đè lên src/<target>/icons/
├── overrides/<target>/   Thay nguyên file upstream (cùng đường dẫn tương đối)
├── additions/<target>/   File hoàn toàn mới của bạn
└── patches/<target>/     Diff phẫu thuật, áp bằng `git apply`
```

`tokens.css` ở root chứa palette, font stack, spacing và motion token dùng chung cho hai giao diện
lần đầu. Build script nối token vào từng stylesheet đầu ra trước khi nối `first-run-*.css`.

Thứ tự áp (sau đè trước): copy upstream → overrides → additions → patches → replacements →
manifest/icons/theme → first-run styles.

## Lệnh hằng ngày

```bash
npm run brand:build     # dựng brand-dist/chrome và brand-dist/firefox
npm run brand:watch     # build lại mỗi khi sửa src/, brand/ hoặc tokens.css
npm run brand:audit     # liệt kê file còn sót chữ "webbrain", nhiều nhất trước
npm run brand:clean     # xoá brand-dist/
npm run build:zip       # build brand-dist rồi đóng gói dist/netmind-extension-*.zip
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

Tên file do người dùng tải xuống dùng tiền tố `netmind-extension-`. Đuôi workflow cũ
`.agentx-webmate-workflow.json` và `.webbrain-workflow.json` vẫn được chấp nhận khi import để không làm hỏng dữ liệu đã có.
Các README/ARCHITECTURE và ghi chú nguồn asset của upstream không cần lúc chạy được loại khỏi gói phát hành;
`LICENSE` luôn được giữ lại.

Hai file `first-run-*.css` chỉ thay lớp giao diện: nội dung i18n, logic mở side panel, dò model,
coachmark ghim và trạng thái hoàn thành onboarding vẫn lấy nguyên từ upstream. Build script nối chúng
vào `src/ui/install.css` và `styles/sidepanel.css` của từng target, nên không cần sửa trực tiếp `src/`.

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

### Secret `MIRROR_TOKEN` — đừng để hết hạn

Workflow push bằng secret `MIRROR_TOKEN` chứ **không** dùng `github.token` mặc định. Lý do:
token mặc định của Actions là token GitHub App, mà App bị GitHub cấm tạo/sửa file trong
`.github/workflows/`. Upstream có sẵn 6 workflow, nên bất cứ lần nào upstream đụng vào chúng thì
push bằng token mặc định sẽ bị từ chối ở đúng bước cuối — sau khi đã upload xong dữ liệu.

Nếu PAT hết hạn, workflow fail ngay ở bước *Kiểm tra token* với hướng dẫn tạo lại:
```bash
gh auth refresh -h github.com -s workflow
gh secret set MIRROR_TOKEN --repo astralxkienlt/agentx-webmate --body "$(gh auth token)"
```

6 workflow của upstream đã bị **tắt** trong mirror (tắt qua API, không xoá file — nên không tạo
conflict khi merge). Nếu sau này merge upstream thêm workflow mới, nhớ tắt nó đi, không thì nó
sẽ chạy và fail vì thiếu secret của WebBrain.

Merge tại máy:
```bash
git fetch upstream
git merge upstream/main
npm run brand:build
```

## Còn phải làm trước khi phát hành

Build hiện dùng giá trị tạm. Những mục dưới đây **phải** xử lý trước khi lên store:

- [ ] `product.firefoxId` đang là `netmind-extension@astralx.com.vn` — xác nhận với AMO trước khi lên store.
- [ ] **Privacy policy**: `https://webbrain.one/privacy` còn xuất hiện 24 chỗ. Chrome Web Store **bắt buộc** có
      privacy policy của chính bạn với bộ quyền này (`debugger`, `<all_urls>`, `tabCapture`…). Trỏ về trang của bạn
      bằng một rule replace URL.
- [ ] Prompt đánh giá đang bị vô hiệu hoá để không đưa người dùng tới listing cũ → sau khi publish, cấu hình URL listing mới và bật lại ngưỡng hiển thị.
- [ ] Quyết định về `api.webbrain.one`: hiện các tính năng cloud vẫn gọi backend của WebBrain. Muốn tách hẳn thì
      phải tự dựng backend rồi mới đổi URL — đừng đổi URL trước.
- [ ] `theme.css` và `tokens.css` đã khóa palette raspberry + Inter theo netMind Chat. Re-check biến CSS sau mỗi lần merge upstream lớn.

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
