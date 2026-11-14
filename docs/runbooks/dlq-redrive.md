# Runbook · Đọc và redrive DLQ (`risk-events-dlq`, `notification-events-dlq`)

> **Status:** Active (chạy thật trên ElasticMQ local ở [DBS-125](../features/DBS-125-dlq-isolation-runbook.md) và trên SQS dev ở [DBS-164](../features/DBS-164-dlq-runbook-dev-trial.md), xem "Lần chạy thật") · **Owner:** Platform & Ops · **Cập nhật:** 2026-11-15 (DBS-164: tóm tắt cho người trực, phân loại nguyên nhân, bỏ qua có ghi nhận)

## Tóm tắt cho người trực

| # | Việc | Dừng khi |
|---|---|---|
| 1 | Alarm `dbs-dev-<risk\|notification>-dlq-not-empty` gửi thư tới topic `dbs-dev-alarms`: xác định DLQ nào | biết tên DLQ |
| 2 | Đếm (mục 1) rồi xem (mục 2) | biết số message và mẫu body |
| 3 | **Phân loại nguyên nhân** (mục 2b): log worker, tuổi, nội dung body | mỗi message có một nhãn |
| 4 | Quét (mục 3): tách hỏng và quá hạn; **bỏ qua có ghi nhận** (mục 3c) mọi message nhãn "bỏ qua" **trước khi redrive** | DLQ chỉ còn message redrive được, hoặc rỗng |
| 5 | Sửa nguyên nhân. **Ngay trước redrive**: đếm lại (mục 1) và chạy lại `dlq:age-check`; có message mới hoặc thoát khác 0 thì quay về bước 3. Kiểm `list-message-move-tasks`: có task **bất kỳ trạng thái** (hoặc `ApproximateNumberOfMessagesMoved` > 0) bắt đầu trong 6 ngày qua thì **không redrive**. Redrive (mục 4); kiểm (mục 5) | queue chính về 0 trong 24 giờ |
| 6 | Ba thuộc tính của DLQ đều 0, alarm về `OK` (khoảng 3 phút sau khi cạn, đo ở DBS-163); ghi nhận nếu có bỏ qua | alarm `OK` |

## Khi nào dùng

