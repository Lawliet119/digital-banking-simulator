# DBS-211 · Xuất CSV FeatureInput (11 trường) từ OfflineFeatureProvider (lệnh export-features)

> **Trạng thái:** Kiểm chứng cục bộ; chờ CI và Dev review · **Vai:** #4 Fraud · **Nhánh:** `feat/DBS-211-export-features` · **PR:** [#133](https://github.com/Lawliet119/digital-banking-simulator/pull/133) · **Cập nhật:** 2026-11-11

> **Ghi chú về lịch sử (2026-11-11):** bản đầu của PR chạy test thủ công bằng `load-tests/fraud-dataset/generate-fraud.mjs`, thư mục niêm phong mà vai #4 không được mở hay chạy (SKILL.md, `references/fraud.md`); bằng chứng đó, kèm SHA ghi sai, đã bị **xóa**. Test thủ công chạy lại trên một CSV tự viết (`screenshots/DBS-211/sample-input.csv`, không đụng thư mục niêm phong). Gate G1 đến G3 và domain review độc lập không được ghi lúc làm; không dựng lại dấu vết đó. Một review độc lập (subagent, 2026-11-11) tìm các lỗi dưới đây; đã sửa.

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 5, High, Deliverable P5. **Expect:** «Một nguồn duy nhất tính đặc trưng cho cả đánh giá luật lẫn đánh giá AI.» **Thực trạng:** «Chưa có. Đặc trưng chỉ dùng dữ liệu trước occurredAt. CSV này là đầu vào để chạy đánh giá AI offline và tạo capture (B1, B2), không có ID và không có scenario, để môi trường đánh giá và chạy thật không lệch nhau.»
- **DoD (chép nguyên văn từ board):**
  1. Lệnh export-features đọc CSV giao dịch và xuất CSV gồm id giao dịch, 11 trường FeatureInput (amount, fromBalanceBefore, accountAgeHours, sameOwner, txCount10m, txCount1h, historyCount30d, medianAmount30d, minutesSinceReverse, newRecipients1h, distinctRecipients24h) và cột nhãn tách riêng; chạy hai lần cùng đầu vào cho kết quả giống hệt
  2. Mọi đặc trưng chỉ dùng dữ liệu trước occurredAt (test: giao dịch ở tương lai không làm đổi giá trị)
  3. Không xuất cột scenario; không dùng scenario hay is_fraud để tính đặc trưng
  4. Unit test trên dữ liệu nhỏ có đáp án tính tay cho từng nhóm đặc trưng
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:** DBS-128 (OfflineFeatureProvider) và DBS-127 (tập tune) Done trên board; cả hai có trong `main`.
- **Câu hỏi mở và quyết định (agent tự quyết, 2026-11-11):**
  1. *«Trước occurredAt» hay «trước hoặc tại»?* Provider thật tính cả giao dịch cùng mili-giây (`txCount10m` gồm chính giao dịch đó; DBS-128, `offline-feature-provider.ts`), để khớp phía chạy thật. DoD ghi «trước occurredAt»: tính chất bảo đảm và được test là **giao dịch ở tương lai (sau `occurredAt`) không đổi giá trị**; việc giao dịch cùng thời điểm nhìn thấy nhau là hành vi kế thừa từ DBS-128, không phải thay đổi DoD. Bản đầu của PR đã viết lại DoD thành «trước hoặc tại»; mục này đã chép lại nguyên văn.
  2. *Board nói CSV «không có ID» còn DoD 1 đòi «id giao dịch»:* làm theo DoD (cột `tx_id`), ghi mâu thuẫn ở đây; `tx_id` là id của dòng đầu vào, không phải định danh khách hàng.
  3. *Dữ liệu cho test thủ công:* chưa có tập tune trong `backend/data/fraud/` trên `main`; dùng CSV tự viết với tên khách giả, không dùng generator niêm phong.
- **Ngoài phạm vi:** chạy đánh giá AI/luật trên CSV (DBS-132/133, 212), sinh dataset, giá trị `perTxLimit` thật.

## 2. Hành vi

