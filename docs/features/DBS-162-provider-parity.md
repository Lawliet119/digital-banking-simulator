# DBS-162 · Test so khớp OnlineFeatureProvider và OfflineFeatureProvider

> **Trạng thái:** Kiểm chứng cục bộ; chờ CI và Dev review · **Vai:** #4 Fraud · **Nhánh:** `feat/DBS-162-provider-parity` · **PR:** [#142](https://github.com/Lawliet119/digital-banking-simulator/pull/142) · **Cập nhật:** 2026-11-11

> **Ghi chú về lịch sử (2026-11-11):** bản đầu của PR chỉ so khớp vài chục giao dịch (DoD 1 yêu cầu «vài nghìn»), chưa có ca biên cửa sổ thời gian, ghi SHA không tồn tại, sửa timeout toàn cục của `jest-db.js` ngoài phạm vi, và tự ghi «Implemented» trước khi có CI. Một review độc lập (subagent, 2026-11-11) chỉ ra điều đó; bản này thêm TC-162-07 (2.400 giao dịch), bỏ các sửa timeout, chạy lại bằng chứng trên commit thật. G1 đến G3 và domain review độc lập lúc làm bản đầu không được ghi; không dựng lại dấu vết đó.

## 1. Bối cảnh

- **Task:** DBS-162 (Task, Tuần 6, High, P5). **Thực trạng:** «Kết quả đánh giá offline chỉ đáng tin nếu phản ánh đúng hành vi online.» **Expect:** «Offline và online cho cùng đặc trưng trên cùng dữ liệu.»
- **DoD (chép nguyên văn từ board):**
  1. Đưa cùng chuỗi giao dịch (vài nghìn) qua cả hai provider (Online với Postgres/Redis thật) → đặc trưng và kết quả luật giống hệt
  2. Chạy trong CI; khác biệt được giải thích hoặc sửa
  3. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
  4. Test so khớp cả phép chiếu FeatureInput giữa Online và Offline; thống nhất median khi lịch sử < 5 lệnh (Features trả null, FeatureInput yêu cầu (historyCount30d == 0) ⇔ (median == null))
- **Phụ thuộc:** DBS-128 (`OfflineFeatureProvider`) và DBS-109 (`OnlineFeatureProvider`) đã có trên `main`.
- **Quyết định (agent tự quyết):**
  - «Postgres/Redis thật»: `OnlineFeatureProvider` hiện tính đặc trưng từ view PostgreSQL `v_transfer_facts` và không đọc Redis (Redis chỉ là mốc phủ trong cache); test dùng **PostgreSQL thật**, không dựng Redis. Phần Redis ghi ở BL-238.
  - Cùng mili-giây: giao dịch trùng `occurredAt` tới mili-giây thấy nhau ở cả hai provider (khớp DBS-128 và DBS-109); TC-162-07 có hai giao dịch cùng mili-giây.
  - Điểm luật: so `ScoringService.score` với cấu hình seed v1 (`rule_only`), nên so sánh là «kết quả luật», không có AI.
- **Ngoài phạm vi:** đo hiệu năng, so khớp trên tập tune thật (BL-238), sửa `OnlineFeatureProvider`/`OfflineFeatureProvider`.

## 2. Hành vi

Với mọi giao dịch trong chuỗi, hai provider trả cùng:

1. `Features` (9 trường: `txCount10m`, `txCount1h`, `historyCount30d`, `medianAmount30dTimes2`, `reverseTransferOccurredAt`, `newRecipients1h`, `distinctRecipients24h`, `sumOut24h`, `smallTxCount24h`);
2. kết quả `ScoringService.score` (cùng `hits`, `ruleScore`, `level`) trên cấu hình seed v1;
3. `FeatureInput` (11 trường): `toAiFeatureInput(event, onlineFeatures)` bằng `offline.extractAiInput(event)`;
4. median: `historyCount30d < 5` thì `medianAmount30dTimes2 = null` và `FeatureInput.medianAmount30d = null`; từ 5 trở lên cùng giá trị chính xác;
5. giao dịch `REJECTED` bị bỏ qua ở cả hai.

## 3. Kiến trúc

`backend/test/services/feature-provider-parity.services-spec.ts` (PostgreSQL thật qua `createTempDatabase`, `TransferFixture`, `OnlineFeatureProvider` + `TransferFacts` và `OfflineFeatureProvider`); `backend/test/manual/provider-parity.manual.ts` (kịch bản chạy tay 30 giao dịch); `.github/workflows/ci.yml` (một bước trong job `e2e`). Không đổi mã chạy.

