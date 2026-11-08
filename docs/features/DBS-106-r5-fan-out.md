# DBS-106 · R5 fan-out

> **Status:** Đang triển khai · **Vai:** #4 Fraud · **Nhánh:** `feat/DBS-105-r4-r6-scoring` · **PR:** chưa tạo

## 1. Bối cảnh

Task tuần 4, P5, vai #4 Fraud, board To Do; Expect: «R5 đúng và miễn đúng cho chuyển giữa hai tài khoản cùng chủ.» DoD nguyên văn:

1. Hàm thuần nhận số người nhận mới và cờ sameOwner; sameOwner = true thì không kích hoạt
2. Test: 4 và 5 người nhận mới, người nhận cũ không tính, ngoài cửa sổ, sameOwner
3. explanation nêu số người nhận mới và ngưỡng
4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ

DBS-59 Done.

G1 (agent tự quyết): rule chỉ đánh giá `newRecipients1h` do provider cấp. Người nhận cũ và cửa sổ cần provider/SQL thật (DBS-109/128), chưa coi là đã chứng minh.

## 2. Hành vi

Chỉ TRANSFER; count phải là số nguyên an toàn không âm, sameOwner phải là boolean. Khi rule bật, `!sameOwner && newRecipients1h >= minNewRecipients` thì hit. `windowMinutes=60`, `noveltyDays=30` phải khớp feature hiện có, config sai ném lỗi. Explanation nêu count và threshold; count vẫn là dữ liệu hành vi nhạy cảm.

## 3. Kiến trúc

`R5FanOutRule` là class `RiskRule` đồng bộ, không Redis/SQL/clock/I/O; không sửa event hay schema.

## 4. Test cases

| ID | Mức | Điều kiện / kết quả |
|---|---|---|
| TC-106-01 | unit | Count 4 → null, 5 → R5, sameOwner → null; explanation nêu count/ngưỡng. |
| TC-106-02 | unit | Config, count, sameOwner sai → lỗi; rule tắt và DEPOSIT → null. |
| TC-106-03 | tích hợp | Provider loại người nhận cũ và event ngoài cửa sổ: chưa chạy, cần DBS-109/128. |
| TC-106-04 | quy trình | CI, Dev review, merge: chưa xảy ra. |

## 5. Manual

`npx ts-node -r tsconfig-paths/register test/manual/r3-r6.manual.ts` từ `backend/`: M-106-01 kiểm 4/5 và sameOwner; M-95/105/106/107-02 kiểm DEPOSIT.

## 6. Review

[Review độc lập R5/R6](screenshots/DBS-106/domain-review.md) không phát hiện lỗi trên code được cung cấp; lưu ý quyền đọc explanation và provider chưa tích hợp. Không thay Dev review.

[Review sau implementation](screenshots/DBS-106/post-implementation-review.md): **APPROVE phạm vi thu hẹp** trên code/test cung cấp; không chạy lại test, không thay Dev review.

**G2 kiểm lại sau code (agent tự quyết):** reviewer model `default` kết luận approve phạm vi thu hẹp, không blocker còn nêu trong code được cung cấp; provider và Dev review không nằm trong kết luận đó. Đây không phải review đã chạy trước implementation.

## 7. Kế hoạch và độ lệch

Test trước class, xác nhận module thiếu rồi implement và chạy lại; provider là handoff. Code/test có trước tài liệu này; review độc lập được bổ sung sau đó, không nhận đã review thiết kế trước code.

| Bước | File | Test trước / đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|
| R5 thuần | `rules/r5-fan-out.rule.ts` | `r5-fan-out.rule.spec.ts`, module chưa tồn tại | `npm test -- --runInBand src/modules/risk/rules/r5-fan-out.rule.spec.ts` | `f536209` |
| Non-TRANSFER và manual | `rules/transfer-only.spec.ts`, `test/manual/r3-r6.manual.ts` | DEPOSIT trước guard: rule mới trả hit | `npx ts-node -r tsconfig-paths/register test/manual/r3-r6.manual.ts` | `f536209` |

Sweep sau implementation: test người nhận cũ/cửa sổ thật phụ thuộc provider, quy trình chưa xong, bàn giao BL-185; rollback bằng revert commit code. Việc lập/review kế hoạch sau code là độ lệch ghi tại §8.

**G3 kiểm lại sau code (agent tự quyết):** sweep đã đối chiếu từng DoD với unit/manual hoặc handoff BL-185, ghi rủi ro và cách revert ở trên. Phạm vi thu hẹp có thể công bố ở Draft; sai lệch thứ tự được ghi §8.

## 8. Kết quả và bàn giao

- Xác minh trên code cuối `183014c`: `lint:check`, `typecheck`, `build` đạt; unit toàn backend **80 suite / 1.584 test**, e2e **15 suite / 153 test** đạt trên PostgreSQL/Valkey cô lập. E2e này không chứng minh fraud runtime; DB suite **43 / 735** chạy trong quá trình, trước fix projection/R2 cuối, không đổi schema.
- TC-106-01/02: **đạt** qua `r5-fan-out.rule.spec.ts` và `transfer-only.spec.ts`; TC-106-03: **chưa làm**, chưa có provider tính người nhận cũ/cửa sổ; TC-106-04: **chưa đạt**, CI/Dev review/merge chưa xảy ra. Theo dõi [BL-185](../BACKLOG.md).
- Manual trên commit code cuối: `npx ts-node -r tsconfig-paths/register test/manual/r3-r6.manual.ts`; M-106-01 count 4 → null, 5 → hit, sameOwner → null; M-95/105/106/107-02 DEPOSIT → null. [Output thật](screenshots/DBS-106/manual-test.txt), [ảnh terminal](screenshots/DBS-106/01-rules.png). Count là input tổng hợp, không chứng minh lịch sử thực.
- Độ lệch: code/test được viết trước feature doc và review thiết kế; review được thực hiện sau, không coi là đã hoàn thành theo đúng thứ tự G2/G3. Quyết định sau đó: giữ PR ở Draft, bàn giao rõ review quy trình và các phần chưa chứng minh; không tuyên bố hoàn thành DoD.

## 9. Tài liệu

Đã cập nhật `backend/src/modules/risk/README.md`, `docs/features/README.md`, `docs/BACKLOG.md` (BL-185) và guide lỗi theo ADR-14.
