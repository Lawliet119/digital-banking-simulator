# DBS-183 · Kịch bản sự cố phần bất đồng bộ (chạy lặp lại được)

> **Status:** Plan approved (sau G3) · **Vai:** Dev (docs, chạy test) · **Cặp đôi review:** Dev khác · **Nhánh:** `docs/DBS-183-async-incident-scenarios` · **PR:** — · **Cập nhật:** 2026-11-15

## 1. Bối cảnh

- **Task trên board:** Task · Tuần 8 · Ưu tiên High · Status board `To Do`. **Expect:** Lỗi ở một consumer không ảnh hưởng chuyển tiền và consumer khác. **Thực trạng (board):** Mới có test ở mức Testcontainers (DBS-124, DBS-125); chưa có kịch bản chạy trên cloud.
- **DoD:**
  1. Bốn kịch bản có lệnh chạy lặp lại: (a) consumer lỗi liên tục → DLQ sau 5 lần + alarm; (b) message hỏng → DLQ ngay; (c) notification chết → risk vẫn chạy, chuyển tiền không ảnh hưởng; (d) worker tắt rồi bật → outbox gửi bù
  2. Mỗi kịch bản ghi kết quả mong đợi và cách xác nhận
  3. PR đã merge vào main; Dev review; không còn liên kết hỏng, tên bảng/cột/mã lỗi khớp các tài liệu khác (đã grep)
