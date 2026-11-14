# DBS-135 · AC-8.2: tra theo correlationId thấy đủ chuỗi trong dưới 5 phút

> **Status:** Implemented (G4 2026-11-10) · **Vai:** Dev · **Cặp đôi review:** Dev khác (theo team.md) · **Nhánh:** `feat/DBS-135-trace-by-correlation-id` · **PR:** — · **Cập nhật:** 2026-11-10

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 5, High, Demo 4. **Expect:** «Kiểm toán viên tra trọn một giao dịch bằng một mã.»
- **Thực trạng (board):** «Chưa có test chứng minh chuỗi yêu cầu → ghi sổ → thông báo → cờ → review truy được bằng một mã.»
- **DoD (chép nguyên văn):**
  1. Test e2e: giao dịch hoàn tất, có cờ, được review → auditor tra theo correlationId thấy đủ chuỗi
  2. Truy vấn dùng Index Scan trên audit_log (correlation_id), ≤ 10 ms
  3. Đo thời gian thao tác tay từ khi nhận mã tới khi thấy đủ chuỗi: < 5 phút (ghi lại)
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **AC liên quan (BRD):** AC-8.2 «Một giao dịch đã hoàn tất · Kiểm toán viên tra theo mã liên kết · Thấy đủ chuỗi: yêu cầu → ghi sổ → thông báo → (cờ → review)»; NFR-AUD-02 «Truy vết một giao dịch end-to-end < 5 phút».
- **Phụ thuộc (đã xác minh trong `main` `98cdb30`):** DBS-134 (correlationId qua outbox/SQS/consumer, `notification_log.correlation_id`), DBS-103 (`GET /v1/audit/entries?correlationId=`, index `audit_log_correlation_idx`), DBS-111 (consumer ghi audit `fraud.flagged` với `event.correlationId`). Cả ba Done và có code.
- **Đã có gì (đã đọc code, chạy test):**
  - `transfers.correlation_id` và audit `transfer`/`deposit` cùng id của request; `outbox_events.correlation_id` và payload cùng id (DBS-134).
  - Auditor tra được theo `correlationId`; truy vấn dùng `Index Scan` trên `audit_log_correlation_idx`, đã có test plan trên ≥ 50.000 dòng: TC-103-18 trong `test/db/audit-search.db-spec.ts` («real service SQL chooses the correlation index in all five warm <=10ms plans»).
  - `RiskScoringConsumer.apply` ghi `fraud.flagged` với `event.correlationId`; TC-111-13 kiểm `audit_log.correlation_id = transfers.correlation_id`.
  - Hạ tầng test: `startDepositApp(..., { fraud: true })`, `buildRiskConsumer`, `riskFixtures`, ElasticMQ container, `correlation-chain.services-spec.ts` (DBS-134). `startDepositApp` **chưa** nạp `AuditHttpModule` (domain review #4): task thêm option.
- **Khoảng trống thật (đã xác minh bằng đọc code và grep):**
  1. **Bước «review» không nằm dưới mã của giao dịch.** `FraudHttpService.review` ghi `fraud_flag.review` với `correlationId` của chính request review (`fraud-http.service.ts:102-133`).
  2. **Bước «thông báo» không có dòng nào trong `audit_log`.** `NotificationConsumer.apply` chỉ ghi `notification_log`; auditor chỉ đọc `audit_log` qua UC-8.
  3. Chưa có test xuyên chuỗi gồm cờ và review, chưa có số đo thao tác tay (DoD 1, 3).
- **Baseline (2026-11-10, `main` `98cdb30`, Node 24):** `lint:check` sạch; `typecheck` sạch; `npm test` 103 suite / 1824 test đạt; `test:e2e` 17 suite / 163 test đạt (`DATABASE_URL=postgres://test:test@localhost:55433/postgres`, Postgres 17 tạm).
- **Backlog:** không có dòng `BL-NNN` cùng module/DoD cần nhận; BL-024 mục (1) đã đóng ở DBS-134.
- **Ngoài phạm vi:** đổi quyền đọc của auditor; cột `correlation_id` cho `risk_decisions` (ADR-14); tra quyết định LOW; đo trên RDS và dashboard (BL-198, Ops); đổi hợp đồng event; đổi schema bảng nào.
- **Quyết định ở G1 (agent tự quyết):**
  1. Review ghi audit dưới mã của giao dịch gốc, vì Expect là «tra trọn một giao dịch bằng một mã» và DBS-134 định nghĩa `correlationId` là mã nối chuỗi xử lý của một giao dịch.
  2. Consumer thông báo ghi thêm một dòng audit `notification.sent` mỗi event, trong cùng transaction với `notification_log`.
  3. DoD 2 đã có TC-103-18: không viết test trùng, chạy lại lúc bàn giao.
  4. Đo DoD 3 bằng thao tác tay `curl` trên API thật.

## 2. Hành vi

Một giao dịch có một mã `C` = `correlationId` do server sinh ở request chuyển tiền (header `X-Correlation-Id` của phản hồi `POST /v1/transfers`). Mọi bước của chuỗi ghi dòng `audit_log` dưới đúng `C`. **Định nghĩa mới:** `audit_log.correlation_id` là mã chuỗi của giao dịch mà hành động gắn vào; hành động không gắn giao dịch (xem danh sách, tra cứu) vẫn dùng mã của request.

| Bước AC-8.2 | Dòng audit dưới `C` | Ghi bởi |
|---|---|---|
| Yêu cầu + ghi sổ | `transfer` / `SUCCESS` (cùng transaction với hai bút toán ledger nên là bằng chứng ghi sổ; auditor không đọc `ledger_entries`) | API, đã có |
| Thông báo | `notification.sent` / `SUCCESS` | worker, **mới** |
| Cờ | `fraud.flagged` / `SUCCESS` | worker, đã có |
| Review | `fraud_flag.review` / `SUCCESS` | API, **đổi mã** |

| # | Điều kiện | Kết quả |
|---|---|---|
| H1 | Khách `POST /v1/transfers` thành công | Dòng `transfer` dưới `C`, `metadata: {id: <toAccountId>}` (đã có, DBS-61/134) |
| H2 | Consumer thông báo xử lý event `TransferCompleted` hoặc `AccountStatusChanged` lần đầu | Cùng transaction với `notification_log`: một dòng audit `actor=null`, `role='worker'`, `action='notification.sent'`, `outcome='SUCCESS'`, `target={type:'transfer'` hoặc `'account'`, `id}`, `correlationId=event.correlationId`, `metadata={count: số thông báo}`. Không lý do, không câu chữ thông báo (BR-13) |
| H3 | Event nhận lại (SQS giao lại hoặc relay gửi trùng, cùng `eventId`) | `processed_events` chặn: không thêm dòng `notification_log` lẫn audit |
| H4 | Audit INSERT của H2 lỗi | Cả transaction rollback: không `notification_log`, không claim `processed_events`; message không được ack, lần nhận sau xử lý lại (tối đa 5 lần rồi DLQ, ConsumerBase). Hệ quả mới: lỗi audit chặn thông báo (fail-closed, FR-AUD-01) |
| H5 | Consumer chấm điểm tạo cờ | Dòng `fraud.flagged` dưới `C` (đã có, DBS-111) |
| H6 | Operator `POST /v1/operator/fraud-flags/{transferId}/review` lần đầu | Dòng `fraud_flag.review` dưới `C`, `metadata: {reason, id: <mã request review>}` (`id` UUID được metadata guard cho phép; giữ liên kết với log pino-http, header và problem+json của request review). Header `X-Correlation-Id` của phản hồi vẫn là mã request review (khác `C`). `C` lấy qua hàm export của module ledger (§3), trong cùng transaction với UPDATE. Nếu hàm trả `undefined` (không thể xảy ra sau UPDATE thành công vì khóa ngoại) thì ném lỗi nội bộ: transaction rollback, API trả 500; **không bao giờ** rơi về mã request |
| H7 | Review lần hai | 409 `FLAG_ALREADY_REVIEWED`, không thêm dòng audit (đã có, DBS-130) |
| H8 | `fraud_flag.view` và `fraud_flag.search` | Ban đầu không đổi, vẫn dưới mã request (Quyết định G2 #3). **Cập nhật BL-226:** `fraud_flag.view` ghi dưới `C` với `metadata: {id: <mã request xem>}` (cùng cơ chế H6); `fraud_flag.search` vẫn dưới mã request vì một danh sách không gắn một giao dịch |
| H9 | Auditor `GET /v1/audit/entries?correlationId=C` | 200, `entries` đúng 4 dòng của chuỗi, mới nhất trước. Dòng `audit.search` của chính lần tra cứu nằm dưới mã server của request tra cứu, không dưới `C` (DBS-103) |
| H10 | Tra mã không tồn tại | 200, `entries: []`, `nextCursor: null`, vẫn ghi `audit.search` |
| H11 | Client gửi `X-Correlation-Id` tự chọn ở transfer hoặc review | Bị bỏ qua; mã do server sinh (DBS-134 H1) |
| H12 | Customer hoặc operator gọi `GET /v1/audit/entries` | 403 `FORBIDDEN` (đã có, DBS-103) |

Ví dụ phản hồi H9 (rút gọn, mới nhất trước; hình dạng theo `AuditEntriesPage`):

```json
{ "entries": [
  { "action": "fraud_flag.review", "outcome": "SUCCESS", "actorRole": "operator", "target": { "type": "fraud_flag", "id": "<transferId>" }, "correlationId": "<C>", "metadata": { "reason": "CONFIRMED_FRAUD", "id": "<mã request review>" } },
  { "action": "fraud.flagged", "outcome": "SUCCESS", "actorRole": "worker", "target": { "type": "transfer", "id": "<transferId>" }, "correlationId": "<C>", "metadata": { "count": 2 } },
  { "action": "notification.sent", "outcome": "SUCCESS", "actorRole": "worker", "target": { "type": "transfer", "id": "<transferId>" }, "correlationId": "<C>", "metadata": { "count": 2 } },
  { "action": "transfer", "outcome": "SUCCESS", "actorRole": "customer", "target": { "type": "transfer", "id": "<transferId>" }, "correlationId": "<C>", "metadata": { "id": "<toAccountId>" } } ],
  "nextCursor": null }
```

Mỗi dòng còn có `id`, `occurredAt`, `actorUserId`. Thứ tự giữa `notification.sent` và `fraud.flagged` phụ thuộc consumer nào chạy trước, không cam kết. Chỉ `transfer` là sớm nhất và `fraud_flag.review` là muộn nhất.

## 3. Kiến trúc

- **Vị trí và role:** `modules/notification` (worker), `modules/risk/fraud-http.service.ts` (api), `modules/ledger` (thêm một hàm export), `test/support/deposit-app.ts` (option mới). Không đổi schema.
- **Interface:**
  - `NotificationConsumer` nhận thêm `AuditService` ở constructor; `NotificationModule` import `AuditModule`. **Nơi gọi `new …NotificationConsumer(` phải sửa (đã grep):** `test/db/notification-consumer.db-spec.ts:45`, `test/services/outbox-relay.services-spec.ts:86`, `outbox-relay-faults.services-spec.ts:414`, `notification-consumer-review.services-spec.ts:51`, `correlation-chain.services-spec.ts:121` (lớp `FlakyNotificationConsumer`), `dlq-isolation.services-spec.ts:181` (`TestNotification`), `test/manual/notification-consumer.manual.ts:47`, `test/manual/notification-consumer-review.manual.ts:59`.
  - `modules/ledger` export `transferCorrelationId(manager: EntityManager, transferId: string): Promise<string | undefined>` (`SELECT correlation_id FROM transfers WHERE id = $1`, khóa chính). `risk` gọi hàm này, không đọc bảng `transfers` (database-design §3 quy tắc 9, §8.2). `FraudHttpService.review` giữ chữ ký; tham số `correlationId` (mã request) chuyển vào `metadata.id`.
  - `startDepositApp(url, { audit: true })` nạp thêm `AuditHttpModule`.
  - `riskFixtures.transfer` (`test/support/risk-consumer.ts`) chỉ trả `transferId` và không gửi thêm header: TC-135-01 và TC-135-03 gọi `POST /v1/transfers` trực tiếp bằng supertest (đọc `C` từ header phản hồi, gửi `X-Correlation-Id` giả); các việc khác dùng `riskFixtures` nguyên trạng, không sửa file dùng chung này.
- **Dữ liệu:** `audit_log` (chỉ INSERT; `dbs_worker` đã có INSERT như với `fraud.flagged`; `dbs_api` đã ghi audit review). Tra cứu dùng `audit_log_correlation_idx`. Không bảng, cột, index mới.
- **Dung lượng:** thêm một dòng `audit_log` mỗi event thông báo, tức khoảng một dòng mỗi giao dịch hoàn tất (và mỗi lần khóa/mở khóa); `audit_log` có 3 index và không xóa được. Ở tải thiết kế (≈ 10.000 lệnh chuyển/ngày, database-design §6.3) là khoảng 10.000 dòng/ngày tăng thêm (cộng khoảng 20.000 dòng `ledger_entries`), không đáng kể; cận trên theo ADR-14 (120 RPS liên tục, toàn bộ là chuyển tiền) là khoảng 10,4 triệu dòng/ngày. Đọc và từ chối quyền đã ghi audit sẵn (FR-AUD-02) nên không nói «nhân đôi». Ghi cả hai con số vào `database-design.md` §4.7; phân vùng hoặc lưu trữ khi tải thật tiến gần cận trên là việc của #3/#5, bàn giao qua BL.
- **Ranh giới transaction:** audit và `notification_log` cùng transaction của `ConsumerBase` (sau claim `processed_events`); audit review cùng transaction với UPDATE `fraud_flags`. Không gọi SQS/HTTP trong transaction.
- **Sơ đồ:**

```mermaid
sequenceDiagram
  participant K as Khách
  participant A as API
  participant DB as PostgreSQL
  participant W as Worker (relay, notification, risk)
  participant O as Operator
  participant U as Auditor
  K->>A: POST /v1/transfers (mã C do server sinh)
  A->>DB: transfers(C) + audit transfer(C) + outbox(C)
  W->>DB: notification_log(C) + audit notification.sent(C)
  W->>DB: fraud_flags + audit fraud.flagged(C)
  O->>A: POST /operator/fraud-flags/{id}/review
  A->>DB: audit fraud_flag.review(C từ ledger, metadata.id = mã request)
  U->>A: GET /v1/audit/entries?correlationId=C
  A->>DB: Index Scan audit_log_correlation_idx
  A-->>U: 4 dòng của chuỗi
```

- **Thay đổi cấp hệ thống:** `database-design.md` (§4.7 định nghĩa `correlation_id` và dung lượng; §6 nguồn các dòng), docs/03 (UC-8, chuỗi audit, action registry), `modules/notification/README.md`, `modules/audit/README.md` (đăng ký action `notification.sent`), `modules/ledger/README.md` (hàm export), doc DBS-129-130 (mã audit review). Không đổi ADR: ADR-14 §Audit chỉ nói về nhánh fraud và việc auditor không đọc `risk_decisions`; `notification.sent` không mâu thuẫn.

## 4. Test cases tự động

Lớp «services»: `npm run test:services` (PostgreSQL và ElasticMQ thật bằng Testcontainers; không cần Valkey vì `buildRiskConsumer` dùng `downRedis`). Điều khiển từng bước (`relayOnce`, `consumeOnce(0)`), không sleep. File mới `test/services/audit-trace.services-spec.ts` và thêm một bước vào `.github/workflows/ci.yml` (CI chạy từng path).

| ID | Truy vết | Lớp | Given · When · Then | `errorCode` |
|---|---|---|---|---|
| TC-135-01 | DoD 1, AC-8.2 | services (HTTP thật + PostgreSQL + ElasticMQ) | Hai khách khác `sub`: An (21.000.000đ) chuyển 20.000.000đ cho Bình → relay gửi → notification và risk consume → cờ MEDIUM (R3 + R6 = 65) → operator review `CONFIRMED_FRAUD` → auditor tra `?correlationId=C`: đúng 4 `entries`, `action` {`transfer`, `notification.sent`, `fraud.flagged`, `fraud_flag.review`}, cùng `C`, `target.id` là giao dịch, `transfer` sớm nhất và `fraud_flag.review` muộn nhất | — |
| TC-135-02 | AC-8.2, BR-13 | như TC-135-01 | Metadata: `transfer` chỉ `id`; `notification.sent` và `fraud.flagged` chỉ `count`; `fraud_flag.review` chỉ `reason` và `id`; không có `note` của review, rule, điểm hay `riskLevel` ở bất kỳ dòng nào | — |
| TC-135-03 | DoD 1, H6, H11 | như TC-135-01 | Header `X-Correlation-Id` của phản hồi review khác `C`; `fraud_flag.review.metadata.id` bằng đúng header đó; transfer và review gửi `X-Correlation-Id` tự chọn thì không dòng audit nào mang giá trị đó | — |
| TC-135-04 | H10 | như TC-135-01 | Tra UUID chưa từng dùng: `entries` rỗng; tra `C` lần nữa: vẫn đúng 4 dòng (các `audit.search` không lẫn vào `C`) | — |
| TC-135-05 | H7 | như TC-135-01 | Review lần hai trả 409 và tra lại vẫn 4 dòng | `FLAG_ALREADY_REVIEWED` |
| TC-135-06 | H2, BR-13 | integration PostgreSQL (`test/db/notification-consumer.db-spec.ts`) | `TransferCompleted` TRANSFER hai chủ → 2 dòng `notification_log` và **một** dòng audit `notification.sent`: `actor` NULL, `role` worker, target transfer, `count` 2, đúng `correlation_id` | — |
| TC-135-07 | H2 | integration | `AccountStatusChanged` → target `account`, `count` 1; DEPOSIT → target transfer, `count` 1; chuyển cho chính mình → `count` 1 | — |
| TC-135-08 | H3 | integration | Cùng `eventId` xử lý hai lần (SQS giao lại; relay gửi trùng): đúng 1 dòng audit và 1 dòng `notification_log` mỗi thông báo | — |
| TC-135-09 | H4 | integration | Trigger chặn INSERT `audit_log` có `action='notification.sent'`: `handle` ném lỗi, không `notification_log`, không `processed_events`; bỏ trigger rồi nhận lại: xử lý thành công, đúng 1 dòng audit | — |
| TC-135-10 | H6, DBS-130 | integration PostgreSQL thật (`test/db/fraud-operator-http.db-spec.ts`: thêm assertion về `correlation_id`, và **sửa hai test đang `toEqual` metadata `{reason}`**: «allows exactly one simultaneous review with correct actor and exactly one audit, no outbox» (dòng 318-331) và «audits actor and exact conclusion for %s without the private note» (dòng 355-367); metadata mới là `{reason, id}` với `id` = `X-Correlation-Id` của request) | Review ghi `fraud_flag.review` có `correlation_id = transfers.correlation_id`, `metadata.id` = mã request, kể cả khi API chạy bằng role `dbs_api` quyền tối thiểu (đường hiện có ở file này) | — |
| TC-135-11 | H6 | unit | `transferCorrelationId` trả `undefined` cho id không có; `FraudHttpService.review` không đọc bảng `transfers` (không chuỗi `FROM transfers` trong `risk/`, kiểm bằng grep ở §8) | — |
| TC-135-12 | DoD 2 | integration (đã có) | TC-103-18: `Index Scan` trên `audit_log_correlation_idx`, ≤ 10 ms, năm lượt warm. Chạy lại lúc bàn giao | — |
| TC-135-13 | H12 | integration (đã có) | Customer/operator gọi `GET /v1/audit/entries` → 403 (test DBS-103 hiện có, chạy lại) | `FORBIDDEN` |
| TC-135-14 | DoD 4 | quy trình | PR merge, CI xanh, Dev review, bảng đối chiếu | — |

**Test hiện có bị ảnh hưởng (đã grep):** không test nào đếm dòng audit mà vỡ khi thêm `notification.sent` (TC-134-04 đếm trước khi consumer chạy, TC-134-07 dùng `>= 1`). Hai test `fraud-operator-http.db-spec.ts` ở TC-135-10 vỡ vì hình dạng metadata của review và được sửa trong task này. Sẽ chạy lại các spec ở danh sách §3 và toàn bộ `fraud-operator-http.db-spec.ts` để chứng minh.

**Security checklist:** vai đúng ở endpoint (TC-135-13); không lộ cờ cho khách (TC-135-02; nội dung thông báo không đổi); lỗi không lộ nội bộ (DBS-103); SQL tham số hóa (SELECT khóa chính, truy vấn audit đã có); không secret trong log (không đổi). Tra theo mã không cần ownership vì chỉ auditor.

## 5. Test thủ công

Điều kiện (từ gốc repo): `docker compose up -d`; trong `backend/`: `cp env/.env.example env/.env.development`, đặt cả hai dòng `AUTH_MODE=local` và `AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json` (bỏ qua các dòng `COGNITO_*`; thiếu dòng thứ hai thì API và worker từ chối khởi động), `npm run auth:dev-keys`, `npm run migration:run`; `npm run build` một lần rồi mở hai terminal `APP_ROLE=api node dist/main` và `APP_ROLE=worker node dist/main` (không dùng hai `nest start --watch`: cả hai xóa và dựng lại `dist`, đã gặp ở DBS-111). Token: `npm run --silent auth:dev-token -- --role <customer|operator|auditor> --sub <tên>` (README §10; hai khách phải có `sub` khác nhau, nếu cùng `sub` thì `sameOwner` miễn R6 và không có cờ). Mọi lệnh nạp và chuyển có header `Idempotency-Key` (UUID mới). Chạy bằng Git Bash, ghi vào `docs/features/screenshots/DBS-135/manual-test.txt`. `psql` chỉ để kiểm tra, ngoài phần bấm giờ.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-135-00 | `psql`: rule set mới nhất có `mode` `rule_only` hoặc đang bật AI | ghi lại; rule-only cho điểm 65 |
| M-135-01 | Onboard Trần Văn An (`--sub tran-van-an`) và Nguyễn Thị Bình (`--sub nguyen-thi-binh`), mở tài khoản CHECKING mỗi người; operator nạp 21.000.000đ cho An | 200/201, số dư An 21.000.000 |
| M-135-02 | An `POST /v1/transfers` 20.000.000đ sang Bình, gửi kèm `X-Correlation-Id: aaaaaaaa-0000-4000-8000-000000000001` | 201; header phản hồi **khác** giá trị gửi; ghi `C` |
| M-135-03 | Vài giây sau, `psql`: `SELECT action, correlation_id FROM audit_log WHERE correlation_id='<C>'` | có `transfer`, `notification.sent`, `fraud.flagged` |
| M-135-04 | Operator `POST /v1/operator/fraud-flags/<transferId>/review` `CONFIRMED_FRAUD` | 200; header khác `C` |
| M-135-05 | **Bấm giờ:** T0 = lúc auditor nhận được `C` (chuỗi và review đã xong). Auditor `GET /v1/audit/entries?correlationId=<C>` bằng `curl`; T1 = lúc thấy đủ | đúng 4 `entries` như H9, `fraud_flag.review` đầu tiên; ghi T1−T0 (mục tiêu < 5 phút) |
| M-135-06 | Ca biên: auditor tra UUID lạ; customer và operator gọi cùng endpoint | `entries: []`; 403 `FORBIDDEN` |
| M-135-07 | Ca biên: gửi review lần hai | 409 `FLAG_ALREADY_REVIEWED`; tra lại vẫn 4 dòng |
| M-135-08 | Phục hồi: dừng riêng process worker (Ctrl+C ở terminal worker, API vẫn chạy); operator nạp thêm 21.000.000đ cho An rồi An chuyển 20.000.000đ nữa cho Bình; tra mã mới | chỉ có `transfer`; chạy lại `APP_ROLE=worker node dist/main`, tra lại: thêm `notification.sent` và `fraud.flagged`, không dòng nào bị nhân đôi |

## 6. Domain review (AI)

**Reviewer:** subagent, model opus, 2026-11-10 · **Lượt 1:** 14 phát hiện (1 blocking, 7 should-fix, 6 minor), Verdict: REVISE · **Lượt 2:** 6 phát hiện (0 blocking, 3 should-fix, 3 minor), Verdict: REVISE (không blocking) · [trả lời nguyên văn cả hai lượt](screenshots/DBS-135/domain-review.md)

| # | Mức | Phát hiện (rút gọn) | Xử lý |
|---|---|---|---|
| 1 | blocking | `risk` không được đọc bảng `transfers` | đã sửa §3: `ledger` export `transferCorrelationId`; TC-135-11 |
| 2 | should-fix | Review dưới `C` làm đứt liên kết với mã request | đã sửa §2 H6, §3: `metadata.id` giữ mã request; định nghĩa `correlation_id` mới ghi vào `database-design.md` §4.7; TC-135-03, TC-135-10 (assertion thêm mới) |
| 3 | should-fix | Hình dạng phản hồi sai (`entries`, `actorRole`, `target`, metadata của `transfer`) | đã sửa §2, §4, §5 |
| 4 | should-fix | `startDepositApp` thiếu `AuditHttpModule`; sai tên lớp test; CI | đã sửa §3, §4: option `audit`, lớp services, file mới và bước CI |
| 5 | should-fix | Fail-closed kiểm sai chiều | đã sửa H4, TC-135-09 (trigger chặn audit INSERT) |
| 6 | should-fix | Hai khách cùng `sub` → không có cờ; thiếu Idempotency-Key và bước cấu hình | đã sửa §5 |
| 7 | should-fix | `APP_ROLE=both` không dừng riêng được worker | đã sửa §5: hai terminal |
| 8 | should-fix | Cửa sổ bấm giờ sai | đã sửa M-135-05: T0 là lúc auditor nhận mã |
| 9 | minor | Danh sách nơi gọi constructor và test không vỡ | đã sửa §3, §4 (đã grep) |
| 10 | minor | «Ghi sổ» chỉ là một dòng `transfer` | đã sửa §2: bảng bước AC-8.2 nêu lý do |
| 11 | minor | ADR-14 bị dẫn rộng; đăng ký action | đã sửa §3: bỏ ý định sửa ADR; ghi `audit/README` |
| 12 | minor | Dung lượng audit | đã sửa §3 và `database-design.md` |
| 13 | minor | TC-135-08 «bản sao khác `eventId`» | đã sửa TC-135-08 |
| 14 | minor | Cột `errorCode` TC-135-09 | đã sửa |

**Lượt 2** (đã kiểm từng phát hiện với code):

| # | Mức | Phát hiện (rút gọn) | Xử lý |
|---|---|---|---|
| R2-1 | should-fix | `metadata.id` làm vỡ hai test `toEqual({reason})` trong `fraud-operator-http.db-spec.ts` | đã sửa §4 TC-135-10 và câu «test bị ảnh hưởng» |
| R2-2 | should-fix | Thiếu `AUTH_LOCAL_JWKS_PATH` thì API/worker không khởi động | đã sửa §5 |
| R2-3 | should-fix | Hai `nest start --watch` va chạm trên `dist` (`deleteOutDir`) | đã sửa §5: build một lần, hai `node dist/main` |
| R2-4 | minor | Con số dung lượng sai ngữ cảnh, không có «nhân đôi» | đã sửa §3 |
| R2-5 | minor | Chưa nói `review` làm gì khi `transferCorrelationId` trả `undefined` | đã sửa H6: lỗi nội bộ, không rơi về mã request |
| R2-6 | minor | `riskFixtures.transfer` không gửi header | đã sửa §3: TC-135-01 và TC-135-03 gọi supertest trực tiếp |

Lượt 2 không có phát hiện blocking, mọi phát hiện đã sửa bằng thay đổi văn bản hẹp (không đổi thiết kế); không chạy lượt 3.

**Quyết định ở G2 (agent tự quyết):**
1. Giữ quyết định review dưới mã giao dịch (không để hai mã riêng), kèm `metadata.id` = mã request review để không mất liên kết với log. Đây là thay đổi hành vi của DBS-130 ở module #4 và định nghĩa trong §4.7 của #3: ghi vào mô tả PR để owner duyệt.
2. `notification.sent` được đăng ký là action mới trong `audit/README`, không sửa ADR.
3. `fraud_flag.view` giữ mã request: một lượt xem không phải bước của chuỗi giao dịch AC-8.2. Bàn giao nếu auditor muốn thấy cả lượt xem dưới `C` (BL ở §8). **Đã đổi ở BL-226 (techlead quyết định):** lượt xem nằm trong chuỗi dưới `C`, `metadata.id` giữ mã request; `fraud_flag.search` vẫn dưới mã request.
4. Test mới nằm ở `audit-trace.services-spec.ts` (không sửa file của DBS-134) kèm bước CI.

## 7. Kế hoạch triển khai

Mọi bước: viết test trước, chạy, ghi một dòng đỏ, viết mã tối thiểu, chạy xanh, commit. Chạy từ `backend/` với Node 24; services spec cần Docker. Dùng `DATABASE_URL=postgres://test:test@localhost:55433/postgres` cho `test:e2e`; `test:db` và `test:services` tự dựng container (bỏ `DATABASE_URL`).

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `test/support/deposit-app.ts` (option `audit`), `test/services/audit-trace.services-spec.ts` (mới) | TC-135-01..05 | (điền) | `npm run test:services -- --runInBand --runTestsByPath test/services/audit-trace.services-spec.ts` | `test(audit): chain trace spec for AC-8.2 (DBS-135)` |
| 2 | `test/db/notification-consumer.db-spec.ts`; sau khi đỏ: `src/modules/notification/notification.consumer.ts`, `notification.module.ts` | TC-135-06, 07, 08, 09 | (điền) | `npm run test:db -- test/db/notification-consumer.db-spec.ts` | `feat(notification): audit every notification event under its correlationId (DBS-135)` |
| 3 | Sửa 7 nơi gọi còn lại: `test/services/outbox-relay.services-spec.ts:86`, `outbox-relay-faults.services-spec.ts:414`, `notification-consumer-review.services-spec.ts:51`, `correlation-chain.services-spec.ts:121`, `dlq-isolation.services-spec.ts:181`, `test/manual/notification-consumer.manual.ts:47`, `test/manual/notification-consumer-review.manual.ts:59` | không thêm TC; chứng minh bằng typecheck đỏ rồi xanh và chạy lại từng spec | typecheck đỏ ở 7 nơi trước khi sửa | `npm run typecheck`; chạy từng services spec ở cột này (CI chạy từng path) | gộp vào commit bước 2 |
| 4 | `src/modules/ledger/transfer-correlation.ts` (mới) và `src/modules/ledger/index.ts`; test: `src/modules/ledger/transfer-correlation.spec.ts` (mới) | TC-135-11 | (điền) | `npm test -- transfer-correlation` | `feat(ledger): export transferCorrelationId for audit chains (DBS-135)` |
| 5 | `test/db/fraud-operator-http.db-spec.ts` (hai test đổi metadata + assertion `correlation_id`); sau khi đỏ: `src/modules/risk/fraud-http.service.ts` | TC-135-10 | (điền) | `npm run test:db -- test/db/fraud-operator-http.db-spec.ts` (toàn file) | `feat(risk): record the review under the transfer correlationId (DBS-135)` |
| 6 | Chạy lại spec bước 1: phải xanh. `.github/workflows/ci.yml` (thêm bước cho `audit-trace.services-spec.ts`, ngay sau bước `correlation-chain`) | TC-135-01..05 | — | cùng lệnh bước 1; `grep audit-trace .github/workflows/ci.yml` | `ci: run the audit trace spec (DBS-135)` |
| 7 | Chạy lại TC-103-18 (`test/db/audit-search.db-spec.ts`) và toàn bộ `audit-search.*` (DoD 2, TC-135-12, 13) | TC-135-12, 13 | — | `npm run test:db -- test/db/audit-search.db-spec.ts` | không có (chỉ chạy lại) |
| 8 | Docs: `docs/components/_shared/database-design.md` (§4.7 định nghĩa, dung lượng, nguồn các dòng; §6 dòng tra cứu), `docs/03_HIGH_LEVEL_ARCHITECTURE.md` (UC-8 chuỗi audit), `backend/src/modules/notification/README.md`, `backend/src/modules/audit/README.md` (action `notification.sent`), `backend/src/modules/ledger/README.md`, `docs/features/DBS-129-130-fraud-operator-api.md`, `docs/features/README.md`, `docs/BACKLOG.md` (các dòng bàn giao) | `check-doc-links.mjs` | — | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(audit): AC-8.2 chain and correlation definition (DBS-135)` |
| 9 | Test thủ công M-135-00..08 trên API và worker thật; `docs/features/screenshots/DBS-135/manual-test.txt` và ảnh | §5 | — | theo §5 trên SHA cuối đổi mã | `docs(audit): DBS-135 manual test evidence` |
| 10 | §8, §9, checklist G4; chạy `lint:check`, `typecheck`, `npm test`, `test:e2e`, các spec bị ảnh hưởng | — | — | bốn lệnh baseline | `docs(audit): DBS-135 results and handover` |

**Quét giới hạn của tài liệu và DoD (plan sweep, đã chạy):** DoD 1 → bước 1, 2, 4, 5; DoD 2 → bước 7 (TC-103-18, không viết trùng); DoD 3 → bước 9 (M-135-05); DoD 4 → quy trình (PR, CI, Dev review). Giới hạn nêu ở DBS-134 §«Ngoài phạm vi» («Tra cứu theo correlationId trên API và đo thời gian (DBS-135)»): nhận ở task này. Giới hạn đã biết của DBS-103 (live keyset, chưa đo RDS): không đổi, nằm ngoài phạm vi. BL-024 (1) đã đóng ở DBS-134; không còn dòng backlog nào của module này cần nhận. Hai mục nằm ngoài kế hoạch có dòng BL ở bước 8: (a) lượt xem `fraud_flag.view` chưa nằm dưới `C`; (b) dung lượng `audit_log` khi tải gần cận trên ADR-14 (phân vùng/lưu trữ).

**Rủi ro và cách lùi:**
- *Test cũ vỡ vì thêm audit:* đã grep không có, nhưng bước 3 chạy lại từng services spec của consumer thông báo; vỡ thì sửa test theo H2, không nới lỏng assertion.
- *Audit lỗi chặn thông báo:* là hệ quả có chủ đích (H4); lùi bằng cách bỏ lời gọi `audit.record` trong `NotificationConsumer.apply`.
- *Đổi mã audit của review:* nếu owner #3/#4 không chấp nhận, lùi một commit bước 5; chuỗi mất bước review nhưng không mất dữ liệu (dòng cũ không bị sửa, audit chỉ INSERT).
- *Không có migration:* không cần lùi schema.
- *Docker/RAM:* chạy test DB và services tuần tự (`--runInBand`), từng file, vì chạy cả bộ từng làm sập máy.

**Quyết định ở G3 (agent tự quyết):**
1. Gộp bước 3 vào commit bước 2 vì đổi constructor không thể xanh nếu thiếu một nơi gọi; chứng minh bằng typecheck.
2. Không sửa `riskFixtures` (file dùng chung của #4): TC-135-01 và TC-135-03 gọi supertest trực tiếp.
3. Không viết lại test plan ≤ 10 ms: dùng TC-103-18 (DBS-103) và ghi số đo lúc bàn giao.

## 8. Kết quả

- **Quyết định techlead 2026-11-14 (BL-227 đóng):** chưa phân vùng hay lưu trữ lạnh `audit_log`. Ở tải thiết kế (≈ 10.000 dòng/ngày) và thời gian dự án còn lại, kích thước không đáng kể; quyết định lại khi có số đo dung lượng thật trên RDS hoặc khi tải tiến gần cận trên của ADR-14.

- **Lệnh kiểm tra** (từ `backend/`, Node 24, 2026-11-10, trên commit mã cuối `f974236`):

```
npm run lint:check        → sạch
npm run typecheck         → sạch
npm test                  → Test Suites: 104 passed, 104 total / Tests: 1826 passed, 1826 total
npm run test:e2e          → Test Suites: 17 passed, 17 total / Tests: 163 passed, 163 total  (DATABASE_URL Postgres 17 tạm)
test:db  notification-consumer.db-spec          → 13 passed
test:db  fraud-operator-http.db-spec            → 14 passed
test:db  audit-search.db-spec + audit-search.http.db-spec → 54 passed (gồm TC-103-18)
test:services audit-trace.services-spec         → 3 passed
test:services correlation-chain / notification-consumer-review / outbox-relay / outbox-relay-faults / dlq-isolation → 5 / 4 / 15 / 12 / 3 passed
```

  Không `.skip`, `.only`, `.todo` trong test của task (0 skipped). Baseline trước khi sửa: unit 1824/103, e2e 163/17. `test:db` toàn bộ và `test:services` toàn bộ **chưa chạy** (từng làm sập RAM): chỉ các spec bị ảnh hưởng ở danh sách trên; CI chạy phần còn lại.

- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-135-01 | `test/services/audit-trace.services-spec.ts` › «TC-135-01/02/03 transfer → notice → flag → review…» (đúng 4 `action`, cùng `C`, `target.id`, thứ tự đầu/cuối) | đạt |
| TC-135-02 | cùng test: metadata từng dòng, chuỗi JSON không chứa `note`, `riskLevel`, `score`, tên rule | đạt |
| TC-135-03 | cùng test: header review khác `C`, `metadata.id` = header đó, giá trị `X-Correlation-Id` giả không ở dòng audit nào | đạt |
| TC-135-04 | `audit-trace.services-spec.ts` › «TC-135-04…» | đạt |
| TC-135-05 | `audit-trace.services-spec.ts` › «TC-135-05…» (409 `FLAG_ALREADY_REVIEWED`, vẫn 4 dòng) | đạt |
| TC-135-06 | `test/db/notification-consumer.db-spec.ts` › «TC-135-06…» | đạt |
| TC-135-07 | cùng file › «TC-135-07…» (account, deposit, tự chuyển) | đạt |
| TC-135-08 | cùng file › «TC-135-08…» (xử lý hai lần). Lưu ý: chỉ kiểm cùng `eventId` xử lý hai lần qua `handle`, không dựng riêng đường «relay gửi trùng» qua SQS (đã được TC-134-12 kiểm) | đạt |
| TC-135-09 | cùng file › «TC-135-09…» (trigger chặn audit INSERT, rollback, retry thành công) | đạt |
| TC-135-10 | `test/db/fraud-operator-http.db-spec.ts`: hai test cũ sửa metadata `{reason, id}` và thêm `correlation_id`; test `dbs_api` thêm assertion `review_code = transfer_code` | đạt |
| TC-135-11 | `src/modules/ledger/transfer-correlation.spec.ts` (2 test) + `grep -rn "FROM transfers\|JOIN transfers" backend/src/modules/risk` (không có kết quả) | đạt |
| TC-135-12 | `audit-search.db-spec.ts` › TC-103-18: fixture 50.012 dòng, 5 lượt warm 0,046 / 0,05 / 0,048 / 0,047 / 0,054 ms, `Index Scan` trên `audit_log_correlation_idx` | đạt |
| TC-135-13 | `audit-search.http.db-spec.ts` (403 `FORBIDDEN` cho vai không phải auditor, dòng 349-350) + M-135-06 | đạt |
| TC-135-14 | quy trình (PR, CI, Dev review) | chưa đạt: PR chưa mở; BL-160 chung |

  15 case đạt, 0 đơn giản hóa, 1 quy trình chưa đạt.

- **Test thủ công** (API `APP_ROLE=api` và worker `APP_ROLE=worker`, `node dist/main`, PostgreSQL 17, ElasticMQ và Valkey của compose; SHA `f974236`; output thô: [manual-test.txt](screenshots/DBS-135/manual-test.txt), token và `Authorization` không có trong file):

| Bước | Kết quả thật | Đạt? |
|---|---|---|
| M-135-00 | rule set version 1, `mode: rule_only`, không khối `ai` | đạt |
| M-135-01 | An và Bình onboard (200), hai tài khoản CHECKING (201), nạp 21.000.000 (201) | đạt |
| M-135-02 | transfer 20.000.000 → 201; gửi `X-Correlation-Id: aaaaaaaa-0000-4000-8000-000000000001`, server chọn `C=2722de31-246c-4814-88aa-e94cbda72de6` (khác) | đạt |
| M-135-03 | `psql`: `transfer`, `notification.sent` (count 2), `fraud.flagged` (count 2) cùng `C` | đạt |
| M-135-04 | review `CONFIRMED_FRAUD` → 200, header `1767d2be-…` khác `C` | đạt |
| M-135-05 | auditor tra `C`: 4 dòng `fraud_flag.review \| fraud.flagged \| notification.sent \| transfer`; `metadata.id` của review = `1767d2be-…`; **T1−T0 = 552 ms** (mục tiêu < 5 phút) | đạt, kèm giới hạn: đo bằng kịch bản chạy lệnh, chưa phải người bấm giờ (BL-228) |
| M-135-06 | mã lạ → `entries: []`; customer và operator → 403 `FORBIDDEN` | đạt |
| M-135-07 | review lần hai → 409 `FLAG_ALREADY_REVIEWED`; tra lại vẫn 4 dòng | đạt |
| M-135-08 | dừng riêng tiến trình worker (API sống): chuỗi mới `C2` chỉ có `transfer`, 2 event outbox chưa gửi; chạy lại worker: thêm `notification.sent` và `fraud.flagged`, mỗi action đúng 1 dòng, 2 dòng `notification_log`, 0 event chưa gửi | đạt |

  Quan sát khác: (a) plan của câu tra cứu trên bảng thật (vài chục dòng) là `Bitmap Index Scan` trên `audit_log_correlation_idx`: bảng quá nhỏ để planner chọn `Index Scan`, nên bằng chứng DoD 2 là TC-103-18 (50.012 dòng), không phải số này; (b) tên khách có dấu bị Git Bash/curl trên Windows làm hỏng khi gửi (`Tr?n Van An` trong `customers.full_name`), là lỗi môi trường chạy tay chứ không phải của API; chưa kiểm lại với tên có dấu đúng, không ảnh hưởng chuỗi audit; (c) nhánh thật chạy với Postgres tạm cổng 55433 vì volume compose có mật khẩu cũ.

- **Phạm vi so với §7:** `git diff --stat main...HEAD` (mã, 18 file) khớp danh sách §7 và §3, cộng ba file không nằm trong danh sách: `backend/test/services/outbox-relay-faults.services-spec.ts` (đổi nơi gọi và Prettier xuống dòng lại hai khối khác, 19 dòng), `dlq-isolation.services-spec.ts` (nơi gọi) và `test/manual/*` (nơi gọi): đều là nơi gọi constructor đã liệt kê ở §3. Docs: 8 file sửa ở §9 cộng doc này và thư mục ảnh.
- **Ảnh chụp** (browser headless chụp từ transcript thật, có SHA và dòng chạy; đã mở kiểm):

![Chuỗi một mã](screenshots/DBS-135/01-chain-by-one-code.png)

![Phục hồi sau khi chạy lại worker](screenshots/DBS-135/02-recovery-after-worker-restart.png)

- **Lệch so với kế hoạch (quyết định agent tự duyệt, gate phụ):**
  1. Commit: kế hoạch có sáu commit riêng; thực tế hai commit mã (`cc93ace` thông báo + nơi gọi; `f974236` helper ledger + review + spec chuỗi + CI) vì spec chuỗi đỏ không thể commit riêng và helper không có người dùng nếu thiếu review. Hai commit đều xanh.
  2. Test `fraud-operator-http.db-spec.ts`: ngoài hai test đã nêu, thêm assertion vào test `dbs_api` (không đổi hành vi, thêm một kiểm).
  3. Ảnh chụp làm từ transcript bằng Chrome headless (không phải ảnh màn hình terminal trực tiếp), cùng cách DBS-86 đã dùng.
- **Bàn giao cho vai khác (dòng trong [BACKLOG](../BACKLOG.md)):**
  - **BL-226 (đã xong):** lượt xem `fraud_flag.view` nay nằm dưới mã của giao dịch, `metadata.id` giữ mã request (`FraudHttpService.detail`, cùng cơ chế review); `fraud_flag.search` giữ mã request. Test: `fraud-operator-http.db-spec.ts` và `audit-trace.services-spec.ts`.
  - **BL-227:** dung lượng `audit_log` khi tải gần cận trên ADR-14, phân vùng hoặc lưu trữ (#3, #5).
  - **BL-228:** DoD 3 cần một người bấm giờ thật trên môi trường demo (Dev reviewer).
  - **BL-160 (có sẵn):** review độc lập trên GitHub cho PR này.
  - **Cần owner duyệt ở PR:** đổi mã audit của review (module risk, #4) và định nghĩa `correlation_id` ở database-design §4.7 (#3), dòng `Techlead waiver` ở PR.

## 9. Tài liệu đã cập nhật

- [`database-design.md`](../components/_shared/database-design.md) §4.7: ý nghĩa `correlation_id`, nguồn các dòng của một chuỗi, dung lượng.
- [`docs/03`](../03_HIGH_LEVEL_ARCHITECTURE.md) §6.6: đoạn truy vết một giao dịch bằng một mã.
- [`DBS-129-130`](DBS-129-130-fraud-operator-api.md): mã audit của review và `metadata.id`.
- `backend/src/modules/audit/README.md` (action của một chuỗi), `notification/README.md` (audit của thông báo), `ledger/README.md` (`transferCorrelationId`).
- [`features/README.md`](README.md): dòng DBS-135.
- `docs/BACKLOG.md`: thêm BL-226, BL-227, BL-228; không xóa dòng nào (không có dòng nào của task này).
- `check-doc-links.mjs`: 373 file, 0 link hỏng (chạy lại ở G4).

## Checklist G4 (2026-11-10)

- [x] 15/15 test case tự động đạt đủ độ sâu, 0 đơn giản hóa; TC-135-14 (quy trình: PR, CI, Dev review) chưa đạt vì PR chưa mở
- [x] Test thủ công chạy trên commit cuối đổi mã (`f974236`, dòng đầu `manual-test.txt`): M-135-00..08 đều đạt; đường thành công đã chạy; không bước nào "chưa chạy". Giới hạn: M-135-05 đo bằng kịch bản, chưa có người bấm giờ (BL-228)
- [x] Hai ảnh trong `screenshots/DBS-135/`; `manual-test.txt` đã quét không có token, `Authorization` hay ARN (script `shots.mjs` từ chối chạy nếu có)
- [x] `git diff --stat main...HEAD` khớp §7; ba nhóm file lạ ghi ở §8
- [x] Bốn lệnh baseline chạy lúc bàn giao, có số đếm (§8); `test:db` và `test:services` chỉ chạy các spec bị ảnh hưởng
- [x] Doc có fact bị đổi đã sửa (§9); `check-doc-links.mjs` sạch
- [x] Việc bàn giao và DoD chưa đạt có ở §8 và `BL-226/227/228` trong `docs/BACKLOG.md`
