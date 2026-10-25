# infra/terraform

Hạ tầng AWS viết bằng Terraform. Phụ trách: #5.

## Cấu trúc

```
infra/terraform/
├── bootstrap/        # S3 bucket lưu state (tạo một lần, xem bên dưới)
├── modules/          # network, ecr, kms, ecs, rds, redis, sqs, cognito, monitoring…
└── envs/
    ├── dev/
    │   ├── base/     # phần giữ lại: VPC, ECR, KMS, Cognito, logs, OIDC (hiếm khi đổi)
    │   └── session/  # phần dựng/xóa hằng ngày: RDS, ElastiCache, ALB, ECS, SQS, WAF
    └── prod/
        └── session/  # Multi-AZ, ≥ 2 task; dùng lại base của dev qua remote state
```

Mỗi thư mục stack có `backend.tf` và `backend.hcl.example` riêng. `terraform destroy` một stack chỉ xóa phần của nó, nên `session` có thể xóa mỗi ngày mà không đụng `base`.

| Giữ lại (gần như miễn phí) | Dựng / xóa hằng ngày |
|---|---|
| S3 state, ECR, VPC, KMS, Cognito, logs, SNS, OIDC | RDS, ElastiCache, ALB, ECS service, SQS, WAF |

## Quy ước

- Terraform `>= 1.11` (khóa state bằng file khóa S3, không cần DynamoDB), provider `hashicorp/aws ~> 6.0`. Commit `.terraform.lock.hcl`.
- Region `ap-southeast-1`. Tên tài nguyên có tiền tố `dbs-<env>-`.
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

## Kiểm tra trước khi push

```bash
terraform fmt -check -recursive
cd bootstrap && terraform init -backend=false && terraform validate && terraform test
```

Chi tiết cấu hình: [docs/03 mục 13](../../docs/03_HIGH_LEVEL_ARCHITECTURE.md).
