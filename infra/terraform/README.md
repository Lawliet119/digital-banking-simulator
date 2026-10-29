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

Xóa (thứ tự ngược): `session` trước, `base` sau. `base` chỉ xóa được khi ECR `dbs-api` rỗng (`force_delete = false`); xóa image bằng `aws ecr batch-delete-image` trước. `base` gần như miễn phí nên thường giữ lại; chỉ xóa `session` cuối mỗi phiên làm việc. Ai bật phần tính tiền thì tắt khi xong.

Kiểm tra tĩnh cho `envs/dev/base` và `envs/dev/session`: `terraform init -backend=false && terraform test` (dùng `mock_provider` và `override_data`, không cần credential). ALB của dev nghe HTTPS bằng chứng chỉ self-signed (chưa có tên miền): gọi bằng `curl -k`.

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

## Kiểm tra trước khi push

```bash
terraform fmt -check -recursive
for d in bootstrap envs/dev/base envs/dev/session; do (cd $d && terraform init -backend=false && terraform validate && terraform test); done
```

Chi tiết cấu hình: [docs/03 mục 13](../../docs/03_HIGH_LEVEL_ARCHITECTURE.md).
