# libs

Adapter cho dịch vụ bên ngoài — bọc SDK để phần còn lại của ứng dụng không phụ thuộc trực tiếp vào chúng.

| Thư viện (dự kiến) | Bọc | Quy tắc |
|---|---|---|
| [`libs/redis`](redis/README.md) (DBS-76) | `ioredis` + `opossum` | Timeout tối đa50ms, breaker ADR-12, lỗi explicit và counter redis_fallback_total; caller chọn fallback; mọi lệnh ghi có TTL |
| `libs/sqs` | `@aws-sdk/client-sqs` | `SQS_ENDPOINT` chỉ đặt ở local (ElasticMQ); trên AWS dùng IAM role |
| `libs/cognito` | JWKS của Cognito | Cache khóa công khai; không bao giờ gọi Cognito trên đường request |

Import qua alias `@libs/<tên>`.
