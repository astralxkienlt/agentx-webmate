# Kế hoạch thi công — Ingestion v2 (tệp đính kèm làm context)

> Bản trình bày đầy đủ (kèm sơ đồ): https://claude.ai/code/artifact/441f1568-f70c-406a-8abb-ec585ee82e1b
> Bản vẽ kiến trúc gốc: https://claude.ai/code/artifact/268be3ea-12c5-4fd5-bce2-5cb7b0bb0fe8
>
> Nền: nhánh mới từ `2c8bfa74`. Không chạm các file đang sửa dở trong working tree
> (brand config, icons, skill wikipedia). Quy ước: mọi thay đổi mirror Chrome ↔ Firefox
> trong cùng PR. Kế hoạch neo theo tên hàm/module, không neo số dòng (repo đang tiến hóa).
>
> Kiến trúc tổng hợp từ khảo sát mã nguồn Hermes Agent (Nous Research) và OpenClaw
> ngày 19-08-2026: kho claim-check + giao nội dung theo năng lực model + tool đọc thêm
> theo trang, chuyển vào ràng buộc MV3 của extension.

## 01 · Mục tiêu và Definition of Done toàn tính năng

Tính năng được coi là **hoàn tất chuẩn production** khi toàn bộ 10 tiêu chí sau được
kiểm chứng trên cả Chrome và Firefox, trên build brand netMind (`brand-dist`):

1. **PDF có text layer, provider mặc định (cloud, không hỗ trợ document block):** đính
   10 trang → tin nhắn gửi thành công dưới dạng văn bản trích, khai báo rõ phạm vi trang;
   hỏi chi tiết nằm ở trang 9 → model tự gọi `read_attachment` và trả lời đúng.
2. **Ảnh giấy tờ trên model vision:** agent đọc và điền form đúng các trường;
   `upload_file({attachmentId})` nộp đúng bytes gốc vào `input[type=file]`.
3. **PDF scan:** trên provider vision → trả lời từ các trang đã render; trên provider
   text-only → tin nhắn *vẫn gửi*, tệp đó mang outcome "thiếu năng lực" kèm gợi ý đổi
   model. Không còn kịch bản một tệp chặn cả lần gửi.
4. **DOCX có bảng:** trích được nội dung, bảng phẳng hóa đọc được; .doc cũ (OLE) bị
   từ chối với thông báo đúng loại.
5. **Sống sót qua reload:** đóng-mở side panel giữa chừng → chip còn nguyên, retry gửi
   lại đủ tệp (loại bỏ hẳn toast "Không còn tệp đính kèm của lần chạy lỗi").
6. **Payload IPC không còn base64:** message `chat_start` chỉ mang id + metadata
   (đo được < 5 KB cho phần đính kèm, so với hàng MB hiện nay).
7. **An ninh:** corpus injection mở rộng (27 → 33 payload, thêm 6 payload đường tài
   liệu) xanh trên cả hai trình duyệt; nonce ngẫu nhiên hiện diện trong notice mỗi lần
   gửi; nội dung trích không thể giả ranh giới.
8. **Vòng đời:** tệp tự biến mất khỏi Store sau TTL 24 giờ; nút "Xóa tệp đã đính"
   trong Settings hoạt động; chế độ "chỉ trong phiên" hoạt động.
9. **Không hồi quy:** `npm test` (gồm security, toolbar-guard, agentx-auth),
   `test:fixtures` xanh; redaction ảnh chụp giữ nguyên hành vi fail-closed; compaction
   lịch sử và export không đổi định dạng.
10. **Hoàn thiện sản phẩm:** đủ chuỗi cho 23 ngôn ngữ; cập nhật `docs/agent-tools.md`,
    `docs/privacy-and-data-flow.md`, `docs/architecture.md`; CHANGELOG; `brand:build` +
    `brand:audit` sạch; `build:zip` ra gói cài được.

**Ngoài phạm vi (non-goals):** hồ sơ cá nhân có cấu trúc (track riêng), XLSX (đã có
`sheets-tools` cho luồng download — cân nhắc sau), voice/STT, RAG/embeddings, thay đổi
luồng outbound `upload_file`.

## 02 · Năm quyết định đã chốt

