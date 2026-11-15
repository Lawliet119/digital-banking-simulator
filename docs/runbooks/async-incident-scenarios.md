# Kịch bản sự cố phần bất đồng bộ (chạy lặp lại được)

> **Status:** Active: local đã chạy 2026-11-15 ([DBS-183](../features/DBS-183-async-incident-scenarios.md)); **cloud đã chạy 2026-11-15** ([DBS-184](../features/DBS-184-cloud-incident-scenarios.md)) · **Owner:** Dev · **Nguồn:** [DBS-183](../features/DBS-183-async-incident-scenarios.md) · **Cập nhật:** 2026-11-15

Bốn sự cố của phần bất đồng bộ (outbox, SQS, worker, consumer), mỗi sự cố có lệnh chạy **local** lặp lại được (test dịch vụ có sẵn), lệnh **cloud** (đã chạy ở DBS-184), kết quả đo và cách xác nhận. Bản chạy tay từng bước nằm ở [Demo 3](../demos/demo-3-failure-recovery.md); xử lý DLQ sau sự cố theo [runbook DLQ](dlq-redrive.md).

| Kịch bản | Nội dung | Local | Cloud |
|---|---|---|---|
| (a) | consumer lỗi liên tục → DLQ sau 5 lần + alarm | đã chạy (không có alarm) | đã chạy (2026-11-15) |
| (b) | message hỏng → DLQ ngay | đã chạy | đã chạy (2026-11-15) |
| (c) | notification chết → risk vẫn chạy, chuyển tiền không ảnh hưởng | đã chạy | đã chạy (2026-11-15) |
| (d) | worker tắt rồi bật → outbox gửi bù | đã chạy | đã chạy (2026-11-15) |

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

## Chạy cloud (đã chạy 2026-11-15, DBS-184)

