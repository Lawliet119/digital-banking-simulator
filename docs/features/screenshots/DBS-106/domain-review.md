## Findings

**No demonstrable correctness, security, precision, or privacy issue** is apparent in the supplied R5 and R6 implementations when evaluated with the specified seed thresholds and valid contract inputs.

- R5 uses the inclusive five-recipient boundary and exempts same-owner transfers.
- R6 uses exact integer cross-products for the inclusive 90% and one-million-dong boundaries; its rounded percentage is explanatory only.

## Verdict and limits

**R5/R6: pass on the supplied code and contract, subject to integration verification.** The rules deliberately support configurable thresholds, so the later configuration validation and deployment must ensure the intended seed values are used. The R6 explanation contains the exact amount and balance; whether exposing it is appropriate depends on the absent consumer and its access controls.

R3 and R4 implementations are not supplied, so their timestamp boundaries and 1–9 fractional-digit precision cannot be assessed. Feature-provider windowing and novelty calculations, the money parser implementations, and downstream handling are also handoffs and cannot be verified from this excerpt.

No tests were executed.

---

## Review bổ sung (backfill sau khi merge, subagent riêng, đọc code trên main)

Review ở trên đã có sẵn từ PR #100/#104. Phần dưới là reply nguyên văn của subagent chạy bổ sung.

| # | Severity (blocking / should-fix / minor) | Section of the doc or file | Finding | Evidence (file and section/line) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | `rules/r5-fan-out.rule.ts` | R5 tắt vẫn kiểm `sameOwner` và `newRecipients1h` (số đếm do provider cấp), rồi mới xét `enabled`. Hậu quả giống R4 #1: tắt R5 không cứu được khi provider phát count hỏng. Điều này trái chính sách R3 và DBS-108 §2. | r5-fan-out.rule.ts:23-26 | Đưa `if (!params.enabled) return null` lên ngay sau khi kiểm cấu hình; thêm test |
| 2 | minor | doc §4 TC-106-03, §8 | DoD 2 yêu cầu «người nhận cũ không tính, ngoài cửa sổ». Doc ghi «chưa làm», nhưng DBS-109 đã có test DB thật. Trong unit, ca «distinctRecipients24h=100» chỉ là ca thay thế, không chứng minh được việc loại người nhận cũ. TC-106-04 (merge) cũng đã cũ. | transfer-facts.db-spec.ts:160-190; r5 spec:76-80 | Cập nhật truy vết sang TC-109-04 |
| 3 | minor | doc §5 manual | Manual chỉ có đường thành công, biên 4/5 và sameOwner (chạy được, đúng như mô tả). Không có đường lỗi: count hoặc cấu hình sai. | r3-r6.manual.ts:78-84 | Thêm `assert.throws` với count âm hoặc `windowMinutes: 59` |

Verdict: REVISE

---
**Ghi chú chung của reviewer (một reply cho DBS-105..108):** Đã xác minh bằng chạy thực tế: hai script manual (`r3-r6.manual.ts`, `scoring.manual.ts`) chạy được và ra đúng kết quả như doc mô tả (chạy bằng ts-node `-T`, `node_modules` mượn từ worktree `main`). Chưa chạy được bộ unit Jest vì Jest không nhận cấu hình transform với `node_modules` mượn; khi đánh giá test chỉ đọc code test. Reviewer không sửa file nào trong repo.
