# Runbook · Đọc và redrive DLQ (`risk-events-dlq`, `notification-events-dlq`)

> **Status:** Active (chạy thật trên ElasticMQ local ở [DBS-125](../features/DBS-125-dlq-isolation-runbook.md); chưa chạy trên AWS, BL-161) · **Owner:** Platform & Ops · **Cập nhật:** 2026-11-10

## Khi nào dùng

- **Alarm DLQ** báo có message, hoặc thấy `ApproximateNumberOfMessages` của một DLQ lớn hơn 0. Trên AWS alarm là `dbs-dev-risk-dlq-not-empty` hoặc `dbs-dev-notification-dlq-not-empty` (`ApproximateNumberOfMessagesVisible` > 0 trong 1 phút, `infra/terraform/envs/dev/base/alarms.tf`), thư gửi tới topic SNS `dbs-dev-alarms`; alarm giữ ở ALARM tới khi DLQ cạn. Alarm `dbs-dev-risk-rule-error` (lỗi luật, kèm `Rule`) và `dbs-dev-risk-config-invalid` báo sớm hơn, trước khi message tới DLQ ([observability](../components/observability/01-concept-brief.md#alarm-cloudwatch-bl-051-bl-117-bl-127-bl-179-bl-182)). Alarm mới ở Terraform, **chưa kích hoạt thử trên AWS** (BL-051).
- **Một message vào DLQ vì một trong hai lý do:**
  - **Hỏng:** không phải JSON, sai schema, hoặc là loại sự kiện mà consumer không biết. Message này vào DLQ ngay lần nhận đầu.
  - **Lỗi 5 lần liền** (`MAX_ATTEMPTS` của `ConsumerBase`). Ở production, các lần thử cách nhau 5, 10, 20, 40 s, nên message vào DLQ khoảng 75–80 s sau lần nhận đầu.
- **Cả hai trường hợp đều chưa ghi gì.** Lỗi thì rollback, message hỏng thì không được claim. Vì vậy message trong DLQ **không có** dòng `processed_events`.

Chỉ redrive **sau khi đã sửa nguyên nhân**: deploy bản sửa, gỡ cấu hình hỏng, hoặc chờ DB hay Redis hồi phục. Redrive khi nguyên nhân còn đó chỉ làm message vào lại DLQ.

## Quyền

**Ops** (không phải task `worker`; DBS-73 từ chối worker đọc hoặc xóa DLQ) cần các quyền sau. Từ BL-241, queue policy còn `Deny` các thao tác message cho principal ngoài danh sách cho phép (role `dbs-dev-worker-task` và `sqs_ops_principal_arns`, mặc định mọi IAM user của tài khoản): người redrive phải nằm trong danh sách đó, nếu không sẽ gặp `explicit deny in a resource-based policy` dù identity policy đủ quyền (`infra/terraform/README.md`, mục SQS).
- **Trên DLQ:** `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, `sqs:GetQueueAttributes`, `sqs:StartMessageMoveTask`, `sqs:ListMessageMoveTasks`, `sqs:CancelMessageMoveTask`.
- **Trên queue chính:** `sqs:SendMessage`, `sqs:GetQueueAttributes`.

## Biến dùng trong các lệnh

```bash
# Local: ElasticMQ (docker compose: http://localhost:9324; Demo 3: http://localhost:9334)
export AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_DEFAULT_REGION=us-east-1
SQS="aws --endpoint-url http://localhost:9324 sqs"
# AWS: SQS="aws sqs" với profile Ops; URL thật lấy bằng `$SQS get-queue-url --queue-name <tên>`
MAIN=http://localhost:9324/000000000000/notification-events      # hoặc risk-events
DLQ=http://localhost:9324/000000000000/notification-events-dlq    # hoặc risk-events-dlq
```

## 1. Đếm

```bash
$SQS get-queue-attributes --queue-url "$DLQ" --attribute-names \
  ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed
```

Queue được coi là "cạn" khi cả ba thuộc tính bằng 0. Không dùng `test/manual/queue-census.ts` để đếm: script đó chỉ thấy message đang hiện, và làm message bị ẩn 30 s.

## 2. Xem (chỉ nhìn, không lấy mất message)

```bash
$SQS receive-message --queue-url "$DLQ" --max-number-of-messages 10 --wait-time-seconds 5 \
  --visibility-timeout 0 --attribute-names All --message-attribute-names All
```

- Mỗi body là một sự kiện. `eventId`, `eventType` và `correlationId` dùng để tra log và `audit_log`.
- **Chỉ xem DLQ, không xem queue chính.** Mỗi lần nhận đều tăng `ApproximateReceiveCount`, mà queue chính chuyển message sang DLQ khi số này đủ 5.
- **Đừng xóa bằng handle của lần xem này.** Mỗi lần nhận sau đó cấp handle mới, và handle cũ không dùng được nữa. Lệnh xem với visibility 0 cũng chỉ thấy lại tối đa 10 message đầu, nên không dùng để quét cả DLQ.

## 3. Quét để tách message hỏng (bắt buộc trước khi redrive)

Redrive chuyển **mọi** message trong DLQ, không lọc được. Một message hỏng bị redrive sẽ vào lại DLQ ngay, và như vậy phạm quy tắc "mỗi message chỉ redrive một lần". Vì vậy phải quét hết DLQ:

1. Nhận tối đa 10 message mỗi lần, ẩn 1800 s, đủ lâu cho cả lượt quét:
   ```bash
   $SQS receive-message --queue-url "$DLQ" --max-number-of-messages 10 --wait-time-seconds 5 \
     --visibility-timeout 1800 --attribute-names All --query 'Messages[].[MessageId,ReceiptHandle,Body]' --output text >> dlq-scan.tsv
   ```
   Nếu một `MessageId` xuất hiện lại, chỉ giữ handle **mới nhất** của nó.
2. Message hỏng (không phải JSON, hoặc thiếu `eventId`/`eventType`):
   - lưu body ra file để điều tra;
   - xóa bằng **chính** handle đó: `$SQS delete-message --queue-url "$DLQ" --receipt-handle <handle>`.
3. Message hợp lệ: **giữ ẩn**, không đổi visibility trong lúc quét. Nếu đổi về 0 ngay, message đó quay lên đầu hàng và vòng quét không bao giờ dừng.
4. Lặp bước 1–3 cho tới khi một lần nhận trả về rỗng **và** `ApproximateNumberOfMessages` = 0. Lúc đó message hợp lệ nằm trong `…NotVisible`.
5. **Trả message hợp lệ về**, với handle mới nhất của từng message:
   ```bash
   $SQS change-message-visibility --queue-url "$DLQ" --receipt-handle <handle> --visibility-timeout 0
   ```
   Bước này **bắt buộc**, không thay bằng việc chờ hết 1800 s. Trên ElasticMQ, `delete-message` chỉ đánh dấu xóa; chính lệnh đổi visibility về 0 mới dựng lại hàng đợi và loại hẳn message đã xóa trước khi redrive. Nếu không còn message hợp lệ nào thì **dừng ở đây, không redrive**.

## 4. Redrive

```bash
SRC_ARN=$($SQS get-queue-attributes --queue-url "$DLQ" --attribute-names QueueArn --query Attributes.QueueArn --output text)
DST_ARN=$($SQS get-queue-attributes --queue-url "$MAIN" --attribute-names QueueArn --query Attributes.QueueArn --output text)
$SQS start-message-move-task --source-arn "$SRC_ARN" --destination-arn "$DST_ARN"
```

- **Luôn ghi `--destination-arn`.** Message trong DLQ do `ConsumerBase` **gửi** sang (`SendMessage`), không phải do SQS chuyển. Vì vậy AWS không biết "queue gốc" của chúng.
- **Lấy ARN bằng `get-queue-attributes`**, không tự ghép.
- **Theo dõi:**
  - Trên AWS: `$SQS list-message-move-tasks --source-arn "$SRC_ARN"`, đợi `COMPLETED`. Hủy bằng `cancel-message-move-task --task-handle <handle>`.
  - **Ở local thì không dùng `list-message-move-tasks`:** lệnh này làm ElasticMQ sập (`scala.MatchError`, image `softwaremill/elasticmq-native@sha256:e4580ab9…`, thử ngày 2026-11-10; image này nay được ghim, xem "Nâng image ElasticMQ"). Thay bằng cách đếm DLQ (bước 1) cho tới khi về 0.

## 5. Kiểm sau redrive (quy tắc 24 giờ)

- **Queue chính về 0 trong 24 giờ** kể từ lúc bắt đầu redrive: `ApproximateNumberOfMessages` + `…NotVisible` = 0. Không đạt thì dừng (`cancel-message-move-task`) và xử lý tay.
- **Mỗi sự kiện (theo `eventId`) chỉ redrive một lần.** Ghi lại các `eventId` đã redrive. Nếu một `eventId` quay lại DLQ thì xử lý tay, không redrive lần hai. ElasticMQ giữ nguyên `MessageId` khi chuyển, còn AWS cấp `MessageId` mới, nên đối chiếu theo `eventId`.
- **Không redrive lại một DLQ** khi lần trước chưa đủ 6 ngày (thời gian DLQ giữ message, DBS-73).
- **Vì sao an toàn với dedup 7 ngày:** message trong DLQ chưa từng commit `processed_events` (xem "Khi nào dùng"), nên redrive không thể làm một hiệu ứng chạy hai lần. Ngược lại, nếu một message đã commit mà vẫn quay lại (xóa thất bại), dòng `processed_events` còn trong 7 ngày sẽ chặn nó.
- Kiểm hiệu ứng theo `eventId`:
  - notification: `SELECT count(*) FROM notification_log WHERE event_id = '<eventId>'` (một TRANSFER khác chủ có 2 dòng);
  - risk: `SELECT * FROM risk_decisions WHERE event_id = '<eventId>'`.

## Nâng image ElasticMQ

Local stack ghim ElasticMQ theo digest `sha256:e4580ab9ad1bd5cd37b4ba04911bc5ccc8cd2d9ab4de56ece65acee71c24e05c` (BL-225; image ngày 2026-04-05, bản DBS-125 đã thử). Ba nơi dùng cùng một giá trị: hằng số `ELASTICMQ_IMAGE` trong `backend/test/support/elasticmq.container.ts` (mọi suite `test:services` và CI), `docker-compose.yml`, và lệnh `docker run` của [Demo 3](../demos/demo-3-failure-recovery.md). Hành vi runbook này dựa vào (redrive bằng `start-message-move-task`, message đã xóa bị loại khi đổi visibility về 0, `list-message-move-tasks` làm ElasticMQ sập) chưa được thử trên bản nào khác; ElasticMQ 2.0 (2026-11) đổi giới hạn và retention.

Nâng bản (đổi digest) chỉ khi cần, theo thứ tự:

1. Lấy digest mới của tag muốn thử (`docker buildx imagetools inspect softwaremill/elasticmq-native:<tag>`), chạy thử bằng `docker run` riêng như Demo 3.
2. Từ `backend/`, với `DATABASE_URL` trỏ một PostgreSQL: `npm run test:services -- --runInBand --runTestsByPath test/services/dlq-isolation.services-spec.ts` và `…/worker-recovery.services-spec.ts`.
3. Chạy lại runbook này (mục 1 đến 5) trên bản mới, kể cả kiểm `list-message-move-tasks` có còn làm ElasticMQ sập không; ghi khác biệt vào runbook.
4. Đổi digest ở cả ba nơi trong cùng một PR (test `TC-BL225-01` trong `elasticmq.container.spec.ts` kiểm `docker-compose.yml` và tài liệu khớp hằng số), cập nhật đoạn này.

## Lần chạy thật

[DBS-125 §8](../features/DBS-125-dlq-isolation-runbook.md#8-kết-quả) (ElasticMQ local, hai process thật). Kịch bản demo: [Demo 3 phần C](../demos/demo-3-failure-recovery.md#c-consumer-lỗi--dlq-dbs-125).
