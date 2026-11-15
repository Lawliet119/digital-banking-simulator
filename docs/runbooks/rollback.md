# Runbook · Rollback ECS (service `api` và `worker`)

> **Status:** Active · **Owner:** #5 Platform & Ops · **Cập nhật:** 2026-11-15 · **Task:** [DBS-156](../features/DBS-156-rollback-drill.md) · **Verified against code:** diễn tập thật trên AWS dev ngày 2026-11-14 và 2026-11-15 (số đo ở cuối)

## Tên cần biết trước

| Thứ | Giá trị | Ghi chú |
|---|---|---|
| Cluster | `dbs-dev` | |
| Service | `api` và `worker` | Tên **service** trong Terraform (`envs/dev/session/ecs.tf`, `worker.tf`) **không** có tiền tố `dbs-dev-`. `dbs-dev-api` là tên ALB/security group, dùng nó làm tên service sẽ lỗi `ServiceNotFoundException` |
| Family task definition | `dbs-api` và `dbs-worker` | Revision viết `dbs-api:<rev>`, `dbs-worker:<rev>` |
| Nhóm log | `/dbs/dev/api`, `/dbs/dev/worker` | Luồng log của task: `api/api/<task-id>`, `worker/worker/<task-id>`; migration: `migrate/migrate/<task-id>` trong `/dbs/dev/api` |
| Vùng | `ap-southeast-1` | |
| Profile AWS | một profile thuộc nhóm IAM `dbs-admin` | Tài liệu ghi `AWS_PROFILE=dbs-admin`; trên máy dev của nhóm profile đó tên là `dbs` (`export AWS_PROFILE=<tên profile của bạn>`). Các lệnh dưới đây dùng biến này, không gắn `--profile` |

```bash
export AWS_PROFILE=dbs-admin AWS_DEFAULT_REGION=ap-southeast-1   # đổi tên profile cho khớp máy
```

**Quyền tối thiểu** (hiện dùng nhóm `dbs-admin`, quyền admin; nên tách thành role vận hành riêng, xem §8 của DBS-156): `ecs:DescribeServices`, `ecs:DescribeTaskDefinition`, `ecs:ListTaskDefinitions`, `ecs:ListTasks`, `ecs:DescribeTasks`, `ecs:UpdateService`, `ecs:RegisterTaskDefinition`, `ecs:TagResource` (task definition mang tag `default_tags`), `ecs:DeregisterTaskDefinition`, `ecs:RunTask` (kiểm bất biến) và `iam:PassRole` cho các role task/execution; `logs:FilterLogEvents`, `logs:GetLogEvents`; `sqs:GetQueueUrl`, `sqs:GetQueueAttributes`; `secretsmanager:GetSecretValue` cho secret tài khoản demo (chỉ khi chạy giao dịch mẫu). Trên GitHub: quyền write hoặc maintain của repo để tắt và hủy workflow `Deploy`.

## Khi nào rollback

Rollback ngay khi gặp một trong các dấu hiệu sau sau khi deploy:
- Deployment `PRIMARY` không chuyển sang `COMPLETED` sau 10 phút.
- `GET /health/ready` qua ALB không trả `200` sau thời gian grace (60 giây).
- Tỉ lệ `5xx` hoặc lỗi khởi động (`Application startup failed` trong luồng log của task mới) tăng bất thường sau deploy.

**Trước hết xem circuit breaker đã tự rollback chưa.** ECS deployment circuit breaker (`rollback = true`) tự đưa service về revision ổn định trước sau một số task hỏng liên tiếp (tối thiểu 3). Dấu hiệu: deployment `PRIMARY` đã trỏ lại revision cũ, và có một deployment `rolloutState = FAILED` trỏ revision lỗi (`rolloutState` chỉ có `IN_PROGRESS`, `COMPLETED`, `FAILED`):

```bash
aws ecs describe-services --cluster dbs-dev --services api worker \
  --query 'services[*].{name:serviceName,deployments:deployments[*].{status:status,rolloutState:rolloutState,failed:failedTasks,td:taskDefinition}}'
```

Kể cả khi breaker đã tự rollback, vẫn phải làm hai bước **bắt buộc** ở mục «Sau mọi lần rollback» (dừng deploy tự động, hủy đăng ký revision lỗi).

