## Finding

**Low — Rounded explanations can contradict the rule boundary.** R3 correctly hits when the account age is 24 hours minus one nanosecond, but its explanation rounds that age to `24.00` hours. Likewise, R4 describes a reverse transfer one nanosecond earlier as `0.00` minutes ago. This can mislead reviewers about why a boundary-sensitive rule fired. Use more precision near boundaries, or phrase the values as explicitly rounded approximations without implying an exact boundary value.

## Verdict

With the shown 24-hour/10-million R3 and 60-minute R4 parameters, the decision comparisons preserve the specified boundaries and nanosecond precision. No demonstrable security or privacy issue is established in the supplied code; R3 does put the exact transfer amount in its explanation, so its eventual handling should be reviewed at the consumer handoff.

R5, R6, the configuration seed, providers, and consumer are not supplied, so their behavior cannot be verified. This is a static review; no tests were executed.

---

## Review bổ sung (backfill sau khi merge, subagent riêng, đọc code trên main)

Review ở trên đã có sẵn từ PR #100/#104. Phần dưới là reply nguyên văn của subagent chạy bổ sung.

| # | Severity (blocking / should-fix / minor) | Section of the doc or file | Finding | Evidence (file and section/line) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | `rules/r4-round-trip.rule.ts`; doc §2 | R4 tắt vẫn parse `event.occurredAt` và `reverseTransferOccurredAt` (dữ liệu do provider cấp) trước khi xét `enabled`. Như vậy, nếu provider phát timestamp sai định dạng thì tắt R4 bằng một phiên bản luật mới không ngăn được lỗi: mọi TRANSFER đều ném lỗi và vào DLQ. Điều này trái chính sách đã chốt ở R3: luật tắt chỉ kiểm cấu hình. | r4-round-trip.rule.ts:24-28 (parse) đứng trước `!params.enabled` ở :28; DBS-95 §1 câu hỏi 5, §2.3, review #5; DBS-108 §2 («kiểm … trước khi bỏ qua»); R3 trả về sớm ở r3-…rule.ts:83 | Trả `null` ngay sau khi kiểm cấu hình nếu `!enabled`; thêm test «rule tắt + timestamp hỏng → null» |
| 2 | minor | `r4-round-trip.rule.ts` và `ai/feature-projection.ts` | Lệnh ngược xảy ra cùng lúc hoặc sau `occurredAt`: R4 âm thầm trả `null` (đã chạy thử), còn projection AI lại ném lỗi với cùng fact đó. Hai chính sách fail-closed không thống nhất, nên lỗi provider bị che ở chế độ `rule_only`. SQL của DBS-109 có chặn `< occ` nên hiện không xảy ra. | r4:28 (`elapsed <= 0n` → null); feature-projection.ts:137 (throw) | Ném lỗi khi `elapsed <= 0`, hoặc ghi rõ trong §2 rằng đây là quyết định có chủ ý |
| 3 | minor | doc §2 «chính xác tới nanosecond» | Độ phân giải thực tế từ đầu đến cuối chỉ là mili giây: provider cắt `occurredAt` về ms và `date_trunc('milliseconds')` lệnh ngược. Lệnh ngược thật ở mốc 60 phút + 0,5 ms (`created_at` tính bằng µs) được báo là đúng 60:00.000, nên vẫn hit. | online-feature-provider.ts:51; transfer-facts.ts:85-90 | Ghi rõ độ phân giải ms trong §2; chuyển DBS-109 nếu muốn chính xác dưới ms |
| 4 | minor | `r4-round-trip.rule.spec.ts` | Thiếu ca cận trên `reverseWindowMinutes: 61`. Nhánh explanation «chưa đến 0.01» chưa được assert: test 1 ns chỉ kiểm `id`. | spec:63-86, :158-168 | Thêm ca 61 và assert nội dung explanation |
| 5 | minor | doc §4 TC-105-03/04, §8 | Tài liệu đã cũ: vẫn ghi «chưa làm, provider/SQL chưa có» và «chưa merge». Thực tế DBS-109 đã có test REJECTED, mốc 1 giờ và EXPLAIN không Seq Scan, BL-185 cũng ghi đã đóng. | test/db/transfer-facts.db-spec.ts:111-133, :217-229; BACKLOG BL-185 | Cập nhật bảng truy vết, trỏ sang TC-109-03/05 |
| 6 | minor | doc §5 manual | Script manual không có đường lỗi nào cho R4 (timestamp hoặc cấu hình sai). Ca lỗi duy nhất trong script thuộc R3. Script vẫn chạy được: M-105-01 cho 60 phút → hit, quá 1 ns → null. | test/manual/r3-r6.manual.ts:68-76, :111-113 | Thêm ca `reverseWindowMinutes: 0` hoặc timestamp sai, kèm `assert.throws` |
| 7 | minor (hand-off: UC-12/DBS-110) | BL-188 | `parseRuleSet` nhận `reverseWindowMinutes: 90` (đã chạy thử), sau đó mọi TRANSFER đều ném «Invalid R4 configuration». BL-188 chỉ liệt kê miền giá trị của R2, R3, R5, bỏ sót R4. | config/rule-set.ts:49-66; BACKLOG BL-188 | Thêm R4 (số nguyên 1–60) vào bộ kiểm khi ghi phiên bản |

Verdict: REVISE

---
**Ghi chú chung của reviewer (một reply cho DBS-105..108):** Đã xác minh bằng chạy thực tế: hai script manual (`r3-r6.manual.ts`, `scoring.manual.ts`) chạy được và ra đúng kết quả như doc mô tả (chạy bằng ts-node `-T`, `node_modules` mượn từ worktree `main`). Chưa chạy được bộ unit Jest vì Jest không nhận cấu hình transform với `node_modules` mượn; khi đánh giá test chỉ đọc code test. Reviewer không sửa file nào trong repo.
