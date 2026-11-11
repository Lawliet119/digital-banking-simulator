# RSK-06 · Test runtime của cổng bật AI: đua quyết định, rollback, quyền, cô lập khách, chuyển cấu hình

> **Trạng thái:** Kiểm chứng cục bộ; chờ CI và Dev review (phần cache TTL 60 giây với Redis thật chưa làm: BL-239) · **Vai:** Dev · **Nhánh:** `test/RSK-06-ai-runtime-gating` · **PR:** [#141](https://github.com/Lawliet119/digital-banking-simulator/pull/141) · **Cập nhật:** 2026-11-11

> **Ghi chú về lịch sử (2026-11-11):** bản đầu của PR có bốn test, trong đó ba cái lặp lại test đã có trên `main` (TC-111-10, TC-111-15, TC-RSK01-08), cái đua worker chỉ khẳng định «nhiều nhất một cờ», và không test nào đi qua đường AI (rule set vẫn là `rule_only`). Một review độc lập (subagent, 2026-11-11) chỉ ra điều đó; bản này giữ ba test thực sự mới và trỏ tới các test cũ cho phần còn lại. G1 đến G3 và domain review độc lập lúc làm bản đầu không được ghi; không dựng lại dấu vết đó.

## 1. Bối cảnh

- **Task trên board:** Story, Tuần 7, High, P5. **Thực trạng:** «Cổng bật AI của ADR-14 đòi test chạy thật trên PostgreSQL và SQS; chưa có test nào cho các tình huống này.» **Expect:** «Biết chắc quyết định không đổi, không trùng và không lộ khi hai worker đua hoặc cấu hình đổi giữa chừng.»
- **DoD (chép nguyên văn từ board):**
  1. Hai worker đua cùng event, khác event cùng transfer và khác mode: đúng một risk_decisions và một cờ; LOW và rule_only không bị chấm lại
  2. Rollback khi SQL hoặc audit lỗi thì không ack; ack chỉ sau commit; audit tạo cờ đúng một lần
  3. dbs_worker không UPDATE hoặc DELETE được risk_decisions; khách không thấy cờ, aiAssessment hay risk_decisions ở mọi endpoint customer
  4. Chuyển cấu hình rule_only và rules_with_external_ai trong lúc cache TTL 60 giây và có request đang bay: kết quả đúng, không lỗi 500
  5. Redis chết thì đặc trưng vẫn đúng (dự phòng SQL); log không chứa body, khóa hay Authorization
  6. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:** RSK-01 (#123), RSK-02 (#129), DBS-122 có trên `main`; DBS-131 ghi `In Review` trên board (đã có trên `main`).
- **Đã có trên `main` (không viết lại):**
  - DoD 1, hai worker và khác event cùng transfer: TC-111-04, TC-111-05, TC-111-06, TC-RSK01-04a/b/c.
  - DoD 2: TC-111-09 (lỗi quy tắc: rollback, thử lại, dead-letter ở lần nhận thứ 5), TC-111-10 (audit lỗi: rollback claim, quyết định, cờ), TC-101-01 và TC-101-03 (`ConsumerBase`: báo xong sau commit; lỗi sau tác dụng thì rollback cả tác dụng và claim), TC-124-02 (consumer chết sau commit trước khi xóa: nhận lại, vẫn một quyết định, một cờ), TC-134-11 (lần thử lỗi rollback, nhận lại cùng id).
  - DoD 3 phần `dbs_worker`: TC-111-15, TC-RSK01-08.
  - DoD 5: TC-111-11 (Redis cấu hình hỏng, đặc trưng vẫn từ SQL), «keeps request, credential and rubric out of real SafeLogger output» trong `risk-scoring-ai-mode.db-spec.ts` (RSK-02).
- **Phần mới của task này** (`backend/test/db/risk-runtime-gating.db-spec.ts`, ba test): chuyển cấu hình giữa chừng (DoD 4, trừ cache Redis), quyết định không bị làm lại khi chế độ đổi, kể cả LOW (DoD 1, phần «khác mode»), và khách không thấy gì ở mọi endpoint customer (DoD 3, phần khách).
- **Quyết định (agent tự quyết):** `risk_rule_sets` là append-only nên ba test dùng chung một database và chạy theo thứ tự; AI được thay bằng một stub trả `UNAVAILABLE` (có provider, model, SHA như đường outage thật) vì kết quả nhà cung cấp đã có test ở RSK-02; «mọi endpoint customer» là sáu route GET customer thật của `deposit-app` (không có `/v1/admin/risk-config` vì app test không gắn module đó).
- **Ngoài phạm vi:** cache TTL 60 giây với Redis thật (BL-239), SQS thật (đường chạy tay ở DBS-101), model AI thật.

## 2. Hành vi

| # | Điều kiện | Kết quả |
|---|---|---|
| S1 | sáu request đang chạy (đã đọc rule set v1 `rule_only`) khi v2 `rules_with_external_ai` được thêm; sáu request sau đó | sáu đầu: v1, `rule_only`, không gọi AI; sáu sau: v2, `rules_with_external_ai`, `UNAVAILABLE`, gọi AI sáu lần; không request nào lỗi; mỗi transfer đúng một quyết định, một cờ, một audit |
| S2 | sau khi chuyển, hai event mới cho cùng transfer đã quyết (một đã gắn cờ, một LOW), chạy song song | không chấm lại (`score` không được gọi), không gọi AI, quyết định không đổi, vẫn một cờ và một audit (hoặc không cờ với LOW) |
| S3 | khách gửi và nhận của hai transfer đã gắn cờ (một `rule_only`, một AI) gọi mọi GET customer | 200 và không chuỗi nào về cờ, AI, điểm, quy tắc hay quyết định; GET route operator trả 403 |

## 3. Kiến trúc

Chỉ test: `backend/test/db/risk-runtime-gating.db-spec.ts` (PostgreSQL thật qua Testcontainers, ứng dụng thật qua `startDepositApp`, `RiskScoringConsumer` dựng bằng `buildRiskConsumer`). Không đổi mã chạy, schema, CI (`test:db` đã chạy `test/db`).

## 4. Test cases tự động

| ID | Truy vết | Nội dung |
|---|---|---|
| TC-RSK06-01 | DoD 4 | S1 |
| TC-RSK06-02 | DoD 1 (khác mode, LOW và rule_only không bị chấm lại) | S2 |
| TC-RSK06-03 | DoD 3 (khách) | S3 |
| TC-RSK06-04 | DoD 1, 2, 3, 5 | tham chiếu các test cũ nêu ở §1, không viết lại |
| TC-RSK06-05 | DoD 6 | CI xanh, Dev review, PR merge |

## 5. Test thủ công

Suite chỉ là test tự động. Bước duy nhất: `cd backend && npm run test:db -- test/db/risk-runtime-gating.db-spec.ts` trên commit cuối, chạy hai lần liên tiếp (kiểm không nháy); kết quả ở `screenshots/RSK-06/manual-test.txt`, SHA ở dòng đầu.

## 6. Domain review (AI)

Review độc lập (subagent, 2026-11-11), nguyên văn không lưu. Phát hiện và xử lý: ba test lặp lại test cũ (đã bỏ, ghi tham chiếu); test đua worker chỉ khẳng định «nhiều nhất một cờ» (nay nằm trong TC-111-05); không test nào đi qua đường AI (TC-RSK06-01 dùng rule set AI thật, AI là stub); DoD 4 và «khác mode» chưa có (đã thêm); DoD thiếu hai dòng (Redis, log) trong bản đầu (đã chép đủ); cache TTL với Redis thật chưa làm (BL-239). Chưa có lượt review thứ hai. Self-review đầu bị loại.

## 7. Kế hoạch triển khai

Một commit viết lại spec, một commit doc và bằng chứng. Lùi: revert, không đổi mã chạy.

## 8. Kết quả

- 3 test đạt trên PostgreSQL thật; lint và typecheck sạch.
- **Chưa làm:** cache TTL 60 giây với Redis thật (BL-239); SQS thật; ảnh chụp (đầu ra là log test); review độc lập thứ hai; DoD 6.
- **Bàn giao:** BL-239.

## 9. Tài liệu đã cập nhật

`docs/features/README.md`, `docs/BACKLOG.md` (BL-239), doc này, `screenshots/RSK-06/domain-review.md`.

## Checklist G4 (2026-11-11)

- [x] 3 test mới đạt đủ độ sâu; các phần còn lại của DoD dựa vào test có sẵn (đơn giản hóa nêu ở §1)
- [x] Test thủ công trên commit cuối (SHA ở dòng đầu `manual-test.txt`)
- [ ] Ảnh chụp: không có (lý do ở §8)
- [ ] G1 đến G3 và domain review độc lập lúc làm: không có (ghi ở đầu tài liệu)
- [x] Bàn giao và DoD chưa đạt ở §8 và BL-239
