# P2 — Application, Data & Integration Architecture: Digital Banking Simulator

> **Status:** Bản ghép sẵn, còn thiếu OpenAPI xuất từ code (DBS-72) · **Dẫn dắt:** #1 · **Cập nhật:** 2026-10-11
> Bản này **tóm tắt và trỏ về nguồn**. Nguồn: [docs/03](../03_HIGH_LEVEL_ARCHITECTURE.md) §4–10, [database-design](../components/_shared/database-design.md), [event-contract](../components/_shared/event-contract.md), [ADR](../adr/README.md).

## 1. Component (C4 mức 2 và 3)

| Container | Trách nhiệm | Công nghệ |
|---|---|---|
| API (`APP_ROLE=api`) | Mọi use case đồng bộ; ghi DB trong transaction | NestJS 11 trên ECS Fargate |
| Worker (`APP_ROLE=worker`) | Outbox relay, chấm điểm gian lận, thông báo, đối soát, dọn dữ liệu | Cùng image với API |
| PostgreSQL 17 | Nguồn sự thật: sổ cái, mã yêu cầu, nhật ký, outbox | Amazon RDS |
| Valkey | Rate limit, mốc thu hồi phiên, bộ đếm gian lận, cache cấu hình | ElastiCache, node cố định |
| SQS + DLQ | `risk-events`, `notification-events`, mỗi queue một DLQ | Amazon SQS standard |
| Cognito | Đăng ký, đăng nhập, JWT, 4 nhóm vai trò | Amazon Cognito |

Module bên trong ứng dụng và quy tắc phụ thuộc (eslint ép ranh giới): [docs/03 §5](../03_HIGH_LEVEL_ARCHITECTURE.md). Mỗi module có concept brief ở [components/index.md](../components/index.md).

| Module | Chạy ở | Sở hữu bảng |
|---|---|---|
| `identity` | api | `users` |
| `accounts` | api | `customers`, `accounts` |
| `ledger` | api (đối soát ở worker) | `transfers`, `ledger_entries`, `idempotency_keys`, `reconciliation_runs` |
| `audit` | api và worker | `audit_log` |
| `outbox` | ghi ở mọi role; relay ở worker | `outbox_events`, `processed_events` |
| `risk` | api (review, cấu hình) và worker (chấm điểm) | `risk_rule_sets`, `fraud_flags`, `fraud_rule_hits` |
| `notification` | worker | `notification_log` |
| `health` | api | — |

## 2. API specification

Đặc tả đầy đủ là **OpenAPI sinh từ code** (`/docs` ở môi trường không phải production). Bảng endpoint, quy ước tiền là chuỗi, lỗi `application/problem+json` kèm `errorCode`, 404 cho tài nguyên không thuộc mình, 503 + `Retry-After` cho lỗi DB tạm thời: [docs/03 §7](../03_HIGH_LEVEL_ARCHITECTURE.md). Danh sách `errorCode`: [docs/03 §7.1](../03_HIGH_LEVEL_ARCHITECTURE.md).

- [ ] Xuất file `openapi.json` từ commit nộp bài và đính vào bản nộp (việc còn lại của DBS-72).

## 3. Data model

- ERD rút gọn: [docs/03 §8.2](../03_HIGH_LEVEL_ARCHITECTURE.md). Schema đầy đủ (14 bảng, ràng buộc, index, quyền, vòng đời dữ liệu, thứ tự migration): [database-design](../components/_shared/database-design.md).
- Bất biến do DB bảo vệ: số dư khách không âm; mỗi giao dịch tối đa một dòng Nợ và một dòng Có, mỗi dòng đúng số tiền và đúng tài khoản của giao dịch (đủ cặp do code và đối soát giữ); `PRIMARY KEY (user_id, idem_key)`; bảng chỉ-thêm (`ledger_entries`, `transfers`, `audit_log`, `risk_rule_sets`) bị chặn sửa/xóa bằng quyền **và** trigger.
- Tiền là `bigint` (đồng); thời gian `timestamptz`, DB chạy UTC; ranh giới ngày theo `Asia/Ho_Chi_Minh`.
- Hai DB role cho ứng dụng (`dbs_api`, `dbs_worker`) và một role migration (`dbs_migrator`), quyền theo ma trận ở database-design §8.

## 4. Luồng đồng bộ và bất đồng bộ

| Luồng | Kiểu | Sơ đồ |
|---|---|---|
| Chuyển tiền (UC-5): xác thực → một transaction (mã yêu cầu, khóa theo thứ tự id, sync guard, bút toán, audit, outbox) → 201 hoặc 422 | Đồng bộ | [docs/03 §6.1, §6.3](../03_HIGH_LEVEL_ARCHITECTURE.md) |
| Nạp tiền tại quầy (UC-3): cùng luồng, nguồn là tài khoản SYSTEM `funding` | Đồng bộ | [§6.4](../03_HIGH_LEVEL_ARCHITECTURE.md) |
| Khóa tài khoản, thu hồi phiên (UC-11) | Đồng bộ | [§6.2](../03_HIGH_LEVEL_ARCHITECTURE.md) |
| Outbox → SQS → risk consumer (cờ) và notification consumer | Bất đồng bộ, at-least-once, consumer idempotent | [§10](../03_HIGH_LEVEL_ARCHITECTURE.md) |
| Review cờ (UC-10), tra cứu nhật ký (UC-8) | Đồng bộ | [§6.5, §6.6](../03_HIGH_LEVEL_ARCHITECTURE.md) |

**Integration:** sự kiện `TransferCompleted` (mang ảnh chụp số dư và tuổi tài khoản tại thời điểm giao dịch) và `AccountStatusChanged`; bảng định tuyến tới từng queue; `TransferRejected` không phát ở v1. Hình dạng sự kiện: [event-contract](../components/_shared/event-contract.md). Xử lý sự cố (relay chết, consumer lỗi, message hỏng, Redis chết): [docs/03 §11](../03_HIGH_LEVEL_ARCHITECTURE.md).

## 5. Architecture Decision Records

Đề bài yêu cầu tối thiểu 3 ADR; nhóm có 13, đều Accepted. Ba ADR trọng tâm của P2:

| ADR | Quyết định |
|---|---|
| [ADR-01](../adr/0001-modular-monolith-worker.md) | Modular monolith + worker, không microservices |
| [ADR-02](../adr/0002-postgresql-ledger.md) | PostgreSQL làm sổ cái và nguồn sự thật |
| [ADR-03](../adr/0003-sync-transfer-async-outbox-sqs.md) | Chuyển tiền đồng bộ, tác vụ phụ bất đồng bộ qua outbox + SQS |

Liên quan trực tiếp: [ADR-04](../adr/0004-row-locking-read-committed.md) (khóa), [ADR-05](../adr/0005-idempotency-in-postgres.md) (idempotency), [ADR-07](../adr/0007-nestjs-typeorm-explicit-sql.md) (tầng truy cập dữ liệu), [ADR-09](../adr/0009-funding-system-account.md) (nạp tiền), [ADR-13](../adr/0013-one-app-app-role.md) (một image).

## 6. Checklist trước khi nộp

- [ ] Xuất OpenAPI từ code đã merge (tuần 2 đã có identity, accounts, nạp và chuyển tiền bản thô).
- [ ] Đối chiếu với mẫu hoặc rubric của giảng viên; mục thiếu có người nhận.
- [ ] Cả nhóm đọc và xác nhận; nộp; điền link ở cột P2 của [deliverables/README](README.md).
