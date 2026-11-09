# DBS-124 · Test tắt/bật worker: sự kiện không mất, cờ vẫn xuất hiện

> **Status:** Draft · **Vai:** Dev · **Cặp đôi review:** Dev khác · **Nhánh:** `test/DBS-124-worker-down-recovery` · **PR:** — · **Cập nhật:** 2026-11-10

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 4, Demo 3. **Expect:** "Chứng minh không mất sự kiện khi worker chết."
- **DoD** (chép nguyên văn):
  1. Tắt worker, chuyển tiền N lần, bật lại → mọi cờ cần có vẫn xuất hiện, không trùng cờ
  2. Kịch bản Demo 3 (failure/recovery) có từng bước và kết quả mong đợi
  3. Bất biến đúng sau test (DBS-69)
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc** (đều có trên `main` 083ecee):
  - DBS-111 consumer risk (PR #124, vừa merge).
  - DBS-91 relay chịu sự cố.
  - DBS-69 `checkLedgerInvariants`.
- **Đã có gì:**
  - DBS-91 M-91-01: không worker, 21 sự kiện chờ; bật worker thì 21 message, 0 trùng.
  - DBS-91 TC-91-0x: kill relay giữa lô.
  - DBS-111 TC-111-13: vòng lặp thật, gửi lại không thêm cờ.
  - **Chưa có:** test hệ thống cho "worker tắt, rồi bật lại, thì **cờ** vẫn đủ"; tài liệu Demo 3 (grep "Demo 3" chỉ ra ADR-03 và feature doc).
- **Baseline** (`main` 083ecee = code của PR #124, CI xanh 6 job):
  - Unit 1.770, e2e 163, `test:db` 892 (đo ở DBS-111 trên cùng code).
- **Ngoài phạm vi:**
  - DLQ và consumer lỗi 5 lần: DBS-125.
  - Worker trên ECS: BL-161.
  - Thứ tự đến muộn hoặc đảo của bộ đếm R1/R5: DBS-112, BL-187/205.
- **Quyết định ở G1** (agent tự quyết):
  1. **Kịch bản Demo 3** đặt ở `docs/components/outbox/demo-3-failure-recovery.md`, vì nửa bất đồng bộ (outbox → relay → SQS → consumer) là nơi Demo 3 diễn ra.
     - Gồm bước của DBS-91 (relay) và DBS-124 (cờ).
     - DBS-125 sẽ thêm phần DLQ.
     - Link từ concept brief của outbox và `docs/components/index.md`.
  2. **"Worker chết" trong test tự động:**
     - **Dừng hẳn** vòng lặp relay và consumer (`onApplicationShutdown`), rồi dựng **instance mới** (như một process mới, kèm `invalidateCounters()`).
     - **Chết sau commit, trước khi ack:** consumer "chết" ngay sau khi transaction commit, message không bị xóa, nên SQS giao lại sau visibility timeout.
     - Kill process thật nằm ở test thủ công (`taskkill /F` process worker).
  3. Board ghi DBS-124 "Done" nhưng chưa có test: người dùng sửa board.

## 2. Hành vi

Không có API mới. Hệ thống phải giữ các tính chất sau, đúng như thiết kế ADR-03, DBS-91, DBS-101 và DBS-111:

| Tình huống | Kết quả |
|---|---|
| Worker (relay và consumer) tắt, khách chuyển N lần | Mọi lệnh 201 (đường đồng bộ không phụ thuộc worker); N sự kiện `TransferCompleted` nằm trong `outbox_events` với `published_at IS NULL`; không có decision hay cờ nào |
| Bật worker mới | Relay đẩy hết outbox; consumer risk ghi đúng N decision. Mọi transfer đạt ngưỡng có **đúng 1** cờ, kèm các hit đúng luật; transfer LOW không có cờ |
| Consumer commit xong nhưng chết trước khi ack | SQS giao lại message; lần giao sau dừng ở dedup (`processed_events` / `risk_decisions`); vẫn 1 decision, 1 cờ, 1 audit |
| Sau mọi kịch bản | `checkLedgerInvariants` PASS: worker không chạm tiền |

**Dữ liệu:**
- Lệnh **đạt ngưỡng** theo fixture AC-9.1: tài khoản mới, nạp 21.000.000đ, chuyển 20.000.000đ cho người khác chủ → R3 + R6 = 65 MEDIUM.
- Lệnh **LOW:** tài khoản mới, nạp 5.000.000đ, chuyển 1.000.000đ (20%, ≤ 10.000.000đ) → 0 điểm.

## 3. Kiến trúc

- **Vị trí:** chỉ có test và tài liệu, không đổi code sản phẩm.
  - `backend/test/services/worker-recovery.services-spec.ts`, kèm một bước CI riêng trong job `e2e`.
  - Tái dùng `test/support/risk-consumer.ts` (DBS-111) và `startDepositApp`.
- **Interface dùng:**
  - `OutboxRelayService.onApplicationBootstrap()`, `onApplicationShutdown()`.
  - `RiskScoringConsumer` (subclass test: long poll 1 s; ghi đè `consumeOnce(waitTimeSeconds = 1, visibilityTimeout = 2)` để lần giao lại đến sau ~2 s).
  - `OnlineFeatureProvider.invalidateCounters()`.
- **"Chết sau commit":** subclass ghi đè `handle()`: gọi `super.handle()`, nếu thành công và cờ `dieAfterCommit` còn bật thì ném lỗi đúng một lần. `processBatch` không xóa message khi handler ném lỗi, nên message hiện lại sau visibility timeout.
- **Thay đổi cấp hệ thống:** tài liệu Demo 3 mới; ADR-03 §Hệ quả trỏ tới tài liệu này.

## 4. Test cases tự động

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-124-01 | DoD #1, #3 | services (PG + ElasticMQ + Valkey thật, HTTP thật, vòng lặp thật) | Worker đang chạy rồi tắt. 12 lệnh (6 đạt ngưỡng, 6 LOW) → 12 lệnh 201; `TransferCompleted` chưa gửi ≥ 12; 0 decision. Bật worker mới (instance mới) → trong ≤ 60 s có 12 decision, đúng 6 cờ 65 MEDIUM {R3, R6} trên đúng 6 transfer đạt ngưỡng; mỗi transfer ≤ 1 cờ; mỗi `eventId` 1 dòng `processed_events('risk')`; outbox chưa gửi = 0; bất biến PASS |
| TC-124-02 | DoD #1, #3 | services | Consumer "chết" sau commit trước ack, với 1 lệnh đạt ngưỡng → message được giao lại (đếm số lần `handle`: 2); vẫn 1 decision, 1 cờ, 1 audit; bất biến PASS |
| quy trình | DoD #2 | tài liệu | `docs/components/outbox/demo-3-failure-recovery.md`: từng bước, lệnh, kết quả mong đợi; chạy thật ở §5 |
| quy trình | DoD #4 | — | PR, CI, bảng đối chiếu |

## 5. Test thủ công (đây cũng là lần chạy Demo 3)

Hai process thật (`node dist/main` với `APP_ROLE=api` và `APP_ROLE=worker`, sau `npm run build`) trên DB riêng `banking_dbs124`, với Valkey và ElasticMQ của `docker compose`. Queue được purge trước khi chạy.

**Chuẩn bị** (từ `backend/`):
- Tạo DB.
- `export DATABASE_URL=…/banking_dbs124`, rồi `npm run migration:run`.
- Token lấy bằng `auth:dev-token` với `--sub` riêng cho từng khách.
- Mỗi khách gọi `POST /v1/customers/me` trước `POST /v1/accounts`.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-124-01 | Chạy cả hai process; một lệnh đạt ngưỡng | Cờ xuất hiện (hệ thống đang khỏe) |
| M-124-02 | `taskkill /F` process worker; 3 lệnh đạt ngưỡng + 3 lệnh LOW | 6 lệnh 201; outbox chưa gửi ≥ 6; 0 decision mới |
| M-124-03 | Bật lại worker | ≤ 10 s: 6 decision mới, 3 cờ mới 65 MEDIUM; không transfer nào có 2 cờ; outbox chưa gửi = 0 |
| M-124-04 (chết giữa chừng) | Gửi loạt 10 lệnh đạt ngưỡng, `taskkill /F` worker sau ~300 ms, bật lại | Sau khi bật lại: đủ 10 decision và 10 cờ, 0 trùng (`GROUP BY transfer_id HAVING count(*) > 1` rỗng) |
| M-124-05 | `npm run --silent check:invariants` | PASS |

## 6. Domain review (AI)

(điền ở G2)

## 7. Kế hoạch triển khai

(điền ở G3)

## 8. Kết quả

(điền ở G4)

## 9. Tài liệu đã cập nhật

(điền ở G4)