## 4. Test cases tự động

| ID | Truy vết | Nội dung |
|---|---|---|
| TC-162-01 / 02 / 03 | DoD 1, DoD 4 | một chuỗi đa dạng (bình thường, đảo chiều, người nhận mới, lệnh nhỏ): Features, điểm luật và FeatureInput giống hệt (một `it` gộp ba kiểm tra) |
| TC-162-04 | DoD 4 | `historyCount30d < 5`: cả hai trả `null`, FeatureInput `null` |
| TC-162-05 | DoD 1 | lệnh `REJECTED` bị bỏ qua ở cả hai |
| TC-162-06 | DoD 1 | 45 giao dịch đa tài khoản trong 15 ngày, so 10 lệnh cuối |
| TC-162-07 | DoD 1 | **2.400 giao dịch** (PRNG cố định) giữa 12 tài khoản trong 29 ngày + biên 10 phút, 1 giờ, 24 giờ, 30 ngày (đúng ±1 ms) + lệnh cùng mili-giây + lệnh đảo chiều; so hơn 400 sự kiện (mỗi sự kiện thứ 8 và 120 sự kiện cuối); khẳng định thêm có luật bị kích hoạt và median có giá trị để phép so sánh không rỗng |
| TC-162-08 | DoD 2 | CI chạy suite này (job `e2e`, bước «Online and Offline FeatureProvider parity (DBS-162)») |
| TC-162-09 | DoD 3 | PR merge, CI xanh, Dev review |

## 5. Test thủ công

| Bước | Lệnh | Kỳ vọng |
|---|---|---|
| M-162-01 | `DATABASE_URL=postgres://… npx ts-node -r tsconfig-paths/register test/manual/provider-parity.manual.ts` trên PostgreSQL thật | `30/30 transfers with 100% parity` |
| M-162-02 | `npx jest --config ./test/jest-db.js --testRegex test/services/feature-provider-parity.services-spec.ts --runInBand` (Testcontainers cấp DB) | 5/5 test đạt |

## 6. Domain review (AI)

Review độc lập (subagent, 2026-11-11), nguyên văn không lưu. Phát hiện và xử lý: DoD 1 «vài nghìn» chưa đạt (đã thêm TC-162-07, 2.400 giao dịch); thiếu ca biên cửa sổ và cùng mili-giây (đã thêm); sửa timeout toàn cục ngoài phạm vi (đã bỏ; TC-116-18 sửa riêng ở #145); SHA không tồn tại và tự ghi «Implemented» (đã sửa); «Redis thật» chưa đạt (BL-238). Chưa có lượt review thứ hai. Self-review đầu bị loại.

## 7. Kế hoạch triển khai

| Bước | File | Nội dung |
|---|---|---|
| 1 | `feature-provider-parity.services-spec.ts` | TC-162-01..06 (bản đầu) và TC-162-07 (bản sửa) |
| 2 | `ci.yml`, `provider-parity.manual.ts` | CI và kịch bản chạy tay |
| 3 | doc này, `screenshots/DBS-162/manual-test.txt` | bằng chứng trên commit cuối |

Lùi: revert PR; không đổi mã chạy.

## 8. Kết quả

- Suite: 5 test đạt trên PostgreSQL thật; kịch bản chạy tay: 30/30 giao dịch khớp; lint và typecheck sạch.
- **Chưa đạt / chưa làm:** Redis thật (BL-238); ảnh chụp (đầu ra là văn bản; ảnh cũ ghi SHA cũ đã bị xóa); review độc lập thứ hai; DoD 3.
- Mọi lần so sánh đều khớp: không có khác biệt cần giải thích hay sửa.
- **Bàn giao:** BL-238.

## 9. Tài liệu đã cập nhật

`.github/workflows/ci.yml` (một bước), `docs/features/README.md`, `docs/BACKLOG.md` (BL-238), doc này.

## Checklist G4 (2026-11-11)

- [x] 7 kiểm tra tự động đạt đủ độ sâu; «Redis thật» là đơn giản hóa (BL-238)
- [x] Test thủ công trên commit cuối (SHA ở dòng đầu `manual-test.txt`)
- [ ] Ảnh chụp: không có (lý do ở §8)
- [ ] G1 đến G3 và domain review độc lập lúc làm: không có (ghi ở đầu tài liệu)
- [x] Bàn giao và DoD chưa đạt ở §8 và BL-238
