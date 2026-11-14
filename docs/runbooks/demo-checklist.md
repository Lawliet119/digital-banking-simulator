# Checklist trước và sau demo (môi trường dev trên AWS)

> **Status:** Draft · **Vai:** #5 Platform & Ops · **Nguồn:** [DBS-139](../features/DBS-139-dev-env-rebuild-demo-checklist.md) · Các bước dựng và thời gian: [infra/terraform/README.md](../../infra/terraform/README.md#dựng-từ-trạng-thái-trống-và-đo-thời-gian-dbs-139)

Mục tiêu: demo không vấp lỗi hạ tầng. Làm theo thứ tự; mỗi dòng có lệnh kiểm và kết quả mong đợi. Mọi lệnh chạy từ gốc repo với `AWS_PROFILE=dbs-admin`.

## 0. Một ngày trước

- [ ] CI `Image` trên `main` xanh và ECR có image của SHA sẽ demo: `aws ecr describe-images --repository-name dbs-api --image-ids imageTag=<sha-40-ky-tu>` thoát 0. Không có image thì không dựng được task (BL-247).
- [ ] Budget alarm còn: `aws budgets describe-budgets --account-id <id> --query 'Budgets[].BudgetName'` thấy `My Monthly Cost Budget`.
- [ ] `bash infra/scripts/verify-clean.sh` thoát 0 (khởi đầu sạch). Thấy tài nguyên ngoài dự án thì ghi nhận, đừng xóa nếu không chắc.

## 1. Dựng (T − 60 phút)

Theo bảng ở README (dựng từ trạng thái trống). Bật tối đa 90 phút cho một phiên; chi phí ≈ 0,09 USD/giờ chưa tính task Fargate, khoảng 0,14 USD/giờ khi api và worker chạy (ADR-11).

- [ ] Tài khoản và vùng đúng: `aws sts get-caller-identity`, `ap-southeast-1`.
- [ ] `terraform plan` session được đọc (không có NAT, không VPC endpoint, không `destroy` ngoài ý định) rồi `apply` với `desired_count=1 worker_desired_count=1`, `image_tag` = SHA đã có trên ECR.
- [ ] `migrate.sh` thoát 0 (lần hai: "No migrations are pending").

## 2. Dịch vụ nào bật

| Dịch vụ | Phải bật | Vì sao | Kiểm |
|---|---|---|---|
| RDS `dbs-dev` | có | sổ cái, outbox | `aws rds describe-db-instances --db-instance-identifier dbs-dev --query 'DBInstances[0].DBInstanceStatus'` = `available` |
| ElastiCache `dbs-dev` | có | khóa phiên, rate limit, cache (có thể chết mà hệ thống vẫn chạy: `degraded`) | `aws elasticache describe-replication-groups --replication-group-id dbs-dev --query 'ReplicationGroups[0].Status'` = `available` |
| ALB `dbs-dev` | có | cổng vào HTTPS (chứng chỉ tự ký: `curl -k`) | `curl -sk -o /dev/null -w '%{http_code}\n' https://<alb>/health/live` = 200 |
| ECS `api` | có (1 task) | API | `aws ecs describe-services --cluster dbs-dev --services api --query 'services[0].[runningCount,desiredCount]'` = 1 1 |
| ECS `worker` | có (1 task) | outbox relay, consumer, cờ gian lận | như trên cho `worker`; log `/dbs/dev/worker` có dòng khởi động |
| Cognito, SQS, ECR, secret, KMS | đã giữ lại | không tính tiền đáng kể | `aws sqs get-queue-attributes` không cần; chỉ cần pool `dbs` còn |

## 3. Kiểm health (theo thứ tự)