| # | Câu hỏi | Chốt | Hệ quả |
|---|---------|------|--------|
| Q1 | TTL của Store | 24 giờ, quét mỗi giờ + xóa tay + tùy chọn "chỉ trong phiên" | Sweep bằng `chrome.alarms`; mục Settings mới (GĐ 2) |
| Q2 | Thư viện DOCX | Vendor mammoth (bản browser, pin version, không build step) | `src/chrome/vendor/mammoth/` cạnh `pdfjs`, `katex` (GĐ 4) |
| Q3 | Render PDF scan | Tối đa 8 trang đầu, ~144 DPI, trần pixel chia theo số trang còn lại | Trang sau qua `read_attachment({mode:'render'})` (GĐ 3–4) |
| Q4 | Firefox | Mirror trong từng PR, không dồn cuối | Mỗi checklist có cặp `src/chrome/…` ↔ `src/firefox/…` |
| Q5 | Gộp staged-screenshot-store | GĐ 2 mở schema (`origin:'slash_screenshot'` + trường redaction), di trú thật sau GĐ 3 | Không trộn rủi ro redaction vào PR nền tảng |

## 03 · Đặc tả kỹ thuật cắt ngang

Quy tắc viết mã xuyên suốt: **module mới là ESM thuần, phụ thuộc được tiêm qua tham số**
(indexedDB, pdfjs, storage) — vì `test/run.js` là Node thuần không có `chrome.*`, test
import module trực tiếp và truyền fake.

### 3.1 Attachment Store (mới)

File `src/{chrome,firefox}/src/media/attachment-store.js`. IndexedDB `wb_attachments`
v1, object store `attachments` keyPath `id`, index theo `tabId`, `createdAt`, `origin`.
Side panel lẫn background đọc-ghi cùng DB (cùng origin extension) — bytes ghi một lần từ
side panel, background đọc theo id, **chấm dứt chuyển base64 qua runtime message**.

```js
record = {
  id: 'att_' + uuid,            // định danh claim-check, dùng luôn làm attachmentId phía agent
  tabId, origin: 'user_upload' | 'slash_screenshot',
  name,                          // đã qua allowlist ký tự (3.6)
  mime,                          // kết quả sniff, không phải file.type
  kind: 'image'|'document'|'text', docType: 'pdf'|'docx'|null,
  size, bytes: Blob,             // bytes gốc — bất biến, phục vụ upload_file replay
  textContent?,                  // riêng kind text (tương thích _formatTextAttachmentBlock)
  facts: { pages?, hasTextLayer?, coverage?, width?, height? },   // Probe ghi sau
  redaction?: {...},             // mở sẵn cho screenshot (Q5), GĐ 2 chưa dùng
  state: 'pending'|'sent', createdAt, lastUsedAt
}
```

- API: `createAttachmentStore({ idb })` → `put, get, getBytes, touch, listByTab, remove,
  removeByTab, sweep(ttlMs)`. Test dùng fake IDB in-memory.
- **Sweep:** alarm `wb-attachment-sweep` mỗi giờ trong background; xóa record có
  `lastUsedAt` quá TTL. Chip pending của tab đã đóng dọn theo hook
  `clearPendingAttachmentsForTab` sẵn có. Chế độ "chỉ trong phiên": sweep lúc service
  worker khởi động xóa record của phiên trước.
- **Suy biến an toàn:** mở DB lỗi hoặc quota → toast `sp.persistence.unavailable`
  (chuỗi có sẵn) và rơi về đường in-memory hiện tại, giữ một release rồi mới gỡ.
  Không bao giờ chặn người dùng gửi tin.
- Kiểm tra quyền `alarms` trong manifest (đã dùng cho `schedule_*`) — nếu thiếu, bổ sung.

### 3.2 media-core: sniff và phân lớp (mới)

File `src/{chrome,firefox}/src/media/media-core.js`. Không dependency. MIME quyết định
theo thứ tự **bytes ▸ header ▸ đuôi tệp**, container chung không đè gợi ý cụ thể:

