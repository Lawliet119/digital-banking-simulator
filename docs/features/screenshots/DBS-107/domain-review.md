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
| 1 | minor | `rules/r6-drain.rule.ts` | R6 tắt vẫn kiểm `sameOwner`, `fromBalanceBefore`, `amount`. Đã chạy thử: tắt R6 với snapshot `'x'` → ném lỗi. Các trường này đã được schema event kiểm từ trước nên rủi ro thấp, nhưng vẫn lệch chính sách R3 và DBS-108 §2. | r6-drain.rule.ts:26-28 | Trả `null` sau khi kiểm cấu hình nếu tắt |
| 2 | minor | explanation R6 | Phần trăm làm tròn half-up: chuyển 99,996% hiển thị «100.00%» (đã chạy thử), tức là phóng đại thành rút cạn hoàn toàn. | r6:37-38 | Làm tròn xuống (floor) để không bao giờ phóng đại |
| 3 | minor | explanation R6 / tên gọi | Tiền trong explanation không có dấu ngăn nghìn và chỉ có «đ» ở cuối («(950000/1000000đ)»). Trong khi R3 viết «20.000.000đ» và guide §4.4 dùng «(20.000.000/20.800.000)». Đã có trong BL-184 H7. | r6:42; guide §4.4 dòng 253; manual output M-108-01 | Thống nhất một formatter tiền cho R1–R6 |
| 4 | minor | doc §5, §8 | Manual không có đường lỗi và không có ca bigint lớn: DoD 2 «số rất lớn» chỉ được phủ ở unit. Ngoài ra TC-107-03 «chưa merge» đã cũ. | r3-r6.manual.ts:86-100 | Thêm ca `fromBalanceBefore` gần 2^63 và một ca cấu hình sai |
| 5 | minor (hand-off: UC-12/DBS-110) | BL-188 | `parseRuleSet` nhận `minBalancePercent: 90.5` (đã chạy thử), sau đó mọi TRANSFER ném «Invalid R6 configuration». BL-188 bỏ sót R6. | rule-set.ts:61-63; BL-188 | Thêm R6 (số nguyên 1–100, `minBalance` là chuỗi tiền dương) |

Verdict: APPROVE

---
**Ghi chú chung của reviewer (một reply cho DBS-105..108):** Đã xác minh bằng chạy thực tế: hai script manual (`r3-r6.manual.ts`, `scoring.manual.ts`) chạy được và ra đúng kết quả như doc mô tả (chạy bằng ts-node `-T`, `node_modules` mượn từ worktree `main`). Chưa chạy được bộ unit Jest vì Jest không nhận cấu hình transform với `node_modules` mượn; khi đánh giá test chỉ đọc code test. Reviewer không sửa file nào trong repo.
