# Architecture Decision Records

Mỗi quyết định kiến trúc quan trọng được ghi thành một ADR theo [mẫu](0000-template.md): bối cảnh, các phương án, lựa chọn, lý do và đánh đổi. Đề bài yêu cầu tối thiểu 3 ADR; nhóm dự kiến 13.

**Trạng thái:** `Proposed` (đề xuất) → `Accepted` (đã chốt) → có thể `Superseded` (bị thay bởi ADR mới).

| # | Quyết định | Phương án so sánh | Người viết | Trạng thái |
|---|---|---|---|---|
| ADR-01 | Modular monolith + worker | Monolith thuần · Microservices | #1 | Proposed |
| ADR-02 | PostgreSQL làm sổ cái | DynamoDB · MongoDB | #1 | Proposed |
| ADR-03 | Chuyển tiền đồng bộ, tác vụ phụ bất đồng bộ (outbox + SQS, mỗi consumer một queue) | Full async / saga · Đồng bộ toàn bộ · SNS fan-out | #3 | Proposed |
| ADR-04 | Khóa `FOR UPDATE` theo thứ tự id ở READ COMMITTED | Optimistic version · SERIALIZABLE | #1 | Proposed |
| ADR-05 | Idempotency trong Postgres, scope theo user, `ON CONFLICT DO NOTHING` | Redis · Không idempotency | #1 | Proposed |
| ADR-06 | Cognito; ECS Fargate | JWT tự quản; EKS | #2, #5 | Proposed |
| ADR-07 | NestJS/TypeScript và tầng truy cập dữ liệu | Spring Boot · FastAPI; TypeORM vs Kysely vs Prisma | #1 | Proposed |
| ADR-08 | Fraud rule-based, gắn cờ bất đồng bộ | ML từ đầu · Chặn đồng bộ | #4 | Proposed |
| ADR-09 | Nạp tiền qua tài khoản SYSTEM | Sửa số dư trực tiếp | #1 | Proposed |
| ADR-10 | Egress mạng cho Fargate | NAT Gateway · VPC endpoints · Public subnet | #5 | Proposed |
| ADR-11 | Cloud managed services | VPS tự quản · Kết hợp ([phân tích](../DEPLOYMENT_OPTIONS_VPS_VS_CLOUD.md)) | #5 | Proposed |
| ADR-12 | Redis cho rate limit, mốc thu hồi, bộ đếm, cấu hình; không cache số dư | Không cache · Bộ nhớ từng task · Cache cả số dư | #2, #4 | Proposed |
| [ADR-13](0013-one-app-app-role.md) | Một ứng dụng, một image, chạy theo `APP_ROLE` | Hai app riêng · Hai repo | #1, #5 | Proposed (đã hiện thực, chờ nhóm xác nhận) |

Tên file: `NNNN-tieu-de-ngan.md`, ví dụ `0001-modular-monolith.md`.