- [ ] `https://<alb>/health/live` = 200 (tiến trình sống).
- [ ] `https://<alb>/health/ready` = 200, thân có `redis: up` (hoặc `degraded` nếu Valkey chậm: vẫn 200; PostgreSQL lỗi mới 503).
- [ ] Log api không có `Application startup failed`: `aws logs tail /dbs/dev/api --since 10m`.
- [ ] Worker: `aws logs tail /dbs/dev/worker --since 10m` không có lỗi; hàng đợi `dbs-dev-risk-events-dlq` và `dbs-dev-notification-events-dlq` có 0 message.
- [ ] Bất biến sổ cái: CLI đã biên dịch vào image (`node dist/scripts/invariants/invariants.js`, chạy bằng ECS one-off task theo `backend/README.md` §9, BL-128) nhưng **chưa có lần chạy thật trên RDS dev**. Cho đến khi có, dùng kết quả `check:invariants` của lần chạy local gần nhất; không đánh dấu ô này là đạt.

## 4. Seed

- [ ] Tài khoản demo (nhân viên operator, auditor, admin và ba khách customer1..3) có trong Cognito: `bash infra/scripts/seed-cognito.sh --dry-run` rồi (khi chưa có) `bash infra/scripts/seed-cognito.sh`.
- [ ] Dữ liệu demo qua API (sau khi api có task `RUNNING`): `AWS_PROFILE=dbs-admin bash infra/scripts/seed-cloud.sh` (thêm `--dry-run` để xem kế hoạch trước). Script chạy task ECS `dbs-seed` **trong VPC** và gọi thẳng task api qua HTTP cổng 3000, nên không dính chứng chỉ ALB tự ký (BL-252); token operator và customer1..3 tự lấy bằng `demo-token.sh` ngay trước khi chạy, không qua argv (đặt sẵn `DBS_*_TOKEN` trong môi trường thì dùng giá trị đó). Thoát 0 và in bản tóm tắt seed là đạt. Cần `apply base` và `apply session` có SG `dbs-dev-seed` và family `dbs-seed`, và image có `seed-cloud.js` (xem `infra/terraform/README.md`, mục Seed dữ liệu demo trên cloud). Ba khách customer1..3 do `seed-cognito.sh` tạo. Việc dựng từ DB trống nên không dính BL-213.

## 5. Token demo

- [ ] Lấy **sau** khi hệ thống đã lên (token sống 15 phút): `export DBS_OPERATOR_TOKEN=$(bash infra/scripts/demo-token.sh --role operator)`; tương tự `DBS_CUSTOMER_1_TOKEN` với `--role customer1`, `customer2`, `customer3` (và `auditor`, `admin` khi cần). Không dán token vào chat, ghi chú hay commit.
- [ ] Kiểm nhanh một token: gọi một route của đúng vai bằng `curl -sk -H "Authorization: Bearer $DBS_OPERATOR_TOKEN" https://<alb>/<route>` (bảng route: docs/03 §7) trả 2xx, và route của vai khác trả 403. Chưa chạy trên cloud (không có image, BL-247).
- [ ] Token khách hàng: ba khách seed lấy bằng `demo-token.sh --role customer1|customer2|customer3`; khách tự đăng ký mới dùng `sign-up`, `admin-confirm-sign-up` và `initiate-auth` (mật khẩu qua stdin, chạy trong Linux) như ở [demo giữa kỳ, nhánh cloud](../demos/demo-midterm-end-to-end.md#nhánh-cloud); chưa có script riêng (BL-350). Xóa khách đó (`admin-delete-user`) trước khi `destroy`, vì pool ở `base`.

## 6. Sau demo (ngay, không để qua đêm)

- [ ] `terraform destroy` stack `session` với đúng bộ biến lúc dựng, không `-target`.
- [ ] `bash infra/scripts/verify-clean.sh` thoát 0. Thấy `FAIL eni-available` hoặc `rds-automated-backup` ngay sau destroy là tạm thời: đợi vài phút, chạy lại. Thoát 2 nghĩa là chưa kiểm được: không kết luận sạch.
- [ ] Phần giữ lại còn nguyên và gần như miễn phí: VPC, ECR, Cognito, SQS, KMS, secret, log group.
- [ ] Ngày hôm sau ghi chi phí thật của phiên (Cost Explorer trễ tới 24 giờ): `python3 infra/scripts/cost-report.py`.
