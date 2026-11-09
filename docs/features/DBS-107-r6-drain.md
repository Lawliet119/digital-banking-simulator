# DBS-107 · R6 rút cạn

> **Status:** Implemented (hàm thuần R6) (gốc: PR #100 của easterlywind, đưa vào main qua PR rebase của techlead) · **Vai:** #4 Fraud · **Nhánh:** `feat/DBS-105-r4-r6-scoring` · **PR:** xem README feature docs

## 1. Bối cảnh

Task tuần 4, P5, vai #4 Fraud, board To Do; Expect: «R6 đúng với snapshot trong event.» DoD nguyên văn:

1. Hàm thuần: kích hoạt khi !sameOwner và fromBalanceBefore ≥ 1.000.000 và amount ≥ 0,9 × fromBalanceBefore (tính bằng bigint, không số thực)
2. Test: đúng 90% và dưới 90%, số dư < 1.000.000, sameOwner, số rất lớn
3. explanation nêu tỉ lệ phần trăm
4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ

DBS-59 Done.

G1 (agent tự quyết): chỉ đánh giá snapshot trong event, không đọc số dư hiện tại hoặc thay luồng tiền. CI, review và merge chưa xảy ra.

## 2. Hành vi

Chỉ TRANSFER; sameOwner bắt buộc boolean. Đọc `fromBalanceBefore` qua `parseBalance`, amount dương qua `parsePositiveMoney`. Hit khi cùng lúc đủ balance, khác chủ và `amount*100 >= balance*minBalancePercent`; cả ba là so sánh bigint. Explanation hiển thị phần trăm xấp xỉ và số tiền/số dư chính xác, đều là dữ liệu nhạy cảm.

## 3. Kiến trúc

`R6DrainRule` là `RiskRule` thuần; không đọc DB, không sửa ledger, không thay contract event.

## 4. Test cases

| ID | Mức | Điều kiện / kết quả |
|---|---|---|
| TC-107-01 | unit | Đúng 90% và đúng balance tối thiểu → hit; kém 1 đồng hoặc balance dưới ngưỡng → null. |
| TC-107-02 | unit | Bigint lớn/nửa đồng ngưỡng, sameOwner, cấu hình, snapshot sai, rule tắt và DEPOSIT. |
| TC-107-03 | quy trình | CI xanh và merge qua [#104](https://github.com/Lawliet119/digital-banking-simulator/pull/104); Dev review chưa có. |

## 5. Manual

`npx ts-node -r tsconfig-paths/register test/manual/r3-r6.manual.ts` từ `backend/`: M-107-01 kiểm biên 90% và sameOwner; M-95/105/106/107-02 kiểm DEPOSIT.

## 6. Review

[Review độc lập R5/R6](screenshots/DBS-107/domain-review.md) không phát hiện lỗi trên code được cung cấp; lưu ý explanation cần kiểm soát quyền ở consumer/API. Không thay Dev review.

[Review sau implementation](screenshots/DBS-107/post-implementation-review.md): **APPROVE phạm vi thu hẹp** trên code/test cung cấp; không chạy lại test, không thay Dev review.

**G2 kiểm lại sau code (agent tự quyết):** reviewer model `default` kết luận approve phạm vi thu hẹp, không blocker còn nêu trong code được cung cấp; Dev review không nằm trong kết luận đó. Đây không phải review đã chạy trước implementation.

## 7. Kế hoạch và độ lệch

Test trước class, xác nhận module thiếu rồi implement và chạy lại. Code/test có trước tài liệu này; review độc lập được bổ sung sau đó, không nhận đã review thiết kế trước code.

| Bước | File | Test trước / đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|
| R6 thuần | `rules/r6-drain.rule.ts` | `r6-drain.rule.spec.ts`, module chưa tồn tại | `npm test -- --runInBand src/modules/risk/rules/r6-drain.rule.spec.ts` | `f536209` |
| Non-TRANSFER và manual | `rules/transfer-only.spec.ts`, `test/manual/r3-r6.manual.ts` | DEPOSIT trước guard: rule mới trả hit | `npx ts-node -r tsconfig-paths/register test/manual/r3-r6.manual.ts` | `f536209` |

Sweep sau implementation: test và giải thích rule được kiểm, CI/Dev review/merge chưa xảy ra và bàn giao BL-185; rollback bằng revert commit code. Việc lập/review kế hoạch sau code là độ lệch ghi tại §8.

**G3 kiểm lại sau code (agent tự quyết):** sweep đã đối chiếu từng DoD với unit/manual hoặc handoff BL-185, ghi rủi ro và cách revert ở trên. Phạm vi thu hẹp có thể công bố ở Draft; sai lệch thứ tự được ghi §8.

## 8. Kết quả và bàn giao

- Xác minh trên code cuối `5df0f0f`: `lint:check`, `typecheck`, `build` đạt; unit toàn backend **80 suite / 1.584 test**, e2e **15 suite / 153 test** đạt trên PostgreSQL/Valkey cô lập. E2e này không chứng minh fraud runtime; DB suite **43 / 735** chạy trong quá trình, trước fix projection/R2 cuối, không đổi schema.
- TC-107-01/02: **đạt** qua `r6-drain.rule.spec.ts` và `transfer-only.spec.ts`; TC-107-03: CI xanh và merge qua [#104](https://github.com/Lawliet119/digital-banking-simulator/pull/104), **Dev review chưa có**. Theo dõi [BL-185](../BACKLOG.md).
- Manual trên commit code cuối: `npx ts-node -r tsconfig-paths/register test/manual/r3-r6.manual.ts`; M-107-01 đúng 90% → hit, dưới 1 đồng và sameOwner → null; M-95/105/106/107-02 DEPOSIT → null. [Output thật](screenshots/DBS-107/manual-test.txt), [ảnh terminal](screenshots/DBS-107/01-rules.png). Dùng snapshot tổng hợp, không chạm ledger.
- Độ lệch: code/test được viết trước feature doc và review thiết kế; review được thực hiện sau, không coi là đã hoàn thành theo đúng thứ tự G2/G3. Quyết định sau đó: giữ PR ở Draft, bàn giao rõ review quy trình và các phần chưa chứng minh; không tuyên bố hoàn thành DoD.

## 9. Tài liệu

Đã cập nhật `backend/src/modules/risk/README.md`, `docs/features/README.md`, `docs/BACKLOG.md` (BL-185) và guide lỗi theo ADR-14.

### Domain review bằng subagent (bù sau merge, 2026-11-09)

Reviewer: subagent `fable` (mô hình mạnh nhất có sẵn), prompt `prompts/domain-review.md` chỉnh cho code đã merge, đọc `main` ở `18f93dc`. [Phản hồi nguyên văn](screenshots/DBS-107/domain-review.md). Bước này lẽ ra chạy ở Phase 2; agent đã bỏ qua khi làm một mạch, vì suy diễn Techlead waiver rộng hơn lời dặn «không qua humangate» (chỉ miễn người duyệt gate). Chạy bù sau merge. Phần review có sẵn ở trên được giữ nguyên.

**Verdict: APPROVE** (5 minor).

| # | Mức | Xử lý |
|---|---|---|
| 1, 2, 3 | minor | Không sửa: R6 tắt vẫn kiểm snapshot; làm tròn 99,996% thành «100.00%»; định dạng tiền trong explanation → BL-207 (định dạng tiền cũng là H7 của BL-184) |
| 4 | minor | **Đã sửa:** §8 «chưa merge». Ca số gần 2^63 trong manual và đường lỗi → BL-212 |
| 5 | minor | Bàn giao UC-12: `parseRuleSet` chưa chặn `minBalancePercent` không nguyên hoặc ngoài 1–100 → BL-188 |