## Trước khi làm

1. **Dừng deploy tự động** cho tới khi có bản sửa đã merge: `deploy.sh` dựng lần deploy kế tiếp từ revision `ACTIVE` mới nhất của mỗi family và chỉ thay image, nên một lần push `main` có thể chép lại cấu hình lỗi.
   ```bash
   gh workflow disable Deploy   # bật lại: gh workflow enable Deploy
   gh run list --workflow Deploy --status in_progress   # tắt workflow không hủy lần chạy đang chờ hay đang chạy
   gh run cancel <run-id>
   ```
   Báo trong kênh chat của nhóm: **không ai chạy `deploy.sh` tay** cho tới khi xong (lệnh tắt workflow không chặn việc chạy tay).
2. **Xem revision hiện tại và các revision `ACTIVE`:**
   ```bash
   aws ecs describe-services --cluster dbs-dev --services api worker --query 'services[*].{name:serviceName,taskDefinition:taskDefinition,running:runningCount,desired:desiredCount}' --output table
   aws ecs list-task-definitions --family-prefix dbs-api --status ACTIVE --sort DESC --max-items 5
   aws ecs list-task-definitions --family-prefix dbs-worker --status ACTIVE --sort DESC --max-items 5
   ```
   `list-task-definitions` chỉ trả revision `ACTIVE`; revision `INACTIVE` không dùng được (xem «Khi không rollback được»). **Cảnh giác revision của phiên cũ:** revision do `deploy.sh` đăng ký ở các phiên trước vẫn `ACTIVE` sau `terraform destroy`, nhưng trỏ RDS, Valkey và secret của phiên đã xóa (đã thấy ở diễn tập 2026-11-15: `dbs-api:16` và `dbs-api:10` cùng `ACTIVE`).
3. **Xem bản lỗi đã migrate chưa.** `deploy.sh` chạy `migrate.sh` **trước** `update-service`, nên một deploy lỗi có thể đã đổi schema. Đọc log task migration của lần deploy đó (luồng `migrate/migrate/<task-id>` trong `/dbs/dev/api`, task id ở log của workflow `Deploy`):
   ```bash
   MSYS_NO_PATHCONV=1 aws logs filter-log-events --log-group-name /dbs/dev/api --log-stream-name-prefix migrate/migrate/ \
     --start-time $((($(date -u +%s) - 3600) * 1000)) --filter-pattern '"has been executed successfully"' --query 'events[].message' --output text
   ```
   Rollback chỉ đổi image, **không** hoàn tác migration. Migration kiểu *expand* (thêm bảng, thêm cột nullable) thì rollback an toàn; kiểu *contract* (xóa hay đổi tên cột, thêm ràng buộc mà bản cũ không thỏa) thì **không** rollback, mà sửa tiến (roll-forward). Không chắc thì hỏi Dev chủ migration trước khi làm.
4. Lưu ý Terraform: `ignore_changes = [task_definition]` ở `ecs.tf` và `worker.tf`, nên rollback tay không bị `terraform apply` ghi đè, nhưng lần `apply` sau cũng không tự khôi phục trạng thái.

## Rollback

**Chọn revision đích:** dùng đúng revision đã chạy **ngay trước** lần deploy lỗi (đọc ở deployment `ACTIVE` hay `COMPLETED` cũ trong `describe-services`, hoặc log workflow `Deploy`). Nếu phải chọn từ danh sách `ACTIVE`, kiểm nó thuộc phiên hiện tại: `DB_HOST`, `REDIS_HOST` và ARN secret phải giống revision đang chạy ở phiên này (`aws ecs describe-task-definition --task-definition dbs-api:<rev> --query 'taskDefinition.containerDefinitions[0].[environment,secrets]'`). Hai family đánh số riêng nên số revision của `api` và `worker` thường khác nhau.

```bash
t0=$(date -u +%s)
aws ecs update-service --cluster dbs-dev --service api    --task-definition dbs-api:<rev>    --force-new-deployment
aws ecs update-service --cluster dbs-dev --service worker --task-definition dbs-worker:<rev> --force-new-deployment
```

Theo dõi tới khi cả hai service có deployment `PRIMARY` đạt `rolloutState = COMPLETED`, đúng `taskDefinition` vừa chọn và `runningCount = desiredCount`:

