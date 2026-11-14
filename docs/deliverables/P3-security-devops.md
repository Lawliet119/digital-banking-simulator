# P3 — Security & DevOps: Digital Banking Simulator

> **Status:** Bản ghép sẵn sàng nộp · **Dẫn dắt:** #5 Platform & Ops · **Cập nhật:** 2026-11-14
> Bản này **tóm tắt và trỏ về nguồn** (không viết lại tài liệu gốc). Nguồn chính: [Threat Model (STRIDE)](../security/threat-model.md), [docs/03 §12–13](../03_HIGH_LEVEL_ARCHITECTURE.md), [ADR-06](../adr/0006-cognito-ecs-fargate.md), [ADR-10](../adr/0010-fargate-egress-public-subnet.md), [ADR-11](../adr/0011-aws-managed-session-based.md), [infra/terraform/README.md](../../infra/terraform/README.md).

## 1. Threat Model (STRIDE)

- Tài liệu gốc: [docs/security/threat-model.md](../security/threat-model.md) (Accepted, 2026-10-11).
- Phạm vi: 2 luồng tiền cốt lõi (`UC-5` chuyển tiền, `UC-3` nạp tiền tại quầy) qua các ranh giới `Z0` (Internet) → `Z1` (WAF/ALB/Cognito) → `Z2` (ECS Fargate `api`/`worker`) → `Z3` (RDS PostgreSQL private subnet, Valkey TLS+AUTH, SQS+DLQ, Secrets Manager + KMS).
- Biện pháp kiểm soát hạ tầng trọng tâm: WAFv2 ở biên (`DBS-153`), TLS ALB + `TRUST_PROXY_HOPS=1` (`DBS-152`), KMS CMK mã hóa tĩnh & xoay khóa (`DBS-154`), tách IAM role `api` vs `worker` (`DBS-120`, `DBS-121`).

## 2. IAM, Secrets & Mã hóa (KMS CMK)

- **OIDC GitHub Actions & IAM least privilege:**
  - Role push ECR (`dbs-github-ecr-push`) và role deploy (`dbs-github-deploy`) qua OIDC GitHub (`DBS-36`, `DBS-38`).
  - Tách biệt role runtime `dbs-dev-api-task` (không có quyền SQS) và `dbs-dev-worker-task` (`sqs:ReceiveMessage`, `DeleteMessage`, `SendMessage` chỉ trên queue cần thiết), kèm SQS queue policy từ chối `api` (`DBS-120`, `DBS-121`).
  - DB roles tách biệt `dbs_api`, `dbs_worker`, `dbs_migrator` ([database-design §8](../components/_shared/database-design.md)).
- **KMS Customer Managed Key (CMK) — `DBS-154`** (nhánh `feat/DBS-154-kms-cmk`, đã kiểm chứng trên AWS thật):
  - `alias/dbs-dev` bật xoay khóa tự động 365 ngày (`rotation_period_in_days = 365`).
  - Key policy giới hạn `UseKeyOnlyThroughAwsServices` (`kms:ViaService` + `kms:CallerAccount`) và `GrantsForAwsServices` (`kms:GrantIsForAWSResource = "true"` + `kms:CallerAccount`), chặn mã hóa trực tiếp từ IAM user (`AccessDeniedException`).
  - Đã xác minh live bằng `verify-kms.sh` (exit 0): RDS (`1`), ElastiCache Valkey (`1`), SQS (`4`), Secrets Manager (`3`), `dbs-migrate` Fargate task đọc secret thành công, và diễn tập thu hồi khóa tạm (`KMS.DisabledException`).

## 3. CI/CD & Quét bảo mật chuỗi cung ứng

- **GitHub Actions CI/CD:** [DBS-35](../features/DBS-35-ci-github-actions.md), [DBS-36](../features/DBS-36-ci-build-push-ecr-oidc.md), [DBS-38](../features/DBS-38-auto-deploy-ecs.md), [DBS-68](../features/DBS-68-migration-step.md).
- **Quét Container & Secret — `DBS-155`:**
  - Trivy quét image Docker trước khi push/deploy (chặn `CRITICAL`/`HIGH` chưa vá hoặc theo baseline).
  - Gitleaks quét secret trên repo và lịch sử commit (`.gitleaksignore` cho JWT test fixture đã ghi lý do và ngày xem lại).
- **Pre-demo automation & FinOps:** [DBS-139](../features/README.md) (dựng cloud từ trống ≤ 30 phút), [DBS-143](../features/DBS-143-cost-report.md) (báo cáo Cost Explorer theo dịch vụ và tag).

## 4. Container, Mạng & WAF biên

