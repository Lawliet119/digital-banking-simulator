# infra/terraform

Hạ tầng AWS viết bằng Terraform. Phụ trách: #5.

## Cấu trúc

```
infra/terraform/
├── bootstrap/        # S3 bucket lưu state (tạo một lần, xem bên dưới)
├── modules/          # network, ecr, kms, ecs, rds, redis, sqs, cognito, monitoring…
└── envs/
    ├── dev/
    │   ├── base/     # phần giữ lại: VPC, ECR, KMS, Cognito, logs, OIDC, SQS (hiếm khi đổi)
    │   ├── session/  # phần dựng/xóa hằng ngày: RDS, ElastiCache, ALB, ECS, WAF
    │   └── loadgen/  # máy chạy k6 cùng region, bucket và client Cognito tạm cho một đợt đo tải (DBS-166)
    └── prod/
        └── session/  # Multi-AZ, ≥ 2 task; dùng lại base của dev qua remote state
```

Mỗi thư mục stack có `backend.tf` và `backend.hcl.example` riêng. `terraform destroy` một stack chỉ xóa phần của nó, nên `session` có thể xóa mỗi ngày mà không đụng `base`.

| Giữ lại (gần như miễn phí) | Dựng / xóa hằng ngày |
|---|---|
| S3 state, ECR, VPC, KMS, Cognito, logs, SNS, OIDC, SQS | RDS, ElastiCache, ALB, ECS service, WAF |

Security group và subnet group (ECS, RDS, ElastiCache, ALB) nằm ở `base` (miễn phí, ADR-11); tài nguyên ở `session` tham chiếu chúng qua `terraform_remote_state`.

## Quy ước

- Terraform `>= 1.11` (khóa state bằng file khóa S3, không cần DynamoDB), provider `hashicorp/aws ~> 6.0` (`session` thêm `hashicorp/tls ~> 4.0` cho chứng chỉ self-signed của dev). Commit `.terraform.lock.hcl`.
- Region `ap-southeast-1`. Tên tài nguyên có tiền tố `dbs-<env>-`. Ngoại lệ: repo ECR `dbs-api`, vì một repo dùng chung cho dev và prod (`prod/session` dùng lại `base` của dev).
- Tag bắt buộc trên mọi tài nguyên hỗ trợ tag, đặt bằng `default_tags` của provider: `project=dbs`, `env=dev|prod`, `owner=platform` ([ADR-11](../../docs/adr/0011-aws-managed-session-based.md)). Bucket state dùng chung cho dev và prod nên mang `env=dev`.
- **Không commit** `*.tfvars`, `terraform.tfstate`, `backend.hcl` (đã có trong `.gitignore`). Dùng `*.example` làm mẫu.
- **Không tạo NAT Gateway** và không tạo VPC interface endpoint ([ADR-10](../../docs/adr/0010-fargate-egress-public-subnet.md)). Task ECS ở public subnet, security group chỉ nhận từ ALB.
- Credential: access key của IAM user trong group `dbs-admin`, đặt bằng `aws configure --profile dbs-admin` rồi `AWS_PROFILE=dbs-admin`. Không bắt MFA cho CLI (policy `dbs-require-mfa` đã gỡ, 2026-10-25); console vẫn đăng nhập bằng MFA. **Không dán key vào chat hay commit.**
- Ai `apply` phần dựng/xóa thì `destroy` khi xong và báo trong kênh chat lúc bật, lúc tắt.
- Bật AWS Budget alarm (50 / 100 / 150 USD) trước khi dựng bất cứ thứ gì.

## State

Bucket `dbs-tfstate-<account-id>-ap-southeast-1`: versioning, mã hóa SSE-S3, chặn public, từ chối truy cập không TLS, khóa state bằng `use_lockfile`, `prevent_destroy`. Mỗi stack một key:

| Stack | Key |
|---|---|
| `bootstrap` | `bootstrap.tfstate` |
| `envs/dev/base` | `dev/base.tfstate` |
| `envs/dev/session` | `dev/session.tfstate` |
| `envs/prod/session` | `prod/session.tfstate` |

State sẽ chứa bí mật (RDS, Cognito) và chỉ được bảo vệ bằng IAM, nên chỉ cấp cho người dùng state các quyền tối thiểu: `s3:ListBucket`, `s3:GetBucketVersioning` trên bucket; `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` trên `bucket/*`. Quyền quản trị bucket chỉ dành cho người `apply` bootstrap.

### Dùng backend (mọi người)

```bash
cd infra/terraform/<stack>
cp backend.hcl.example backend.hcl   # thay <account-id> bằng 12 chữ số
terraform init -backend-config=backend.hcl
```

### Bootstrap lần đầu (một lần, chủ tài khoản)

```bash
cd infra/terraform/bootstrap
mv backend.tf backend.tf.off
terraform init
terraform plan  -var account_id=<account-id>
terraform apply -var account_id=<account-id>
mv backend.tf.off backend.tf
cp backend.hcl.example backend.hcl   # thay <account-id>
terraform init -migrate-state -force-copy -backend-config=backend.hcl
rm -f terraform.tfstate terraform.tfstate.backup
```

Kiểm tra: `aws s3 ls s3://dbs-tfstate-<account-id>-ap-southeast-1/` thấy `bootstrap.tfstate`.

## Thứ tự dựng và xóa (dev)

Biến cần có:

| Stack | Biến | Ghi chú |
|---|---|---|
| `bootstrap`, `envs/dev/base` | `account_id` | 12 chữ số; provider từ chối nếu profile thuộc account khác |
| `envs/dev/session` | `state_bucket` | tên bucket state (output `state_bucket_name` của `bootstrap`) |
| `envs/dev/session` | `account_id`, `image_tag` | `image_tag` là SHA 40 ký tự của commit đã có trên ECR (không `latest`); `desired_count` mặc định 0 (task chưa chạy được khi thiếu DB, Redis, Cognito), `node_env` mặc định `staging` |

Dựng: `bootstrap` (một lần) → `envs/dev/base` → `envs/dev/session`.

```bash
cd infra/terraform/envs/dev/base
cp backend.hcl.example backend.hcl   # thay <account-id>
terraform init -backend-config=backend.hcl
terraform plan -out=base.tfplan -var account_id=<account-id>
terraform apply base.tfplan

cd ../session
cp backend.hcl.example backend.hcl
terraform init -backend-config=backend.hcl
terraform plan -var account_id=<account-id> -var state_bucket=dbs-tfstate-<account-id>-ap-southeast-1 -var image_tag=<sha-40-ky-tu>
terraform apply -var account_id=<account-id> -var state_bucket=dbs-tfstate-<account-id>-ap-southeast-1 -var image_tag=<sha-40-ky-tu>
# xong việc: một lệnh xóa toàn bộ phần tính tiền (ALB, ECS, chứng chỉ)
terraform destroy -var account_id=<account-id> -var state_bucket=dbs-tfstate-<account-id>-ap-southeast-1 -var image_tag=<sha-40-ky-tu>
```

### Dashboard CloudWatch (DBS-145, DBS-178)

