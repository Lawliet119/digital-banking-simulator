# Tài liệu từng task (feature docs)

> **Status:** Active · **Owner:** cả nhóm · **Cập nhật:** 2026-11-07

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
| [DBS-64](DBS-64-read-accounts.md) | UC-4 own list/detail, exact PostgreSQL balances, audited reads and measured p95 | Dev | Implemented · [PR #66](https://github.com/Lawliet119/digital-banking-simulator/pull/66); chưa có Dev review (BL-160) |
| [DBS-60](DBS-60-operator-deposits.md) | UC-3 nạp tiền bản thô: operator nạp từ tài khoản SYSTEM funding, bút toán kép/audit/outbox/key atomic | Dev | Implemented · [PR #57](https://github.com/Lawliet119/digital-banking-simulator/pull/57) đã merge; chưa có Dev review (BL-160); replay DBS-79 còn BL-148 |
| [DBS-62](DBS-62-customer-onboarding.md) | UC-1 onboarding: tạo hồ sơ customers, create-or-return, GET của chính mình, audit cùng transaction, test HTTP/PostgreSQL đồng thời | Dev | Implemented · [PR #56](https://github.com/Lawliet119/digital-banking-simulator/pull/56) đã merge; chưa có Dev review (BL-160) |
| [DBS-63](DBS-63-open-accounts.md) | UC-2 mở CHECKING/SAVINGS, khóa customer để giữ giới hạn 3; audit atomic và test đồng thời | Dev | Implemented · [Draft PR #58](https://github.com/Lawliet119/digital-banking-simulator/pull/58); chờ Dev review và merge (BL-158) |
| [DBS-20](DBS-20-migration-users-customers-accounts.md) | Migration 1: users, customers, accounts và tài khoản SYSTEM funding | Dev | Implemented · [PR #7](https://github.com/Lawliet119/digital-banking-simulator/pull/7) đã merge; chưa có Dev review (BL-160) |
| [DBS-21](DBS-21-migration-transfers-ledger-idempotency.md) | Migration 2: transfers, ledger_entries, idempotency_keys, view v_transfer_facts | Dev | Implemented · [PR #8](https://github.com/Lawliet119/digital-banking-simulator/pull/8) đã merge; chưa có Dev review (BL-160) |
| [DBS-22](DBS-22-common-money-type-dto-validator.md) | @common/money: `Money`, `Balance`, `@IsMoneyAmount`, JSON an toàn cho bigint | Dev | Implemented · [PR #9](https://github.com/Lawliet119/digital-banking-simulator/pull/9) đã merge; chưa có Dev review (BL-160) |
| [DBS-24](DBS-24-common-events-types-schema.md) | @common/events: kiểu và hàm kiểm tra cho TransferCompleted, AccountStatusChanged | Dev | Implemented · [PR #10](https://github.com/Lawliet119/digital-banking-simulator/pull/10) đã merge; chưa có Dev review (BL-160) |
| [DBS-26](DBS-26-migration-audit-log.md) | Audit schema, ba index, revert giữ dữ liệu và manual PostgreSQL | Dev | Implemented · [PR #13](https://github.com/Lawliet119/digital-banking-simulator/pull/13) đã merge; chưa có Dev review (BL-160) |
| [DBS-27](DBS-27-append-only-triggers.md) | Trigger append-only ba bảng, test owner NOSUPERUSER và revert giữ dữ liệu | Dev | Implemented · [PR #17](https://github.com/Lawliet119/digital-banking-simulator/pull/17) đã merge; chưa có Dev review (BL-160) |
| [DBS-35](DBS-35-ci-github-actions.md) | GitHub Actions CI: sáu job song song (lint, typecheck, unit, e2e, db, build) trên mỗi PR và push `main` | Dev | Implemented · [PR #11](https://github.com/Lawliet119/digital-banking-simulator/pull/11) đã merge; chưa có Dev review (BL-160) |
| [DBS-39](DBS-39-testcontainers-postgres.md) | Testcontainers: helper Postgres 17 chạy migration cho test | Dev | Implemented · [PR #15](https://github.com/Lawliet119/digital-banking-simulator/pull/15) đã merge; chưa có Dev review (BL-160) |
| [DBS-40](DBS-40-valkey-elasticmq-testcontainers.md) | Testcontainers: helper Valkey và ElasticMQ, sample thao tác và mô phỏng sự cố | Dev | Implemented · [PR #18](https://github.com/Lawliet119/digital-banking-simulator/pull/18) đã merge; chưa có Dev review (BL-160) |
| [DBS-41](DBS-41-testcontainers-ci.md) | CI chạy Testcontainers PostgreSQL và migration run → revert → run trên DB tạm | Dev | Implemented · [PR #19](https://github.com/Lawliet119/digital-banking-simulator/pull/19) đã merge; chưa có Dev review (BL-160) |
| [DBS-25](DBS-25-migration-outbox-events.md) | Migration outbox_events và processed_events | Dev | Implemented · [PR #12](https://github.com/Lawliet119/digital-banking-simulator/pull/12) đã merge; chưa có Dev review (BL-160) |
| [DBS-42](DBS-42-json-logger.md) | Logger JSON, redaction, log level và HTTP correlation | Dev | Implemented · [PR #16](https://github.com/Lawliet119/digital-banking-simulator/pull/16) đã merge; chưa có Dev review (BL-160) |
| [DBS-31](DBS-31-terraform-bootstrap-s3-backend.md) | Terraform bootstrap: S3 state có versioning, mã hóa và khóa state | #5 Platform & Ops | Implemented · [PR #22](https://github.com/Lawliet119/digital-banking-simulator/pull/22) đã merge; chưa có Dev review (BL-160) |
| [DBS-33](DBS-33-terraform-vpc-ecr.md) | Terraform: VPC 2 AZ, gateway endpoint S3 và ECR `dbs-api` (stack `envs/dev/base`) | #5 Platform & Ops | Implemented · [PR #23](https://github.com/Lawliet119/digital-banking-simulator/pull/23) đã merge; chưa có Dev review (BL-160) |
| [DBS-50](DBS-50-jwt-auth-guard-jwks.md) | Identity: JwtAuthGuard xác minh JWT bằng JWKS có cache, guard toàn cục mặc định | Dev | Implemented · [PR #29](https://github.com/Lawliet119/digital-banking-simulator/pull/29) đã merge; chưa có Dev review (BL-160) |
| [DBS-55](DBS-55-accounts-service.md) | AccountsService: khóa theo id, đổi số dư trong caller transaction và ownership 404; vòng 2 (2026-10-31) bắt buộc đã khóa ở cấp ngoài cùng, lỗi có kiểu, `clock_timestamp()` | Dev | Implemented · [PR #33](https://github.com/Lawliet119/digital-banking-simulator/pull/33) đã merge; chưa có Dev review (BL-160) |
| [DBS-56](DBS-56-audit-service-record.md) | `AuditService.record`/`recordDenied`: ghi nhật ký fail-closed trong transaction của người gọi, DENIED trong transaction riêng | Dev | Implemented · [PR #54](https://github.com/Lawliet119/digital-banking-simulator/pull/54) đã merge; chưa có Dev review (BL-160) |
| [DBS-57](DBS-57-outbox-writer.md) | OutboxWriter: INSERT validated envelope trong transaction caller, correlation ALS nhất quán; vòng 2 (2026-10-31) từ chối chuỗi jsonb không lưu được, khóa hợp đồng context cho producer nền | Dev | Implemented · [PR #34](https://github.com/Lawliet119/digital-banking-simulator/pull/34) đã merge; chưa có Dev review (BL-160) |
| [DBS-69](DBS-69-ledger-invariants.md) | SQL/hàm/CLI kiểm năm bất biến sổ cái, test PostgreSQL và demo owner làm lệch/phục hồi | Dev | Implemented · [PR #35](https://github.com/Lawliet119/digital-banking-simulator/pull/35) đã merge; chưa có Dev review (BL-160) |
| [DBS-34](DBS-34-terraform-ecs-alb.md) | Terraform: ECS Fargate cluster, service api và ALB HTTPS (nhóm xóa hằng ngày) | #5 Platform & Ops | Implemented · [PR #25](https://github.com/Lawliet119/digital-banking-simulator/pull/25) đã merge; chưa có Dev review (BL-160) |
| [DBS-54](DBS-54-terraform-cognito.md) | Terraform: Cognito user pool, 4 nhóm, app client và script seed tài khoản nhân viên demo | #5 Platform & Ops | Implemented · [PR #39](https://github.com/Lawliet119/digital-banking-simulator/pull/39) đã merge; chưa có Dev review (BL-160) |
| [DBS-38](DBS-38-auto-deploy-ecs.md) | Deploy tự động: push main → image mới → ECS → /health/ready (role OIDC riêng, `deploy.sh`) | #5 Platform & Ops | Implemented · [PR #36](https://github.com/Lawliet119/digital-banking-simulator/pull/36) đã merge; chưa có Dev review (BL-160) |
| [DBS-66](DBS-66-terraform-rds.md) | Terraform: RDS PostgreSQL 17 (dev), mã hóa bằng KMS, ép TLS, SG chỉ từ task api | #5 Platform & Ops | Implemented · [PR #27](https://github.com/Lawliet119/digital-banking-simulator/pull/27) đã merge; chưa có Dev review (BL-160) |
| [DBS-36](DBS-36-ci-build-push-ecr-oidc.md) | CI: build image và đẩy ECR tag SHA bằng OIDC (role chỉ tin repo và nhánh main) | #5 Platform & Ops | Implemented · [PR #24](https://github.com/Lawliet119/digital-banking-simulator/pull/24) đã merge; chưa có Dev review (BL-160) |
| [FRAUD-API-01](FRAUD-API-01-external-ai-decision.md) | Hồ sơ ADR-14 (Proposed): giữ R1–R6, thêm API AI bổ sung, không tự train; phương án Proposed tách khỏi tài liệu Accepted; chưa triển khai backend fraud | #4 Fraud | Implemented · [PR #20](https://github.com/Lawliet119/digital-banking-simulator/pull/20) đã merge; chưa có Dev review (BL-160); docs-only, ADR-14 vẫn Proposed |
| [FRAUD-API-02](FRAUD-API-02-standalone-risk.md) | Adapter OpenAI Decisions và CLI độc lập; chưa nối fraud runtime | Fraud | Implemented — chờ Dev review và CI |
| [DBS-67](DBS-67-rds-tls-secrets.md) | RDS: task api đọc secret master, ghép `DATABASE_URL`, kết nối TLS xác minh CA (bundle ghim hash trong image) | #5 Platform & Ops | Implemented · [PR #37](https://github.com/Lawliet119/digital-banking-simulator/pull/37) đã merge; chưa có Dev review (BL-160) |
| [DBS-75](DBS-75-terraform-valkey.md) | Terraform: ElastiCache Valkey 8 (TLS bắt buộc, AUTH token write-only xoay bằng ROTATE), task api ghép `REDIS_URL` từ `REDIS_*` | #5 Platform & Ops | Implemented · [PR #41](https://github.com/Lawliet119/digital-banking-simulator/pull/41) đã merge; chưa có Dev review (BL-160) |
| [DBS-68](DBS-68-migration-step.md) | Bước migration riêng trong pipeline: task ECS `dbs-migrate` chạy một lần trước `update-service` | #5 Platform & Ops | Implemented · [PR #38](https://github.com/Lawliet119/digital-banking-simulator/pull/38) đã merge; chưa có Dev review (BL-160) |
| [DBS-53](DBS-53-local-test-auth-keys-tokens.md) | Identity: `AUTH_MODE=local` và `AUTH_LOCAL_JWKS_PATH` (app từ chối khởi động ở staging/production), `npm run auth:dev-keys` và `auth:dev-token` cấp token mẫu bốn vai, helper token cho e2e | Dev | Implemented · [PR #48](https://github.com/Lawliet119/digital-banking-simulator/pull/48) đã merge; chưa có Dev review (BL-160) |
| [DBS-52](DBS-52-users-upsert-first-token.md) | Identity: tạo dòng `users` bằng upsert theo `cognito_sub` ở token hợp lệ đầu tiên (`IdentityService.resolveUserId`, cache tiến trình) | Dev | Implemented · [PR #46](https://github.com/Lawliet119/digital-banking-simulator/pull/46) đã merge; chưa có Dev review (BL-160) |
| [DBS-51](DBS-51-roles-guard-current-user.md) | Identity: `@Roles`, `RolesGuard` (`APP_GUARD` thứ hai) và `@CurrentUser`; vai trò chỉ từ `cognito:groups`, không nhóm là `customer`, sai vai trò 403 `FORBIDDEN` | Dev | Implemented · [PR #47](https://github.com/Lawliet119/digital-banking-simulator/pull/47) đã merge; chưa có Dev review (BL-160) |
| [DBS-59](DBS-59-risk-module-skeleton.md) | Khung RiskModule, RiskRule và FeatureProvider | #4 Fraud | Implemented · [PR #42](https://github.com/Lawliet119/digital-banking-simulator/pull/42) đã merge; chưa có Dev review (BL-160) |
| [DBS-58](DBS-58-fraud-migration.md) | Migration risk_rule_sets v1, fraud_flags, fraud_rule_hits và trigger append-only | #4 Fraud | Implemented · [PR #44](https://github.com/Lawliet119/digital-banking-simulator/pull/44) đã merge; chưa có Dev review (BL-160) |
| [DBS-71](DBS-71-normal-fraud-dataset.md) | Generator CSV giao dịch bình thường có seed cố định, thói quen khách và đối soát số dư | Dev | Implemented · [PR #43](https://github.com/Lawliet119/digital-banking-simulator/pull/43) đã merge; chưa có Dev review (BL-160) |
| [DBS-77](DBS-77-sqs-adapter.md) | `libs/sqs`: gửi/nhận raw qua `@aws-sdk/client-sqs`, long polling/batch, `processBatch` chỉ xóa sau handler thành công, JSON hỏng chuyển DLQ trước khi xóa nguồn | Dev | Implemented · [PR #51](https://github.com/Lawliet119/digital-banking-simulator/pull/51) đã merge; chưa có Dev review (BL-160) |
| [DBS-78](DBS-78-health-redis-degraded.md) | Readiness returns200/degraded on Redis outage; PostgreSQL gates health | Dev | Implemented · [PR #67](https://github.com/Lawliet119/digital-banking-simulator/pull/67); chưa có Dev review (BL-160) |
| [DBS-76](DBS-76-redis-adapter.md) | `libs/redis`: bọc `ioredis` + `opossum`, timeout ≤50ms, breaker ADR-12, lỗi tường minh, counter `redis_fallback_total` trên registry riêng và `defaultRegister` | Dev | Implemented · [PR #52](https://github.com/Lawliet119/digital-banking-simulator/pull/52) đã merge; chưa có Dev review (BL-160) |
| [DBS-61](DBS-61-customer-transfers.md) | Chuyển tiền giữa khách: kiểm quyền nguồn, bút toán kép nguyên tử, lưu từ chối, audit, outbox | Dev | Implemented · [PR #61](https://github.com/Lawliet119/digital-banking-simulator/pull/61) đã merge; chưa có Dev review (BL-160); còn BL-154, BL-155, BL-156 |
| [DBS-79](DBS-79-idempotency-replay.md) | Idempotency: replay đúng kết quả cũ, AC-5.4 song song, số > 2^53, hash khóa sắp xếp (ADR-05) | Dev | Implemented · [PR #69](https://github.com/Lawliet119/digital-banking-simulator/pull/69); theo chế độ techlead, chưa có Dev review (BL-174) |
| [DBS-80](DBS-80-lock-order-retry-timeouts.md) | Chuyển chéo đồng thời, retry deadlock/serialization, timeout lock/statement/idle → 503 + Retry-After; sửa idle-in-transaction trả 500 | Dev | Implemented · [PR #70](https://github.com/Lawliet119/digital-banking-simulator/pull/70); theo chế độ techlead, chưa có Dev review (BL-174) |
| [DBS-81](DBS-81-rollback-waiting-same-key.md) | Review Focus 1: lệnh gốc rollback/commit khi lệnh cùng key đang chờ, cổng đồng bộ bằng khóa advisory và pg_locks, 20 vòng × 20 lần chạy | Dev | Implemented · PR đang mở; theo chế độ techlead, chưa có Dev review (BL-174) |
| [DBS-73](DBS-73-terraform-sqs.md) | Terraform: hai queue SQS (risk-events, notification-events), mỗi queue một DLQ, policy worker và chặn api (stack `envs/dev/base`) | #5 Platform & Ops | Implemented |
| [DBS-96](DBS-96-notification-log.md) | Migration `notification_log`: identity bigint, FK user nullable (RESTRICT), CHECK hai kind, index `event_id`; revert xóa bảng | Dev | Implemented · [PR #50](https://github.com/Lawliet119/digital-banking-simulator/pull/50); chưa có Dev review (BL-160) |
| [DBS-116](DBS-116-reconciliation-runs.md) | Migration kết quả đối soát, details chỉ ID/tiền chính xác, revert giữ dữ liệu và tương thích lifecycle27 | Dev | Implemented; G4 đã duyệt, [Draft PR #53](https://github.com/Lawliet119/digital-banking-simulator/pull/53); CI theo [Checks](https://github.com/Lawliet119/digital-banking-simulator/pull/53/checks), chờ Dev review/merge; code09e3703, manual10/10 đạt |
| [DBS-143](DBS-143-cost-report.md) | Báo cáo chi phí tuần từ Cost Explorer (`infra/scripts/cost-report.py`), bật tag chi phí `project`/`env`/`owner` ở `base` | #5 Platform & Ops | Implemented |
| [DBS-103](DBS-103-audit-search.md) | GET audit entries auditor-only, cursor chính xác và audit.search cùng transaction | Dev | Implemented (G4 2026-11-06); kiểm local và bằng chứng bàn giao ở feature doc; chờ tích hợp main mới/Dev review/CI/merge |
| [DBS-86](DBS-86-resource-ownership.md) | Mandatory ownership context, cùng404 và audit DENIED độc lập/fail-closed | Dev | Implemented (G4 2026-11-06), phạm vi service; HTTP DBS-61/64/87 và full AC-5.8 còn bàn giao; chờ tích hợp main mới/Dev review/CI/merge |
