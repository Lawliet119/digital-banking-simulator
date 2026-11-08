## Kết luận: APPROVE

Trong phạm vi review độc lập §2–§4 và mã sáu rule được cung cấp, **hợp đồng hiện đủ rõ, không thấy vấn đề blocking**. Đây là review trước khi viết scoring service; không khẳng định test, CI, Dev review hay merge đã được thực hiện.

### Kiểm tra trọng tâm: `enabled=false`

Với event `TRANSFER`, cả R1–R6 đều kiểm tra `enabled`, miền weight và các threshold cấu hình tương ứng **trước khi** nhánh `!params.enabled` trả `null`. Vì vậy, theo mã được cung cấp, cấu hình tắt nhưng sai vẫn bị từ chối, thay vì âm thầm bỏ qua. Ví dụ: R5 với `enabled=false` và `windowMinutes=30` vẫn ném lỗi vì cửa sổ phải bằng 60.

Một số rule cũng kiểm tra dữ liệu event hoặc feature trước khi bỏ qua rule tắt. Điều này phù hợp với hợp đồng fail-closed hiện tại; caller không nên giả định rằng feature sai của rule tắt luôn được bỏ qua.

### Các điểm đã rõ sau chỉnh sửa

- Non-TRANSFER trả `null` trước khi đọc config hoặc tăng metric; mode lạ ở TRANSFER tăng counter ngay cả khi baseline sau đó lỗi.
- Baseline overflow thì ném lỗi; AI overflow chỉ xét khi predicate đã hợp lệ và weight thực sự sẽ được áp dụng, rồi fallback về baseline với `CONFIG_INVALID`.
- Điểm không bị chặn ở 100; hit chỉ gồm R1–R6 và AI có thể tạo điểm mà không tạo hit.
- Validation trước egress và các bảo đảm tích hợp/vận hành AI vẫn thuộc caller hoặc task khác, không được suy ra từ hàm chấm thuần.

**Lưu ý triển khai, không blocking:** TC-108-02 nên có ví dụ cấu hình sai khi tắt cho từng rule, với event và feature còn lại hợp lệ, để xác minh lỗi thực sự đến từ validation cấu hình. TC-108-04/05 cũng nên kiểm tra thứ tự metric và overflow như hợp đồng đã nêu.