- **Phụ thuộc (đối chiếu repo):** DBS-125 (`dlq-isolation.services-spec.ts`, TC-125-01..03) và DBS-124 (`worker-recovery.services-spec.ts`, TC-124-01..02): có trên `main`. DBS-163 (alarm DLQ và tuổi queue): đã merge ([#187](https://github.com/Lawliet119/digital-banking-simulator/pull/187)); alarm `dbs-dev-<consumer>-dlq-not-empty` và `dbs-dev-outbox-age` đã kích hoạt thử trên AWS. DBS-164 (runbook DLQ) cho bước xử lý sau sự cố, đang ở PR #198.
- **Đã có gì:** bốn scenario đã có ở dạng test và demo tay rải rác: [Demo 3](../demos/demo-3-failure-recovery.md) phần A–C (relay chết, worker chết, consumer lỗi → DLQ) và các feature doc DBS-91, 124, 125. **Chưa có:** một nơi liệt kê bốn kịch bản với **lệnh chạy lặp lại** (local) và **lệnh cloud**, kết quả mong đợi (kèm số đo đã có) và cách xác nhận cho từng kịch bản; DBS-184 cần đúng thứ này để chạy trên cloud và ghi bằng chứng.
- **Baseline (docs-only, kèm test dịch vụ để chứng minh lệnh local chạy được):** `check-doc-links.mjs` → `423 files checked, 0 broken link(s)` (2026-11-15, `main` 841d5ec). Lệnh local của kịch bản được chạy ở §5.
- **Vai trên board:** `Dev`; việc là tài liệu kịch bản có chạy lệnh thật.
- **Ngoài phạm vi:** chạy các kịch bản trên cloud và ghi bằng chứng (DBS-184, cần phiên ECS và RDS); đổi code hay Terraform; đường ghi vào RDS cho Ops (BL-362).
- **BACKLOG cùng module:** BL-182 (alarm `outbox-age` kêu sau 9 phút 22 giây khi worker về 0, bật lại xả trong 4 giây): lấy làm số đo mong đợi của kịch bản (d) cloud, không đóng. BL-364 (dòng log `dead_letter` và lệnh lọc chưa kiểm trên log thật, đang ở PR #198): kịch bản (a) và (b) trên cloud là chỗ kiểm, nêu ở §8. BL-211 và BL-210 (backoff 150 giây, tuổi message) là nền của kịch bản (a).
- **Quyết định ở G1 (agent tự quyết):**
  1. **Lệnh "chạy lặp lại được" = các test dịch vụ đã có** (`npm run test:services -- --runTestsByPath …`), mỗi lần chạy dựng lại ElasticMQ, Valkey và PostgreSQL tạm nên lặp bao nhiêu lần cũng cho cùng kết quả; không viết script mới. Kịch bản ghi rõ test nào ứng với (a)–(d) và đã chạy chúng ở §5. Demo 3 giữ cho bản chạy tay.
  2. **Phần cloud viết từ lệnh và số đo đã có** (DBS-163, BL-182, DBS-139), đánh dấu **chưa chạy trên cloud (chờ DBS-184)**; riêng cách ép lỗi consumer trên cloud cần ghi vào RDS và Ops chưa có đường đó (BL-362), nên kịch bản nêu phương án (task ECS chạy một lần dùng secret master như `db-roles.sh`) là **đề xuất chưa kiểm**.
  3. Tài liệu đặt ở `docs/runbooks/async-incident-scenarios.md` (cạnh runbook DLQ).
- **Câu hỏi mở:** không có.

## 2. Hành vi

Sản phẩm: [`docs/runbooks/async-incident-scenarios.md`](../runbooks/async-incident-scenarios.md). Bốn kịch bản, mỗi kịch bản có cùng sáu mục: **Mục tiêu**, **Chạy local (lặp lại được)**, **Chạy cloud (cho DBS-184)**, **Kết quả mong đợi**, **Cách xác nhận**, **Dọn để chạy lại**. Tài liệu phụ thuộc runbook DLQ ([DBS-164](DBS-164-dlq-runbook-dev-trial.md), PR #198) nên PR của task này chỉ merge sau #198.

**Chạy local (chung).** Từ `backend/`, cần Docker (Testcontainers tự dựng ElasticMQ và Valkey) và một PostgreSQL 17 đang chạy làm máy chủ; mỗi test tạo database tạm riêng (`dbs_test_<12 hex>`) rồi xóa, nên lặp bao nhiêu lần cũng cho cùng kết quả:

```bash
docker run -d --rm --name dbs183-pg -p 55433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test postgres:17 -c timezone=UTC
export DATABASE_URL=postgres://test:test@localhost:55433/postgres
npm run test:services -- --runInBand --runTestsByPath test/services/dlq-isolation.services-spec.ts --verbose
```

| Kịch bản | Spec (test) | Điều test chứng minh, và điều không chứng minh |
|---|---|---|
| (a) consumer lỗi liên tục → DLQ sau 5 lần + alarm | `dlq-isolation.services-spec.ts` TC-125-01 | notification lỗi mọi lần: message vào DLQ sau đúng 5 lần nhận; risk vẫn xử lý. **Không có alarm ở local** (CloudWatch): chỉ chạy trên cloud |
| (b) message hỏng → DLQ ngay | `dlq-isolation.services-spec.ts` TC-125-02; `consumer-poison.services-spec.ts` TC-010-01 (loại sự kiện lạ), TC-010-02 (sai schema), TC-010-03 (không phải JSON) | mỗi loại hỏng vào DLQ ở lần nhận đầu; consumer khác không bị chặn |
| (c) notification chết → risk vẫn chạy, chuyển tiền không ảnh hưởng | `dlq-isolation.services-spec.ts` TC-125-01 và TC-125-03 | cờ rủi ro vẫn tạo khi notification lỗi; bất biến sổ cái PASS (`afterEach` của spec; giao dịch đã commit trước khi consumer chạy); sau khi sửa, redrive đưa message về xử lý đúng một lần (TC-125-03). Spec không tự kiểm số dư hay trạng thái giao dịch sau lỗi ngoài bất biến |
| (d) worker tắt rồi bật → outbox gửi bù | `worker-recovery.services-spec.ts` TC-124-01, TC-124-02 | worker dừng: chuyển tiền vẫn 201, sự kiện chờ trong outbox; bật lại thì 6 cờ MEDIUM, mỗi cờ đúng một audit `fraud.flagged`, không trùng; consumer chết giữa lệnh nhận lại message, vẫn một decision. **Local chỉ có consumer risk** (TC-124-01 không có notification) |

`dlq-isolation.services-spec.ts` có bốn test: TC-125-01..03 và TC-046-01 (không thuộc kịch bản nào).

**Chạy cloud (chung; DBS-184 chạy và ghi bằng chứng).** Cần phiên ECS và RDS ([Dựng từ trạng thái trống](../../infra/terraform/README.md#dựng-từ-trạng-thái-trống-và-đo-thời-gian-dbs-139), ≈ 12 phút) và token nhân viên, khách (kịch bản [demo giữa kỳ](../demos/demo-midterm-end-to-end.md), nhánh cloud). **Chi phí và dọn:** ≈ 0,14 USD/giờ khi api và worker chạy, quên tắt ≈ 2 USD/ngày khi không có task (README Terraform) và ≈ 3,4 USD/ngày khi api và worker chạy, trần một phiên 90 phút. Ngân sách thời gian: (a)+(c) ≈ 10 phút (150 s chờ DLQ, alarm tới 5 phút, khôi phục), (b) ≈ 5 phút, (d) ≈ 12 phút (alarm `outbox-age` kêu sau ≈ 9 phút 22 giây). Cuối cùng **bắt buộc**: `desired-count` của `worker` về 1 (để `dbs-dev-outbox-age` không kẹt ở `ALARM`), `terraform destroy` phiên, `verify-clean.sh` thoát 0, báo trong kênh chat.

| Kịch bản | Ép sự cố | Mong đợi (đã đo ở đâu) | Xác nhận |
|---|---|---|---|
| (a) | thứ tự: nạp tiền cho nguồn **trước**; rồi ép notification lỗi (`ADD CONSTRAINT`, xem dưới); rồi **đúng một** chuyển tiền đạt ngưỡng | ≈ 150–155 s sau lệnh chuyển, `dbs-dev-notification-events-dlq` có message của `eventId` đó (backoff 10+20+40+80 s, BL-210). Constraint chặn **mọi** INSERT `notification_log` của cả môi trường (nạp tiền, giao dịch khác, `AccountStatusChanged`), nên chờ **≥ 1** message và lọc theo `eventId`. Alarm `dbs-dev-notification-dlq-not-empty` sang `ALARM` trong ≤ 5 phút kể từ lúc message vào DLQ (đã đo 155 s ở DBS-163 trên DLQ risk, 139 s ở DBS-164 trên DLQ notification) | `get-queue-attributes` của DLQ; `describe-alarms`; log `/dbs/dev/worker` có dòng `dead_letter`, `reason: attempts_exhausted`, `receiveCount: 5` (BL-364: chưa kiểm trên log thật; trên Git Bash đặt `MSYS_NO_PATHCONV=1`) |
| (b) | hai message vào `dbs-dev-risk-events` khi worker chạy: (1) `{not json`; (2) `{"eventType":"TransferCompleted"}` (JSON hợp lệ, sai schema) | cả hai vào `dbs-dev-risk-events-dlq` ở lần nhận đầu (vài giây); alarm `dbs-dev-risk-dlq-not-empty` sang `ALARM` ≤ 5 phút. (1) **không có dòng log và không có metric**: `SqsClient` chuyển DLQ trước khi tới `ConsumerBase`; (2) có dòng `dead_letter`, `reason: invalid_event`, `issueCodes`, không có body | `get-queue-attributes` (DLQ = 2); log chỉ một dòng cho (2) |
| (c) | cùng sự cố và cùng một chuyển tiền của (a); quan sát phía giao dịch | chuyển tiền 201 `COMPLETED`; cờ rủi ro xuất hiện (`GET /v1/operator/fraud-flags`) trong vài giây; bất biến sổ cái PASS | API; `GET /v1/audit/entries?action=notification.sent&correlationId=<C>` (auditor) trả **0** dòng khi lỗi còn và **1** dòng sau khi sửa và gửi lại (không endpoint nào đọc `notification_log`); `invariants.js` bằng task ECS chạy một lần ([backend/README §9](../../backend/README.md)); DLQ risk 0 |
| (d) | `aws ecs update-service --cluster dbs-dev --service worker --desired-count 0`, chờ `runningCount` 0, chuyển N lệnh đạt ngưỡng, rồi `--desired-count 1` | chuyển tiền vẫn 201 khi worker tắt; `dbs-dev-outbox-age` sang `ALARM` sau ≈ 9 phút 22 giây (BL-182, đo 2026-11-14); bật lại: outbox xả trong ≈ 4 giây, đủ N cờ, mỗi cờ đúng một audit `fraud.flagged`, queue và DLQ về 0 | `GET /v1/operator/fraud-flags`, `GET /v1/audit/entries?action=fraud.flagged` (auditor); `get-queue-attributes` bốn queue; `describe-alarms` |

**Cách ép lỗi notification trên cloud (đề xuất, chưa kiểm; DBS-184 xác nhận).** Ops không có đường ghi vào RDS (BL-362). Dùng `dbs-migrate`, task chạy một lần nối RDS bằng role `dbs_migrator`, là **chủ** của `notification_log` và đã có cách ghi đè lệnh trong [backend/README §9](../../backend/README.md) (không dùng `dbs-db-roles`: task đó cố ý chạy không ghi đè và là task duy nhất đọc secret master; master RDS cũng không phải superuser nên không `ALTER` được bảng của `dbs_migrator`). Ghi đè `command` của container `migrate` bằng một lệnh `node` dùng thư viện `pg` và biến `DB_*` (TLS bằng `DATABASE_SSL_CA_PATH`) chạy `ALTER TABLE notification_log ADD CONSTRAINT dbs183_block CHECK (false) NOT VALID`, và `DROP CONSTRAINT dbs183_block` để khôi phục; kiểm bằng `exitCode` của task, rồi một task nữa kiểm `pg_constraint` không còn `dbs183_block`. Lệnh `node` cụ thể chưa được chạy: DBS-184 viết và kiểm; nếu không làm được thì (a) và (c) trên cloud ghi **chưa chạy** kèm lý do, (b) và (d) không cần ghi RDS nên vẫn chạy. Trước `ADD` và trước `DROP`, kiểm `aws ecs list-tasks --cluster dbs-dev --family dbs-migrate --desired-status RUNNING` rỗng (`migrate.sh` từ chối chạy khi còn task `dbs-migrate` đang chạy, và một migration chạy lúc `CHECK (false)` còn đó mà ghi `notification_log` sẽ làm deploy hỏng); **không deploy** cho tới khi `DROP CONSTRAINT` được xác nhận. Đừng chạy khi người khác đang dùng cùng phiên (constraint ảnh hưởng mọi thông báo). Một lệnh ép lỗi chính thức là bàn giao (§8).

**Dọn để chạy lại.**
- (a), (c): `DROP CONSTRAINT` rồi kiểm; message notification trong DLQ là **sự kiện hợp lệ** (`attempts_exhausted`) mà nguyên nhân đã sửa, không thuộc bốn trường hợp được bỏ qua ở runbook DLQ mục 3c. Xử lý **mọi** message `attempts_exhausted` của cửa sổ này (không chỉ message của chuyển tiền thử, vì constraint chặn cả nạp tiền và giao dịch khác), ghi từng `eventId`: redrive cả DLQ nếu DLQ đó chưa redrive trong 6 ngày; còn khóa (DLQ notification tới 2026-11-21, DLQ risk tới 2026-11-20) thì với từng message `receive-message --message-attribute-names All`, gửi lại thân vào `dbs-dev-notification-events` bằng `send-message --message-attributes` **mang theo `OriginalSentTimestamp`** của bản trong DLQ (để tuổi message vẫn tính từ lần gửi gốc, BL-210), rồi xóa bản trong DLQ theo handle (mục "Lần chạy thật" của runbook). `processed_events` và `INSERT … ON CONFLICT DO NOTHING` bảo đảm mỗi `eventId` chỉ áp một lần dù cùng lúc có redrive và gửi lại. Kết quả: `notification.sent` có đúng 1 dòng cho mỗi sự kiện đã gửi lại (kịch bản (c)).
- (b): xóa hai message khỏi DLQ theo handle (runbook mục 3b và 3c, ghi nhận bằng GitHub issue); **không** `purge-queue`.
- (d): `desired-count 1`, outbox rỗng (không còn alarm `outbox-age`).
- Local: không cần dọn (database tạm tự xóa); dừng container PostgreSQL.

## 3. Kiến trúc

- **Vị trí:** `docs/runbooks/async-incident-scenarios.md` (mới); `docs/03_HIGH_LEVEL_ARCHITECTURE.md` §17 (liên kết ở dòng "Failure / recovery"), `docs/demos/demo-3-failure-recovery.md` (liên kết), `docs/features/README.md`, `docs/BACKLOG.md`. Không đổi code, Terraform, hợp đồng sự kiện hay `ErrorCode`.
- **Dữ liệu chạm tới (đọc để đối chiếu):** `outbox_events`, `processed_events`, `notification_log`, `risk_decisions`, `fraud_flags`, `audit_log` (`fraud.flagged`, `notification.sent`); hàng đợi `dbs-dev-{risk,notification}-events` và `-dlq`; alarm `dbs-dev-{risk,notification}-dlq-not-empty`, `dbs-dev-outbox-age`; ECS service `worker` của cluster `dbs-dev`; `ConsumerBase` (`MAX_ATTEMPTS = 5`, backoff 10/20/40/80 s).
- **Luồng:**

```mermaid
flowchart LR
  T[Chuyển tiền 201] --> O[(outbox_events)]
  O -- relay trong worker --> Q1[risk-events] --> R[risk consumer] --> F[cờ + audit fraud.flagged]
  O -- relay trong worker --> Q2[notification-events] --> N[notification consumer]
  N -- lỗi 5 lần --> D2[notification DLQ] --> A2[alarm]
  Q1 -- body hỏng --> D1[risk DLQ] --> A1[alarm]
  W[worker tắt] -. sự kiện chờ trong outbox .-> O
```

- **Ranh giới transaction và quyền:** không áp dụng. Cloud dùng quyền admin của người chạy (nhóm `dbs-admin`); việc ghi RDS để ép lỗi đi qua `dbs-migrate` (role `dbs_migrator`), không qua secret master.
- **Thay đổi cấp hệ thống:** docs/03 §17 và Demo 3 thêm liên kết.

## 4. Test cases tự động

Task docs-only: các lệnh local của kịch bản chính là test tự động đã có; task này kiểm chúng chạy được, lặp lại được và khớp tài liệu.

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-183-01 | DoD #1, #2 | grep | runbook có bốn mục (a)–(d), mỗi mục đủ sáu tiểu mục (Mục tiêu, local, cloud, mong đợi, xác nhận, dọn) |
| TC-183-02 | DoD #1 | grep đối chiếu | mỗi spec và mã `TC-125-01..03`, `TC-124-01..02`, `TC-010-01..03` trong tài liệu có trong `backend/test/services/` |
| TC-183-03 | DoD #1 | chạy thật, hai lần | `dlq-isolation` (4 test), `worker-recovery` (2), `consumer-poison` chạy lần 1 và lần 2 cho cùng kết quả (lặp lại được); sau đó không còn database `dbs_test_%` |
| TC-183-04 | DoD #3 | grep đối chiếu | tên queue, alarm, service, `reason`, action audit, bảng trong tài liệu có ở `sqs.tf`, `alarms.tf`, `consumer-base.ts`, `sqs.client.ts`, `audit.registry.ts`, migration |
| TC-183-05 | DoD #3 | link check | `check-doc-links.mjs` sạch |
| TC-183-06 | DoD #3 | quy trình | PR merge (sau #198), Dev review: làm ở PR |

## 5. Test thủ công (local thật; phần cloud chỉ kiểm tên và cú pháp với AWS, không chạy sự cố)

Điều kiện: Docker bật; Node 24 trên `PATH` (`engines.node` là `>=24`; trên máy này `node` mặc định là v18) và `npm ci` trong `backend/`; PostgreSQL 17 tạm cổng 55433 (cổng 5432 bị Postgres native chiếm); không `DATABASE_URL` từ shell khác; trên Git Bash đặt `MSYS_NO_PATHCONV=1` trước mọi lệnh `aws logs … --log-group-name /dbs/…`.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-183-01 | `dlq-isolation.services-spec.ts --verbose` | 4 test đạt (TC-125-01..03, TC-046-01): kịch bản (a), (b), (c) |
| M-183-02 | `worker-recovery.services-spec.ts --verbose` | TC-124-01..02 đạt: kịch bản (d) |
| M-183-03 | `consumer-poison.services-spec.ts --verbose` | TC-010-01..03 đạt: kịch bản (b) |
| M-183-04 | Chạy lại M-183-01, M-183-02 và M-183-03 lần hai; rồi `docker exec dbs183-pg psql -U test -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname LIKE 'dbs_test_%'"` | cùng số test đạt; số database tạm còn lại là `0` |
| M-183-05 | Kiểm tên trên AWS (chỉ đọc): `describe-alarms` hai alarm DLQ; `get-queue-url` bốn queue; `describe-services` không có cluster (không có phiên); cú pháp `aws ecs update-service help`, `aws ecs run-task help` | tên khớp; ghi rõ alarm `dbs-dev-outbox-age` và task `dbs-migrate` chỉ tồn tại khi có phiên (không kiểm được lúc này) |
| M-183-06 | `docker stop dbs183-pg` | không còn container tạm (`docker ps` không có `dbs183-pg`) |

## 6. Domain review (AI)

**Reviewer:** subagent, model Opus 5.5 (`opus`, effort medium), ngày 2026-11-15 · **Kết quả vòng 1:** 12 phát hiện (blocking 2, should-fix 5, minor 5), REVISE · [nguyên văn](screenshots/DBS-183/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | ép lỗi bằng `dbs-db-roles` (master): không khả thi (chủ bảng là `dbs_migrator`, master không phải superuser) và phá thiết kế không ghi đè | đã sửa §2, §3: dùng `dbs-migrate` (role `dbs_migrator`, chủ bảng), bỏ mọi nhắc secret master |
| 2 | blocking | body `{not json` không có dòng log `invalid_event` (`SqsClient` chuyển DLQ trước `ConsumerBase`); runbook DBS-164 mục 2b ghi sai | đã sửa §2 (b): hai message (không phải JSON: không log; sai schema: có log); đã sửa runbook DBS-164 trong PR #198 (`invalid_event` chỉ cho JSON sai schema, thêm dòng "không có dòng log nào") |
| 3 | should-fix | bỏ qua message hợp lệ mất thông báo; phụ thuộc #198 | đã sửa: gửi lại thân message theo runbook khi DLQ còn khóa; PR phụ thuộc #198 (đã ghi ở §2, TC-183-06) |
| 4 | should-fix | constraint chặn mọi INSERT `notification_log` của môi trường | đã sửa: nạp tiền trước, một chuyển tiền, chờ ≥ 1 message theo `eventId`, kiểm `pg_constraint`, không chạy khi người khác dùng phiên |
| 5 | should-fix | không có API đọc `notification_log` | đã sửa: xác nhận bằng audit `notification.sent` theo `correlationId` |
| 6 | should-fix | thiếu chi phí và dọn | đã thêm ngân sách thời gian, chi phí, `desired-count 1`, `destroy`, `verify-clean.sh` |
| 7 | should-fix | claim vượt quá test (tiền không đổi, TC-010, TC-124 chỉ risk) | đã sửa bảng local §2 |
| 8 | minor | `dlq-isolation` có 4 test; M-04 thiếu `consumer-poison` và lệnh kiểm database tạm | đã sửa §4, §5 |
| 9 | minor | `describe-task-definition` không dùng được khi không có phiên | đã sửa M-183-05 |
| 10 | minor | thứ tự đo 155 s và 139 s | đã sửa (155 s DBS-163 risk; 139 s DBS-164 notification) |
| 11 | minor | "DLQ về 0" không nói cách | đã sửa: xóa theo handle, không `purge` |
| 12 | minor | thiếu bảng bàn giao | sẽ có ở §8 |

**Vòng 2** ([nguyên văn](screenshots/DBS-183/domain-review-2.md)): 6 phát hiện (blocking 0, should-fix 2, minor 4), **APPROVE**; đã sửa hết:

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 2.1 | should-fix | tên container PostgreSQL không thống nhất | đã sửa: `dbs183-pg` ở §2 và §5, M-183-06 có lệnh `docker stop` |
| 2.2 | should-fix | dọn (a), (c) chỉ nói một message; constraint chặn mọi thông báo | đã sửa: xử lý mọi message `attempts_exhausted` của cửa sổ, ghi từng `eventId` |
| 2.3 | minor | `migrate.sh` từ chối khi còn task `dbs-migrate`; migration lúc constraint còn | đã thêm kiểm `list-tasks` rỗng trước ADD/DROP và không deploy tới khi DROP xong |
| 2.4 | minor | gửi lại mất `OriginalSentTimestamp` | đã sửa: `send-message --message-attributes` mang theo thuộc tính |
| 2.5 | minor | chi phí lệch README | đã sửa: 2 USD/ngày không task, 3,4 USD/ngày khi có task |
| 2.6 | minor | thiếu Node 24, `npm ci`, `MSYS_NO_PATHCONV` | đã thêm vào điều kiện §5 |

**Quyết định ở G2 (agent tự quyết):** (1) cloud (a) và (c) dùng `dbs-migrate` với ghi đè lệnh `node` chưa kiểm, DBS-184 xác nhận; (2) PR chỉ merge sau #198.

## 7. Kế hoạch triển khai

Task docs-only: "test viết trước" là các lệnh grep của TC-183-01, 02, 04 và lần chạy test dịch vụ của TC-183-03; "đỏ" là grep chưa ra gì vì runbook chưa tồn tại.

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `docs/runbooks/async-incident-scenarios.md` (mới; bốn kịch bản, sáu tiểu mục mỗi cái) | TC-183-01, 02, 04 | `ls docs/runbooks/async-incident-scenarios.md` báo không có file; `check-doc-links.mjs` báo 2 liên kết hỏng tới file này và tới feature doc DBS-164 (chờ #198) | các grep ở §4, `check-doc-links.mjs` | `docs(runbook): bốn kịch bản sự cố bất đồng bộ chạy lặp lại được (DBS-183)` |
| 2 | `docs/03_HIGH_LEVEL_ARCHITECTURE.md` §17, `docs/demos/demo-3-failure-recovery.md` (liên kết), `docs/features/README.md` | TC-183-05 | — | `check-doc-links.mjs` | `docs: nối kịch bản sự cố bất đồng bộ vào docs/03 và Demo 3 (DBS-183)` |
| 3 | `docs/features/screenshots/DBS-183/manual-test.txt` | M-183-01..06 | — | chạy ba spec hai lần với `--verbose`, kiểm database tạm, kiểm tên trên AWS | `docs(runbook): kết quả chạy local của kịch bản sự cố (DBS-183)` |
| 4 | feature doc §8–§9, `docs/BACKLOG.md` (bàn giao) | G4 | — | checklist G4 | `docs(features): hoàn tất DBS-183` |

- **Plan sweep:** hạn chế nêu trong docs: Demo 3 ("kill API giữa lệnh chờ DBS-185": ngoài phạm vi, ghi tên), BL-182 (số đo (d) cloud, dùng không đóng), BL-364 (kiểm log trên cloud: DBS-184), BL-362 (đường ghi RDS), quy tắc 6 ngày của runbook DLQ (ghi trong dọn dẹp (a), (c)), reviewer vòng 1 (hai blocking: bước 1), phụ thuộc #198 (rebase lên `main` sau khi #198 merge, bước trước G4). Không còn mục nào chưa có hàng kế hoạch.
- **Rủi ro và cách lùi:** (1) lệnh cloud viết từ tài liệu, chưa chạy: ghi rõ "chưa chạy trên cloud (DBS-184)" ở từng kịch bản và ở PR; (2) hai liên kết hỏng cho tới khi #198 merge: rebase và chạy lại link check trước G4; (3) test dịch vụ phụ thuộc Docker và Postgres tạm: dọn container cuối. Back-out: không đổi code, bỏ commit docs.
- **Quyết định ở G3 (agent tự quyết):** BL của task lấy dải 370–374 (BL-350, 351, 360–364 đã dùng).
