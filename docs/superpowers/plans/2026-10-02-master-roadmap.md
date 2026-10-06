# Digital Banking Simulator — Master Roadmap (10 tuần)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Đây là roadmap mức cao, không phải plan từng dòng code.** Mỗi "Task" bên dưới là một hệ thống con; trước khi bắt tay vào task nào, viết **plan chi tiết riêng** cho nó (skill `writing-plans`, lưu cạnh file này) với bước test → code → commit. Roadmap này chốt: thứ tự, phụ thuộc, giao diện giữa các task, mốc theo tuần và tiêu chí xong.

**Goal:** Đưa Digital Banking Simulator từ khung NestJS trống tới một luồng chạy thật trên AWS (đăng ký → mở tài khoản → nạp tiền → chuyển tiền → lịch sử → phát hiện gian lận → nhân viên review → kiểm toán tra cứu), cùng 5 demo bắt buộc và 5 bản nộp P1–P5, trong 10 tuần (05/10 → 13/12/2026).

**Architecture:** Modular monolith NestJS, một image chạy theo `APP_ROLE` (`api` / `worker` / `both`). PostgreSQL là nguồn sự thật duy nhất (sổ cái bút toán kép, idempotency và audit cùng transaction); Redis chỉ là cache có đường dự phòng; sự kiện đi qua transactional outbox → SQS (mỗi consumer một queue + DLQ). Fraud là 6 luật hàm thuần chạy bất đồng bộ ở worker, chỉ gắn cờ.

**Tech Stack:** Node.js ≥ 24, TypeScript strict, NestJS 11, TypeORM (+ SQL tường minh trong `QueryRunner`), PostgreSQL 17, Valkey (ioredis), SQS (ElasticMQ ở local), Cognito, Jest + Supertest + Testcontainers, k6, Terraform, GitHub Actions, AWS (ECS Fargate, RDS, ElastiCache, WAF, KMS, CloudWatch).