Điều phối bằng [`infra/scripts/incident-cloud.sh`](../../infra/scripts/incident-cloud.sh) theo từng pha, trong container `dbs-awscli` (lý do và cách dùng container: [demo giữa kỳ, nhánh cloud](../demos/demo-midterm-end-to-end.md#nhánh-cloud)). Cần phiên ECS và RDS ([Dựng từ trạng thái trống](../../infra/terraform/README.md#dựng-từ-trạng-thái-trống-và-đo-thời-gian-dbs-139): `apply` 9 phút 27 giây, `db-roles.sh`, `migrate.sh`, bật api và worker, `seed-cognito.sh`, `seed-cloud.sh`: 4 phút 12 giây), token và `ACC1..3` (CHECKING của `customer1..3`) trong biến môi trường; **lấy token mới ở đầu mỗi pha** (sống 15 phút). Kết quả thô: [manual-test-cloud.txt](../features/screenshots/DBS-184/manual-test-cloud.txt); thiết kế, ngưỡng và quyết định: [DBS-184](../features/DBS-184-cloud-incident-scenarios.md).

```bash
bash infra/scripts/incident-cloud.sh latency L0     # đo p95 máy chủ khi bình thường
bash infra/scripts/incident-cloud.sh bad-messages   # (b)
bash infra/scripts/incident-cloud.sh block          # ép notification lỗi
bash infra/scripts/incident-cloud.sh latency L1     # đo p95 khi consumer lỗi
bash infra/scripts/incident-cloud.sh ac91           # lệnh 44.000.000: cờ 65 MEDIUM
bash infra/scripts/incident-cloud.sh dlq-wait       # (a) DLQ notification, alarm, log
bash infra/scripts/incident-cloud.sh unblock && bash infra/scripts/incident-cloud.sh resend && bash infra/scripts/incident-cloud.sh verify-c
bash infra/scripts/incident-cloud.sh worker-off && bash infra/scripts/incident-cloud.sh d-traffic && bash infra/scripts/incident-cloud.sh outbox-wait && bash infra/scripts/incident-cloud.sh worker-on     # (d)
bash infra/scripts/incident-cloud.sh final-check    # trước destroy
```

- **Chi phí và dọn:** ≈ 0,14 USD/giờ khi api và worker chạy; quên tắt ≈ 3,4 USD/ngày; phiên này ≈ 57 phút (từ `apply` tới `final-check`). **Cuối cùng, bắt buộc:** `final-check` đạt (không còn constraint, `worker` desired và running 1, bốn queue 0/0/0, hai alarm DLQ `OK`; SQS sống qua `destroy` và `verify-clean.sh` không kiểm SQS), rồi `terraform destroy` và `verify-clean.sh` thoát 0. Pha nào hỏng thì `incident-cloud.sh` tự gỡ constraint và bật worker (`safety-net`).
- **Mỗi kịch bản chỉ bắt đầu khi bốn queue về 0/0/0 và hai alarm DLQ về `OK`:** alarm chỉ đếm message **hiện**, `OK` trễ ≈ 2–3 phút sau khi DLQ rỗng; dự trù mỗi lần reset.
- **Quy tắc 6 ngày của DLQ:** mọi redrive thật khóa DLQ đó 6 ngày ([runbook DLQ](dlq-redrive.md) mục 4); DLQ notification khóa tới 2026-11-21, DLQ risk tới 2026-11-20. Lần chạy này **không redrive**: (b) dọn bằng bỏ qua có ghi nhận, (a) bằng gửi lại tay.
- **Ghi vào đâu:** không dán body hay `ReceiptHandle` vào repo; file chứa chúng nằm ở `~/dbs-ops/dlq/` (ngoài repo), script chỉ in `MessageId` và `eventId`.

### Cách ép lỗi notification trên cloud (đã kiểm)

Ops không có đường ghi vào RDS (BL-362). Dùng task `dbs-migrate`: nối RDS bằng role `dbs_migrator`, là **chủ** của `notification_log`, cùng subnet và security group với `api`. Không dùng `dbs-db-roles` (task đó cố ý chạy không ghi đè và là task duy nhất đọc secret master; master RDS không phải superuser nên cũng không `ALTER` được bảng của `dbs_migrator`).

- [`infra/scripts/incident-db.js`](../../infra/scripts/incident-db.js) được nhúng bằng `node -e` vào `--overrides` của `run-task` (dựng bởi `ac-5-10-tools.py overrides --script`, 2.737 ký tự, giới hạn 8.192): `notification-block` chạy `ALTER TABLE notification_log ADD CONSTRAINT dbs183_block CHECK (false) NOT VALID`, `notification-unblock` chạy `DROP CONSTRAINT IF EXISTS dbs183_block`, `notification-check` đọc `pg_constraint` và đếm dòng. DDL tự động commit, `lock_timeout` 3 s, thử lại tới 5 lần (đã thử local với khóa giữ 9 s: một lần `RETRY` rồi thành công).
- Chỉ `NotificationConsumer` ghi `notification_log`: constraint không làm hỏng chuyển tiền, nạp tiền, consumer risk hay đối soát; nó làm thông báo của **mọi** sự kiện (chuyển tiền, nạp tiền, `AccountStatusChanged`) trong cửa sổ rơi vào DLQ, nên chỉ chạy khi không ai khác dùng phiên, và phải gửi lại **mọi** message `attempts_exhausted` của cửa sổ (không chỉ của lệnh thử).
- **Không** chạy `migrate.sh` hay deploy khi constraint còn (một migration ghi `notification_log` sẽ hỏng); `migrate.sh` từ chối khi còn task `dbs-migrate` đang chạy. Kiểm trước và sau bằng `notification-check` (`blocked`).

## (a) Consumer lỗi liên tục → DLQ sau 5 lần + alarm

- **Mục tiêu:** một consumer lỗi mọi lần không chặn consumer khác; message vào DLQ sau đúng 5 lần nhận; người trực được báo.
- **Local:** TC-125-01 (xem bảng trên).
- **Cloud (đã chạy):** `block`, `latency L1` (3 + 24 lệnh nhỏ), `ac91` (nạp sẵn; một lệnh 44.000.000: R3 + R6 = 65), `dlq-wait`.
- **Kết quả đo (2026-11-15):** ≈ 152 s sau lệnh đầu tiên bị lỗi, `dbs-dev-notification-events-dlq` có message đầu (backoff 10+20+40+80 s, BL-210); tổng **28** message (27 lệnh nhỏ gồm khởi động + 1 lệnh AC-9.1), mỗi message một `eventId`; **28** dòng log `/dbs/dev/worker` `dead_letter` với `consumer: notification`, `reason: attempts_exhausted`, `receiveCount: 5`, `eventId` (không có body; BL-364 đã kiểm). Alarm `dbs-dev-notification-dlq-not-empty` sang `ALARM` sau ≈ 1 phút 57 giây kể từ message đầu vào DLQ. Hàng đợi chính `notification-events` về 0/0/0 khi DLQ có đủ 28.
- **Cách xác nhận:** `get-queue-attributes` của DLQ (cả ba thuộc tính); `describe-alarms`; `filter-log-events` `/dbs/dev/worker` với pattern `"dead_letter"`, lọc `reason == "attempts_exhausted"` bằng `jq`, chỉ in `consumer`, `reason`, `eventId`, `receiveCount`.
- **Dọn để chạy lại:** `unblock` (`pg_constraint` rỗng, kiểm bằng `notification-check`), đợi queue chính 0/0/0, rồi `resend`: từ DLQ notification, với từng `eventId` (khử trùng; một `eventId` có thể có hai bản) `send-message` vào `dbs-dev-notification-events` kèm **toàn bộ** thuộc tính của bản DLQ (`OriginalSentTimestamp`, `correlationId`, `eventType`), rồi xóa bản DLQ theo handle; ghi `eventId` và `MessageId` cũ và mới vào file ngoài repo. Đã gửi lại 28 `eventId` trong 25 s; DLQ về 0/0/0, `processed_events` và `INSERT … ON CONFLICT DO NOTHING` bảo đảm mỗi `eventId` chỉ áp một lần; alarm về `OK` sau ≈ 2 phút. Lệnh `resend` là script bash chưa có test tự động và chưa đưa vào CLI (BL-372).

## (b) Message hỏng → DLQ ngay

- **Mục tiêu:** message không đọc được không bị thử lại và không chặn queue.
- **Local:** TC-125-02, TC-010-01..03 (xem bảng trên).
- **Cloud (đã chạy):** `bad-messages`: `send-message` hai message vào `dbs-dev-risk-events`: (1) `{not json`; (2) `{"eventType":"TransferCompleted"}` (JSON hợp lệ, sai schema).
- **Kết quả đo:** cả hai vào `dbs-dev-risk-events-dlq` sau **2 s** (2/0/0), `risk-events` về 0/0/0; alarm `dbs-dev-risk-dlq-not-empty` sang `ALARM` sau **190 s** kể từ lúc gửi. Log: message (1) **không có dòng log** (`SqsClient` chuyển DLQ trước khi tới `ConsumerBase`); message (2) có dòng `dead_letter` `consumer: risk`, `reason: invalid_event`, `issueCodes: ["MISSING_FIELD"]`, `eventId: null`, `receiveCount: 1`, không có body (BL-364 đã kiểm).
- **Cách xác nhận:** `get-queue-attributes` của DLQ = 2; log đúng một dòng cho (2).
- **Dọn để chạy lại:** bỏ qua có ghi nhận ([runbook DLQ](dlq-redrive.md) mục 3b và 3c): body lưu ở `~/dbs-ops/dlq/skip-…jsonl` (ngoài repo), xóa theo handle, ghi GitHub issue ([#201](https://github.com/Lawliet119/digital-banking-simulator/issues/201)); **không** `purge-queue`. DLQ về 0/0/0 sau vài giây; alarm về `OK` sau ≈ 3 phút.

## (c) Notification chết → risk vẫn chạy, chuyển tiền không ảnh hưởng

- **Mục tiêu:** lỗi của consumer phụ không làm hỏng giao dịch tiền và không chặn chấm điểm rủi ro.
- **Local:** TC-125-01 và TC-125-03 (xem bảng trên).
- **Cloud (đã chạy):** cùng sự cố và cùng các lệnh của (a); quan sát phía giao dịch.
- **Kết quả đo:** 27 lệnh nhỏ và lệnh 44.000.000 đều 201 `COMPLETED`; cờ của lệnh 44.000.000: `score` 65, `MEDIUM`, `OPEN`, `ruleSetVersion` 1, xuất hiện sau **2,4 s**; DLQ risk 0/0/0; audit `notification.sent` theo mã lệnh = **0** dòng khi lỗi còn, **1** dòng sau khi gỡ lỗi và gửi lại, và `fraud.flagged` 1 dòng; `invariants.js` PASS (nợ = có = 131.554.000, qua task ECS). **p95 chuyển tiền (máy chủ, `responseTime` của log `Request completed`, 24 lệnh/lần):** bình thường p50 26 ms, p95 **29** ms, p99 31 ms; khi consumer lỗi p50 25 ms, p95 **31** ms, p99 58 ms (tỉ lệ 1,07; ngưỡng ≤ max(1,5×, +50 ms) và < 300 ms). Phía khách (qua ALB tự ký, chỉ so sánh tương đối): p95 86,9 và 94,6 ms. Mẫu nhỏ, một task: chỉ báo.
- **Cách xác nhận:** API; `GET /v1/operator/fraud-flags/<transferId>`; `GET /v1/audit/entries?correlationId=<C>&action=notification.sent` (auditor); `invariants.js` bằng task ECS một lần theo [backend/README §9](../../backend/README.md). **Kiểm cờ theo `transferId`, không đếm tổng**, và giữ `customer1` sạch lịch sử (luật R1, R2, R4 cộng điểm khi một khách có nhiều lệnh gần nhau).
- **Dọn để chạy lại:** như (a).

## (d) Worker tắt rồi bật → outbox gửi bù

- **Mục tiêu:** sự kiện không mất khi worker chết; chuyển tiền không phụ thuộc worker.
- **Local:** TC-124-01 và TC-124-02 (xem bảng trên).
- **Cloud (đã chạy):** `worker-off` (`update-service worker --desired-count 0`), `d-traffic` (nhân viên nạp 40.000.000 cho `customer1`; `customer1` chuyển 43.000.000 cho `customer2`: R3 + R6 = 65; hai lệnh 1.000 VND), `outbox-wait` (chờ tới khi `dbs-dev-outbox-age` sang `ALARM`, trần 15 phút), `worker-on`.
- **Kết quả đo:** `runningCount` của worker về 0 sau **13 s** (container thoát lúc +79 s kể từ `stop-task`, **exit 137**: không thoát trong `stopTimeout` 60 s, xem BL-384); khi worker tắt nạp và chuyển tiền đều 201, cờ của lệnh 43.000.000 chưa có (404); `dbs-dev-outbox-age` sang `ALARM` sau **545 s (9 phút 5 giây)** kể từ `stop-task` (BL-182 đo 9 phút 22 giây từ lúc worker dừng). Bật lại: worker chạy sau **29 s**, cờ 65 MEDIUM xuất hiện sau **43 s** kể từ `update-service`, đúng một audit `fraud.flagged` của lệnh đó, đủ `notification.sent` (lệnh 43.000.000: thấy sau ≤ 1 s, hai lệnh nhỏ: 1 và 1); bốn queue 0/0/0; alarm `outbox-age` về `OK` sau 4 phút 39 giây kể từ lúc bật lại. `invariants.js` PASS (214.556.000).
- **Cách xác nhận:** `GET /v1/operator/fraud-flags/<transferId>`; `GET /v1/audit/entries?correlationId=<C>`; `get-queue-attributes` bốn queue; `describe-alarms`; `describe-tasks` của task worker cũ (`executionStoppedAt`, exit code).
- **Dọn để chạy lại:** `worker-on` (`desired-count 1`); outbox rỗng và alarm `outbox-age` về `OK`.

## Giới hạn hiện tại

- Mẫu p95 nhỏ (24 lệnh mỗi trạng thái, một task api, một người gửi) và đo ở dev: chỉ báo «không đổi đáng kể», không phải benchmark; tải 120 RPS thuộc load test của #5.
- Video chưa quay (BL-383); `resend` mới là script bash (BL-372); `incident-cloud.sh` chạy theo từng pha, chưa chạy một mạch.
- Ở local không có alarm CloudWatch: (a) chỉ chứng minh phần DLQ sau 5 lần; kill API giữa lệnh (AC-5.10) ở [Demo 3 phần E](../demos/demo-3-failure-recovery.md#e-dừng-task-api-giữa-lệnh-chuyển-tiền-ac-510-dbs-185).
