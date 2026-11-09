## Verdict: **CHƯA APPROVE**

Review tĩnh trên tài liệu và interface được cung cấp; chưa có implementation để kiểm chứng và tôi **không chạy test**. Hướng sửa về tách overflow baseline/AI, whitelist event và predicate không ép kiểu là đúng, nhưng đặc tả vẫn còn các lỗ hổng có thể dẫn tới hành vi khác ADR-14 hoặc tới các implementation không tương thích.

### 1. Chưa thống nhất miền weight của rule — có thể làm giảm điểm baseline

§2 yêu cầu weight là số nguyên trong miền PostgreSQL `int`, tức bao gồm số âm, nhưng lại yêu cầu `ruleScore` không âm. Chỉ kiểm tra tổng cuối cùng không đủ để phát hiện một rule làm giảm điểm.

**Ví dụ:** R1 hit với weight `70`, R2 hit với weight `-40`. Tổng là `30`, vẫn là số nguyên không âm hợp lệ, nhưng R2 đã làm giảm baseline từ 70 xuống 30. Nếu đây không phải policy mong muốn, cấu hình này phải bị từ chối, kể cả khi R2 bị tắt.

**Đề nghị:** quy định rõ weight từng rule trong `[0, 2147483647]`, validate trước khi bỏ qua rule tắt; thêm test tổng vẫn dương dù có weight âm. Nếu weight âm là chủ ý, cần ghi rõ policy và hệ quả thay vì chỉ kiểm tra tổng.

### 2. Validation threshold của rule tắt chưa có hợp đồng thực thi cụ thể

Tài liệu yêu cầu validate threshold đúng miền của **từng rule trước khi bỏ qua**, nhưng `RiskRule` chỉ có `evaluate`, còn `thresholds` là `Record<string, number | string>`. Không có đặc tả key bắt buộc, kiểu runtime, miền giá trị, hay cơ chế validator dùng chung với từng rule. Gọi `evaluate` không bảo đảm validation: rule có thể trả `null` ngay khi thấy `enabled=false`.

**Ví dụ:** R1 tắt, thiếu threshold bắt buộc hoặc threshold là `"không-phải-số"`. Một implementation bỏ qua R1 trước khi đọc threshold sẽ trả điểm bình thường, trái TC-108-02.

**Đề nghị:** định nghĩa schema/validator cho từng rule, bao gồm quy tắc parse đối với threshold dạng string nếu rule thực sự cần; scoring gọi validator cho cả sáu config trước khi quyết định chạy rule. Test riêng threshold thiếu, sai kiểu/miền và config tắt.

### 3. Policy overflow AI còn mơ hồ về *thời điểm* kiểm tra

§2 nói AI config sai **hoặc cộng weight làm overflow** thì `CONFIG_INVALID`, nhưng không xác định có kiểm tra `ruleScore + ai.weight` khi assessment thiếu, lỗi, hoặc `p < threshold` hay không. Trong khi đó caller phải validate **tổng weight tối đa trước egress**. Hai kiểm tra này phục vụ mục đích khác nhau nhưng chưa được phân biệt thành thuật toán.

**Ví dụ:** `ruleScore = 2147483647`, `ai.weight = 1`, assessment `SUCCEEDED`, `p < threshold`. Một cách hiểu trả `SUCCEEDED` và contribution 0 vì không cộng; cách khác trả `CONFIG_INVALID` vì weight tiềm năng gây overflow. Cả hai hiện có thể được suy ra từ mô tả.

**Đề nghị:** chốt thứ tự và precedence status: validate AI config, xử lý assessment/predicate, rồi kiểm tra overflow khi contribution *sẽ được áp dụng* — hoặc quy định rõ kiểm tra tiềm năng luôn được thực hiện. Tách riêng validation tổng weight tối đa trước egress của caller và test cả hai lớp. Baseline overflow vẫn phải ném lỗi trước khi AI có thể che lỗi.

### 4. Chưa quy định đầy đủ xử lý AI input malformed ở runtime

Predicate probability đã nói rõ không ép kiểu, nhưng shape của `assessment` và `config.ai` tại runtime chưa được đặc tả đủ. TypeScript interface không bảo vệ dữ liệu từ JSON hoặc caller.

**Ví dụ:** ở mode AI, `config.ai = null` hoặc thiếu; đọc trực tiếp `config.ai.threshold` có thể ném `TypeError` thay vì trả baseline với `CONFIG_INVALID`. Tương tự, `assessment = null` cần được xác định có phải “thiếu assessment” hay không; `assessment = { status: 'SUCCEEDED' }` phải thành `INVALID_RESPONSE`, không throw.

**Đề nghị:** chỉ rõ kiểm tra object/null và thứ tự xử lý, bao gồm status đầu vào `DISABLED`/`CONFIG_INVALID` vốn cũng nằm trong `AiStatus`. Thêm test `null`, thiếu object/field, sai kiểu và các status hợp lệ nhưng không phải `SUCCEEDED`. Không dùng coercion như `Number(p)`.

### 5. Metric chưa đủ contract để triển khai và kiểm thử ổn định

Đã nói counter không có label dữ liệu khách, nhưng chưa xác định tên, lifecycle/registry và chính xác khi nào tăng.

