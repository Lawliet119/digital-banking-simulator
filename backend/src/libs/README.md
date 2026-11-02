# libs

Adapter cho dịch vụ bên ngoài — bọc SDK để phần còn lại của ứng dụng không phụ thuộc trực tiếp vào chúng.

| Thư viện (dự kiến) | Bọc | Quy tắc |
|---|---|---|
| `libs/redis` | `ioredis` | Timeout ngắn (`REDIS_COMMAND_TIMEOUT_MS`), circuit breaker; Redis lỗi **không được** làm hỏng nghiệp vụ — mỗi nơi dùng có đường dự phòng (docs/03 §9.3) |
| [`libs/sqs`](sqs/README.md) (DBS-77) | `@aws-sdk/client-sqs` | Gửi/nhận raw, long polling/batch; processBatch chỉ xóa sau handler thành công; JSON hỏng chuyển DLQ. `SQS_ENDPOINT` chỉ đặt ở local; cloud dùng IAM role |
| `libs/cognito` | JWKS của Cognito | Cache khóa công khai; không bao giờ gọi Cognito trên đường request |

Import qua alias `@libs/<tên>`.
