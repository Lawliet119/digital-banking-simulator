# DBS-184 · Chạy bốn kịch bản sự cố trên cloud và ghi bằng chứng

> **Status:** Draft (đang làm, đến G2) · **Vai:** Dev (chạy cloud, script vận hành, tài liệu) · **Cặp đôi review:** Dev khác · **Nhánh:** `test/DBS-184-cloud-incident-scenarios` · **PR:** — · **Cập nhật:** 2026-11-15

## 1. Bối cảnh

- **Task trên board:** Task · Tuần 8 · Ưu tiên High · Deliverable/Demo: Demo 3 · Status board `To Do`. **Thực trạng (board):** các kịch bản sự cố chưa chạy trên cloud; mới có test ở local/Testcontainers; cần worker trên ECS (DBS-121) và alarm DLQ (DBS-163) để thấy phản ứng đầy đủ. **Expect:** Có video/log cho bảng sự cố của P4.
- **DoD (nguyên văn, đánh số):**
  1. Chạy đủ 4 kịch bản trên cloud, p95 chuyển tiền không đổi đáng kể khi consumer lỗi
  2. Video và log lưu docs/deliverables; kết quả vào bảng sự cố P4 (làm gì → phản ứng → thời gian phục hồi)
  3. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc (đối chiếu repo):** DBS-183 (`docs/runbooks/async-incident-scenarios.md`, PR #199 đã merge, board còn To Do); DBS-121 (worker trên ECS, Done); DBS-163 (alarm DLQ, `outbox-age`, đã kích hoạt thử ở PR #187); DBS-164 (runbook DLQ, PR #198). Nền công cụ: [DBS-185](DBS-185-ac-5-10-kill-task-cloud.md) (`ac-5-10-tools.py overrides`, task `dbs-migrate` ghi đè lệnh, mẫu phiên cloud; PR #200).
- **Đã có gì:** bốn kịch bản (a) consumer lỗi → DLQ sau 5 lần + alarm, (b) message hỏng → DLQ ngay, (c) notification chết, risk vẫn chạy, (d) worker tắt rồi bật, outbox gửi bù: lệnh cloud và số đo mong đợi ở [runbook](../runbooks/async-incident-scenarios.md) (viết từ DBS-163, DBS-164, BL-182, chưa chạy); [runbook DLQ](../runbooks/dlq-redrive.md); [bảng sự cố P4](../deliverables/P4-incident-table.md) mới có dòng local DBS-186. **Chưa có:** lệnh ép lỗi notification đã kiểm (BL-370), dòng log `dead_letter` thật (BL-364), kết quả cloud (BL-371), số p95 chuyển tiền khi consumer lỗi.
- **Baseline (docs và script vận hành):** `check-doc-links.mjs` → `434 files checked, 0 broken link(s)` (2026-11-15). Không đổi `backend/`: bốn lệnh backend không chạy.
- **Ngoài phạm vi:** quay video (cần người; BL mới), kill api giữa lệnh (DBS-185), redrive thật hai DLQ (khóa tới 2026-11-20 và 2026-11-21 theo [runbook DLQ](../runbooks/dlq-redrive.md#4-redrive)), đổi code backend hoặc Terraform, tải 120 RPS (task của #5).
- **BACKLOG cùng module:** BL-364, BL-370, BL-371 (task này xử lý, xóa dòng nếu đạt); BL-372 (công cụ gửi lại tay, task này dùng lệnh `aws sqs` ghép tay và có thể thêm hàm trong script, chưa phải công cụ có test: giữ); BL-362 (Ops đọc `processed_events`): không đụng.
- **Câu hỏi mở và quyết định ở G1 (agent tự quyết):**
  1. **Ép lỗi notification** bằng task `dbs-migrate` (role `dbs_migrator`, chủ `notification_log`) chạy `ALTER TABLE notification_log ADD CONSTRAINT dbs183_block CHECK (false) NOT VALID`, gỡ bằng `DROP CONSTRAINT`, kiểm bằng `pg_constraint`: viết thành `infra/scripts/incident-db.js` (nhúng bằng `node -e` như `ac-5-10-db.js`), có test tĩnh. Không dùng `dbs-db-roles` (runbook DBS-183).
  2. **DLQ bị khóa:** hai DLQ không redrive thật trước 2026-11-20 (risk) và 2026-11-21 (notification). (b) dọn bằng «bỏ qua có ghi nhận» đúng [runbook DLQ 3c](../runbooks/dlq-redrive.md): lưu body vào file ngoài repo `~/dbs-ops/dlq/skip-…`, xóa theo handle, ghi một **GitHub issue** `DLQ bỏ qua 2026-11-15 risk-events-dlq` (eventId hoặc messageId, nhãn lý do, ai và khi nào); hai message thử là `{not json` và sai schema, đúng loại được bỏ qua. (a) dọn bằng **gửi lại tay**: với từng `eventId` (khử trùng theo `eventId`, một `eventId` có thể có hai bản trong DLQ) `send-message` vào `notification-events` kèm **mọi** thuộc tính của bản DLQ (`eventType`, `correlationId`, `OriginalSentTimestamp`, kiểu Number), rồi xóa bản DLQ theo handle; ghi `eventId` cùng `MessageId` cũ và mới vào file ngoài repo (tóm tắt trong §8). Chỉ gửi lại sau khi ba thuộc tính của queue chính `notification-events` đều 0 (tin nhắn còn backoff tự thành công). Không `start-message-move-task`, không `purge-queue`.
  3. **p95 «không đổi đáng kể» (domain review #2):** p95 lấy **ở máy chủ**: trường `responseTime` của dòng log `Request completed` của `POST` 201 trong `/dbs/dev/api` theo cửa sổ thời gian từng lần đo (metric EMF `DBS/Backend` cùng nguồn); đo 24 lệnh chuyển 1.000 VND **từ `customer2` sang `customer3` một chiều** (không có chiều ngược, để R4 không bắn; một người gửi, tối đa 9 lệnh/phút vì `RATE_LIMIT_TRANSFERS_PER_MINUTE` mặc định 10), sau 3 lệnh khởi động bỏ đi, ở hai trạng thái trên cùng task api: bình thường (L0) và khi consumer notification lỗi (L1). Số đo phía khách (`curl`, `time_starttransfer − time_appconnect`) chỉ để so sánh tương đối, vì `curl` mỗi lần bắt tay TLS mới với ALB tự ký. **Ngưỡng đạt:** p95(L1) < 300 ms (SLO docs/03 §14, đo ở API; dev không cam kết SLO, chỉ dùng làm mốc) **và** p95(L1) ≤ max(1,5 × p95(L0); p95(L0) + 50 ms). Mẫu nhỏ (24; p99 là giá trị lớn nhất): chỉ báo, không phải benchmark.
  4. **Video** không có người quay: log có dấu thời gian và raw làm bằng chứng; «video lưu docs/deliverables» ghi **chưa làm** (BL mới); bảng đối chiếu của PR ghi DoD 2 «một phần».
  5. **Một phiên cloud** cho cả bốn kịch bản, thứ tự L0 → (b) → (a)+(c) với L1 → dọn → (d) → kiểm cuối → `destroy`. Mỗi kịch bản chỉ bắt đầu khi ba thuộc tính của mọi queue về 0 và alarm DLQ về `OK` (alarm chỉ đếm message **hiện**, `OK` trễ ≈ 3 phút sau khi DLQ rỗng; dự trù 3 phút mỗi lần reset). Token Cognito sống 15 phút: lấy mới ở đầu mỗi pha (kể cả `auditor`), chỉ giữ trong biến.
  6. **Cờ AC-9.1 và luật rủi ro (domain review #1, #7).** Luật v1: R1 +30 (> 5 lệnh trong 10 phút), R2 +25 (> 5 × trung vị 30 ngày, cần ≥ 5 lịch sử), R3 +35, R4 +20 (chiều ngược trong 60 phút), R6 +30; MEDIUM ≥ 40, HIGH ≥ 70. Vì vậy: L0, L1 chỉ chuyển `customer2` → `customer3` (R1 tối đa 30 nên không có cờ). Lệnh AC-9.1 của (a)+(c): `customer1` (CHECKING 48.000.000, không có lịch sử gần) chuyển **44.000.000** cho `customer3` ⇒ R3 35 + R6 30 = **65 MEDIUM**, chờ ≥ 10 phút kể từ lệnh nhỏ cuối. Lệnh của (d): nhân viên nạp 40.000.000 cho `customer1` (còn ≈ 44.000.000), `customer1` chuyển **43.000.000** cho `customer2` ⇒ R3 + R6 = 65 MEDIUM (customer1 chỉ có hai lệnh lịch sử, không R1/R2; customer2 chưa trả customer1, không R4). Kiểm cờ **theo `transferId`**, không đếm tổng.
  7. **Ép lỗi bằng DDL trong tự động commit, có thử lại** (domain review #10): `ADD CONSTRAINT` cần khóa độc quyền trên `notification_log`, có thể xếp hàng sau giao dịch retry của worker: `incident-db.js` mở kết nối với `lock_timeout` 3 s, thử lại tới 5 lần, in kết quả; mọi lệnh DDL chạy tự động commit.

## 2. Hành vi

Chạy bốn kịch bản của runbook DBS-183 trên phiên cloud (api 1, worker 1, `seed-cloud.sh`), đo, ghi. Mỗi kịch bản: làm gì → phản ứng → thời gian phục hồi (cột của bảng P4).

| Kịch bản | Làm gì | Mong đợi (từ runbook DBS-183, sửa theo domain review) |
|---|---|---|
| L0 | 3 lệnh khởi động, rồi 24 lệnh chuyển 1.000 VND `customer2` → `customer3`, 7 s một lệnh | p50, p95, p99 từ `responseTime` phía máy chủ; p95 phía khách chỉ so sánh |
| (b) message hỏng | `send-message` `{not json` và `{"eventType":"TransferCompleted"}` vào `dbs-dev-risk-events` | cả hai vào `dbs-dev-risk-events-dlq` ở lần nhận đầu (vài giây); alarm `dbs-dev-risk-dlq-not-empty` `ALARM` ≤ 5 phút; log: message 1 không có dòng log, message 2 có `dead_letter`, `reason: invalid_event` (BL-364). Dọn theo runbook DLQ 3c, chờ DLQ risk 0 và alarm `OK` |
| (a) + (c) | `incident-db.js notification-block`; L1 (cùng cách đo L0); lệnh AC-9.1 (44.000.000) | mọi lệnh 201; cờ 65 MEDIUM của **đúng `transferId` đó** trong vài giây; DLQ risk 0; ≈ 150–155 s sau mỗi lệnh `notification-events-dlq` có message của `eventId` đó (log `dead_letter`, `reason: attempts_exhausted`, `receiveCount: 5`); alarm `dbs-dev-notification-dlq-not-empty` `ALARM` ≤ 5 phút kể từ message đầu; audit `notification.sent` theo mã lệnh AC-9.1 = 0 dòng khi lỗi còn; `invariants.js` PASS; p95 theo G1 quyết định 3 |
| dọn (a) | `notification-unblock` (`pg_constraint` rỗng); chờ queue chính 0; gửi lại tay theo `eventId` | DLQ notification về 0; audit `notification.sent` = 1 dòng theo mã lệnh AC-9.1; alarm về `OK`. Mọi thông báo của nạp tiền và `AccountStatusChanged` rơi trong cửa sổ cũng vào DLQ và cũng được gửi lại |
| (d) worker tắt/bật | `update-service worker --desired-count 0`; nạp 40.000.000 cho `customer1`; lệnh 43.000.000 (65 MEDIUM) và 2 lệnh 1.000 VND; **chờ tới khi `dbs-dev-outbox-age` sang `ALARM`** (trần 15 phút), rồi `desired-count 1` | chuyển tiền 201 khi worker tắt; `outbox-age` `ALARM` ≈ 9 phút 22 giây (BL-182) kể từ lúc worker dừng (ghi `stoppingAt`, `executionStoppedAt`, `StateUpdatedTimestamp`); sau khi bật lại outbox xả ≈ 4 giây, cờ của lệnh 43.000.000 xuất hiện và có đúng một audit `fraud.flagged`, ba lệnh có `notification.sent`; queue và DLQ về 0; alarm về `OK` trong ≤ 5 phút |
| kiểm cuối | trước `destroy` | `notification-check` `blocked: false`, worker desired và running 1, ba thuộc tính 0 trên cả bốn queue, hai alarm DLQ `OK` (SQS sống qua `destroy`, `verify-clean.sh` không kiểm SQS) |

**Ca biên:** constraint chặn **mọi** `INSERT notification_log` của cả phiên (nạp tiền, giao dịch khác): chỉ chạy khi không ai khác dùng phiên; không chạy `migrate.sh` hay deploy khi constraint còn (migration ghi `notification_log` sẽ hỏng); `migrate.sh` từ chối khi còn task `dbs-migrate` đang chạy.

## 3. Kiến trúc

- **Vị trí:** không đổi code sản phẩm hay Terraform. Thêm `infra/scripts/incident-db.js` (chạy trong task `dbs-migrate`: `notification-block`, `notification-unblock`, `notification-check`), `infra/scripts/incident-cloud.sh` (điều phối từng pha, chạy trong container `dbs-awscli`), mở rộng `ac-5-10-tools.py overrides` thêm `--script PATH`, test `tests/test_incident_scenarios.py`; sửa runbook DBS-183, bảng P4, Demo 3.
- **Interface dùng:** `aws ecs run-task` (`dbs-migrate`), `update-service`, `aws sqs` (send/receive/delete/get-queue-attributes), `aws cloudwatch describe-alarms`, `aws logs filter-log-events`, API `POST /v1/transfers`, `GET /v1/operator/fraud-flags`, `GET /v1/audit/entries`, `POST /v1/operator/deposits`.
- **Dữ liệu chạm tới:** DDL duy nhất: `notification_log` thêm và gỡ constraint `dbs183_block` (`CHECK (false) NOT VALID`; không đổi dữ liệu có sẵn); đọc `pg_constraint`, `reconciliation_runs`. SQS (sống qua `destroy`): gửi hai message hỏng; xóa chúng và các message `attempts_exhausted` khỏi DLQ sau khi lưu vào file ngoài repo và ghi `eventId` (và GitHub issue cho (b)).
- **Ranh giới transaction:** không đổi.
- **Sơ đồ:** mỗi kịch bản là một dòng trong runbook DBS-183 (đã có sơ đồ luồng); không vẽ thêm.
- **Thay đổi cấp hệ thống:** runbook DBS-183 (trạng thái, kết quả cloud, lệnh ép lỗi đã kiểm), P4, Demo 3, `docs/features/README.md`, `docs/BACKLOG.md` (xóa BL-364, 370, 371 nếu đạt).
- **Rủi ro vận hành:** constraint quên gỡ thì mọi `notification_log` lỗi (`destroy` xóa cả DB); worker quên bật lại thì `dbs-dev-outbox-age` kẹt `ALARM`. Cả hai được chặn bằng `trap` (gỡ constraint, bật worker) trong `incident-cloud.sh` và pha `final-check` trước `destroy`; message dở dang trong DLQ giữ alarm của `base` ở `ALARM` và trỏ tới DB đã hủy, nên `final-check` đòi ba thuộc tính 0; quên `destroy` ≈ 3,4 USD/ngày; chi phí phiên ≈ 0,14 USD/giờ, dự kiến ≤ 90 phút.

## 4. Test cases tự động

Task vận hành: kiểm tĩnh và test script; hành vi trên cloud ở §5.

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-184-01 | BL-370 | tĩnh (Python) | `incident-db.js` chỉ có `SELECT`, `BEGIN`, `ROLLBACK` và DDL duy nhất `ALTER TABLE public.notification_log ADD CONSTRAINT dbs183_block CHECK (false) NOT VALID` / `DROP CONSTRAINT IF EXISTS dbs183_block`; không in mật khẩu; `--overrides` dựng bằng `ac-5-10-tools.py overrides --script` ≤ 8 192 ký tự; `bash -n incident-cloud.sh`; script không in token; không `purge-queue`, không `start-message-move-task` |
| TC-184-02 | BL-370 | PostgreSQL 17 thật (tay, local) | `notification-block` làm `INSERT notification_log` lỗi `23514`; `notification-check` báo `blocked: true`; `notification-unblock` gỡ, `INSERT` được lại; `notification-check` `blocked: false` |
| TC-184-03 | DoD 1 (a) | cloud | DLQ notification có message `attempts_exhausted` ≈ 150 s sau lệnh; alarm `ALARM` ≤ 5 phút; log `dead_letter` (BL-364) |
| TC-184-04 | DoD 1 (b) | cloud | hai message hỏng vào DLQ risk ngay; alarm; log đúng như runbook |
| TC-184-05 | DoD 1 (c) | cloud | lệnh 201, cờ 65, DLQ risk 0, audit `notification.sent` 0 dòng khi lỗi còn, 1 dòng sau khi gửi lại, invariants PASS |
| TC-184-06 | DoD 1 (d) | cloud | worker 0 → chuyển 201, `outbox-age` `ALARM`, bật lại outbox xả, đủ cờ và audit, queue và DLQ 0 |
| TC-184-07 | DoD 1 (p95) | cloud | p95 phía máy chủ của L1 thỏa ngưỡng ở G1 quyết định 3 (kèm L0 và số đo phía khách) |
| TC-184-08 | DoD 2 | tài liệu | bảng P4 có dòng cloud cho từng kịch bản (làm gì → phản ứng → thời gian phục hồi → bằng chứng); log lưu `docs/features/screenshots/DBS-184/`; video chưa (BL) |
| TC-184-09 | DoD 3 | quy trình | PR, CI xanh, Dev review, bảng đối chiếu |
| TC-184-10 | tài liệu | tĩnh | `check-doc-links.mjs` sạch; `grep -E "eyJ|arn:aws|[0-9]{12}|ReceiptHandle|\"Body\"|sqs\..*amazonaws"` trên bằng chứng = 0 (chỉ in `MessageId` và `eventId`) |

## 5. Test thủ công

Điều kiện: image `c0db04a` (hoặc SHA mới hơn) trên ECR; AWS profile nhóm `dbs-admin` (bí danh `dbs`); container `dbs-awscli`; không có phiên khác; bí mật như [DBS-185 §5](DBS-185-ac-5-10-kill-task-cloud.md#5-test-thủ-công). Chạy bằng `infra/scripts/incident-cloud.sh <pha>`.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-184-01 | Local: TC-184-01, 02 (PostgreSQL 17 tạm) | như §4 |
| M-184-02 | `apply` phiên, `db-roles.sh`, `migrate.sh`, bật api và worker, seed Cognito và dữ liệu | `/health/ready` 200 |
| M-184-03 | `latency L0` (3 lệnh bỏ + 24 lệnh) | p50, p95, p99 phía máy chủ ghi |
| M-184-04 | `bad-messages` (kịch bản b), theo dõi DLQ risk, alarm, log; dọn bằng bỏ qua có ghi nhận (file ngoài repo, GitHub issue); chờ DLQ 0 và alarm `OK` | §2 |
| M-184-05 | `block` (kiểm `pg_constraint`), `latency L1`, lệnh AC-9.1, đo, chờ DLQ notification và alarm, lọc log | §2 (a), (c), p95 |
| M-184-06 | `unblock`, gửi lại tay, kiểm audit, DLQ về 0, alarm về `OK` | §2 dọn (a) |
| M-184-07 | `worker-off`, nạp và lệnh 43.000.000 cùng 2 lệnh nhỏ, chờ `outbox-age` `ALARM`, `worker-on`, kiểm | §2 (d) |
| M-184-08 | `final-check`, `destroy`, `verify-clean.sh` | §2 kiểm cuối; `verify-clean` exit 0 |

Video: **chưa làm** (G1 quyết định 4).

## 6. Domain review (AI)

**Vòng 1:** subagent, model opus (effort medium), 2026-11-15 · **Kết quả:** 12 phát hiện (blocking 2, should-fix 5, minor 5), verdict **REVISE** · [trả lời nguyên văn](screenshots/DBS-184/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | L0, L1 làm customer1 có lịch sử, lệnh AC-9.1 vượt 65 (R1, R2, R4) | đã sửa: G1 quyết định 6: L0 và L1 chỉ `customer2` → `customer3` một chiều; AC-9.1 do `customer1`; kiểm cờ theo `transferId` |
| 2 | blocking | `curl time_total` gồm bắt tay TLS, không thể xét SLO 300 ms | đã sửa: G1 quyết định 3: p95 từ `responseTime` phía máy chủ, curl chỉ so sánh tương đối, bỏ 3 lệnh khởi động |
| 3 | should-fix | chờ cố định ≥ 10 phút cho (d), mốc bắt đầu | đã sửa: chờ tới khi `ALARM` (trần 15 phút), ghi `executionStoppedAt`, `StateUpdatedTimestamp` |
| 4 | should-fix | token Cognito 15 phút, thiếu token auditor | đã sửa: G1 quyết định 5: token mới ở đầu mỗi pha |
| 5 | should-fix | dọn chỉ dựa vào cuối script; SQS sống qua `destroy` | đã sửa: `trap` và pha `final-check` (§2 kiểm cuối) |
| 6 | should-fix | ghi nhận bỏ qua phải theo runbook (GitHub issue, file ngoài repo) | đã sửa: G1 quyết định 2 |
| 7 | should-fix | số tiền (d) thiếu, R6 không bắn | đã sửa: G1 quyết định 6: nạp 40.000.000, chuyển 43.000.000 từ `customer1` |
| 8 | minor | gửi lại phải chép đủ thuộc tính, khử trùng theo `eventId`, đợi queue chính 0 | đã sửa: G1 quyết định 2 |
| 9 | minor | mô tả ca biên chưa chính xác | đã sửa §2 |
| 10 | minor | DDL cần tự động commit, `lock_timeout`, thử lại | đã sửa: G1 quyết định 7, TC-184-01 |
| 11 | minor | reset alarm giữa các kịch bản | đã sửa: G1 quyết định 5 (chặn bằng ba thuộc tính 0 và alarm `OK`) |
| 12 | minor | grep bằng chứng thiếu `ReceiptHandle`, body, URL queue | đã sửa: TC-184-10 |

**Quyết định ở G2 (agent tự quyết):** (1) không chạy vòng 2: không còn blocking sau khi sửa, các thay đổi là điều kiện đo và cách dọn kiểm được khi chạy thật, và mọi lần chạy ghi nguyên văn; (2) p95 chỉ là chỉ báo (24 mẫu), không tuyên bố SLO.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `infra/scripts/tests/test_incident_scenarios.py` | TC-184-01 | 5 lỗi/thất bại vì chưa có `incident-*` và `overrides --script` | `python infra/scripts/tests/test_incident_scenarios.py`; CI `script-tests` | `test(infra): TC-184-01 cho công cụ kịch bản sự cố (DBS-184)` |
| 2 | `infra/scripts/incident-db.js`, `ac-5-10-tools.py` (`--script`) | TC-184-02 (tay, PostgreSQL 17 local) | `Cannot find module` | bước 1 xanh; M-184-01 | `feat(infra): incident-db.js ép và gỡ lỗi notification (DBS-184)` |
| 3 | `infra/scripts/incident-cloud.sh` | `bash -n`; thiếu biến môi trường thì từ chối | `bash -n` báo không có file | `bash -n`; chạy thật ở cloud | `feat(infra): incident-cloud.sh điều phối kịch bản sự cố (DBS-184)` |
| 4 | `docs/features/screenshots/DBS-184/manual-test.txt`, `manual-test-cloud.txt` | TC-184-02..07, M-184-01..08 | — | `terraform apply` → các pha → `final-check` → `destroy` → `verify-clean.sh` | `docs(features): kết quả chạy cloud kịch bản sự cố (DBS-184)` |
| 5 | `docs/runbooks/async-incident-scenarios.md`, `docs/runbooks/dlq-redrive.md` (nếu lệch), `docs/deliverables/P4-incident-table.md`, `docs/demos/demo-3-failure-recovery.md`, `docs/features/README.md`, `docs/BACKLOG.md`, feature doc §8, §9 | TC-184-08, 10 | — | `check-doc-links.mjs`; grep bằng chứng | `docs: kết quả bốn kịch bản sự cố trên cloud, P4, BACKLOG (DBS-184)` |

- **Plan sweep:** hạn chế trong tài liệu liền kề: runbook DBS-183 «phần cloud chưa chạy», «cách ép lỗi là đề xuất chưa kiểm», «BL-364» (bước 5); P4 «cloud chưa chạy» (bước 5); Demo 3 phần A–C (bước 5, thêm liên kết kết quả cloud); BL-364, 370, 371 (bước 5, xóa nếu đạt); BL-372 giữ; DoD 1 (bước 4), DoD 2 video (BL mới), DoD 3 quy trình.
- **Rủi ro và cách lùi:** quên `destroy` ≈ 3,4 USD/ngày (kết thúc bằng `final-check`, `destroy`, `verify-clean.sh`; nếu hết giới hạn giữa chừng, ghi handoff); constraint hoặc worker 0 bị bỏ lại (`trap`, `final-check`); lần đo không đạt ngưỡng p95 thì ghi nguyên văn, không sửa ngưỡng; DLQ còn message sau khi dọn thì dừng và ghi. Back-out: bỏ commit, trên cloud `destroy`.
- **Quyết định ở G3 (agent tự quyết):** (1) tái dùng `ac-5-10-tools.py overrides` thay vì công cụ mới; (2) chạy `incident-cloud.sh` theo pha để quan sát từng bước; (3) test DB chạy tay local, không đưa vào CI.