```bash
aws ecs describe-services --cluster dbs-dev --services api worker --query 'services[*].{name:serviceName,taskDefinition:taskDefinition,running:runningCount,desired:desiredCount,deployments:deployments[*].{status:status,rolloutState:rolloutState}}'
```

> **Lưu ý:** api chạy 1 task với `minimumHealthyPercent = 0`, nên từ lúc deploy lỗi tới lúc task cũ lên lại là không có đích khỏe sau ALB (khách thấy `503`; ghi chú BL-234 ở `envs/dev/session/ecs.tf`). Worker lăn `0% / 100%`, nên có khoảng trống xử lý ngắn khi thay task; sự kiện vẫn nằm an toàn trong `outbox_events` (ADR-03) và được xử lý bù sau khi worker khỏe. Worker là service chậm nhất khi rollback (xem số đo cuối trang).

## Sau mọi lần rollback (bắt buộc, kể cả khi circuit breaker tự rollback)

1. **Hủy đăng ký revision lỗi của cả hai family**, để `deploy.sh` không dựng lần deploy kế tiếp từ chúng:
   ```bash
   aws ecs deregister-task-definition --task-definition dbs-api:<rev-lỗi>
   aws ecs deregister-task-definition --task-definition dbs-worker:<rev-lỗi>
   ```
2. Giữ workflow `Deploy` tắt cho tới khi bản sửa đã merge, rồi `gh workflow enable Deploy`.

## Kiểm sau rollback

1. `GET /health/live` và `GET /health/ready` qua ALB trả `200` (`redis: up`; chứng chỉ ALB dev tự ký nên `curl -k`).
2. Luồng log **của task mới** (không phải cả nhóm log, vì task của bản lỗi có thể còn ghi lỗi sau `t0`) không có `Application startup failed`, worker có dòng `Worker started`:
   ```bash
   tid=$(aws ecs list-tasks --cluster dbs-dev --service-name worker --desired-status RUNNING --query 'taskArns[0]' --output text); tid=${tid##*/}
   MSYS_NO_PATHCONV=1 aws logs filter-log-events --log-group-name /dbs/dev/worker --log-stream-names "worker/worker/$tid" \
     --start-time $((t0*1000)) --filter-pattern '"Worker started"' --query 'length(events)' --output text | awk '{n += $1} END {print n + 0}'
   ```
   (`MSYS_NO_PATHCONV=1` chỉ cần khi chạy từ Git Bash trên Windows. `filter-log-events` trả theo trang nên phải cộng số của từng trang.)
3. Hàng đợi SQS (`dbs-dev-risk-events`, `dbs-dev-notification-events`) và DLQ tương ứng (`…-dlq`) không tồn đọng bất thường (`get-queue-attributes`, ba thuộc tính `ApproximateNumberOf*`).
4. (Khi có thể) chạy `invariants.js` bằng task `dbs-migrate` một lần (như Phase F của [`drill.sh`](../deliverables/P3-rollback-drill/drill.sh)): thoát 0 là sổ cái cân.

## Giao dịch mẫu

Chạy một giao dịch mẫu sau rollback để xác nhận luồng tiền bình thường. Dùng một cặp tài khoản của khách demo, token qua biến môi trường (không in, không dán vào ticket):
1. `GET /v1/accounts` thấy số dư trước sự cố còn nguyên vẹn (số dư đã ghi **trước** khi deploy lỗi).
2. Replay đúng lệnh chuyển tiền đã gửi trước sự cố, **cùng `Idempotency-Key` và cùng body** → `201` với đúng `transferId` cũ, số dư **cả hai** tài khoản không đổi thêm.
3. Nạp tiền mới (`POST /v1/operator/deposits`) và chuyển tiền mới (`POST /v1/transfers`, khóa mới) → `201 COMPLETED`, số dư hai tài khoản khớp từng đồng.

Các bước 1–3 được tự động hóa trong Phase A và D của [`drill.sh`](../deliverables/P3-rollback-drill/drill.sh) (xem phần dùng và yêu cầu Linux trong header của nó).

## Khi không rollback được

