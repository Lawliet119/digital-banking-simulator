# Runbook · Rollback ECS (`dbs-dev-api` và `dbs-dev-worker`)

> **Status:** Active · **Owner:** #5 Platform & Ops · **Cập nhật:** 2026-11-14 · **Task:** [DBS-156](../features/DBS-156-rollback-drill.md)

## Khi nào rollback

Rollback ngay khi gặp một trong các dấu hiệu sau sau khi deploy:
- Deployment `PRIMARY` không chuyển sang `COMPLETED` sau 10 phút.
- `GET /health/ready` qua ALB không trả `200` sau thời gian grace (60 giây).
- Tỉ lệ `5xx` hoặc lỗi khởi động tăng bất thường sau deploy.

Kiểm tra `rolloutState` của service trước: ECS deployment circuit breaker (`rollback = true`) có thể đã tự động rollback về revision ổn định trước đó.

## Trước khi làm

1. Xác định profile và region: `AWS_PROFILE=dbs-admin`, `AWS_REGION=ap-southeast-1`, cluster `dbs-dev`, hai service `dbs-dev-api` và `dbs-dev-worker`.
2. Kiểm tra revision hiện tại và các revision `ACTIVE` trước đó:
   ```bash
   aws ecs describe-services --cluster dbs-dev --services dbs-dev-api dbs-dev-worker --region ap-southeast-1 --profile dbs-admin
   aws ecs list-task-definitions --family-prefix dbs-api --status ACTIVE --sort DESC --region ap-southeast-1 --profile dbs-admin
   aws ecs list-task-definitions --family-prefix dbs-worker --status ACTIVE --sort DESC --region ap-southeast-1 --profile dbs-admin
   ```
3. Kiểm tra migration: rollback chỉ đổi image, **không** hoàn tác migration DB. An toàn với migration kiểu *expand*; nếu migration kiểu *contract* đã chạy thì **không** rollback mà sửa tiến (roll-forward).
4. Lưu ý Terraform: `ignore_changes = [task_definition]` ở `ecs.tf` và `worker.tf`, nên rollback tay không bị `terraform apply` ghi đè, nhưng lần `apply` sau cũng không tự khôi phục trạng thái.

## Rollback

Chọn revision `ACTIVE` ổn định gần nhất cho cả hai service (ví dụ `dbs-api:<rev>` và `dbs-worker:<rev>`), ghi mốc thời gian bắt đầu `t0` và cập nhật tuần tự cả hai service:

```bash
aws ecs update-service --cluster dbs-dev --service dbs-dev-api --task-definition dbs-api:<rev> --force-new-deployment --region ap-southeast-1 --profile dbs-admin
aws ecs update-service --cluster dbs-dev --service dbs-dev-worker --task-definition dbs-worker:<rev> --force-new-deployment --region ap-southeast-1 --profile dbs-admin
```

Theo dõi tới khi cả hai service có deployment `PRIMARY` đạt `rolloutState = COMPLETED` và `runningCount = desiredCount`:

```bash
aws ecs describe-services --cluster dbs-dev --services dbs-dev-api dbs-dev-worker --region ap-southeast-1 --profile dbs-admin --query 'services[*].{name:serviceName,taskDefinition:taskDefinition,running:runningCount,desired:desiredCount,deployments:deployments[*].{status:status,rolloutState:rolloutState}}'
```

> **Lưu ý:** Worker lăn `0% / 100%`, nên có khoảng trống xử lý ngắn khi thay task; sự kiện vẫn nằm an toàn trong `outbox_events` (ADR-03) và được xử lý bù sau khi worker khỏe.

## Kiểm sau rollback

1. Xác nhận `GET /health/live` và `GET /health/ready` qua ALB trả `200` (`redis: up`).
2. Kiểm tra log mới từ mốc `t0` của `/dbs/dev/api` và `/dbs/dev/worker` không có `Application startup failed` và worker có dòng log khởi động.
3. Kiểm tra hàng đợi SQS (`risk-events`, `notification-events`) và DLQ không bị tồn đọng bất thường.

## Giao dịch mẫu

Chạy một giao dịch mẫu sau rollback để xác nhận luồng tiền bình thường:
1. Kiểm tra `GET /v1/accounts` thấy số dư trước sự cố còn nguyên vẹn.
2. Replay một lệnh chuyển tiền cũ với cùng `Idempotency-Key` → trả lại đúng response đã lưu.
3. Thực hiện nạp tiền (`POST /v1/operator/deposits`) và chuyển tiền (`POST /v1/transfers`) → `201 COMPLETED`, số dư hai tài khoản khớp.

## Khi không rollback được

- **Revision cũ đã `INACTIVE`:** AWS từ chối `update-service` về revision `INACTIVE`. Khi đó lấy image SHA cũ từ ECR (`aws ecr describe-images`, ECR giữ 20 image gần nhất), render task definition mới bằng `.github/scripts/render-task-definition.py`, rồi `aws ecs register-task-definition` và `update-service` tới revision vừa đăng ký.
- **Image bị lỗi cả ở revision cũ hoặc DB đã contract:** chuyển sang sửa tiến (roll-forward) hoặc cô lập bằng cách đặt `desiredCount = 0` trong lúc khắc phục.

## Số đo

- **Ngưỡng đạt (docs/03 §13.3):** tổng thời gian từ lệnh `update-service` đầu tiên của rollback tới khi cả `dbs-dev-api` và `dbs-dev-worker` ổn định (`COMPLETED`, `runningCount = desiredCount`) và `/health/ready` trả `200` phải **≤ 600 giây (10 phút)**.
- **Kết quả diễn tập:** xem [DBS-156](../features/DBS-156-rollback-drill.md) §8 và `docs/deliverables/P3-rollback-drill/timings.md` (cập nhật sau khi chạy diễn tập thật trên AWS).
