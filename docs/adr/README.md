# Architecture Decision Records

Mỗi quyết định kiến trúc quan trọng được ghi thành một ADR theo [mẫu](0000-template.md): bối cảnh, các phương án, lựa chọn, lý do và đánh đổi. Đề bài yêu cầu tối thiểu 3 ADR; nhóm có 13.

**Trạng thái:** `Proposed` (đề xuất) → `Accepted` (đã chốt) → có thể `Superseded` (bị thay bởi ADR mới). Đổi một quyết định đã `Accepted` thì viết ADR mới thay thế, không sửa ADR cũ.

| # | Quyết định | Phương án so sánh | Chủ ADR | Trạng thái |
|---|---|---|---|---|
| [ADR-01](0001-modular-monolith-worker.md) | Modular monolith + worker | Monolith thuần · Microservices | #1 | Accepted |
| [ADR-02](0002-postgresql-ledger.md) | PostgreSQL 17 làm sổ cái và nguồn sự thật | DynamoDB · MongoDB | #1 | Accepted |
| [ADR-03](0003-sync-transfer-async-outbox-sqs.md) | Chuyển tiền đồng bộ, tác vụ phụ bất đồng bộ (outbox + SQS, mỗi consumer một queue) | Đồng bộ toàn bộ · Full async / saga · SNS fan-out | #3 | Accepted |
| [ADR-04](0004-row-locking-read-committed.md) | Khóa `FOR UPDATE` theo thứ tự id ở READ COMMITTED | Optimistic version · SERIALIZABLE | #1 | Accepted |
| [ADR-05](0005-idempotency-in-postgres.md) | Idempotency trong Postgres, theo user, `ON CONFLICT DO NOTHING`, giữ 7 ngày | Redis · Không idempotency | #1 | Accepted |
| [ADR-06](0006-cognito-ecs-fargate.md) | Cognito (4 nhóm, access token 15 phút); ECS Fargate | JWT tự cấp · Keycloak; EKS · ECS trên EC2 | #2, #5 | Accepted |
| [ADR-07](0007-nestjs-typeorm-explicit-sql.md) | NestJS/TypeScript; TypeORM + SQL tường minh cho luồng tiền | Spring Boot · FastAPI; Kysely · Prisma | #1 | Accepted |
| [ADR-08](0008-fraud-detection-architecture.md) | Fraud bất đồng bộ theo phiên bản: 6 luật (`v1`), luật học tham số (`v2`), mô hình ONNX in-process (`v3`) chỉ sau cổng go/no-go | Chặn đồng bộ · Chỉ luật tĩnh · Microservice Python riêng | #4 | Accepted |
| [ADR-09](0009-funding-system-account.md) | Nạp tiền qua tài khoản SYSTEM `funding`, một hàng ở v1 | Sửa số dư trực tiếp · Nhiều tài khoản funding | #1 | Accepted |
| [ADR-10](0010-fargate-egress-public-subnet.md) | Task Fargate ở public subnet, security group chỉ nhận từ ALB; không NAT | NAT Gateway · VPC interface endpoint | #5 | Accepted |
| [ADR-11](0011-aws-managed-session-based.md) | AWS managed services, `ap-southeast-1`, dựng/xóa theo phiên | VPS tự quản · Kết hợp VPS + cloud | #5 | Accepted |
| [ADR-12](0012-redis-valkey-node.md) | Valkey node (cluster mode tắt) cho rate limit, mốc thu hồi, bộ đếm, cấu hình; không cache số dư | Không cache · Bộ nhớ từng task · Cache cả số dư; Serverless | #2, #4 | Accepted |
| [ADR-13](0013-one-app-app-role.md) | Một ứng dụng, một image, chạy theo `APP_ROLE` | Hai app riêng · Hai repo | #1, #5 | Accepted |

Tên file: `NNNN-tieu-de-ngan.md`, ví dụ `0001-modular-monolith-worker.md`.
