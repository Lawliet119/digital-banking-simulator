# DBS-56 · AuditService.record: ghi nhật ký fail-closed trong transaction của người gọi

> **Status:** Implemented (sau G4) · **Vai:** Dev · **Cặp đôi review:** chưa chỉ định (không có pair cố định, xem `references/team.md`) · **Nhánh:** `feat/DBS-56-audit-service-record` · **PR:** — · **Cập nhật:** 2026-10-26

## 1. Bối cảnh

- **Task trên board:** Story · Tuần 2 · Deliverable/Demo: P2.
  **Expect:** "Mọi thao tác ghi đều để lại nhật ký trong cùng transaction."

- **DoD** (chép nguyên văn từ sheet, đánh số):
  1. `AuditService.record(manager, { actor, role, action, outcome, target, correlationId, metadata })` export qua `index`.
  2. Lỗi ghi audit làm cả transaction rollback (test fail-closed).
  3. `outcome` ∈ `SUCCESS | REJECTED | DENIED`; ghi rõ cách đảm bảo bản ghi `DENIED` (ví dụ 404 do không sở hữu) vẫn tồn tại dù lệnh bị từ chối (transaction riêng hoặc ghi trước khi ném lỗi) và có test.
  4. `metadata` chỉ gồm id, lý do, số đếm; không tên, email, số tài khoản đầy đủ.
  5. PR đã merge vào `main` (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ.

- **Phụ thuộc:**
  - DBS-26 "Migration: audit_log" (Tuần 1) — sheet ghi **Done**. **Xác minh thật trong repo:** local ban đầu thiếu 9 commit so với `origin/main` nên tưởng DBS-26 chưa tồn tại; sau `git fetch origin` xác nhận migration `CreateAuditLog1792627200001` (commit `f33a1b5`, PR #13) và trigger append-only `AddAppendOnlyTriggers1792627200002` (DBS-27, commit `7ce5a23`) **đã merge vào `main`**. Phụ thuộc thật sự **Done** — không cần giảm phạm vi.

- **Đã có gì:**
  - Bảng `audit_log` (10 cột, 3 index, CHECK `outcome`, FK `actor_user_id → users.id ON DELETE RESTRICT`) — `backend/src/database/migrations/1792627200001-CreateAuditLog.ts`.
  - Trigger append-only (chặn UPDATE/DELETE/TRUNCATE, SQLSTATE `42501`) — `backend/src/database/migrations/1792627200002-AddAppendOnlyTriggers.ts`.
  - Test schema/migration đã có: `backend/test/db/audit-schema.db-spec.ts`, `backend/test/db/audit-migration-revert.db-spec.ts` (thuộc DBS-26/27, không lặp lại ở đây).
  - `backend/src/modules/audit/README.md` — hợp đồng thiết kế đầy đủ (chữ ký `record()`, quy tắc fail-closed, DENIED trong transaction riêng), nhưng **chưa có bất kỳ file `.ts` nào** triển khai (không entity, không service, không module).
  - Tài liệu liên quan: `docs/components/_shared/database-design.md` §4.7; `docs/components/audit/01-concept-brief.md`; `docs/security/threat-model.md` T10/T11 (gắn trực tiếp DBS-56); `.claude/skills/dbs-delivering-task/references/module-notes.md` mục "Async, events và audit".
  - `docs/BACKLOG.md`: **BL-019** — đúng module/DoD này ("Schema audit chưa cung cấp AuditService/API tra cứu, policy metadata không PII, fail-closed... hoặc production roles"). DBS-56 giải quyết **một phần** (AuditService + policy PII + pattern fail-closed/DENIED), không giải quyết phần API tra cứu (UC-8) và production role grants (`dbs_api`/`dbs_worker`) — BL-019 sẽ được **thu hẹp nội dung**, không xóa, ở Phase 5. BL-020 (xác minh PR DBS-26) không liên quan tới DBS-56.

  **Baseline** (branch `feat/DBS-56-audit-service-record`, tạo từ `origin/main` mới nhất, Docker Desktop đã chạy):
  | Lệnh | Kết quả |
  |---|---|
  | `npm run lint:check` | sạch, 0 lỗi |
  | `npm run typecheck` | sạch, 0 lỗi |
  | `npm test` (unit) | 30 suites / 495 tests pass |
  | `npm run test:e2e` | 8/8 suites, 57 tests pass |
  | `npm run test:db` (Testcontainers) | 8/8 suites, 154 tests pass |

  Máy local có PostgreSQL khác chiếm cổng 5432 (không liên quan `docker compose` của repo) — đúng tình huống đã lường trước ở `references/manual-testing.md`: "Port 5432 already used by another PostgreSQL on this machine". Đã remap `postgres` sang cổng 5433 bằng compose override **ngoài repo** (không commit) và trỏ `DATABASE_URL` vào đó để chạy `test:e2e` (suite `app-guard.e2e-spec.ts` boot `AppModule` thật, cần Postgres thật trên máy, không qua Testcontainers). `test:db` dùng Testcontainers (cổng ngẫu nhiên riêng) nên không bị ảnh hưởng. Bất kỳ test thủ công/manual test (Phase 4c) sau này trên máy này cũng cần remap tương tự; sẽ ghi cụ thể ở §5.

- **Ngoài phạm vi** (mỗi dòng: việc, chủ đề xuất):
  - Code thật cho `ledger`/`accounts`/`risk` gọi `AuditService.record`/`recordDenied` — ledger #1, accounts #2, risk #4 (task sở hữu module đó).
  - Migration/grant quyền DB production (`dbs_api` SELECT+INSERT, `dbs_worker` INSERT-only) trên `audit_log`, và test `record()` dưới role đó thật (không phải role tự tạo trong test) — task roles (Dev/Ops).
  - API tra cứu `GET /v1/audit/entries` (UC-8, FR-AUD-03) — task UC-8.
  - Ghi nhật ký cho **xem** dữ liệu nhạy cảm (FR-AUD-02, ví dụ nhân viên xem cờ gian lận) — các điểm đọc này không có `manager`/transaction sẵn, `record(manager,...)` không vừa; cần `recordDenied`-kiểu helper riêng cho đường đọc — task sở hữu UC-8/risk (#4) khi họ wire vào.
  - Đọc `correlationId` từ `AsyncLocalStorage` (DBS-43, chưa merge vào `main`) — `correlationId` là tham số bắt buộc do tầng gọi truyền vào.
  - Registry đóng (closed enum) cho `action`/`role`/`target.id` để chặn PII triệt để qua các field tự do này — nền tảng backend, ai chạm `audit`/`ledger`/`accounts` trước sẽ bắt đầu registry.
  - Đo tải thật cho rủi ro pool/lock của `recordDenied()` dưới đồng thời cao — task đầu tiên wire `recordDenied()` vào một đường nóng thật (chưa có consumer để đo).

- **Câu hỏi mở:**
  1. Docker Desktop không chạy trong môi trường hiện tại nên 1 suite e2e và toàn bộ `test:db` chưa xác nhận được. Đề xuất: tiếp tục Phase 2/3 (không cần DB thật để thiết kế), và chạy đủ `test:e2e` + `test:db` trước khi coi Phase 4 hoàn tất — cần Docker Desktop chạy trước lúc đó. Đồng ý cách xử lý này?
  2. BL-019 sẽ được sửa nội dung (thu hẹp, không xóa) ở Phase 5 vì chỉ giải quyết một phần. Đồng ý?
  3. Role board ghi `Dev`, khớp loại việc (backend code) — không có bất thường.

**Quyết định ở G1 (duyệt 2026-10-26):** Người dùng xác nhận đã bật Docker Desktop và yêu cầu tiếp tục. Câu hỏi 1 đã giải quyết (baseline đầy đủ xanh sau khi remap cổng 5432→5433 cho Postgres local, xem bảng baseline trên). Câu hỏi 2 (thu hẹp BL-019 ở Phase 5 thay vì xóa) được chấp thuận ngầm (không có phản đối). Câu hỏi 3 không cần quyết định. Chuyển sang Phase 2.

## 2. Hành vi

`AuditService` không có HTTP endpoint — là thư viện nội bộ. Mọi input đến từ code TypeScript khác trong repo, không từ body HTTP, nên không có DTO/`class-validator`; nhưng **TypeScript một mình không đủ** để chặn PII (excess-property check chỉ áp dụng cho object literal, không áp dụng cho biến/spread/cast) — xem hành vi #4.

1. **Ghi SUCCESS/REJECTED trong transaction nghiệp vụ đang mở.** Điều kiện: gọi `auditService.record(manager, input)` với `manager` là `EntityManager` của một transaction đang mở (từ `TransactionService.run`). Kết quả: một dòng mới trong `audit_log` bằng `INSERT` SQL thuần (không `RETURNING` — xem §3); transaction **không** tự commit/rollback. `metadata` bị bỏ qua (`undefined`) được gửi xuống DB dưới dạng `'{}'::jsonb` (cột `NOT NULL DEFAULT '{}'`, không phải `NULL` — vi phạm sẽ là `23502`; xem TC-56-04c).
2. **Fail-closed: lỗi ghi audit làm rollback cả transaction.** Điều kiện: insert vào `audit_log` thất bại (CHECK `outcome`, FK `actor_user_id`, kiểu `uuid` sai, mất kết nối...) hoặc `metadata` bị runtime guard từ chối (hành vi #4) **trước khi** chạm DB. Kết quả: `record()` reject, không bọc, không catch → `TransactionService.run` rollback toàn bộ transaction, **kể cả write khác trong cùng transaction**. **Quy tắc bắt buộc cho người gọi:** không bao giờ `catch` lỗi từ `record()`/`recordDenied()` bên trong một callback của `TransactionService.run` — Postgres đã abort transaction (`25P02`); `catch` rồi tiếp tục khiến `COMMIT` âm thầm trả về `ROLLBACK` mà `run()` vẫn resolve như thành công. **Hazard này được *chứng minh*, không chỉ nói, ở TC-56-10b** (callback tự catch rồi return, `run()` resolve nhưng không gì được lưu) — domain review vòng 2 #2 chỉ ra round 1 chỉ nói, chưa test đúng case này.
3. **DENIED tồn tại dù lệnh bị từ chối — qua `recordDenied()`, gọi **ngoài** mọi `run()` nghiệp vụ.** `AuditService.recordDenied(input)` (không có `outcome`, bị ép `'DENIED'` nội bộ) tự mở một `TransactionService.run` riêng, `record()` rồi tự `commit`. Quy tắc bắt buộc: gọi `recordDenied()` **trước khi** `BEGIN` transaction nghiệp vụ, hoặc sau khi nó đã kết thúc (commit/rollback) — không bao giờ gọi bên trong callback của một `run()` khác đang mở (giữ 2 connection pool đồng thời; nếu callback đó bị `TransactionService` retry do deadlock, `recordDenied()` chạy lại và ghi trùng dòng DENIED). Nếu `recordDenied()` tự thất bại, lỗi phải lan ra — tầng gọi trả 500, không được vẫn trả 404 "sạch" không có bằng chứng từ chối (TC-56-06d). **Đính chính so với thiết kế trước review:** insert `audit_log` có lấy khóa `FOR KEY SHARE` trên dòng `users` tham chiếu, nhưng khóa này **không** xung đột với `UPDATE users SET sessions_revoked_at = ...` (câu đó dùng `FOR NO KEY UPDATE`, chỉ xung đột với khóa mạnh hơn như `FOR UPDATE`/xóa dòng) — rủi ro lock nêu ở thiết kế trước review là sai, đã bỏ; rủi ro thật còn lại chỉ là áp lực connection pool (xem §3).
4. **`metadata` chỉ nhận `id?`, `reason?`, `count?` — có runtime guard dùng registry đóng, không phải regex đoán.** `record()` validate trước khi insert: `metadata` phải là plain object (không phải array/`null`/chuỗi) nếu có; key ⊆ `{id, reason, count}`; `id` (nếu có) khớp `/^[0-9a-fA-F-]{1,36}$/` (hình dạng uuid/id ngắn, không khoảng trắng, không ký tự đặc biệt); `reason` (nếu có) **phải là một giá trị thuộc `ErrorCode` hoặc `AuditReason`** (enum mới, nhỏ, chỉ cho lý do audit không khớp `ErrorCode` nào — ví dụ `NOT_OWNER`, `NO_PERMISSION`; mở rộng dần khi module khác cần, cùng triết lý "chỉ thêm khi có người cần branch theo nó" như `ErrorCode`); `count` (nếu có) phải `Number.isSafeInteger(x) && x >= 0`. Vi phạm → `record()` reject với `AuditMetadataError` có **message cố định, không echo giá trị bị từ chối** (tránh log lại chính PII đang cố chặn) — reject trước khi gọi DB. **Giới hạn đã biết, không sửa trong task này:** `action`, `role`, `target.type`, `target.id` vẫn là `string` tự do — PII vẫn lọt được qua các field này nếu người gọi tự ý nhồi vào; một registry đóng cho `action`/`role` là việc toàn hệ thống, lớn hơn phạm vi DBS-56 (đưa `BL-NNN` ở Phase 5).
5. **`actor: null` cho hành động hệ thống** (worker, không có người dùng đăng nhập). Kết quả: `actor_user_id` NULL, `role` vẫn ghi tự do (ví dụ `'system'`).
6. **`outcome` ngoài `'SUCCESS' | 'REJECTED' | 'DENIED'`** bị chặn ở compile-time cho code nội bộ bình thường; CHECK DB (`23514`) là lớp phòng thủ thứ hai nếu ai đó ép kiểu (`as never`) — test ở TC-56-10.

## 3. Kiến trúc

- **Vị trí:** `backend/src/modules/audit/`. Role: `api` **và** `worker` (`sharedModules`).
- **Interface cung cấp** (export qua `index.ts`), dạng `@Injectable()`:
  ```ts
  @Injectable()
  class AuditService {
    constructor(private readonly transactionService: TransactionService) {}
    record(manager: EntityManager, input: AuditRecordInput): Promise<void>;
    recordDenied(input: Omit<AuditRecordInput, 'outcome'>): Promise<void>;
  }
  enum AuditReason { NOT_OWNER = 'NOT_OWNER', NO_PERMISSION = 'NO_PERMISSION' } // mở rộng dần
  type AuditOutcome = 'SUCCESS' | 'REJECTED' | 'DENIED';
  type AuditTarget = { type: string; id: string };
  type AuditMetadata = { id?: string; reason?: ErrorCode | AuditReason; count?: number };
  type AuditRecordInput = {
    actor: string | null; role: string; action: string; outcome: AuditOutcome;
    target: AuditTarget; correlationId: string; metadata?: AuditMetadata;
  };
  class AuditMetadataError extends Error {} // message cố định, không echo input
  ```
  **Interface dùng:** `EntityManager.query()` (SQL thuần, **không** `EntityManager.insert()`/entity — không tạo `entities/audit-log.entity.ts`). **Lý do (domain review vòng 1 #1, blocking):** `manager.insert(Entity, …)` sinh `INSERT ... RETURNING` cho cột generated/default; production sẽ cấp `dbs_worker` chỉ quyền `INSERT` trên `audit_log`, và `RETURNING` cần `SELECT` → ghi audit từ worker sẽ lỗi `permission denied` khi role đó được cấp thật. Dùng `INSERT INTO audit_log (...) VALUES ($1..$8)` thuần, không `RETURNING` — khớp ADR-07.
  **Kiểm được dưới role INSERT-only ngay trong task này** (domain review vòng 2 #4 chỉ ra round 1 sai khi nói "không thể"): `test/db/append-only.db-spec.ts` đã có pattern tạo role tạm (`CREATE ROLE ... NOLOGIN`, `GRANT INSERT ON audit_log`, `SET LOCAL ROLE`) trong chính database tạm của test — không cần chờ migration grant production. TC-56-04b dùng đúng pattern này. Test dưới role `dbs_worker` **production thật** (migration grant) vẫn ngoài phạm vi (task roles, §1) — khác với việc chứng minh cơ chế không cần `SELECT`, cái mà TC-56-04b làm được ngay.
  **Người gọi hiện tại:** chưa có (grep `AuditService` trong `backend/src/modules/{ledger,accounts,risk}` → 0 kết quả) — DBS-56 không đổi một symbol đã có người dùng.
- **Dữ liệu:** bảng `audit_log` (đã có từ DBS-26, 10 cột): `id bigint identity`, `occurred_at timestamptz default clock_timestamp()`, `actor_user_id uuid NULL FK users(id) ON DELETE RESTRICT`, `actor_role text`, `action text`, `outcome text CHECK IN (SUCCESS,REJECTED,DENIED)`, `target_type text`, `target_id text`, `correlation_id uuid`, `metadata jsonb NOT NULL DEFAULT '{}'`. `actor` trong `AuditRecordInput` **là `users.id`** (uuid), không phải Cognito `sub`. Index: `audit_log_correlation_idx`, `audit_log_actor_occurred_idx`, `audit_log_action_occurred_idx`. Trigger append-only (DBS-27) chặn UPDATE/DELETE/TRUNCATE.
- **Ranh giới transaction:** `record()` không tự mở/đóng transaction — nằm hoàn toàn trong transaction của `manager` truyền vào. `recordDenied()` là **ngoại lệ có chủ đích**, tự mở transaction riêng qua `TransactionService.run` (giống outbox relay) — quy tắc gọi đúng chỗ nêu ở hành vi #3. **Rủi ro đã biết, ghi lại chứ không tự giải quyết trong task này (handoff §1):** `recordDenied()` giữ một connection trong pool (`DATABASE_POOL_MAX`, mặc định 10) cho tới khi commit; gọi đồng thời nhiều hơn pool size trong khi transaction nghiệp vụ khác đang mở có thể cạn pool — chưa đo tải thật vì chưa có consumer. (Rủi ro khóa `FOR KEY SHARE`/`sessions_revoked_at` nêu ở thiết kế trước review đã được đính chính là **sai** — xem hành vi #3.)
- **Đăng ký module** (danh sách thay đổi cụ thể, domain review vòng 2 #6): `backend/src/modules/audit/audit.module.ts` (`providers: [AuditService]`, `exports: [AuditService]` — không cần import `DatabaseModule`, module đó là `@Global()` nên `TransactionService` tự có sẵn); `backend/src/modules/audit/index.ts` export `AuditModule`, `AuditService`, `AuditOutcome`, `AuditTarget`, `AuditMetadata`, `AuditRecordInput`, `AuditReason`, `AuditMetadataError`; `backend/src/modules/index.ts` — thêm `AuditModule` vào mảng `sharedModules` (bỏ khỏi dòng comment); `backend/src/modules/modules.spec.ts` — thêm assertion `modulesForRole(AppRole.Api)` và `modulesForRole(AppRole.Worker)` đều chứa `AuditModule` (TC-56-13).
- **Sơ đồ** (3 hành vi cốt lõi):

```mermaid
sequenceDiagram
  participant Caller as Module gọi
  participant TS as TransactionService
  participant AS as AuditService
  participant PG as Postgres (audit_log)

  rect rgb(240,240,240)
  Note over Caller,PG: Case 2 — fail-closed
  Caller->>TS: run(manager => { ghi nghiệp vụ; AS.record(manager, SUCCESS) })
  TS->>PG: BEGIN
  TS->>AS: record(manager, input)
  AS->>AS: validate metadata (runtime guard)
  AS->>PG: INSERT audit_log (không RETURNING)
  PG-->>AS: lỗi (CHECK/FK/22P02)
  AS-->>TS: reject (lỗi gốc, không bọc)
  TS->>PG: ROLLBACK (mọi write khác trong transaction này cũng mất)
  TS-->>Caller: throw (lỗi gốc) — Caller KHÔNG được catch rồi tiếp tục
  end

  rect rgb(240,240,240)
  Note over Caller,PG: Case 3 — DENIED qua recordDenied() (transaction riêng, gọi NGOÀI run() nghiệp vụ)
  Caller->>AS: recordDenied(input)
  AS->>TS: run(manager => record(manager, {...input, outcome:'DENIED'}))
  TS->>PG: BEGIN
  TS->>PG: INSERT audit_log (DENIED)
  TS->>PG: COMMIT
  TS-->>AS: resolve
  AS-->>Caller: resolve (đã commit)
  Caller->>Caller: throw NotFoundException (sau khi commit xong)
  end
```

- **Thay đổi cấp hệ thống:** không sửa ADR/`_shared`/event-contract. Viết lại `backend/src/modules/audit/README.md`: chữ ký cũ trong README (`record(manager, {actor, action, target, correlationId})`) thiếu `role`, `outcome`, `metadata`, và chưa có `recordDenied()` — cần đồng bộ với chữ ký thật, cộng quy tắc "không catch lỗi từ record()/recordDenied()" và "gọi recordDenied() ngoài run() nghiệp vụ".

## 4. Test cases tự động

Hạ tầng db-spec (áp dụng cho mọi test "integration" dưới đây, domain review vòng 2 #8): `new DataSource({type:'postgres', url: db.url})` (không cần `entities`/`namingStrategy` vì `record()` dùng SQL thuần) + `new TransactionService(dataSource, {lockTimeoutMs, statementTimeoutMs, idleInTransactionTimeoutMs, maxRetries, ...})` (cấu hình tối thiểu, theo fixture `transaction.service.spec.ts`). Trước mọi test cần "write nghiệp vụ khác" để quan sát rollback, tạo **một bảng scratch thường trực** trong DB tạm (không phải `TEMP TABLE` — xem lý do dưới): `CREATE TABLE fc_scratch(id uuid PRIMARY KEY)`, chạy một lần ở `beforeAll`, mỗi test dùng `id` riêng (uuid mới) để không đụng nhau.

**Vì sao không dùng `CREATE TEMP TABLE` (domain review vòng 2 #1, sửa lỗi thiết kế round 1):** DDL tạo temp table tự nó nằm trong transaction — rollback xoá luôn cả bảng, nên `SELECT` sau rollback báo "relation does not exist" bất kể audit có fail-closed đúng hay không; test như vậy **không chứng minh được gì**. Bảng scratch thường trực, tạo trước mọi transaction test, mới quan sát được đúng "dòng có hay không còn sau rollback/commit".

| ID | Truy vết (DoD / AC / FR / Threat) | Lớp | Given · When · Then |
|---|---|---|---|
| TC-56-01 | DoD #1 | unit | Given input hợp lệ, `metadata` đủ 3 field · When `record(manager, input)` · Then `manager.query(sql, params)` gọi đúng 8 tham số theo thứ tự cột, `metadata` là JSON string; `sql` **không chứa** `RETURNING` |
| TC-56-02 | DoD #2 | unit | Given `manager.query` reject với lỗi E · When `record()` · Then promise reject đúng instance E, không bọc |
| TC-56-03 | DoD #2, FR-AUD-01 | unit (`fakeDataSource` + `TransactionService` + `AuditService` thật) | Given `record()` gọi trong `TransactionService.run(fn)` thật, `manager.query` reject · When `run()` chạy · Then `rollbackTransaction` được gọi, `commitTransaction` không, lỗi gốc (cùng instance) lan ra khỏi `run()` |
| TC-56-04 | DoD #1, FR-AUD-01 | integration (db-spec) | Given Postgres thật đã migrate, một `users.id` thật, `metadata` đầy đủ · When `record()` outcome SUCCESS qua `TransactionService.run` thật, commit · Then đọc lại đúng 8 cột không tự sinh, `id`/`occurred_at` tự sinh (không NULL), `metadata` round-trip đúng JSON |
| TC-56-04b | DoD #1 (domain review vòng 1 #1, vòng 2 #4) | integration (db-spec) | Given trong DB tạm: `CREATE ROLE audit_rw_test NOLOGIN; GRANT INSERT ON audit_log TO audit_rw_test;` (không `SELECT`) · When trong `TransactionService.run`, `SET LOCAL ROLE audit_rw_test` rồi `record()` · Then insert thành công (chứng minh không cần `SELECT`/`RETURNING`) |
| TC-56-04c | DoD #1 (domain review vòng 2 #7) | integration (db-spec) | Given `metadata` bị bỏ qua (`undefined`) · When `record()` · Then cột `metadata` lưu `'{}'`, không lỗi `23502` |
| TC-56-05 | DoD #2, FR-AUD-01, BR-09 | integration (db-spec) | Given trong cùng transaction: `INSERT INTO fc_scratch VALUES ($1)` (bảng thường trực) rồi `record()` với `actor` không tồn tại (vi phạm FK) · When transaction chạy qua `TransactionService.run` thật, reject · Then **sau khi `run()` reject**, mở connection mới: cả dòng `fc_scratch` và dòng audit đều không tồn tại |
| TC-56-05b | DoD #2 (positive control) | integration (db-spec) | Given cùng flow TC-56-05 nhưng `record()` hợp lệ (không lỗi) · When transaction commit · Then cả dòng `fc_scratch` và dòng audit **đều tồn tại** — chứng minh TC-56-05 không "pass vì luôn trống" |
| TC-56-06 | DoD #3, AC-5.8, T11 | integration (db-spec) | Given `recordDenied({...,correlationId:X})` đã resolve (gọi ngoài mọi `run()` khác) · When `SELECT ... WHERE correlation_id = X` · Then đúng 1 dòng `outcome='DENIED'` |
| TC-56-06b | DoD #3 (negative control) | integration (db-spec) | Given gọi `record(manager, {outcome:'DENIED'})` **lồng trong** một `TransactionService.run` rồi cho `fn` đó `throw` ngay sau (không dùng `recordDenied()`) · When `run()` reject · Then dòng DENIED **không tồn tại** — vì sao phải dùng `recordDenied()` |
| TC-56-06c | DoD #3, AC-5.8, T11 (domain review vòng 2 #5) | integration (db-spec) | Given một `run()` nghiệp vụ ghi `fc_scratch` rồi **lỗi vì lý do khác** (không liên quan audit) sau khi `recordDenied()` đã được gọi và resolve **trước đó, ngoài `run()` đó** · When `run()` nghiệp vụ reject · Then dòng DENIED **còn**, dòng `fc_scratch` của transaction nghiệp vụ **mất** |
| TC-56-06d | DoD #3 (domain review vòng 2 #5) | integration (db-spec) | Given `recordDenied({..., correlationId: 'not-a-uuid'})` · When gọi · Then reject (`22P02`), không có gì được commit |
| TC-56-07 | DoD #4 | compile-time (`@ts-expect-error`, pattern `event-types.spec.ts`) | Given literal `AuditMetadata` có field lạ · Then lỗi biên dịch |
| TC-56-07b | DoD #4 (domain review vòng 1 #2) | unit | Given `metadata` dựng qua biến/spread chứa key lạ (`{...base, email: 'a@b.com'}`) · When `record()` · Then reject **trước khi** gọi `manager.query` (assert `query` không được gọi) |
| TC-56-07c | DoD #4 (domain review vòng 2 #3, table-driven) | unit | Given lần lượt: `metadata` là array/`null`/chuỗi; `id` chứa khoảng trắng/dài hơn 36 ký tự; `reason` là câu tự do (`'khách phàn nàn'`) hoặc chuỗi hoa hợp lệ-nhìn-giống-code nhưng **không** thuộc `ErrorCode`/`AuditReason` (ví dụ `'NGUYENVANA'`); `count` âm hoặc không nguyên · When `record()` mỗi case · Then reject mỗi case, lỗi là `AuditMetadataError`, message không chứa giá trị gốc |
| TC-56-07d | DoD #4 (positive, domain review vòng 2 #3) | unit | Given `metadata` lần lượt: bỏ qua, `{}`, `{id: <uuid>}`, `{reason: ErrorCode.ACCOUNT_NOT_ACTIVE}`, `{reason: AuditReason.NOT_OWNER}`, `{count: 0}`, đủ cả ba field hợp lệ · When `record()` · Then không reject, `manager.query` được gọi |
| TC-56-08 | DoD #3 (biên outcome) | compile-time | Given `outcome` ngoài union 3 giá trị · Then lỗi biên dịch |
| TC-56-09 | DoD #1 (biên actor hệ thống) | integration (db-spec) | Given `actor: null, role: 'system'` · When `record()` qua transaction thật · Then `actor_user_id` NULL, `actor_role='system'` |
| TC-56-10 | DoD #2, FR-AUD-01, BR-09 | integration (db-spec) | Given `fc_scratch` ghi trước, rồi `record()` với `outcome` ép kiểu sai (`'X' as AuditOutcome`) · When chạy qua `TransactionService.run` thật · Then Postgres trả `23514` (`audit_log_outcome_check`), cả transaction rollback — `fc_scratch` cũng mất |
| TC-56-10b | DoD #2 (domain review vòng 2 #2 — chứng minh hazard, không phải "đã sửa") | integration (db-spec) | Given callback `run()` ghi `fc_scratch`, gọi `record()` với `actor` sai (FK lỗi), **`catch` lỗi đó và `return` bình thường** (vi phạm quy tắc hành vi #2 một cách cố ý) · When `run()` chạy · Then `run()` **resolve** (không throw) nhưng cả `fc_scratch` và audit đều **không tồn tại** — bằng chứng cho hazard "giả thành công", không phải case được sửa |
| TC-56-11 | DoD #2, FR-AUD-01 | integration (db-spec) | Given `fc_scratch` ghi trước, `correlationId` không phải uuid hợp lệ (`'not-a-uuid'`) · When `record()` · Then Postgres trả `22P02`, transaction rollback (`fc_scratch` cũng mất) |
| TC-56-12 | DoD #1 | unit (Nest `Test.createTestingModule`, import `DatabaseModule` thật — không dùng stub) | Given testing module import `DatabaseModule` + `AuditModule` thật · When `compile()` · Then `AuditService` resolve được, không lỗi DI (chứng minh registration thật, không phải trivial vì stub) |
| TC-56-13 | DoD #1 (domain review vòng 2 #6) | unit (`modules.spec.ts`) | Given `modulesForRole(AppRole.Api)` và `modulesForRole(AppRole.Worker)` · When gọi · Then cả hai đều chứa `AuditModule` |
| DoD #5 | quy trình | — | PR merge, Dev review, CI xanh, bảng Đối chiếu test case — xác nhận ở §8 |

**Không áp dụng** (nêu rõ theo `testing.md`): số tiền trên 2^53, midnight giờ Việt Nam, event trùng/lệch thứ tự, Redis chậm/chết — `AuditService` không gọi Redis/SQS/tiền. Tải đồng thời cho `recordDenied()` (áp lực pool) là rủi ro đã biết nhưng chưa đo (§1/§3, chưa có consumer thật).

## 5. Test thủ công

Không có HTTP endpoint — chạy qua script `backend/test/manual/audit-record.manual.ts`, gọi trực tiếp `AuditService` (dựng tay `DataSource` + `TransactionService`) trên Postgres thật, xác nhận bằng `psql`.

**Điều kiện chạy:** từ **repo root**: `docker compose up -d`; máy này có Postgres native khác chiếm cổng 5432 → remap bằng override ngoài repo, `DATABASE_URL=postgres://banking:banking_local_only@127.0.0.1:5433/banking` (xem §1). Từ `backend/`: `npm run migration:run`. Seed một `users` thật và một bảng scratch thường trực (không phải temp — xem §4):
```
docker compose exec postgres psql -U banking banking -c \
  "INSERT INTO users(cognito_sub) VALUES ('manual-test-dbs56') RETURNING id;"
docker compose exec postgres psql -U banking banking -c \
  "CREATE TABLE IF NOT EXISTS fc_scratch(id uuid PRIMARY KEY);"
```
Chạy script (từ `backend/`): `npx ts-node -r tsconfig-paths/register test/manual/audit-record.manual.ts <users.id vừa seed>`. Theo `manual-testing.md` (đường dẫn tương đối tính từ **repo root**, không phải `backend/`): `cd backend && npx ts-node ... 2>&1 | tee -a ../docs/features/screenshots/DBS-56/manual-test.txt`.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-56-01 | Script: `transactionService.run(m => auditService.record(m, {actor: <users.id>, role: 'operator', action: 'ledger.transfer', outcome: 'SUCCESS', target: {type:'account', id: randomUUID()}, correlationId: randomUUID()}))`, in `correlationId` | Script chạy xong không lỗi; `docker compose exec postgres psql -U banking banking -c "select * from audit_log where correlation_id = '<id>'"` → đúng 1 dòng, `outcome = SUCCESS` |
| M-56-02 | Script, cùng transaction: `INSERT INTO fc_scratch VALUES ($1)` (uuid mới) rồi `record()` thứ hai với `actor` là uuid ngẫu nhiên không có trong `users` | Script in lỗi FK, không bị nuốt; `psql select * from fc_scratch where id = '<id>'` → 0 dòng; `psql` với `correlation_id` của lần ghi audit đó → 0 dòng |
| M-56-03 | Script: `await auditService.recordDenied({actor: <users.id>, role:'customer', action:'access.denied', target:{type:'account', id: randomUUID()}, correlationId: randomUUID()})` (gọi **ngoài** mọi transaction khác) xong, rồi script tự `throw` ngay sau mô phỏng 404, bắt lỗi đó và thoát bình thường | `psql` với `correlation_id` bước này → đúng 1 dòng `outcome = DENIED`, dù script "thất bại" ngay sau |

Ảnh chụp: terminal chạy script + output `psql` cho cả 3 bước, lưu `docs/features/screenshots/DBS-56/`.

## 6. Domain review (AI)

**Vòng 1 — Reviewer:** subagent (model `fable`), 2026-10-26 · **Kết quả:** 11 phát hiện (3 blocking, 4 should-fix, 4 minor) · Verdict: REVISE · [trả lời nguyên văn](screenshots/DBS-56/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | `manager.insert` sinh `RETURNING`, vỡ với role `dbs_worker` chỉ có INSERT | **đã sửa** §3 — `manager.query()` SQL thuần, không `RETURNING`, không entity; TC-56-01 + TC-56-04b (vòng 2) |
| 2 | blocking | PII: compile-time không chặn biến/spread/cast; `action`/`role`/`target.id` không có whitelist nào | **đã sửa một phần** — runtime guard cho `metadata` (siết lại ở vòng 2 thành registry đóng, không phải regex). **Không sửa** `action`/`role`/`target.id` tự do (ngoài phạm vi, lý do ở §2 hành vi #4) |
| 3 | blocking | TC-56-06 không chứng minh cơ chế; không negative control; rủi ro pool/lock của transaction lồng | **đã sửa** — `recordDenied()`, TC-56-06b/06c/06d (vòng 2). Rủi ro lock (`FOR KEY SHARE`) **round 2 chỉ ra là sai** — đã đính chính trong §2 hành vi #3; rủi ro pool vẫn ghi nhận, chưa đo |
| 4 | should-fix | Fail-closed chỉ test 2 dòng audit; caller catch lỗi có thể "giả thành công" | **đã sửa một phần vòng 1 (dùng TEMP TABLE), vòng 2 phát hiện cách đó sai (xem dưới)** |
| 5 | should-fix | Lẫn hàm rời/`@Injectable()`; DI/registration chưa rõ | **đã sửa**, siết thêm ở vòng 2 (TC-56-12 trivial → sửa; TC-56-13 thêm) |
| 6 | should-fix | Hạ tầng test chưa cụ thể | **đã sửa** §4/§5 |
| 7 | should-fix | Thiếu test CHECK/uuid cho fail-closed | **đã sửa** — TC-56-10, 11 |
| 8 | minor | TC-56-04 tính sai số cột | **đã sửa** |
| 9 | minor | Thiếu trace AC/FR/Threat | **đã sửa một phần vòng 1 (sai: nói docs/02 không có mã), sửa đúng ở vòng 2** |
| 10 | minor | Thiếu bàn giao rõ chủ; README sai chữ ký | **đã sửa** — §1 "Ngoài phạm vi" giờ có chủ từng dòng |
| 11 | minor | Câu hỏi mở §1 #1 lỗi thời | **đã sửa** |

**Vòng 2 — Reviewer:** subagent (model `fable`, fresh, không thấy context vòng 1), 2026-10-26 · **Kết quả:** 11 phát hiện mới (0 blocking, 7 should-fix, 4 minor — không còn blocking, nhưng chỉ ra 2 chỗ vòng 1 tự nhận "đã sửa" nhưng sai/chưa đủ) · Verdict: REVISE · [trả lời nguyên văn](screenshots/DBS-56/domain-review-round2.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | `CREATE TEMP TABLE` trong transaction bị rollback theo DDL — test "write khác" (round-1 #4) **không chứng minh được gì**, vì sau rollback bảng biến mất bất kể audit có fail-closed hay không | **đã sửa** — đổi sang bảng `fc_scratch` thường trực tạo ở `beforeAll`, dùng lại cho TC-56-05/05b/06c/10/10b/11; thêm TC-56-05b (positive control) |
| 2 | should-fix | Hazard "catch rồi `run()` giả resolve" (25P02) chỉ nói, chưa có test đúng; §2 dẫn nhầm sang TC-56-10 (test CHECK, không liên quan) | **đã sửa** — TC-56-10b, callback tự catch rồi return, assert `run()` resolve nhưng không gì tồn tại; sửa lại tham chiếu trong §2 hành vi #2 |
| 3 | should-fix | Guard `metadata` vẫn mơ hồ: `id` không có độ dài/charset rõ; `reason` theo regex chấp nhận cả chuỗi hoa không phải mã thật (`NGUYENVANA`); chưa nói rõ array/null/object lạ, kiểu lỗi, có echo giá trị vào message không | **đã sửa** — `reason` đổi sang enum đóng (`ErrorCode \| AuditReason`, không phải regex); `id` có regex rõ độ dài; `AuditMetadataError` nêu rõ không echo input; TC-56-07c/07d table-driven cả accept/reject |
| 4 | should-fix | Round-1 nói test dưới role INSERT-only "không thể" — **sai**, `append-only.db-spec.ts` đã có pattern tạo role tạm trong DB test, không cần chờ migration grant production | **đã sửa** — TC-56-04b dùng đúng pattern đó, sửa lại lý do trong §3 (phân biệt rõ: chứng minh cơ chế không cần SELECT ≠ test dưới role production thật, cái sau vẫn ngoài phạm vi) |
| 5 | should-fix | Thiếu rule "không gọi `recordDenied()` trong `run()` khác"; thiếu test transaction ngoài rollback mà DENIED còn; thiếu test `recordDenied()` tự lỗi; claim khóa `FOR KEY SHARE` xung đột với update `sessions_revoked_at` là **sai kỹ thuật** (khác loại khóa, không xung đột) | **đã sửa** — rule thêm vào hành vi #3; TC-56-06c/06d; đính chính claim khóa sai (bỏ, không còn nêu rủi ro đó) |
| 6 | should-fix | TC-56-12 (DI boot) trivial vì `DatabaseModule` là `@Global()`, không cần import gì cũng resolve được qua stub; chưa nói rõ thay đổi `modules/index.ts`/`modules.spec.ts` | **đã sửa** — TC-56-12 đổi sang import `DatabaseModule` thật; thêm TC-56-13 cho `modules.spec.ts`; §3 có danh sách file đăng ký cụ thể |
| 7 | should-fix | `metadata` bỏ qua (`undefined`) có thể gửi `NULL` xuống cột `NOT NULL` → lỗi `23502`, chưa được nói tới hay test | **đã sửa** — hành vi #1 nêu rõ `undefined → '{}'`, TC-56-04c |
| 8 | minor | Hạ tầng DataSource/TransactionService cho db-spec vẫn chỉ nói "dùng lại", chưa cụ thể | **đã sửa** — câu cụ thể ở đầu §4 |
| 9 | minor | §6 (vòng 1) nói sai: docs/02 **có** FR-AUD-01..04, AC-5.8, AC-11.3, NFR-AUD-01/02; TC-56-08 trace nhầm DoD #4 (phải là #3) | **đã sửa** — cột truy vết §4 giờ có FR/AC/Threat thật; sửa trace TC-56-08 |
| 10 | minor | Danh sách bàn giao vẫn nói "chốt ở §8 Phase 5"; thiếu chủ cụ thể; thiếu khoảng trống đọc nhạy cảm (FR-AUD-02) | **đã sửa** — §1 "Ngoài phạm vi" giờ có chủ từng dòng, thêm dòng FR-AUD-02 (đọc nhạy cảm) |
| 11 | minor | `tee -a docs/features/screenshots/...` chạy từ `backend/` sẽ ghi vào `backend/docs/...` (không tồn tại) | **đã sửa** — §5 sửa thành đường dẫn `../docs/...` tính từ `backend/`, nêu rõ "repo root" |

Không còn phát hiện `blocking` sau vòng 2. Các điểm còn lại thuộc loại "đã sửa nhưng là quyết định phạm vi có thể tranh luận" (không phải lỗi) được đưa thành câu hỏi ở G2 bên dưới.

**Quyết định ở G2 (duyệt 2026-10-26):** Người dùng trả lời "duyệt" không kèm góp ý. Cả 3 câu hỏi được chấp thuận theo đề xuất của agent: (1) không chạy vòng review thứ 3 — chuyển sang Phase 3; (2) giữ `AuditMetadata.reason: ErrorCode | AuditReason` (registry đóng, mở rộng dần); (3) `action`/`role`/`target.id` tiếp tục để tự do, xác nhận lại là ngoài phạm vi DBS-56 (đã ghi ở §1 "Ngoài phạm vi"). Chuyển sang Phase 3.

## 7. Kế hoạch triển khai

**Quét giới hạn/BACKLOG (bắt buộc trước khi lập kế hoạch):** đã quét `docs/BACKLOG.md` ở G1 — chỉ BL-019 (đúng module, thu hẹp ở Phase 5, không xóa) và BL-020 (không liên quan) chạm tới `audit`; không có dòng BACKLOG khác về `AuditService`/`record`. Giới hạn nêu trong `audit/README.md` ("service/API chưa triển khai", "production roles... còn là bước bàn giao") đều đã có dòng kế hoạch hoặc dòng "ngoài phạm vi" ở §1/§3 dưới đây — không có giới hạn nào bị bỏ sót.

| Bước | File | Test viết trước | Kết quả đỏ (1 dòng, điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `backend/src/modules/audit/audit.types.ts` | `audit.types.spec.ts` (TC-56-07, 08: `@ts-expect-error` cho field lạ và `outcome` sai) | _(điền khi chạy)_ | `npm test -- audit.types` | `feat(audit): add AuditRecordInput/AuditOutcome/AuditMetadata types` |
| 2 | `backend/src/modules/audit/audit-metadata.guard.ts` (`assertValidMetadata`, `AuditMetadataError`, `AuditReason`) | `audit-metadata.guard.spec.ts` (TC-56-07b, 07c, 07d — bảng accept/reject) | _(điền khi chạy)_ | `npm test -- audit-metadata.guard` | `feat(audit): add runtime metadata guard (closed reason registry)` |
| 3 | `backend/src/modules/audit/audit.service.ts` (`record`, `recordDenied`) | `audit.service.spec.ts` (TC-56-01, 02, 03) | _(điền khi chạy)_ | `npm test -- audit.service` | `feat(audit): add AuditService.record with fail-closed insert` |
| 4 | `backend/src/modules/audit/audit.module.ts`, `index.ts` | mở rộng `audit.service.spec.ts` bằng TC-56-12 (`Test.createTestingModule` import `DatabaseModule` + `AuditModule` thật) | _(điền khi chạy)_ | `npm test -- audit.service` | `feat(audit): add AuditModule and public index` |
| 5 | `backend/src/modules/index.ts` (thêm `AuditModule` vào `sharedModules`) | mở rộng `backend/src/modules/modules.spec.ts` bằng TC-56-13 | _(điền khi chạy)_ | `npm test -- modules.spec` | `feat(audit): register AuditModule as shared module` |
| 6 | `backend/test/db/audit.service.db-spec.ts` (hạ tầng: `fc_scratch` table ở `beforeAll`, `DataSource` + `TransactionService` dựng tay) | chính file này — TC-56-04, 04b, 04c, 05, 05b, 06, 06b, 06c, 06d, 09, 10, 10b, 11 | _(điền khi chạy — kỳ vọng TC-56-04c và TC-56-04b đỏ trước nếu bước 3 có sót, vì đây là nơi bug `metadata→NULL` và giả định RETURNING sẽ lộ ra trên Postgres thật)_ | `npm run test:db -- audit.service` | `test(audit): add integration coverage for fail-closed, DENIED and role grants` |
| 7 | `backend/src/modules/audit/README.md` (viết lại: chữ ký thật, `recordDenied`, quy tắc không catch / gọi ngoài `run()`) | không áp dụng (docs) | — | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(audit): sync README with implemented AuditService` |
| 8 | `backend/test/manual/audit-record.manual.ts` | không áp dụng (script test thủ công) | — | chạy tay theo §5 (Phase 4c) | `test(audit): add manual audit-record script` |

**Rủi ro và cách lùi:**
- Thứ tự tham số SQL thuần (`manager.query`) sai cột → đã có TC-56-01 khẳng định đúng thứ tự trước khi chạm DB thật; nếu lệch, đỏ ngay ở unit, không tới integration.
- `AuditMetadata.reason` siết thành enum đóng có thể chặn một lý do hợp lệ chưa có trong `ErrorCode`/`AuditReason` khi module khác bắt đầu dùng — mở rộng enum là thay đổi tương thích xuôi (thêm member), không phải breaking change; không cần lùi, chỉ cần PR nhỏ thêm member khi cần.
- Chưa có consumer thật nào phụ thuộc `AuditService` trong repo (xác nhận ở §3) — nếu sau merge phát hiện vấn đề, lùi an toàn bằng cách revert nguyên PR (xóa `audit.module.ts`/`index.ts`, bỏ `AuditModule` khỏi `sharedModules`), không ảnh hưởng module nào khác.
- `recordDenied()` dùng connection pool riêng khi gọi — rủi ro cạn pool dưới tải đã ghi nhận ở §3/§1, không giải quyết trong task này (chưa có đường gọi thật để đo); không cần cách lùi vì chưa triển khai tải thật.

**Quyết định ở G3 (duyệt 2026-10-26):** Người dùng trả lời "duyệt" (gõ "dduyet"), không góp ý, không câu hỏi nào cần quyết định. Chuyển sang Phase 4 (Implement and test) — bắt đầu từ bước 1 của §7.

## 8. Kết quả

- **Lệnh kiểm tra** (chạy lúc bàn giao, branch `feat/DBS-56-audit-service-record`):
  ```
  npm run lint:check  → sạch, 0 lỗi
  npm run typecheck   → sạch, 0 lỗi
  npm test            → 34 suites / 522 tests pass (521 trước + 1 lần flake không liên quan, tự qua khi chạy lại — xem dưới)
  npm run test:e2e    → 8 suites / 57 tests pass
  npm run test:db     → 9 suites / 167 tests pass
  ```
  Một lần chạy `npm test` fail ở `jwks-verifier.service.spec.ts` (module `identity`, không đụng tới trong PR này) vì một bộ đếm thời gian sát ngưỡng dưới tải máy; chạy riêng file đó và chạy lại cả bộ đều xanh ngay sau — flake môi trường có sẵn trên `origin/main`, không phải regression của DBS-56.

- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-56-01 | `audit.service.spec.ts` › TC-56-01 inserts the exact columns, in order, with no RETURNING | đạt |
| TC-56-02 | `audit.service.spec.ts` › TC-56-02 rejects with the exact error manager.query threw, unwrapped | đạt |
| TC-56-03 | `audit.service.spec.ts` › TC-56-03 a failing record() rolls back the whole transaction, uncaught | đạt |
| TC-56-04 | `audit.service.db-spec.ts` › TC-56-04 SUCCESS round-trips all 8 columns | đạt |
| TC-56-04b | `audit.service.db-spec.ts` › TC-56-04b inserts under a role granted INSERT only | đạt |
| TC-56-04c | `audit.service.db-spec.ts` › TC-56-04c metadata omitted stores {} rather than NULL | đạt |
| TC-56-05 | `audit.service.db-spec.ts` › TC-56-05 a failing record() rolls back a real other-table write too | đạt |
| TC-56-05b | `audit.service.db-spec.ts` › TC-56-05b positive control | đạt |
| TC-56-06 | `audit.service.db-spec.ts` › TC-56-06 recordDenied() commits a DENIED row standalone | đạt |
| TC-56-06b | `audit.service.db-spec.ts` › TC-56-06b negative control | đạt |
| TC-56-06c | `audit.service.db-spec.ts` › TC-56-06c DENIED survives an unrelated outer business rollback | đạt |
| TC-56-06d | `audit.service.db-spec.ts` › TC-56-06d recordDenied() itself rejects on an invalid correlationId | đạt |
| TC-56-07 | `audit.types.spec.ts` › TC-56-07/08 the compiler enforces AuditMetadata and AuditOutcome | đạt |
| TC-56-07b | `audit.service.spec.ts` › TC-56-07b rejects invalid metadata before ever calling manager.query (+ `audit-metadata.guard.spec.ts`) | đạt |
| TC-56-07c | `audit-metadata.guard.spec.ts` › TC-56-07b/07c rejects (table-driven) | đạt |
| TC-56-07d | `audit-metadata.guard.spec.ts` › TC-56-07d accepts (table-driven) | đạt |
| TC-56-08 | `audit.types.spec.ts` › cùng test TC-56-07 (compile-time, outcome) | đạt |
| TC-56-09 | `audit.service.db-spec.ts` › TC-56-09 actor null, role free text, for a system action | đạt |
| TC-56-10 | `audit.service.db-spec.ts` › TC-56-10 an outcome CHECK violation fails closed | đạt |
| TC-56-10b | `audit.service.db-spec.ts` › TC-56-10b hazard: catching the record() rejection | đạt |
| TC-56-11 | `audit.service.db-spec.ts` › TC-56-11 an invalid correlationId fails closed | đạt |
| TC-56-12 | `audit.module.spec.ts` › TC-56-12 resolves AuditService through real Nest DI | đạt |
| TC-56-13 | `modules.spec.ts` › TC-56-13 audit is a library both api and worker load | đạt |
| DoD #5 | quy trình | chưa làm (chờ mở PR, Dev review, CI — sau G4) |

- **Test thủ công:** chạy thật trên `docker compose` (Postgres remap cổng 5433, xem §1), migration đã `run`, một `users` thật seed qua `psql`, bảng `fc_scratch` tạo qua `psql`. Script: `backend/test/manual/audit-record.manual.ts`. Output thô ở [manual-test.txt](screenshots/DBS-56/manual-test.txt) (dòng đầu là SHA `d4aeb40` — commit cuối đổi code).

  | Bước | Lệnh | Phản hồi (rút gọn) | Kết quả |
  |---|---|---|---|
  | M-56-01 | script ghi SUCCESS qua `transactionService.run` | `psql`: 1 dòng `correlation_id=ffe9cf1f…`, `outcome=SUCCESS` | đạt |
  | M-56-02 | script ghi `fc_scratch` + `record()` với `actor` không tồn tại, cùng transaction | script in lỗi FK ngay (không bị nuốt); `psql`: 0 dòng `fc_scratch`, 0 dòng `audit_log` cho correlation đó | đạt |
  | M-56-03 | script `recordDenied()` rồi tự `throw` mô phỏng 404 | script bắt lỗi, thoát bình thường; `psql`: 1 dòng `correlation_id=80e69f0e…`, `outcome=DENIED` | đạt |

  Điều kiện chạy: `docker compose up -d`, `npm run migration:run`, không cần token (không có HTTP).

- **Phạm vi so với §7:** `git diff --stat origin/main...HEAD` → đúng 17 file, khớp hoàn toàn danh sách ở §7 (8 bước) cộng feature doc và 2 file domain review (tài liệu của chính task này, không phải "file lạ"). Không có file ngoài kế hoạch.

- **Ảnh chụp:** **không có PNG** — DBS-56 là thư viện nội bộ (`AuditService`), không có UI/Swagger để chụp; bằng chứng duy nhất khả thi là output terminal/`psql` thô, đã lưu đủ ở `manual-test.txt`. Đề nghị người duyệt G4 chấp nhận việc này thay cho ảnh chụp (không áp dụng theo đúng tinh thần `manual-testing.md`: "Docs-only tasks have no manual test... take none" — ở đây ngược lại là có manual test nhưng không có gì để chụp màn hình vì không có giao diện).

- **Lệch so với kế hoạch:** một dòng ngoài §7 — thêm `TC-56-07b` ở cấp `audit.service.spec.ts` (ngoài bản đã có trong `audit-metadata.guard.spec.ts`) để khẳng định trực tiếp "`record()` không gọi `manager.query` khi metadata sai", không chỉ qua guard độc lập. Không đổi file nào ngoài `audit.service.spec.ts` đã có trong §7 bước 3 — không phải lệch phạm vi, chỉ sâu hơn kế hoạch.

- **Bàn giao cho vai khác:** đã cập nhật **BL-019** trong `docs/BACKLOG.md` (thu hẹp, không xóa) — còn lại: API tra cứu UC-8/FR-AUD-03 (task UC-8), production role grants + kiểm AC-8.1/8.2 với role thật (Ops), registry đóng cho `action`/`role`/`target.id` (nền tảng backend), đo tải pool cho `recordDenied()` (task đầu tiên wire vào đường nóng thật), audit cho đọc dữ liệu nhạy cảm FR-AUD-02 (risk #4 khi họ wire UC-10); thêm **BL-137** theo dõi DoD #5 (PR merge, Dev review, CI) — đổi số từ BL-031 lúc bàn giao gốc (2026-10-26) vì rebase lên `main` hiện tại cho thấy BL-031 đã là một dòng khác (DBS-33), xem DBS-56 vòng sửa review (2026-11-03).

## 9. Tài liệu đã cập nhật

- `backend/src/modules/audit/README.md` — đồng bộ chữ ký thật, `recordDenied`, quy tắc không catch / gọi ngoài `run()`.
- `docs/BACKLOG.md` — **BL-019** sửa nội dung (thu hẹp theo phần DBS-56 đã giải quyết), không xóa dòng; thêm **BL-137** cho DoD #5 (đổi số từ BL-031 sau rebase, xem §8).
- `docs/features/README.md` — thêm dòng DBS-56.
- `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` — sạch, 106 file, 0 link hỏng.

**Quyết định ở G4 (duyệt 2026-10-26):** Người dùng trả lời "duyệt", chấp nhận không có ảnh chụp PNG (thư viện nội bộ, không có UI) — `manual-test.txt` là bằng chứng thay thế. Chuyển Status thành Implemented, push branch, mở PR.

## Vòng 2 · Sửa sau code-review nhánh `feat/DBS-56-audit-service-record`

> **Status vòng 2:** Draft (đã implement và test, chờ G4) · **Nguồn:** review code (`/code-review`, model Claude, mức medium) ngày 2026-11-03 trên nhánh gốc, chưa merge · **Nhánh:** `fix/DBS-56-audit-service-record-review-fixes` (rebase từ `origin/main`, PR chưa mở) · **Cập nhật:** 2026-11-04

### R1. Bối cảnh

**Phạm vi:** 3 phát hiện của review (xem báo cáo gửi người dùng trong chat 2026-11-03), đã xác minh thật bằng script tái hiện và đọc code trước khi thiết kế fix:

| ID | Mức (từ review) | Vị trí | Vấn đề | Đã xác minh |
|---|---|---|---|---|
| F-1 | nghiêm trọng | `backend/src/modules/audit/audit-metadata.guard.ts:22` | `assertValidMetadata` chỉ kiểm `Object.keys(metadata)` (key enumerable); `audit.service.ts` serialize bằng `JSON.stringify(metadata)`, gọi cả `toJSON()` non-enumerable → hai cơ chế nhìn metadata khác nhau | Tái hiện bằng script Node thật: `Object.defineProperty(m, 'toJSON', {value: () => ({email: 'victim@example.com'}), enumerable: false})` → `Object.keys(m)` = `[]` (guard pass), `JSON.stringify(m)` = `{"email":"victim@example.com"}` (PII lọt vào `audit_log.metadata`) |
| F-2 | should-fix | `backend/src/modules/audit/audit.service.ts:42` | `recordDenied()` không được gọi lồng trong `TransactionService.run` khác (giữ 2 connection, retry deadlock ghi trùng DENIED) — chỉ là JSDoc, không có kiểm runtime, khác với `AccountsService.requireOutermostTransaction` (DBS-55) | Đọc `accounts.service.ts:150` xác nhận pattern đã có nhưng dựa vào `manager.queryRunner.transactionDepth` — cần có `manager` sẵn. `recordDenied()` không nhận `manager` (đúng chủ đích, tự mở transaction riêng) nên cần cơ chế khác: theo dõi "đang có transaction mở" bằng `AsyncLocalStorage`, set trong `withTransaction` (`backend/src/database/transaction.helper.ts`) — **file nền tảng dùng chung, không riêng module `audit`** |
| F-3 | should-fix | `backend/src/modules/index.ts`, `docs/BACKLOG.md`, `docs/features/README.md` | Nhánh gốc dựa trên `main` cũ (điểm rẽ `82c8e23`), `main` đã tiến 19 commit (DBS-50/51/52/53/55/57/69…) → conflict khi merge | Tái hiện bằng `git merge-tree --write-tree origin/main <nhánh gốc>`: đúng 3 file conflict. **Đã giải quyết bằng rebase** (xem dưới), không còn là việc cần làm ở §7 |

**Đã làm trước khi vào G1:** tạo nhánh làm việc `fix/DBS-56-audit-service-record-review-fixes` từ `origin/feat/DBS-56-audit-service-record` (SHA `4e43261`); chạy baseline đủ 4 lệnh + `test:db` (xanh, remap Postgres cổng 5433 — cùng tình huống đã lường ở vòng 1 §1); **rebase lên `origin/main`** mới nhất (người dùng đồng ý ở G1 làm ngay, tránh giải conflict hai lần) — giải 3 conflict đúng như F-3 dự đoán:
- `backend/src/modules/index.ts`: gộp `AuditModule` và `OutboxModule` vào `sharedModules` (trước đó mỗi nhánh chỉ có một), giữ `AccountsModule` ở `apiModules`, sửa lại comment.
- `docs/BACKLOG.md`: giữ bản thu hẹp của **BL-019** (narrowed, từ commit `dc2d9f3` của nhánh gốc) over bản cũ của `main`; phát hiện ID `BL-031` bị trùng (nhánh gốc đã chiếm cho DoD #5 của DBS-56, nhưng trên `main` hiện tại `BL-031` đã là dòng khác của DBS-33) → đổi dòng DoD #5 DBS-56 thành **BL-137** (số tiếp theo sau `BL-136` hiện có trên `main`).
- `docs/features/README.md`: thêm dòng DBS-56 vào danh sách đầy đủ của `main` (giữ tất cả dòng DBS-55/57/69/34/54/38/66/36/67/75/68/53/52/51 đã có), không còn dùng danh sách cũ, ngắn của nhánh gốc.

Baseline sau rebase (`npm install` lại để nhận `redis`/`@aws-sdk/client-sqs` mới từ `main`, revert `package-lock.json` về đúng bản đã rebase — không phải bản tự `npm install` sinh ra, tránh lockfile drift do thứ tự resolve `peer`):
| Lệnh | Kết quả |
|---|---|
| `npm run lint:check` | sạch, 0 lỗi |
| `npm run typecheck` | sạch, 0 lỗi |
| `npm test` | 788/788 pass, loại trừ `jwks-verifier.service.spec.ts` |
| `npm run test:e2e` | 13/13 suites, 135/135 tests pass |
| `npm run test:db` | 16/16 suites, 335/335 tests pass, loại trừ `outbox-writer-bootstrap.db-spec.ts` |

Hai file loại trừ **không liên quan `audit` hay nhánh này** — đã xác minh bằng cách tái hiện độc lập trên một worktree `origin/main` sạch (`git worktree add`, không có thay đổi gì của DBS-56):
- `jwks-verifier.service.spec.ts` (`refetches on key rotation…`, `honours the refetch cooldown…`): timer thật `setTimeout`/`COOLDOWN_MS` nhạy với tải máy — đúng BL-112 đã ghi trên `docs/BACKLOG.md`. Fail trên cả `origin/main` sạch (5/5 lần chạy lại trong phiên này — tỷ lệ cao hơn ghi chú gốc của BL-112, nhưng cùng nguyên nhân: máy đang bận).
- `outbox-writer-bootstrap.db-spec.ts` (TC-57-13, cả 3 role `api`/`worker`/`both`): `execFile` spawn child process với `env` đã lọc theo whitelist (không gồm `NODE_OPTIONS`), nên child không có cờ `--experimental-global-webcrypto` mà Node 18 cần để có `globalThis.crypto` (package.json yêu cầu `engines.node: >=24`). Tái hiện cùng `ReferenceError` trên `origin/main` sạch khi chạy trực tiếp `node -r ts-node/register … outbox-writer.manual.ts` không có `NODE_OPTIONS`. Không phải lỗi của `audit`; CI (Node ≥24) không gặp vấn đề này.

**Người gọi các symbol bị đổi:** grep `assertValidMetadata`, `recordDenied`, `withTransaction` trong `backend/src/` (ngoài test) → không có caller production nào khác ngoài `audit.service.ts` và `transaction.service.ts` tự nó. An toàn để sửa nội bộ mà không phá giao diện của symbol khác.

**Ngoài phạm vi:** registry đóng cho `action`/`role`/`target.id` (BL-019 đã ghi, không đổi); API tra cứu UC-8; production role grants; đo tải pool cho `recordDenied()` dưới tải thật. Không đổi chữ ký public `record()`/`recordDenied()` — chỉ sửa hành vi nội bộ.

**Câu hỏi mở:** đã hỏi ở G1 (chat), đã được duyệt:
1. Finding F-2 cần sửa file nền tảng `backend/src/database/transaction.helper.ts` (không riêng `audit`) — làm trong PR này, có test riêng cho `transaction.helper.spec.ts`. **Đã duyệt.**
2. Rebase lên `origin/main` ngay ở Phase 1 (không để tới Phase 4). **Đã duyệt, đã làm (xem trên).**

**Quyết định ở G1 (vòng 2, duyệt qua chat 2026-11-03):** Người dùng trả lời "duyệt" (gõ "duyêht"), không góp ý thêm. Cả 2 câu hỏi được chấp thuận theo đề xuất của agent. Chuyển sang Phase 2.

### R2. Hành vi thay đổi

**F-1 — guard metadata kiểm cùng thứ sẽ được ghi, không phải `Object.keys`.** Thay `assertValidMetadata` bằng cách validate trên `JSON.parse(JSON.stringify(metadata === undefined ? {} : metadata))` — chính là giá trị sẽ đi vào DB — thay vì validate trên object gốc rồi serialize riêng. **Default chỉ áp dụng khi `metadata === undefined`, dùng so sánh chặt, không dùng `??`** (domain review vòng 2 round 1 #1, blocking — bản thiết kế đầu thiếu bước default này nên `JSON.stringify(undefined)` trả **giá trị JS `undefined`**, không phải chuỗi, khiến `JSON.parse(undefined)` throw `SyntaxError` ngay, tức mọi lệnh gọi `record()` không có `metadata` — trường hợp phổ biến nhất — sẽ crash; domain review vòng 2 round 2 #5, should-fix — bản sửa #1 ban đầu dùng `metadata ?? {}`, nhưng `??` coi `null` giống `undefined`, nên một `metadata` tường minh là `null` sẽ bị âm thầm biến thành `{}` và **được accept**, thay vì reject như hành vi hiện tại và như TC-56-07c yêu cầu — dùng `=== undefined` tường minh mới phân biệt đúng hai case). Hai bước (validate, serialize) đổi thành một chuỗi: default khi `undefined` → serialize → validate trên kết quả serialize → ghi SQL bằng chính chuỗi đã serialize đó (không serialize lại hai lần, tránh lệch nếu `toJSON()` không idempotent). Hệ quả hành vi mới:
- `metadata` bị bỏ qua (`undefined`) → default `{}` → `JSON.stringify({})` = `'{}'`→ `JSON.parse('{}')` = `{}` → guard pass (không có key nào) — **giữ đúng hành vi cũ** (TC-56-04c, TC-56-16), không crash.
- `metadata` tường minh là `null` → **không** default (vì `null !== undefined`) → `JSON.stringify(null)` = chuỗi `'null'` → `JSON.parse('null')` = `null` → guard thấy `typeof !== 'object' || metadata === null` → `AuditMetadataError` — **giữ đúng hành vi cũ** (TC-56-07c), không bị accept nhầm thành `{}`.
- `{ id: 'a', toJSON: () => ({ email: 'x' }) }` (hay bất kỳ object có `toJSON`) → bị thấy đúng là `{ email: 'x' }` sau `JSON.parse(JSON.stringify(...))`, `email` không thuộc `{id, reason, count}` → `AuditMetadataError`, đúng như một object `{ email: 'x' }` thường.
- Một `Date` làm `metadata` (hiếm nhưng hợp `typeof === 'object'`) → `JSON.stringify` cho ra một **chuỗi** (`"2026-11-03T..."`), không phải object → `JSON.parse` lại cho string đó → guard thấy `typeof !== 'object'` → reject, đúng (một `Date` không có field nào trong `{id, reason, count}` nên không hợp lệ).
- Nếu `JSON.stringify` tự nó throw (ví dụ `metadata` chứa `BigInt`, hoặc một `getter` throw) — lỗi đó lan ra từ `record()` **trước khi chạm DB**, không bọc — vẫn là fail-closed (giống hành vi #2 đã có, chỉ sớm hơn một bước).
- Giá trị đã `JSON.parse(JSON.stringify(x))` không còn giữ `undefined` cho field bị bỏ qua (JSON không có `undefined`) — không đổi hành vi hiện có vì guard đã coi field thiếu và field `undefined` như nhau (`metadata.id !== undefined`).

Không đổi `AuditMetadataError`, không đổi `ALLOWED_KEYS`/`ID_PATTERN`/`VALID_REASONS`, không đổi chữ ký `assertValidMetadata`. Message lỗi vẫn cố định, không echo giá trị gốc (kể cả giá trị đã qua `JSON.stringify`).

**F-2 — `recordDenied()` từ chối chạy khi đang có `TransactionService.run` mở trên cùng async context.** Thêm một theo dõi runtime bằng `AsyncLocalStorage<boolean>` trong `withTransaction()` (`transaction.helper.ts`): khi vào thân `try` (sau `startTransaction`, trước khi gọi `fn`), chạy `fn` bên trong `activeTransactionContext.run(true, () => fn(manager))`. `recordDenied()` đọc `activeTransactionContext.getStore()`; nếu `=== true`, reject ngay với một lỗi mới `NestedTransactionError` (message cố định, không echo input) **trước khi** gọi `this.transactionService.run(...)` — không mở transaction mới, không chạm DB.
- Gọi đúng (ngoài mọi `run()`, hoặc sau khi `run()` đã resolve/reject): `getStore()` là `undefined` (ngoài context) → `recordDenied()` chạy như cũ.
- Gọi lồng trong `run()` khác (dù trực tiếp hay qua một hàm async khác gọi từ trong callback — `AsyncLocalStorage` theo dõi theo chuỗi async, không theo lexical scope): `getStore()` là `true` → reject `NestedTransactionError` ngay, không mở transaction thứ hai, không có nguy cơ ghi trùng khi retry deadlock.
- Một `recordDenied()` gọi từ một `.then()`/callback **đã thoát khỏi** `await fn(manager)` của `withTransaction` (ví dụ do caller `void` một promise rồi tiếp tục) — ngoài phạm vi: `AsyncLocalStorage` chỉ theo dõi chuỗi async đồng bộ với `fn`; một fire-and-forget đã tự rời khỏi mọi ràng buộc transaction, không phải lỗi mới do fix này gây ra.
- **Giới hạn đã biết, ghi lại cho người wire sau (domain review vòng 2 #2):** guard ALS chỉ bắt được lồng **đồng bộ theo chuỗi async** (gọi trực tiếp, hoặc qua một hàm `async` khác được `await` — TC-56-21). Một caller tương lai kiểu `OutboxWriter`/consumer (nhắc ở `module-notes.md` "Async, events và audit") mà gọi `recordDenied()` từ trong một listener `EventEmitter`/`setImmediate` được đăng ký bên trong `run()` nhưng kích hoạt **sau, từ bên ngoài** chuỗi async đó — guard sẽ không thấy (`getStore()` trả `undefined` dù transaction gốc vẫn đang mở) tùy theo cách callback đó được nối dây. Guard này không phải lưới an toàn toàn diện cho mọi cách gọi bất đồng bộ — chỉ chặn đúng ca JSDoc cũ mô tả (gọi trực tiếp/awaited trong `run()` khác).

Không đổi hành vi hiện có của `withTransaction`/`TransactionService.run` cho mọi caller khác (`AccountsService`, `OutboxWriter` tương lai...) — `AsyncLocalStorage.run()` chỉ bọc thêm quanh `fn`, không đổi giá trị trả về, không đổi exception path, không đổi retry logic.

### R3. Kiến trúc thay đổi

- **F-1**, trong `backend/src/modules/audit/`: `audit-metadata.guard.ts` đổi chữ ký nội bộ (không đổi export): thêm một hàm `serializeMetadata(metadata: AuditMetadata | undefined): string` làm bước trung gian — `JSON.stringify(metadata === undefined ? {} : metadata)` (default chỉ khi `undefined`, so sánh chặt — domain review vòng 2 round 1 #1 và round 2 #5: `??` sẽ default luôn cả `null` thành `{}`, phá hành vi reject `null` của TC-56-07c), rồi validate trên `JSON.parse(...)` kết quả đó. `audit.service.ts` gọi `serializeMetadata` một lần, dùng kết quả (chuỗi) cho cả validate và SQL param thứ 8 (hiện đang gọi `JSON.stringify(input.metadata ?? {})` riêng ở đó — sẽ xóa, dùng lại chuỗi từ `serializeMetadata`; lưu ý SQL param vẫn nhận `'{}'` khi `undefined` giống hệt hôm nay, chỉ khác là `null` giờ bị chặn ở bước validate trước khi tới SQL thay vì lọt qua `?? {}` ở service). Không export thêm gì mới ra `index.ts`.
- **F-2**, hai file:
  - `backend/src/database/transaction.helper.ts` (nền tảng, không riêng `audit`): thêm `export const activeTransactionContext = new AsyncLocalStorage<true>()` (module-level, singleton — giống cách `pg-error.util.ts` xuất hàm thuần không có state); sửa `withTransaction` để chạy `fn` bên trong `activeTransactionContext.run(true, () => fn(queryRunner.manager))`. Không export gì khác, không đổi `TransactionOptions`.
  - `backend/src/modules/audit/audit.service.ts`: `recordDenied()` import `activeTransactionContext` từ `@database/transaction.helper`, kiểm `activeTransactionContext.getStore()` trước khi gọi `this.transactionService.run(...)`.
  - `backend/src/modules/audit/audit.types.ts`: thêm `export class NestedTransactionError extends Error` (cùng pattern `AuditMetadataError` — message cố định, không echo input).
- **Không có thay đổi dữ liệu, không có migration mới, không đổi `_shared`/ADR/event-contract.** Transaction boundary không đổi: `record()` vẫn chạy trong `manager` của caller; `recordDenied()` vẫn tự mở transaction riêng — chỉ thêm một bước kiểm trước khi mở.
- **Người gọi `withTransaction`/`TransactionService.run` khác** (`AccountsService`, test helpers): không cần đổi gì, `AsyncLocalStorage.run()` transparent với giá trị trả về và exception.

### R4. Test cases tự động (vòng 2)

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-56-14 | F-1 | unit | Given `metadata` có `toJSON()` non-enumerable trả `{ email: 'x' }` (`Object.defineProperty(m, 'toJSON', {value: () => ({email: 'x'}), enumerable: false})`) · When `record(manager, {...INPUT, metadata: m})` · Then reject `AuditMetadataError`, `manager.query` không được gọi |
| TC-56-15 | F-1 | unit | Given `metadata` là `new Date()` · When `record()` · Then reject `AuditMetadataError` (chuỗi ISO sau `JSON.stringify` không phải object hợp lệ) |
| TC-56-16 | F-1 (positive, không phá hành vi cũ) | unit | Given lần lượt mọi case accept hiện có của TC-56-07d (omitted, `{}`, `{id}`, `{reason: ErrorCode...}`, `{reason: AuditReason...}`, `{count: 0}`, đủ ba field) · When `record()` · Then không reject, SQL param thứ 8 là `JSON.stringify(metadata)` giống hệt hành vi cũ (không đổi output khi input không có `toJSON`) |
| TC-56-16b | F-1 (negative, domain review vòng 2 round 2 #5) | unit | Given `metadata` tường minh là `null` (ví dụ ép kiểu `null as unknown as AuditMetadata`, không phải bỏ qua param) · When `record()` · Then reject `AuditMetadataError`, `manager.query` không được gọi — phân biệt rõ với `undefined` (TC-56-16): `??` sẽ default cả hai case này thành `{}` và accept nhầm `null`, `=== undefined` thì chỉ default đúng case bị bỏ qua |
| TC-56-17 | F-1 | unit | Given `metadata` mà `JSON.stringify` tự throw (ví dụ chứa `BigInt`, hoặc `get count() { throw new Error('boom') }`) · When `record()` · Then reject (lỗi gốc, không bọc), `manager.query` không được gọi |
| TC-56-18 | F-2 | unit (`fakeDataSource` + `TransactionService` thật) | Given gọi `recordDenied(input)` **trong** callback của `transactionService.run(async manager => { ...; await auditService.recordDenied(input); })`, `transactionService.run` được spy (`jest.spyOn`) để đếm số lần gọi · When `run()` chạy · Then `recordDenied()` reject `NestedTransactionError` ngay; `transactionService.run` chỉ được gọi **đúng 1 lần** tổng (lần gọi ngoài của test, không có lần gọi thứ hai từ bên trong `recordDenied`) — domain review vòng 2 #3: chỉ đếm `createQueryRunner` không phân biệt được "guard chặn đúng" với "guard bị đặt sai vị trí/bị xóa nhưng vẫn chỉ có 1 runner vì lý do khác"; đếm `transactionService.run` mới thật sự chứng minh nhánh early-return chạy trước khi `recordDenied` kịp tự gọi `run()` |
| TC-56-19 | F-2 (positive control) | unit | Given gọi `recordDenied(input)` **ngoài** mọi `run()` (như hiện tại) · When gọi · Then không reject `NestedTransactionError`, chạy `record()` qua `transactionService.run` như bình thường (hành vi TC-56-06 không đổi) |
| TC-56-20 | F-2 | unit | Given gọi `recordDenied(input)` sau khi một `run()` khác đã resolve (không còn đang mở) · When gọi · Then không reject `NestedTransactionError` — `AsyncLocalStorage` context đã kết thúc cùng `fn` |
| TC-56-21 | F-2 (chuỗi async, domain review sẽ kiểm) | unit | Given `recordDenied(input)` được gọi từ một hàm `async` thứ hai mà callback của `run()` `await` trực tiếp (ví dụ `await helper()` trong đó `helper` gọi `recordDenied`) — không gọi trực tiếp tại lexical scope của callback · When `run()` chạy · Then vẫn reject `NestedTransactionError` (chứng minh theo dõi theo chuỗi async, không theo lexical scope) |
| TC-56-22 | F-1/F-2 (hồi quy) | integration (db-spec, Postgres thật) | Given mọi test case hiện có TC-56-01 → TC-56-13 · When chạy lại sau fix · Then không có test nào đổi hành vi mong đợi (SQL param thứ 8 vẫn là chuỗi JSON giống cũ cho metadata hợp lệ, `recordDenied()` gọi đúng chỗ vẫn commit DENIED như TC-56-06) |

**Không áp dụng:** không có thay đổi dữ liệu/migration nên không cần test schema mới; F-3 (rebase) không sinh test case — đã xác minh bằng `git merge-tree` (§R1), không phải hành vi runtime.

### R5. Test thủ công (vòng 2)

Cùng script `backend/test/manual/audit-record.manual.ts` (từ vòng 1), mở rộng thêm hai bước mới chứng minh hai fix bằng ứng dụng thật, không chỉ unit test:

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-56-04 | Script: tạo `metadata` có `toJSON()` non-enumerable trả `{ email: 'victim@example.com' }`, gọi `transactionService.run(m => auditService.record(m, {..., metadata}))` | Script in lỗi `AuditMetadataError`, không có gì commit; `psql select * from audit_log where correlation_id = '<id>'` → 0 dòng (PII không lọt vào DB) |
| M-56-05 | Script: gọi `transactionService.run(async m => { await auditService.recordDenied({...}); })` (gọi `recordDenied` lồng trong `run()` đang mở) | Script in lỗi `NestedTransactionError`; `psql` với `correlation_id` của lần gọi đó → 0 dòng (không ghi trùng, không mở transaction thứ hai) |

Điều kiện chạy: như vòng 1 (`docker compose up -d`, `npm run migration:run`, seed `users` + `fc_scratch`, remap cổng 5433 nếu máy có Postgres native khác chiếm 5432). Output nối tiếp vào `docs/features/screenshots/DBS-56/manual-test.txt` (dòng đầu đổi thành SHA commit cuối của vòng 2).

### R6. Domain review (AI, vòng 2)

**Round 1 — Reviewer:** subagent (model mặc định phiên, general-purpose), 2026-11-04 · **Kết quả:** 4 phát hiện (1 blocking, 1 should-fix, 2 minor) · Verdict: REVISE · [trả lời nguyên văn](screenshots/DBS-56/domain-review-round3.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | Thiết kế F-1 thiếu bước default `metadata ?? {}` trước `JSON.stringify` — `JSON.stringify(undefined)` trả giá trị JS `undefined` (không phải chuỗi), `JSON.parse(undefined)` throw `SyntaxError` ngay; case phổ biến nhất (không truyền `metadata`) sẽ crash | **đã sửa** §R2/§R3 — `serializeMetadata` thêm bước default trước `JSON.stringify`, nêu rõ trong cả hành vi và kiến trúc; thêm giải thích case "omitted" vào R2 (sau đó round 2 sửa tiếp cách default, xem phát hiện #5) |
| 2 | should-fix | Guard ALS (F-2) chỉ bắt lồng đồng bộ theo chuỗi async; một caller tương lai kiểu outbox/event-driven gọi `recordDenied()` từ callback bị kích hoạt tách rời chuỗi async (`EventEmitter`/`setImmediate`) sẽ không bị guard bắt, dù transaction gốc vẫn mở | **đã sửa** §R2 — thêm một đoạn "Giới hạn đã biết" nêu rõ đây không phải lưới an toàn toàn diện, cảnh báo trước cho người wire `recordDenied()` vào consumer bất đồng bộ sau này |
| 3 | minor | TC-56-18 chỉ đếm `createQueryRunner`, không phân biệt được "guard chặn đúng" với "chỉ có 1 runner vì lý do khác" | **đã sửa** §R4 — đổi assertion sang spy trực tiếp `transactionService.run`, xác nhận không bị gọi lần hai |
| 4 | minor | Xác nhận F-3 (rebase giải quyết conflict) đúng, không cần sửa | không cần sửa — reviewer tự xác nhận đã đúng |

**Round 2 — Reviewer:** subagent (model mặc định phiên, general-purpose), 2026-11-04 · Review lại các phần đã sửa (R2/R3/R4/R6) sau round 1 · **Kết quả:** xác nhận cả 4 phát hiện round 1 đã xử lý đúng, phát hiện thêm 1 should-fix mới · Verdict: REVISE · [trả lời nguyên văn](screenshots/DBS-56/domain-review-round3.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 5 | should-fix | Bản sửa #1 (round 1) dùng `metadata ?? {}` để default — nhưng `??` coi `null` giống `undefined`, nên một `metadata` tường minh là `null` (đúng kiểu bypass F-1 muốn chặn) bị âm thầm biến thành `{}` và **được accept**, thay vì reject như hành vi hiện tại và như TC-56-07c yêu cầu | **đã sửa** §R2/§R3 — đổi default sang so sánh chặt `metadata === undefined ? {} : metadata` (không dùng `??`), tự verify bằng `node -e` xác nhận `null` vẫn reject đúng và `undefined` vẫn default `{}` đúng; thêm test case TC-56-16b (reject `null` tường minh) vào §R4 |

Round 2 chỉ còn 1 should-fix (không blocking), đã sửa trực tiếp và tự verify bằng thực nghiệm (`node -e`) khớp đúng hành vi mong đợi của TC-56-07c/TC-56-16 — không chạy thêm round 3 trước khi trình G2 vì fix không đổi kiến trúc tổng thể, chỉ đổi cách default một biểu thức.

**Quyết định ở G2 (vòng 2, duyệt qua chat 2026-11-04):** Người dùng trả lời "duyệt" (gõ "duyêth"), không góp ý thêm. Chuyển sang Phase 3.

### R7. Kế hoạch triển khai (vòng 2)

| Bước | File | Test viết trước | Kết quả đỏ (1 dòng, điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `backend/src/modules/audit/audit-metadata.guard.spec.ts` | TC-56-14, TC-56-15, TC-56-16, TC-56-16b, TC-56-17 (mới, cho `serializeMetadata` — đổi `assertValidMetadata` để gọi hàm mới nội bộ) | `TS2305: Module has no exported member 'serializeMetadata'` | `npm run test -- audit-metadata.guard.spec.ts` | `16dfa73` |
| 2 | `backend/src/modules/audit/audit-metadata.guard.ts` | (test bước 1 đỏ vì `serializeMetadata` chưa tồn tại) | (như trên) → xanh: 34/34 | `npm run test -- audit-metadata.guard.spec.ts` | `da86d99` |
| 3 | `backend/src/modules/audit/audit.service.ts` | TC-56-16 (SQL param thứ 8 phải là chuỗi từ `serializeMetadata`, không `JSON.stringify` riêng); `audit.service.spec.ts` TC-56-01 giữ nguyên (hồi quy) | n/a — thay code production, không viết test đỏ riêng ở bước này | `npm run test -- audit.service.spec.ts audit-metadata.guard.spec.ts` → xanh: 38/38 | `fe4034d` |
| 4 | `backend/src/database/transaction.helper.spec.ts` | Test mới: `activeTransactionContext.getStore()` là `true` trong `fn`, `undefined` ngoài `withTransaction`, giữ `undefined` sau khi `fn` resolve/reject | `TS2305: Module has no exported member 'activeTransactionContext'` | `npm run test -- transaction.helper.spec.ts` | `c4871c4` |
| 5 | `backend/src/database/transaction.helper.ts` | (test bước 4 đỏ vì `activeTransactionContext` chưa tồn tại) | (như trên) → xanh: 19/19 | `npm run test -- transaction.helper.spec.ts`, sau đó `npm run test` toàn bộ | `d0f0174` |
| 6 | `backend/src/modules/audit/audit.types.ts` | `audit.types.spec.ts` thêm case `NestedTransactionError` là `instanceof Error`, message cố định | n/a — type/class mới, thêm cùng lúc với test (không tách được đỏ riêng vì compile-time) | `npm run test -- audit.types.spec.ts` → xanh: 3/3 | `cff5a53` |
| 7 | `backend/src/modules/audit/audit.service.spec.ts` | TC-56-18, TC-56-19, TC-56-20, TC-56-21 (mới, cho guard lồng transaction trong `recordDenied()`) | TC-56-18 và TC-56-21 fail: "Resolved to value: undefined" thay vì reject `NestedTransactionError` | `npm run test -- audit.service.spec.ts` | `b3ce59c` |
| 8 | `backend/src/modules/audit/audit.service.ts` | (test bước 7 đỏ vì chưa có guard) | (như trên) → xanh: 8/8 | `npm run test -- audit.service.spec.ts` | `66b26ab` |
| 9 | — (hồi quy toàn bộ) | TC-56-22: chạy lại TC-56-01→13 | n/a | `npm run test` (818/820, 2 fail pre-existing không liên quan) và `npm run test:db -- audit` (51/51) | (không commit riêng — đã xác nhận, xem R8) |
| 10 | `backend/test/manual/audit-record.manual.ts` | M-56-04, M-56-05 (mở rộng script, không phải unit test) | — | chạy tay qua Docker Postgres thật, dán output vào `manual-test.txt` | `248a0bf` |
| 11 | `docs/features/DBS-56-audit-service-record.md` + `docs/features/screenshots/DBS-56/manual-test.txt` | — | — | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | (commit này, sau khi G4 được duyệt) |

**Rủi ro và cách lùi:**
- Bước 2/5/8 đổi hành vi runtime production; nếu `npm run test` toàn bộ (`audit`, `database`, các module khác dùng `withTransaction`) đỏ bất ngờ sau một bước, dừng lại ở đó, không đi tiếp bước sau — sửa ngay trong cùng bước, không gộp nhiều thay đổi logic vào một commit.
- Bước 5 đổi `transaction.helper.ts`, file nền tảng dùng chung với `AccountsService`, `OutboxWriter` (tương lai) — chạy `npm run test` toàn bộ backend (không chỉ file audit) sau bước 5 để chắc không phá caller khác, trước khi qua bước 6.
- Nếu bước 9 phát hiện hồi quy, lùi về bước trước đó bằng `git revert` commit vừa tạo, không sửa đè lên commit cũ.
- Baseline trước khi bắt đầu: `npm run lint:check && npm run typecheck && npm run test` sạch (trừ hai test pre-existing-flaky đã ghi ở §R1: `jwks-verifier.service.spec.ts` BL-112, `outbox-writer-bootstrap.db-spec.ts` do thiếu `NODE_OPTIONS=--experimental-global-webcrypto` trên Node 18 local — không thuộc phạm vi DBS-56).

**Quyết định ở G3 (duyệt qua chat 2026-11-04):** Người dùng trả lời "duyệt". Chuyển sang Phase 4.

### R8. Kết quả (vòng 2)

- **Lệnh kiểm tra** (chạy lúc bàn giao, branch `fix/DBS-56-audit-service-record-review-fixes`, `DATABASE_URL` trỏ cổng 5433 vì máy có Postgres native chiếm 5432, `NODE_OPTIONS=--experimental-global-webcrypto` vì môi trường local dùng Node 18 — xem §R1):
  ```
  npm run lint:check  → sạch, 0 lỗi
  npm run typecheck   → sạch, 0 lỗi
  npm run test        → 53 suites / 818 tests pass, 1 suite fail (jwks-verifier.service.spec.ts,
                         BL-112, flaky có sẵn trên main — không do vòng 2)
  npm run test:e2e    → 13 suites / 135 tests pass
  npm run test:db     → 16 suites / 335 tests pass, 1 suite fail (outbox-writer-bootstrap.db-spec.ts,
                         pre-existing trên main — NODE_OPTIONS không truyền qua execFile whitelist
                         trên Node 18 local, không do vòng 2; xem §R1)
  ```
  Cả hai lỗi còn lại đã được xác nhận pre-existing trước khi bắt đầu Phase 4 (baseline chạy trước bước 1, và lại sau bước 9) — không phải regression của vòng 2.

- **Đối chiếu test case (vòng 2):**

| ID | Test | Đạt? |
|---|---|---|
| TC-56-14 | `audit-metadata.guard.spec.ts` › TC-56-14 rejects a non-enumerable toJSON() | đạt |
| TC-56-15 | `audit-metadata.guard.spec.ts` › TC-56-15 rejects a Date | đạt |
| TC-56-16 | `audit-metadata.guard.spec.ts` › TC-56-16 accepts … and returns its JSON serialization | đạt |
| TC-56-16b | `audit-metadata.guard.spec.ts` › TC-56-16b rejects an explicit null | đạt |
| TC-56-17 | `audit-metadata.guard.spec.ts` › TC-56-17 propagates an error from JSON.stringify itself | đạt |
| TC-56-18 | `audit.service.spec.ts` › TC-56-18 rejects NestedTransactionError … run() is only invoked once total | đạt |
| TC-56-19 | `audit.service.spec.ts` › TC-56-19 (positive control) runs normally outside any run() | đạt |
| TC-56-20 | `audit.service.spec.ts` › TC-56-20 runs normally after an earlier run() has resolved | đạt |
| TC-56-21 | `audit.service.spec.ts` › TC-56-21 rejects NestedTransactionError nested through an awaited async helper | đạt |
| TC-56-22 | `npm run test` + `npm run test:db -- audit` (toàn bộ TC-56-01→13) | đạt — không test nào đổi hành vi mong đợi |

- **Test thủ công:** chạy thật trên `docker compose` (Postgres remap cổng 5433), một `users` thật seed qua script Node trực tiếp (tương đương `psql`), bảng `fc_scratch` đã có từ vòng 1. Script: `backend/test/manual/audit-record.manual.ts` (mở rộng từ vòng 1). Output thô nối tiếp vào [manual-test.txt](screenshots/DBS-56/manual-test.txt), đoạn "Vòng 2" ở cuối file (commit cuối đổi code: `66b26ab`).

  | Bước | Lệnh | Phản hồi (rút gọn) | Kết quả |
  |---|---|---|---|
  | M-56-04 | script tạo `metadata` có `toJSON()` non-enumerable trả `{email: 'victim@example.com'}`, gọi `record()` | script in lỗi `AuditMetadataError` ngay; xác nhận trực tiếp qua `select count(*)`: 0 dòng cho correlation đó | đạt |
  | M-56-05 | script gọi `recordDenied()` **trong** một `transactionService.run()` đang mở | script in lỗi `NestedTransactionError` ngay; xác nhận trực tiếp qua `select count(*)`: 0 dòng cho correlation đó | đạt |

  Điều kiện chạy: như vòng 1 (`docker compose up -d`, Postgres đã migrate từ trước, seed `users` + `fc_scratch`, remap cổng 5433).

- **Phạm vi so với §R7:** `git diff --stat main...HEAD` → đúng các file ở §R7 (9 file code/test: `audit-metadata.guard.ts`/`.spec.ts`, `audit.service.ts`/`.spec.ts`, `audit.types.ts`/`.spec.ts`, `transaction.helper.ts`/`.spec.ts`, `audit-record.manual.ts`) cộng tài liệu (`DBS-56-audit-service-record.md`, `manual-test.txt`, `domain-review-round3.md`) và các file rebase đã nêu ở §R1 (`modules/index.ts`, `BACKLOG.md`, `features/README.md`). Không có file ngoài kế hoạch.

- **Ảnh chụp:** không có PNG — cùng lý do vòng 1 (thư viện nội bộ, không có UI). Bằng chứng là output terminal/truy vấn DB trực tiếp, lưu đủ ở `manual-test.txt`.

- **Lệch so với kế hoạch:** không có.

- **Bàn giao cho vai khác:** không có mục mới — **BL-137** (theo dõi DoD #5: PR merge, Dev review, CI) vẫn mở, không đổi bởi vòng sửa review này.

### R9. Tài liệu đã cập nhật (vòng 2)

- `docs/features/DBS-56-audit-service-record.md` — thêm toàn bộ mục "Vòng 2" (R1–R9).
- `docs/features/screenshots/DBS-56/domain-review-round3.md` — mới, chứa cả 2 round domain review của vòng 2 (round 1: 4 phát hiện REVISE; round 2: xác nhận + 1 phát hiện mới REVISE).
- `docs/features/screenshots/DBS-56/manual-test.txt` — nối thêm output M-56-04/05.
- `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` — sạch, 188 file, 0 link hỏng.

**Quyết định ở G4 (vòng 2):** chờ người dùng duyệt sau khi trình bày tin nhắn G4.
