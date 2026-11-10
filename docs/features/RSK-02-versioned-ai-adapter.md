# RSK-02 · Adapter AI theo version và admission có deadline

## Phạm vi và thiết kế

Adapter Decisions nhận cấu hình model/rubric tường minh từ version rule set. Rubric UTF-8 được giữ nguyên và ghi SHA-256; rubric rỗng, quá 16.384 byte hoặc phản chiếu credential bị từ chối trước admission/network. Không log request, phản hồi gốc hay credential. Predicate và allowlist feature cố định.

Admission có thể bất đồng bộ; deadline tính từ lúc chọn version, không phải lúc bắt đầu xin permit. Permit đến muộn được nhả đúng một lần; từ chối quota → `BUDGET_EXHAUSTED`, lỗi/timeout → `UNAVAILABLE`. Kiểm deadline lại ngay trước fetch; cleanup best-effort không chặn. Timeout provider riêng với deadline admission.

## Kiểm thử và giới hạn

Trước khi tích hợp worker, typecheck/lint mục tiêu đạt, 121 test adapter và 7 test CLI đạt; fixture loopback trả `UNAVAILABLE` khi response body bị treo, với một lần admission, một request và một release. Đây là kiểm thử synthetic, không phải provider thật hay bằng chứng chất lượng.

Tích hợp worker, quota bền vững, quyền và test liên quan ở [RSK-02](RSK-02-durable-ai-gate.md). Quota request không phải trần tiền; abort không chứng minh provider ngừng tính phí; không bảo đảm exactly-once billing. `rule_only` vẫn mặc định. Theo [tài liệu OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions), model hiện được hỗ trợ là `gpt-6-luna`; model phải do rule set chỉ định và còn cần kiểm tra quyền tài khoản thực tế.