- **Alarm DLQ** báo có message, hoặc thấy `ApproximateNumberOfMessages` của một DLQ lớn hơn 0. Trên AWS alarm là `dbs-dev-risk-dlq-not-empty` hoặc `dbs-dev-notification-dlq-not-empty` (`ApproximateNumberOfMessagesVisible` > 0 trong 1 phút, `infra/terraform/envs/dev/base/alarms.tf`), thư gửi tới topic SNS `dbs-dev-alarms`; alarm giữ ở ALARM tới khi DLQ cạn. Alarm `dbs-dev-risk-rule-error` (lỗi luật, kèm `Rule`) và `dbs-dev-risk-config-invalid` báo sớm hơn, trước khi message tới DLQ ([observability](../components/observability/01-concept-brief.md#alarm-cloudwatch-bl-051-bl-117-bl-127-bl-179-bl-181-bl-182)). Cả hai alarm đã kích hoạt thử trên AWS (DBS-163: `ALARM` sau 155 s kể từ lúc message vào DLQ, `OK` sau 178 s kể từ lúc xóa).
- **Alarm chỉ đếm message nhìn thấy** (`ApproximateNumberOfMessagesVisible`, [DBS-163](../features/DBS-163-dlq-age-alarms.md)): khi quét DLQ ở bước 3 (ẩn 1800 s) alarm về `OK` dù message còn trong DLQ, và bật lại khi hết ẩn nếu chưa xử lý. Thư `OK` không có nghĩa là xong; kiểm `ApproximateNumberOfMessages` và `…NotVisible` cùng bằng 0.
- **Một message vào DLQ vì một trong hai lý do:**
  - **Hỏng:** không phải JSON, sai schema, hoặc là loại sự kiện mà consumer không biết. Message này vào DLQ ngay lần nhận đầu.
  - **Lỗi 5 lần liền** (`MAX_ATTEMPTS` của `ConsumerBase`). Ở production, các lần thử cách nhau 10, 20, 40, 80 s (BL-210, ADR-03), nên message vào DLQ khoảng 150 s sau lần nhận đầu: đủ cho một lần failover PostgreSQL 60–120 s, nên chỉ một sự cố dài hơn mới đưa event vào DLQ.
- **Cả hai trường hợp đều chưa ghi gì.** Lỗi thì rollback, message hỏng thì không được claim. Vì vậy message trong DLQ thường **không có** dòng `processed_events` (ngoại lệ hiếm: một bản trùng lỗi ở bước chuẩn bị năm lần trong khi một bản khác của cùng sự kiện đã commit; xem mục 2b).

- **Tuổi của message tính từ lần gửi gốc, không từ lúc vào DLQ (BL-210).** `ConsumerBase` chuyển message sang DLQ bằng `SendMessage`, nên `SentTimestamp` và hạn giữ của DLQ bắt đầu lại lúc chuyển. Để giữ lời hứa «replay không sống quá dòng `processed_events` 7 ngày» ([database-design §10](../components/_shared/database-design.md)), bản sao mang thuộc tính `OriginalSentTimestamp` (epoch ms của lần gửi gốc, giữ nguyên qua các lần chuyển và replay). Message gửi gốc **quá 6 ngày không được replay**: dòng `processed_events` của nó có thể đã bị dọn, và một bản trùng đã áp hiệu ứng sẽ áp lần hai. Mục 3 kiểm điều này.

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
- **Đừng xóa bằng handle của lần xem này.** Mỗi lần nhận sau đó cấp handle mới, và handle cũ không dùng được nữa. Lệnh xem với visibility 0 cũng chỉ thấy lại tối đa 10 message đầu, nên không dùng để quét cả DLQ. Một lần xem có thể trả **cùng một message nhiều lần** (đã thấy trên AWS: 3 message ra 10 dòng): đếm theo `MessageId`, không theo số dòng.

## 2b. Phân loại nguyên nhân

Mỗi message vào DLQ để lại một dòng log mức `error` của worker (số 50 trong JSON, khóa thông điệp là `message`); các lần thử lại là mức `warn` (40). Log group `/dbs/dev/worker`. Lọc theo consumer, giới hạn thời gian và phân trang (`--end-time`, `nextToken`):

```bash
aws logs filter-log-events --log-group-name /dbs/dev/worker --start-time <epoch ms> --end-time <epoch ms> \
  --filter-pattern '{ ($.outcome = "dead_letter") && ($.consumer = "risk") }' --query 'events[].message' --output text
```

Trên Git Bash (Windows) đặt `MSYS_NO_PATHCONV=1` trước lệnh: nếu không, `/dbs/dev/worker` bị đổi thành đường dẫn Windows và AWS báo `InvalidParameterException` (đã gặp ở DBS-164). Lệnh trả `0` khi chưa có dòng nào (worker chưa chạy hoặc không có message lỗi).

Dòng có `consumer` (`risk` hoặc `notification`), `outcome: "dead_letter"`, `reason`, `receiveCount`; `eventId` (khi body hợp lệ) **hoặc** `messageId` và `issueCodes` (khi body không hợp lệ: body không bao giờ được ghi vào log); `errorType` (`Error` hoặc `NonError`) và `code` (SQLSTATE hoặc mã mạng) của lỗi gốc nếu có (hai dòng `invalid_event` và `unknown_event_type` không có hai trường này). **`messageId` trong log là id trên queue chính**: bản sao trong DLQ có `MessageId` mới, nên đối chiếu `invalid_event` với message trong DLQ theo khung giờ, `consumer`, `issueCodes` và nội dung body (mục 2), rồi ghi cả hai id.

| `reason` (hoặc dấu hiệu) | Nghĩa | Việc làm |
|---|---|---|
| `invalid_event` | body là JSON hợp lệ nhưng sai schema (`issueCodes` nói loại lỗi) | không redrive; tìm nơi gửi; **bỏ qua có ghi nhận** (mục 3c) |
| **không có dòng log nào** | body **không phải JSON**: `SqsClient` chuyển thẳng sang DLQ trước khi tới `ConsumerBase`, nên không có dòng log và không có đếm metric (`dead-lettered` chỉ ở kết quả lô) | phân loại theo nội dung body (mục 2); không redrive; **bỏ qua có ghi nhận** (mục 3c) |
| `unknown_event_type` | `issueCodes` có `UNKNOWN_EVENT_TYPE`: consumer chưa biết loại sự kiện (producer mới hơn consumer) | deploy consumer biết loại đó rồi redrive; nếu loại sự kiện bị bỏ hẳn thì bỏ qua có ghi nhận |
| `poison` | handler tự kết luận không xử lý được; `code` là SQLSTATE của lỗi gốc (ví dụ `23503` khóa ngoại) | điều tra dữ liệu của `eventId`; sửa dữ liệu hoặc code rồi redrive; không sửa được thì bỏ qua có ghi nhận |
| `attempts_exhausted` | lỗi 5 lần liền; các dòng `retry` (mức `warn`) cùng `eventId` đứng trước | lỗi tạm (failover PostgreSQL 60–120 s, hết kết nối) hay lỗi code: chờ hạ tầng hồi phục hoặc deploy bản sửa rồi redrive |
| `dlq:age-check` báo **stale** (gửi gốc quá 6 ngày) | quá hạn dedup 7 ngày: redrive có thể áp hiệu ứng lần hai | không redrive; **bỏ qua có ghi nhận** (file quarantine) |
| `processed_events` đã có dòng `(consumer, event_id)` | sự kiện đã áp hiệu ứng (hiếm: bản trùng lỗi ở bước chuẩn bị năm lần trong khi một bản khác đã commit) | xóa message khỏi DLQ, không redrive, ghi nhận. Cần đọc `processed_events` trong RDS của phiên: `SELECT 1 FROM processed_events WHERE consumer = '<risk\|notification>' AND event_id = '<eventId>'`. Ops hiện chưa có đường đọc DB (BL-362), nên bước này làm cùng người có quyền DB |

Không có dòng log (body không phải JSON như trên, log group hết hạn giữ, worker chưa từng chạy, message do tay gửi): phân loại theo nội dung body (mục 2), tuổi (`dlq:age-check`) và, khi có phiên, `processed_events`; ghi "không rõ" vào bản ghi nhận.

## 3. Quét để tách message hỏng và message quá 6 ngày (bắt buộc trước khi redrive)

Redrive chuyển **mọi** message trong DLQ, không lọc được. Một message hỏng bị redrive sẽ vào lại DLQ ngay, và như vậy phạm quy tắc "mỗi message chỉ redrive một lần". Một message gửi gốc quá 6 ngày thì có thể áp hiệu ứng lần hai (xem "Khi nào dùng"). Vì vậy phải quét hết DLQ.

### 3a. Tuổi: `dlq:age-check` (BL-210)

Từ `backend/` (cần credential Ops đọc và xóa trên DLQ; ở local thêm `--endpoint-url`):

```bash
mkdir -p ~/dbs-ops/dlq                                   # ngoài repo; CLI không tự tạo thư mục (thiếu thì thoát 2, không xóa gì)
QF=~/dbs-ops/dlq/stale-<queue>-$(date +%Y%m%dT%H%M%S).jsonl   # tên mới mỗi lần: CLI GHI ĐÈ file cũ
if [ -e "$QF" ]; then echo "đã có $QF, đổi tên"; else
  npm run --silent dlq:age-check -- --queue-url "$DLQ" [--endpoint-url http://localhost:9324] \
    --delete-stale --quarantine-file "$QF"
fi
```

Truyền `--quarantine-file "$QF"` (có dấu cách, biến trong nháy kép): `--quarantine-file=~/…` không được mở rộng `~` trong Git Bash và file rơi vào thư mục hiện tại, tức trong repo.

- Công cụ nhận hết DLQ (ẩn 1800 s như bước quét tay bên dưới), tính tuổi theo `OriginalSentTimestamp`, lấy `SentTimestamp` của queue khi message do SQS tự chuyển và chưa có thuộc tính; message không có thời điểm nào dùng được bị coi là **quá hạn**, không phải mới. Sau đó trả message còn lại về queue (visibility 0).
- In một báo cáo JSON: `checked`, `fresh`, `stale` (mỗi mục chỉ có `messageId`, `eventId` nếu body là UUID, `ageHours`; **không bao giờ in body**), `deleted`, `failed`, `complete`.
- Không có `--delete-stale` thì chỉ báo cáo. Có thì công cụ **ghi các message quá hạn (kèm body) vào `--quarantine-file` rồi mới xóa** khỏi DLQ; lỗi ghi file thì không xóa gì. File chứa dữ liệu sự kiện: giữ ngoài repo như dữ liệu điều tra, không đưa lên repo hay kênh chat (xem mục 3c).
- Mã thoát: `0` không còn message quá hạn trong DLQ (không có, hoặc đã lưu và xóa hết); `1` còn message quá hạn (chạy không `--delete-stale`): **không redrive**; `2` lỗi tham số, lỗi quét, hoặc quét chưa thấy hết queue (`complete: false`) hay có message không trả về/xóa được (`failed`): **không redrive**, chạy lại sau khi xử lý.
- Message đã lưu vào file được điều tra tay (áp lại hiệu ứng nếu cần theo quy trình xử lý lỗi), không redrive.
- Giới hạn mặc định 6 ngày, đổi bằng `--max-age-days`; chỉ hạ, không nâng quá 6 (DLQ giữ 6 ngày, `processed_events` giữ 7 ngày).

### 3b. Tách message hỏng


1. Nhận tối đa 10 message mỗi lần, ẩn 1800 s, đủ lâu cho cả lượt quét. **Đặt tên file một lần** cho cả lượt (mọi lô cùng vào một file; file chứa body và `ReceiptHandle`, nên nằm ngoài repo):
   ```bash
   SCAN=~/dbs-ops/dlq/scan-<queue>-$(date +%Y%m%dT%H%M%S).tsv     # một lần; test -e "$SCAN" phải sai
   $SQS receive-message --queue-url "$DLQ" --max-number-of-messages 10 --wait-time-seconds 5 \
     --visibility-timeout 1800 --attribute-names All --query 'Messages[].[MessageId,ReceiptHandle,Body]' --output text >> "$SCAN"
   ```
   Nếu một `MessageId` xuất hiện lại, chỉ giữ handle **mới nhất** của nó.
2. Message nhãn **bỏ qua** theo mục 2b (không phải JSON, sai schema, loại sự kiện lạ không còn cần, `poison` không sửa được, đã xử lý):
   - lưu body vào `$SKIP` (mục 3c) để điều tra;
   - xóa bằng handle **mới nhất** của message đó: `$SQS delete-message --queue-url "$DLQ" --receipt-handle <handle>`.
3. Message hợp lệ: **giữ ẩn**, không đổi visibility trong lúc quét. Nếu đổi về 0 ngay, message đó quay lên đầu hàng và vòng quét không bao giờ dừng.
4. Lặp bước 1–3 cho tới khi một lần nhận trả về rỗng **và** `ApproximateNumberOfMessages` = 0. Lúc đó message hợp lệ nằm trong `…NotVisible`.
5. **Trả message hợp lệ về**, với handle mới nhất của từng message:
   ```bash
   $SQS change-message-visibility --queue-url "$DLQ" --receipt-handle <handle> --visibility-timeout 0
   ```
   Bước này **bắt buộc**, không thay bằng việc chờ hết 1800 s. Trên ElasticMQ, `delete-message` chỉ đánh dấu xóa; chính lệnh đổi visibility về 0 mới dựng lại hàng đợi và loại hẳn message đã xóa trước khi redrive. Nếu không còn message hợp lệ nào thì **dừng ở đây, không redrive**.

### 3c. Bỏ qua có ghi nhận (làm trong lúc quét, trước redrive)

Redrive chuyển **mọi** message của DLQ, nên mọi message nhãn "bỏ qua" phải rời DLQ trước: nếu không nó vào lại DLQ và phạm quy tắc "mỗi `eventId` một lần".

- **Khi nào được bỏ qua:** (1) `invalid_event`, hoặc `unknown_event_type` không còn cần xử lý; (2) `poison` mà dữ liệu không sửa được; (3) quá 6 ngày; (4) sự kiện đã xử lý (`processed_events`). **Không** bỏ qua khi chưa biết nguyên nhân hoặc khi DLQ vẫn đang tăng (lỗi còn xảy ra: sửa nguồn trước), và không bỏ qua chỉ để tắt alarm.
- **Cách làm:** quá hạn: `dlq:age-check --delete-stale --quarantine-file "$QF"` (mục 3a, lưu body rồi mới xóa). Các loại còn lại: ở bước 2 của mục 3b, ghi body vào `SKIP=~/dbs-ops/dlq/skip-<queue>-$(date +%Y%m%dT%H%M%S).jsonl` (đặt một lần, kiểm `test -e` như `QF`) rồi xóa bằng handle mới nhất.
- **File ở ngoài repo, tên không trùng.** `~/dbs-ops/dlq/` (đường dẫn tuyệt đối): file nằm trong cây repo (ví dụ chạy từ `backend/` với đường dẫn tương đối) chưa được `.gitignore`, một lệnh `git add -A` đưa body lên repo công khai (BL-361). Tên theo queue và giờ; CLI ghi đè file cũ nên body của message đã xóa khỏi SQS mất vĩnh viễn nếu dùng lại tên (BL-360). File ở nơi chỉ nhóm vận hành mở được, giữ đủ lâu để điều tra, rồi xóa; không dán vào chat hay issue.
- **Ghi vào đâu:** một **GitHub issue** trong repo, tiêu đề `DLQ bỏ qua <YYYY-MM-DD> <queue>` (`audit_log` chỉ do api và worker ghi, Ops không có quyền; BACKLOG dành cho việc còn tồn của task, không phải nhật ký vận hành). Nội dung: tên DLQ; số message; `eventId` (hoặc `messageId` của queue chính và của DLQ nếu `invalid_event`); nhãn `reason` ở mục 2b; **GitHub handle** của người quyết định và giờ; cách xử lý (quarantine hay xóa) và **tên file** (không dán đường dẫn có tên người dùng máy); báo cáo JSON của `dlq:age-check` (không có body); việc sửa nguyên nhân (liên kết issue hoặc `BL-NNN`). **Không** dán body, `ReceiptHandle`, nội dung file quarantine, token hay dữ liệu khách (repo công khai).
- Bỏ qua xong thì tiếp tục bước 6 của bản tóm tắt: ba thuộc tính của DLQ đều 0.

## 4. Redrive

**Trước khi chạy lệnh** (cả hai bắt buộc):

1. Đếm lại (mục 1) và chạy lại `dlq:age-check` (chỉ báo cáo): từ lúc quét tới giờ có thể đã qua nhiều giờ (sửa nguyên nhân, chờ hạ tầng), message mới chưa được phân loại, và redrive chuyển mọi message. Có message mới, hoặc thoát khác 0: quay về bước 3 của bản tóm tắt.
2. (đặt `SRC_ARN` bằng lệnh đầu của khối bên dưới trước) `$SQS list-message-move-tasks --source-arn "$SRC_ARN" --query 'Results[].[Status,StartedTimestamp,ApproximateNumberOfMessagesMoved]' --output text` (chưa có task nào thì in rỗng: không có trường `Results`, nên `--query 'length(Results)'` báo lỗi): có task **bất kỳ trạng thái** (kể cả `CANCELLED`, `FAILED`, `RUNNING`) bắt đầu trong 6 ngày qua, hoặc `ApproximateNumberOfMessagesMoved` > 0: **không redrive**, xử lý tay (message đã chuyển có thể quay lại DLQ và sống quá mốc 7 ngày của `processed_events`). Ở local không chạy lệnh này (xem dưới).

```bash
SRC_ARN=$($SQS get-queue-attributes --queue-url "$DLQ" --attribute-names QueueArn --query Attributes.QueueArn --output text)
DST_ARN=$($SQS get-queue-attributes --queue-url "$MAIN" --attribute-names QueueArn --query Attributes.QueueArn --output text)
$SQS start-message-move-task --source-arn "$SRC_ARN" --destination-arn "$DST_ARN"
# Đã chạy thật trên AWS 2026-11-14 (BL-051): `dlq:age-check` báo 1 fresh, move task COMPLETED (1 message), worker nhận lại
# và bỏ qua vì eventId đã xử lý; DLQ và queue chính về 0. Thiếu --destination-arn thì message không do SQS tự chuyển
# sang DLQ (ví dụ gửi tay) làm move task FAILED với `CouldNotDetermineMessageSource`: luôn ghi rõ đích.
```

- **Luôn ghi `--destination-arn`.** Message trong DLQ do `ConsumerBase` **gửi** sang (`SendMessage`), không phải do SQS chuyển. Vì vậy AWS không biết "queue gốc" của chúng.
- **Lấy ARN bằng `get-queue-attributes`**, không tự ghép.
- **Theo dõi:**
  - Trên AWS: `$SQS list-message-move-tasks --source-arn "$SRC_ARN"`, đợi `COMPLETED`. Hủy bằng `cancel-message-move-task --task-handle <handle>`.
  - **Ở local thì không dùng `list-message-move-tasks`:** lệnh này làm ElasticMQ sập (`scala.MatchError`, image `softwaremill/elasticmq-native@sha256:e4580ab9…`, thử ngày 2026-11-10; image này nay được ghim, xem "Nâng image ElasticMQ"). Thay bằng cách đếm DLQ (bước 1) cho tới khi về 0.

## 5. Kiểm sau redrive (quy tắc 24 giờ)

- **Queue chính về 0 trong 24 giờ** kể từ lúc bắt đầu redrive: `ApproximateNumberOfMessages` + `…NotVisible` = 0. Không đạt thì dừng (`cancel-message-move-task`) và xử lý tay.
- **Mỗi sự kiện (theo `eventId`) chỉ redrive một lần.** Ghi lại các `eventId` đã redrive. Nếu một `eventId` quay lại DLQ thì xử lý tay, không redrive lần hai. ElasticMQ giữ nguyên `MessageId` khi chuyển, còn AWS cấp `MessageId` mới, nên đối chiếu theo `eventId`.
- **Không redrive lại một DLQ** khi lần trước chưa đủ 6 ngày (thời gian DLQ giữ message, DBS-73); "lần trước" là task bất kỳ trạng thái hoặc đã chuyển ít nhất một message (xem mục 4).
- **Vì sao an toàn với dedup 7 ngày:** message trong DLQ thường chưa từng commit `processed_events` (xem "Khi nào dùng"), nên redrive không làm một hiệu ứng chạy hai lần. Trường hợp ngoại lệ (một bản khác của sự kiện đã commit) vẫn an toàn trong 7 ngày: dòng `processed_events` đã có chặn bản trùng (`INSERT … ON CONFLICT DO NOTHING` trong `consumer-base.ts`). Vì vậy giới hạn 6 ngày ở mục 3a và quy tắc "một lần" ở trên là bắt buộc.
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

- **AWS dev, SQS thật, ngày 2026-11-15 ([DBS-164](../features/DBS-164-dlq-runbook-dev-trial.md), [output thô](../features/screenshots/DBS-164/manual-test.txt)):** chạy trọn mục tóm tắt trên `dbs-dev-notification-events-dlq` với ba message tổng hợp (hợp lệ, không phải JSON, loại sự kiện lạ): alarm `ALARM` sau 139 s; `dlq:age-check` báo 3 `fresh`; quét tách hai message "bỏ qua" ra file ngoài repo rồi xóa theo handle; redrive bằng `start-message-move-task` `COMPLETED` (1 message); dọn queue chính theo `eventId`; nhánh quá hạn mô phỏng (`--max-age-days 0.0007`) báo `stale` 1, `deleted` 1 và file quarantine có body; cuối cùng bốn queue 0 và hai alarm `OK`. **Chưa kiểm:** dòng log của worker (không có worker), `processed_events` (không có phiên RDS), danh sách quyền tối thiểu của mục "Quyền" (chạy bằng IAM user nhóm `dbs-admin`, BL-363).
- **Hệ quả của lần chạy:** DLQ notification được redrive thật ngày 2026-11-15 nên **không redrive lại trước 2026-11-21**; DLQ risk đã redrive ngày 2026-11-14 nên **không trước 2026-11-20**. Sự cố thật trên hai DLQ này trong khoảng đó xử lý tay (xem, quét, bỏ qua có ghi nhận, và xử lý message hợp lệ ngoài `start-message-move-task`, ví dụ gửi lại bằng `send-message` sau khi sửa nguyên nhân và ghi `eventId`).
- [DBS-125 §8](../features/DBS-125-dlq-isolation-runbook.md#8-kết-quả) (ElasticMQ local, hai process thật). Kịch bản demo: [Demo 3 phần C](../demos/demo-3-failure-recovery.md#c-consumer-lỗi--dlq-dbs-125).
