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

### Đẩy image lên ECR bằng OIDC (DBS-36)

`envs/dev/base` tạo OIDC provider của GitHub và role `dbs-github-ecr-push` (output `github_ecr_push_role_arn`). Role chỉ tin đúng `sub` của repo và nhánh `main` (repo bật immutable subject nên `sub` có id owner và id repo). Biến `github_oidc_sub_prefix` có sẵn giá trị đã kiểm; đổi repo thì lấy giá trị mới bằng `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (trường `sub_claim_prefix`).

Sau khi `apply`, **chủ repo** (cần quyền admin) tạo biến Actions (Settings → Secrets and variables → Actions → Variables, không phải Secrets): `AWS_ROLE_ARN` = output ở trên, và tùy chọn `AWS_REGION`. Tạo trước khi merge `image.yml`; thiếu biến thì job `image-push` bị bỏ qua, chạy lại bằng `gh workflow run image.yml --ref main`. Chỉ `image.yml` được xin `id-token: write`.

### Deploy tự động lên ECS (DBS-38)

`envs/dev/base` thêm role `dbs-github-deploy` (output `github_deploy_role_arn`), tin đúng `sub` của repo và nhánh `main` như role đẩy image; quyền chỉ gồm cập nhật service `dbs-dev/api`, đăng ký task definition `dbs-api`, đọc image trên ECR và `iam:PassRole` cho hai role của task. Sau khi `apply`, **chủ repo** tạo biến Actions `AWS_DEPLOY_ROLE_ARN` (thiếu biến thì job `deploy` bị bỏ qua). Chỉ `image.yml` và `deploy.yml` được xin `id-token: write`.

Luồng: push `main` → `Image` đẩy `dbs-api:<SHA>` → `Deploy` (`.github/workflows/deploy.yml`, `workflow_run`) chạy `.github/scripts/deploy.sh`: lấy revision ACTIVE mới nhất của family `dbs-api`, đổi image container `api`, đăng ký revision mới, `update-service`, chờ deployment PRIMARY `COMPLETED` (tối đa 20 phút; circuit breaker đã rollback hoặc `FAILED` thì đỏ), rồi kiểm `/health/live` và `/health/ready`. Bỏ qua (thoát 0) khi stack `session` chưa dựng, service `desired_count = 0`, hoặc commit không còn là đầu `main`. Service có `ignore_changes = [task_definition]`: `terraform apply` không kéo về revision của Terraform; thay đổi task definition trong Terraform có hiệu lực ở lần deploy kế tiếp. `image_tag` lúc `apply` session phải là tag đã có trên ECR.

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

**Quy tắc:** migration chạy khi bản app cũ vẫn phục vụ, nên viết theo kiểu expand → migrate → contract (backend README); deploy lỗi sau migration không hoàn tác schema. Task migration tạm dùng secret master như api (BL-103); DBS-119 tách role `dbs_migrator`, execution role riêng và sửa `iam:PassRole` ở `base/deploy_role.tf`. Mặc định TypeORM chạy mọi migration chờ trong **một** transaction nên không dùng được `CREATE INDEX CONCURRENTLY` (BL-110). Role `dbs-github-deploy` cần `apply base` để có quyền `ecs:RunTask` (BL-109). Chi phí một lần chạy ≈ 0,012 USD/giờ × thời gian chạy; `destroy session` bỏ task definition, chỉ còn log event ở `base` (7 ngày).

### Cognito và tài khoản nhân viên demo (DBS-54)

`envs/dev/base` tạo user pool `dbs` (đăng nhập bằng email không phân biệt hoa thường, tự đăng ký bật, mật khẩu tối thiểu 12 ký tự đủ 4 loại), 4 nhóm `customer`, `operator`, `auditor`, `admin` và app client `dbs-app` không secret (`USER_SRP_AUTH`, `REFRESH_TOKEN_AUTH`, `USER_PASSWORD_AUTH`; access và ID token 15 phút, refresh 1 ngày). Output: `cognito_user_pool_id`, `cognito_client_id`, `cognito_issuer` (ba biến `COGNITO_*` của task ECS lấy từ đây, không bí mật). `cognito_deletion_protection` mặc định `INACTIVE` cho dev (teardown cần); đặt `ACTIVE` khi pool đã có người dùng thật, và đặt lại `INACTIVE` trước khi `destroy base`.

Tài khoản `operator`, `auditor`, `admin` demo do script tạo, không do Terraform (mật khẩu không vào state):

```bash
export COGNITO_USER_POOL_ID=$(terraform -chdir=infra/terraform/envs/dev/base output -raw cognito_user_pool_id)
bash infra/scripts/seed-cognito.sh --dry-run   # chỉ in kế hoạch
bash infra/scripts/seed-cognito.sh             # tạo; chạy lại an toàn
bash infra/scripts/seed-cognito.sh --rotate    # đổi mật khẩu và sign-out phiên cũ
python3 infra/scripts/tests/test_seed_cognito.py   # test của script (aws giả, không cần credential)
```

Mật khẩu nằm ở Secrets Manager `dbs/dev/demo-accounts` (secret là nguồn sự thật; ≈ 0,40 USD/tháng; tag `project/env/owner`). Không bao giờ để mật khẩu trên dòng lệnh hay in ra màn hình. Quyền tối thiểu cho người chạy: `cognito-idp:AdminGetUser`, `AdminCreateUser`, `AdminSetUserPassword`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminUpdateUserAttributes`, `AdminListGroupsForUser`, `AdminUserGlobalSignOut` trên ARN pool; `secretsmanager:DescribeSecret`, `GetSecretValue`, `CreateSecret`, `PutSecretValue`, `TagResource` trên `dbs/dev/demo-accounts-*`. Teardown: `aws secretsmanager delete-secret --secret-id dbs/dev/demo-accounts --force-delete-without-recovery`.