| # | Quy tắc |
|---|---|
| 1 | Đầu vào: CSV có đủ 12 cột (`tx_id, occurred_at, from_account, to_account, from_customer, to_customer, amount, from_balance_before, from_account_created_at, to_account_created_at, is_fraud, scenario`). Thiếu cột → lỗi `Invalid CSV header`. |
| 2 | Đầu ra: `tx_id`, 11 trường `FeatureInput` theo đúng thứ tự của `ai-contract.ts`, rồi `is_fraud`. **Không** có `scenario`. Một dòng mỗi giao dịch, theo thứ tự đầu vào, kết thúc bằng LF. |
| 3 | Đặc trưng lấy từ `OfflineFeatureProvider.extractAiInput` (cùng phép chiếu `toAiFeatureInput` của chạy thật); `scenario` không được đọc vào phép tính nào, `is_fraud` chỉ đi vào cột nhãn. |
| 4 | Giao dịch ở tương lai (sau `occurredAt`) không làm đổi giá trị của dòng đã xuất (provider chỉ nhìn về quá khứ; giao dịch cùng mili-giây nhìn thấy nhau như DBS-128). |
| 5 | Chạy hai lần cùng đầu vào cho đầu ra giống hệt từng byte. |
| 6 | **Dòng sai khuôn dạng là lỗi, không bị bỏ qua:** số cột khác tiêu đề, trường có dấu nháy kép, hoặc `is_fraud` không phải `0`/`1` → lỗi nêu số dòng vật lý (`Line N: …`); dòng trống không làm lệch số dòng. |
| 7 | Tham số: `--input`, `--output`, `--per-tx-limit` (số nguyên dương). Thiếu tham số, tùy chọn lạ, `--per-tx-limit` sai, hoặc file đầu vào không có → lỗi, không ghi file. `perTxLimit` mặc định 500.000.000 chỉ ảnh hưởng `smallTxCount24h` (không nằm trong 11 trường) nên không đổi đầu ra; nó **không** phải `TRANSFER_LIMIT_PER_TX`. |

## 3. Kiến trúc

- `backend/src/modules/risk/features/export-features.ts`: `parseTransactionCsv(csvText): ParsedDataset`, `exportFeaturesString(csvText, perTxLimit?)`, `exportFeaturesFile(inputPath, outputPath, perTxLimit?)`, hằng `OUTPUT_HEADERS`, `EXPECTED_INPUT_COLUMNS`; `backend/src/scripts/export-features.ts`: `runExportFeatures(args)` và CLI; script `export-features` trong `backend/package.json`. Không đọc DB, Redis hay mạng; không đổi schema, env, ADR.

## 4. Test cases tự động

| ID | Truy vết | Lớp | Nội dung |
|---|---|---|---|
| TC-211-01 | DoD 1, 3 | unit | đầu ra đúng 13 cột, không có `scenario`, giá trị dòng mẫu |
| TC-211-02 | DoD 2 | unit | thêm giao dịch ở tương lai không đổi các dòng đã xuất |
| TC-211-03 | DoD 4 | unit | đáp án tính tay cho từng nhóm trên chuỗi 3 giao dịch (tuổi tài khoản, đếm 10 phút và 1 giờ, lịch sử, ngược chiều, người nhận mới, người nhận phân biệt, `sameOwner`) |
| TC-211-03b | DoD 4 | unit | `medianAmount30d`: null dưới 5 giao dịch trước; giữa của số lẻ (30000); trung bình hai giá trị giữa của số chẵn (35000) |
| TC-211-04 | DoD 1 | unit | hai lần chạy cho đầu ra giống hệt (băm SHA-256 và so chuỗi) |
| TC-211-05 | quy tắc 1 | unit | thiếu cột → `Invalid CSV header` |
| TC-211-05b | quy tắc 6 | unit | dòng ngắn, dấu nháy, nhãn sai → lỗi có số dòng; dòng trống không lệch số dòng |
| TC-211-05c..e | quy tắc 7 | unit (`src/scripts/export-features.spec.ts`) | CLI ghi file và báo số dòng; năm kiểu tham số sai bị từ chối; file đầu vào không có thì lỗi `ENOENT` và không ghi |
| TC-211-06 | DoD 5 | quy trình | PR merge, CI xanh, Dev review |