**Spec:** [`../../01_BUSINESS_ANALYSIS.md`](../../01_BUSINESS_ANALYSIS.md) · [`../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md`](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · [`../../03_HIGH_LEVEL_ARCHITECTURE.md`](../../03_HIGH_LEVEL_ARCHITECTURE.md) · [`../plan/10_WEEK_PLAN.md`](../../plan/10_WEEK_PLAN.md) · [`plan/TEAM_ROLES_PLAYBOOK.md`](../../plan/TEAM_ROLES_PLAYBOOK.md) · [`components/risk/FRAUD_DETECTION_GUIDE.md`](../../components/risk/FRAUD_DETECTION_GUIDE.md). Số liệu bên dưới copy từ các file này; mâu thuẫn thì spec thắng.

## Global Constraints

Áp dụng ngầm cho mọi task.

- **Tiền:** `BIGINT` (đồng) trong DB; `bigint`/string trong domain, API, event; **không bao giờ** `number` có phần thập phân. Driver `pg` trả BIGINT dạng string.
- **Transaction:** `TransactionService.run(...)`, READ COMMITTED + `SELECT … FOR UPDATE` khóa hai tài khoản **theo thứ tự id**; `lock_timeout` 2 s, `statement_timeout` 5 s, `idle_in_transaction_session_timeout` 10 s; deadlock `40P01` chạy lại cả callback tối đa 3 lần; lỗi DB tạm thời → **503 + `Retry-After`**.
- **Không gọi Redis / HTTP / SQS bên trong transaction.** Sự kiện đi qua bảng `outbox_events`.
- **Bất biến:** `ledger_entries` và `audit_log` chỉ INSERT (revoke UPDATE/DELETE); `CHECK (type = 'SYSTEM' OR balance >= 0)`; `SUM(balance)` mọi tài khoản = 0; **không** đưa số dư vào Redis.
- **Hạn mức (GĐ):** 50.000.000đ/lần, 200.000.000đ/ngày (ngày theo `Asia/Ho_Chi_Minh`, chỉ tính tiền đi `DEBIT`); tối đa 3 tài khoản/khách.
- **Lỗi:** `application/problem+json` (RFC 7807) + enum `ErrorCode`; test theo `errorCode`, không theo câu chữ; lệnh `REJECTED` trả **422**; tài nguyên không thuộc mình trả **404** (không phải 403); `correlationId` do server sinh.
- **Idempotency:** header `Idempotency-Key` bắt buộc cho chuyển/nạp tiền; `PRIMARY KEY (user_id, idem_key)`; `INSERT … ON CONFLICT DO NOTHING`.
- **Event:** at-least-once; consumer idempotent bằng `processed_events(consumer, event_id)`; DLQ sau **5** lần lỗi; outbox poll ≤ 1 s; mỗi consumer một queue (`risk-events`, `notification-events`).
- **Module:** import xuyên module chỉ qua `@modules/<tên>` (eslint ép); consumer chỉ khởi động khi `runsWorkers()`.
- **NFR đích:** chuyển tiền p95 < 300 ms ở 120 RPS; đọc p95 < 150 ms; tài khoản nóng 20 lệnh/s p95 < 1 s; fraud từ giao dịch tới cờ p95 < 5 s; availability 99,9 % (production); RPO ≤ 5 phút; RTO ≤ 30 phút; chi phí ≤ $150–200/tháng.
- **Bảo mật:** access token 15 phút *(GĐ)*; rate limit 10 lệnh chuyển/phút/khách và 100 yêu cầu/phút/IP *(GĐ)*; TLS bắt buộc ở production; không secret trong repo/image; GitHub → AWS qua OIDC.
- **Quy trình:** không push thẳng `main`; 1 reviewer (cặp đôi) + CI xanh; squash merge; test liên quan tiền chạy trên **Postgres thật** (Testcontainers), không mock.
- **"Xong"** = đã merge, có test, chạy được trên cloud.

## Review Focus

Năm tình huống mà spec ngụ ý nhưng chưa có test nào trong spec chắc chắn đụng tới; mỗi dòng được gắn vào task sở hữu (xem trường **Review Focus test** của task đó).

1. **Lệnh gốc rollback giữa chừng rồi client gửi lại cùng `Idempotency-Key`** (hoặc lệnh thứ hai đang chờ khóa của lệnh đầu rồi lệnh đầu rollback): lệnh thứ hai phải được xử lý như lệnh mới, không treo, không trả kết quả của lệnh đã rollback. → Task 3.
2. **Giao dịch quanh nửa đêm giờ Việt Nam** (23:59:59 và 00:00:00 `+07`, server/DB chạy UTC): hạn mức ngày phải reset đúng mốc 00:00 `Asia/Ho_Chi_Minh`. → Task 3 (sync guard).
3. **Token phát hành đúng bằng giây của `sessions_revoked_at`** (JWT `iat` làm tròn xuống giây): token cùng giây với mốc thu hồi phải bị từ chối, không lọt. → Task 2.
4. **Sự kiện đến trùng, trễ hoặc đảo thứ tự, và message hỏng định dạng**: cửa sổ R1/R5 tính theo `occurredAt`, không đếm trùng, message hỏng đi thẳng DLQ không retry. → Task 4 và Task 5.
5. **Redis chậm (vượt timeout) chứ không chỉ "chết"**: circuit breaker mở, đường dự phòng Postgres cho R-2/R-3/R-4, rate limit fail-open, `/health/ready` báo degraded chứ không down. → Task 1 và Task 8.

---

## Bản đồ phụ thuộc

```
T0 Chuẩn bị ─▶ T1 Nền tảng & CI/CD ─┬▶ T2 Identity & Accounts ─┐
                                     ├▶ T3 Ledger lõi ◀──────────┤  (lockForUpdate / applyBalanceChange)
                                     └▶ T4 Audit + Outbox ───────┘  (audit.record / outbox writer cho T3)
                                          T3 ─▶ T4 relay ─▶ T5 Consumer & Notification ─▶ T6 Fraud (risk)
                                          T7 Dataset fraud (#6) ──────────────────────────▶ T6 đánh giá
                                          T8 Quality & Load (xuyên suốt, nặng ở tuần 7–9)
                                          T9 Production hardening / P3 / HA / chi phí
                                          T10 Tài liệu, ADR, P1–P5, bảo vệ
```

**Đường găng:** T1 (hạ tầng tuần 1–2) → T2 + T3 (chuyển tiền đúng, tuần 3) → T4/T5 (sự kiện, tuần 4) → T6 (fraud, tuần 4–5). Trễ ở đầu chuỗi thì cả chuỗi trễ. **Tuần 3 là tuần quan trọng nhất.**

---

## Việc chốt trong tuần 0–1 (chặn các task bên dưới)

Các điểm spec còn mở hoặc lệch nhau; mỗi điểm cần một người quyết và ghi vào ADR/issue **trước khi** task phụ thuộc bắt đầu.

- [ ] **Nền tảng:** AWS (cần thẻ quốc tế) hay Azure for Students hay VPS — người giữ tài khoản (mặc định #5). Chặn T1. *(docs/03 §20 câu 5; ADR-11)*
- [ ] **Deadline thật của P1–P5** từ giảng viên; cập nhật `10_WEEK_PLAN.md`. *(§20 câu 1)*
- [ ] **TypeORM hay Kysely** cho luồng chuyển tiền. Khuyến nghị: TypeORM + SQL tường minh trong `QueryRunner` như spec §19. Chặn T3. *(ADR-07)*
- [ ] **Event contract `TransferCompleted`:** doc 03 §10 chưa có `sameOwner`; FRAUD_GUIDE §5.2 đề xuất thêm. Chốt bản có `sameOwner`, `fromBalanceBefore`, `fromAccountCreatedAt`, `toAccountCreatedAt`, `occurredAt`, `correlationId`. Chặn T3, T4, T6. *(owner #3)* — 06/10: đã đưa vào docs/03 §10 và event-contract (thêm `fromUserId`, `toUserId`), chờ #1, #4 đồng ý.
- [ ] **Đồng bộ ERD:** `fraud_rule_hits` có `rule_version` (doc 03 §8.2) nhưng `fraud_flags` đã có `rule_set_version` (FRAUD_GUIDE §5.3) — giữ một nơi (khuyến nghị: `rule_set_version` ở `fraud_flags`). Chặn migration T6. — 06/10: đã sửa docs/02, docs/03 theo khuyến nghị.
- [ ] **Mục tiêu fraud:** NFR-FRD-02 "≤ 10 cảnh báo/1.000 giao dịch" gần như không đạt với luật thủ công (FRAUD_GUIDE §6.4); chốt cặp mục tiêu mới (đề xuất recall ≥ 70 % trên kịch bản luật nhắm tới, ≤ 20 cảnh báo/1.000) và sửa `docs/02`. Chặn đánh giá T6/T7. — 06/10: đã ghi vào docs/01, docs/02 dưới dạng *(GĐ)*, chờ nhóm chốt.
- [ ] **Egress Fargate (ADR-10)** và **Redis Serverless vs node (ADR-12)** — chốt trước tuần 3 để T1 dựng hạ tầng không lỡ tạo NAT Gateway. *(§20 câu 3, 4)*
- [ ] **Giá trị tham số *(GĐ)*:** hạn mức, rate limit, thời gian sống token, thời gian giữ idempotency key (≥ 7 ngày). *(§20 câu 6)*

---

## Tasks

### Task 0: Chuẩn bị (tuần 0 · 01–04/10)

**Owner:** cả nhóm; #2 dẫn dắt, #5 tài khoản cloud.

**Deliverable:** mỗi người có vai; repo + board + kênh chat; tài khoản cloud + cảnh báo chi phí; bảo vệ nhánh `main`; danh sách "việc chốt" ở trên đã có người nhận.

**Files (repo hiện có):** commit lại phần thay đổi đang treo trong working tree (`backend/…`, `README.md`) thành các commit riêng theo Conventional Commits trước khi bắt đầu tuần 1.

- [ ] Gán 6 vai (README mục "Nhóm" đang `_TBD_`) và cặp đôi.
- [ ] #5: tài khoản AWS/Azure, AWS Budget alarm, IAM user + MFA cho từng người, bảo vệ `main` (1 review + CI xanh).
- [ ] #2: board có đủ issue tuần 1–2; lịch họp thứ Hai / thứ Năm; kênh chat; file theo dõi deadline.
- [ ] Làm sạch working tree: review diff đang treo, tách commit, đảm bảo `npm run lint:check && npm run typecheck && npm test && npm run test:e2e` xanh trên `main`.

**Exit:** mọi người đăng nhập được cloud; có cảnh báo chi phí; `main` xanh và được bảo vệ.

---

### Task 1: Nền tảng, CI/CD, Redis/SQS adapters, khung test (tuần 1–3)

**Owner:** #5 (hạ tầng, CI/CD) · #6 (khung test) · #3 (adapter SQS) · #2 (adapter Redis/Cognito JWKS). **Cặp đôi:** #5 ↔ #6.

**Files:**
- Create: `infra/terraform/{bootstrap,modules/{network,ecs,rds,redis,sqs,cognito,monitoring},envs/{dev,prod}}`, `.github/workflows/{ci.yml,deploy.yml}`.
- Create: `backend/src/libs/{redis,sqs,cognito}/` (adapter), `backend/test/support/{postgres,valkey,elasticmq}.container.ts` (Testcontainers).
- Modify: `backend/Dockerfile` (CA bundle RDS, health check cho worker), `backend/src/modules/health/health.controller.ts` (thêm trạng thái Redis *degraded*).

**Interfaces:**
- Produces (cho T2–T6): biến môi trường chuẩn trong `backend/env/.env.example`; endpoint `/health/live`, `/health/ready`; `RedisClient` với timeout ≤ 50 ms *(GĐ)* + circuit breaker (`opossum`) và API `get/set/incr/zadd…` có đường lỗi tường minh; `SqsClient.send(queue, body)` / `receive(queue)`; helper Testcontainers khởi tạo Postgres + Valkey + ElasticMQ dùng chung cho mọi e2e.
- Consumes: `docker-compose.yml`, `infra/local/elasticmq.conf` (đã có).

**Mốc theo tuần:**
- **T1:** Terraform nền (state S3 + versioning + mã hóa, VPC, ECR, ECS), CI build + test + push image, deploy `/health/ready` lên cloud; khung Testcontainers chạy trong CI với một test mẫu xanh.
- **T2:** RDS + Secrets Manager; app kết nối DB trên cloud qua TLS (`DATABASE_SSL_CA_PATH`, **kiểm bundle CA trên RDS thật**); pipeline migration là bước riêng trước deploy.
- **T3:** ElastiCache + SQS + DLQ; chốt ADR-10; hạ tầng đủ thành phần.

- [ ] Terraform dev dựng/xóa được bằng `apply`/`destroy` trong một lệnh; phần giữ lại (S3 state, ECR, VPC, Cognito) tách khỏi phần xóa hằng ngày (RDS, ElastiCache, ALB, WAF, ECS service).
- [ ] CI: lint → typecheck → unit → e2e (Testcontainers) → build image → quét lỗ hổng → quét secret → push ECR (tag = SHA). Deploy bằng OIDC, **không** access key trong GitHub Secrets.
- [ ] Redis adapter: khi Redis chậm vượt timeout → circuit breaker mở → caller nhận lỗi tường minh để rơi về dự phòng; metric `redis_fallback_total`.
- [ ] `/health/ready` trả 200 khi Postgres ổn và Redis chết (báo *degraded*).
- [ ] **Review Focus test (5):** test adapter Redis với server **chậm** (không chỉ tắt) → breaker mở trong ≤ ngưỡng, request nghiệp vụ không vượt SLO.

**Exit:** push lên `main` → tự lên cloud; luồng đầu tiên (T2 xong) chạy trên cloud; `terraform destroy` dev về chi phí ≈ 0 phần dựng/xóa; **không có NAT Gateway** trừ khi ADR-10 cho phép.

---

### Task 2: Identity & Accounts (tuần 2–4)

**Owner:** #2 · **Cặp đôi:** #3. **Use case:** UC-1, 2, 4, 11 · **AC:** AC-5.8, AC-11.1–11.3 · **FR:** FR-ID-01…05, FR-ACC-01…03.

**Files:**
- Create: `backend/src/modules/{identity,accounts}/` (module, controller, service, `dto/`, `entities/`, `index.ts`), migration `users`, `customers`, `accounts` (gồm tài khoản SYSTEM `funding`).
- Modify: `backend/src/modules/index.ts` (đăng ký vào `sharedModules`/`apiModules`).

**Interfaces:**
- Produces (cho T3): `AccountsService.lockForUpdate(ids: string[], manager: EntityManager): Promise<LockedAccount[]>` (khóa theo thứ tự id), `AccountsService.applyBalanceChange(accountId: string, delta: bigint, manager: EntityManager): Promise<void>`, `AccountsService.getOwnedAccount(accountId: string, userId: string): Promise<Account>` (ném 404 nếu không thuộc mình). `IdentityService.revokeSessions(userId: string, manager: EntityManager): Promise<void>`. Guard `@Roles('customer'|'operator'|'auditor'|'admin')`, decorator `@CurrentUser()`.
- Consumes: `AuditService.record(manager, …)` (T4), `RedisClient` (T1).

**Mốc theo tuần:** T2 đăng ký → onboarding → mở tài khoản chạy được · T3 kiểm sở hữu mọi endpoint, rate limit toàn cục · T4 khóa/mở khóa + thu hồi phiên đồng bộ trong cùng lệnh.

- [ ] JWT verify bằng JWKS (cache khóa công khai); nhóm Cognito `customer`/`operator`/`auditor`/`admin` khớp tên đã thỏa thuận với #5.
- [ ] Mở tài khoản: tối đa 3 (`ACCOUNT_LIMIT_REACHED`), kiểm trong transaction có khóa hàng `customers`.
- [ ] Khóa tài khoản = đổi `LOCKED` + `users.sessions_revoked_at = now()` + audit + outbox(`AccountStatusChanged`) trong **một** transaction; sau commit mới `SET revoked_at:{userId}` ở Redis (TTL = thời gian sống token); Redis lỗi → đọc Postgres.
- [ ] **Review Focus test (3):** token có `iat` **bằng** giây của `sessions_revoked_at` bị từ chối `SESSION_REVOKED`; token phát hành giây kế tiếp được chấp nhận (khi tài khoản khác còn ACTIVE).
- [ ] Test AC-5.8: A truy cập tài khoản của C → **404**, có audit lần bị từ chối.
- [ ] Tra cứu cho nhân viên (FR-ACC-04): `GET /v1/operator/accounts` theo `accountId` hoặc tên khách, tối đa 20 kết quả, không trả số dư, mỗi lần tra cứu ghi audit.
- [ ] Dòng `users` tạo bằng upsert theo `cognito_sub` ở token hợp lệ đầu tiên của mọi vai trò; cách xác thực khi chạy local và test (khóa ký thử nghiệm) chốt cùng #6.

**Exit:** AC-5.8, AC-11.1–11.3 xanh trong CI trên Postgres thật; OpenAPI có ví dụ cho mọi endpoint của module.

---

### Task 3: Ledger lõi — chuyển tiền, nạp tiền, idempotency, sync guard, đối soát (tuần 1–4, **đường găng**)

**Owner:** #1 + #4 (sync guard) · **Cặp đôi:** #1 ↔ #4. **Use case:** UC-3, 5, 6, 7 · **AC:** AC-5.1…5.10 · **FR:** FR-LED-01…10 · **ADR:** 01, 02, 04, 05, 07, 09.

**Files:**
- Create: `backend/src/modules/ledger/{ledger.module.ts,transfers.controller.ts,operator-deposits.controller.ts,transfer.service.ts,sync-guard.ts,ledger-query.service.ts,reconciliation.job.ts,dto/,entities/,index.ts}`.
- Create: migrations `transfers`, `ledger_entries`, `idempotency_keys`, `outbox_events` (+ index `ledger_entries(account_id, created_at)`, `transfers(from_account_id, created_at)`, `transfers(from_account_id, to_account_id, created_at)` (chi tiết ở database-design §6)) và revoke UPDATE/DELETE trên `ledger_entries`.
- Test: `backend/test/ledger/*.e2e-spec.ts` (Postgres thật).

**Interfaces:**
- Consumes: `AccountsService.lockForUpdate / applyBalanceChange` (T2), `AuditService.record(manager, { actor, action, target, correlationId })` và `OutboxWriter.add(manager, event)` (T4), `RejectReason`, `ErrorCode` (đã có).
- Produces: `POST /v1/transfers`, `POST /v1/operator/deposits` (bắt buộc `Idempotency-Key`), `LedgerQueryService.listTransactions(accountId, { cursor, from, to })` và `.getTransfer(id, userId)` (cho UC-6/7); sync guard `checkGuards(manager, lockedFrom, lockedTo, amount): Promise<RejectReason | null>` (async: chạy truy vấn tổng tiền đi trong ngày, nên người gọi phải `await`); event `TransferCompleted` ghi vào outbox cùng transaction; job đối soát (tổng Nợ = tổng Có, `balance` = tổng bút toán, tổng số dư = 0).

**Mốc theo tuần:** T1 ERD + migration đầu · T2 chuyển tiền bản thô + nạp tiền (nạp → chuyển → xem số dư) · T3 `ON CONFLICT DO NOTHING`, khóa theo thứ tự id, lưu `REJECTED`, retry deadlock, sync guard sau `FOR UPDATE` · T4 job đối soát có alarm.

- [ ] Luồng đúng thứ tự docs/03 §6.1: `INSERT idempotency_keys ON CONFLICT DO NOTHING` → (nếu đã có: `SELECT` response, trả lại; `request_hash` khác → `IDEMPOTENCY_KEY_REUSED` 422) → `FOR UPDATE` 2 tài khoản theo id → sync guard (ACTIVE → hạn mức lần → hạn mức ngày → số dư) → `INSERT transfers + 2 ledger_entries` + cập nhật số dư + outbox + audit → lưu response vào key → commit.
- [ ] Nạp tiền dùng cùng luồng với `type = DEPOSIT`, nguồn là tài khoản SYSTEM `funding`, chỉ `operator`, bỏ qua số dư/hạn mức của SYSTEM.
- [ ] Hạn mức ngày: `SUM(amount) WHERE direction='DEBIT' AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'`, chạy **sau** `FOR UPDATE`, ≤ 5 ms.
- [ ] Test AC-5.1…5.10 trên Postgres thật, gồm: 10 request cùng key **song song** → 1 giao dịch + 2 bút toán (AC-5.4); 2 lệnh 15 tr song song khi đã chuyển 180 tr → đúng 1 `COMPLETED` (AC-5.6); chuyển chéo đồng thời + tài khoản nóng → bất biến đúng (AC-5.9); kill giữa transaction rồi gửi lại cùng key → thực hiện đúng một lần (AC-5.10).
- [ ] **Review Focus test (1):** lệnh A cùng key K đang giữ khóa, lệnh B (cùng K) chờ trên `ON CONFLICT`; A rollback (ném lỗi giữa chừng) → B xử lý như lệnh mới và `COMPLETED`; số dư thay đổi đúng một lần.
- [ ] **Review Focus test (2):** đồng hồ giả/`SET TIME ZONE` UTC: lệnh lúc 23:59:59+07 tính vào ngày cũ, 00:00:00+07 tính vào ngày mới; hạn mức ngày reset đúng.
- [ ] Số tiền lớn (> 2^53, ví dụ `"9007199254740993"`) đi qua API → DB → response không mất chữ số (không `number`).
- [ ] Seed dữ liệu test qua API nạp tiền, không `UPDATE balance` trực tiếp (thỏa thuận với #6).

**Exit:** AC-5.1…5.10 xanh trong CI; đối soát chạy định kỳ, 0 lệch; p95 chuyển tiền đo lần đầu trên cloud (bản tối ưu ở T8); danh sách nợ kỹ thuật ledger trống sau demo giữa kỳ.

---

### Task 4: Audit + Outbox + Event contract (tuần 1–5)

**Owner:** #3 · **Cặp đôi:** #2. **Use case:** UC-8 · **AC:** AC-8.1, AC-8.2 · **FR:** FR-AUD-01…04 · **ADR:** 03.

**Files:**
- Create: `backend/src/modules/audit/{audit.module.ts,audit.service.ts,audit.controller.ts,entities/audit-log.entity.ts,index.ts}`, `backend/src/modules/outbox/{outbox.module.ts,outbox.writer.ts,outbox-relay.service.ts,routing.ts,consumer-base.ts,entities/,index.ts}`, `backend/src/common/events/transfer-completed.event.ts` (contract dùng chung), migrations `audit_log`, `processed_events`.
- Modify: `backend/src/modules/index.ts` (`OutboxModule`, `NotificationModule` vào `workerModules`).

**Interfaces:**
- Produces: `AuditService.record(manager, { actor, action, target, correlationId }): Promise<void>` (ném lỗi → rollback, fail-closed); `OutboxWriter.add(manager, event: DomainEvent): Promise<void>`; bảng định tuyến `TransferCompleted → [risk-events, notification-events]`, `TransferRejected → [risk-events]`, `AccountStatusChanged → [notification-events]`; khung consumer `ConsumerBase.handle(message)` (ghi `processed_events(consumer, event_id)` cùng transaction với tác động; message hỏng → DLQ ngay).
- Consumes: `TransactionService`, `SqsClient` (T1).

**Mốc theo tuần:** T1 contract + schema `outbox_events`/`processed_events` · T2 `AuditService.record` · T3 relay (`SELECT … FOR UPDATE SKIP LOCKED`, gửi theo bảng định tuyến, chạy với ElasticMQ) · T4 khung consumer idempotent, notification, DLQ, API tra cứu audit · T5 `correlationId` xuyên suốt API → outbox → consumer → audit.

- [ ] Relay gửi **sau** commit, set `published_at` sau khi gửi mọi queue; sự cố giữa chừng gửi lại (at-least-once); job dọn outbox sau 7 ngày *(GĐ)*.
- [ ] `GET /v1/audit/entries` lọc theo người/hành động/thời gian/`correlationId`; việc tra cứu tự ghi audit; role `auditor` chỉ đọc.
- [ ] Test AC-8.1 (auditor sửa/xóa → bị từ chối, DB role không có UPDATE/DELETE), AC-8.2 (tra theo `correlationId` thấy chuỗi yêu cầu → ghi sổ → thông báo → cờ → review).
- [ ] **Review Focus test (4):** gửi cùng `eventId` 3 lần → 1 hiệu ứng; message sai schema → vào DLQ sau 1 lần nhận (không retry 5 lần); relay chết sau commit trước khi gửi → bật lại gửi bù.

**Exit:** chuyển tiền → message vào đúng 2 queue; tắt/bật worker, outbox được xử lý bù; tra được một giao dịch end-to-end bằng `correlationId` dưới 5 phút.

---

### Task 5: Consumers & Notification & vận hành bất đồng bộ (tuần 4–8)

**Owner:** #3 · **Cặp đôi:** #2.

**Files:** `backend/src/modules/notification/{notification.module.ts,notification.consumer.ts,entities/notification-log.entity.ts,index.ts}` (v1 chỉ ghi log).

**Interfaces:** Consumes `ConsumerBase`, queue `notification-events` (T4). Produces: metric `dlq_depth`, `oldest_message_age`; alarm DLQ > 0.

- [ ] Notification không bao giờ làm hỏng chuyển tiền; retry có backoff + circuit breaker; **không** nêu lý do gian lận trong thông báo khóa tài khoản (BR-13).
- [ ] T6: alarm DLQ > 0 và tuổi message cũ nhất. T7: tối ưu relay (chu kỳ poll, kích thước lô) để p95 tới khi có cờ < 5 s. T8: giả lập consumer lỗi liên tục, message hỏng, notification chết.
- [ ] **Review Focus test (4):** consumer lỗi liên tục → message sang DLQ đúng sau 5 lần và alarm bật; consumer khác (risk) không bị chặn.

**Exit:** AC-9.2 (cùng sự kiện hai lần → 1 cờ) và demo "consumer lỗi → DLQ" chạy lại được bất cứ lúc nào.

---

### Task 6: Fraud — module `risk` (tuần 1–7)

**Owner:** #4 · **Cặp đôi:** #1. **Use case:** UC-9, 10, 12 · **AC:** AC-9.1, 9.2, 10.1, 10.2 · **ADR:** 08, 12 (phần bộ đếm). **Chi tiết:** [`components/risk/FRAUD_DETECTION_GUIDE.md`](../../components/risk/FRAUD_DETECTION_GUIDE.md).

**Files:**
- Create: `backend/src/modules/risk/{risk.module.ts,risk-flags.controller.ts,risk-config.controller.ts,risk-scoring.consumer.ts,scoring.service.ts,entities/,rules/{rule.ts,r1-velocity.rule.ts,…,r6-drain.rule.ts},features/{feature-provider.ts,online-feature-provider.ts,offline-feature-provider.ts},config/rule-set.repository.ts,index.ts}`, migrations `risk_rule_sets`, `fraud_flags`, `fraud_rule_hits`, DB role riêng cho worker; script đánh giá offline `backend/src/scripts/evaluate-rules.ts`.

**Interfaces:**
- Consumes: event `TransferCompleted` từ `risk-events` (T4), `ConsumerBase` (T4), `RedisClient` (T1), `AuditService` (T4).
- Produces: `interface RiskRule { id: 'R1'|…|'R6'; evaluate(event, features, params): RuleHit | null }` (hàm thuần); `FeatureProvider` (online: Redis + SQL; offline: dữ liệu trong bộ nhớ); `GET /v1/operator/fraud-flags`, `GET …/{transferId}`, `POST …/{transferId}/review` (`CONFIRMED_FRAUD`/`FALSE_POSITIVE`, chỉ một lần); `GET/POST /v1/admin/risk-config…` (phiên bản bất biến).

**Mốc theo tuần:** T1–2 chốt luật, schema, interface · T3 sync guard cùng #1 (thuộc Task 3) · T4 6 luật + consumer + Redis + dự phòng SQL → "chuyển tiền xong thì cờ tự xuất hiện" · T5 API review + đánh giá lần đầu trên tập tune · T6 chỉnh tham số, test so khớp online/offline · T7 đóng băng cấu hình, chạy holdout **một lần**, ablation, đường PR.

- [ ] Mọi cửa sổ thời gian tính theo `occurredAt`; R3/R6 dùng snapshot trong event, không đọc số dư hiện tại; chấm điểm chỉ `TRANSFER`, bỏ qua `DEPOSIT`; `sameOwner` miễn R5/R6.
- [ ] Điểm = tổng trọng số luật kích hoạt (R1 30, R2 25, R3 35, R4 20, R5 40, R6 30 *(GĐ)*); `0–39 LOW` (không cờ), `40–69 MEDIUM`, `≥ 70 HIGH`; ví dụ bảng §4.3 của guide thành unit test.
- [ ] Khách không thấy cờ: không endpoint customer nào trả trường về cờ (AC-10.2).
- [ ] Review lần hai trả 409 `FLAG_ALREADY_REVIEWED` (AC-10.1).
- [ ] Cấu hình luật: `cfg:risk:latest` trỏ phiên bản hiện hành (TTL 60 giây, miss thì `max(version)` từ DB), `cfg:risk:v{n}` bất biến.
- [ ] Redis lỗi → dự phòng SQL cho R1/R5, kết quả không đổi (test bật/tắt Redis).
- [ ] Test so khớp: `OnlineFeatureProvider` và `OfflineFeatureProvider` cho cùng đặc trưng trên cùng dữ liệu.
- [ ] **Review Focus test (4):** sự kiện đến muộn (worker xử lý sau 30 phút) cho cùng kết quả như xử lý tức thì; hai sự kiện đảo thứ tự `occurredAt` vẫn đếm R1 đúng; cùng `transferId` hai lần → R1 không đếm đôi (member sorted set là `transferId`).

**Exit:** AC-9.1, 9.2, 10.1, 10.2 xanh; có bảng trước/sau tune; số liệu holdout đủ cho P5 (precision, recall, F1, recall theo kịch bản, ablation, đường PR).

---

### Task 7: Bộ dữ liệu gian lận tổng hợp (tuần 2–7)

**Owner:** #6 · **Người dùng:** #4. **Bức tường:** #4 **không** xem code generator.

**Files:** `load-tests/fraud-dataset/` (generator, seed cố định, CSV tune/holdout). Định dạng: `tx_id, occurred_at, from_account, to_account, from_customer, to_customer, amount, from_balance_before, from_account_created_at, to_account_created_at, is_fraud, scenario`.

- [ ] ~2.000 khách, 60 ngày, ~100.000 giao dịch, ~1 % gian lận; hard negatives (tiền nhà, chuyển sang tài khoản của chính mình, khách mới nhận lương, chia tiền ăn nhóm, mượn–trả trong ngày); kịch bản `ATO_DRAIN`, `MULE_FANOUT`, `VELOCITY_BURST`, `BUST_OUT`, `ROUND_TRIP` và 3 kịch bản ngoài tầm luật `SLOW_DRIP`, `STRUCTURING`, `FAN_IN`.
- [ ] Chia theo **khách hàng** 70 % tune / 30 % holdout; giao tập tune tuần 4; giữ nhãn holdout tới tuần 7.

**Exit:** #4 chạy offline được trên tập tune; holdout được dùng đúng một lần.

---

### Task 8: Quality, load test, giả lập sự cố, quan sát (tuần 1–9)

**Owner:** #6 · **Cặp đôi:** #5. **ADR/NFR:** NFR-PERF/SCAL/OBS · **Demo:** 5 demo bắt buộc.

**Files:** `backend/test/**` (concurrent, duplicate, security, failure), `load-tests/{baseline,hot-account,duplicate,stress,rate-limit}.js` (k6), `load-tests/check-invariants.sh` (hoặc script SQL), dashboard + alarm CloudWatch (cùng #2).

**Interfaces:** Consumes mọi API; Produces: báo cáo p95/p99/error rate ở 12 → 60 → 120 RPS, tài khoản nóng 20 lệnh/s, stress tìm điểm gãy, có/không Redis; SLO chính thức.

- [ ] T3: test đồng thời (N luồng, tài khoản nóng, kiểm tra bất biến) và request trùng song song (AC-5.4, 5.6, 5.9). T4: test tắt/bật worker, DLQ. T6: test bảo mật (truy cập chéo, auditor chỉ đọc, khách không thấy cờ). T7: load test + bật/tắt Redis + đo fraud online. T8: giả lập sự cố đầy đủ, P4.
- [ ] **Sau mỗi** load test chạy kiểm tra bất biến: tổng Nợ = tổng Có, tổng số dư = 0, không tài khoản khách nào âm.
- [ ] Load test chạy từ một máy cùng region, không từ laptop qua mạng nhà.
- [ ] **Review Focus test (5):** tắt Redis **và** làm Redis chậm giữa load test → bất biến vẫn đúng, p95 chuyển tiền trong ngưỡng, `/health/ready` còn 200.
- [ ] Mọi test "xanh rồi đỏ" (flaky) được điều tra như lỗi đồng thời, không bỏ qua.

**Exit:** báo cáo load test số liệu thật; 5 demo chạy lại được bất cứ lúc nào; p95 chuyển tiền < 300 ms ở 120 RPS, lỗi < 0,1 % liên tục 15 phút.

---

### Task 9: Production hardening, bảo mật, HA, chi phí (tuần 4–10)

**Owner:** #5 · **Cặp đôi:** #6. **Deliverable:** P3, bằng chứng HA cho P4 · **ADR:** 06, 10, 11, 12.

**Files:** `infra/terraform/envs/prod`, WAF, KMS, IAM role riêng cho task `api` và `worker`, quét image, threat model STRIDE (`docs/` cùng #2).

- [ ] T4: IAM quyền tối thiểu cho từng task; DB role `dbs_api`, `dbs_worker`, `dbs_migrator` theo ma trận database-design §8 (worker đọc giao dịch qua view `v_transfer_facts`). T6: cấu hình production, WAF, KMS, quét image, demo rollback ≤ 10 phút (về task definition cũ), threat model. T7: đo chi phí thật hằng tuần. T8: bật Multi-AZ, demo RDS failover, so sánh chi phí hai cấu hình. T10: `terraform destroy` phần thừa, kiểm tra hóa đơn.
- [ ] `TRUST_PROXY_HOPS=1` (ALB) ở production; `DATABASE_SSL=true`, Redis `rediss://`.
- [ ] Migration chạy như bước pipeline riêng, **không** lúc app khởi động; kiểu expand → migrate → contract.

**Exit:** nộp P3; demo rollback; chi phí tuần có số thật; sau T10 chi phí về ≈ 0.

---

### Task 10: Tài liệu, ADR, bản nộp, bảo vệ (xuyên suốt, nặng tuần 1, 2, 6, 8, 9, 10)

**Owner:** #2 (ghép/nộp) · mỗi người tự viết phần của mình · #1 duyệt ADR.

- [ ] **P1 (T1)** từ docs 01–02 · **P2 (T2)** + ≥ 3 ADR (01, 02, 03; dự kiến 13, đổi `Proposed` → `Accepted` ngay khi chốt) · **P3 (T6)** · **P4 (T8)** · **P5 (T9)** (#4 viết). Ghép bản cuối T10.
- [ ] Khi đổi thiết kế/contract: cập nhật `docs/` và ADR **trong cùng PR**; đổi OpenAPI khi đổi API.
- [ ] T9: tổng duyệt, mỗi người có bằng chứng (test/số liệu/ảnh/video) cho câu bảo vệ được giao (1–12); T10: 2–3 ngày dự phòng, **không thêm việc mới**.

---

## Lịch theo tuần (cổng ra)

| Tuần | Ngày | Mục tiêu | Cổng ra — phải đúng mới sang tuần sau |
|---|---|---|---|
| 0 | 01–04/10 | Chuẩn bị (T0) | Có vai, repo, tài khoản cloud, cảnh báo chi phí, `main` xanh |
| 1 | 05–11/10 | **P1** + khung chạy (T1, T3 schema, T4 contract) | Nộp P1; push → tự lên cloud; contract `TransferCompleted` chốt |
| 2 | 12–18/10 | **P2** + API nền (T2, T3 bản thô, T4 audit) | Nộp P2; mở TK → nạp tiền → xem số dư chạy **trên cloud** |
| 3 | 19–25/10 | **Lõi đúng-sai** ⚠️ (T3, T2, T4 relay, T1 Redis/SQS) | AC-5.1…5.10 xanh trong CI; test đồng thời + chống trùng xanh |
| 4 | 26/10–01/11 | Bất đồng bộ + nhân viên (T5, T6 luật, T2 khóa, T3 đối soát) | Chuyển tiền xong → cờ tự xuất hiện; AC-8.x, 9.x, 11.x xanh |
| 5 | 02–08/11 | **Demo giữa kỳ** | Video demo toàn luồng; danh sách nợ kỹ thuật; số liệu fraud đầu tiên |
| 6 | 09–15/11 | **P3** bảo mật & DevOps (T9) | Nộp P3; demo rollback; threat model; test bảo mật xanh |
| 7 | 16–22/11 | Load test & giám sát (T8) | Báo cáo load test thật; holdout chạy **một lần**; đo chi phí |
| 8 | 23–29/11 | **P4** vận hành | Nộp P4; Multi-AZ failover; 5 demo chạy lại được |
| 9 | 30/11–06/12 | **P5** + tổng duyệt | Nộp P5; chạy lại toàn bộ test/load; không ai "bí" câu bảo vệ |
| 10 | 07–13/12 | Dự phòng + nộp | Nộp bài; xóa tài nguyên thừa; hóa đơn ≈ 0 |

## Rủi ro và cách giảm

| Rủi ro | Tín hiệu | Xử lý |
|---|---|---|
| Chuyển tiền chưa đúng ở tuần 3 | AC-5.4/5.6/5.9 đỏ hoặc flaky | Ưu tiên tuyệt đối; kéo #2 hỗ trợ #1; hoãn mọi việc ngoài đường găng |
| #1, #2 quá tải | PR chờ review > 1 ngày | #3 hỗ trợ P2; mỗi người tự viết phần tài liệu của mình |
| Chi phí cloud vượt | Báo cáo chi phí thứ Hai > kế hoạch | `destroy` ngoài giờ; WAF chỉ bật tuần 6–8; không NAT |
| Generator dữ liệu trễ | Tuần 4 chưa có tập tune | #4 tự làm bộ nhỏ thủ công để test luật (không dùng cho đánh giá cuối) |
| Kết quả fraud "đẹp bất thường" | Precision/recall ≈ 100 % | Kiểm tra bức tường #4/#6, rò rỉ nhãn, chia tập sai |
| Deadline thật khác giả định | Giảng viên báo lịch | Cập nhật `10_WEEK_PLAN.md` và bảng trên, giữ thứ tự việc |

## Self-review (đã chạy)

- **Phủ spec:** UC-1…12 → T2 (1, 2, 4, 11), T3 (3, 5, 6, 7), T4 (8), T6 (9, 10, 12); NFR → T3 (COR), T8 (PERF/SCAL/OBS), T9 (SEC/AVL/REC/COST/MNT); 5 demo → T3 + T5 + T8; ADR-01…13 → T10 + task sở hữu.
- **Nhất quán tên:** `lockForUpdate`, `applyBalanceChange`, `getOwnedAccount`, `AuditService.record`, `OutboxWriter.add`, `ConsumerBase`, `RejectReason`/`ErrorCode` dùng giống nhau ở Interfaces của T2/T3/T4/T6.
- **Phát hiện khi viết:** (a) `sameOwner` thiếu trong event doc 03 §10; (b) `rule_version` vs `rule_set_version` lệch giữa doc 03 và FRAUD_GUIDE; (c) NFR-FRD-02 ≤ 10 cảnh báo/1.000 không khả thi; (d) working tree đang có nhiều thay đổi chưa commit. Cả bốn nằm trong danh sách "Việc chốt" / Task 0.
- **Việc tiếp theo:** viết plan chi tiết cho **Task 3 (Ledger lõi)** trước (đường găng), sau đó Task 1 và Task 2 song song.