### RDS PostgreSQL 17 (DBS-66)

`base` giữ KMS CMK dùng chung `alias/dbs-dev` (≈ 1 USD/tháng; xóa phải chờ 7 ngày), DB subnet group `dbs-dev` (2 private subnet) và SG `dbs-dev-db` (5432 chỉ từ SG `dbs-dev-api`; task `api` chỉ được đi ra 5432 tới SG này). `session` dựng instance `dbs-dev` (`db.t4g.micro`, Single-AZ, 20 GB gp3, mã hóa bằng CMK, `rds.force_ssl = 1`, `timezone = UTC`, backup 1 ngày) và parameter group `dbs-dev-postgres17`. Mật khẩu master do RDS quản lý trong Secrets Manager (output `db_master_secret_arn`); không có mật khẩu nào trong state. `db_instance_class` và `db_multi_az` là biến (production đổi).

**Chi phí khi bật** (ADR-11): RDS ≈ 0,025 USD/giờ + gp3 20 GB ≈ 0,004 USD/giờ + secret master 0,40 USD/tháng theo tỉ lệ. Dev mất dữ liệu mỗi lần `destroy` (không snapshot cuối, xóa cả backup tự động); seed lại bằng migration và script (DBS-68). Tạo mất 10–15 phút, xóa 5–8 phút: `destroy` ngay khi kiểm xong, không để qua đêm. Tên database `dbs` (local và CI dùng `banking`; app chỉ nhận `DATABASE_URL`). CA của RDS ghim `rds-ca-rsa2048-g1`.

Xóa (thứ tự ngược): `session` trước, `base` sau. `base` chỉ xóa được khi ECR `dbs-api` rỗng (`force_delete = false`); xóa image bằng `aws ecr batch-delete-image` trước. `base` gần như miễn phí nên thường giữ lại; chỉ xóa `session` cuối mỗi phiên làm việc. Ai bật phần tính tiền thì tắt khi xong.

Kiểm tra tĩnh cho `envs/dev/base` và `envs/dev/session`: `terraform init -backend=false && terraform test` (dùng `mock_provider` và `override_data`, không cần credential). ALB của dev nghe HTTPS bằng chứng chỉ self-signed (chưa có tên miền): gọi bằng `curl -k`.

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
- Provider: `aws >= 6.70, < 7.0` ở `base` và `session` (cần thuộc tính write-only), `random ~> 3.7` ở `session`.
- Kiểm tĩnh: `terraform test` ở `envs/dev/base` (`tests/redis.tftest.hcl`) và `envs/dev/session` (run `valkey_replication_group`, `redis_connection`, `redis_secret_policy`…). Probe chạy thật trên AWS: [DBS-75 §8](../../docs/features/DBS-75-terraform-valkey.md).

### Hàng đợi SQS (DBS-73)

`envs/dev/base` tạo hai queue standard và hai DLQ: `dbs-dev-risk-events`, `dbs-dev-notification-events`, mỗi queue có `…-dlq` riêng. Queue nằm ở `base` vì SQS không tính tiền khi rảnh (trả theo request, 1 triệu request/tháng đầu miễn phí), URL không đổi giữa các phiên, và message trong DLQ còn nguyên sau `destroy session`.

| Tham số | Giá trị |
|---|---|
| Queue chính | visibility 30 giây, long polling 20 giây, giữ 4 ngày, sang DLQ sau 5 lần nhận (ADR-03), mã hóa SSE-SQS |
| DLQ | giữ 6 ngày, ngắn hơn 7 ngày của `processed_events`; redrive allow `byQueue`: chỉ queue chính tương ứng được trỏ vào |
| IAM | managed policy `dbs-dev-worker-sqs` (gửi, nhận, xóa, đổi visibility trên queue chính; chỉ `SendMessage` trên DLQ cho message sai schema). Chưa gắn role nào: DBS-120 gắn vào role task worker |
| Chặn api | queue policy của cả 4 queue `Deny` mọi `sqs:*` cho role `dbs-dev-api-task` (so `aws:PrincipalArn` theo tên; đổi tên role thì sửa `sqs.tf`) |

| Output của `base` | Biến môi trường (`sqs.config.ts`) |
|---|---|
| `sqs_risk_queue_url` | `SQS_RISK_QUEUE_URL` |
| `sqs_notification_queue_url` | `SQS_NOTIFICATION_QUEUE_URL` |
| `sqs_risk_dlq_url`, `sqs_notification_dlq_url` | chưa có biến (DBS-77, DBS-90 thêm khi consumer đẩy message sai schema vào DLQ) |

`SQS_ENDPOINT` không đặt trên AWS. Đưa các biến vào task definition worker là việc của DBS-121.

Redrive DLQ về queue chính: `aws sqs start-message-move-task --source-arn <arn-dlq>`, theo dõi bằng `list-message-move-tasks`. Redrive cấp `MessageId` mới và tính lại hạn giữ từ lúc chuyển, nên message được redrive phải được xử lý xong trong vòng 24 giờ, mỗi message chỉ redrive một lần (quy tắc đầy đủ: [DBS-73 §2](../../docs/features/DBS-73-terraform-sqs.md), runbook ở BL-051). Với queue standard và `maxReceiveCount > 3`, `ApproximateAgeOfOldestMessage` bỏ qua message đã nhận từ 3 lần trở lên (ghi chú cho alarm DBS-163).

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

Chi tiết cấu hình: [docs/03 mục 13](../../docs/03_HIGH_LEVEL_ARCHITECTURE.md).
