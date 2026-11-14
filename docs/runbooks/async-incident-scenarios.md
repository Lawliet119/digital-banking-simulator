# Kịch bản sự cố phần bất đồng bộ (chạy lặp lại được)

> **Status:** Active cho phần local (đã chạy 2026-11-15); **phần cloud chưa chạy** (chờ DBS-184) · **Owner:** Dev · **Nguồn:** [DBS-183](../features/DBS-183-async-incident-scenarios.md) · **Cập nhật:** 2026-11-15

Bốn sự cố của phần bất đồng bộ (outbox, SQS, worker, consumer), mỗi sự cố có lệnh chạy **local** lặp lại được (test dịch vụ có sẵn), lệnh **cloud** cho DBS-184, kết quả mong đợi (kèm số đo đã có) và cách xác nhận. Bản chạy tay từng bước nằm ở [Demo 3](../demos/demo-3-failure-recovery.md); xử lý DLQ sau sự cố theo [runbook DLQ](dlq-redrive.md).

| Kịch bản | Nội dung | Local | Cloud |
|---|---|---|---|
| (a) | consumer lỗi liên tục → DLQ sau 5 lần + alarm | đã chạy (không có alarm) | chưa chạy |
| (b) | message hỏng → DLQ ngay | đã chạy | chưa chạy |
| (c) | notification chết → risk vẫn chạy, chuyển tiền không ảnh hưởng | đã chạy | chưa chạy |
| (d) | worker tắt rồi bật → outbox gửi bù | đã chạy | chưa chạy |

## Chạy local (chung)

Từ `backend/`. Cần Docker (Testcontainers tự dựng ElasticMQ và Valkey), Node 24 trên `PATH` (`engines.node` là `>=24`), `npm ci` đã chạy, và một PostgreSQL 17 làm máy chủ. Mỗi test tạo database tạm riêng (`dbs_test_<12 hex>`) rồi xóa, nên lặp bao nhiêu lần cũng cho cùng kết quả:

```bash
docker run -d --rm --name dbs183-pg -p 55433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test postgres:17 -c timezone=UTC
export DATABASE_URL=postgres://test:test@localhost:55433/postgres
npm run test:services -- --runInBand --runTestsByPath test/services/dlq-isolation.services-spec.ts --verbose
```

Cổng 5432 bị PostgreSQL khác chiếm thì dùng cổng khác như trên. Không có `DATABASE_URL`, `test:services` đỏ với "DATABASE_URL is not set". Xong thì `docker stop dbs183-pg`.

| Kịch bản | Spec (test) | Điều test chứng minh, và điều không chứng minh |
|---|---|---|
| (a) | `dlq-isolation.services-spec.ts` TC-125-01 | notification lỗi mọi lần: message vào DLQ sau đúng 5 lần nhận; risk vẫn xử lý. **Không có alarm ở local** (CloudWatch): chỉ chạy trên cloud |
| (b) | `dlq-isolation.services-spec.ts` TC-125-02; `consumer-poison.services-spec.ts` TC-010-01 (loại sự kiện lạ), TC-010-02 (sai schema), TC-010-03 (không phải JSON) | mỗi loại hỏng vào DLQ ở lần nhận đầu; consumer khác không bị chặn |
| (c) | `dlq-isolation.services-spec.ts` TC-125-01 và TC-125-03 | cờ rủi ro vẫn tạo khi notification lỗi; bất biến sổ cái PASS (`afterEach` của spec; giao dịch đã commit trước khi consumer chạy); sau khi sửa, redrive đưa message về xử lý đúng một lần (TC-125-03). Spec không tự kiểm số dư hay trạng thái giao dịch ngoài bất biến |
| (d) | `worker-recovery.services-spec.ts` TC-124-01, TC-124-02 | worker dừng: chuyển tiền vẫn 201, sự kiện chờ trong outbox; bật lại thì 6 cờ MEDIUM, mỗi cờ đúng một audit `fraud.flagged`, không trùng; consumer chết giữa lệnh nhận lại message, vẫn một decision. **Local chỉ có consumer risk** (TC-124-01 không có notification) |

