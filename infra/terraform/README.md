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
    │   └── session/  # phần dựng/xóa hằng ngày: RDS, ElastiCache, ALB, ECS, WAF
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

### Dashboard CloudWatch (DBS-145)

`envs/dev/session/dashboard.tf` tạo `aws_cloudwatch_dashboard.overview` (`dbs-dev-overview`) cùng phiên; output `dashboard_url`. Dashboard không tham chiếu tài nguyên nào của session (chỉ tên DLQ từ state của `base`), nên có thể dựng riêng, không kéo ALB/RDS: `terraform apply -target=aws_cloudwatch_dashboard.overview` (cần `-var` như các lệnh trên). Xóa cùng `destroy` của session. Biến `metrics_namespace` (mặc định `DBS/Backend`) chỉ đổi khi thử bằng số mô phỏng. Hai phiên cùng dựng thì dùng chung một tên dashboard (PutDashboard ghi đè): chỉ một state được giữ nó. Chi phí ≈ 3 USD/tháng tính theo giờ tồn tại. Nội dung widget và cách đọc: [observability](../../docs/components/observability/01-concept-brief.md#dashboard-dbs-145).

**Dashboard hạ tầng (BL-261).** `envs/dev/session/dashboard_infra.tf` tạo thêm `dbs-dev-infra` (output `infra_dashboard_url`): ECS CPU và bộ nhớ của `api` và `worker`, số task api khỏe sau ALB, 5xx ở ALB (số lượng và tỉ lệ), RDS (kết nối, CPU), Valkey (CPU, bộ nhớ, kết nối). Nó **tách** khỏi `overview` vì widget ALB cần `arn_suffix` của `aws_lb` và target group (không dựng được từ chuỗi biết trước), nên dashboard này tham chiếu tài nguyên session và `-target` nó sẽ kéo cả ALB lên; `overview` vẫn không tham chiếu gì nên giữ tính chất `-target` ở trên. Số task đang chạy của ECS (`RunningTaskCount`) cần Container Insights, đang tắt ở `ecs.tf` (bật tốn tiền theo task), nên chưa có số task của worker: xem tuổi outbox (không có điểm là worker không chạy). Hai dashboard nằm trong 3 dashboard miễn phí của tài khoản (tối đa 50 metric mỗi dashboard).

### Alarm CloudWatch và thông báo (BL-051, BL-117, BL-127, BL-179, BL-182, BL-188, BL-235)

Mọi alarm gửi vào topic SNS `dbs-dev-alarms`, cả lúc báo (`alarm_actions`) lẫn lúc hết (`ok_actions`).

- `envs/dev/base/alarms.tf`: topic SNS, đăng ký email (biến `alarm_email`, mặc định rỗng = không đăng ký), 2 alarm DLQ (`dbs-dev-risk-dlq-not-empty`, `dbs-dev-notification-dlq-not-empty`). Ở base để email chỉ phải xác nhận **một lần** (không mất theo `destroy` của session) và để alarm DLQ còn đó khi session đã xóa nhưng DLQ vẫn giữ message tới 6 ngày. Output `alarm_topic_arn`.
- `envs/dev/session/alarms.tf`: 11 alarm của thứ chỉ có khi phiên chạy (tuổi queue, tuổi và cách ly outbox, Redis, fallback, rate limit, risk, đối soát). Đọc `alarm_topic_arn` từ state của `base`, nên **phải apply `base` trước `session`** (session cũ không có output này sẽ lỗi lúc plan).
- Bảng alarm, ngưỡng, cửa sổ và lý do: [observability](../../docs/components/observability/01-concept-brief.md#alarm-cloudwatch-bl-051-bl-117-bl-127-bl-179-bl-181-bl-182).

```bash
# base: đặt email nhận alarm (SNS gửi thư xác nhận; chưa bấm "Confirm subscription" thì không có thư alarm)
terraform apply -var account_id=<account-id> -var alarm_email=<email>
```

Chi phí: 13 alarm (2 ở base, 11 ở session). Alarm chuẩn 0,10 USD/alarm/tháng; alarm biểu thức metric (`SUM(METRICS())`) tính theo số metric tham chiếu (alarm lỗi luật 6, ba alarm khác mỗi cái 2). Ước ≈ 2,3 USD/tháng nếu chạy cả tháng, trong đó 0,2 USD của hai alarm DLQ ở base chạy luôn; alarm của session tính theo giờ và mất cùng phiên. SNS email gần như miễn phí. Thử alarm thật (đẩy message độc vào DLQ, ép lỗi luật) cần AWS thật và chưa làm: còn mở ở BL-051.

### Đẩy image lên ECR bằng OIDC (DBS-36)

`envs/dev/base` tạo OIDC provider của GitHub và role `dbs-github-ecr-push` (output `github_ecr_push_role_arn`). Role chỉ tin đúng `sub` của repo và nhánh `main` (repo bật immutable subject nên `sub` có id owner và id repo). Biến `github_oidc_sub_prefix` có sẵn giá trị đã kiểm; đổi repo thì lấy giá trị mới bằng `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (trường `sub_claim_prefix`).

Sau khi `apply`, **chủ repo** (cần quyền admin) tạo biến Actions (Settings → Secrets and variables → Actions → Variables, không phải Secrets): `AWS_ROLE_ARN` = output ở trên, và tùy chọn `AWS_REGION`. Tạo trước khi merge `image.yml`; thiếu biến thì job `image-push` bị bỏ qua, chạy lại bằng `gh workflow run image.yml --ref main`. Chỉ `image.yml` được xin `id-token: write`.

### Deploy tự động lên ECS (DBS-38)

`envs/dev/base` thêm role `dbs-github-deploy` (output `github_deploy_role_arn`), tin đúng `sub` của repo và nhánh `main` như role đẩy image; quyền chỉ gồm cập nhật service `dbs-dev/api`, đăng ký task definition `dbs-api`, đọc image trên ECR và `iam:PassRole` cho hai role của task. Sau khi `apply`, **chủ repo** tạo biến Actions `AWS_DEPLOY_ROLE_ARN` (thiếu biến thì job `deploy` bị bỏ qua). Chỉ `image.yml` và `deploy.yml` được xin `id-token: write`.

Luồng: push `main` → `Image` đẩy `dbs-api:<SHA>` → `Deploy` (`.github/workflows/deploy.yml`, `workflow_run`) chạy `.github/scripts/deploy.sh`: lấy revision ACTIVE mới nhất của family `dbs-api`, đổi image container `api`, đăng ký revision mới, `update-service`, chờ deployment PRIMARY `COMPLETED` (tối đa 20 phút; circuit breaker đã rollback hoặc `FAILED` thì đỏ), rồi kiểm `/health/live` và `/health/ready`. Sau khi api khỏe, `deploy.sh` lăn tiếp service `worker` (BL-248) cùng image: lấy revision ACTIVE mới nhất của family `dbs-worker`, đổi image container `worker`, đăng ký, `update-service`, rồi chờ PRIMARY `COMPLETED` với `runningCount` đủ `desiredCount` (worker lăn 0%/100%). `desiredCount` của worker = 0 (mặc định của stack): vẫn đăng ký và trỏ service về revision mới nhưng không chờ; service worker không ACTIVE thì cảnh báo và bỏ qua; `DEPLOY_WORKER=0` tắt bước này. Api lỗi thì worker không bị đụng (cả hai cùng ở bản cũ). Bỏ qua (thoát 0) khi stack `session` chưa dựng, service `desired_count = 0`, hoặc commit không còn là đầu `main`. Service có `ignore_changes = [task_definition]`: `terraform apply` không kéo về revision của Terraform; thay đổi task definition trong Terraform có hiệu lực ở lần deploy kế tiếp. `image_tag` lúc `apply` session phải là tag đã có trên ECR.

Chạy tay (không cần `gh`): `IMAGE_TAG=<sha-40-ky-tu> AWS_PROFILE=dbs-admin bash .github/scripts/deploy.sh`.

**Kiểm sống** (chứng chỉ self-signed nên cần `-k`):

```bash
ALB=$(aws elbv2 describe-load-balancers --names dbs-dev --query 'LoadBalancers[0].DNSName' --output text)
curl -sk -o /dev/null -w '%{http_code}\n' https://$ALB/health/live
curl -sk -o /dev/null -w '%{http_code}\n' https://$ALB/health/ready
```

**Rollback thủ công** (diễn tập chính thức ở tuần 6, DBS-156). Chỉ quay lại được image còn trong ECR (giữ 20 image mới nhất, nghĩa là 20 commit gần nhất):

```bash
aws ecs list-task-definitions --family-prefix dbs-api --sort DESC --max-items 5
aws ecs update-service --cluster dbs-dev --service api --task-definition dbs-api:<revision>
aws ecs describe-services --cluster dbs-dev --services api --query 'services[0].deployments'   # PRIMARY phải COMPLETED
```

### Migration trước deploy (DBS-68)

Migration chạy như một task ECS Fargate chạy một lần (family `dbs-migrate`, container `migrate`, lệnh `migration:run`), vì runner GitHub không với tới RDS. `deploy.sh` gọi `.github/scripts/migrate.sh` giữa "đăng ký revision api mới" và `update-service`: script đăng ký revision `dbs-migrate` với image của commit, `run-task` trong subnet và SG của service `api`, chờ `STOPPED`, đọc `exitCode`. Lỗi (exit khác 0, quá 600 s, không tạo được task) thì `deploy.sh` dừng trước `update-service` và service vẫn chạy bản cũ; log 50 dòng cuối của task được in trong nhóm `Log task migration`. Chạy lần hai khi không còn migration chờ là vô hại (TypeORM ghi vào bảng `migrations`).

**Chạy tay:**

```bash
IMAGE_TAG=<sha-40-ky-tu> AWS_PROFILE=dbs-admin bash .github/scripts/migrate.sh
```

Script từ chối chạy khi còn task `dbs-migrate` đang `RUNNING` (TypeORM không có khóa nên hai lần chạy chồng nhau sẽ va nhau). Đọc log của một lần chạy: `aws logs get-log-events --log-group-name /dbs/dev/api --log-stream-name migrate/migrate/<task-id>`.

**Trình tự "Up" lần đầu** (`desired_count = 0` nên `deploy.sh` bỏ qua): `apply session` → `Image` đã đẩy tag SHA lên ECR → `migrate.sh` bằng tay → nâng `desired_count` lên 1.

**Role chạy migration (BL-195): bước bắt buộc trước migration đầu tiên trên RDS.** Task `dbs-migrate` nối bằng user master (BL-103), mà master của RDS **không phải superuser thật**. Migration bước 7 (`1793664000000-CreateDbRolesAndGrants`, DBS-119) chạy `ALTER VIEW v_transfer_facts OWNER TO dbs_migrator`, và PostgreSQL chỉ cho người không phải superuser đổi chủ sang role mà họ `SET ROLE` được. Chưa có quyền đó thì cả lượt migration dừng với `42501 must be able to SET ROLE "dbs_migrator"` và rollback hết (`migration:run` chạy mọi migration chờ trong một transaction); `migrate.sh` thoát 1 và `deploy.sh` không `update-service`. Vì vậy, một lần, **trước** lần `migrate.sh` đầu tiên của database mới, kết nối bằng master (hoặc role có `ADMIN OPTION` trên `dbs_migrator`) và chạy:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_migrator') THEN
    CREATE ROLE dbs_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT dbs_migrator TO <master>;   -- <master> = DB_USER của secret master, ví dụ postgres
```

Migration bước 7 chỉ tạo `dbs_migrator` khi chưa có và **không bao giờ tự gán quyền cho user chạy nó** (một migration tự cấp quyền cho người chạy sẽ che đúng lỗi này). Một role do master tự tạo bằng `CREATEROLE` vẫn không cho master `SET ROLE` cho tới khi có `GRANT`, nên không bỏ qua được bước trên. Mọi migration sau đó (kể cả `1793750400000-AddNotificationLogCorrelationId`, `ALTER TABLE` đầu tiên trên bảng có sẵn) phải chạy bằng đúng role là **chủ các bảng**, tức master đã tạo chúng: đừng đổi chủ bảng sang `dbs_migrator` hay chạy migration bằng user khác khi chưa đổi chủ bảng. Bằng chứng: `backend/test/db/migration-owner-role.db-spec.ts` chạy toàn bộ migration bằng một login `CREATEROLE`, không superuser: không `GRANT` thì dừng đúng `42501` ở bước 7 và không áp dụng gì, có `GRANT` thì qua cả chuỗi và chạy lại được. Test này mô phỏng master bằng PostgreSQL 17 trong Testcontainers, **không phải RDS**: `rds_superuser` của RDS chưa được kiểm, nên BL-195 còn mở tới khi `migration:run` chạy thật trên RDS dev (M-68-04).

**Quy tắc:** migration chạy khi bản app cũ vẫn phục vụ, nên viết theo kiểu expand → migrate → contract (backend README); deploy lỗi sau migration không hoàn tác schema. Task migration chạy bằng execution role riêng `dbs-dev-migrate-execution` và **không có task role** (DBS-120); kết nối bằng secret master (BL-103 đổi sang secret của `dbs_migrator`). Role deploy cần `apply base` để có `iam:PassRole` cho role này trước lần deploy kế tiếp. Migration `1795000008000-EnableUnaccentSearch` (BL-178) chạy `CREATE EXTENSION unaccent`: `unaccent` có trong danh sách extension RDS hỗ trợ, và secret master (thành viên `rds_superuser`) đủ quyền; khi BL-103 đổi sang `dbs_migrator` thì role đó cần `CREATE` trên database `dbs` (extension này là *trusted* từ PG 13, không đòi superuser). Mặc định TypeORM chạy mọi migration chờ trong **một** transaction nên không dùng được `CREATE INDEX CONCURRENTLY` (BL-110). Role `dbs-github-deploy` cần `apply base` để có quyền `ecs:RunTask` (BL-109). Chi phí một lần chạy ≈ 0,012 USD/giờ × thời gian chạy; `destroy session` bỏ task definition, chỉ còn log event ở `base` (7 ngày).

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

Mật khẩu nằm ở Secrets Manager `dbs/dev/demo-accounts` (secret là nguồn sự thật; ≈ 0,40 USD/tháng; tag `project/env/owner`). Không bao giờ để mật khẩu trên dòng lệnh hay in ra màn hình. Quyền tối thiểu cho người chạy: `cognito-idp:AdminGetUser`, `AdminCreateUser`, `AdminSetUserPassword`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminUpdateUserAttributes`, `AdminListGroupsForUser`, `AdminUserGlobalSignOut` trên ARN pool; `secretsmanager:DescribeSecret`, `GetSecretValue`, `CreateSecret`, `PutSecretValue`, `TagResource` trên `dbs/dev/demo-accounts-*`. Teardown: `aws secretsmanager delete-secret --secret-id dbs/dev/demo-accounts --force-delete-without-recovery`.

**Role riêng để seed (BL-101):** `envs/dev/base/cognito_seeder.tf` tạo role `dbs-dev-cognito-seeder` (output `cognito_seeder_role_arn`) với đúng các quyền trên và không gì khác (không xóa secret hay user, không KMS vì secret dùng khóa mặc định `aws/secretsmanager`). Trust là gốc tài khoản: chỉ principal của tài khoản có `sts:AssumeRole` trong identity policy của mình (admin có sẵn) mới assume được; không đòi MFA vì dev không bật MFA cho IAM user. `apply base` một lần để tạo role, rồi thêm profile vào `~/.aws/config` và chạy script bằng profile đó thay cho `dbs-admin`:

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

`base` giữ KMS CMK dùng chung `alias/dbs-dev` (≈ 1 USD/tháng; xóa phải chờ 7 ngày), DB subnet group `dbs-dev` (2 private subnet) và SG `dbs-dev-db` (5432 chỉ từ SG `dbs-dev-api`; task `api` chỉ được đi ra 5432 tới SG này). `session` dựng instance `dbs-dev` (`db.t4g.micro`, Single-AZ, 20 GB gp3, mã hóa bằng CMK, `rds.force_ssl = 1`, `timezone = UTC`, backup 1 ngày) và parameter group `dbs-dev-postgres17`. Mật khẩu master do RDS quản lý trong Secrets Manager (output `db_master_secret_arn`); không có mật khẩu nào trong state. `db_instance_class` và `db_multi_az` là biến (production đổi).

**Chi phí khi bật** (ADR-11): RDS ≈ 0,025 USD/giờ + gp3 20 GB ≈ 0,004 USD/giờ + secret master 0,40 USD/tháng theo tỉ lệ. Dev mất dữ liệu mỗi lần `destroy` (không snapshot cuối, xóa cả backup tự động); seed lại bằng migration và script (DBS-68). Tạo mất 10–15 phút, xóa 5–8 phút: `destroy` ngay khi kiểm xong, không để qua đêm. Tên database `dbs` (local và CI dùng `banking`; app chỉ nhận `DATABASE_URL`). CA của RDS ghim `rds-ca-rsa2048-g1`.

Xóa (thứ tự ngược): `session` trước, `base` sau. `base` chỉ xóa được khi ECR `dbs-api` rỗng (`force_delete = false`); xóa image bằng `aws ecr batch-delete-image` trước. `base` gần như miễn phí nên thường giữ lại; chỉ xóa `session` cuối mỗi phiên làm việc. Ai bật phần tính tiền thì tắt khi xong.

Kiểm tra tĩnh cho `envs/dev/base` và `envs/dev/session`: `terraform init -backend=false && terraform test` (dùng `mock_provider` và `override_data`, không cần credential; CI chạy sẵn, xem "Kiểm tra trước khi push"). ALB của dev nghe HTTPS bằng chứng chỉ self-signed (chưa có tên miền): gọi bằng `curl -k`.

### Secret DB và TLS trong task api (DBS-67)
Task api nhận `DB_HOST` (từ `aws_db_instance.main.address`), `DB_PORT`, `DB_NAME`, `DATABASE_SSL=true`, `DATABASE_SSL_CA_PATH` làm biến thường, và `DB_USER`, `DB_PASSWORD` từ secret master (`<arn>:username::`, `<arn>:password::`). Execution role `dbs-dev-api-execution` có `secretsmanager:GetSecretValue` trên đúng secret đó và `kms:Decrypt` trên CMK `alias/dbs-dev` với `kms:ViaService = secretsmanager.<region>.amazonaws.com`.

- Ghi chú: ARN secret đổi mỗi lần dựng lại RDS, nên revision task cũ không dùng lại được sau `destroy`; `terraform apply` tạo revision mới. RDS xoay mật khẩu master mỗi 7 ngày, task đang chạy giữ mật khẩu cũ tới khi khởi động lại (BL-107).
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

### Hàng đợi SQS (DBS-73)

`envs/dev/base` tạo hai queue standard và hai DLQ: `dbs-dev-risk-events`, `dbs-dev-notification-events`, mỗi queue có `…-dlq` riêng. Queue nằm ở `base` vì SQS không tính tiền khi rảnh (trả theo request, 1 triệu request/tháng đầu miễn phí), URL không đổi giữa các phiên, và message trong DLQ còn nguyên sau `destroy session`.

| Tham số | Giá trị |
|---|---|
| Queue chính | visibility 30 giây, long polling 20 giây, giữ 4 ngày, sang DLQ sau 5 lần nhận (ADR-03), mã hóa SSE-SQS |
| DLQ | giữ 6 ngày, ngắn hơn 7 ngày của `processed_events`; redrive allow `byQueue`: chỉ queue chính tương ứng được trỏ vào |
| IAM | managed policy `dbs-dev-worker-sqs` (gửi, nhận, xóa, đổi visibility trên queue chính; chỉ `SendMessage` trên DLQ cho message sai schema), gắn vào role `dbs-dev-worker-task` ở `session` (DBS-120) |
| Chặn api | queue policy của cả 4 queue `Deny` mọi `sqs:*` cho role `dbs-dev-api-task` (so `aws:PrincipalArn` theo tên; đổi tên role thì sửa `sqs.tf`) |
| Danh sách cho phép (BL-241) | cùng queue policy có `Deny` `SendMessage`, `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `PurgeQueue`, `StartMessageMoveTask` cho mọi principal **không** khớp `ArnNotLike aws:PrincipalArn` với {role `dbs-dev-worker-task`, biến `sqs_ops_principal_arns`}. Mặc định biến để trống = mọi IAM user của tài khoản (`arn:aws:iam::<account>:user/*`), nên người vận hành và người redrive DLQ không bị khóa; role khác (api, role tương lai) và principal ngoài tài khoản bị chặn dù identity policy cho `sqs:*`. Chặt hơn: đặt `sqs_ops_principal_arns = ["arn:aws:iam::<account>:user/<tên>", …]` (nhớ gồm người chạy redrive). Không chặn thao tác quản trị queue (`SetQueueAttributes`, `GetQueueAttributes`, `DeleteQueue`), nên Terraform vẫn sửa được policy; lỡ khóa nhầm thì chỉ mất quyền đụng message, gỡ bằng sửa biến rồi `terraform apply base`. Redrive tự động của SQS sang DLQ (`maxReceiveCount`) là nội bộ SQS, không bị policy này đánh giá |

| Output của `base` | Biến môi trường (`sqs.config.ts`) |
|---|---|
| `sqs_risk_queue_url` | `SQS_RISK_QUEUE_URL` |
| `sqs_notification_queue_url` | `SQS_NOTIFICATION_QUEUE_URL` |
| `sqs_risk_dlq_url`, `sqs_notification_dlq_url` | không có biến: app suy ra URL DLQ từ URL queue chính bằng `dlqUrlFor(queueUrl)` = `<queueUrl>-dlq` (`backend/src/common/messaging/consumer-base.ts`), khớp tên Terraform `dbs-dev-<consumer>-events-dlq`. Hai output này dành cho người vận hành và runbook ([dlq-redrive](../../docs/runbooks/dlq-redrive.md)) |

`SQS_ENDPOINT` không đặt trên AWS. Hai biến URL vào task definition worker ở `session/worker.tf` (DBS-121).

**Kiểm danh sách cho phép trên AWS thật (BL-241, chưa chạy; sau `apply base`):** (1) tạo role tạm `dbs-sqs-probe` tin cậy IAM user đang chạy, inline policy `Allow sqs:*` trên 4 queue (đối chứng dương: Allow đã có hiệu lực, nên từ chối sau đó là do queue policy), `aws sts assume-role` (lặp tối đa 12 lần × 5 giây cho tới khi lan truyền); (2) gọi bằng credential tạm của role đó, truyền theo từng lệnh, không `export`: `env AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_SESSION_TOKEN=… aws sqs send-message --queue-url <url dbs-dev-risk-events> --message-body '{"probe":"BL-241"}'` và `receive-message`; mong đợi `AccessDenied` với "explicit deny in a resource-based policy"; (3) cùng lệnh bằng IAM user trong danh sách phải thành công (gửi rồi nhận và xóa message probe); (4) role worker thật gửi và nhận được: task Fargate tạm với `dbs-dev-worker-task` như bước "Kiểm quyền trái phép" ở mục DBS-120; (5) gửi một message hỏng và để consumer nhận 5 lần: message phải sang DLQ (redrive nội bộ không bị chặn), rồi `start-message-move-task` bằng user trong danh sách phải chạy; (6) xóa role tạm. Ghi nguyên văn thông báo lỗi.

Redrive DLQ về queue chính: `aws sqs start-message-move-task --source-arn <arn-dlq>`, theo dõi bằng `list-message-move-tasks`. Redrive cấp `MessageId` mới và tính lại hạn giữ từ lúc chuyển, nên message được redrive phải được xử lý xong trong vòng 24 giờ, mỗi message chỉ redrive một lần (quy tắc đầy đủ: [DBS-73 §2](../../docs/features/DBS-73-terraform-sqs.md), runbook ở BL-051). Với queue standard và `maxReceiveCount > 3`, `ApproximateAgeOfOldestMessage` bỏ qua message đã nhận từ 3 lần trở lên (ghi chú cho alarm DBS-163). Alarm DLQ > 0 (`base/alarms.tf`) và alarm tuổi message > 120 giây (`session/alarms.tf`): xem mục «Alarm CloudWatch» ở trên.

### Service worker (DBS-121)

`envs/dev/session/worker.tf` dựng task definition `dbs-worker` (0,25 vCPU / 0,5 GB, cùng image `dbs-api:<image_tag>`, `APP_ROLE=worker`) và service `worker` trong cluster `dbs-dev`; thuộc nhóm xóa hằng ngày. `envs/dev/base/worker.tf` giữ log group `/dbs/dev/worker` (7 ngày) và SG `dbs-dev-worker`.

| Mục | Giá trị |
|---|---|
| Sức khỏe | Theo ADR-13 và Dockerfile: không `healthCheck`, không cổng, không load balancer. Container `essential`: tiến trình thoát thì ECS chạy task mới. Worker treo phát hiện qua alarm tuổi outbox (`dbs-dev-outbox-age`) và tuổi message (`dbs-dev-*-events-age`), cả hai ở `session/alarms.tf`; không qua ECS |
| Mạng | SG không ingress; egress 443, 5432 tới SG db, 6379 tới SG redis. SG db và redis nhận từ SG api và SG worker, không ai khác. Task ở public subnet có IP công khai (ADR-10) |
| Số task | `worker_desired_count` mặc định 0, tối đa 2; `desired_count + worker_desired_count ≤ 6` (74 kết nối dùng được, mỗi task 10 + 5). Lăn 0%/100% để không có hai worker song song |
| Dừng | `stopTimeout` 60 s (một lô relay tới 25 s) |
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
| `dbs-dev-api-execution` | kéo image, ghi log `/dbs/dev/api`, `GetSecretValue` secret master RDS và `dbs/dev/redis-auth`, `kms:Decrypt` CMK qua Secrets Manager | `dbs-api` |
| `dbs-dev-worker-execution` | như api, ghi log `/dbs/dev/worker` | service worker (DBS-121) |
| `dbs-dev-migrate-execution` | kéo image, `CreateLogStream` trên `/dbs/dev/api`, `PutLogEvents` chỉ stream `migrate/*`, `GetSecretValue` chỉ secret master | `dbs-migrate` (không task role) |

- Hai task role tin `ecs-tasks.amazonaws.com` với `aws:SourceAccount` và `aws:SourceArn` (`arn:aws:ecs:<region>:<account>:*`); execution role chỉ có `aws:SourceAccount`.
- **Không đổi tên `dbs-dev-api-task`:** queue policy ở `base/sqs.tf` chặn theo tên role. Test khóa tên này.
- **Thứ tự apply:** role deploy (`base/deploy_role.tf`) chỉ được `iam:PassRole` cho role của `dbs-api` và `dbs-migrate`. Sau khi `session` đổi role, `apply base` trước lần deploy kế tiếp, nếu không `migrate.sh` lỗi `iam:PassRole`. Role worker được thêm cùng service worker (DBS-121, BL-242).
- **Kiểm quyền trái phép:** không assume được task role từ máy. Gọi thật bằng task Fargate tạm (family `dbs-probe`, image `public.ecr.aws/aws-cli/aws-cli`, `entryPoint ["sh","-c"]`) chạy dưới role cần thử; `simulate-principal-policy` chỉ tính identity policy (không áp queue policy cho role). Để thấy `explicit deny` của queue policy mà không cần task: dựng tạm một role **cùng tên** `dbs-dev-api-task` có `sqs:*` khi `session` chưa dựng, assume rồi gọi `sqs send-message`. Bằng chứng ở [feature doc DBS-120](../../docs/features/DBS-120-ecs-task-roles.md).
- **Dựng phần IAM rẻ để kiểm:** `terraform apply` với mười `-target` (5 role, `aws_iam_role_policy_attachment.worker_sqs`, `aws_iam_role_policy.execution`, `.worker_execution`, `.migrate_execution`, `aws_ecs_cluster.main`) không cần RDS hay Valkey; phần còn lại của session không dựng.

## Dựng từ trạng thái trống và đo thời gian (DBS-139)

«Trạng thái trống» nghĩa là: `base` đã có (giữ lại, không dựng lại mỗi phiên), `session` rỗng, ECR có image của SHA cần chạy. Bảng dưới đây là các bước theo thứ tự; cột thời gian chỉ ghi số **đo thật** (ngày 2026-11-12, `ap-southeast-1`, profile `dbs-admin`, Terraform 1.16.6) hoặc nói rõ **ước tính, chưa đo** và lý do. Checklist cho người trực demo: [docs/runbooks/demo-checklist.md](../../docs/runbooks/demo-checklist.md).

| # | Bước | Lệnh | Thời gian |
|---|---|---|---|
| 1 | Kiểm tài khoản, vùng, budget, khởi đầu sạch | `aws sts get-caller-identity`; `aws budgets describe-budgets --account-id <id>`; `bash infra/scripts/verify-clean.sh` | **đo: 17 giây** (verify-clean, 13 loại) |
| 2 | `plan` session, đọc kết quả | `terraform plan …` (30 tài nguyên thêm, 0 xóa) | **đo: 5 giây** |
| 3 | `apply` session (RDS, Valkey, ALB, IAM, ECS service ở 0 task) | `terraform apply …` (lệnh ở mục «Thứ tự dựng») | **đo: 9 phút 16 giây** (RDS 8 phút 41 giây, Valkey 9 phút 10 giây, ALB 2 phút 13 giây, chạy song song nên tổng ≈ tài nguyên chậm nhất) |
| 4 | Image `<sha>` lên ECR | CI `Image` trên `main` (hoặc đã có từ trước) | **chưa đo**: ECR đang không có image và máy làm việc không có docker (BL-247). Đã có sẵn từ lần `main` trước thì ≈ 0 phút lúc dựng |
| 5 | Migration | `IMAGE_TAG=<sha> bash .github/scripts/migrate.sh` | **ước tính, chưa đo**: trần của script 10 phút; một task Fargate chạy một lần thường 1–3 phút (BL-109) |
| 6 | Nâng service lên 1 api và 1 worker, chờ `runningCount` | `terraform apply … -var desired_count=1 -var worker_desired_count=1` | **ước tính, chưa đo**: 2–4 phút (kéo image, `healthCheckGracePeriodSeconds = 60`) |
| 7 | Tài khoản nhân viên demo | `bash infra/scripts/seed-cognito.sh` | **đo `--dry-run` 0 giây**; chạy thật không cần lặp: tài khoản đã có trong Cognito (phần giữ lại) |
| 8 | Dữ liệu demo qua API | `cd backend && npm run seed -- --auth cloud …` (token qua biến môi trường) | **chưa đo** (cần API chạy; còn vướng TLS tự ký và token khách hàng, BL-252) |
| 9 | Health | `curl -k https://<alb>/health/live`, `/health/ready` | **đo: ALB trả 503 khi chưa có target** (chứng minh ALB và TLS lên); 200 **chưa đo** |
| 10 | Token demo | `bash infra/scripts/demo-token.sh --role operator\|auditor\|admin` | **đo: 3–4 giây mỗi vai** |
| 11 | Bất biến sổ cái | `npm run check:invariants` | **chưa chạy được trên cloud** (RDS riêng tư, checker cần `ts-node`: BL-128) |

**Tổng.** Phần đo thật (bước 1–3, 7, 9 phần ALB, 10) là **≈ 10 phút**, chủ yếu là RDS và Valkey. Phần chưa đo (4, 5, 6, 8, 9 phần 200) cộng ước tính khoảng 10–15 phút, nên cả quy trình **dự kiến** vào khoảng 20–25 phút; đây là **ước tính, chưa chứng minh**: DoD «≤ 30 phút» của DBS-139 chưa đạt cho tới khi chạy trọn có image (BL-251). Bước bị bỏ qua có chủ ý: tạo ba role DB (`db-roles.sql`) không có bước riêng, vì task vẫn nối bằng credential master (BL-103).

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

Tham số: `--end` không tính (exclusive) và mặc định là hôm nay UTC; `--credit-since` (mặc định 2026-08-01, tháng đầu có credit); `--project-end` mặc định 2026-12-14 (hết ngày 13/12). Script lỗi (credential, quyền) thì thoát 1 và stdout rỗng, không ghi nửa báo cáo. Test: `python3 infra/scripts/tests/test_cost_report.py`.

**Tag chi phí.** `base/cost_tags.tf` bật `project`, `env`, `owner` trong Cost allocation tags (miễn phí); xóa resource hoặc `destroy base` đặt chúng về Inactive. Tag mới bật cần tới 24 giờ mới nhóm được; dữ liệu cũ cần backfill một lần:

```bash
aws ce start-cost-allocation-tag-backfill --backfill-from 2026-10-01T00:00:00Z
aws ce list-cost-allocation-tag-backfill-history
```

> **State `base` đang lệch với `main`:** queue SQS của DBS-73 (PR #40, chưa merge) đã được apply, còn role deploy thì chưa có trong state. `terraform plan` đầy đủ từ `main` sẽ **xóa 11 tài nguyên SQS**. Tới khi DBS-73 merge, chỉ apply tag bằng `-target`: `terraform plan -out=tags.tfplan -var account_id=<account-id> -target='aws_ce_cost_allocation_tag.this'`, rồi `terraform apply tags.tfplan` ([BL-138](../../docs/BACKLOG.md)).

## Kiểm tra trước khi push

```bash
terraform fmt -check -recursive
for d in bootstrap envs/dev/base envs/dev/session; do (cd $d && terraform init -backend=false && terraform validate && terraform test); done
```

CI chạy đúng các lệnh này ở job `terraform` của [`ci.yml`](../../.github/workflows/ci.yml) trên mọi PR và mọi lần push vào `main` (BL-028): một lần `terraform fmt -check -recursive infra/terraform`, rồi `init -backend=false`, `validate`, `test` cho từng thư mục trong ba thư mục trên, gồm mọi `tests/*.tftest.hcl` (kể cả `session/tests/dashboard.tftest.hcl` của DBS-145). Runner không có credential AWS và không cần: test dùng `mock_provider`/`override_data` (kể cả `data.terraform_remote_state.base`). Test mới phải giữ tính chất đó, đừng thêm test gọi AWS thật. Job ghim Terraform `1.16.6` (`required_version` trong `versions.tf` là `>= 1.11`) và chạy `init -lockfile=readonly`, nên đổi provider thì phải commit lại `.terraform.lock.hcl` (`terraform init -upgrade` kèm `terraform providers lock` cho các nền tảng cần). Job `script-tests` chạy test Python của `infra/scripts/tests/` (`seed-cognito.sh`, `verify-clean.sh`, `demo-token.sh`, `cost-report.py`) và `.github/scripts/tests/`. Job chưa nằm trong required status checks của `main`; thêm vào ruleset do chủ repo quyết định (BL-012).

Chi tiết cấu hình: [docs/03 mục 13](../../docs/03_HIGH_LEVEL_ARCHITECTURE.md).
