# libs

Adapter cho dịch vụ bên ngoài — bọc SDK để phần còn lại của ứng dụng không phụ thuộc trực tiếp vào chúng.

| Thư viện | Bọc | Quy tắc |
|---|---|---|
| [`libs/redis`](redis/README.md) (DBS-76) | `ioredis` + `opossum` | Timeout tối đa 50ms, breaker ADR-12, lỗi explicit và counter `redis_fallback_total`; Redis lỗi **không được** làm hỏng nghiệp vụ — mỗi nơi dùng có đường dự phòng (docs/03 §9.3); mọi lệnh ghi có TTL |
| [`libs/sqs`](sqs/README.md) (DBS-77) | `@aws-sdk/client-sqs` | Gửi/nhận raw, long polling/batch; processBatch chỉ xóa sau handler thành công; JSON hỏng chuyển DLQ. `SQS_ENDPOINT` chỉ đặt ở local; cloud dùng IAM role |

Import qua alias `@libs/<tên>`. Chưa module nghiệp vụ nào import hai thư viện này. JWKS của Cognito không nằm ở đây mà ở `modules/identity` (`JwksVerifierService`).
