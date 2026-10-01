# apps/api

NestJS API — mọi use case đồng bộ. Stateless, chạy trên ECS Fargate, scale ngang.

| Module | Trách nhiệm | Use case | Phụ trách |
|---|---|---|---|
| `identity` | Xác minh JWT (Cognito), vai trò, mốc thu hồi phiên | UC-1 | #2 |
| `accounts` | Khách hàng, tài khoản, khóa / mở khóa | UC-1, 2, 4, 11 | #2 |
| `ledger` | Nạp tiền, chuyển tiền, idempotency, hạn mức, lịch sử, trạng thái, đối soát | UC-3, 5, 6, 7 | #1 |
| `risk-admin` | Review cờ gian lận, cấu hình luật | UC-10, 12 | #4 |
| `audit` | API tra cứu nhật ký cho kiểm toán viên | UC-8 | #3 |

Quy tắc phụ thuộc giữa module: [docs/03 mục 5](../../docs/03_HIGH_LEVEL_ARCHITECTURE.md). Bảng API: [docs/03 mục 7](../../docs/03_HIGH_LEVEL_ARCHITECTURE.md).

> Khởi tạo ở tuần 1 (#5).