`envs/dev/session/dashboard.tf` tạo `aws_cloudwatch_dashboard.overview` (`dbs-dev-overview`) cùng phiên; output `dashboard_url`. Dashboard không tham chiếu tài nguyên nào của session (chỉ tên DLQ từ state của `base`), nên có thể dựng riêng, không kéo ALB/RDS: `terraform apply -target=aws_cloudwatch_dashboard.overview` (cần `-var` như các lệnh trên). Xóa cùng `destroy` của session. Biến `metrics_namespace` (mặc định `DBS/Backend`) chỉ đổi khi thử bằng số mô phỏng. Hai phiên cùng dựng thì dùng chung một tên dashboard (PutDashboard ghi đè): chỉ một state được giữ nó. Chi phí ≈ 3 USD/tháng tính theo giờ tồn tại. Nội dung widget và cách đọc: [observability](../../docs/components/observability/01-concept-brief.md#dashboard-dbs-145-dbs-178). **DBS-178:** dashboard có 33 widget xếp theo nhóm (trạng thái alarm và health, API, hàng đợi, Redis và đối soát, fraud); widget trạng thái alarm liệt kê 20 alarm theo ARN dựng từ chuỗi `arn:aws:cloudwatch:<region>:<account_id>:alarm:<tên>` (danh sách `dash_alarm_names` trong `dashboard.tf`, không tham chiếu `aws_cloudwatch_metric_alarm` để `-target` vẫn kéo đúng một dashboard; hai alarm `dlq-oldest-age` chưa có vì chưa apply ở `base`, BL-409). Chụp ảnh lúc chạy tải bằng `node infra/scripts/dashboard-snapshot.mjs --profile dbs --start <ISO Z> --end <ISO Z> --out <thư mục>` (chỉ đọc; `singleValue` vẽ thành đường, `text` và `alarm` bỏ qua): xem [mục «Chụp ảnh lúc chạy tải»](../../docs/components/observability/01-concept-brief.md#chụp-ảnh-lúc-chạy-tải-dbs-178).

**Dashboard hạ tầng (BL-261).** `envs/dev/session/dashboard_infra.tf` tạo thêm `dbs-dev-infra` (output `infra_dashboard_url`): ECS CPU và bộ nhớ của `api` và `worker`, số task api khỏe sau ALB, 5xx ở ALB (số lượng và tỉ lệ), RDS (kết nối, CPU), Valkey (CPU, bộ nhớ, kết nối). Nó **tách** khỏi `overview` vì widget ALB cần `arn_suffix` của `aws_lb` và target group (không dựng được từ chuỗi biết trước), nên dashboard này tham chiếu tài nguyên session và `-target` nó sẽ kéo cả ALB lên; `overview` vẫn không tham chiếu gì nên giữ tính chất `-target` ở trên. Số task đang chạy của ECS (`RunningTaskCount`) cần Container Insights, đang tắt ở `ecs.tf` (bật tốn tiền theo task), nên chưa có số task của worker: xem tuổi outbox (không có điểm là worker không chạy). Hai dashboard nằm trong 3 dashboard miễn phí của tài khoản (tối đa 50 metric mỗi dashboard).

### Alarm CloudWatch và thông báo (BL-051, BL-117, BL-127, BL-179, BL-182, BL-188, BL-235, DBS-177)

Mọi alarm gửi vào topic SNS `dbs-dev-alarms`, cả lúc báo (`alarm_actions`) lẫn lúc hết (`ok_actions`).

- `envs/dev/base/alarms.tf`: topic SNS, đăng ký email (biến `alarm_email`, mặc định rỗng = không đăng ký), 4 alarm DLQ (`dbs-dev-risk-dlq-not-empty`, `dbs-dev-notification-dlq-not-empty` và hai alarm `…-dlq-oldest-age` của RSK-04). Ở base để email chỉ phải xác nhận **một lần** (không mất theo `destroy` của session) và để alarm DLQ còn đó khi session đã xóa nhưng DLQ vẫn giữ message tới 6 ngày. Output `alarm_topic_arn`.
- `envs/dev/session/alarms.tf`: 18 alarm của thứ chỉ có khi phiên chạy (tuổi queue, tuổi và cách ly outbox, Redis, fallback, độ tươi cấu hình luật, rate limit, risk, cờ trên 1.000 giao dịch `dbs-dev-risk-flag-rate` (DBS-188), đối soát, tỉ lệ 5xx API, latency chuyển tiền p95, latency đọc p95, thời gian tới cờ p95). Đọc `alarm_topic_arn` từ state của `base`, nên **phải apply `base` trước `session`** (session cũ không có output này sẽ lỗi lúc plan).
- Bảng alarm, ngưỡng, cửa sổ và lý do: [observability](../../docs/components/observability/01-concept-brief.md#alarm-cloudwatch-bl-051-bl-117-bl-127-bl-179-bl-181-bl-182).

```bash
# base: đặt email nhận alarm (SNS gửi thư xác nhận; chưa bấm "Confirm subscription" thì không có thư alarm)
terraform apply -var account_id=<account-id> -var alarm_email=<email>
```

Chi phí: 22 alarm (4 ở base, 18 ở session). Alarm chuẩn 0,10 USD/alarm/tháng; alarm biểu thức metric (`SUM(METRICS())` / `MAX(METRICS())` / công thức tỉ lệ) tính theo số metric tham chiếu (alarm lỗi luật và tỉ lệ fallback AI 6, latency đọc 3, các alarm đối soát, Redis fallback, rate limit, 5xx và cờ/1.000 giao dịch mỗi cái 2). Ước ≈ 3,9 USD/tháng nếu chạy cả tháng, trong đó 0,4 USD của bốn alarm DLQ ở base chạy luôn; alarm của session tính theo giờ và mất cùng phiên. SNS email gần như miễn phí. Thử alarm thật (đẩy message độc vào DLQ, ép lỗi luật, tải 5xx/latency) cần AWS thật và chưa làm: còn mở ở BL-051, BL-341.

### Đẩy image lên ECR bằng OIDC (DBS-36)

`envs/dev/base` tạo OIDC provider của GitHub và role `dbs-github-ecr-push` (output `github_ecr_push_role_arn`). Role chỉ tin đúng `sub` của repo và nhánh `main` (repo bật immutable subject nên `sub` có id owner và id repo). Biến `github_oidc_sub_prefix` có sẵn giá trị đã kiểm; đổi repo thì lấy giá trị mới bằng `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (trường `sub_claim_prefix`).

Sau khi `apply`, **chủ repo** (cần quyền admin) tạo biến Actions (Settings → Secrets and variables → Actions → Variables, không phải Secrets): `AWS_ROLE_ARN` = output ở trên, và tùy chọn `AWS_REGION`. Tạo trước khi merge `image.yml`; thiếu biến thì job `image-push` bị bỏ qua, chạy lại bằng `gh workflow run image.yml --ref main`. Chỉ `image.yml` được xin `id-token: write`.

### Deploy tự động lên ECS (DBS-38)

`envs/dev/base` thêm role `dbs-github-deploy` (output `github_deploy_role_arn`). Từ BL-105 role chỉ tin `sub` của **environment `dev`** (`<tiền tố repo>:environment:dev`, biến `github_deploy_environment`), không còn tin nhánh `main` như role đẩy image: job `deploy` của `deploy.yml` khai `environment: dev` (không có người duyệt) nên workflow khác trên `main` không assume được role ghi ECS. Chủ repo tạo environment một lần, trước khi bật deploy:

```bash
# environment dev: không người duyệt, chỉ nhánh được bảo vệ (main) được triển khai
echo '{"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}' \
  | gh api -X PUT repos/Lawliet119/digital-banking-simulator/environments/dev --input -
terraform -chdir=infra/terraform/envs/dev/base apply -var account_id=<account-id>   # đổi trust của role deploy
```

OIDC thật assume từ `deploy.yml` chưa thử (chờ BL-104: biến `AWS_DEPLOY_ROLE_ARN`); lúc đó `gh workflow run deploy.yml --ref main` rồi xác nhận bước `configure-aws-credentials` thành công (xem [DBS-38 §11](../../docs/features/DBS-38-auto-deploy-ecs.md)). Quyền của role chỉ gồm cập nhật service `dbs-dev/api`, đăng ký task definition `dbs-api`, đọc image trên ECR và `iam:PassRole` cho hai role của task. Sau khi `apply`, **chủ repo** tạo biến Actions `AWS_DEPLOY_ROLE_ARN` (thiếu biến thì job `deploy` bị bỏ qua). Chỉ `image.yml` và `deploy.yml` được xin `id-token: write`.

Luồng: push `main` → `Image` đẩy `dbs-api:<SHA>` → `Deploy` (`.github/workflows/deploy.yml`, `workflow_run`) chạy `.github/scripts/deploy.sh`: lấy revision ACTIVE mới nhất của family `dbs-api`, đổi image container `api`, đăng ký revision mới, `update-service`, chờ deployment PRIMARY `COMPLETED` (tối đa 20 phút; circuit breaker đã rollback hoặc `FAILED` thì đỏ), rồi kiểm `/health/live` và `/health/ready`. Sau khi api khỏe, `deploy.sh` lăn tiếp service `worker` (BL-248) cùng image: lấy revision ACTIVE mới nhất của family `dbs-worker`, đổi image container `worker`, đăng ký, `update-service`, rồi chờ PRIMARY `COMPLETED` với `runningCount` đủ `desiredCount` (worker lăn 0%/100%). `desiredCount` của worker = 0 (mặc định của stack): vẫn đăng ký và trỏ service về revision mới nhưng không chờ; service worker không ACTIVE thì cảnh báo và bỏ qua; `DEPLOY_WORKER=0` tắt bước này. Api lỗi thì worker không bị đụng (cả hai cùng ở bản cũ). Bỏ qua (thoát 0) khi stack `session` chưa dựng, service `desired_count = 0`, hoặc commit không còn là đầu `main`. Service có `ignore_changes = [task_definition]`: `terraform apply` không kéo về revision của Terraform; thay đổi task definition trong Terraform có hiệu lực ở lần deploy kế tiếp. `image_tag` lúc `apply` session phải là tag đã có trên ECR.

Chạy tay (không cần `gh`): `IMAGE_TAG=<sha-40-ky-tu> AWS_PROFILE=dbs-admin bash .github/scripts/deploy.sh`.

**Kiểm sống** (chứng chỉ self-signed nên cần `-k`):

```bash
ALB=$(aws elbv2 describe-load-balancers --names dbs-dev --query 'LoadBalancers[0].DNSName' --output text)
curl -sk -o /dev/null -w '%{http_code}\n' https://$ALB/health/live
curl -sk -o /dev/null -w '%{http_code}\n' https://$ALB/health/ready
```

**Rollback thủ công** (đã diễn tập ở [DBS-156](../../docs/features/DBS-156-rollback-drill.md): 267 s cho cả hai service, ngưỡng 600 s). Quy trình đầy đủ ở [runbook rollback](../../docs/runbooks/rollback.md): rollback **cả** service `api` và `worker` (tên service không có tiền tố `dbs-dev-`), chọn revision chạy ngay trước bản lỗi (revision `ACTIVE` của phiên cũ vẫn còn sau `destroy`), sau đó **hủy đăng ký revision lỗi** và tắt workflow `Deploy` tới khi có bản sửa, vì `deploy.sh` dựng lần deploy kế tiếp từ revision `ACTIVE` mới nhất. Chỉ quay lại được image còn trong ECR (giữ 20 image mới nhất):

```bash
aws ecs list-task-definitions --family-prefix dbs-api --status ACTIVE --sort DESC --max-items 5      # tương tự dbs-worker
aws ecs update-service --cluster dbs-dev --service api    --task-definition dbs-api:<revision>    --force-new-deployment
aws ecs update-service --cluster dbs-dev --service worker --task-definition dbs-worker:<revision> --force-new-deployment
aws ecs describe-services --cluster dbs-dev --services api worker --query 'services[*].deployments'   # PRIMARY phải COMPLETED
```

### Migration trước deploy (DBS-68)

Migration chạy như một task ECS Fargate chạy một lần (family `dbs-migrate`, container `migrate`, lệnh `migration:run`), vì runner GitHub không với tới RDS. `deploy.sh` gọi `.github/scripts/migrate.sh` giữa "đăng ký revision api mới" và `update-service`: script đăng ký revision `dbs-migrate` với image của commit, `run-task` trong subnet và SG của service `api`, chờ `STOPPED`, đọc `exitCode`. Lỗi (exit khác 0, quá 600 s, không tạo được task) thì `deploy.sh` dừng trước `update-service` và service vẫn chạy bản cũ; log 50 dòng cuối của task được in trong nhóm `Log task migration`. Chạy lần hai khi không còn migration chờ là vô hại (TypeORM ghi vào bảng `migrations`).

**Chạy tay:**

```bash
IMAGE_TAG=<sha-40-ky-tu> AWS_PROFILE=dbs-admin bash .github/scripts/migrate.sh
```

Script từ chối chạy khi còn task `dbs-migrate` đang `RUNNING` (TypeORM không có khóa nên hai lần chạy chồng nhau sẽ va nhau). Đọc log của một lần chạy: `aws logs get-log-events --log-group-name /dbs/dev/api --log-stream-name migrate/migrate/<task-id>`.

**Trình tự "Up" lần đầu** (`desired_count = 0` nên `deploy.sh` bỏ qua): `apply session` → `Image` đã đẩy tag SHA lên ECR → **`db-roles.sh` bằng tay (BL-103, xem "Role DB riêng cho api, worker và migrate")** → `migrate.sh` bằng tay → nâng `desired_count` lên 1. Chưa chạy `db-roles.sh` thì `migrate.sh` thoát 1 với `password authentication failed for user "dbs_migrator"` (role chưa có LOGIN).

**Role chạy migration (BL-195, BL-103).** Từ BL-103 task `dbs-migrate` nối bằng role `dbs_migrator`, không còn bằng master. Master của RDS **không phải superuser thật**, nên cần hai điều kiện mà `db-roles.sh` (task `dbs-db-roles`, bên dưới) đã lo trước migration đầu tiên của database mới: (1) `dbs_migrator` tồn tại, có LOGIN, mật khẩu, `USAGE, CREATE` trên schema `public` (thuộc `pg_database_owner`, tức master) và `CREATE` trên database `dbs` (migration `1795000008000-EnableUnaccentSearch` chạy `CREATE EXTENSION unaccent`, extension *trusted* từ PG 13); (2) vì chính `dbs_migrator` chạy mọi migration nên nó **là chủ mọi bảng** ngay từ đầu, và `ALTER VIEW v_transfer_facts OWNER TO dbs_migrator` của migration bước 7 (`1793664000000-CreateDbRolesAndGrants`, DBS-119) chỉ đổi chủ sang chính nó, không cần `SET ROLE` và không cần `GRANT dbs_migrator TO <master>` (nên không còn bước tay của BL-195). Migration bước 7 chỉ tạo role khi chưa có và **không bao giờ tự gán quyền cho user chạy nó**. Mọi migration sau đó phải chạy bằng `dbs_migrator`, vì role này là chủ các bảng: đừng chạy migration bằng master khi database đã được `dbs_migrator` migrate (master không sở hữu bảng nào). Database đã được master migrate từ **trước** BL-103 (phiên đang chạy khi chuyển sang code này): `db-roles.sh` đưa chủ sở hữu các bảng, view, hàm, kiểu enum/domain của schema `public` sang `dbs_migrator` (bỏ qua thành phần của extension). Bằng chứng: `backend/test/db/db-role-provisioning.db-spec.ts` (PostgreSQL 17 trong Testcontainers, master giả lập là login `CREATEROLE` không superuser): cấp login, migrate toàn bộ bằng `dbs_migrator` (chạy lại không có gì chờ), nối bằng `dbs_api` và `dbs_worker`, và ca database đã migrate bằng master rồi được đổi chủ. Cũng như `migration-owner-role.db-spec.ts` (BL-195), test này mô phỏng master, **không phải RDS**: `rds_superuser` thật chỉ kiểm được trong phiên AWS; BL-103 còn mở tới đó.

### Role DB riêng cho api, worker và migrate (BL-103)

Mỗi thành phần nối RDS bằng role của mình (ma trận quyền ở [DBS-119](../../docs/features/DBS-119-db-roles-grant-matrix.md) §8.1); chỉ task `dbs-db-roles` dùng master.

| Thành phần | Role DB | Secret (Secrets Manager, JSON `username`, `password`) | Execution role đọc secret |
|---|---|---|---|
| task `api` | `dbs_api` | `dbs/dev/db-api` | `dbs-dev-api-execution` |
| service `worker` | `dbs_worker` | `dbs/dev/db-worker` | `dbs-dev-worker-execution` |
| task `dbs-migrate` | `dbs_migrator` | `dbs/dev/db-migrator` | `dbs-dev-migrate-execution` |
| task `dbs-db-roles` (một lần) | master (`dbs_master`) + mật khẩu của ba role để đặt | secret master của RDS và ba secret trên | `dbs-dev-db-roles-execution` (không task role) |

- **Sinh mật khẩu (`session/db_roles.tf`).** `ephemeral random_password` 32 ký tự chữ-số cho mỗi role, ghi vào secret bằng thuộc tính write-only `secret_string_wo`: mật khẩu **không nằm trong state hay plan**. Đã chọn cách này thay `random_password` thường (lưu `result` trong state; state mã hóa ở S3 nên chấp nhận được, nhưng ephemeral cho cùng kết quả mà không để lại gì) vì provider aws ≥ 6.70 đã hỗ trợ và `redis.tf` dùng sẵn. Cái giá: Terraform không đọc lại được mật khẩu, nên đổi mật khẩu là tăng `-var db_role_password_version=<n+1>` (không có xoay tự động). Secret nằm ở `session` (dựng và xóa cùng RDS, `recovery_window_in_days = 0`, mã hóa bằng CMK `alias/dbs-dev` như secret master); ARN đổi mỗi phiên.
- **Đặt LOGIN và mật khẩu: `AWS_PROFILE=dbs-admin bash infra/scripts/db-roles.sh`.** Chạy tay bằng quyền admin, **không** trong pipeline (pipeline không được chạy task đọc secret master). Một task ECS chạy trong VPC (cùng mạng service api) chạy `node dist/scripts/provision-db-roles.main.js` bằng master, trong một transaction: tạo ba role nếu thiếu; `ALTER ROLE … LOGIN PASSWORD '<verifier SCRAM-SHA-256>'` (server chỉ nhận verifier, nên lệnh lỗi trong log RDS cũng không lộ mật khẩu); `GRANT USAGE, CREATE ON SCHEMA public` và `CREATE ON DATABASE` cho `dbs_migrator`; đổi chủ các đối tượng còn thuộc master. Sau khi commit, đăng nhập thử bằng từng role với đúng mật khẩu trong secret: mật khẩu Secrets Manager mà DB không nhận sẽ làm task thoát khác 0 ngay tại đây. Idempotent. Mật khẩu chỉ đi bằng `secrets` của task definition (không `containerOverrides`, nên không có trong `describe-tasks` hay CloudTrail) và không vào log (script chỉ in tên role). Quyền bảng **không** do bước này cấp: migration bước 7 và `infra/scripts/db-roles.sql` làm.
- **Khi nào chạy lại.** Mỗi database mới (sau mỗi `apply` session sau `destroy`), trước `migrate.sh` đầu tiên; sau khi tăng `db_role_password_version` (rồi khởi động lại task api và worker, task đang chạy giữ mật khẩu cũ; xem BL-107). `IMAGE_TAG=<sha>` đổi image của task (mặc định dùng image trong revision Terraform, tức `image_tag` của `apply`; image phải có `dist/scripts/provision-db-roles.main.js`).
- **Không còn đường master ngoài `dbs-db-roles`.** Chính sách đọc secret của execution role api, worker và migrate chỉ trỏ tới secret role của chính nó; task definition của chúng không nhắc `rds!db-…`. Test: `terraform test` ở `envs/dev/session`, run `bl103_role_credentials`.
- **Kết nối.** Pool không đổi (10 mỗi task), nên `số task × 10 + 5 ≤ max_connections − reserved` giữ như cũ (DBS-66 §8, tối đa 6 task cho 74 kết nối dùng được của `db.t4g.micro`). Giới hạn kết nối theo role (`CONNECTION LIMIT`) chưa đặt.
- **Chưa chạy trên AWS.** Code, test Terraform, test script và test PostgreSQL 17 đã xong; phiên AWS cần xác nhận `rds_superuser` thật, ECS đọc JSON key của secret mới, và `/health/ready` 200 khi api nối bằng `dbs_api`.

**Quy tắc:** migration chạy khi bản app cũ vẫn phục vụ, nên viết theo kiểu expand → migrate → contract (backend README); deploy lỗi sau migration không hoàn tác schema. Task migration chạy bằng execution role riêng `dbs-dev-migrate-execution` và **không có task role** (DBS-120); kết nối bằng secret của `dbs_migrator` (BL-103). Role deploy cần `apply base` để có `iam:PassRole` cho role này trước lần deploy kế tiếp. Migration `1795000008000-EnableUnaccentSearch` (BL-178) chạy `CREATE EXTENSION unaccent`: `unaccent` có trong danh sách extension RDS hỗ trợ; `dbs_migrator` cần `CREATE` trên database `dbs` (extension này là *trusted* từ PG 13, không đòi superuser) và `db-roles.sh` đã cấp quyền đó. Mặc định TypeORM chạy mọi migration chờ trong **một** transaction nên không dùng được `CREATE INDEX CONCURRENTLY` (BL-110). Role `dbs-github-deploy` cần `apply base` để có quyền `ecs:RunTask` (BL-109). Chi phí một lần chạy ≈ 0,012 USD/giờ × thời gian chạy; `destroy session` bỏ các revision task definition do Terraform quản lý (revision do `deploy.sh` hay diễn tập đăng ký thì vẫn `ACTIVE`, BL-396), chỉ còn log event ở `base` (7 ngày).

### Cognito và tài khoản nhân viên demo (DBS-54)

`envs/dev/base` tạo user pool `dbs` (đăng nhập bằng email không phân biệt hoa thường, tự đăng ký bật, mật khẩu tối thiểu 12 ký tự đủ 4 loại), 4 nhóm `customer`, `operator`, `auditor`, `admin` và app client `dbs-app` không secret (`USER_SRP_AUTH`, `REFRESH_TOKEN_AUTH`, `USER_PASSWORD_AUTH`; access và ID token 15 phút, refresh 1 ngày). Output: `cognito_user_pool_id`, `cognito_client_id`, `cognito_issuer` (ba biến `COGNITO_*` của task ECS lấy từ đây, không bí mật). `cognito_deletion_protection` mặc định `INACTIVE` cho dev (teardown cần); đặt `ACTIVE` khi pool đã có người dùng thật, và đặt lại `INACTIVE` trước khi `destroy base`.

Tài khoản demo do script tạo, không do Terraform (mật khẩu không vào state): `operator`, `auditor`, `admin` và, từ BL-252, ba khách `customer1`, `customer2`, `customer3` (email `customerN.demo@dbs.invalid`, nhóm `customer`):

```bash
export COGNITO_USER_POOL_ID=$(terraform -chdir=infra/terraform/envs/dev/base output -raw cognito_user_pool_id)
bash infra/scripts/seed-cognito.sh --dry-run   # chỉ in kế hoạch
bash infra/scripts/seed-cognito.sh             # tạo; chạy lại an toàn
bash infra/scripts/seed-cognito.sh --rotate    # đổi mật khẩu và sign-out phiên cũ
python3 infra/scripts/tests/test_seed_cognito.py   # test của script (aws giả, không cần credential)
```

Mật khẩu nằm ở Secrets Manager `dbs/dev/demo-accounts` (secret là nguồn sự thật, mã hóa bằng CMK `alias/dbs-dev`; ≈ 0,40 USD/tháng; tag `project/env/owner`). Không bao giờ để mật khẩu trên dòng lệnh hay in ra màn hình. Quyền tối thiểu cho người chạy: `cognito-idp:AdminGetUser`, `AdminCreateUser`, `AdminSetUserPassword`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminUpdateUserAttributes`, `AdminListGroupsForUser`, `AdminUserGlobalSignOut` trên ARN pool; `secretsmanager:DescribeSecret`, `GetSecretValue`, `CreateSecret`, `PutSecretValue`, `UpdateSecret`, `TagResource` trên `dbs/dev/demo-accounts-*`; và `kms:Decrypt`, `kms:GenerateDataKey`, `kms:DescribeKey` trên CMK `alias/dbs-dev` với `kms:ViaService = secretsmanager.<region>.amazonaws.com`. Teardown: `aws secretsmanager delete-secret --secret-id dbs/dev/demo-accounts --force-delete-without-recovery`.

**Role riêng để seed (BL-101, DBS-154):** `envs/dev/base/cognito_seeder.tf` tạo role `dbs-dev-cognito-seeder` (output `cognito_seeder_role_arn`) với đúng các quyền trên và không gì khác (không xóa secret hay user). Trust là gốc tài khoản: chỉ principal của tài khoản có `sts:AssumeRole` trong identity policy của mình (admin có sẵn) mới assume được; không đòi MFA vì dev không bật MFA cho IAM user. `apply base` một lần để tạo role, rồi thêm profile vào `~/.aws/config` và chạy script bằng profile đó thay cho `dbs-admin`:

```ini
[profile dbs-seeder]
role_arn       = <output cognito_seeder_role_arn>
source_profile = <profile của người chạy, ví dụ dbs-admin>
region         = ap-southeast-1
```

```bash
AWS_PROFILE=dbs-seeder bash infra/scripts/seed-cognito.sh
```

Phần chưa chạy thật: một lần seed bằng role này trên AWS (còn mở ở BL-101). Teardown secret vẫn cần quyền admin vì role không có `DeleteSecret`.

### RDS PostgreSQL 17 (DBS-66)

`base` giữ KMS CMK dùng chung `alias/dbs-dev` (≈ 1 USD/tháng; xóa phải chờ 7 ngày), DB subnet group `dbs-dev` (2 private subnet) và SG `dbs-dev-db` (5432 chỉ từ SG `dbs-dev-api`; task `api` chỉ được đi ra 5432 tới SG này). `session` dựng instance `dbs-dev` (`db.t4g.micro`, Single-AZ, 20 GB gp3, mã hóa bằng CMK, `rds.force_ssl = 1`, `timezone = UTC`, backup 1 ngày) và parameter group `dbs-dev-postgres17`. Mật khẩu master do RDS quản lý trong Secrets Manager (output `db_master_secret_arn`); không có mật khẩu nào trong state. `db_instance_class` và `db_multi_az` là biến (production đổi; dev bật tạm khi diễn tập failover theo DBS-180).

**Bật/tắt Multi-AZ để diễn tập failover (DBS-180):**

- Mặc định `db_multi_az = false` (Single-AZ). Output `db_multi_az` báo trạng thái sau `apply`.
- Chênh lệch chi phí theo giờ (`db.t4g.micro` PostgreSQL ở `ap-southeast-1`, giá on-demand niêm yết):

| Mục | Single-AZ | Multi-AZ | Chênh lệch |
|---|---|---|---|
| Instance `db.t4g.micro` | 0,0250 USD/giờ | 0,0510 USD/giờ | +0,0260 USD/giờ |
| Storage gp3 20 GB (730 giờ/tháng) | ≈ 0,0038 USD/giờ | ≈ 0,0076 USD/giờ | +0,0038 USD/giờ |
| **Tổng** | **≈ 0,0288 USD/giờ** | **≈ 0,0586 USD/giờ** | **≈ +0,030 USD/giờ (gấp ≈ 2,03 lần)** |

- Bật khi diễn tập (sửa tại chỗ, kéo dài vài phút và làm chậm I/O trong lúc tạo standby; báo kênh trước khi bật): `terraform apply -var db_multi_az=true` (kèm đủ biến của phiên đang chạy).
- Tắt ngay sau khi diễn tập xong để tiết kiệm (quên tắt ≈ +0,72 USD/ngày): chạy lại `terraform apply` không truyền `db_multi_az=true` (về mặc định `false`) và xác nhận `terraform output db_multi_az` = `false`. Quên tắt thì `check "db_multi_az_off"` (`envs/dev/session/rds.tf`) cảnh báo ở mọi `terraform plan` và `apply` còn `db_multi_az = true` (BL-324). Check đọc biến chứ không đọc RDS thật: plan không truyền lại `-var db_multi_az=true` thì check qua, nên bước `terraform output db_multi_az` cuối phiên vẫn là bước bắt buộc.

**Chi phí khi bật** (ADR-11): RDS ≈ 0,025 USD/giờ + gp3 20 GB ≈ 0,004 USD/giờ + secret master 0,40 USD/tháng theo tỉ lệ. Dev mất dữ liệu mỗi lần `destroy` (không snapshot cuối, xóa cả backup tự động); seed lại bằng migration và script (DBS-68). Tạo mất 10–15 phút, xóa 5–8 phút: `destroy` ngay khi kiểm xong, không để qua đêm. Tên database `dbs` (local và CI dùng `banking`; app chỉ nhận `DATABASE_URL`). CA của RDS ghim `rds-ca-rsa2048-g1`.

Xóa (thứ tự ngược): `session` trước, `base` sau. `base` chỉ xóa được khi ECR `dbs-api` rỗng (`force_delete = false`); xóa image bằng `aws ecr batch-delete-image` trước. `base` gần như miễn phí nên thường giữ lại; chỉ xóa `session` cuối mỗi phiên làm việc. Ai bật phần tính tiền thì tắt khi xong.

Kiểm tra tĩnh cho `envs/dev/base` và `envs/dev/session`: `terraform init -backend=false && terraform test` (dùng `mock_provider` và `override_data`, không cần credential; CI chạy sẵn, xem "Kiểm tra trước khi push"). ALB của dev nghe HTTPS bằng chứng chỉ self-signed (chưa có tên miền): gọi bằng `curl -k`.

### Secret DB và TLS trong task api (DBS-67)
Task api nhận `DB_HOST` (từ `aws_db_instance.main.address`), `DB_PORT`, `DB_NAME`, `DATABASE_SSL=true`, `DATABASE_SSL_CA_PATH` làm biến thường, và `DB_USER`, `DB_PASSWORD` từ secret của role `dbs_api` (`dbs/dev/db-api`, `<arn>:username::`, `<arn>:password::`; BL-103, trước đó là secret master của RDS). Execution role `dbs-dev-api-execution` có `secretsmanager:GetSecretValue` trên đúng secret đó và `kms:Decrypt` trên CMK `alias/dbs-dev` với `kms:ViaService = secretsmanager.<region>.amazonaws.com`.

- Ghi chú: ARN secret đổi mỗi phiên, nên revision task cũ không dùng lại được sau `destroy`; `terraform apply` tạo revision mới. Mật khẩu role DB không tự xoay (đổi bằng `db_role_password_version`, xem "Role DB riêng"); RDS vẫn xoay mật khẩu master mỗi 7 ngày, nhưng chỉ task `dbs-db-roles` đọc nó (BL-107).
- Kiểm tĩnh: `terraform test` ở `envs/dev/session` (run `db_connection`, `db_secret_policy`). Chạy thật trên AWS **chưa chạy** (BL-106).

### ElastiCache Valkey (DBS-75)

`base` giữ subnet group ElastiCache `dbs-dev` (2 private subnet), SG `dbs-dev-redis` (6379 chỉ từ SG `dbs-dev-api`; task `api` chỉ được đi ra 6379 tới SG này) và **vỏ** secret `dbs/dev/redis-auth` (CMK `alias/dbs-dev`, `recovery_window_in_days = 0`, chưa có giá trị). `session` dựng replication group `dbs-dev`: Valkey 8, `cache.t4g.micro`, 1 node, cluster mode tắt, TLS bắt buộc (`transit_encryption_mode = required`), mã hóa at-rest bằng CMK, không snapshot. Biến `redis_node_type`, `redis_replicas` (0–2; > 0 bật failover và Multi-AZ) dành cho production.

- **AUTH token không nằm trong state nào.** Mỗi `apply` của `session` sinh token 64 ký tự bằng ephemeral `random_password` (provider `hashicorp/random`) và ghi cùng lúc vào Valkey (`auth_token_wo`) và secret (`secret_string_wo`). Mỗi phiên (`apply` sau `destroy`) có token mới.
- **Task api** nhận `REDIS_HOST` (primary endpoint), `REDIS_PORT=6379` làm biến thường và `REDIS_AUTH_TOKEN` từ secret; execution role có `GetSecretValue` trên đúng secret này. App ghép `REDIS_URL` (`rediss://`), xem [backend/README.md](../../backend/README.md).
- **Xoay token giữa phiên:** tăng `redis_auth_version` (mặc định 1) rồi `apply`. Strategy `ROTATE`: Valkey nhận cả token mới và token cũ, task đang chạy giữ kết nối, task khởi động sau đó đọc token mới (`aws ecs update-service --force-new-deployment` để thay hết). Token cũ còn hợp lệ tới lần xoay sau; xoay thêm một lần nếu cần loại hẳn nó. Không dùng `SET`: ElastiCache chỉ nhận `SET` cho token đầu tiên. Cùng cách đó dùng để khôi phục khi token của secret và Valkey lệch nhau (`WRONGPASS`), ví dụ ghi secret thất bại giữa chừng.
- Sau `destroy session`, secret vẫn còn một version `AWSCURRENT` chứa token của phiên đã xóa; không hại gì vì Valkey dùng token đó đã bị xóa.
- **Chi phí khi bật** (ADR-11, ADR-12; giá thật trên Cost Explorer, DBS-143): node 0,0192 USD/giờ (quên `destroy` ≈ 14 USD/tháng), secret 0,40 USD/tháng. Tạo mất 5–10 phút, xóa khoảng 5 phút; chạy song song với RDS.
- **Alarm "Redis không truy cập được > 1 phút"** (BL-117, docs/03 §14): `session/alarms.tf` có `dbs-dev-redis-node-missing` (node `dbs-dev-001` ngừng phát `CPUUtilization` 2 phút liên tiếp) và `dbs-dev-redis-fallback` (`redis_fallback_total` > 0 ở 2 phút liên tiếp, phát hiện cả khi node sống nhưng app không với tới). Bật `redis_replicas` > 0 thì node chính có thể là `-002`: thêm alarm cho node đó.
- Provider: `aws >= 6.70, < 7.0` ở `base` và `session` (cần thuộc tính write-only), `random ~> 3.7` ở `session`.
- Kiểm tĩnh: `terraform test` ở `envs/dev/base` (`tests/redis.tftest.hcl`) và `envs/dev/session` (run `valkey_replication_group`, `redis_connection`, `redis_secret_policy`…). Probe chạy thật trên AWS: [DBS-75 §8](../../docs/features/DBS-75-terraform-valkey.md).

### KMS CMK dùng chung (DBS-154)

`envs/dev/base/kms.tf` quản lý CMK `alias/dbs-dev` (`enable_key_rotation = true`, `rotation_period_in_days = 365`, `deletion_window_in_days = 7`; chi phí 1 USD/tháng, 20.000 yêu cầu đầu tiên miễn phí). Key policy tối thiểu gồm 3 statement ủy quyền cho IAM (`Principal = arn:aws:iam::<account_id>:root`, không `Principal "*"`, không `kms:*`):
- `AccountManagesKeyNotData`: chỉ thao tác quản lý key (kèm `PutKeyPolicy`, `ScheduleKeyDeletion`, `CancelKeyDeletion` để tránh tự khóa), không cho phép mã hóa/giải mã trực tiếp bằng CLI.
- `UseKeyOnlyThroughAwsServices` và `GrantsForAwsServices`: chỉ cho phép dùng dữ liệu/tạo grant khi `kms:CallerAccount` = tài khoản và `kms:ViaService` thuộc bốn dịch vụ `{rds, secretsmanager, sqs, elasticache}.<region>.amazonaws.com` (cần đồng thời quyền KMS trong identity policy của caller).

Kiểm tra nhanh trên AWS bằng script chỉ đọc: `AWS_PROFILE=dbs-admin bash infra/scripts/verify-kms.sh` (thoát `0` khi CMK, RDS, ElastiCache, SQS và Secrets Manager đang có đều dùng `alias/dbs-dev`; `1` khi có tài nguyên dùng khóa khác; `2` khi thiếu quyền kiểm tra). Test offline: `python3 infra/scripts/tests/test_verify_kms.py` và `terraform test` (`tests/kms.tftest.hcl`).

### Hàng đợi SQS (DBS-73)

`envs/dev/base` tạo hai queue standard và hai DLQ: `dbs-dev-risk-events`, `dbs-dev-notification-events`, mỗi queue có `…-dlq` riêng. Queue nằm ở `base` vì SQS không tính tiền khi rảnh (trả theo request, 1 triệu request/tháng đầu miễn phí), URL không đổi giữa các phiên, và message trong DLQ còn nguyên sau `destroy session`.

| Tham số | Giá trị |
|---|---|
| Queue chính | visibility 30 giây, long polling 20 giây, giữ 4 ngày, sang DLQ sau 5 lần nhận (ADR-03), mã hóa SSE-KMS bằng CMK `alias/dbs-dev` (`kms_data_key_reuse_period_seconds = 300`) |
| DLQ | giữ 6 ngày, ngắn hơn 7 ngày của `processed_events`; mã hóa SSE-KMS bằng CMK `alias/dbs-dev`; redrive allow `byQueue`: chỉ queue chính tương ứng được trỏ vào |
| IAM | managed policy `dbs-dev-worker-sqs` (gửi, nhận, xóa, đổi visibility trên queue chính; chỉ `SendMessage` trên DLQ cho message sai schema; `kms:GenerateDataKey` và `kms:Decrypt` trên CMK với `kms:ViaService = sqs.<region>.amazonaws.com`), gắn vào role `dbs-dev-worker-task` ở `session` (DBS-120) |
| Chặn api | queue policy của cả 4 queue `Deny` mọi `sqs:*` cho role `dbs-dev-api-task` (so `aws:PrincipalArn` theo tên; đổi tên role thì sửa `sqs.tf`) |
| Danh sách cho phép (BL-241) | cùng queue policy có `Deny` `SendMessage`, `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `PurgeQueue`, `StartMessageMoveTask` cho mọi principal **không** khớp `ArnNotLike aws:PrincipalArn` với {role `dbs-dev-worker-task`, biến `sqs_ops_principal_arns`}. Mặc định biến để trống = mọi IAM user của tài khoản (`arn:aws:iam::<account>:user/*`), nên người vận hành và người redrive DLQ không bị khóa; role khác (api, role tương lai) và principal ngoài tài khoản bị chặn dù identity policy cho `sqs:*`. Chặt hơn: đặt `sqs_ops_principal_arns = ["arn:aws:iam::<account>:user/<tên>", …]` (nhớ gồm người chạy redrive). Không chặn thao tác quản trị queue (`SetQueueAttributes`, `GetQueueAttributes`, `DeleteQueue`), nên Terraform vẫn sửa được policy; lỡ khóa nhầm thì chỉ mất quyền đụng message, gỡ bằng sửa biến rồi `terraform apply base`. Redrive tự động của SQS sang DLQ (`maxReceiveCount`) là nội bộ SQS, không bị policy này đánh giá |

| Output của `base` | Biến môi trường (`sqs.config.ts`) |
|---|---|
| `sqs_risk_queue_url` | `SQS_RISK_QUEUE_URL` |
| `sqs_notification_queue_url` | `SQS_NOTIFICATION_QUEUE_URL` |
| `sqs_risk_dlq_url`, `sqs_notification_dlq_url` | không có biến: app suy ra URL DLQ từ URL queue chính bằng `dlqUrlFor(queueUrl)` = `<queueUrl>-dlq` (`backend/src/common/messaging/consumer-base.ts`), khớp tên Terraform `dbs-dev-<consumer>-events-dlq`. Hai output này dành cho người vận hành và runbook ([dlq-redrive](../../docs/runbooks/dlq-redrive.md)) |

`SQS_ENDPOINT` không đặt trên AWS. Hai biến URL vào task definition worker ở `session/worker.tf` (DBS-121).

**Kiểm danh sách cho phép trên AWS thật (BL-241, chưa chạy; sau `apply base`):** (1) tạo role tạm `dbs-sqs-probe` tin cậy IAM user đang chạy, inline policy `Allow sqs:*` trên 4 queue (đối chứng dương: Allow đã có hiệu lực, nên từ chối sau đó là do queue policy), `aws sts assume-role` (lặp tối đa 12 lần × 5 giây cho tới khi lan truyền); (2) gọi bằng credential tạm của role đó, truyền theo từng lệnh, không `export`: `env AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_SESSION_TOKEN=… aws sqs send-message --queue-url <url dbs-dev-risk-events> --message-body '{"probe":"BL-241"}'` và `receive-message`; mong đợi `AccessDenied` với "explicit deny in a resource-based policy"; (3) cùng lệnh bằng IAM user trong danh sách phải thành công (gửi rồi nhận và xóa message probe); (4) role worker thật gửi và nhận được: task Fargate tạm với `dbs-dev-worker-task` như bước "Kiểm quyền trái phép" ở mục DBS-120; (5) gửi một message hỏng và để consumer nhận 5 lần: message phải sang DLQ (redrive nội bộ không bị chặn), rồi `start-message-move-task` bằng user trong danh sách phải chạy; (6) xóa role tạm. Ghi nguyên văn thông báo lỗi.

Redrive DLQ về queue chính: `aws sqs start-message-move-task --source-arn <arn-dlq>`, theo dõi bằng `list-message-move-tasks`. Redrive cấp `MessageId` mới và tính lại hạn giữ từ lúc chuyển, nên message được redrive phải được xử lý xong trong vòng 24 giờ, mỗi message chỉ redrive một lần (quy tắc đầy đủ: [DBS-73 §2](../../docs/features/DBS-73-terraform-sqs.md), runbook ở BL-051). **Tuổi tính từ lần gửi gốc (BL-210):** consumer của app chuyển DLQ bằng `SendMessage` nên hạn DLQ tính lại từ lúc chuyển; bản sao mang `OriginalSentTimestamp`, và trước mỗi redrive Ops chạy `npm run --silent dlq:age-check -- --queue-url <url DLQ>` (từ `backend/`) để loại message gửi gốc quá 6 ngày ([runbook](../../docs/runbooks/dlq-redrive.md) mục 3). Với queue standard và `maxReceiveCount > 3`, `ApproximateAgeOfOldestMessage` bỏ qua message đã nhận từ 3 lần trở lên (ghi chú cho alarm DBS-163). Alarm DLQ > 0 (`base/alarms.tf`) và alarm tuổi message > 120 giây (`session/alarms.tf`): xem mục «Alarm CloudWatch» ở trên.

### Service worker (DBS-121)

`envs/dev/session/worker.tf` dựng task definition `dbs-worker` (0,25 vCPU / 0,5 GB, cùng image `dbs-api:<image_tag>`, `APP_ROLE=worker`) và service `worker` trong cluster `dbs-dev`; thuộc nhóm xóa hằng ngày. `envs/dev/base/worker.tf` giữ log group `/dbs/dev/worker` (7 ngày) và SG `dbs-dev-worker`.

| Mục | Giá trị |
|---|---|
| Sức khỏe | Theo ADR-13 và Dockerfile: không `healthCheck`, không cổng, không load balancer. Container `essential`: tiến trình thoát thì ECS chạy task mới. Worker treo phát hiện qua alarm tuổi outbox (`dbs-dev-outbox-age`) và tuổi message (`dbs-dev-*-events-age`), cả hai ở `session/alarms.tf`; không qua ECS |
| Mạng | SG không ingress; egress 443, 5432 tới SG db, 6379 tới SG redis. SG db và redis nhận từ SG api và SG worker, không ai khác. Task ở public subnet có IP công khai (ADR-10) |
| Số task | `worker_desired_count` mặc định 0, tối đa 2; `desired_count + worker_desired_count ≤ 6` (74 kết nối dùng được, mỗi task 10 + 5). Lăn 0%/100% để không có hai worker song song |
| Dừng | `stopTimeout` 60 s (một lô relay tới 25 s) |
| Đối soát sổ cái | Biến `reconciliation_interval_ms` (mặc định 60 000, nhận 10 000..300 000) → env `RECONCILIATION_INTERVAL_MS`. Mặc định của ứng dụng là 300 s, quá chậm để alarm `dbs-dev-reconciliation-failed` báo trong 5 phút; production đặt lại theo tải ([DBS-123](../../docs/features/DBS-123-reconciliation-alarms.md)) |
| Relay outbox | Biến `relay_idle_delay_ms` (mặc định 500, nhận 50..1000: ADR-03 giữ poll ≤ 1 giây) và `relay_batch_size` (mặc định 100, nhận 1..500) → env `OUTBOX_RELAY_IDLE_DELAY_MS`, `OUTBOX_RELAY_BATCH_SIZE` (DBS-175). Không đặt thì hành vi y như trước; chỉ vào task `worker`. Mỗi lần đổi là một task definition mới: `ecs update-service --task-definition` rồi đợi deployment `COMPLETED` (service có `ignore_changes = [task_definition]`) |
| Log | CloudWatch `/dbs/dev/worker`, stream `worker/worker/<task-id>`; lỗi khởi động ghi `Application startup failed` kèm `invalidKeys` |
| Biến | như api cộng `SQS_RISK_QUEUE_URL`, `SQS_NOTIFICATION_QUEUE_URL`; không `SQS_ENDPOINT`, không `PORT`; bí mật `DB_USER`, `DB_PASSWORD`, `REDIS_AUTH_TOKEN` qua `secrets` |

- **Thứ tự apply:** `apply base` trước (log group, SG, output) rồi `session`; nếu không `session` thiếu output của `base`. Không sửa `description` của SG `db`/`redis` ở `base` (ForceNew).
- **Lệnh** (luôn đủ biến, nếu không `desired_count` của api về 0): `terraform apply -var account_id=… -var state_bucket=… -var image_tag=<sha> -var desired_count=1 -var worker_desired_count=1`. Tắt worker: `worker_desired_count=0`; api không đổi.
- **Chi phí:** một task worker ≈ 0,01 USD/giờ (Fargate 0,25 vCPU / 0,5 GB cộng IPv4 công khai); cả stack bật ≈ 0,14 USD/giờ (ADR-11). Luôn `terraform destroy` cả `session` sau khi dùng.
- **Chưa có:** `deploy.sh` chưa cập nhật service worker (BL mới); alarm worker treo đã có trong Terraform nhưng chưa kích hoạt thử trên AWS (BL-161); test thủ công trên AWS: nhóm A và B ở [DBS-121 §5](../../docs/features/DBS-121-worker-service.md).

### Task role và execution role (DBS-120)

Mỗi service có execution role riêng (ECS agent dùng để kéo image, ghi log và đọc secret của chính service đó) và task role riêng (quyền của mã ứng dụng). App không gọi Secrets Manager hay KMS: secret vào container qua `secrets` của task definition, nên quyền đọc secret nằm ở execution role, task role không có.

| Role | Quyền | Dùng bởi |
|---|---|---|
| `dbs-dev-api-task` | không có (không policy, không attachment); queue policy `Deny sqs:*` | `dbs-api` |
| `dbs-dev-worker-task` | managed policy `dbs-dev-worker-sqs` (đúng 2 queue và `SendMessage` vào 2 DLQ) | service worker (DBS-121) |
| `dbs-dev-api-execution` | kéo image, ghi log `/dbs/dev/api`, `GetSecretValue` secret `dbs/dev/db-api` và `dbs/dev/redis-auth`, `kms:Decrypt` CMK qua Secrets Manager | `dbs-api` |
| `dbs-dev-worker-execution` | như api nhưng secret `dbs/dev/db-worker`, ghi log `/dbs/dev/worker` | service worker (DBS-121) |
| `dbs-dev-migrate-execution` | kéo image, `CreateLogStream` trên `/dbs/dev/api`, `PutLogEvents` chỉ stream `migrate/*`, `GetSecretValue` chỉ secret `dbs/dev/db-migrator` | `dbs-migrate` (không task role) |
| `dbs-dev-db-roles-execution` | kéo image, `PutLogEvents` chỉ stream `db-roles/*`, `GetSecretValue` secret master RDS và ba secret `dbs/dev/db-*` (nơi duy nhất đọc secret master) | `dbs-db-roles` (BL-103, không task role) |

- Hai task role tin `ecs-tasks.amazonaws.com` với `aws:SourceAccount` và `aws:SourceArn` (`arn:aws:ecs:<region>:<account>:*`); execution role chỉ có `aws:SourceAccount`.
- **Không đổi tên `dbs-dev-api-task`:** queue policy ở `base/sqs.tf` chặn theo tên role. Test khóa tên này.
- **Thứ tự apply:** role deploy (`base/deploy_role.tf`) chỉ được `iam:PassRole` cho role của `dbs-api` và `dbs-migrate`. Sau khi `session` đổi role, `apply base` trước lần deploy kế tiếp, nếu không `migrate.sh` lỗi `iam:PassRole`. Role worker được thêm cùng service worker (DBS-121, BL-242).
- **Kiểm quyền trái phép:** không assume được task role từ máy. Gọi thật bằng task Fargate tạm (family `dbs-probe`, image `public.ecr.aws/aws-cli/aws-cli`, `entryPoint ["sh","-c"]`) chạy dưới role cần thử; `simulate-principal-policy` chỉ tính identity policy (không áp queue policy cho role). Để thấy `explicit deny` của queue policy mà không cần task: dựng tạm một role **cùng tên** `dbs-dev-api-task` có `sqs:*` khi `session` chưa dựng, assume rồi gọi `sqs send-message`. Bằng chứng ở [feature doc DBS-120](../../docs/features/DBS-120-ecs-task-roles.md).
- **Dựng phần IAM rẻ để kiểm:** `terraform apply` với mười `-target` (5 role, `aws_iam_role_policy_attachment.worker_sqs`, `aws_iam_role_policy.execution`, `.worker_execution`, `.migrate_execution`, `aws_ecs_cluster.main`) không cần RDS hay Valkey; phần còn lại của session không dựng.

### WAF gắn ALB (DBS-153)

`infra/terraform/modules/waf` dựng `aws_wafv2_web_acl` vùng (`scope = "REGIONAL"`, mặc định `allow`) gắn vào `aws_lb.main` qua `envs/dev/session/waf.tf` (`dbs-dev-waf`), với 3 rule theo thứ tự: `rate-limit` (ưu tiên 10, `evaluation_window_sec = 300`, `aggregate_key_type = "IP"`, chặn trả **429**), `AWSManagedRulesCommonRuleSet` (ưu tiên 20) và `AWSManagedRulesKnownBadInputsRuleSet` (ưu tiên 30).

| Biến ở `session` | Mặc định | Ý nghĩa |
|---|---|---|
| `waf_enabled` | `true` | Bật/tắt WAF (tắt bằng `-var waf_enabled=false` → 0 USD) |
| `waf_rate_limit` | `1000` | Ngưỡng request / 5 phút / IP (`10..2000000000`) |
| `waf_rate_limit_exempt_cidrs` | `[]` | Danh sách IPv4 CIDR (`/8`–`/32`) miễn rate rule (managed rules vẫn chạy). Trước khi chạy k6 cùng region, truyền `-var 'waf_rate_limit_exempt_cidrs=["<IP k6>/32"]'` |
| `waf_managed_rules_count_only` | `false` | Đặt `true` để chuyển hai nhóm managed sang `count` khi xử lý false positive mà không gỡ WAF |
| `waf_off_date` | `"2026-11-26"` | Ngày đầu tuần 9 dự kiến tắt WAF; `check "waf_off_date"` cảnh báo nếu `waf_enabled = true` từ ngày này trở đi |

- **Chi phí:** ≈ 1,85 USD/tuần nếu bật 24/7 (5 USD/ACL + 3 USD/3 rule + phí request) hoặc ≈ 0,5 USD/tuần nếu dựng/xóa theo phiên (~45 giờ/tuần). Chi tiết ở [DBS-153 §3](../../docs/features/DBS-153-waf-alb.md).

## Dựng từ trạng thái trống và đo thời gian (DBS-139)

«Trạng thái trống» nghĩa là: `base` đã có (giữ lại, không dựng lại mỗi phiên), `session` rỗng, ECR có image của SHA cần chạy. Bảng dưới đây là các bước theo thứ tự; cột thời gian chỉ ghi số **đo thật** (ngày 2026-11-12, `ap-southeast-1`, profile `dbs-admin`, Terraform 1.16.6) hoặc nói rõ **ước tính, chưa đo** và lý do. Checklist cho người trực demo: [docs/runbooks/demo-checklist.md](../../docs/runbooks/demo-checklist.md).

| # | Bước | Lệnh | Thời gian |
|---|---|---|---|
| 1 | Kiểm tài khoản, vùng, budget, khởi đầu sạch | `aws sts get-caller-identity`; `aws budgets describe-budgets --account-id <id>`; `bash infra/scripts/verify-clean.sh` | **đo: 17 giây** (verify-clean, 13 loại) |
| 2 | `plan` session, đọc kết quả | `terraform plan …` (30 tài nguyên thêm, 0 xóa) | **đo: 5 giây** |
| 3 | `apply` session (RDS, Valkey, ALB, IAM, ECS service ở 0 task) | `terraform apply …` (lệnh ở mục «Thứ tự dựng») | **đo: 9 phút 24 giây** (2026-11-14, `dev1`; RDS 8 phút 47 giây, Valkey 7 phút 39 giây, ALB 2 phút 11 giây; lần 2026-11-12: 9 phút 16 giây) |
| 4 | Image `<sha>` lên ECR | CI `Image` trên `main` (hoặc đã có từ trước) | **đo: 0 phút**: workflow `Image` trên `main` đẩy image theo SHA mỗi lần merge (2026-11-14: `4afac28`) |
| 4b | LOGIN và mật khẩu cho `dbs_api`, `dbs_worker`, `dbs_migrator` (BL-103) | `AWS_PROFILE=dbs-admin bash infra/scripts/db-roles.sh` | **đo: 55 giây** (2026-11-14, `db.t4g.small`; log «Đăng nhập thử bằng dbs_api / dbs_worker / dbs_migrator: được»; migration sau đó bằng `dbs_migrator` thoát 0 trong 70 giây) |
| 5 | Migration (bằng `dbs_migrator` từ BL-103) | `IMAGE_TAG=<sha> bash .github/scripts/migrate.sh` | **đo: 58 giây** (18 migration trên RDS trống, bằng master, thoát 0; chạy lần 2 «No migrations are pending», 58 giây; chưa đo lại bằng `dbs_migrator`). Không cần `GRANT dbs_migrator TO <master>` trên RDS PostgreSQL 17 (BL-195) |
| 6 | Nâng service lên 1 api và 1 worker, chờ `runningCount` | `terraform apply … -var desired_count=1 -var worker_desired_count=1` | **đo: 44 giây** (`apply` 20 giây, `/health/ready` 200 sau 24 giây) |
| 7 | Tài khoản nhân viên demo | `bash infra/scripts/seed-cognito.sh` | **đo: vài giây** (chạy thật 2026-11-14 trong container Linux: script dùng `file:///dev/stdin`, `aws.exe` trên Windows không đọc được) |
| 8 | Dữ liệu demo qua API | `bash infra/scripts/seed-cloud.sh` (task ECS `dbs-seed` trong VPC gọi thẳng task api, không qua ALB; BL-252, xem [Seed dữ liệu demo trên cloud](#seed-dữ-liệu-demo-trên-cloud-bl-252)) | **đo: 6 giây** (`npm run seed -- --auth cloud` qua ALB, 3 khách, 4 lệnh nạp, 2 lệnh chuyển; lần đo dùng `NODE_TLS_REJECT_UNAUTHORIZED=0` cho riêng lệnh này vì chứng chỉ tự ký, cách thay thế không tắt TLS: BL-252) |
| 9 | Health | `curl -k https://<alb>/health/live`, `/health/ready` | **đo: 200** cho `/health/live` và `/health/ready` (`database: up`, `redis: up`) |
| 10 | Token demo | `bash infra/scripts/demo-token.sh --role operator\|auditor\|admin` | **đo: 3–4 giây mỗi vai** (operator và `customer1..3`, chạy trong container Linux) |
| 11 | Bất biến sổ cái | `npm run check:invariants` | **đo: PASS, thoát 0** bằng task ECS chạy một lần `node dist/scripts/invariants/invariants.js` trên RDS (BL-128) |

**Tổng.** Đo trọn một phiên ngày 2026-11-14 (BL-251): từ `apply` session tới dữ liệu demo và token đọc được route thật mất **khoảng 12 phút** (9 phút 24 giây `apply`, 58 giây migration, 44 giây nâng service và chờ `ready`, vài giây seed Cognito, 6 giây seed dữ liệu, vài giây token), dưới DoD «≤ 30 phút» của DBS-139. `destroy` mất 8 phút 4 giây (43 tài nguyên) và `verify-clean.sh` thoát 0. Lần đo này chạy khi task còn nối bằng credential master; từ BL-103 có thêm bước 4b (`db-roles.sh`, 55 giây đo 2026-11-14) trước migration. **Dựng lại trên một phiên cũ** (state còn service): `terraform apply` thay task definition nhưng service giữ revision cũ (`ignore_changes = [task_definition]`); revision cũ trước BL-103 tham chiếu secret master mà execution role không còn đọc được, nên task không khởi động cho tới khi chạy `deploy.sh` (đã gặp và xử lý như vậy ngày 2026-11-14).

**Ngoại lệ có chủ ý khi chỉ kiểm hạ tầng.** `image_tag` bắt buộc là SHA 40 ký tự hex; khi ECR chưa có image, dùng SHA của HEAD làm giá trị giữ chỗ cùng `desired_count=0` và `worker_desired_count=0`: an toàn vì không task nào chạy (Terraform không kiểm image tồn tại). Đây là ngoại lệ của quy tắc «tag phải có trên ECR»; đừng dùng khi nâng service lên 1 task.

**Chi phí khi bật.** RDS ≈ 0,029 + Valkey 0,0192 + ALB ≈ 0,025 và IPv4 công khai ≈ 0,01 = **≈ 0,09 USD/giờ** chưa có task (≈ 0,14 USD/giờ khi api và worker chạy, ADR-11). Quên tắt ≈ 2 USD/ngày. Trần một phiên: 90 phút bật.

### Dọn sau demo và chứng minh sạch

```bash
# cùng bộ biến lúc dựng, không -target
terraform destroy -var account_id=<account-id> -var state_bucket=dbs-tfstate-<account-id>-ap-southeast-1 -var image_tag=<sha-40-ky-tu>
AWS_PROFILE=dbs-admin bash infra/scripts/verify-clean.sh
```

**Đo thật:** `destroy` 30 tài nguyên mất **4 phút 50 giây** (ALB 17 giây, RDS 1 phút 51 giây, Valkey 4 phút 14 giây); `verify-clean.sh` sau đó thoát 0 (15 giây), cùng các lệnh `describe-*` độc lập đều đếm 0 và `terraform state list` của `session` rỗng ([bằng chứng](../../docs/features/screenshots/DBS-139/manual-test.txt)).

[`infra/scripts/verify-clean.sh`](../scripts/verify-clean.sh) chỉ đọc (chỉ `describe-*` và `list-*`, luôn `--region ap-southeast-1`) và quét **cả tài khoản** mười ba loại tính tiền: NAT Gateway, load balancer, RDS (instance, cluster, snapshot thủ công, bản sao lưu tự động), ElastiCache (nhóm, cluster, snapshot), ECS (service `desiredCount > 0` hoặc task đang chạy; cluster rỗng miễn phí), Elastic IP, ENI `available`, WAF vùng, VPC interface endpoint và EC2, EBS volume và snapshot. Thoát 0 là sạch; 1 là còn thứ tính tiền (tên nằm trong dòng `FAIL`); 2 là có loại không kiểm được (thiếu quyền, hết hạn credential) và **không** kết luận sạch. Tag listing không đủ vì bỏ sót ENI và EIP. Ngay sau `destroy`, ENI `available` hoặc bản sao lưu RDS `deleting` là tạm thời: đợi vài phút rồi chạy lại. Khi stack đang bật, `FAIL` ở load-balancer, rds, elasticache, elastic-ip (hai IP công khai của ALB) và rds-automated-backup là đúng. Phần giữ lại (VPC, ECR, KMS, Cognito, SQS, secret, log group) không bị tính là tồn dư. Test: `python3 infra/scripts/tests/test_verify_clean.py` (`aws` giả, không cần credential).

### Seed dữ liệu demo trên cloud (BL-252)

`npm run seed -- --auth cloud` từ máy dev **không** chạy được qua ALB: chứng chỉ dev tự ký (CN `dbs-dev.local`) nên Node từ chối TLS, và tắt kiểm chứng chỉ là cách không chấp nhận. Quyết định (techlead, 2026-11-14): seed bằng một task ECS Fargate chạy một lần **trong VPC**, gọi thẳng một task api qua HTTP cổng 3000 (ALB cũng nói HTTP với task, nên không mất lớp mã hóa nào).

```bash
AWS_PROFILE=dbs-admin bash infra/scripts/seed-cloud.sh --dry-run   # chỉ in kế hoạch (IP api, SG, image)
AWS_PROFILE=dbs-admin bash infra/scripts/seed-cloud.sh             # chạy thật; thoát 0 chỉ khi container seed thoát 0
python3 infra/scripts/tests/test_seed_cloud.py                     # test của script (aws giả, Linux)
```

- **Điều kiện:** session đang chạy và api có task `RUNNING`; tài khoản demo đã `seed-cognito.sh`; `apply base` (SG `dbs-dev-seed`, `base/seed_task.tf`) và `apply session` (family `dbs-seed` và role `dbs-dev-seed-execution`, `session/seed.tf`); image có `dist/scripts/seed-cloud.js` (build sau BL-252; mặc định script dùng đúng image đang chạy của service `api`, đổi bằng `IMAGE_TAG=<sha>`).
- **Cách chạy:** script đọc mạng của service `api`, tìm IP riêng của một task api `RUNNING`, đăng ký revision `dbs-seed` (chỉ đổi image, như `migrate.sh`), `run-task` với SG `dbs-dev-seed`, ghi đè `command` (`node dist/scripts/seed-cloud.js --auth cloud --url http://<ip>:3000`) và `environment` (`DBS_*_TOKEN`), chờ `STOPPED`, đọc `exitCode` của container `seed` rồi in log (bản tóm tắt seed; stream `seed/seed/<task-id>` trong `/dbs/dev/api`). Seed chạy lại an toàn (BL-213). Không chạy chồng hai task seed.
- **Mạng:** SG `dbs-dev-seed` không có ingress, chỉ ra 443 (ECR, logs) và tới SG api ở cổng 3000; SG api thêm một luật nhận 3000 từ SG seed. SG api không tự tin chính nó. Task chạy ở subnet và `assignPublicIp` của service api (không NAT).
- **Image không mang công cụ ký token:** `seed-cloud.ts` chỉ import `seed-core.ts` (không import `dev-auth`, ADR-06); `--auth local` ở bản này báo lỗi. `seed.ts` (máy dev, ts-node) vẫn bị loại khỏi build.
- **Token:** `DBS_OPERATOR_TOKEN` và `DBS_CUSTOMER_{1,2,3}_TOKEN` lấy bằng `demo-token.sh` ngay trước `run-task` (hoặc đặt sẵn trong môi trường, khi đó dùng giá trị đó). Token đi vào task bằng `containerOverrides`, không qua argv. **Hệ quả cần biết:** ECS lưu overrides, nên token Cognito (sống 15 phút) hiện trong `ecs describe-tasks` (khoảng một giờ sau khi task dừng), trong lịch sử `RunTask` của CloudTrail và trên console ECS cho ai đọc được ECS; chúng hết hạn sau 15 phút. Phương án thay thế (task tự đăng nhập Cognito) đòi task role đọc secret `dbs/dev/demo-accounts`, tức mật khẩu bền của mọi tài khoản demo kể cả admin, và thêm mã đăng nhập vào image: rủi ro lớn hơn nên không chọn. Task definition `dbs-seed` không có `secrets`, không task role.
- **Quyền người chạy:** `ecs:RunTask`, `ecs:RegisterTaskDefinition`, `iam:PassRole` cho `dbs-dev-seed-execution`, `ec2:DescribeSecurityGroups`, đọc ECS và log (admin có đủ); role `dbs-github-deploy` **không** được cấp việc này (seed là việc chạy tay, không nằm trong deploy tự động).
- **Chưa chạy thật trên AWS** (cần `apply` và session dựng): test chỉ chứng minh logic script bằng `aws` giả và Terraform bằng `terraform test`.

### Token nhân viên demo

`bash infra/scripts/demo-token.sh --role operator|auditor|admin|customer1|customer2|customer3` in một access token Cognito (15 phút) ra stdout, mật khẩu đọc từ secret `dbs/dev/demo-accounts` và chỉ đi qua stdin của `aws` (`--auth-parameters file:///dev/stdin`; `--cli-input-json file:///dev/stdin` không chạy được trên AWS CLI v2). Chưa seed hoặc Cognito trả thử thách thì thoát 1 và không in gì. Test: `python3 infra/scripts/tests/test_demo_token.py`. Ba khách demo `customer1..3` (Nguyễn Minh Anh, Trần Thu Hà, Nguyễn Văn Bình theo kế hoạch của `npm run seed`) do `seed-cognito.sh` tạo (nhóm `customer`, mật khẩu cùng secret); chạy lại `seed-cognito.sh` để bổ sung vào secret cũ chỉ có ba nhân viên. `--role customer` (không số) bị từ chối (thoát 2). Seed nhận token qua `DBS_OPERATOR_TOKEN` và `DBS_CUSTOMER_{1,2,3}_TOKEN`, cờ `--*-token` đã lỗi thời (BL-252).

## Báo cáo chi phí tuần (DBS-143)

[`infra/scripts/cost-report.py`](../scripts/cost-report.py) đọc Cost Explorer (chỉ đọc) và in báo cáo Markdown: chi phí gộp theo dịch vụ (đã lọc bỏ credit, vì credit trừ hết mọi khoản), số giờ dựng và đơn giá theo từng usage type, chi phí theo tag `env`, credit đã dùng và còn lại, dự báo, cảnh báo (NAT Gateway hoặc VPC endpoint theo ADR-10; tài nguyên phiên còn chạy ở ngày cuối). Mỗi lệnh Cost Explorer tính 0,01 USD; một lần chạy 4–6 lệnh.

**Mỗi thứ Hai**, sau 19:00 giờ Việt Nam (Cost Explorer trễ tới 24 giờ):

```bash
AWS_PROFILE=dbs-admin python3 infra/scripts/cost-report.py --start 2026-10-01 --end <thứ Hai YYYY-MM-DD> \
  > docs/components/platform-infra/cost-reports/<thứ Hai YYYY-MM-DD>.md
```

1. Đối chiếu "Credit còn lại" với console Billing → Credits; nếu khác thì chạy lại với `--credit-total <số thật>`.
2. Viết mục "Đề xuất cắt giảm" (script chỉ gợi ý khoản lớn nhất và các cảnh báo).
3. Commit báo cáo; dán mục "Tóm tắt gửi nhóm" vào kênh chat của nhóm.

Tham số: `--end` không tính (exclusive) và mặc định là hôm nay UTC; `--credit-since` (mặc định 2026-08-01, tháng đầu có credit); `--project-end` mặc định 2026-12-14 (hết ngày 13/12). Script lỗi (credential, quyền) thì thoát 1 và stdout rỗng, không ghi nửa báo cáo. Test: `python3 infra/scripts/tests/test_cost_report.py`. Đơn giá thật, chi phí theo phiên và 24/7 tính từ báo cáo: [`02-capacity-cost.md`](../../docs/components/platform-infra/02-capacity-cost.md) (DBS-179).

**Tag chi phí.** `base/cost_tags.tf` bật `project`, `env`, `owner` trong Cost allocation tags (miễn phí); xóa resource hoặc `destroy base` đặt chúng về Inactive. Tag mới bật cần tới 24 giờ mới nhóm được; dữ liệu cũ cần backfill một lần:

```bash
aws ce start-cost-allocation-tag-backfill --backfill-from 2026-10-01T00:00:00Z
aws ce list-cost-allocation-tag-backfill-history
```

> **State `base` đang lệch với `main`:** queue SQS của DBS-73 (PR #40, chưa merge) đã được apply, còn role deploy thì chưa có trong state. `terraform plan` đầy đủ từ `main` sẽ **xóa 11 tài nguyên SQS**. Tới khi DBS-73 merge, chỉ apply tag bằng `-target`: `terraform plan -out=tags.tfplan -var account_id=<account-id> -target='aws_ce_cost_allocation_tag.this'`, rồi `terraform apply tags.tfplan` ([BL-138](../../docs/BACKLOG.md)).

## Máy chạy tải và đợt đo k6 (DBS-166)

Stack `envs/dev/loadgen` dựng **một máy chạy k6 cùng region** (EC2 `t3.medium` ở public subnet, IP công khai gán lúc khởi động, SG không ingress, điều khiển bằng SSM), một bucket S3 tạm và một client Cognito tạm `dbs-loadgen` (access token 240 phút, để một fixture dùng hết năm bài; `base` và app client `dbs-app` không bị đụng). Dựng cho một đợt đo rồi `destroy`; state key riêng, ví dụ `dev/loadgen-dbs166.tfstate`. Stack thêm **một** luật ingress 5432 vào SG RDS của `base` bằng resource nằm trong state của `loadgen`, nên `destroy` gỡ sạch. **Không stop máy tải**: IP công khai sẽ đổi và mất miễn trừ WAF.

Thứ tự (state tạm cho cả hai stack, `-backend-config=key=dev/<tên>-<task>.tfstate`; mọi `plan`, `apply`, `destroy` của `session` dùng cùng một `-var-file` gồm `account_id`, `state_bucket`, `image_tag`, `db_instance_class`, `db_multi_az`, `redis_replicas`, `desired_count`, `worker_desired_count`, `waf_rate_limit_exempt_cidrs`, `api_extra_environment`; thiếu một biến là âm thầm đổi cấu hình):

1. `apply` `loadgen` trước: lấy output `public_ip`, `cognito_client_id`, `bucket`.
2. `git archive --add-file=COMMIT -o src.tgz HEAD backend load-tests infra/scripts` (loại `load-tests/fraud-dataset`) và `loadgen-bootstrap.sh` lên bucket, chạy bootstrap bằng SSM (`AWS-RunShellScript`, Node 24 và k6 v2.3.0 có kiểm checksum, `npm ci` backend, in SHA của `COMMIT`).
3. `apply` `session` với `waf_rate_limit_exempt_cidrs=["<public_ip>/32"]`, `api_extra_environment={COGNITO_CLIENT_ID="<id>"}`, `db_instance_class=db.t4g.small`, `db_multi_az=true`, `redis_replicas=1`, `desired_count=0`; `db-roles.sh`; `IMAGE_TAG=<sha> migrate.sh`; **`bash infra/scripts/pgss.sh enable`** rồi **`reset`** (bật `pg_stat_statements` và xóa bộ đếm trước lượt đo đầu; BL-420); rồi `apply` lại với `desired_count=2`, `worker_desired_count=1`.
4. Ghi `/opt/loadgen/run.env` (`BUCKET`, `BASE_URL=https://<alb_dns_name>`, `DB_HOST=<db_address>`, `TOKENS_S3_KEY`) từ output của `session`, **rồi** lấy token ngay trước `prepare`: `COGNITO_CLIENT_ID=<id> node infra/scripts/loadgen-tokens.mjs tokens.json` trên máy vận hành (máy tải không đọc `demo-accounts`), đẩy lên bucket, xóa bản trên máy vận hành.
5. Trong lúc chạy các bài, `bash infra/scripts/pgss.sh snapshot <file>` sát đầu và cuối mỗi plateau cần số (delta: `python3 infra/scripts/pgss_delta.py <đầu> <cuối>`). `loadgen-run.sh prepare` một lần (BL-213: một DB một đợt đo; xóa token khỏi máy tải và bucket), rồi `loadgen-run.sh run <kịch bản>` từng bài: bài dài chạy nền, ví dụ `nohup setsid bash /opt/loadgen/src/infra/scripts/loadgen-run.sh run baseline > /opt/loadgen/logs/baseline.out 2>&1 &` và hỏi tiến độ bằng lệnh SSM ngắn (bằng chứng là `run.log` và `exit.json` trong thư mục kết quả, không phải output SSM bị cắt ở 24.000 ký tự). Bài `rate-limit` chạy trước với giới hạn mặc định 10/100; sau đó thêm `RATE_LIMIT_REQUESTS_PER_IP_PER_MINUTE` và `RATE_LIMIT_TRANSFERS_PER_MINUTE` vào `api_extra_environment` (giữ `COGNITO_CLIENT_ID`), `apply`, rồi `aws ecs update-service --task-definition <ARN từ state>` (service có `ignore_changes = [task_definition]`), rồi baseline, hot-account, `loadgen-run.sh quiesce`, duplicate, stress. `run` luôn chạy checker bất biến (DBS-69) và `aggregate-raw.cjs`, nén `raw.json`, ghi `exit.json`, đẩy kết quả lên bucket.
   Với mọi lượt có `aggregate.json` (kể cả `hot-account`, chỉ có cửa sổ cả lượt), `run` còn chạy `load-tests/flag-latency.cjs` (DBS-174): độ trễ giao dịch → quyết định và cờ vào `flag-latency.json`; `flagLatencyExit` = 1 trong `exit.json` là còn giao dịch chưa được chấm sau 120 giây. Chu kỳ poll và cỡ lô của relay đặt bằng biến `relay_idle_delay_ms` (50..1000, mặc định 500) và `relay_batch_size` (1..500, mặc định 100) của `session` (DBS-175); mỗi lần đổi là một task definition `worker` mới (`ecs update-service --task-definition`).
6. Kéo kết quả về, `destroy` `session` rồi `loadgen`, `verify-clean.sh` phải thoát 0, `list-user-pool-clients` chỉ còn `dbs-app`.

Chạy từ Git Bash trên Windows: `db-roles.sh` và `migrate.sh` cần `python3` (shim trỏ `python`) và `TMPDIR` dạng `F:/...` (aws.exe không đọc `/tmp` của MSYS); `git archive`, `aws` dùng đường dẫn `F:/...`, `tar` cần `--force-local`; log group không bắt đầu bằng `/` trừ khi đặt `MSYS_NO_PATHCONV=1`. Profile `dbs` (IAM user `dev1`, nhóm `dbs-admin`) dựng được `session` (2026-11-21, 66 tài nguyên).

`api_extra_environment` chỉ nhận ba khóa (hai `RATE_LIMIT_*` là số nguyên dương, và `COGNITO_CLIENT_ID`), thay thế khóa trùng tên của task definition; không dùng ngoài đợt đo. TLS: ALB dev có chứng chỉ tự ký nên k6 chạy với `K6_INSECURE_SKIP_TLS_VERIFY=true` và riêng `prepare` với `NODE_TLS_REJECT_UNAUTHORIZED=0`; TLS tới RDS luôn xác minh bằng CA bundle. Phán quyết DoD 3 (lỗi < 0,1% suốt plateau 120 RPS, không dropped iteration, 429 ngoài bài rate-limit tính là lỗi) do `load-tests/aggregate-raw.cjs` tính trong `aggregate.json` (`plateaus`). Một đợt đủ năm bài khoảng 3 giờ (≈ 0,5 USD/giờ), vượt trần 90 phút của phiên demo: đây là ngoại lệ có chủ đích của task tải, trần cứng 3,5 giờ. Kết quả đo: [docs/components/load-tests](../../docs/components/load-tests/).

### Đợt đo Redis: `redis_fault_enabled` (DBS-167, DBS-186)

`loadgen` có biến `redis_fault_enabled` (mặc định `false`: không có quyền hay đường mạng nào tới Redis). Bật thì stack thêm egress 6379 của SG máy tải, **một** luật ingress 6379 vào SG Redis của `base` (như `db_from_loadgen`, nằm trong state của `loadgen` nên `destroy` gỡ), NACL riêng `dbs-dev-private-fault` (chỉ luật 100 «allow all») gắn vào hai private subnet, và quyền instance role: đọc secret AUTH của Valkey, `ec2:CreateNetworkAclEntry` và `ec2:DeleteNetworkAclEntry` chỉ trên ARN của NACL đó, `ec2:DescribeNetworkAcls`. Output `redis_fault_nacl_id`, `redis_fault_deny_cidrs` (CIDR các public subnet) và `redis_auth_secret_arn` vào `run.env` là `REDIS_FAULT_NACL_ID`, `REDIS_FAULT_DENY_CIDRS`, `REDIS_AUTH_SECRET_ID`; `REDIS_HOST` là output `redis_primary_endpoint` của `session`. `infra/scripts/redis-fault.sh` (chạy trên máy tải) thêm luật deny 6379 số 50 và 51 từ các CIDR public (tắt), xung `CLIENT PAUSE` (chậm), `FLUSHALL SYNC` (flush). **Thứ tự bắt buộc:** `apply` `loadgen` TRƯỚC `session` (đổi NACL của subnet chạm cả subnet RDS, nên làm lúc chưa có RDS) và `destroy` `session` TRƯỚC `loadgen`. `destroy` `loadgen` gỡ association nên hai subnet về NACL mặc định, mất luôn luật deny còn sót; nếu máy tải chết giữa lúc Redis đang bị chặn: `aws ec2 delete-network-acl-entry --network-acl-id <id> --ingress --rule-number 50` (và 51), hoặc `destroy` `loadgen`. Chi tiết, tiêu chí đo và kết quả: [DBS-167](../../docs/features/DBS-167-redis-fault-load.md).

## Môi trường production (`envs/prod/session`, DBS-152)

Stack `envs/prod/session` (state key `prod/session.tfstate`) dùng lại VPC, subnet, ECR, KMS CMK `alias/dbs-dev`, SG và Cognito từ `dev/base` qua `terraform_remote_state`, và tự tạo các tài nguyên riêng để cô lập phiên: SQS + DLQ + queue policy (`dbs-prod-*`), secret Valkey (`dbs/prod/redis-auth`, `recovery_window_in_days = 0`), log group (`/dbs/prod/{api,worker}`).

- **Giá trị production:** `NODE_ENV=production` (Swagger tắt), `TRUST_PROXY_HOPS=1`, `DATABASE_SSL=true`, Valkey TLS `required` (`rediss://`), RDS PostgreSQL 17 `db.t4g.small` Multi-AZ (backup 7 ngày, `rds.force_ssl=1`), Valkey 1 primary + 1 replica ghim ở 2 AZ khác nhau (`preferred_cache_cluster_azs`), `desired_count` ∈ `{0} ∪ [2, 4]`, `worker_desired_count` ∈ `[0, 2]`, tổng ≤ 6. Service `api` lăn `100%/200%` khi `desired_count <= 2` và `50%/100%` khi `> 2`.
- **Chứng chỉ TLS:** bắt buộc truyền `certificate_arn` (ACM cùng tài khoản và vùng `ap-southeast-1`, không dùng chứng chỉ tự ký). RDS và Valkey `depends_on` listener HTTPS để fail-fast nếu chứng chỉ không hợp lệ.
- **Lưu ý dùng chung `dev/base`:**
  - Dùng chung Cognito user pool: tài khoản demo dev và token dev dùng được trên prod.
  - App phát EMF vào cùng namespace `DBS/Backend` (chưa có chiều môi trường): **không chạy dev và prod cùng lúc** khi đo SLO.
  - Dùng chung CMK `alias/dbs-dev`: không xóa CMK ở `dev/base` khi còn snapshot hoặc secret của prod.
- **Teardown hai bước** (`termination_protection` mặc định `true`):
  1. `terraform apply -var termination_protection=false -var account_id=<id> -var state_bucket=<bucket> -var image_tag=<sha> -var certificate_arn=<arn>`
  2. `terraform destroy -var termination_protection=false -var account_id=<id> -var state_bucket=<bucket> -var image_tag=<sha> -var certificate_arn=<arn>`
  3. `AWS_PROFILE=dbs-admin bash infra/scripts/verify-clean.sh`
  (Nếu `apply` lỗi giữa chừng, chạy `destroy -var termination_protection=false` rồi `verify-clean.sh`. Nếu ai đó tắt bảo vệ ngoài Terraform để lại snapshot `dbs-prod-final`, cần xóa snapshot thủ công trước lần `destroy` sau.)
- **Chi phí ước tính:** ≈ 0,30 USD/giờ khi bật ([ADR-11](../../docs/adr/0011-aws-managed-session-based.md)); kiểm tra cấu hình ngoại tuyến bằng `node infra/scripts/check-prod-config.mjs <plan.json | --self-test>`.

## Hạ tầng API AI cho worker (`RSK-03`, tắt mặc định)

- `dev/base/ai_secret.tf` giữ vỏ secret `dbs/dev/openai-api-key` (mã hóa CMK `alias/dbs-dev`, `recovery_window_in_days = 0`); giá trị nạp ngoài băng dạng raw string (`sk-...`), không nằm trong Terraform state.
- `dev/session` tắt AI mặc định (`risk_ai_egress_approved = false`, 4 biến hạn mức `default = null`): khi tắt, `dbs-worker` không gắn `OPENAI_API_KEY` và `dbs-dev-worker-execution` không có policy đọc secret. Khi bật (`risk_ai_egress_approved = true`, sau `RSK-05`), Terraform `check` ép đủ 4 biến hạn mức và tổng kết nối PostgreSQL `desired_count * 10 + worker_desired_count * (10 + risk_ai_concurrency) + 5 <= 74`.
- Tắt mềm AI: tạo phiên bản `rule_only` qua `POST /v1/admin/risk-config/versions` (có hiệu lực sau ≤ 60 s TTL cache, không dừng worker). Tắt cứng: đặt `risk_ai_egress_approved = false`, `terraform apply`, rồi chạy ngay `aws ecs update-service --force-new-deployment` vì `aws_ecs_service.worker` có `ignore_changes = [task_definition]`.

## Kiểm tra trước khi push

```bash
terraform fmt -check -recursive
for d in bootstrap modules/waf envs/dev/base envs/dev/session envs/prod/session; do (cd $d && terraform init -backend=false && terraform validate && terraform test); done
```

CI chạy đúng các lệnh này ở job `terraform` của [`ci.yml`](../../.github/workflows/ci.yml) trên mọi PR và mọi lần push vào `main` (BL-028): một lần `terraform fmt -check -recursive infra/terraform`, rồi `init -backend=false`, `validate`, `test` cho từng thư mục trong năm thư mục trên, gồm mọi `tests/*.tftest.hcl` (kể cả `session/tests/dashboard.tftest.hcl` của DBS-145 và `waf.tftest.hcl` của DBS-153, `envs/prod/session/tests/prod.tftest.hcl` của DBS-152). Runner không có credential AWS và không cần: test dùng `mock_provider`/`override_data` (kể cả `data.terraform_remote_state.base`). Test mới phải giữ tính chất đó, đừng thêm test gọi AWS thật. Job ghim Terraform `1.16.6` (`required_version` trong `versions.tf` là `>= 1.11`) và chạy `init -lockfile=readonly`, nên đổi provider thì phải commit lại `.terraform.lock.hcl` (`terraform init -upgrade` kèm `terraform providers lock` cho các nền tảng cần). Job `script-tests` chạy test Python của `infra/scripts/tests/` (`seed-cognito.sh`, `verify-clean.sh`, `demo-token.sh`, `cost-report.py`) và `.github/scripts/tests/`. Job chưa nằm trong required status checks của `main`; thêm vào ruleset do chủ repo quyết định (BL-012).

Chi tiết cấu hình: [docs/03 mục 13](../../docs/03_HIGH_LEVEL_ARCHITECTURE.md).