**Ví dụ:** nếu tạo `prom-client` Counter trong mỗi constructor và nhiều `ScoringService` dùng default registry, có thể đăng ký trùng tên và ném lỗi. Ngoài ra, mode lạ trên DEPOSIT phải **không tăng** vì event bị loại trước khi đọc config; với TRANSFER có mode lạ nhưng baseline sau đó lỗi, tài liệu chưa nói counter có tăng hay không.

**Đề nghị:** định nghĩa counter không label, đăng ký singleton hoặc inject registry/metric; chốt điểm tăng, ví dụ một lần mỗi TRANSFER khi phát hiện mode không hỗ trợ, kể cả nếu bước sau ném lỗi. Test giá trị counter và việc non-TRANSFER không đụng config/metric.

### Phạm vi kết luận

Thiết kế đã nêu đúng các bất biến quan trọng: AI không được xóa điểm luật, baseline overflow phải fail-closed, AI overflow phải fallback, và event ngoài whitelist bị bỏ qua sớm. Tuy nhiên, các điểm trên cần được chốt và chuyển thành test trước khi approve. Ngoài ra, review này không xác nhận được hành vi thực tế của sáu rule, mapping config, caller trước egress hay CI/merge vì implementation và bằng chứng tương ứng chưa được cung cấp.

---

## Review bổ sung (backfill sau khi merge, subagent riêng, đọc code trên main)

Review ở trên đã có sẵn từ PR #100/#104. Phần dưới là reply nguyên văn của subagent chạy bổ sung.

| # | Severity (blocking / should-fix / minor) | Section of the doc or file | Finding | Evidence (file and section/line) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | `scoring.service.ts` | ADR-14 yêu cầu metric `risk_rule_error_total{rule}`, nhưng scorer ném lại lỗi thô không mang mã luật, nên consumer không gắn được nhãn `rule`. Ví dụ: «Not a valid money value» từ R6, «Invalid risk rule configuration» khi thiếu entry, «Invalid risk rule result». | scoring.service.ts:91-108; ADR-14 dòng 64; BL-051 | Bọc `rule.evaluate` trong try/catch, ném `RiskRuleError{ruleId}` (giữ `cause`, không kèm giá trị); thêm test |
| 2 | minor | Nguồn tham chiếu | `02-architecture.md` §7 vẫn ghi «bắt lỗi tại chỗ, các luật còn lại vẫn chạy», trái với hành vi fail-closed của scorer theo ADR-14. BL-186 chỉ nhắc guide, không nhắc file này. | docs/components/risk/02-architecture.md:170 | Sửa §7 theo ADR-14 |
| 3 | minor | TC-108-01 | DoD 2 yêu cầu «các ví dụ guide §4.3 thành unit test», nhưng test dùng giá trị biên (5 người nhận, 6 lệnh, tài khoản 3 giờ, số dư 20,8 triệu) chứ không dùng đúng ví dụ (6 người nhận, 8 lệnh/10 phút). Fixture AC-9.1 (tài khoản 1 giờ, số dư 21 triệu, chuyển 20 triệu → 65 MEDIUM) cũng không có nguyên văn. | scoring.service.spec.ts:78-105; guide §4.3 dòng 195-200; BRD AC-9.1 | Thêm các hàng đúng nguyên văn guide và AC-9.1 |
| 4 | minor | doc §1, §8 | Tài liệu đã cũ: vẫn ghi DBS-105–107 chưa merge, provider và repository chưa có, trong khi DBS-109/110 đã ở `main`. | DBS-108 §1 đoạn 2; git log `77a5cac`, `32367ab` | Cập nhật trạng thái |
| 5 | minor (hand-off: DBS-111/consumer, Dev API) | Tích hợp | `ScoringService` chưa được nối vào module hay consumer nào. Vì vậy FR-RSK-03/04, AC-9.1, AC-9.2 (event trùng hoặc đảo thứ tự) và AC-10.2 (ẩn cờ và explanation chứa số tiền khỏi khách hàng) chưa được chứng minh. | risk.module.ts:3; grep không tìm thấy nơi dùng `ScoringService` | Consumer test e2e AC-9.1/9.2; API test AC-10.2 |
| 6 | minor (hand-off: UC-12/DBS-110) | BL-188 | `parseRuleSet` nhận các giá trị mà luật sẽ ném lỗi, nên một phiên bản hỏng làm mọi TRANSFER vào DLQ. Đã chạy thử với R4=90, R5 `windowMinutes`=30, R6=90.5. BL-188 thiếu R4 và R6. | rule-set.ts:61-63; BL-188 | Bộ kiểm khi ghi phiên bản phải phủ đủ miền giá trị R1–R6 |

Không có phát hiện về tiền hay bảo mật: điểm được giới hạn trong int, mức LOW/MEDIUM/HIGH khớp 40/70, AI chỉ được cộng điểm, projection gửi đúng danh sách trường cho phép (không UUID, không timestamp tuyệt đối).

Verdict: REVISE

---
**Ghi chú chung của reviewer (một reply cho DBS-105..108):** Đã xác minh bằng chạy thực tế: hai script manual (`r3-r6.manual.ts`, `scoring.manual.ts`) chạy được và ra đúng kết quả như doc mô tả (chạy bằng ts-node `-T`, `node_modules` mượn từ worktree `main`). Chưa chạy được bộ unit Jest vì Jest không nhận cấu hình transform với `node_modules` mượn; khi đánh giá test chỉ đọc code test. Reviewer không sửa file nào trong repo.