| Chữ ký bytes (đầu tệp) | Kết luận | Ghi chú |
|---|---|---|
| `89 50 4E 47` / `FF D8 FF` / `47 49 46 38` / `RIFF…WEBP` / `42 4D` | image/png · jpeg · gif · webp · bmp | Header khai `image/*` nhưng bytes không khớp → **từ chối** (`sp.attach.mime_mismatch`) |
| `%PDF-` trong 1024 byte đầu | application/pdf | Chuẩn PDF cho phép rác trước header |
| `50 4B 03 04` (zip) | container — nhường đuôi tệp | `.docx` → docType docx; xác thực thật khi trích (`[Content_Types].xml`); zip trần → loại lạ, làn C |
| BOM UTF-8/16 hoặc tỉ lệ ký tự in được > 0.85 trên 8 KB đầu | text/* | Không suy ra text từ decode "thành công" đơn thuần |
| khác | application/octet-stream | Làn C — tham chiếu, không từ chối im lặng |

Caps giữ 16 MB nhị phân / 5 MB text; nguồn base64 (paste) **ước lượng kích thước trước
khi decode** (len × 3⁄4).

### 3.3 IPC và vòng đời chip (nâng cấp)

- `handleAttachedFiles()` → `ingestFiles()`: sniff → ghi Store → chip trỏ `att_id`.
  `pendingAttachmentsByTab` chỉ giữ id + metadata hiển thị;
  `retryAttachmentPayloads`/`retryAttachmentIdsByTab` **xóa bỏ** — retry đọc lại Store.
- Payload `chat_start`/`chat` mang `attachmentIds`; `_applyAttachments` resolve bytes
  từ Store; `_registerUserAttachments`/`_resolveUserAttachment` đọc Store +
  `touch(lastUsedAt)` — handle `attachmentId` phía tool *chính là* id Store (giữ ngữ
  nghĩa "tệp người dùng tự đính" cho `upload_file`).
- Journal reconnect (`run-ui-journal`) và lịch sử chat lưu id + metadata, không lưu bytes.

### 3.4 Materializer và outcome union (nâng cấp)

`_applyAttachments` giữ vai trò chốt chặn duy nhất, đổi ruột theo ma trận ba làn.
Hợp đồng mới: **không đường nào `return {ok:false}` cho cả lần gửi vì một tệp**:

```js
outcome = { id, lane: 'native'|'native_pages'|'text'|'reference' }
        | { id, skipped: 'capability'|'policy'|'error', reasonKey }   // closed union, test exhaustive
```

- Ánh xạ chip: `lane:*` → "Đã kèm" (tooltip nói làn nào); `skipped:*` → "Chưa gửi" +
  lý do phân biệt *chính sách* / *thiếu năng lực* / *lỗi*. Sự kiện `attachment_rejected`
  tái dùng làm kênh phát outcome.
- **Budget thông báo:** tối đa 6 dòng ghi chú tệp trong notice; từ tệp thứ 7 gộp
  "và N tệp khác — dùng read_attachment theo id".
- Ngoại lệ giữ nguyên: ảnh `slash_screenshot` mất bản redaction model-facing vẫn
  *fail-closed từ chối gửi* như hiện tại.

Ma trận giao nội dung (từ bản vẽ):

| Loại tệp | Provider | Làn | Cơ chế |
|---|---|---|---|
| Ảnh | có vision | A · native | `image_url` + budget shrink + redaction (có sẵn) |
| Ảnh | không vision | outcome | `skipped_capability`, các tệp khác vẫn gửi |
| PDF | supportsDocuments (Anthropic) | A · native | `document` block (có sẵn) |
| PDF text-layer | provider khác | B · văn bản | trích pdf.js cục bộ + coverage warning |
| PDF scan | có vision | A · ảnh trang | render ≤ 8 trang, pixel-budget chia trang |
| PDF scan | không vision | C · tham chiếu | outcome capability + id dùng khi đổi model |
| DOCX | mọi provider | B · văn bản | mammoth vendored |
| TXT/JSON/CSV | mọi provider | B · văn bản | như hiện tại + sniff xác nhận |
| Quá lớn / loại lạ | mọi provider | C · tham chiếu | metadata + `att_⟨id⟩` + chỉ dẫn `read_attachment` |

### 3.5 Trích xuất và render

- `extractPdfText(url)` tách đôi: `extractPdfTextFromBytes(bytes, {fromPage, toPage,
  maxChars})` + wrapper URL cũ (`read_pdf` không đổi hành vi).
- **Cảnh báo độ phủ** (ngưỡng Hermes): đếm ký tự từng trang; nếu ≥ 2 trang và (≥ 20% số
  trang hoặc ≥ 10 trang) dưới 20 ký tự → header tiếng Anh liệt kê dải trang thiếu chữ +
  chỉ dẫn "các trang này cần vision — gọi read_attachment mode render".
- `renderPdfPagesToPng(bytes, {pages, pixelBudget})`: pdfjs + OffscreenCanvas trong
  background (Firefox background page dùng canvas thường); trần pixel mỗi lần gọi chia
  cho số trang còn lại; ảnh ra đi qua `_shrinkImageForBudget` sẵn có.
- **DOCX:** `extractDocxText(bytes)` bọc mammoth; bảng phẳng hóa mỗi hàng một dòng, ô
  ngăn `|`; numbering giữ số; lỗi → outcome `skipped:'error'`. Từ chối OLE (.doc) ngay
  ở sniff với thông báo riêng.
- Mọi trích xuất chạy trong background theo message `attachment_probe`/
  `attachment_extract`; **một tài liệu decode tại một thời điểm** (hàng đợi tuần tự).

### 3.6 Ranh giới tin cậy (nâng cấp trên nền sẵn có)

- **Nonce:** `_userAttachmentNotice` chèn `id=⟨randomToken()⟩` *sau* prefix
  `[UNTRUSTED USER ATTACHMENTS` — mọi guard `startsWith` hiện có (planner strip,
  compaction, `_isUserAttachmentNoticeBlock`) giữ nguyên; thêm test khẳng định prefix.
- **Trung hòa nội dung trích:** văn bản từ PDF/DOCX đi qua bộ trung hòa của
  `_wrapUntrusted`, mở rộng hai mẫu: prefix notice giả `[UNTRUSTED USER ATTACHMENTS` và
  `[UNTRUSTED DOCUMENT` xuất hiện *bên trong* nội dung.
- **Metadata theo allowlist:** `_sanitizeAttachmentName` siết thành pattern dương
  `[\p{L}\p{N} ._()-]{1,80}`, sai thì thay "attachment-N" (không escape-rồi-giữ). MIME
  hiển thị phải khớp token RFC.
- Memory/profile giữ nguyên: không tự lưu nội dung tệp; auto-learn tiếp tục loại
  attachment bodies.

### 3.7 Tool `read_attachment` (mới)

```js
{ name: 'read_attachment',
  parameters: {
    attachmentId: string,                    // bắt buộc, id từ notice
    fromPage?: number, toPage?: number,      // PDF — mặc định trang kế tiếp sau phần đã gửi
    fromChar?: number,                        // text/DOCX — con trỏ ký tự, trả next_offset
    mode?: 'text' | 'render'                  // render: PDF scan → ảnh trang (cần vision)
  } }
```

- Phân bậc mode: **theo hàng `read_pdf`** trong `docs/agent-tools.md` (có ở Ask — đọc
  tệp người dùng là read-only), khác hàng `read_downloaded_file` (Act/Dev).
- Đấu dây untrusted: thêm vào `UNTRUSTED_CONTENT_TOOLS` (permission-gate) + hai đoạn
  liệt kê tool untrusted trong `SYSTEM_PROMPT_ASK`/`ACT` + ghi chú scratchpad.
- Ngân sách: mặc định 20 000 ký tự/lần gọi, trả `next` (trang hoặc offset) khi cắt;
  `mode:'render'` tái dùng đường đính ảnh follow-up sẵn có (≤ 4 trang/lần, tính vào
  budget ảnh của lượt).
- Id hết hạn/không tồn tại → lỗi hành động được ("tệp đã hết hạn lưu — đề nghị người
  dùng đính lại"), không lộ đường dẫn nội bộ.

## 04 · Sáu giai đoạn thi công

Phụ thuộc: GĐ1 độc lập (phát hành sớm được); GĐ2 → GĐ3, GĐ5; GĐ4 cần GĐ1 + GĐ2
(nên merge sau GĐ3 để dùng outcome union).

### GĐ 0 · Chuẩn bị (0.5 ngày)

- [ ] Nhánh `feature/ingestion-v2` từ `2c8bfa74`; mỗi giai đoạn một PR vào nhánh này
      (hoặc merge thẳng từng PR nếu muốn phát hành dần — GĐ 1 đủ điều kiện).
- [ ] Fixtures `test/fixtures/attachments/`: PDF text 3tr, PDF scan 2tr, PDF lai 10tr
      (7 text + 3 scan), DOCX bảng + numbering, CSV 1 MB, PNG hợp lệ, "PNG" giả
      (HTML đổi đuôi), zip trần, UTF-16 TXT có BOM.
- [ ] Provider stub cho test ma trận: 4 tổ hợp `{supportsVision, supportsDocuments}`.
- [ ] Xác nhận quyền `alarms` trong cả hai manifest.

### GĐ 1 · PDF làn B — trích văn bản cục bộ (1–1.5 ngày)

- [ ] `agent/pdf-tools.js`: tách `extractPdfTextFromBytes`; coverage per-page + builder
      cảnh báo độ phủ (3.5). Mirror Firefox.
- [ ] `agent/agent.js · _applyAttachments`: nhánh `kind==='document' && docType==='pdf'
      && !provider.supportsDocuments` → trích bytes, clamp bằng
      `_textAttachmentContentBudget`, block khai báo tên + phạm vi trang + coverage.
      Anthropic giữ làn A.
- [ ] PDF scan ở giai đoạn này: outcome cần-vision, *không chặn cả lần gửi* — điểm đổi
      hợp đồng đầu tiên, kèm chuỗi `sp.attach.*`.
- [ ] i18n: 3 khóa mới × 23 locale (trích-một-phần, cần-vision, đã-gửi-dạng-văn-bản).
- [ ] Test: coverage thresholds (4), ma trận hàng PDF (3 × 2 trình duyệt), fixture PDF
      lai ra đúng cảnh báo dải trang.
- [ ] Docs: `privacy-and-data-flow.md` — trích xuất chạy cục bộ, bytes chỉ đến provider.

**Nghiệm thu:** DoD-1 (nửa đầu), DoD-3 phần "không chặn lần gửi".

### GĐ 2 · media-core + Attachment Store + Settings TTL (2–3 ngày)

- [ ] Tạo `src/{chrome,firefox}/src/media/media-core.js` (3.2) và
      `attachment-store.js` (3.1) — ESM thuần, tiêm phụ thuộc.
- [ ] `ui/sidepanel.js`: `ingestFiles()` thay `handleAttachedFiles()` — sniff trước,
      từ chối mismatch, ghi Store, chip theo id; xóa `retryAttachmentPayloads`/
      `retryAttachmentIdsByTab`; chip đọc metadata từ Store khi mở lại panel.
- [ ] `background.js`: alarm sweep; handler `attachment_probe` (pdf.js đếm trang +
      hasText, DOCX validate zip) ghi `facts`; sidepanel cập nhật chip ("PDF · 12
      trang" / "PDF scan — cần vision" / cảnh báo trước gửi theo provider đang chọn).
- [ ] `agent.js`: `_applyAttachments`/`_resolveUserAttachment`/`upload_file` resolve
      bytes qua Store id; payload `chat_start` → `attachmentIds`; journal lưu id.
- [ ] `ui/settings.html + settings.js`: mục "Tệp đính kèm" — TTL (24h / chỉ trong
      phiên), nút "Xóa tất cả tệp đã đính", dòng đếm dung lượng.
- [ ] Schema mở sẵn `redaction`/`origin:'slash_screenshot'` (Q5) — chưa di trú.
- [ ] i18n: ~7 khóa × 23 locale.
- [ ] Test: sniffer 12 case; store CRUD/TTL biên/fallback quota; "reload panel giữ
      chip"; assert payload `chat_start` không chứa `data:` URL.

**Nghiệm thu:** DoD-5, DoD-6, DoD-8; hành vi cũ chạy y nguyên trên nền Store.

### GĐ 3 · read_attachment + làn C + outcome union (2 ngày)

- [ ] `agent/tools.js`: schema `read_attachment` (3.7); thêm vào hai đoạn liệt kê
      untrusted trong system prompt + ghi chú scratchpad; `getToolsForMode` theo bậc
      `read_pdf`.
- [ ] `agent/permission-gate.js`: thêm `read_attachment` vào `UNTRUSTED_CONTENT_TOOLS`.
- [ ] `agent/agent.js`: dispatch trong `executeTool` — text/PDF-text theo con trỏ;
      `mode:'render'` đi đường đính ảnh follow-up sẵn có; `touch` Store; lỗi id hết
      hạn theo 3.7. Outcome union thay các `return {ok:false}` còn lại; làn C sinh ghi
      chú tham chiếu + budget 6 dòng.
- [ ] `ui/sidepanel.js`: outcome → tooltip chip (chính-sách/năng-lực/lỗi).
- [ ] i18n ~5 khóa × 23 locale. Docs: hàng mới `docs/agent-tools.md`.
- [ ] Test: phân trang trả `next`; id hết hạn; kết quả bọc untrusted; exhaustive-check
      outcome; marker budget gộp từ tệp thứ 7; kịch bản LLM tùy chọn "trả lời từ
      trang 9".
- [ ] Sau merge: di trú staged-screenshot-store vào Attachment Store (PR con riêng,
      test redaction hiện có phải xanh không sửa).

**Nghiệm thu:** DoD-1 (vế sau), DoD-3 (outcome), nửa DoD-7 (nonce + neutralization
vào cùng GĐ này).

### GĐ 4 · DOCX + PDF scan render (2–3 ngày)

- [ ] Vendor `mammoth` vào `src/{chrome,firefox}/vendor/mammoth/` (pin version, ghi
      nguồn/license, không build step).
- [ ] `media/extract-docx.js` (3.5); media-core nhận docType docx; `accept` của input
      thêm `.docx`; cập nhật `sp.attach.unsupported_type`.
- [ ] `renderPdfPagesToPng` + nhánh ma trận "PDF scan × vision → A·ảnh trang";
      `read_attachment mode:'render'` dùng chung hàm.
- [ ] Hàng đợi trích xuất tuần tự trong background + đo bộ nhớ bằng fixture PDF 100
      trang.
- [ ] Test: docx bảng ra text phẳng đúng; .doc OLE từ chối đúng loại; scan 2 trang
      render đúng số ảnh; ma trận đủ 9 hàng xanh cả hai trình duyệt.

**Nghiệm thu:** DoD-3 (vế render), DoD-4.

### GĐ 5 · Paste, kéo-thả và khép an ninh (1–1.5 ngày)

- [ ] `ui/sidepanel.js`: handler `paste` trên ô nhập (ảnh clipboard + file) và
      `dragover/drop` trên composer → cùng đổ về `ingestFiles()`; hiệu ứng vùng thả;
      *không* đụng drag-drop sẵn có của plan-review.
- [ ] `test/security/injection-corpus.mjs` +6 payload: lệnh override trong text PDF
      trích; DOCX giả tool-result; tên tệp chứa `[UNTRUSTED…]`; giả đóng nonce;
      zero-width/RTL trong nội dung trích; CSV chứa chỉ thị — giữ 5 bất biến của corpus.
- [ ] Chuỗi hint vùng thả (i18n); cập nhật `docs/architecture.md` mục attachments.

**Nghiệm thu:** DoD-7 trọn vẹn; trải nghiệm intake ngang ChatGPT/Claude desktop.

## 05 · Kiểm thử và QA production

**Tự động (`npm test`):**

- Đơn vị (test/run.js, Node thuần, import ESM): sniffer (12), store (8), ma trận
  materializer (9 hàng × 4 provider stub), coverage (4), nonce/neutralization (4),
  read_attachment (5), marker-budget (2), outcome-exhaustive (1) — mirror hai cây
  chrome/firefox.
- An ninh: corpus 33 payload (`test:security`); `test:agentx-auth` sau `brand:build`.
- Fixtures: `test:fixtures` cover bộ tệp GĐ 0.
- LLM (tùy chọn): 2 kịch bản mới — điền form từ ảnh giấy tờ; trả lời từ trang 9 buộc
  gọi `read_attachment`.

**QA tay — ma trận trước phát hành:**

| Trục | Giá trị chạy |
|---|---|
| Provider | netMind Cloud (mặc định) · Anthropic (document block) · Ollama text-only · llama.cpp vision tắt/bật |
| Tệp | JPG · PDF text 3tr · PDF scan 2tr · PDF lai 10tr · PDF 40tr (làn C + đọc thêm) · DOCX bảng · CSV 4 MB · PNG giả |
| Hành động | gửi · retry sau reload panel · đổi provider giữa pending · `upload_file` vào form thật · `read_attachment` trang sau · chờ hết TTL · xóa trong Settings |
| Trình duyệt | Chrome (brand-dist) đầy đủ · Firefox smoke cùng bộ |
| Regression bắt buộc | `test/manual-screenshot-redaction.md` nguyên trạng · compaction hội thoại dài có đính kèm · export traces/markdown · Ask mode chỉ-đọc |

**Ngưỡng hiệu năng:** sniff ≤ 10 ms/tệp; probe PDF 100 trang ≤ 2 s nền, UI không khựng;
payload IPC phần đính kèm ≤ 5 KB; SW một tài liệu decode tại một thời điểm, không giữ
ArrayBuffer sau materialize.

## 06 · Phát hành và vận hành

1. **Trình tự merge:** GĐ 1 có thể phát hành sớm một mình; còn lại gộp theo nhánh
   feature, phát hành khi DoD toàn tính năng xanh.
2. **Bản dựng:** `npm run bump` → CHANGELOG (giọng như các entry attachment cũ) →
   `brand:build` + `brand:audit` → `npm test` → `build:zip` Chrome/Edge, gói ký Firefox.
3. **Docs:** `agent-tools.md` (+read_attachment), `privacy-and-data-flow.md` (mục
   "Tệp đính kèm lưu cục bộ tối đa 24 giờ; nội dung chỉ rời máy khi gửi đến provider
   bạn chọn"), `architecture.md`, README mục Use it.
4. **Store review:** không quyền mới (alarms/unlimitedStorage đã có); nếu GĐ 2 phát
   hiện thiếu `alarms` thì khai báo lý do thẩm định.
5. **Quan sát:** pipeline telemetry sẵn có tự đếm `read_attachment` — không gửi nội
   dung tệp; theo dõi tỉ lệ outcome `skipped_*` qua feedback.
6. **Rollback:** mỗi GĐ revert độc lập; Store hỏng → nhánh suy biến in-memory (3.1);
   xấu nhất revert GĐ 2 vẫn còn giá trị GĐ 1.

## 07 · Rủi ro chính và phòng bị

| Rủi ro | Phòng bị |
|---|---|
| pdf.js render ngốn bộ nhớ SW, Chrome kill worker | Hàng đợi tuần tự một-tài-liệu; trần pixel chia trang; đo fixture 100 trang ở GĐ 4 |
| mammoth kích thước/CSP | Bản browser thuần vendored như pdfjs; không remote script |
| IndexedDB hỏng/quota | Nhánh suy biến in-memory + toast; unlimitedStorage đã có; đếm dung lượng trong Settings |
| Nonce làm vỡ guard/compaction cũ | Chèn sau prefix cố định + test khẳng định prefix |
| Đổi provider giữa lúc chip pending → làn sai | Làn tính tại thời điểm gửi; chip chỉ cảnh báo dự kiến; QA case riêng |
| Repo tiến hóa nhanh (HEAD đổi trong lúc lập kế hoạch) | Neo theo tên hàm/module; rebase từng GĐ; không chạm file dở ngoài phạm vi |
| Lệch parity Firefox | Mirror trong từng PR; pipeline không cần CDP |

## 08 · Ước lượng tổng

| Hạng mục | Ước lượng (1 kỹ sư) |
|---|---|
| GĐ 0 → GĐ 5 (gồm test đơn vị theo GĐ) | 8.5 – 11.5 ngày |
| Di trú screenshot store (sau GĐ 3) | 1 ngày |
| Dịch 23 ngôn ngữ (~15 khóa), docs, CHANGELOG | 1 ngày |
| QA tay theo ma trận + sửa lỗi vòng cuối | 2 ngày |
| **Tổng đến phát hành** | **≈ 12.5 – 15.5 ngày (~3 tuần lịch)** |

Điểm cắt giá trị sớm: sau GĐ 1 (ngày 2–3) đã có thể phát hành bản vá "PDF chạy trên
mọi provider".
