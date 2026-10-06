# Components — Mục lục

> **Status:** Draft · **Owner:** cả nhóm · **Verified against code:** n/a (code mới có khung) · **Cập nhật:** 2026-10-03

Mỗi **component** (module code, hạ tầng, bộ dữ liệu, kịch bản test) có một thư mục. Dùng mục lục này để tìm nhanh component nào làm việc gì, rồi mở docs của nó.
Khác biệt giữa component và module: xem [glossary](_shared/glossary.md).

## Business modules (code trong `backend/src/modules/`)

| Component | Purpose | Key features | Owner | Docs |
|---|---|---|---|---|
| **`ledger`** | Nơi duy nhất được đổi số dư: nạp tiền, chuyển tiền, chống trùng, hạn mức, đối soát. | Bút toán kép, một transaction, idempotency theo user, khóa theo thứ tự id, sync guard, lưu REJECTED, đối soát. | #1 | [01](ledger/01-concept-brief.md) · [02](ledger/02-architecture.md) |
| **`accounts`** | Hồ sơ khách hàng, tài khoản, trạng thái khóa. | Onboarding, mở tài khoản (tối đa 3), xem số dư, khóa/mở khóa kèm thu hồi phiên, lockForUpdate/applyBalanceChange cho ledger. | #2 | [01](accounts/01-concept-brief.md) · [02](accounts/02-architecture.md) |
| **`identity`** | Ai đang gọi và được làm gì: JWT Cognito, vai trò, thu hồi phiên, rate limit. | Verify JWT bằng JWKS, guard theo nhóm customer/operator/auditor/admin, mốc thu hồi phiên, rate limit Redis fail-open. | #2 | [01](identity/01-concept-brief.md) · [02](identity/02-architecture.md) |
| **`risk`** | Phát hiện giao dịch đáng ngờ bằng 6 luật, gắn cờ có giải thích, nhân viên review. | 6 luật R1–R6 hàm thuần, chấm điểm bất đồng bộ, cờ + giải thích, review một lần, cấu hình luật có phiên bản. | #4 | [01](risk/01-concept-brief.md) · [02](risk/02-architecture.md) · [fraud guide](risk/FRAUD_DETECTION_GUIDE.md) |
| **`audit`** | Nhật ký bất biến: ai làm gì, khi nào, trên đối tượng nào; tra cứu cho kiểm toán viên. | `AuditService.record` trong transaction, fail-closed, chỉ INSERT, tra cứu theo người/hành động/thời gian/correlationId. | #3 | [01](audit/01-concept-brief.md) · [02](audit/02-architecture.md) |
| **`outbox`** | Đưa sự kiện từ bảng outbox ra các queue, ít nhất một lần, kèm khung consumer idempotent. | Relay SKIP LOCKED, bảng định tuyến, mỗi consumer một queue + DLQ, processed_events, event contract. | #3 | [01](outbox/01-concept-brief.md) · [02](outbox/02-architecture.md) |
| **`notification`** | Nhận sự kiện và gửi thông báo; v1 chỉ ghi log (giả lập). | Consumer notification-events, idempotent, retry có backoff, circuit breaker, không lộ lý do gian lận. | #3 | [01](notification/01-concept-brief.md) · [02](notification/02-architecture.md) |
| **`health`** | Probe sức khỏe cho load balancer: `/health/live`, `/health/ready`. | Liveness, readiness kiểm tra PostgreSQL, Redis báo degraded chứ không down. | #5 | [01](health/01-concept-brief.md) · [02](health/02-architecture.md) |

## Platform (hạ tầng, pipeline, quan sát)

| Component | Purpose | Key features | Owner | Docs |
|---|---|---|---|---|
| **`platform-infra`** | Hạ tầng AWS bằng Terraform: VPC, ECS Fargate, RDS, ElastiCache, SQS, Cognito, WAF, KMS. | Hai cấu hình dev/prod, tách phần giữ lại và phần dựng/xóa theo giờ, không NAT Gateway, Multi-AZ khi demo HA. | #5 | [01](platform-infra/01-concept-brief.md) · [02](platform-infra/02-architecture.md) |
| **`ci-cd`** | Từ commit tới cloud: lint, test, build một image, quét, đẩy ECR, deploy, rollback. | Lint → typecheck → unit → e2e (Testcontainers) → build → quét lỗ hổng/secret → ECR; OIDC; migration bước riêng. | #5 | [01](ci-cd/01-concept-brief.md) · [02](ci-cd/02-architecture.md) |
| **`observability`** | SLI/SLO, log JSON có correlationId, dashboard và alarm. | SLI chính, dashboard, alarm (error rate, latency, DLQ > 0, đối soát lệch, Redis), log cấu trúc. | #6 | [01](observability/01-concept-brief.md) · [02](observability/02-architecture.md) |

## Quality (dữ liệu đánh giá, load test)

| Component | Purpose | Key features | Owner | Docs |
|---|---|---|---|---|
| **`fraud-dataset`** | Generator dữ liệu giao dịch tổng hợp có nhãn gian lận để đánh giá các luật. | ~100k giao dịch, ~1% gian lận, hard negatives, 8 kịch bản, chia tune/holdout theo khách hàng. | #6 | [01](fraud-dataset/01-concept-brief.md) · [02](fraud-dataset/02-architecture.md) |
| **`load-tests`** | Kịch bản k6 và kiểm tra bất biến để chứng minh hiệu năng và tính đúng. | baseline, hot-account, duplicate, stress, rate-limit; kiểm tra bất biến sau mỗi lần chạy. | #6 | [01](load-tests/01-concept-brief.md) · [02](load-tests/02-architecture.md) |

## Dùng chung

- [`_shared/database-design.md`](_shared/database-design.md) — thiết kế DB: bảng, ràng buộc, index, quyền, vòng đời dữ liệu, migration.
- [`_shared/event-contract.md`](_shared/event-contract.md) — hình dạng sự kiện và bảng định tuyến.
- [`_shared/glossary.md`](_shared/glossary.md) — thuật ngữ kiến trúc.
- [`_templates/`](_templates/) — mẫu 5 file (01–05) để copy khi một component có code.

## Quy ước

- **Mỗi component có sẵn `01-concept-brief` và `02-architecture`** (khung, điền dần theo roadmap). `03-feature-description` và `04-test-cases` được tạo từ `_templates/` **khi component bắt đầu được triển khai**, trước khi viết code (trạng thái Draft); `05-backlog` được tạo **khi component có code**, để không có file rỗng.
- Mỗi file có dòng **Status** đầu file: `Draft | Accepted | Implemented`, owner, ngày cập nhật, đã đối chiếu với code chưa.
- **Một sự thật, một chỗ:** xem bảng ở [docs/README.md](../README.md).
- Đổi thiết kế thì cập nhật file ở đây **trong cùng PR**.