- **Revision cũ đã `INACTIVE`:** AWS từ chối `update-service` về revision `INACTIVE` (đã thử thật, Phase E của `drill.sh`: `TaskDefinition is inactive`). `describe-task-definition` vẫn đọc được revision `INACTIVE`, nên đăng ký lại **nguyên** revision cũ: đưa đúng revision đó (không phải tên family) vào `render-task-definition.py` qua stdin, với `--image` là image của chính revision đó (script giữ allowlist khóa và `tags`, bỏ trường chỉ-đọc). Đừng chạy `deploy.sh` hay `describe-task-definition --task-definition dbs-api` (tên family): cách đó lấy revision `ACTIVE` mới nhất, tức bản lỗi.
  ```bash
  IMG=$(aws ecs describe-task-definition --task-definition dbs-api:<rev-cũ-INACTIVE> --query 'taskDefinition.containerDefinitions[?name==`api`].image|[0]' --output text)
  aws ecs describe-task-definition --task-definition dbs-api:<rev-cũ-INACTIVE> --include TAGS \
    | python3 .github/scripts/render-task-definition.py --image "$IMG" > td.json          # worker: thêm --container worker
  aws ecs register-task-definition --cli-input-json file://td.json
  ```
  rồi `update-service` tới revision vừa đăng ký. Chỉ dùng khi revision cũ thuộc phiên hiện tại (cùng `DB_HOST`, `REDIS_HOST`, ARN secret). Đường này **chưa diễn tập** ([BL-394](../BACKLOG.md)).
- **Chính lần rollback hỏng** (deployment kẹt `IN_PROGRESS` quá 10 phút, hoặc circuit breaker kêu trong lúc rollback): cô lập service bằng cách hạ về 0 task trong lúc khắc phục. **Hậu quả:** api về 0 là **mất phục vụ hoàn toàn** (ALB trả `503`); worker về 0 thì sự kiện dồn trong `outbox_events` và được gửi bù khi bật lại (ADR-03).
  ```bash
  aws ecs update-service --cluster dbs-dev --service api --desired-count 0
  aws ecs update-service --cluster dbs-dev --service worker --desired-count 0
  ```
  Báo ngay trong kênh chat của nhóm, gọi techlead và Dev chủ module gây lỗi; bật lại bằng `--desired-count 1` sau khi có revision chạy được.
- **Image lỗi cả ở revision cũ, hoặc DB đã contract:** sửa tiến (roll-forward) qua PR, deploy lại.

## Số đo

- **Ngưỡng đạt (DoD của DBS-156):** tổng thời gian từ lệnh `update-service` đầu tiên của rollback tới khi cả `api` và `worker` ổn định (`COMPLETED`, `runningCount = desiredCount`) và `/health/ready` trả `200` phải **≤ 600 giây (10 phút)**. docs/03 §13.3 trỏ về số này.
- **Kết quả diễn tập** (cluster `dbs-dev`, api 1 task, worker 1 task, cùng image với bản tốt, bản lỗi chỉ khác `DB_HOST`):

| Lần | Ngày | Bản lỗi hỏng thật trước rollback | `/health/ready` 200 | api `COMPLETED` | worker `COMPLETED` | **Tổng** | Giao dịch mẫu |
|---|---|---|---|---|---|---|---|
| 1 | 2026-11-14 | không kiểm | +78 s | +108 s | +299 s | **301 s** | không có |
| 2 | 2026-11-15 | không (rollback lúc +47 s, chưa task lỗi dừng) | +86 s | +118 s | +305 s | **305 s** | đạt |
| 3 | 2026-11-15 | **có** (mỗi service một task `exited 1`) | +127 s | +184 s | +267 s | **267 s** | đạt hết |

  Cả ba lần đều dưới 600 s; worker là service chậm nhất. Lần 3 là bằng chứng chính: chờ tới khi task của bản lỗi dừng thật (khoảng 200 s sau deploy lỗi) rồi mới rollback, nên tổng thời gian khách thấy `503` là khoảng 290 s.

- Chi tiết, cách đo và bằng chứng: [DBS-156](../features/DBS-156-rollback-drill.md) §8 và [`timings.md`](../deliverables/P3-rollback-drill/timings.md).
- Chưa làm: rollback qua workflow `Deploy` thật qua OIDC ([BL-104](../BACKLOG.md)), video màn hình thật ([BL-393](../BACKLOG.md)), đường «đăng ký lại revision `INACTIVE`» ([BL-394](../BACKLOG.md)).
