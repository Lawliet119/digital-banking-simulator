# infra/terraform

Hạ tầng AWS viết bằng Terraform. Phụ trách: #5.

## Cấu trúc dự kiến

```
infra/terraform/
├── modules/          # network, ecs, rds, redis, sqs, cognito, monitoring
├── envs/
│   ├── dev/          # Single-AZ, dựng/xóa theo giờ làm việc
│   └── prod/         # Multi-AZ, ≥ 2 task — chỉ bật khi demo HA / đo SLO
└── bootstrap/        # S3 bucket lưu state (tạo một lần)
```

## Tách phần giữ lại và phần dựng/xóa

| Giữ lại (gần như miễn phí) | Dựng / xóa hằng ngày |
|---|---|
| S3 state, ECR, VPC, Cognito | RDS, ElastiCache, ALB, WAF, ECS service |

## Quy tắc

- **Không commit** `*.tfvars`, `terraform.tfstate` (đã có trong `.gitignore`). Dùng `*.tfvars.example` làm mẫu.
- State lưu trên S3 (bật versioning, mã hóa), không lưu ở máy cá nhân.
- **Không tạo NAT Gateway** và không tạo VPC interface endpoint ([ADR-10](../../docs/adr/0010-fargate-egress-public-subnet.md)). Task ECS ở public subnet, security group chỉ nhận từ ALB.
- Region: `ap-southeast-1`. Tag bắt buộc trên mọi tài nguyên: `project=dbs`, `env=dev|prod`, `owner=<vai>` ([ADR-11](../../docs/adr/0011-aws-managed-session-based.md)).
- Ai `apply` phần dựng/xóa thì `destroy` khi xong và báo trong kênh chat lúc bật, lúc tắt.
- Bật AWS Budget alarm (50 / 100 / 150 USD, gửi #5 và #6) trước khi dựng bất cứ thứ gì.

Chi tiết cấu hình: [docs/03 mục 13](../../docs/03_HIGH_LEVEL_ARCHITECTURE.md).
