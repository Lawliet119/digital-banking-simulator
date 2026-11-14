# DBS-183 · Kịch bản sự cố phần bất đồng bộ (chạy lặp lại được)

> **Status:** Draft (đang làm, đến G2) · **Vai:** Dev (docs, chạy test) · **Cặp đôi review:** Dev khác · **Nhánh:** `docs/DBS-183-async-incident-scenarios` · **PR:** — · **Cập nhật:** 2026-11-15

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

Sản phẩm: [`docs/runbooks/async-incident-scenarios.md`](../runbooks/async-incident-scenarios.md). Bốn kịch bản, mỗi kịch bản có cùng sáu mục: **Mục tiêu**, **Chạy local (lặp lại được)**, **Chạy cloud (cho DBS-184)**, **Kết quả mong đợi**, **Cách xác nhận**, **Dọn để chạy lại**.

**Chạy local (chung).** Từ `backend/`, cần Docker (Testcontainers tự dựng ElasticMQ và Valkey) và một PostgreSQL 17 đang chạy làm máy chủ (mỗi test tạo database tạm riêng rồi xóa, nên lặp bao nhiêu lần cũng cho cùng kết quả):

```bash
docker run -d --rm --name dbs-pg -p 55433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test postgres:17 -c timezone=UTC
export DATABASE_URL=postgres://test:test@localhost:55433/postgres
npm run test:services -- --runInBand --runTestsByPath test/services/dlq-isolation.services-spec.ts --verbose
```

| Kịch bản | Spec (test) | Điều test chứng minh |
|---|---|---|
| (a) consumer lỗi liên tục → DLQ sau 5 lần + alarm | `dlq-isolation.services-spec.ts` TC-125-01 | notification lỗi mọi lần: message vào DLQ sau đúng 5 lần nhận; risk vẫn xử lý bình thường. Phần **alarm** không có ở local (CloudWatch): chỉ chạy trên cloud |
| (b) message hỏng → DLQ ngay | `dlq-isolation.services-spec.ts` TC-125-02; `consumer-poison.services-spec.ts` (TC-010-01) | body không phải JSON, sai schema hoặc loại sự kiện lạ vào DLQ ở lần nhận đầu; consumer khác không bị chặn |
| (c) notification chết → risk vẫn chạy, chuyển tiền không ảnh hưởng | `dlq-isolation.services-spec.ts` TC-125-01 và TC-125-03 | cờ rủi ro vẫn tạo khi notification lỗi; tiền không đổi; sau khi sửa, redrive đưa message về xử lý đúng một lần (TC-125-03) |
| (d) worker tắt rồi bật → outbox gửi bù | `worker-recovery.services-spec.ts` TC-124-01, TC-124-02 | worker dừng: chuyển tiền vẫn 201, sự kiện nằm chờ trong outbox; bật lại thì 6 cờ MEDIUM, mỗi cờ đúng một audit `fraud.flagged`, không trùng; consumer chết giữa lệnh nhận lại message, vẫn một decision |

