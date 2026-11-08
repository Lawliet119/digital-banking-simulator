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