`dlq-isolation.services-spec.ts` có bốn test: TC-125-01..03 và TC-046-01 (không thuộc kịch bản nào). Đã chạy ngày 2026-11-15: ba spec trên cùng `consumer-base.services-spec.ts` đạt 42 test trong 273 giây ([DBS-183 §8](../features/DBS-183-async-incident-scenarios.md#8-kết-quả)).

## Chạy cloud (chung, chưa chạy)

DBS-184 chạy và ghi bằng chứng. Cần phiên ECS và RDS ([Dựng từ trạng thái trống](../../infra/terraform/README.md#dựng-từ-trạng-thái-trống-và-đo-thời-gian-dbs-139), ≈ 12 phút) và token nhân viên, khách ([demo giữa kỳ](../demos/demo-midterm-end-to-end.md), nhánh cloud). Trên Git Bash đặt `MSYS_NO_PATHCONV=1` trước mọi lệnh `aws logs … --log-group-name /dbs/…`.

- **Chi phí và dọn:** ≈ 0,14 USD/giờ khi api và worker chạy; quên tắt ≈ 2 USD/ngày khi không có task (README Terraform) và ≈ 3,4 USD/ngày khi api và worker chạy; trần một phiên 90 phút.
- **Ngân sách thời gian:** (a)+(c) ≈ 10 phút (150 s chờ DLQ, alarm tới 5 phút, khôi phục); (b) ≈ 5 phút; (d) ≈ 12 phút (alarm `outbox-age` kêu sau ≈ 9 phút 22 giây).
- **Cuối cùng, bắt buộc:** `desired-count` của `worker` về 1 (để `dbs-dev-outbox-age` không kẹt ở `ALARM`), `terraform destroy` phiên, `verify-clean.sh` thoát 0, báo trong kênh chat.
- **Quy tắc 6 ngày của DLQ:** mọi redrive thật khóa DLQ đó 6 ngày ([runbook DLQ](dlq-redrive.md) mục 4); hiện DLQ notification khóa tới 2026-11-21, DLQ risk tới 2026-11-20.

### Cách ép lỗi notification trên cloud (đề xuất, chưa kiểm)

Ops không có đường ghi vào RDS (BL-362). Dùng task `dbs-migrate`: nối RDS bằng role `dbs_migrator`, là **chủ** của `notification_log`, và [backend/README §9](../../backend/README.md) đã có cách ghi đè lệnh của container `migrate` (cùng subnet và security group với service `api`). Không dùng `dbs-db-roles`: task đó cố ý chạy không ghi đè và là task duy nhất đọc secret master; master RDS không phải superuser nên cũng không `ALTER` được bảng của `dbs_migrator`.

- Ghi đè `command` của container `migrate` bằng một lệnh `node` dùng thư viện `pg` (có trong image) và biến `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DATABASE_SSL_CA_PATH` của task, chạy `ALTER TABLE notification_log ADD CONSTRAINT dbs183_block CHECK (false) NOT VALID`; khôi phục bằng `DROP CONSTRAINT dbs183_block`. Kiểm bằng `exitCode` của task, rồi một task nữa kiểm `pg_constraint` không còn `dbs183_block`.
- Trước `ADD` và trước `DROP`, kiểm `aws ecs list-tasks --cluster dbs-dev --family dbs-migrate --desired-status RUNNING` rỗng: `migrate.sh` từ chối chạy khi còn task `dbs-migrate` đang chạy, và một migration chạy lúc `CHECK (false)` còn đó mà ghi `notification_log` sẽ làm deploy hỏng. **Không deploy** cho tới khi `DROP CONSTRAINT` được xác nhận.
- Constraint chặn **mọi** INSERT `notification_log` của cả môi trường (nạp tiền, giao dịch khác, `AccountStatusChanged`): đừng chạy khi người khác đang dùng cùng phiên.
- Lệnh `node` cụ thể chưa được chạy: DBS-184 viết và kiểm; nếu không làm được thì (a) và (c) trên cloud ghi **chưa chạy** kèm lý do; (b) và (d) không ghi RDS nên vẫn chạy.

## (a) Consumer lỗi liên tục → DLQ sau 5 lần + alarm

- **Mục tiêu:** một consumer lỗi mọi lần không chặn consumer khác; message vào DLQ sau đúng 5 lần nhận; người trực được báo.
- **Local:** TC-125-01 (xem bảng trên).
- **Cloud (chưa chạy):** (1) nạp tiền cho một nguồn **trước**; (2) ép notification lỗi (mục trên); (3) **đúng một** chuyển tiền đạt ngưỡng (nạp 21.000.000đ, chuyển 20.000.000đ: R3 + R6 = 65, [demo giữa kỳ](../demos/demo-midterm-end-to-end.md)); (4) đo.
- **Kết quả mong đợi:** ≈ 150–155 s sau lệnh chuyển, `dbs-dev-notification-events-dlq` có message của `eventId` đó (backoff 10+20+40+80 s, BL-210). Vì constraint chặn mọi INSERT, chờ **≥ 1** message và lọc theo `eventId`. Alarm `dbs-dev-notification-dlq-not-empty` sang `ALARM` trong ≤ 5 phút kể từ lúc message vào DLQ (đã đo 155 s ở DBS-163 trên DLQ risk và 139 s ở DBS-164 trên DLQ notification).
- **Cách xác nhận:** `aws sqs get-queue-attributes` của DLQ (cả ba thuộc tính); `aws cloudwatch describe-alarms --alarm-names dbs-dev-notification-dlq-not-empty`; log `/dbs/dev/worker` có dòng `dead_letter`, `reason: attempts_exhausted`, `receiveCount: 5` (BL-364: chưa kiểm trên log thật; dùng lệnh lọc ở mục 2b của runbook DLQ).
- **Dọn để chạy lại:** `DROP CONSTRAINT` rồi kiểm. Message notification trong DLQ là **sự kiện hợp lệ** (`attempts_exhausted`) mà nguyên nhân đã sửa, không thuộc bốn trường hợp được bỏ qua ở runbook DLQ mục 3c. Xử lý **mọi** message `attempts_exhausted` của cửa sổ này (không chỉ message của chuyển tiền thử, vì constraint chặn cả nạp tiền và giao dịch khác), ghi từng `eventId`: redrive cả DLQ nếu DLQ đó chưa redrive trong 6 ngày; còn khóa thì với từng message `receive-message --message-attribute-names All`, gửi lại thân vào `dbs-dev-notification-events` bằng `send-message --message-attributes` **mang theo `OriginalSentTimestamp`** của bản trong DLQ (để tuổi message vẫn tính từ lần gửi gốc, BL-210), rồi xóa bản trong DLQ theo handle. `processed_events` và `INSERT … ON CONFLICT DO NOTHING` bảo đảm mỗi `eventId` chỉ áp một lần dù cùng lúc có redrive và gửi lại.

## (b) Message hỏng → DLQ ngay

- **Mục tiêu:** message không đọc được không bị thử lại và không chặn queue.
- **Local:** TC-125-02, TC-010-01..03 (xem bảng trên).
- **Cloud (chưa chạy):** khi worker chạy, gửi hai message vào `dbs-dev-risk-events`: (1) `{not json`; (2) `{"eventType":"TransferCompleted"}` (JSON hợp lệ, sai schema), bằng `aws sqs send-message`.
- **Kết quả mong đợi:** cả hai vào `dbs-dev-risk-events-dlq` ở lần nhận đầu (vài giây); alarm `dbs-dev-risk-dlq-not-empty` sang `ALARM` ≤ 5 phút. Message (1) **không có dòng log và không có metric**: `SqsClient` chuyển DLQ trước khi tới `ConsumerBase`; message (2) có dòng `dead_letter`, `reason: invalid_event`, `issueCodes`, không có body.
- **Cách xác nhận:** `get-queue-attributes` của DLQ risk = 2; log chỉ một dòng cho (2).
- **Dọn để chạy lại:** xóa hai message khỏi DLQ theo handle ([runbook DLQ](dlq-redrive.md) mục 3b và 3c, ghi nhận bằng GitHub issue); **không** `purge-queue`.

## (c) Notification chết → risk vẫn chạy, chuyển tiền không ảnh hưởng

- **Mục tiêu:** lỗi của consumer phụ không làm hỏng giao dịch tiền và không chặn chấm điểm rủi ro.
- **Local:** TC-125-01 và TC-125-03 (xem bảng trên).
- **Cloud (chưa chạy):** cùng sự cố và cùng một chuyển tiền của (a); quan sát phía giao dịch.
- **Kết quả mong đợi:** chuyển tiền 201 `COMPLETED`; cờ rủi ro xuất hiện (`GET /v1/operator/fraud-flags`) trong vài giây; bất biến sổ cái PASS; DLQ risk 0.
- **Cách xác nhận:** API; `GET /v1/audit/entries?action=notification.sent&correlationId=<C>` (auditor) trả **0** dòng khi lỗi còn và **1** dòng sau khi sửa và gửi lại (không endpoint nào đọc `notification_log`); `invariants.js` bằng task ECS chạy một lần theo [backend/README §9](../../backend/README.md).
- **Dọn để chạy lại:** như (a).

## (d) Worker tắt rồi bật → outbox gửi bù

- **Mục tiêu:** sự kiện không mất khi worker chết; chuyển tiền không phụ thuộc worker.
- **Local:** TC-124-01 và TC-124-02 (xem bảng trên).
- **Cloud (chưa chạy):** `aws ecs update-service --cluster dbs-dev --service worker --desired-count 0`, chờ `runningCount` 0; chuyển N lệnh đạt ngưỡng; rồi `--desired-count 1`.
- **Kết quả mong đợi:** chuyển tiền vẫn 201 khi worker tắt; `dbs-dev-outbox-age` sang `ALARM` sau ≈ 9 phút 22 giây (BL-182, đo 2026-11-14); bật lại: outbox xả trong ≈ 4 giây, đủ N cờ, mỗi cờ đúng một audit `fraud.flagged`, queue và DLQ về 0.
- **Cách xác nhận:** `GET /v1/operator/fraud-flags`; `GET /v1/audit/entries?action=fraud.flagged` (auditor); `get-queue-attributes` bốn queue; `describe-alarms`.
- **Dọn để chạy lại:** `desired-count 1`; outbox rỗng và alarm `outbox-age` về `OK`.

## Giới hạn hiện tại

- Phần cloud chưa chạy: lệnh viết từ tài liệu và số đo đã có (DBS-163, DBS-164, BL-182); cách ép lỗi notification trên cloud là đề xuất chưa kiểm.
- Log `dead_letter` của worker chưa kiểm trên log thật (BL-364); kill API giữa lệnh (AC-5.10) thuộc DBS-185.
- Ở local không có alarm CloudWatch: (a) chỉ chứng minh phần DLQ sau 5 lần.