**Chạy cloud (chung; DBS-184 chạy và ghi bằng chứng).** Cần phiên ECS và RDS đang chạy ([Dựng từ trạng thái trống](../../infra/terraform/README.md#dựng-từ-trạng-thái-trống-và-đo-thời-gian-dbs-139), 12 phút) và token của nhân viên, khách (kịch bản [demo giữa kỳ](../demos/demo-midterm-end-to-end.md)). Số liệu mong đợi lấy từ các lần đo đã có:

| Kịch bản | Ép sự cố | Mong đợi (đã đo ở đâu) | Xác nhận |
|---|---|---|---|
| (a) | ép notification lỗi mọi lần: `ALTER TABLE notification_log ADD CONSTRAINT dbs183_block CHECK (false) NOT VALID` bằng task ECS chạy một lần dùng secret master (xem bên dưới), rồi một chuyển tiền đạt ngưỡng | ≈ 150–155 s sau lệnh chuyển, `dbs-dev-notification-events-dlq` có 1 message (backoff 10+20+40+80 s, BL-210); alarm `dbs-dev-notification-dlq-not-empty` sang `ALARM` trong ≤ 5 phút kể từ lúc message vào DLQ (đã đo 139 s và 155 s ở DBS-163, DBS-164) | `get-queue-attributes` của DLQ; `describe-alarms`; log `/dbs/dev/worker` có dòng `dead_letter`, `reason: attempts_exhausted`, `receiveCount: 5` (BL-364: chưa kiểm trên log thật) |
| (b) | `send-message` thân `{not json` vào `dbs-dev-risk-events` (worker đang chạy) | vào `dbs-dev-risk-events-dlq` ở lần nhận đầu (vài giây); alarm `dbs-dev-risk-dlq-not-empty` sang `ALARM` ≤ 5 phút | `get-queue-attributes`; log `reason: invalid_event`, có `issueCodes`, không có body |
| (c) | cùng sự cố của (a), nhưng quan sát phía giao dịch | chuyển tiền trả 201 `COMPLETED`; cờ rủi ro xuất hiện (`GET /v1/operator/fraud-flags`) trong vài giây; không có thông báo cho giao dịch đó; bất biến sổ cái PASS | API; `invariants.js` bằng task ECS chạy một lần ([backend/README §9](../../backend/README.md)); DLQ risk 0 |
| (d) | `aws ecs update-service --cluster dbs-dev --service worker --desired-count 0`, chờ `runningCount` 0, chuyển N lệnh đạt ngưỡng, rồi `--desired-count 1` | chuyển tiền vẫn 201 khi worker tắt; `dbs-dev-outbox-age` sang `ALARM` sau ≈ 9 phút 22 giây (BL-182, đo 2026-11-14); bật lại: outbox xả trong ≈ 4 giây, đủ N cờ, mỗi cờ đúng một audit `fraud.flagged`, queue và DLQ về 0 | `GET /v1/operator/fraud-flags` và `GET /v1/audit/entries?action=fraud.flagged` (auditor); `get-queue-attributes` bốn queue; `describe-alarms` |

**Cách ép lỗi notification trên cloud (đề xuất, chưa kiểm; làm rõ ở DBS-184).** Ops không có đường ghi vào RDS (BL-362). Phương án: task ECS chạy một lần từ family `dbs-db-roles` (đã có secret master và `DATABASE_URL` ghép từ `DB_*`), ghi đè `command` bằng một lệnh `node` chạy câu `ALTER TABLE` ở trên (và `DROP CONSTRAINT` để khôi phục), theo cách `seed-cloud.sh` ghi đè lệnh. DBS-184 phải xác nhận lệnh `node` nạp đúng `env.bootstrap` và task role đủ quyền; nếu không làm được thì (a) và (c) trên cloud ghi **chưa chạy** kèm lý do, (b) và (d) không cần ghi RDS nên vẫn chạy. Việc có một lệnh ép lỗi chính thức là bàn giao (§8).

**Quy tắc 6 ngày của DLQ.** Mọi lần redrive thật làm DLQ đó không được redrive lại trong 6 ngày ([runbook DLQ](../runbooks/dlq-redrive.md)); kịch bản (a) và (c) kết thúc bằng bước xử lý DLQ, nên mặc định **bỏ qua có ghi nhận** (mục 3c của runbook) thay vì redrive, trừ khi cố tình thử redrive và chấp nhận khóa DLQ đó 6 ngày (hiện DLQ notification khóa tới 2026-11-21, DLQ risk tới 2026-11-20).

**Dọn để chạy lại.** (a), (c): `DROP CONSTRAINT dbs183_block`, DLQ về 0 (bỏ qua có ghi nhận); (b): DLQ về 0; (d): `desired-count 1`, outbox rỗng. Local: không cần dọn (database tạm tự xóa), chỉ dừng container PostgreSQL.

## 3. Kiến trúc

- **Vị trí:** `docs/runbooks/async-incident-scenarios.md` (mới); `docs/03_HIGH_LEVEL_ARCHITECTURE.md` §17 (một liên kết ở dòng "Failure / recovery"), `docs/demos/demo-3-failure-recovery.md` (liên kết), `docs/features/README.md`, `docs/BACKLOG.md`. Không đổi code, Terraform, hợp đồng sự kiện hay `ErrorCode`.
- **Dữ liệu chạm tới (đọc để đối chiếu):** `outbox_events`, `processed_events`, `notification_log`, `risk_decisions`, `fraud_flags`, `audit_log` (`fraud.flagged`); hàng đợi `dbs-dev-{risk,notification}-events` và `-dlq`; alarm `dbs-dev-{risk,notification}-dlq-not-empty`, `dbs-dev-outbox-age`; ECS service `worker` của cluster `dbs-dev`; `ConsumerBase` (`MAX_ATTEMPTS = 5`, backoff 10/20/40/80 s).
- **Luồng:**

```mermaid
flowchart LR
  T[Chuyển tiền 201] --> O[(outbox_events)]
  O -- relay trong worker --> Q1[risk-events] --> R[risk consumer] --> F[cờ + audit fraud.flagged]
  O -- relay trong worker --> Q2[notification-events] --> N[notification consumer]
  N -- lỗi 5 lần --> D2[notification DLQ] --> A2[alarm]
  Q1 -- thân hỏng --> D1[risk DLQ] --> A1[alarm]
  W[worker tắt] -. sự kiện chờ trong outbox .-> O
```

- **Ranh giới transaction và quyền:** không áp dụng. Cloud dùng quyền admin của người chạy (nhóm `dbs-admin`).
- **Thay đổi cấp hệ thống:** docs/03 §17 thêm liên kết; Demo 3 thêm liên kết.

## 4. Test cases tự động

Task docs-only: các lệnh local của kịch bản chính là test tự động đã có; task này kiểm chúng chạy được, lặp lại được và khớp tài liệu.

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-183-01 | DoD #1, #2 | grep | runbook có bốn mục (a)–(d), mỗi mục đủ sáu tiểu mục (Mục tiêu, local, cloud, mong đợi, xác nhận, dọn) |
| TC-183-02 | DoD #1 | grep đối chiếu | mỗi spec và mã `TC-125-01..03`, `TC-124-01..02` trong tài liệu có trong thư mục `backend/test/services/` |
| TC-183-03 | DoD #1 | chạy thật, hai lần | `dlq-isolation`, `worker-recovery`, `consumer-poison` chạy lần 1 và lần 2 cho cùng kết quả (lặp lại được) |
| TC-183-04 | DoD #3 | grep đối chiếu | tên queue, alarm, service, `reason`, action audit, mã lỗi, bảng trong tài liệu có ở `sqs.tf`, `alarms.tf`, `consumer-base.ts`, `audit.registry.ts`, migration |
| TC-183-05 | DoD #3 | link check | `check-doc-links.mjs` sạch |
| TC-183-06 | DoD #3 | quy trình | PR merge, Dev review: làm ở PR |

## 5. Test thủ công (local thật; phần cloud chỉ kiểm cú pháp và tên với AWS, không chạy sự cố)

Điều kiện: Docker bật; PostgreSQL 17 tạm cổng 55433 (cổng 5432 bị Postgres native chiếm); không `DATABASE_URL` từ shell khác.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-183-01 | `dlq-isolation.services-spec.ts --verbose` | TC-125-01..03 đạt (kịch bản a, b, c) |
| M-183-02 | `worker-recovery.services-spec.ts --verbose` | TC-124-01..02 đạt (kịch bản d) |
| M-183-03 | `consumer-poison.services-spec.ts --verbose` | đạt (kịch bản b) |
| M-183-04 | Chạy lại M-183-01 và M-183-02 lần hai | cùng số test đạt, không dư database tạm (lặp lại được) |
| M-183-05 | Kiểm tên trên AWS (chỉ đọc): `describe-alarms` hai alarm DLQ, `get-queue-url` bốn queue, `describe-task-definition dbs-db-roles` (family có thật dù session đã xóa?), cú pháp `aws ecs update-service help` | tên khớp; kết quả task def ghi đúng thực tế |
| M-183-06 | Dừng container PostgreSQL | không còn container tạm |
