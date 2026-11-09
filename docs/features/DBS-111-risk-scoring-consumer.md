# DBS-111 · Consumer chấm điểm: nhận risk-events, tạo cờ, ghi audit, idempotent

> **Status:** Implemented · **Vai:** #4 Fraud (techlead làm thay theo yêu cầu) · **Cặp đôi review:** Dev · **Nhánh:** `feat/DBS-111-risk-scoring-consumer` · **PR:** — · **Cập nhật:** 2026-11-10

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 4, Deliverable P5. **Expect:** "Chuyển tiền xong vài giây là cờ tự xuất hiện kèm giải thích."
- **DoD** (chép nguyên văn):
  1. Consumer qua ConsumerBase: lấy event, gọi scoring, INSERT fraud_flags + fraud_rule_hits + audit trong một transaction; điểm < 40 không tạo cờ
  2. AC-9.1 (giao dịch khớp R6 → cờ nêu R6) và AC-9.2 (cùng sự kiện hai lần → đúng 1 cờ) xanh
  3. Thời gian từ giao dịch tới cờ ghi lại trong e2e (mục tiêu p95 < 5 giây)
  4. role dbs_worker chỉ INSERT fraud_flags/fraud_rule_hits (kiểm khi có DBS-119)
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
  6. INSERT thêm risk_decisions (khóa transfer_id) cho MỌI TRANSFER kể cả LOW; thứ tự claim processed_events → risk_decisions → fraud_flags trong một transaction, decision commit đầu tiên thắng
  7. Dedup và kiểm decision trước khi gọi AI; lời gọi AI nằm ngoài transaction có retry
  8. role dbs_worker thêm quyền INSERT risk_decisions
  9. Giữ phạm vi baseline rule_only; phần gọi AI tách sang task tích hợp riêng
