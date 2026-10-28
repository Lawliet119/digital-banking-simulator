# Tài liệu từng task (feature docs)

> **Status:** Active · **Owner:** cả nhóm · **Cập nhật:** 2026-10-27

Mỗi task implement trên board (tính năng, sửa lỗi, hạ tầng, test) có **một file** ở đây: `DBS-<n>-<slug>.md`. File được viết trước khi code và hoàn tất khi bàn giao, theo skill [`dbs-delivering-task`](../../.claude/skills/dbs-delivering-task/SKILL.md) và mẫu [`feature-doc.md`](../../.claude/skills/dbs-delivering-task/templates/feature-doc.md).

| Mục | Nội dung | Viết ở phase |
|---|---|---|
| 1. Bối cảnh | Task, DoD chép từ board, phụ thuộc, phạm vi | 1 (duyệt ở G1) |
| 2. Hành vi | Quy tắc, ví dụ API, `errorCode`, ca biên | 2 |
| 3. Kiến trúc | Vị trí, interface, dữ liệu, transaction, sơ đồ | 2 |
| 4. Test cases tự động | `TC-<n>-NN`, truy vết DoD/AC | 2 |
| 5. Test thủ công | Kịch bản chạy tay bằng ứng dụng thật (`M-<n>-NN`) | 2 (duyệt ở G2) |
| 6. Domain review | Phát hiện của AI reviewer và cách xử lý | 2 |
| 7. Kế hoạch | Các bước, test viết trước, lệnh chứng minh | 3 (duyệt ở G3) |
| 8. Kết quả | Lệnh kiểm tra, đối chiếu test case, kết quả test thủ công, ảnh chụp, bàn giao | 4–5 (duyệt ở G4) |
| 9. Tài liệu đã cập nhật | File docs khác đã sửa | 5 |

Feature doc làm bằng mẫu 8 mục cũ (kiến trúc ở §2, hành vi ở §3, ví dụ DBS-20 khi được merge) giữ nguyên, không cần sửa lại.

**Ảnh chụp** tính năng sau khi implement nằm ở `screenshots/DBS-<n>/NN-mo-ta.png` và được nhúng vào mục 8 của file tương ứng.

Lỗi không có mã trên board dùng tên `BUG-YYYYMMDD-<slug>.md`.

`FRAUD-API-01` là mã task kiến trúc nội bộ đã được người yêu cầu cho phép tạo, không phải mã issue trên sheet.

## Danh sách

| Task | Tóm tắt | Vai | Trạng thái |
|---|---|---|---|
| [DBS-20](DBS-20-migration-users-customers-accounts.md) | Migration 1: users, customers, accounts và tài khoản SYSTEM funding | #1 Ledger | Implemented |
| [DBS-21](DBS-21-migration-transfers-ledger-idempotency.md) | Migration 2: transfers, ledger_entries, idempotency_keys, view v_transfer_facts | Dev | Implemented |
| [DBS-22](DBS-22-common-money-type-dto-validator.md) | @common/money: `Money`, `Balance`, `@IsMoneyAmount`, JSON an toàn cho bigint | Dev | Implemented |
| [DBS-24](DBS-24-common-events-types-schema.md) | @common/events: kiểu và hàm kiểm tra cho TransferCompleted, AccountStatusChanged | Dev | Implemented |
| [DBS-26](DBS-26-migration-audit-log.md) | Audit schema, ba index, revert giữ dữ liệu và manual PostgreSQL | Dev | Implemented |
| [DBS-27](DBS-27-append-only-triggers.md) | Trigger append-only ba bảng, test owner NOSUPERUSER và revert giữ dữ liệu | Dev | Implemented |
| [DBS-35](DBS-35-ci-github-actions.md) | GitHub Actions CI: sáu job song song (lint, typecheck, unit, e2e, db, build) trên mỗi PR và push `main` | Dev | Implemented |
| [DBS-39](DBS-39-testcontainers-postgres.md) | Testcontainers: helper Postgres 17 chạy migration cho test | Dev | Implemented |
| [DBS-41](DBS-41-testcontainers-ci.md) | CI chạy Testcontainers PostgreSQL và migration run → revert → run trên DB tạm | Dev | Implemented (PR mở) |
| [DBS-25](DBS-25-migration-outbox-events.md) | Migration outbox_events và processed_events | Dev | Implemented |
| [DBS-42](DBS-42-json-logger.md) | Logger JSON, redaction, log level và HTTP correlation | Dev | Implemented (PR #16, chờ Dev review và CI) |
| [DBS-31](DBS-31-terraform-bootstrap-s3-backend.md) | Terraform bootstrap: S3 state có versioning, mã hóa và khóa state | #5 Platform & Ops | Implemented |
| [DBS-33](DBS-33-terraform-vpc-ecr.md) | Terraform: VPC 2 AZ, gateway endpoint S3 và ECR `dbs-api` (stack `envs/dev/base`) | #5 Platform & Ops | Implemented |
| [DBS-50](DBS-50-jwt-auth-guard-jwks.md) | Identity: JwtAuthGuard xác minh JWT bằng JWKS có cache, guard toàn cục mặc định | Dev | Implemented |
| [DBS-57](DBS-57-outbox-writer.md) | OutboxWriter: INSERT validated envelope trong transaction caller, correlation ALS nhất quán | Dev | Implemented; G4 đã duyệt, chờ Dev review/merge; TC 13/13 và manual M01–07 đạt, full DB local native exit còn mở |
| [DBS-34](DBS-34-terraform-ecs-alb.md) | Terraform: ECS Fargate cluster, service api và ALB HTTPS (nhóm xóa hằng ngày) | #5 Platform & Ops | Implemented |
| [DBS-36](DBS-36-ci-build-push-ecr-oidc.md) | CI: build image và đẩy ECR tag SHA bằng OIDC (role chỉ tin repo và nhánh main) | #5 Platform & Ops | Implemented |
| [FRAUD-API-01](FRAUD-API-01-external-ai-decision.md) | Hồ sơ ADR-14 (Proposed): giữ R1–R6, thêm API AI bổ sung, không tự train; phương án Proposed tách khỏi tài liệu Accepted; chưa triển khai backend fraud | Fraud | Implemented (docs-only, Draft PR #20 chờ Dev review và CI) |