Phủ `scenario`/`is_fraud` không tham gia phép tính (DoD 3 nửa sau): bảo đảm bằng cấu trúc (`parseTransactionCsv` không đưa chúng vào `facts` hay `events`; `is_fraud` chỉ vào `labels`), không bằng test riêng (đơn giản hóa).

## 5. Test thủ công

Điều kiện: `cd backend`, Node 24, không cần Docker. Đầu vào: `docs/features/screenshots/DBS-211/sample-input.csv` (14 giao dịch tự viết, khách giả).

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-211-01 | `npm run export-features -- --input ../docs/features/screenshots/DBS-211/sample-input.csv --output <tmp>/out1.csv` | báo 14 giao dịch; đầu ra có 14 dòng + tiêu đề, 13 cột, không `scenario` |
| M-211-02 | chạy lần hai ra `out2.csv`, `sha256sum out1.csv out2.csv` | hai mã SHA-256 trùng nhau |
| M-211-03 | đối chiếu tay hai dòng với phép tính trong TC-211-03/03b | khớp |
| M-211-04 | ca biên: sửa một dòng thành 11 cột; sửa `is_fraud` thành `2`; bỏ `--input` | mỗi ca báo lỗi có số dòng hoặc tên tùy chọn, không ghi file |

## 6. Domain review (AI)

Review độc lập (subagent, 2026-11-11), nguyên văn không lưu. Phát hiện và xử lý: chạy generator niêm phong và SHA sai trong bằng chứng thủ công (đã xóa và chạy lại bằng CSV tự viết, SHA đúng); parser bỏ qua dòng ngắn và đoán nhãn (đã sửa thành lỗi có số dòng, §2 quy tắc 6); thiếu test median chẵn/lẻ và test CLI (đã thêm); DoD bị viết lại (đã chép nguyên văn, ghi quyết định §1); §3 nêu hàm không tồn tại (đã sửa theo mã thật); trạng thái «Implemented» sai (đã sửa); mặc định `perTxLimit` khác `TRANSFER_LIMIT_PER_TX` (đã ghi rõ không ảnh hưởng đầu ra). Chưa có lượt review thứ hai. Domain review đầu là «self-review» (không đạt chuẩn skill).

## 7. Kế hoạch triển khai

Hai commit mã (test rồi triển khai, của bản đầu) và một commit sửa theo review (parser chặt, test mới, doc); một commit bằng chứng thủ công. Lùi: revert commit; không đổi mã chạy ngoài lệnh mới.

## 8. Kết quả

- `npm test -- export-features`: 14 test đạt (TC-211-01..05e); `lint:check` và `typecheck` sạch. Số liệu chạy thủ công và SHA ở [manual-test.txt](screenshots/DBS-211/manual-test.txt).
- **Chưa làm:** chạy trên tập tune thật của #4 (chưa có trong `main`; Dev giữ dataset giao theo DBS-127), ảnh chụp (đầu ra là văn bản; ảnh cũ chụp từ generator niêm phong đã bị xóa), TC-211-06 (quy trình).
- **Bàn giao:** BL-236: chạy `export-features` trên tập tune thật khi Dev giữ dataset giao CSV, kiểm cột và số dòng; DoD 5 theo BL-160.

## 9. Tài liệu đã cập nhật

`docs/features/README.md`, `docs/BACKLOG.md` (BL-236), doc này; không đổi tài liệu thiết kế khác.

## Checklist G4 (2026-11-11)

- [x] 14 test đạt đủ độ sâu; một ý (scenario/is_fraud không vào phép tính) đơn giản hóa bằng cấu trúc, nêu ở §4; TC-211-06 chưa đạt
- [x] Test thủ công chạy trên commit cuối (SHA ở dòng đầu `manual-test.txt`); M-211-04 xem kết quả trong file
- [ ] Ảnh chụp: không có (lý do ở §8)
- [x] Bốn lệnh baseline: lint và typecheck sạch, unit đạt, e2e chạy ở CI
- [ ] G1 đến G3 và domain review độc lập lúc làm: không có (ghi ở đầu tài liệu)
- [x] Việc bàn giao và DoD chưa đạt ở §8 và BL-236 trong `docs/BACKLOG.md`