- **Container (`Dockerfile`):** Multi-stage build, non-root user, image gắn tag theo SHA 40 ký tự (`IMAGE_TAG`), tích hợp RDS CA bundle ([DBS-67](../features/DBS-67-rds-tls-secrets.md)).
- **Mạng & Biên AWS:**
  - VPC tách public subnet (ALB, ECS Fargate theo [ADR-10](../adr/0010-fargate-egress-public-subnet.md)) và private subnet (RDS PostgreSQL, ElastiCache Valkey); default security group khóa hoàn toàn ([DBS-33](../features/DBS-33-terraform-vpc-ecr.md), [DBS-34](../features/DBS-34-terraform-ecs-alb.md)).
  - **AWS WAFv2 (`DBS-153`, nhánh `infra/DBS-153-waf-alb`):** gắn ALB `dbs-dev`, gồm `rate-limit` (1000 req/300s → `429`), `AWSManagedRulesCommonRuleSet` (`403`), `AWSManagedRulesKnownBadInputsRuleSet` (`403`), hỗ trợ `rate_limit_exempt_cidrs` và `managed_rules_count_only`. Đã kiểm chứng live trên AWS: XSS, LFI, Log4Shell, thiếu `User-Agent` trả `403`; burst vượt ngưỡng trả `429`; thêm CIDR miễn trừ hồi `200`; `count_only=true` cho qua và khôi phục về `403`.

## 5. Infrastructure as Code (Terraform `dev` & `prod`)

- **Kiến trúc Terraform (`base` + `session`):** [DBS-31](../features/DBS-31-terraform-bootstrap-s3-backend.md) (S3 backend + state lock), [DBS-66](../features/DBS-66-terraform-rds.md) (RDS), [DBS-75](../features/DBS-75-terraform-valkey.md) (Valkey), [infra/terraform/README.md](../../infra/terraform/README.md).
- **Môi trường `prod` (`DBS-152`, nhánh `feat/DBS-152-terraform-prod-env`):**
  - `infra/terraform/envs/prod/session` cấu hình TLS ALB, `TRUST_PROXY_HOPS=1`, Redis TLS, DB SSL (`DB_SSL=true`), tắt Swagger (`SWAGGER_ENABLED=false`).
  - Đã kiểm chứng offline: `terraform fmt`, `prod/session` (`17 passed`), `dev/base` (`53 passed`), `dev/session` (`66 passed`), `check-prod-config.mjs --self-test` (`PASS`), `terraform plan -lock=false` đọc từ state live.

## 6. Deploy, Rollback & Sẵn sàng sự cố

- **Diễn tập Rollback (`DBS-156`, nhánh `docs/DBS-156-rollback-drill`):**
  - Runbook rollback ECS (`docs/runbooks/rollback.md`) và script tự động (`docs/deliverables/P3-rollback-drill/drill.sh`).
  - **Kết quả diễn tập live trên `dev/session` (2026-11-14):** Deploy revision lỗi `DB_HOST=broken-db-host.invalid` → `/health/ready` rơi xuống `503` sau `+30 s`. Rollback về revision ổn định (`dbs-api:7`, `dbs-worker:4`): `/health/ready` hồi phục `200` sau **`+78 s`**, `api` `COMPLETED` sau **`+108 s`**, `worker` `COMPLETED` sau **`+299 s`**, toàn bộ diễn tập hoàn tất trong **`301 s`** (~5 phút, đạt ngưỡng **≤ 600 s**).
- **Giám sát DLQ & Queue Age (`DBS-163`, nhánh `feat/DBS-163-dlq-age-alarms`):**
  - Runbook redrive DLQ (`docs/runbooks/dlq-redrive.md`) và 4 alarm SQS/DLQ nối SNS `dbs-dev-alarms`.
  - **Kết quả kiểm chứng live (2026-11-14):** Inject poison message vào `dbs-dev-risk-events` → chuyển sang DLQ sau `maxReceiveCount=5` → `dbs-dev-risk-dlq-not-empty` bật `ALARM` sau **`+155 s`** và về `OK` sau **`+178 s`**; message tồn đọng ở `dbs-dev-notification-events` → `dbs-dev-notification-events-age` bật `ALARM` sau **`+259 s`** và về `OK` sau **`+113 s`**.

## 7. Trạng thái hoàn thành & Lưu ý bàn giao

- Các nhánh thành phần của P3 (`feat/DBS-152-terraform-prod-env`, `infra/DBS-153-waf-alb`, `feat/DBS-154-kms-cmk`, `docs/DBS-156-rollback-drill`, `feat/DBS-163-dlq-age-alarms`) đã hoàn thiện kiểm chứng offline + live AWS và sẵn sàng mở PR vào `main`.
- Chi tiết bằng chứng từng task nằm tại `docs/features/screenshots/DBS-153/`, `DBS-154/`, `DBS-156/`, `DBS-163/` trên các nhánh tương ứng.
