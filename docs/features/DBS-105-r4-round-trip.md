# DBS-105 · R4 chuyển vòng

> **Status:** Implemented (hàm thuần R4); truy vấn SQL, lọc REJECTED và EXPLAIN thuộc DBS-109 (gốc: PR #100 của easterlywind, đưa vào main qua PR rebase của techlead) · **Vai:** #4 Fraud · **Nhánh:** `feat/DBS-105-r4-r6-scoring` · **PR:** xem README feature docs

## 1. Bối cảnh

Task tuần 4, P5, vai #4 Fraud, board To Do; Expect: «R4 đúng và có test đầy đủ.» DoD nguyên văn:

1. Hàm thuần nhận kết quả EXISTS từ FeatureProvider; explanation nêu lệnh ngược cách bao nhiêu phút
2. Test: lệnh ngược trong 1 giờ (kích hoạt), ngoài 1 giờ, lệnh ngược REJECTED không tính, đúng mốc 1 giờ
3. Truy vấn SQL có EXPLAIN dùng index một phần, không Seq Scan
4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ

DBS-59 Done. Vì contract hiện trả timestamp thay vì boolean EXISTS, rule dùng timestamp để vừa quyết định hit vừa ghi số phút; nguồn fact/SQL là handoff, không nhận là đã có.

G1 (agent tự quyết): implement phần rule trên timestamp đã được provider chọn. Không coi fixture là bằng chứng SQL/REJECTED/index; các phần đó giao DBS-109/128, chưa đạt trong PR này.

## 2. Hành vi

Chỉ TRANSFER. `reverseTransferOccurredAt` null → không hit; nếu có, hit khi nằm trong `[occurredAt − reverseWindowMinutes, occurredAt)` với cửa sổ 1–60 phút. Chính xác tới nanosecond; timestamp sai/config sai → lỗi. Explanation nêu số phút xấp xỉ. Provider phải đảm bảo đây là lệnh ngược `COMPLETED` và chỉ lấy lịch sử trước event.

## 3. Kiến trúc

`R4RoundTripRule` dùng `Features` và helper `risk-time.ts`; không tự truy vấn SQL, không sửa DB hay ledger.

## 4. Test cases

| ID | Mức | Điều kiện / kết quả |
|---|---|---|
| TC-105-01 | unit | Trong giờ và đúng 60 phút → hit; ngoài giờ, cùng thời điểm và tương lai → null. |
| TC-105-02 | unit | Biên nanosecond, config cửa sổ/weight, thời gian sai, rule tắt, DEPOSIT. |
| TC-105-03 | tích hợp | Provider loại REJECTED/DEPOSIT và EXPLAIN index: chưa chạy, cần DBS-109/128. |
| TC-105-04 | quy trình | CI, Dev review, merge: chưa xảy ra. |

## 5. Manual

`npx ts-node -r tsconfig-paths/register test/manual/r3-r6.manual.ts` từ `backend/`: M-105-01 so đúng mốc một giờ và quá một nanosecond; M-95/105/106/107-02 kiểm DEPOSIT.

## 6. Review

[Review độc lập R3/R4](screenshots/DBS-105/domain-review.md) lưu ý thời gian xấp xỉ tại biên; implementation ghi «chưa đến 0.01» khi cần, không mô tả 0 phút chính xác. Không thay Dev review.

[Review sau implementation](screenshots/DBS-105/post-implementation-review.md): **APPROVE phạm vi thu hẹp** trên code/test cung cấp; không chạy lại test, không thay Dev review. Review xác nhận bước manual timestamp sai là của R3, còn R4 sai timestamp được kiểm bằng unit.

**G2 kiểm lại sau code (agent tự quyết):** reviewer model `default` kết luận approve phạm vi thu hẹp, không blocker còn nêu trong code được cung cấp; SQL và Dev review không nằm trong kết luận đó. Đây không phải review đã chạy trước implementation.

## 7. Kế hoạch và độ lệch

Viết test trước class, chứng minh lỗi module thiếu rồi implement và chạy lại; test SQL là handoff, không giả lập thành công. Code/test có trước tài liệu này; review độc lập được bổ sung sau đó, không nhận đã review thiết kế trước code.

| Bước | File | Test trước / đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|
| R4 thuần | `rules/r4-round-trip.rule.ts`, `risk-time.ts` | `r4-round-trip.rule.spec.ts`, module chưa tồn tại | `npm test -- --runInBand src/modules/risk/rules/r4-round-trip.rule.spec.ts` | `f536209` |
| Non-TRANSFER và manual | `rules/transfer-only.spec.ts`, `test/manual/r3-r6.manual.ts` | DEPOSIT trước guard: rule mới trả hit | `npx ts-node -r tsconfig-paths/register test/manual/r3-r6.manual.ts` | `f536209` |

Sweep sau implementation: DoD SQL/REJECTED, provider và quy trình chưa được chứng minh, bàn giao BL-185; rollback bằng revert commit code. Việc lập/review kế hoạch sau code là độ lệch ghi tại §8, không giả nhận đã qua trước implementation.

**G3 kiểm lại sau code (agent tự quyết):** sweep đã đối chiếu từng DoD với unit/manual hoặc handoff BL-185, ghi rủi ro và cách revert ở trên. Phạm vi thu hẹp có thể công bố ở Draft; sai lệch thứ tự được ghi §8.

## 8. Kết quả và bàn giao

- Xác minh trên code cuối `2523cc2`: `lint:check`, `typecheck`, `build` đạt; unit toàn backend **80 suite / 1.584 test**, e2e **15 suite / 153 test** đạt trên PostgreSQL/Valkey cô lập. E2e này không chứng minh fraud runtime; DB suite **43 / 735** chạy trong quá trình, trước fix projection/R2 cuối, không đổi schema.
- TC-105-01/02: **đạt** qua `r4-round-trip.rule.spec.ts` và `transfer-only.spec.ts`; TC-105-03: **chưa làm**, provider/SQL chưa có; TC-105-04: **chưa đạt**, CI/Dev review/merge chưa xảy ra. Theo dõi [BL-185](../BACKLOG.md).
- Manual trên commit code cuối: `npx ts-node -r tsconfig-paths/register test/manual/r3-r6.manual.ts`; M-105-01 đúng 60 phút → hit, quá 1 ns → null; M-95/105/106/107-02 DEPOSIT → null và R3 từ chối timestamp sai. [Output thật](screenshots/DBS-105/manual-test.txt), [ảnh terminal](screenshots/DBS-105/01-rules.png). Input tổng hợp, không chạy provider hay SQL.
- Độ lệch: code/test được viết trước feature doc và review thiết kế; review được thực hiện sau, không coi là đã hoàn thành theo đúng thứ tự G2/G3. Quyết định sau đó: giữ PR ở Draft, bàn giao rõ review quy trình và các phần chưa chứng minh; không tuyên bố hoàn thành DoD.

## 9. Tài liệu

Đã cập nhật `backend/src/modules/risk/README.md`, `docs/features/README.md`, `docs/BACKLOG.md` (BL-185) và guide lỗi theo ADR-14.