- **Phụ thuộc** (kiểm trên `main` b804d5e):
  - DBS-101 `ConsumerBase`.
  - DBS-108 `ScoringService`.
  - DBS-109 `OnlineFeatureProvider`.
  - DBS-110 `RuleSetRepository`.
  - DBS-56 `AuditService.record`.
  - RSK-01 `risk_decisions` (PR #123, vừa merge).
  - DBS-119 roles; DBS-90 relay định tuyến `TransferCompleted` → `risk` và `notification` (`outbox-routing.ts`).

  Tất cả có code. Board ghi DBS-111 "Done" nhưng `main` chưa có consumer: grep `class .*Consumer` chỉ ra `NotificationConsumer`.
- **Đã có gì:**
  - `RiskModule` rỗng ("no consumer is registered yet").
  - `OnlineFeatureProvider` và `RuleSetRepository` chưa đăng ký vào DI.
  - `toAiFeatureInput` (projection allowlist FRAUD-API-01 §2.3).
  - Quyền `dbs_worker`: S I trên `fraud_flags`, `fraud_rule_hits`, `risk_decisions`; I trên `audit_log`; S I D trên `processed_events`; S trên `v_transfer_facts`, `risk_rule_sets`.
  - Hàng đợi `risk-events` và DLQ có trong ElasticMQ local.
- **Baseline:** code trên `main` b804d5e giống `e688e10` của RSK-01.
  - `lint`, `typecheck` sạch.
  - Unit: 98 suite / 1.767 test.
  - `e2e`: 17 / 163.
  - `test:db`: 61 / 879.
- **BACKLOG nhận vào phạm vi:**
  - **BL-224** (bàn giao RSK-01: claim không target, snapshot allowlist, decision trước cờ).
  - **BL-202** (cờ và audit mang `event.correlationId`).
  - **BL-010** phần còn lại (consumer risk khai báo `unknownEventPolicy`).
  - **BL-205 mục (8)** phần "DBS-111 tăng gen khi khởi động".
  - **BL-188** phần "DBS-111 ghi `RuleSet.version` vào cờ".
  - Xóa các dòng (hoặc phần) đã xong.
- **BACKLOG chỉ nêu tên:**
  - BL-046 (policy lỗi luật: task này đi đúng policy "throw → rollback → retry → DLQ" nhờ `ConsumerBase`, nhưng chưa có metric `risk_rule_error_total`; giữ dòng, ghi tiến độ).
  - BL-051 (alarm), BL-187 và BL-205 các mục còn lại (độ đúng bộ đếm, thuộc DBS-112/DBS-109).
  - BL-223 (constraint trigger).
- **Ngoài phạm vi:**
  - Lời gọi AI (DoD #9): task tích hợp riêng.
  - API review cờ (UC-10).
  - Metric/alarm (BL-051, BL-204).
  - DBS-112 (đến muộn, đảo thứ tự).
- **Quyết định ở G1** (agent tự quyết):
  1. **Bước chuẩn bị ngoài transaction.** Redis và đọc feature phải chạy trước `BEGIN` (theo docstring `OnlineFeatureProvider` và `references/fraud.md`).
     - Thêm vào `ConsumerBase` hook `prepare(event)`, chạy trước `tx.run`; kết quả truyền vào `apply(event, manager, prepared)` và `onCommitted(event, prepared)`.
     - Mặc định trả `undefined`, nên `NotificationConsumer` không đổi.
     - `processBatch` chạy song song nhiều message, nên kết quả đi theo tham số, không lưu trong field của instance.
  2. **Mode AI** (theo ADR-14 «Dữ liệu và xử lý lỗi» (b), FRAUD-API-01 §2.7 mục 7):
     - **Khối `ai.*` hỏng** (`ruleSet.aiConfigInvalid`): chấm với mode thật. Decision ghi `rules_with_external_ai` / `CONFIG_INVALID`, đóng góp AI bằng 0, provider/model/hash null (CHECK `mode_metadata` của RSK-01 cho phép), commit, không DLQ.
     - **Khối AI hợp lệ nhưng lời gọi chưa nối** (DoD #9): chấm luật, ghi decision `rule_only` / `DISABLED`, nghĩa là đúng việc đã làm: không gọi AI và không có provider/hash để ghi `UNAVAILABLE`. Kèm log `warn` một lần cho mỗi phiên bản. Task tích hợp AI thay nhánh này (BL mới).
  3. **Sự kiện không phải `TransferCompleted` trên `risk-events`** (định tuyến sai, gửi tay) là `PoisonMessageError`, vào DLQ ngay.
  4. Board ghi "Done" sai: người dùng sửa board (DBS-111 "In Progress" rồi "In Review").

## 2. Hành vi

**Một sự kiện trên `risk-events`** (contract `@common/events`):

1. `ConsumerBase.handle` kiểm schema: sai thì DLQ ngay. Loại sự kiện lạ thì DLQ (`unknownEventPolicy = 'dead-letter'`, khai báo tường minh theo BL-010).
2. **`prepare(event)`, ngoài transaction:**
   - `eventType !== 'TransferCompleted'` → `PoisonMessageError` (DLQ ngay).
   - `type = 'DEPOSIT'` → `null` (không chấm).
   - **Dedup sớm** (tối ưu, không phải bảo đảm): đã có `processed_events('risk', eventId)` hoặc `risk_decisions(transferId)` thì trả `null`, không đọc Redis hay feature.
   - `ruleSet = RuleSetRepository.current()`: Redis `cfg:risk:latest:v2`, rồi SQL.
   - `features = OnlineFeatureProvider.extract(event)`: Redis R1/R5 và SQL `v_transfer_facts`.
   - Chấm bằng `ScoringService.score(event, features, config)` theo quyết định G1-2. `config` được chọn như sau:
     - `ruleSet.aiConfigInvalid`: truyền `ruleSet` nguyên vẹn; kết quả là `rules_with_external_ai` / `CONFIG_INVALID`.
     - Mode AI với khối `ai` hợp lệ: truyền `{ ...ruleSet, mode: 'rule_only' }`; nếu truyền mode thật mà không có assessment, kết quả `UNAVAILABLE` sẽ vi phạm CHECK `mode_metadata` (23514).
     - `rule_only`: truyền nguyên vẹn.

     Cột `mode` và `ai_status` của decision **lấy từ kết quả** (`result.mode`, `result.aiStatus`).
   - `snapshot = toAiFeatureInput(event, features)` (allowlist FRAUD-API-01 §2.3).
   - Lỗi ở đây (luật ném lỗi, SQL feature lỗi, cấu hình hỏng ngoài khối `ai.*`) làm message không được ack. `ConsumerBase` retry có backoff rồi đẩy DLQ ở lần nhận thứ 5 (ADR-14, BL-046).
   - **Ghi Redis trong `prepare`:** provider `ZADD` member là `transferId` (R1) hoặc tài khoản nhận (R5). Nếu event sau đó thua claim hoặc rollback, member vẫn còn. Điều này không sai: cùng member không đếm hai lần, và transfer đó đã commit thật trong `v_transfer_facts`.
3. **`apply`, trong một transaction.** `ConsumerBase` đã claim `processed_events('risk', eventId)` ngay trước.
   - `prepared = null` → không làm gì, chỉ commit claim dedup.
   - **Claim decision**, không chỉ định target (BL-224):
     ```sql
     INSERT INTO risk_decisions(transfer_id,event_id,rule_set_version,mode,rule_score,feature_snapshot,ai_status,ai_applied_weight)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,0)   -- $4 = result.mode, $7 = result.aiStatus
     ON CONFLICT DO NOTHING RETURNING transfer_id
     ```
     0 dòng nghĩa là event khác của cùng transfer đã quyết: dừng, chỉ commit claim của event này; `prepared.won = false`.
   - **`level ∈ {MEDIUM, HIGH}`** (điểm ≥ `thresholds.medium`, v1 = 40; HIGH ≥ 70):
     - `INSERT fraud_flags(transfer_id, score, risk_level, rule_set_version)`, với `score = rule_score + ai_applied_weight` (bằng `rule_score` vì đóng góp AI = 0).
     - Mỗi hit một dòng `fraud_rule_hits`.
     - `AuditService.record(manager, { actor: null, role: 'worker', action: 'fraud.flagged', outcome: 'SUCCESS', target: { type: 'transfer', id }, correlationId: event.correlationId, metadata: { count: hits.length } })`. `AuditService.record` không dùng RETURNING; `dbs_worker` có INSERT `audit_log`.
   - **`LOW`:** chỉ có decision.
4. **`onCommitted(event, prepared)`:** chỉ khi `prepared.won`, log `info` gồm `eventId`, `transferId`, `riskLevel`, `ruleSetVersion` và danh sách `ruleId`. Không có số tiền hay lời giải thích.

**AC-9.1** (fixture BRD):
- Tài khoản nguồn của An vừa mở, nạp 21.000.000đ, chuyển 20.000.000đ cho Bình (khác chủ).
- R3 khớp (tài khoản < 24 giờ, > 10.000.000đ, 35 điểm) và R6 khớp (95% ≥ 90%, số dư ≥ 1.000.000đ, 30 điểm). Không khớp R1 (1 lệnh), R2 (chưa đủ 5 lệnh lịch sử), R4, R5 (1 người nhận mới).
- Kết quả: đúng 1 cờ `{ score: 65, risk_level: 'MEDIUM', rule_set_version: 1 }`, hit đúng `{R3, R6}`.

**Chỉ R6** (30 < 40):
- Tài khoản cũ hơn 24 giờ hoặc số tiền ≤ 10.000.000đ.
- Ví dụ: nạp 5.000.000đ, chuyển 4.800.000đ (96%).
- Kết quả: decision `rule_score = 30`, không cờ.

**HIGH** (R3 + R5 = 75):
- Tài khoản mới nạp 50.000.000đ, 4 lệnh 100.000đ tới 4 người nhận mới, rồi lệnh 15.000.000đ tới người nhận mới thứ 5.
- R5: 5 ≥ 5, 40 điểm. R3: 35 điểm. R6 không khớp (30%). R1 không khớp (5 không lớn hơn 5).

**Idempotent (AC-9.2):**
- Cùng `eventId` hai lần: lần 2 dừng ở dedup sớm, hoặc ở claim `processed_events` khi chạy song song, nên không ghi gì thêm.
- Hai `eventId` khác nhau cho cùng transfer chạy song song: bên thua claim `risk_decisions` nhận 0 dòng và chỉ commit dòng dedup.
- PK `fraud_flags` là lớp chặn cuối.

**Khởi động (BL-205 mục 8):** `RiskWorkerModule` gọi `provider.invalidateCounters()` ngay khi dựng provider, tức trước khi bất kỳ vòng lặp nào chạy. Lần `extract` đầu tăng `risk:gen`, nên mọi bộ đếm Redis cũ phải nạp lại từ SQL.

**Khách không thấy cờ (AC-10.2):** không API khách nào đọc các bảng này; log không mang lời giải thích.

## 3. Kiến trúc

- **Vị trí:** role `worker`.
  - `backend/src/modules/risk/risk-scoring.consumer.ts`: `RiskScoringConsumer extends ConsumerBase`, `consumerName = 'risk'`, queue `sqsConfig.riskQueueUrl`.
  - `backend/src/modules/risk/risk-worker.module.ts`: DI, đăng ký trong `workerModules` (`modules/index.ts`).
  - `RiskModule` dùng chung giữ nguyên.
- **Interface:**
  - `ConsumerBase`:
    - Thêm `protected prepare(event): Promise<unknown>`, mặc định `undefined`.
    - Đổi chữ ký `apply(event, manager, prepared?: unknown)` và `onCommitted(event, prepared?: unknown)`.
    - `process()` gọi `prepare` trước `tx.run`.
    - Người gọi (grep): `NotificationConsumer` và các subclass trong test (`correlation-chain`, `consumer-base.*`). Tham số thêm là tùy chọn nên chữ ký cũ vẫn hợp lệ.
  - `OnlineFeatureProvider.invalidateCounters(): void` (mới).
  - `RiskScoringConsumer` có `protected earlyDedup(event): Promise<boolean>`, để test thay bằng stub và chạm nhánh thua claim.
- **DI (`RiskWorkerModule`):**
  - imports: `ConfigModule.forFeature(sqsConfig)`, `ConfigModule.forFeature(limitsConfig)`, `SqsModule`, `RedisModule`, `AuditModule`.
  - providers:
    - `RiskMetrics`;
    - `TransferFacts` (`DataSource`);
    - `RuleSetRepository` (`{ redis, db: DataSource, metrics }`);
    - `OnlineFeatureProvider` (`{ facts, redis, perTxLimit: limits.transfer.perTx, metrics }`, kèm `invalidateCounters()`);
    - `ScoringService`;
    - `RiskScoringConsumer`.
- **Ranh giới transaction:**
  - Ngoài: dedup sớm, rule set, feature, scoring.
  - Trong một `TransactionService.run`: `processed_events` → `risk_decisions` → `fraud_flags` → `fraud_rule_hits` → `audit_log`.
  - Không gọi Redis hay SQS bên trong.
- **Dữ liệu:** không đổi schema.
- **Sơ đồ:**

```mermaid
sequenceDiagram
  participant Q as SQS risk-events
  participant C as RiskScoringConsumer
  participant R as Redis
  participant DB as PostgreSQL (dbs_worker)
  Q->>C: TransferCompleted
  C->>DB: dedup sớm (processed_events / risk_decisions)
  C->>R: cfg:risk:latest:v2 (miss/lỗi → SQL)
  C->>R: R1/R5 (lỗi/lạnh → SQL v_transfer_facts)
  C->>C: ScoringService.score + snapshot allowlist
  C->>DB: BEGIN
  C->>DB: INSERT processed_events ON CONFLICT DO NOTHING
  C->>DB: INSERT risk_decisions ON CONFLICT DO NOTHING
  opt MEDIUM/HIGH
    C->>DB: INSERT fraud_flags, fraud_rule_hits, audit_log
  end
  C->>DB: COMMIT
  C->>Q: ack
```

- **Thay đổi cấp hệ thống:**
  - `docs/components/risk/02-architecture.md` §4.1 và `FRAUD_DETECTION_GUIDE.md` §5.1: bước `risk_decisions`, action `fraud.flagged` (thay `fraud_flag.create`; khớp `test/support/db-role-permissions.ts`).
  - `backend/src/modules/risk/README.md`, `backend/src/common/messaging` (docstring hook `prepare`).

## 4. Test cases tự động

Lớp db: PG thật. Dữ liệu tạo bằng HTTP thật (`startDepositApp`: mở tài khoản, nạp, chuyển). Event lấy đúng từ `outbox_events.payload` của transfer, rồi gọi `consumer.handle(payload)`. Redis là double luôn lỗi (đi đường SQL), trừ TC-111-13.

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-111-01 | DoD #1, #6, BL-202, BL-224(2) | db | Fixture HIGH (R3 + R5 = 75). Một transaction ghi đủ: `processed_events`; `risk_decisions` (`rule_only`, `DISABLED`, `rule_score` 75, `rule_set_version` 1, snapshot đúng **tập key** allowlist, không có key nào chứa id hay tên); `fraud_flags` (75, HIGH, 1); hits {R3, R5} với weight 35 và 40, explanation không rỗng; `audit_log` (`fraud.flagged`, `worker`, `actor_user_id` null, `correlation_id` = `event.correlationId`, metadata `{"count":2}`) |
| TC-111-02 | DoD #2 AC-9.1 | db | Fixture BRD (21M, chuyển 20M, khác chủ) → đúng 1 cờ: score 65, MEDIUM, hits đúng {R3, R6}, không R1/R2/R4/R5 |
| TC-111-03 | DoD #1, #6 | db | Chỉ R6 (5M, chuyển 4,8M) → decision `rule_score = 30`, không cờ, hit hay audit |
| TC-111-04 | DoD #2 AC-9.2 | db | Cùng payload `handle` hai lần, tuần tự → 1 decision, 1 cờ, 1 audit; lần 2 không gọi `extract` (spy) |
| TC-111-05 | DoD #6, BL-224(1,3) | db | Hai `eventId` **khác nhau**, cùng transfer, chạy song song. Barrier giữ cả hai `prepare` xong trước khi transaction nào mở → 1 decision (`event_id` của bên thắng), 1 cờ, 1 audit, 2 `processed_events`, không lỗi (không `23505`) |
| TC-111-06 | DoD #6 | db | Bỏ dedup sớm (`earlyDedup` stub trả `false`), decision đã tồn tại → `apply` thua claim: chỉ thêm `processed_events`, không thêm cờ hay audit, không lỗi |
| TC-111-07 | DoD #1 | db | DEPOSIT → chỉ `processed_events`, không decision |
| TC-111-08 | QĐ G1-3 | db | `AccountStatusChanged` hợp lệ đưa vào consumer risk → `PoisonMessageError`, không dòng nào |
| TC-111-09 | BL-046, ADR-14 | db | Luật ném lỗi (scoring stub) → `handle` ném lỗi không phải poison, không dòng nào (kể cả `processed_events`); với `ApproximateReceiveCount = 5` → `PoisonMessageError` |
| TC-111-10 | DoD #1 | db | Audit ném lỗi (spy) → rollback toàn bộ: không decision, cờ, hit hay `processed_events` |
| TC-111-11a | QĐ G1-2, BL-188 | db, **file riêng** `risk-scoring-ai-mode.db-spec.ts` (`risk_rule_sets` append-only: phiên bản mới sẽ ảnh hưởng các test khác cùng database) | Phiên bản luật mode AI với khối `ai` hỏng → decision `rules_with_external_ai` / `CONFIG_INVALID`, weight 0; cờ vẫn tạo theo điểm luật |
| TC-111-11b | QĐ G1-2, DoD #9 | db, cùng file riêng | Phiên bản luật mode AI với khối `ai` hợp lệ → decision `rule_only` / `DISABLED` được chèn (không `23514`); `warn` được log |
| TC-111-12 | BL-205 (8) | unit | `invalidateCounters()` rồi `extract` → `incr('risk:gen')` được gọi trước mọi `zadd`/`lookup`; module dựng provider ở trạng thái đã invalidate |
| TC-111-13 | DoD #3, BL-202 | services (PG + ElasticMQ + Valkey thật; HTTP thật bằng `startDepositApp`; **vòng lặp thật** của `OutboxRelayService` và `RiskScoringConsumer` khởi động bằng `onApplicationBootstrap()` với `APP_ROLE=both`; consumer là subclass test override `consumeOnce(waitTimeSeconds = 1)` (vòng lặp gọi `consumeOnce()` không đối số) nên long poll 1 giây, để `stop()` trong teardown chờ tối đa ~1 giây; chạy như một bước riêng trong job `e2e` của `ci.yml`) | 10 nguồn theo fixture AC-9.1, chuyển cách nhau ~300 ms trong khi relay và consumer đang chạy vòng lặp của chúng → 10 cờ. In p50/p95/max của `fraud_flags.created_at − transfers.created_at`; assert p95 < 5 s. `audit_log.correlation_id` = `transfers.correlation_id`. Gửi lại payload của một transfer vào `risk-events` → không thêm cờ |
| TC-111-14 | DoD #1 | unit | `ConsumerBase`: `prepare` chạy trước `tx.run` và ngoài transaction context; kết quả tới `apply` và `onCommitted`; subclass không override vẫn chạy như cũ |
| TC-111-15 | DoD #4, #8 | db (LOGIN `dbs_worker` thật) | Consumer với `TransactionService` và `DataSource` của `dbs_worker` xử lý fixture AC-9.1 → ghi đủ, không `42501`. `dbs_worker` UPDATE/DELETE `fraud_flags`, `risk_decisions` → `42501` |
| quy trình | DoD #5 | — | PR, CI, bảng đối chiếu |

Mọi test db kết thúc bằng `checkLedgerInvariants` PASS.

## 5. Test thủ công

App thật, **hai process**: `npm run start:dev:api` và `npm run start:dev:worker` trên DB riêng `banking_dbs111` (container `dbs63-fix-pg`, cổng 55433), Valkey và ElasticMQ của `docker compose`.

**Chuẩn bị** (từ `backend/`):
- Tạo DB: `docker exec dbs63-fix-pg psql -U test -d postgres -c "CREATE DATABASE banking_dbs111"`.
- `export DATABASE_URL=postgres://test:test@localhost:55433/banking_dbs111`, rồi `npm run migration:run`.
- `env/.env.development` có `AUTH_MODE=local` và các URL queue `risk-events` / `notification-events` của ElasticMQ.
- `npm run auth:dev-keys` (đã có).
- Token: `npm run --silent auth:dev-token -- --role customer --sub tran-an`, `--sub nguyen-binh`, `--role operator --sub operator-chi`.
- Mỗi khách gọi `POST /v1/customers/me` (onboarding) trước khi `POST /v1/accounts`.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-111-01 | An mở tài khoản mới; Chi nạp 21.000.000đ; An chuyển 20.000.000đ cho Bình (fixture AC-9.1) | 201 |
| M-111-02 | Sau vài giây, `psql`: `risk_decisions`, `fraud_flags`, `fraud_rule_hits`, `audit_log` (`fraud.flagged`) của transfer đó | 1 decision; 1 cờ 65 MEDIUM; hit R3 và R6 kèm lời giải thích tiếng Việt; audit cùng `correlation_id` với transfer |
| M-111-03 | Bình chuyển 1.000.000đ cho An (≤ 10.000.000đ nên không R3; 5% số dư nên không R6; 1 người nhận mới) | R4 khớp vì An vừa chuyển cho Bình trong 1 giờ: decision LOW, `rule_score` 20 (R4), không cờ |
| M-111-04 | Đo `fraud_flags.created_at − transfers.created_at` | < 5 giây |
| M-111-05 | Gửi lại `outbox_events.payload` của transfer M-111-01 vào `risk-events` (`aws sqs send-message --endpoint-url http://localhost:9324`) | Không thêm cờ/decision; có thêm 0 dòng `processed_events` (cùng `eventId`) |
| M-111-06 (bị từ chối) | Gửi `{"eventType":"Bogus"}` vào `risk-events` | Message nằm ở `risk-events-dlq`, không dòng nào |
| M-111-07 (phục hồi) | Dừng worker; lặp fixture AC-9.1 với một tài khoản mới khác; bật lại worker | Cờ xuất hiện sau khi worker lên; không mất sự kiện |
| M-111-08 | `GET /v1/transfers/{id}` và lịch sử của An | Không có trường nào về cờ (AC-10.2) |
| M-111-09 | `npm run --silent check:invariants` | PASS |

## 6. Domain review (AI)

**Reviewer:** subagent general-purpose, model Opus (effort medium), 2026-11-10.
- **Vòng 1:** 10 phát hiện (blocking 3, should-fix 3, minor 4), verdict REVISE · [nguyên văn](screenshots/DBS-111/domain-review.md).
- **Vòng 2:** 10/10 đã xử lý; 3 should-fix và 1 minor mới, verdict REVISE · [nguyên văn](screenshots/DBS-111/domain-review-r2.md).
- **Vòng 3:** 4/4 đã xử lý, 1 minor mới đã sửa, verdict **APPROVE** · [nguyên văn](screenshots/DBS-111/domain-review-r3.md).

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | Fixture AC-9.1 không theo BRD | đã sửa §2/§4: fixture BRD (21M, 20M → R3 + R6 = 65 MEDIUM); TC-111-13 dùng cùng fixture |
| 2 | blocking | Kết quả mong đợi thủ công sai (R5 đếm cả lệnh hiện tại) | đã sửa §5: dùng fixture AC-9.1, lệnh nhỏ LOW |
| 3 | blocking | Không test nào chạm nhánh thua claim `risk_decisions` | đã thêm TC-111-05 (hai eventId song song, có barrier) và TC-111-06 (bỏ dedup sớm) |
| 4 | should-fix | Phải ghi `CONFIG_INVALID` khi khối `ai.*` hỏng | đã sửa QĐ G1-2; TC-111-11a/b |
| 5 | should-fix | `onCommitted` cần kết quả prepare | đã đổi chữ ký `onCommitted(event, prepared)`, log chỉ khi thắng; TC-111-14 |
| 6 | should-fix | Đo độ trễ theo nhịp harness | đã sửa TC-111-13: vòng lặp relay và consumer thật, lệnh cách nhau |
| 7 | minor | Sự kiện khác `TransferCompleted` | đã thêm QĐ G1-3 và TC-111-08 |
| 8 | minor | Fixture HIGH chưa có | đã nêu: R3 + R5 = 75 |
| 9 | minor | Kịch bản thủ công thiếu chuẩn bị, đường từ chối, nguồn message gửi lại | đã thêm |
| 10 | minor | Thứ tự invalidate so với vòng lặp | đã sửa: invalidate khi module dựng provider; TC-111-12 |
| v2-1 | should-fix | Mode truyền vào `score()` khi khối AI hợp lệ; cột lấy từ kết quả | đã sửa §2 bước 2–3; TC-111-11b kiểm không 23514 |
| v2-2 | should-fix | Phiên bản luật mới ảnh hưởng test cùng file | đã tách TC-111-11a/b sang file riêng |
| v2-3 | should-fix | `APP_ROLE=worker` không có HTTP; teardown long poll 20 s | đã sửa TC-111-13: `APP_ROLE=both`, long poll 1 s, bước CI riêng |
| v2-4 | minor | M-111-03 khớp R4; thiếu onboarding | đã sửa |
| v3-1 | minor | Cách đặt long poll 1 s | đã ghi: subclass test override `consumeOnce(waitTimeSeconds = 1)` |

**Quyết định ở G2:** không có quyết định riêng ngoài G1; vòng 3 APPROVE.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `backend/src/common/messaging/consumer-base.ts` (+ spec) | TC-111-14 | | `npm test -- consumer-base` | `feat(messaging): prepare hook outside the consumer transaction (DBS-111)` |
| 2 | `backend/src/modules/risk/features/online-feature-provider.ts` (+ spec) | TC-111-12 | | `npm test -- online-feature-provider` | `feat(risk): invalidate Redis counters when a worker starts (DBS-111)` |
| 3 | `backend/src/modules/risk/risk-scoring.consumer.ts`, `backend/test/db/risk-scoring-consumer.db-spec.ts`, `backend/test/db/risk-scoring-ai-mode.db-spec.ts` | TC-111-01..10, 11a/b, 15 | | `env -u DATABASE_URL npm run test:db -- --runInBand --runTestsByPath test/db/risk-scoring-consumer.db-spec.ts test/db/risk-scoring-ai-mode.db-spec.ts` | `feat(risk): risk-events consumer writes decisions, flags, hits and audit (DBS-111)` |
| 4 | `backend/src/modules/risk/risk-worker.module.ts`, `backend/src/modules/risk/index.ts`, `backend/src/modules/index.ts` (+ wiring spec) | boot `AppModule` role worker resolves `RiskScoringConsumer`; role api không có | | `npm test -- modules` | `feat(risk): register the risk consumer in the worker role (DBS-111)` |
| 5 | `backend/test/services/risk-scoring.services-spec.ts`, `.github/workflows/ci.yml` (một bước services) | TC-111-13 | | `npm run test:services -- --runInBand --runTestsByPath test/services/risk-scoring.services-spec.ts` | `test(risk): end-to-end transfer to flag latency with real loops (DBS-111)` |
| 6 | docs: `02-architecture.md`, `FRAUD_DETECTION_GUIDE.md` §5.1, `risk/README.md`, `BACKLOG.md`, `features/README.md`, doc này, `screenshots/DBS-111/` | — | — | `check-doc-links`; toàn bộ test | `docs(risk): DBS-111 consumer, evidence and backlog` |

Quét DoD và BACKLOG: DoD #1 → bước 1, 3; #2 → TC-02/04/05; #3 → bước 5; #4/#8 → TC-15; #6 → TC-01/05/06; #7 → dedup sớm + `prepare` (AI chưa có); #9 → QĐ G1-2. BL-224, BL-202, BL-010 (phần risk), BL-205 (8), BL-188 (phần consumer) xử lý ở bước 3–5 và xóa/thu hẹp ở bước 6; BL-046 thu hẹp (còn metric); BL mới cho lời gọi AI.

**Rủi ro:** đổi `ConsumerBase` ảnh hưởng consumer notification → chạy lại các test consumer-base/notification/correlation (services) ở bước 1 và cuối. Test services có vòng lặp thật có thể chậm hoặc treo → timeout rõ ràng, dừng vòng lặp trong `finally`. **Cách lùi:** gỡ `RiskWorkerModule` khỏi `workerModules` là tắt consumer; message nằm lại queue/DLQ, không mất.

**Quyết định ở G3** (agent tự quyết): unit test cho consumer không dùng mock DB; logic tiền/claim chỉ test trên PG thật (bước 3).

## 8. Kết quả

- **Lệnh kiểm tra** (từ `backend/`, trên `5b5a03c`):
  - `lint:check`, `typecheck`: sạch.
  - `npm test`: 98 suite / 1.770 test.
  - `test:e2e`: 17 suite / 163 test.
  - `test:db` toàn bộ: 63 suite / 892 test đạt, 636 s.
  - `test:services`: `risk-scoring` 1/1, cùng các spec services bị ảnh hưởng bởi đổi `ConsumerBase`: `consumer-base` 4/4, `notification-consumer-review` 4/4, `correlation-chain` 5/5, `outbox-relay` 15/15.
  - `check-doc-links`: 0 link hỏng.
  - Không có `.skip`, `.only` hay `.todo`.
- **Đỏ trước, xanh sau:**
  - TC-111-14: `Property 'prepare' does not exist` → 14/14 xanh.
  - TC-111-12: `Property 'invalidateCounters' does not exist` → 11/11.
  - TC-111-16 (module): `has no exported member 'RiskWorkerModule'` → 16/16.
  - Spec DB consumer: `Cannot find module '@modules/risk/risk-scoring.consumer'` → 13/13.
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-111-01 | `risk-scoring-consumer.db-spec.ts` › TC-111-01 | đạt (75 HIGH, hits R3 35 / R5 40, snapshot đúng 11 key allowlist, không UUID, audit `{"count":2}` cùng `correlationId`) |
| TC-111-02 | › TC-111-02 | đạt (65 MEDIUM, hits đúng {R3, R6}, explanation R6 có "95") |
| TC-111-03 | › TC-111-03 | đạt (decision 30, không cờ/hit/audit) |
| TC-111-04 | › TC-111-04 | đạt (`extract` gọi 1 lần) |
| TC-111-05 | › TC-111-05 | đạt (barrier: cả hai qua `prepare` rồi mới mở transaction; 1 decision, 1 cờ, 1 audit, 2 `processed_events`, không lỗi) |
| TC-111-06 | › TC-111-06 | đạt |
| TC-111-07 | › TC-111-07 | đạt |
| TC-111-08 | › TC-111-08 | đạt |
| TC-111-09 | › TC-111-09 | đạt |
| TC-111-10 | › TC-111-10 | đạt (lần retry sau ghi đủ 1 lần) |
| TC-111-11a/b | `risk-scoring-ai-mode.db-spec.ts` | đạt |
| TC-111-12 | `online-feature-provider.spec.ts` › TC-111-12 | đạt |
| TC-111-13 | `risk-scoring.services-spec.ts` | đạt: 10 cờ 65 MEDIUM {R3, R6}; độ trễ giao dịch → cờ **p50 270 ms, p95 542 ms, max 542 ms** với vòng lặp relay và consumer thật; audit cùng `correlation_id`; gửi lại không thêm cờ |
| TC-111-14 | `consumer-base.spec.ts` › TC-111-14 | đạt |
| TC-111-15 | `risk-scoring-consumer.db-spec.ts` › TC-111-15 | đạt (LOGIN `dbs_worker` thật; UPDATE/DELETE `fraud_flags`/`risk_decisions` → `42501`) |
| TC-111-16 | `modules.spec.ts` › TC-111-16 | đạt (thêm ngoài §4: kiểm module chỉ ở worker/both) |

- **Test thủ công**:
  - Chạy `node dist/main` thành **hai process** `APP_ROLE=api` và `APP_ROLE=worker` (cùng bản `npm run build`) trên DB `banking_dbs111`, với Valkey và ElasticMQ của `docker compose`.
  - Token lấy từ `auth:dev-token`.
  - Output thô ở [manual-test.txt](screenshots/DBS-111/manual-test.txt), dòng đầu là SHA `5b5a03c`; không chứa token.

| Bước | Phản hồi thật (rút gọn) | Kết quả |
|---|---|---|
| M-111-01 | Nạp 21.000.000đ, chuyển 20.000.000đ → 201 | đạt |
| M-111-02 | Cờ tự xuất hiện. Decision `1 | rule_only | 65 | DISABLED`, snapshot allowlist. Cờ `65 | MEDIUM | 1 | OPEN`. Hit R3 "Tài khoản mở dưới 1 phút trước, chuyển 20.000.000đ" và R6 "Chuyển xấp xỉ 95.24% số dư (20000000/21000000đ)". Audit `fraud.flagged | worker | {"count": 2}`, cùng correlation `t` | đạt |
| M-111-03 | Bình chuyển 1.000.000đ cho An → decision `rule_score 20` (R4), 0 cờ | đạt |
| M-111-04 | Giao dịch → cờ: **201 ms** | đạt |
| M-111-05 | Gửi lại đúng payload (`eventId` cũ): số decision/cờ/claim trước 2/1/3, sau 2/1/3 | đạt |
| M-111-06 | `{"eventType":"Bogus"}` → có trong `risk-events-dlq` | đạt |
| M-111-07 | Tắt worker: decision của T7 = 0, outbox chưa gửi = 2. Bật lại: cờ T7 xuất hiện, 65 MEDIUM | đạt |
| M-111-08 | `GET /v1/transfers/{id}`: chỉ id, type, status, amount, thời điểm, tài khoản. Lịch sử: `entryId, transferId, type, direction, amount, balanceAfter, counterpartyAccountId, createdAt`. Không có trường về cờ | đạt |
| M-111-09 | `{"status":"PASS",…,"balance":"0"}`, exit 0 | đạt |

- **Phạm vi so với §7:** các file trong `git diff --stat` thuộc 6 bước, cộng thêm:
  - `modules.spec.ts` (TC-111-16) và `test/support/risk-consumer.ts` (helper dùng chung cho ba spec);
  - `docs/features/README.md`, `FRAUD_DETECTION_GUIDE.md`.

  Không có file code ngoài kế hoạch.
- **Ảnh chụp** (dựng từ chính `manual-test.txt`):

![AC-9.1 cờ tự xuất hiện](screenshots/DBS-111/01-ac91-flag-appears.png)

![LOW, độ trễ, gửi lại, DLQ](screenshots/DBS-111/02-low-latency-redelivery-dlq.png)

![Tắt/bật worker, góc nhìn khách](screenshots/DBS-111/03-worker-restart-customer-view.png)

- **Lệch so với kế hoạch:**
  1. §5 ghi `start:dev:api` và `start:dev:worker`. Thực tế chạy `npm run build` một lần rồi `node dist/main` hai lần với `APP_ROLE` khác nhau, vì hai `nest start --watch` cùng ghi vào `dist` có thể đè nhau. Cùng mã, cùng hai role. Agent tự quyết.
  2. Thêm TC-111-16 (module chỉ ở worker/both) và helper `test/support/risk-consumer.ts`.
- **Bàn giao cho vai khác:**
  - **BL-043** (task tích hợp AI): thay nhánh `scoringConfig` (hiện chấm `rule_only` khi khối `ai` hợp lệ).
  - **BL-046** còn: DLQ của lỗi luật trên queue thật, metric `risk_rule_error_total`.
  - **BL-041** còn: review UC-10 và provider offline.
  - **BL-010** còn: test tự động `UNKNOWN_EVENT_TYPE` riêng cho từng consumer.
  - BL-187, BL-205 (các mục khác mục 8) và BL-223 không đổi.

## 9. Tài liệu đã cập nhật

- `docs/components/risk/02-architecture.md` §4.1: bước `risk_decisions`, action `fraud.flagged`.
- `docs/components/risk/FRAUD_DETECTION_GUIDE.md`:
  - §5.1: bước decision và tên action.
  - §5.6: consumer đã có.
- `backend/src/modules/risk/README.md`: DI và consumer.
- `docs/features/README.md`: dòng DBS-111.
- `docs/BACKLOG.md`:
  - **Xóa BL-224** (bàn giao RSK-01: claim không target, snapshot allowlist, decision trước cờ; TC-111-01/05/06).
  - **Xóa BL-202** (cờ và audit mang `correlationId` của event; TC-111-01/13, M-111-02).
  - **Thu hẹp:**
    - BL-041 (còn UC-10 và provider offline);
    - BL-046 (còn DLQ trên queue thật và metric);
    - BL-188 (phần consumer đã làm);
    - BL-205 mục 8 (phần tăng gen đã làm);
    - BL-010 (risk khai báo `dead-letter`).
  - **Ghi thêm vào BL-043:** nhánh `rule_only` chờ tích hợp AI.
