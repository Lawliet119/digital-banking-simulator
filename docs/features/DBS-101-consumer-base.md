# DBS-101 · ConsumerBase: idempotent, message hỏng vào DLQ ngay, lỗi tạm thời retry tối đa 5 lần

> **Status:** Implemented (G1–G4 agent tự duyệt) · **Vai:** Dev · **Nhánh:** `feat/DBS-101-consumer-base` · **PR:** [#101](https://github.com/Lawliet119/digital-banking-simulator/pull/101) · **Cập nhật:** 2026-11-09

## 1. Bối cảnh

- **Task:** Story, Tuần 4, Highest, Demo 3. **Expect:** Mọi consumer dùng chung một khung xử lý đúng một lần về hiệu ứng.
- **DoD:**
  1. `ConsumerBase.handle(message)`: trong MỘT transaction ghi `processed_events(consumer, event_id)` và tác động nghiệp vụ; cùng eventId nhận 3 lần → 1 hiệu ứng (test).
  2. Message sai schema/hỏng định dạng → sang DLQ ngay ở lần nhận đầu, không retry 5 lần; lỗi tạm thời → retry rồi sang DLQ sau 5 lần.
  3. Consumer này lỗi hoặc chết không ảnh hưởng consumer kia (mỗi consumer một queue).
  4. Chỉ khởi động khi `runsWorkers()`; `correlationId` lấy từ message đặt vào AsyncLocalStorage.
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ.
- **Phụ thuộc:** DBS-90 (relay), DBS-77 (`libs/sqs`), DBS-24 (`@common/events`) đều có trên `main`.
- **Đã có:** `NotificationConsumer` (DBS-96) tự viết khung riêng (poll, `validateEvent`, `processed_events`), nhưng sai schema chỉ "không ack" nên phải nhận 5 lần mới vào DLQ; chưa có test cho nó. `libs/sqs.processBatch` chỉ chuyển DLQ ngay khi body không phải JSON. **Baseline:** lint, typecheck sạch; unit 75 suite / 1.413 test xanh.
- **Ngoài phạm vi:** backoff giữa các lần retry và việc ghi `notification_log` đúng người nhận (DBS-102); consumer risk (DBS-111). `NotificationConsumer` chuyển sang `ConsumerBase` nhưng giữ hành vi ghi bản ghi hiện tại.
- **Backlog:** BL-010 (chính sách `UNKNOWN_EVENT_TYPE`) lấy vào phạm vi. BL-115 (biến URL DLQ trong config) giữ quy ước `<url queue>-dlq`, không đổi env.
- **Quyết định ở G1 (agent tự quyết):** (1) đặt khung ở `src/common/messaging` vì dùng chung cho mọi module worker; (2) `UNKNOWN_EVENT_TYPE` mặc định đi DLQ ngay, consumer nào muốn bỏ qua phải khai báo `unknownEventPolicy = 'acknowledge'`.

## 2. Hành vi

| Tình huống | Kết quả |
|---|---|
| Event hợp lệ, lần đầu | Một transaction: `INSERT processed_events … ON CONFLICT DO NOTHING`, rồi `apply(event, manager)`; commit; xóa message |
| Cùng `eventId` lần 2, 3 | Claim không chèn được dòng → không gọi `apply`, xóa message; còn đúng 1 hiệu ứng |
| `apply` ném lỗi | Rollback cả claim; message không bị xóa, giao lại; lần sau xử lý lại từ đầu |
| Body không phải JSON | `libs/sqs` chuyển nguyên vào DLQ ở lần nhận đầu (đã có từ DBS-77) |
| JSON sai schema (thiếu field, sai kiểu, loại sự kiện lạ) | `PoisonMessageError` → chuyển vào DLQ ngay ở lần nhận đầu rồi xóa nguồn; consumer tiếp tục message sau |
| Lỗi tạm thời ở lần nhận 1..4 | Không xóa; message bị ẩn theo backoff 5/10/20/40 giây (`retryBackoffSeconds`, làm ở DBS-102; mặc định 5, đặt 0 để tắt) rồi SQS giao lại |
| Lỗi ở lần nhận thứ 5 (`ApproximateReceiveCount` ≥ 5) | Chuyển DLQ và xóa nguồn, không phụ thuộc cấu hình redrive của queue |
| `APP_ROLE=api` | `onApplicationBootstrap` không bật vòng poll |

`correlationId` của event được đặt vào `PinoLogger.runInContext` (AsyncLocalStorage) quanh `apply`, nên log và `OutboxWriter` bên trong thấy đúng id.

## 3. Kiến trúc

- **Vị trí:** `backend/src/common/messaging/consumer-base.ts` (chạy ở `worker`); `PoisonMessageError` và nhánh DLQ trong `libs/sqs/sqs.client.ts` (`processBatch`).
- **Interface:** `abstract class ConsumerBase { consumerName; queueUrl(); apply(event, manager); onCommitted?(event); unknownEventPolicy; retryBackoffSeconds; handle(body, message?); consumeOnce(wait?, visibility?) }`. Người gọi `dlqUrlFor` (đang nằm ở notification): `outbox-relay.services-spec`, notification index; giữ re-export.
- **Dữ liệu:** `processed_events(consumer, event_id)` (PK). Không đổi schema.
- **Transaction:** claim và `apply` trong một `TransactionService.run`; không gọi SQS trong transaction (xóa message sau commit, do `processBatch`).

```mermaid
sequenceDiagram
  participant Q as SQS queue
  participant C as ConsumerBase
  participant DB as PostgreSQL
  participant D as DLQ
  Q->>C: message (processBatch)
  C->>C: validateEvent
  alt sai schema
    C-->>D: PoisonMessageError → forward + xóa nguồn
  else hợp lệ
    C->>DB: BEGIN; claim processed_events
    alt đã có
      C-->>Q: ack (không apply)
    else mới
      C->>DB: apply + COMMIT
      C-->>Q: ack
    end
  end
```

- **Thay đổi cấp hệ thống:** README của `libs/sqs` và `notification`; không ADR, không env.

## 4. Test cases tự động

| ID | DoD | Lớp | Given · When · Then |
|---|---|---|---|
| TC-101-01 | 1 | db (PG thật) | Cùng eventId qua `handle` 3 lần → 1 dòng `processed_events`, `apply` chạy 1 lần |
| TC-101-02 | 1 | db | Hai `handle` song song cùng eventId → đúng 1 hiệu ứng |
| TC-101-03 | 1 | db | `apply` ném lỗi → không còn dòng `processed_events`; gọi lại thì xử lý thành công |
| TC-101-04 | 2 | unit | Body sai schema / loại lạ → `PoisonMessageError`, không gọi transaction |
| TC-101-05 | 2 | unit | `unknownEventPolicy='acknowledge'` → trả về, không ném, không `apply` |
| TC-101-06 | 2 | unit | Lỗi tạm thời ở lần nhận 4 → ném lại lỗi gốc; ở lần nhận 5 → `PoisonMessageError` |
| TC-101-07 | 2 | services (ElasticMQ) | Message JSON sai schema → vào DLQ ở lần nhận đầu, message hợp lệ sau đó vẫn được xử lý |
| TC-101-08 | 2 | services | Handler luôn lỗi → sau đúng 5 lần nhận, message nằm trong DLQ và nguồn rỗng |
| TC-101-09 | 3 | services | Hai consumer hai queue: consumer A luôn lỗi, consumer B xử lý hết message của nó |
| TC-101-10 | 4 | unit | `APP_ROLE=api` không bật vòng poll; `worker` bật |
| TC-101-11 | 4 | unit | Bên trong `apply`, `logger.logger.bindings().correlationId` bằng `correlationId` của event; ra ngoài thì không còn |
| TC-101-12 | 2 | unit (libs/sqs) | `processBatch`: handler ném `PoisonMessageError` → DLQ có body gốc, nguồn bị xóa, `dead-lettered`; DLQ lỗi → `failed`, nguồn giữ |
| Quy trình | 5 | — | CI, Dev review, merge |

## 5. Test thủ công

Cần `docker compose up -d` (PostgreSQL, ElasticMQ), `backend/` đã `npm ci`. Script `backend/test/manual/consumer-base.manual.ts`, chạy `DATABASE_URL=<postgres server> npx ts-node -r tsconfig-paths/register test/manual/consumer-base.manual.ts`: tạo DB tạm + hai queue tạm (consumer, DLQ), dựng `ConsumerBase` thật.

| Bước | Việc làm | Mong đợi |
|---|---|---|
| M-101-01 | Gửi 1 event hợp lệ 3 lần (cùng eventId), chạy `consumeOnce` | 3 message được xóa, `processed_events` 1 dòng, hiệu ứng 1 |
| M-101-02 | Gửi `{"eventType":"TransferCompleted"}` (thiếu field) | DLQ có 1 message ở lần nhận đầu, nguồn rỗng |
| M-101-03 | Gửi event hợp lệ nhưng `apply` ném lỗi | Sau 5 lần nhận message nằm trong DLQ, không có dòng `processed_events` |

## 6. Domain review

Không có subagent review riêng cho task này (task hạ tầng, không chạm tiền); agent tự phản biện bằng danh sách:

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | Nếu claim và `apply` ở hai transaction, crash giữa chừng làm mất hiệu ứng | Một transaction (§3) |
| 2 | should-fix | Phụ thuộc vào redrive của hạ tầng để "retry tối đa 5 lần" | Thêm chốt cứng ở `ApproximateReceiveCount` ≥ 5 (TC-101-06/08) |
| 3 | minor | `UNKNOWN_EVENT_TYPE` khi triển khai cuốn chiếu (BL-010) | Mặc định DLQ, có chính sách `acknowledge` (TC-101-05) |
| 4 | minor | Không log body/lỗi chứa dữ liệu | Chỉ log `safeErrorMetadata` và id |

**Techlead waiver:** domain review bằng subagent riêng bỏ qua.

## 7. Kế hoạch triển khai

| Bước | File | Test trước | Đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `libs/sqs/sqs.client.ts` (+spec) | TC-101-12 | `PoisonMessageError` chưa tồn tại | `npm test -- sqs.client` | `feat(sqs): dead-letter a poison message at once` |
| 2 | `common/messaging/consumer-base.ts` (+spec) | TC-101-04/05/06/10/11 | thiếu module | `npm test -- consumer-base` | `feat(messaging): ConsumerBase` |
| 3 | `test/db/consumer-base.db-spec.ts` | TC-101-01/02/03 | — | `npm run test:db -- consumer-base` | cùng bước 2 |
| 4 | `notification.consumer.ts` dùng khung; `test/services/consumer-base.services-spec.ts` + CI step | TC-101-07/08/09 | — | `npm run test:services -- --runInBand --runTestsByPath test/services/consumer-base.services-spec.ts` | `refactor(notification): build on ConsumerBase` |
| 5 | manual, README, feature doc, index | M-101-01..03 | — | script manual | `docs(messaging): DBS-101 handover` |

Rủi ro: đổi `NotificationConsumer` làm vỡ `outbox-relay.services-spec` → chạy lại spec đó. Lùi: revert PR, `NotificationConsumer` cũ vẫn chạy được.

## 8. Kết quả

- **Lệnh kiểm tra** (commit code cuối `4ec3d5f`): `lint:check` và `typecheck` sạch; unit 76 suite / 1.424 test xanh; e2e 15 suite / 153 test xanh; `test:db -- consumer-base` 3/3; `test:services` `consumer-base` 3/3 và `outbox-relay` 15/15, `outbox-relay-faults` 12/12 (hồi quy sau khi `NotificationConsumer` dùng khung). Không có `.skip`/`.only`.
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-101-01 | `test/db/consumer-base.db-spec.ts` › TC-101-01; `consumer-base.spec.ts` › TC-101-01 | đạt |
| TC-101-02 | `consumer-base.db-spec.ts` › TC-101-02 (3 delivery đồng thời) | đạt |
| TC-101-03 | `consumer-base.db-spec.ts` › TC-101-03 | đạt |
| TC-101-04 | `consumer-base.spec.ts` › TC-101-04 | đạt |
| TC-101-05 | `consumer-base.spec.ts` › TC-101-05 | đạt |
| TC-101-06 | `consumer-base.spec.ts` › TC-101-06 (hai test) | đạt |
| TC-101-07 | `test/services/consumer-base.services-spec.ts` › TC-101-07 | đạt |
| TC-101-08 | `consumer-base.services-spec.ts` › TC-101-08 (4 lần failed, lần 5 dead-lettered) | đạt |
| TC-101-09 | `consumer-base.services-spec.ts` › TC-101-09 | đạt |
| TC-101-10 | `consumer-base.spec.ts` › TC-101-10 | đạt |
| TC-101-11 | `consumer-base.spec.ts` › TC-101-11 | đạt |
| TC-101-12 | `src/libs/sqs/sqs.client.spec.ts` › TC-101-12 (hai test) | đạt |

- **Test thủ công** (`backend/test/manual/consumer-base.manual.ts`, ElasticMQ của compose + PostgreSQL tạm; output thô ở [manual-test.txt](screenshots/DBS-101/manual-test.txt)): M-101-01 đạt (3 message, 1 claim, 1 hiệu ứng); M-101-02 đạt (DLQ ở lần nhận đầu, nguồn rỗng); M-101-03 đạt (failed ×4 rồi dead-lettered, DLQ giữ event, không có `processed_events`).
- **Phạm vi so với §7:** thêm `test/services/outbox-relay*.services-spec.ts` (sửa constructor `NotificationConsumer`, TC-NTF-02 đổi sang dead-lettered) và `.github/workflows/ci.yml` (bước services-spec mới); không đổi schema, env hay dependency.
- **Ảnh chụp:** không có ảnh PNG; bằng chứng là output text thô trong `manual-test.txt` (Techlead waiver).
- **Lệch so với kế hoạch:** (1) `consumeOnce` nhận thêm tham số `visibilityTimeout` để test deterministic, agent tự quyết vì nhỏ nhất; (2) db-spec viết sau `consumer-base.ts` nên không có bước đỏ riêng cho TC-101-01..03 (bù bằng TC-101-03 chứng minh rollback thật).
- **Bàn giao:** backoff giữa các lần retry thuộc DBS-102; chính sách `UNKNOWN_EVENT_TYPE` của consumer risk thuộc DBS-111 (đã ghi vào BL-010). Không thêm dòng BL mới.

## 9. Tài liệu đã cập nhật

`backend/src/libs/sqs/README.md`, `backend/src/modules/notification/README.md`, `docs/BACKLOG.md` (BL-010 thêm nguồn và phần đã đóng), `docs/features/README.md`.

### Domain review bằng subagent (bù sau merge, 2026-11-09)

Reviewer: subagent `fable` (mô hình mạnh nhất có sẵn), prompt `prompts/domain-review.md` chỉnh cho code đã merge, đọc `main` ở `18f93dc`. [Phản hồi nguyên văn](screenshots/DBS-101/domain-review.md). Bước này lẽ ra chạy ở Phase 2; agent đã bỏ qua khi làm một mạch, vì suy diễn Techlead waiver rộng hơn lời dặn «không qua humangate» (chỉ miễn người duyệt gate). Chạy bù sau merge.

**Verdict: REVISE** (1 blocking, 4 should-fix, 4 minor).

| # | Mức | Xử lý |
|---|---|---|
| 1 | blocking | **Đã sửa.** Script manual M-101-03 đỏ trên `main` vì backoff 5/10/20/40 giây của DBS-102. Đã tái hiện (assert lệch), `DemoConsumer` đặt `retryBackoffSeconds` = 0, chạy lại M-101-01..03 đạt, `manual-test.txt` ghi lại với SHA mới |
| 2 | should-fix | **Đã sửa:** §5 có `DATABASE_URL` |
| 3 | should-fix | **Đã sửa:** §2 và §3 nêu backoff và tham số `visibility`; TC của backoff nằm ở TC-102-03 |
| 4 | should-fix | Không sửa ở đây: cửa sổ retry 75 giây so với ADR-03/14 là quyết định ADR → BL-210 |
| 5 | should-fix | Không sửa ở đây: DLQ retention khi chuyển bằng `SendMessage` là việc hạ tầng/ADR → BL-210 |
| 6 | minor | Không sửa: test đồng thời thật → BL-212 |
| 7, 8 | minor | Không sửa: log/metric dead-letter và tắt máy khi long poll → BL-209 |
| 9 | minor | **Đã sửa:** header có PR [#101](https://github.com/Lawliet119/digital-banking-simulator/pull/101); Dev review chưa có (Techlead waiver) |
