# DBS-55 · AccountsService: khóa tài khoản, đổi số dư và kiểm tra sở hữu

> **Status:** Implemented (G4 đã duyệt; Draft PR #33 đã mở, CI theo Checks; chờ Dev review và merge; còn lỗi baseline ngoài phạm vi) · **Vai:** Dev · **Cặp đôi review:** Dev khác, chưa chỉ định · **Nhánh:** `feat/DBS-55-accounts-service` · **PR:** [#33](https://github.com/Lawliet119/digital-banking-simulator/pull/33) · **Cập nhật:** 2026-10-28

## 1. Bối cảnh

- **Task trên board:** Story, Tuần 2, ưu tiên Highest, Status `In Progress`, Deliverable/Demo **P2**. Đã lấy task bằng `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-55` ngày 2026-10-27; agent không sửa board.
- **Tóm tắt (nguyên văn):** AccountsService: lockForUpdate (khóa theo thứ tự id), applyBalanceChange, getOwnedAccount
- **Thực trạng trên board (nguyên văn):** Mới là chữ ký trên giấy ở roadmap Task 2. Ledger (DBS-60, DBS-61) cần ba hàm này nên đây là việc chặn đường găng.
- **Expect (nguyên văn):** Ledger có hàm khóa và đổi số dư an toàn để dùng ngay.
- **DoD (nguyên văn, đánh số):**
  1. lockForUpdate(ids, manager) chạy SELECT … FOR UPDATE … ORDER BY id; test thứ tự khóa kể cả khi truyền id lộn xộn, và hai transaction khóa chéo (A,B) và (B,A) không deadlock
  2. applyBalanceChange(accountId, delta: bigint, manager) cập nhật số dư trong transaction của người gọi; không cho số dư khách âm (để DB từ chối nếu sync guard sót)
  3. getOwnedAccount(accountId, userId) ném 404 nếu không thuộc về user (không phải 403)
  4. Export qua modules/accounts/index.ts; eslint không cho import sâu
  5. Số dư là string/bigint; không đưa số dư vào Redis
  6. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ

### Phụ thuộc và trạng thái thật

| Phụ thuộc | Board | Trong checkout `main` tại `ab53152` | Mức bằng chứng hiện tại |
|---|---|---|---|
| DBS-20 · Migration 1: users, customers, accounts và tài khoản SYSTEM funding | Done | [Migration thật](../../backend/src/database/migrations/1791763200000-CreateUsersCustomersAccounts.ts) tạo `users`, `customers`, `accounts`, `accounts_balance_non_negative`, `accounts_owner_matches_type` và hàng funding; có [test PostgreSQL](../../backend/test/db/accounts-schema.db-spec.ts) | Đã đọc source; baseline DB hiện tại gồm accounts-schema đạt 8 suites/154 tests. Hồ sơ [DBS-20](DBS-20-migration-users-customers-accounts.md) là bằng chứng lịch sử bổ sung |
| DBS-39 · Testcontainers: helper Postgres 17 chạy migration cho test | Done | [Postgres container](../../backend/test/support/postgres.container.ts), [global setup](../../backend/test/support/jest-global-setup.ts), [DB tạm và migration helper](../../backend/test/support/temp-database.ts), [sample DB suite](../../backend/test/db/testcontainers-sample.db-spec.ts) đã có | Baseline DB 8 suites/154 tests đã chạy qua Testcontainers trên PostgreSQL 17 thật. Hồ sơ [DBS-39](DBS-39-testcontainers-postgres.md) ghi các giới hạn harness ở BL-015/016/017 |

### Đã có gì và phạm vi đề xuất

- Worktree riêng tạo từ `main` `ab53152`; các nhận xét source/baseline dưới đây là lúc G1, trước implementation ở §8.
- `accounts` hiện chỉ có [README](../../backend/src/modules/accounts/README.md); chưa có service, module, entity hoặc `index.ts`. `ledger` và `audit` cũng chỉ có README. Kết quả `rg` trong `backend/src` và `backend/test` chưa có caller chạy thật của `AccountsService`, `lockForUpdate`, `applyBalanceChange`, `getOwnedAccount`; các tên này chỉ nằm trong README và comment ví dụ của transaction helper/service.
- [TransactionService.run](../../backend/src/database/transaction.service.ts) và [withTransaction](../../backend/src/database/transaction.helper.ts) đã có, truyền `EntityManager`, thiết lập READ COMMITTED/timeouts và retry cả transaction; task accounts cần dùng transaction người gọi theo thiết kế đã chấp nhận.
- [Luật eslint](../../backend/eslint.config.mjs) đã cấm import sâu module bằng alias và cấm relative import đi ra ngoài module. [Registry module](../../backend/src/modules/index.ts) hiện đăng ký Health/Identity cho API, chưa có AccountsModule.
- [Kiểu tiền dùng chung](../../backend/src/common/money/index.ts) đã có `Money`/`Balance` dựa trên `bigint`; cột `accounts.balance` là PostgreSQL `bigint`. [ErrorCode](../../backend/src/common/errors/error-code.enum.ts) hiện không có mã riêng cho account 404; [filter](../../backend/src/common/filters/problem-details.filter.ts) hỗ trợ `NotFoundException`. Không cần đổi ErrorCode chỉ để đáp ứng DoD #3.
- Nguồn đối chiếu: [docs/02](../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) FR-ID-04, FR-ACC-02, FR-LED-03, AC-5.8/5.9, NFR-SEC-01; [docs/03](../03_HIGH_LEVEL_ARCHITECTURE.md) §5–8, §12; [database-design](../components/_shared/database-design.md) §4.1–4.2; [ADR-04](../adr/0004-row-locking-read-committed.md), [ADR-07](../adr/0007-nestjs-typeorm-explicit-sql.md), [ADR-09](../adr/0009-funding-system-account.md), [ADR-12](../adr/0012-redis-valkey-node.md); [accounts brief](../components/accounts/01-concept-brief.md); [roadmap Task 2](../superpowers/plans/2026-10-02-master-roadmap.md).
- **Trong phạm vi đề xuất:** ba hàm của AccountsService, public export và Nest wiring cần thiết, test PostgreSQL thật cho thứ tự khóa/concurrency/transaction và quyền sở hữu, kiểm tra ranh giới import, tài liệu và bằng chứng cho phần service. Thiết kế chi tiết, case cụ thể và danh sách file triển khai chờ G1 rồi mới lập.

### Baseline hiện tại

Baseline chạy tại checkout gốc `main` `ab53152` (cùng base với worktree này), ngày 2026-10-27. Lần e2e đầu thất bại vì Docker Desktop chưa hoạt động; sau khi cách ly thư mục socket tạm bằng đổi tên và khởi động lại, Docker engine và các service Compose đã chạy. Giữ nguyên dữ liệu container/volume và cấu hình Docker; thư mục socket cũ được giữ tại `C:\Users\Admin\AppData\Local\Docker\run.stale-dbs-20261027-162600`.

| Lệnh | Kết quả hiện tại |
|---|---|
| `docker compose up -d` | Đạt sau khôi phục Docker; PostgreSQL/Valkey healthy, ElasticMQ running |
| `npm run lint:check` (trong `backend/`) | Đạt, exit 0 |
| `npm run typecheck` (trong `backend/`) | Đạt, exit 0 |
| `npm test -- --runInBand` (trong `backend/`) | Đạt: 30 suites, 495 tests, 0 skipped |
| `npm run test:e2e -- --runInBand` (trong `backend/`) | Đạt sau khôi phục Docker: 8 suites, 57 tests, 0 skipped; lần đầu lỗi `ECONNREFUSED` khi PostgreSQL chưa sẵn sàng |
| `npm run test:db -- --runInBand` (trong `backend/`) | Đạt: 8 suites, 154 tests, 0 skipped, PostgreSQL 17 thật qua Testcontainers |

Đây là baseline của code có sẵn tại `ab53152`, chưa phải test cho implementation DBS-55. Link checker của worktree: 132 files checked, 0 broken link(s).

### Ngoài phạm vi và backlog liên quan

| Việc | Phạm vi đề xuất ở G1 |
|---|---|
| API onboarding/mở tài khoản/xem tài khoản/khóa và mở khóa, role guard, thu hồi phiên | Các task identity/accounts tương ứng; task này chỉ giao service primitive |
| Luồng nạp/chuyển tiền, sync guard, idempotency, hai bút toán, audit/outbox trong giao dịch nghiệp vụ | DBS-60/61 và các task ledger/guard liên quan. Không dựng stub các service chưa có; không nhận đủ AC-5.8/5.9 chỉ từ test primitive |
| Audit DENIED khi truy cập tài khoản người khác | BL-019 / task AuditService và task gọi nghiệp vụ. Hiện `audit` chưa có service; phải ghi bàn giao, không nhận đủ AC-5.8 từ kết quả 404 |
| BL-008 · luật lint chuyên biệt cấm Number/parseInt/parseFloat trên tiền | Đề xuất giữ ngoài phạm vi; task này giữ số dư string/bigint và dùng luật import đã có. BL-008 vẫn mở, không coi DoD #5 là đã bổ sung luật lint tiền |
| BL-002/003 · event nạp tiền và guard tài khoản SYSTEM | Bàn giao DBS-60/61; không biến account primitive thành sync guard |
| BL-015/016/017 · timing test cũ, coverage Testcontainers trong CI và production-role tests | Giới hạn harness hiện có; task này không thay CI hoặc role/grant production |
| Schema/migration mới, ADR, event contract, ErrorCode, env var, dependency mới, Redis cache số dư | Không đề xuất thay trong task này |
| Invariant script chung DBS-69, load test toàn hệ thống, CI remote/Dev review/merge | Task và bước quy trình riêng; chưa có bằng chứng tại Phase 1. Không tự commit, push, mở PR hoặc merge |

### Manual test và câu hỏi mở ở G1

Chưa có deposit/transfer API hoặc LedgerService chạy thật trong checkout. Skill [task-kinds](../../.claude/skills/dbs-delivering-task/references/task-kinds.md) cấm tạo số dư/bút toán bằng SQL seed và cấm dựng service phụ thuộc giả. Do đó chưa thể coi một bài chạy nạp/chuyển tiền qua HTTP là đã thực hiện.

1. **Mức manual test khi chưa có caller ledger:** đề xuất kiểm primitive bằng driver gọi AccountsService thật trên PostgreSQL/DB tạm, kiểm khóa và quyền sở hữu; không seed số dư bằng SQL. Thiết kế ở Phase 2 sẽ phân biệt rõ thao tác đang kiểm với dữ liệu đầu vào và bước rollback. Các bước nạp/chuyển tiền hoàn chỉnh qua API ghi **chưa chạy (chờ DBS-60/61)**, cần được chấp nhận theo tên ở G4; không miễn các test tự động PostgreSQL của DoD #1–3.
2. **Bàn giao audit và lint tiền:** đề xuất giữ BL-019 và BL-008 ngoài phạm vi như bảng trên; đưa trách nhiệm audit DENIED vào phần bàn giao khi hoàn thiện tài liệu. Không tạo AuditService giả để khép AC-5.8.
3. **Định danh user ở giao diện service:** đề xuất giữ `userId` theo quan hệ `customers.user_id → users.id` của schema. JWT hiện mới cung cấp `sub`; việc ánh xạ Cognito sub sang user nội bộ và gọi service thuộc task identity/endpoint, không suy diễn hai id này bằng nhau.

**Quyết định ở G1:** Người dùng trả lời «duyệt g1» cho cả DBS-55/57 ngày 2026-10-27. Phạm vi và các bàn giao ở trên đã được chấp nhận: driver service thật trên PostgreSQL, không SQL seed tiền/fake ledger; E2E nạp/chuyển chờ DBS-60/61; userId nội bộ; BL-008/019 ngoài phạm vi. Bắt đầu Phase 2.

## 2. Hành vi

### Contract đề xuất

```ts
interface Account {
  id: string; customerId: string | null; userId: string | null;
  type: 'CHECKING' | 'SAVINGS' | 'SYSTEM'; status: 'ACTIVE' | 'LOCKED';
  balance: string; createdAt: Date; updatedAt: Date;
}
type LockedAccount = Account;
lockForUpdate(ids: string[], manager: EntityManager): Promise<LockedAccount[]>;
applyBalanceChange(accountId: string, delta: bigint, manager: EntityManager): Promise<void>;
getOwnedAccount(accountId: string, userId: string): Promise<Account>;
```

Snapshot camelCase, SQL alias từng cột (`c.user_id AS "userId"`). `balance` giữ chuỗi PostgreSQL, delta truyền bằng `toString()`, không Number/parseInt. Date serialize ISO UTC. Không endpoint/DTO mới; snapshot chưa là contract HTTP.

| Điều kiện | Kết quả |
|---|---|
| Mutation: manager thiếu QueryRunner, runner released hoặc chưa `startTransaction()` | `Error` an toàn trước SQL, kể cả lock `[]`; không transaction riêng |
| UUID chuẩn 8-4-4-4-12 hex hoa/thường | Chuẩn hóa lowercase; không ép v4, không sửa array người gọi |
| Mutation: id/array sai kiểu/dạng, delta không bigint | `TypeError` an toàn trước SQL, không nhúng input vào lỗi |
| Lock [B,A,A] | SELECT tham số `ANY($1::uuid[])`, `ORDER BY a.id FOR UPDATE OF a`; trả A,B duy nhất; LEFT JOIN customers lấy owner, không khóa phía nullable |
| Lock rỗng/thiếu id/LOCKED/SYSTEM | `[]`/chỉ hàng tồn tại; vẫn trả LOCKED/SYSTEM để ledger quyết định guard |
| Apply id, delta | `UPDATE accounts SET balance=balance+$2::bigint, updated_at=now() WHERE id=$1::uuid RETURNING id`; cộng nguyên tử trong caller transaction; `0n` hợp lệ |
| UPDATE không thấy hàng | `NotFoundException`404; caller rollback khi lỗi |
| Khách0 trừ1; SYSTEM âm | Khách: DB `23514`, `accounts_balance_non_negative`; SYSTEM được âm tới −2^63 |
| Delta/cộng vượt signed64 | DB `22003`; giới hạn balance −9223372036854775808…9223372036854775807; không làm tròn/clamp |
| Owned đúng internal user | DataSource đọc committed state; JOIN customers theo `customers.user_id=$2`; trả snapshot |
| Owned: account/user thiếu, sai dạng, chủ khác, SYSTEM | Cùng `NotFoundException`404 an toàn, không 403/existence/PII |

TypeORM PostgreSQL raw UPDATE trả **`[rows,rowCount]`** (đã đọc installed `PostgresQueryRunner.js:198–208`); apply kiểm rowCount=0, trả void, không đếm `result.length`. SELECT trả rows. DB tests phải phủ updated/missing riêng.

Không catch/đổi `23514` thành INSUFFICIENT_FUNDS: ledger guard quyết định REJECTED trước update. Lỗi SQL truyền ra caller, không retry nội bộ; transaction đã lỗi phải rollback, không query tiếp. Filter có sẵn che SQL/stack khỏi HTTP; không ErrorCode mới. Driver stringify snapshot có `"balance":"9007199254740993"` chính xác.

## 3. Kiến trúc

- `accounts.service.ts`: injectable DataSource, SQL tham số hóa; `account.types.ts`: snapshot; `accounts.module.ts`: provide/export service, không controller/consumer; public `index.ts` export service/module/types.
- `modules/index.ts` thêm AccountsModule vào **apiModules** (api/both); worker chưa có caller. Caller mới import `@modules/accounts`, truyền manager hiện tại; grep chỉ có ví dụ transaction helper/service, không caller thật cần đổi.
- Đọc accounts JOIN customers; chỉ UPDATE balance/updated_at. Không schema/index/FK mới, full_name/PII, ledger/audit/outbox/Redis. Owned dùng DataSource riêng nên không đọc tentative balance từ mutation manager.
- Production ledger dùng `TransactionService.run`; test contention dùng QueryRunner trực tiếp, không retry che deadlock. Phải `runner.startTransaction()`, raw SQL BEGIN không cập nhật `isTransactionActive`.
- Bàn giao cập nhật README accounts, brief, feature index/BACKLOG; không đổi ADR. Full ledger E2E/audit vẫn là handoff §1.

```mermaid
sequenceDiagram
  participant Caller as Caller/driver thật
  participant Tx as TransactionService/QueryRunner
  participant Acc as AccountsService
  participant PG as PostgreSQL
  Caller->>Tx: mở transaction
  Tx->>Acc: lockForUpdate(ids, manager)
  Acc->>PG: ORDER BY a.id FOR UPDATE OF a
  PG-->>Acc: snapshot balance:string
  Tx->>Acc: applyBalanceChange(id, delta, manager)
  Acc->>PG: UPDATE balance + delta
  Acc-->>Tx: void / ném lỗi
  Caller->>Tx: commit nghiệp vụ / rollback probe
```

## 4. Test cases tự động

DB suite dự kiến `test/db/accounts-service.db-spec.ts`: PostgreSQL17 thật, migration production; chỉ SQL seed users/customers/accounts balance mặc định0. Metadata có thể commit; money chỉ qua service trong transaction rồi rollback. Không fake DB/service, skip/only/todo/retry/SQL seed tiền. Sau rollback chạy 4 checks §5; chưa có script invariant DBS-69.

| ID | Truy vết | Lớp / Given → When → Then | Lỗi mong đợi |
|---|---|---|---|
| TC-55-01 | DoD1 | DB: [B,A,A]→A,B distinct, input nguyên; empty→[], missing→subset, LOCKED/SYSTEM không lọc | — |
| TC-55-02 | DoD1, ADR04 | DB: holder khóa low; service [high,low] waits holder; observer pg_blocking_pids xác nhận; probe high FOR UPDATE NOWAIT thành công; thả holder→service xong | Không55P03/40P01 |
| TC-55-03 | DoD1, AC5.9 phần khóa | DB: hai runner [A,B]/[B,A] qua launch barrier, cùng waits holder-low; thả holder; giữ winner đến khi loser blocked by winner, commit lần lượt; cả hai xong, không retry | Không40P01 |
| TC-55-04 | DoD2 | DB: manager global/runner chưa tx/released → mutation lỗi trước SQL; empty vẫn kiểm guard | Error nội bộ |
| TC-55-05 | DoD2/5 | DB: service funding−300000/khách+300000; cùng manager thấy mới, ngoài thấy0; rollback→cả hai0, updated_at về cũ | — |
| TC-55-06 | DoD2/5 | DB: cặp delta ±9007199254740993n; lock/JSON snapshot giữ chuỗi, 0n hợp lệ; cuối rollback; không claim HTTP E2E | — |
| TC-55-07 | DoD2, FR-LED03 | DB: khách0→−1n bị CHECK; rollback toàn bộ, không thay đổi lưu lại | 23514 + accounts_balance_non_negative |
| TC-55-08 | DoD2/5, ADR09 | DB: funding−MAX/khách+MAX; MIN bằng funding−2^63, hai khách+MAX/+1 trong một tx; sum0; rollback | — |
| TC-55-09 | DoD2/5 | DB: khách MAX+1, SYSTEM MIN−1, delta ngoài signed64, mỗi probe tx riêng→rollback | 22003 |
| TC-55-10 | DoD2 | DB: apply UUID thiếu→404; updated row→void; không nhận nhầm UPDATE tuple thành hai hàng | 404, không ErrorCode mới |
| TC-55-11 | DoD3, FR-ID04 | DB: internal owner→snapshot; chủ khác/missing account/user/SYSTEM→cùng404 response an toàn | 404 |
| TC-55-12 | DoD3 | DB: malformed/null/injection id ở account/user→404; Cognito sub không bị coi là internal id | 404 |
| TC-55-13 | DoD1/2, injection | DB: mutation nhận "' OR 1=1 --", invalid array, JS number300000→lỗi trước SQL, bảng nguyên; logger thật kiểm parameters tách query | TypeError |
| TC-55-14 | DoD4 | Unit tĩnh: public export typecheck; effective eslint no-restricted-imports cấm deep alias/relative, cho @modules/accounts | lint diagnostic |
| TC-55-15 | DoD4/5 | DB/Nest resolve AccountsService từ AccountsModule với DataSource thật; unit registry api/both có, worker không; chỉ phụ thuộc DataSource | — |
| Quy trình | DoD6 | CI/Dev review/merge, bảng TC trong PR: chưa làm; domain review không thay thế | — |

TC02/03: observer riêng, pool≥5, poll DB bằng deadline + `setImmediate`, không sleep; statement/lock timeouts hữu hạn; finally thả barrier, rollback/release mọi runner. Chứng minh thứ tự **lấy khóa**, không chỉ output. Test lỗi kiểm status/SQLSTATE/constraint, không so câu chữ detail.

| Security checklist | TC / giới hạn |
|---|---|
| Ownership account-scoped query cho khách | 11/12; lock/update là primitive trusted cho ledger |
| SQL tham số hóa/hostile input | 12/13 |
| Role guard/idempotency user-scope/customer DTO không fraud | Không áp dụng: chưa thêm endpoint/command/DTO |
| REJECTED/DENIED audit | Chưa làm: BL-019/ledger; không nhận đủ AC5.8 |
| Không lộ SQL/PII, correlationId | 11/12: lỗi service an toàn; HTTP filter/middleware đã có, integration ledger chờ60/61 |
| TLS/secrets | Cấu hình hiện có, không đổi TLS/env; driver không URL/PII; cloud/production roles ngoài phạm vi |

## 5. Test thủ công

Driver dự kiến `backend/test/manual/accounts-service.manual.ts`: Nest context nhập **AccountsModule thật** + TypeOrmModule trỏ DB tạm đã migrate; không HTTP probe/fake Ledger/bypass auth. DATABASE_URL được cấp ngoài transcript, không in URL. Seed SQL chỉ users/customers (Nguyễn An, Trần Bình), accounts **bỏ cột balance**. Finally dọn DB/connection.

Chạy tại `backend/`, **Git Bash**, sau commit code cuối (chưa chạy ở Phase2):

```bash
set -euo pipefail
mkdir -p ../docs/features/screenshots/DBS-55
git rev-parse HEAD > ../docs/features/screenshots/DBS-55/manual-test.txt
npx cross-env NODE_ENV=test ts-node -r tsconfig-paths/register test/manual/accounts-service.manual.ts all 2>&1 | tee -a ../docs/features/screenshots/DBS-55/manual-test.txt
```

Driver phải trả exit khác 0 khi assertion thất bại; luôn cleanup trong `finally`. `pipefail` giữ trạng thái lỗi của driver qua `tee`, không coi việc ghi transcript thành công là manual test đạt.

| Bước | Driver `all` / việc operator kiểm | Mong đợi |
|---|---|---|
| M-55-01 | Init Nest/DB; seed metadata0; in owner read | Đúng chủ snapshot0; chủ khác/missing/SYSTEM404; không PII/URL |
| M-55-02 | Holder-low, service [high,low], observer/probe-high; rồi hai service chéo như TC02/03 | PID/blockers/thứ tự; NOWAIT high thành công, không retry/deadlock |
| M-55-03 | runner.startTransaction; service funding−300000/khách+300000, cặp >2^53; đọc cùng manager/observer rồi rollback | Chuỗi chính xác; observer0; cuối cả hai0; không commit money thiếu ledger |
| M-55-04 | Tx riêng: khách−1, overflow, manager không active, hostile id; orchestrator rollback trước đọc lại | 23514+CHECK, 22003, lỗi an toàn; DB dùng lại được, tiền0 |
| M-55-05 | Sau mọi money rollback, 4 SQL checks inline rồi cleanup | 4 pass; không nhận bút toán hợp lệ trong lúc probe |
| M-55-06 | Nạp/chuyển HTTP, audit DENIED, invariants giao dịch ledger | **Chưa chạy (chờ DBS-60/61 và AuditService)** theo G1; G4 chấp nhận từng bước |

Checks inline đọc `ledger_entries.direction` DEBIT/CREDIT: (1) tổng DEBIT=tổng CREDIT; (2) tổng balance=0; (3) không khách âm; (4) từng balance=SUM(CREDIT−DEBIT), COALESCE0. Chạy **sau rollback**: fixture không có bút toán nên mọi balance phải0. Check trung gian chỉ chứng minh primitive/transaction, không double-entry. Chụp output thật `01-ownership.png`, `02-lock-order.png`, `03-money-rollback.png`, `04-rejections-invariants.png`; transcript UTF-8, redact token/Authorization/password/AWS ids/ARN.

## 6. Domain review (AI)

Reviewer độc lập: **gpt-6-astra**, không có lịch sử task. [Phản hồi nguyên văn vòng 1](screenshots/DBS-55/domain-review-round-1.md): 0 blocking, 1 should-fix, 0 minor; `Verdict: REVISE`. [Review lại nguyên văn](screenshots/DBS-55/domain-review.md): `Verdict: APPROVE`, 0 phát hiện còn mở. Đây là review thiết kế, không phải kết quả runtime.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | Pipeline có thể che exit lỗi và chưa tạo thư mục transcript | Đã sửa §5: `set -euo pipefail`, tạo thư mục trước ghi SHA; driver exit khác 0 khi assertion sai và cleanup trong finally. Review lại đã APPROVE. |

**Quyết định G2:** Người dùng trả lời «duyệt g2» cho cả DBS-55/57 ngày 2026-10-27. Giữ nguyên hành vi, kiến trúc, TC và manual script §2–5 đã được domain review APPROVE. Bắt đầu Phase 3; chưa cho phép implementation hoặc commit.

## 7. Kế hoạch triển khai

### Trình tự TDD và file được phép

Các lệnh dưới chạy trong `backend/` của worktree DBS-55 trừ khi ghi rõ. G3 đã cho phép commit local sau bước xanh; P1–P5 đã commit, P6 đã có tài liệu và bằng chứng để commit local. Mỗi hành vi đi qua test trước → đỏ thật → code → xanh → dọn code; output nằm ở [tdd-red-green.txt](screenshots/DBS-55/tdd-red-green.txt). Commit code cuối là `f1d7a5f321d463231868c6ab2c8b450f675c8644`; kiểm tra cuối và manual trên SHA này được ghi ở §8.

| Bước | File được phép thêm/sửa (từ root repo) | Test trước và đỏ/xanh quan sát | Lệnh chứng minh | Commit local / đề xuất |
|---|---|---|---|---|
| P0 · Môi trường/schema | Không sửa file repo. `npm ci` theo `backend/package-lock.json`; xác nhận Node≥24, Docker và Compose hiện tại, không reset/đụng volume. Dùng migration production hiện có qua helper; không migration mới/down | Không thêm hành vi; baseline đã ghi §1, kiểm lại khi môi trường thay đổi | `node --version`; `npm --version`; `npm ci`; `docker compose ps` tại root | Không |
| P1 · Khóa, snapshot và guard | `backend/src/modules/accounts/account.types.ts`; `backend/src/modules/accounts/accounts.service.ts`; `backend/src/modules/accounts/index.ts`; `backend/test/db/accounts-service.db-spec.ts`; `backend/test/support/accounts-service-probe.ts` | TC-55-01/02/03, phần lock của04/13. Đỏ TS2307 thiếu public service; xanh DB5 tests tại 65a4541. Helper chỉ fixture0/barrier/poll/cleanup/SQL checks thật, không fake service | `npm run test:db -- --runInBand --runTestsByPath test/db/accounts-service.db-spec.ts`; `npm run typecheck` | `feat(accounts): lock accounts in deterministic id order` |
| P2 · Đổi số dư trong caller transaction | `backend/src/modules/accounts/accounts.service.ts`; `backend/test/db/accounts-service.db-spec.ts`; `backend/test/support/accounts-service-probe.ts` | Phần apply của04/13 và TC-55-05…10. Đỏ TS2339 thiếu apply; 4 regression đỏ/15 pass đã tái hiện, sửa rồi xanh DB19 tests tại ba12e32. | Cùng lệnh DB P1; `npm run typecheck` | `feat(accounts): apply balance changes in caller transactions` |
| P3 · Quyền sở hữu | `backend/src/modules/accounts/accounts.service.ts`; `backend/test/db/accounts-service.db-spec.ts`; `backend/test/support/accounts-service-probe.ts` | TC-55-11/12. Đỏ TS2339 thiếu owned; xanh DB31 tests tại 078093a, gồm valid Cognito sub khác internal id. | Cùng lệnh DB P1; `npm run typecheck` | `feat(accounts): enforce uniform ownership checks` |
| P4 · Public API và Nest wiring | `backend/src/modules/accounts/accounts.module.ts`; `backend/src/modules/accounts/index.ts`; `backend/src/modules/accounts/accounts.exports.spec.ts`; `backend/src/modules/index.ts`; `backend/src/modules/modules.spec.ts`; `backend/test/db/accounts-service.db-spec.ts` | TC-55-14/15. Unit đỏ TS2305 chưa có AccountsModule; xanh unit6/DB32 tests tại a3c8851. Boundary dùng effective rule thật, không sửa eslint. | `npm test -- --runInBand --runTestsByPath src/modules/accounts/accounts.exports.spec.ts src/modules/modules.spec.ts`; DB P1; `npm run lint:check`; `npm run typecheck` | `feat(accounts): expose and register accounts service` |
| P5 · Driver và lỗi vận hành | `backend/test/manual/accounts-service.manual.ts`; `backend/test/support/accounts-service-probe.ts` | Dùng TC-55-01…15 đã xanh; M-55-01…05. Artifact assertion đỏ exit 1 rồi xanh exit 0; unsupported-mode assertion exit 1 trước DB; manual `all` trên f1d7a5f đạt M01–05, exit 0; M06 chưa chạy như G1. | Lệnh Git Bash §5 với `all`, `pipefail`; transcript có SHA code cuối và không token/URL | `078fbca`; `f1d7a5f` |
| P6 · Docs, đối chiếu và evidence | Các path chính xác ở bảng inventory dưới; không thêm path khác | TC01–15 đạt, manual M01–05 đạt/M06 chờ; đủ bốn ảnh thật. Full checks đã chạy, E2E còn 1 lỗi inherited; người dùng giữ phạm vi cũ, ghi BL-054/056. Kết quả chi tiết §8. | Full checks, manual, render Mermaid; `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs`; `git diff --check` | `docs(accounts): record service verification and handoffs` (chờ commit local) |

Không tách abstraction production mới ngoài service/types/module/index. Helper P1 phục vụ cả DB spec và manual driver để giữ cùng fixture0/cleanup/invariant SQL; assertions từng case vẫn ở spec/driver. Tranh chấp dùng QueryRunner trực tiếp, không TransactionService retry; money probes chỉ gọi service và rollback trước invariant. Không sửa migration, `TransactionService`, `@common/money`, filter, config hoặc package/lockfile; nếu thiếu khả năng trong inventory thì xin gate phụ trước khi sửa.

### Inventory P6: tài liệu và output

| Path chính xác | Việc làm |
|---|---|
| `backend/src/modules/accounts/README.md` | Chữ ký/contract thật, transaction precondition, owner404, hạn chế caller ledger |
| `docs/components/accounts/01-concept-brief.md` | Tình trạng primitive đã kiểm; không nhận hoàn thành endpoint/UC |
| `docs/features/README.md` | Thêm hàng DBS-55, link hồ sơ |
| `docs/BACKLOG.md` | Thêm nguồn DBS-55 vào các gap audit/producer/manual E2E đã có, không tạo duplicate; giữ BL-008/019 và handoff ngoài scope. Dành **BL-057** cho DoD6 DBS-55 (**BL-053** thuộc DBS-57), kiểm lại ID trống khi thực thi nếu base đổi; không xóa gap chưa giải quyết |
| `docs/features/DBS-55-accounts-service.md` | Điền đỏ/xanh thật §7, kết quả/TC/manual/handoff §8, docs §9; status chỉ đổi theo gate |
| `docs/features/screenshots/DBS-55/domain-review-round-1.md`; `docs/features/screenshots/DBS-55/domain-review.md` | Giữ nguyên phản hồi reviewer đã có; không viết lại verdict |
| `docs/features/screenshots/DBS-55/tdd-red-green.txt`; `docs/features/screenshots/DBS-55/verification.txt` | Output thật của red/green và final checks, đã redact; số suite/test/skipped/exit rõ |
| `docs/features/screenshots/DBS-55/manual-test.txt` | Raw output §5, dòng đầu SHA code cuối; lỗi driver không bị tee che |
| `docs/features/screenshots/DBS-55/01-ownership.png`; `docs/features/screenshots/DBS-55/02-lock-order.png`; `docs/features/screenshots/DBS-55/03-money-rollback.png`; `docs/features/screenshots/DBS-55/04-rejections-invariants.png` | Ảnh chụp output manual thật; thiếu ảnh nêu đúng tên ở G4 để người dùng quyết định |

Không glob ngầm cho phép thêm file; `node_modules`, `dist` và output compiler/cache ignored là artifact local, không giao cùng source. Không tạo `.env`/ghi secrets. Chỉ sử dụng dependency đã khóa; cần production dependency mới phải hỏi riêng. Mermaid CLI tạm để kiểm tài liệu là công cụ ngoài project, không thêm vào manifest/lockfile.

### Plan sweep: DoD, case và giới hạn

| Yêu cầu/giới hạn đã nêu §1–6 | Bước bao phủ hoặc bàn giao ngoài phạm vi |
|---|---|
| DoD1, thứ tự SQL và khóa thật, duplicate/empty/missing/status/SYSTEM | P1: TC01/02/03, M02; no retry/sleep, guard trước empty |
| DoD2: caller tx, rollback, atomic bigint update, khách không âm/SYSTEM âm/overflow/missing/invalid | P1–P2: TC04…10/13, M03/04; SQLSTATE/CHECK thật, tuple shape được kiểm |
| DoD3: internal user, same404, injection/null, không PII/existence | P3: TC11/12, M01/04; mapping Cognito sub thuộc identity caller |
| DoD4: public exports, Nest/role registration, chặn deep import | P4: TC14/15; không luật lint tiền mới |
| DoD5: string/bigint, >2^53, không Redis balance | P2/P4: TC05/06/08/09/15; SUT chỉ DataSource, không HTTP/SQS/Redis side effect |
| DoD6: CI xanh/Dev review/PR merge/bảng TC | P6 chuẩn bị bảng/evidence và backlog; remote CI/review/merge chưa làm, không tự push/PR/merge |
| Toàn bộ TC01…15 và M01…06 | P1:01–04/13; P2:04–10/13; P3:11–12; P4:14–15; P5:M01–05; P6:M06 **chưa chạy**, bàn giao |
| Chưa có caller ledger/deposit/transfer; thiếu double-entry/full AC5.8/5.9; BL-002/003 | P6 ghi handoff DBS-60/61; không stub ledger/guard, không sửa event; M06 chờ task thật |
| DENIED/REJECTED audit, AuditService, production grants; BL-019 | P6 thêm nguồn/bàn giao; không tự ghi audit rời hoặc nhận full AC8.x |
| BL-008 tiền lint; BL-015 timing; BL-016 CI Testcontainers path; BL-017 roles | Giữ ngoài scope ở P6; task này chỉ luật import có sẵn, local PostgreSQL proof không thay CI/role proof |
| Chưa có DBS-69 invariant script; không SQL seed tiền/entries | P1/P5 helper SQL inline, seed metadata0; money rollback rồi M05/4 checks; không claim intermediate probe là ledger hợp lệ |
| Auth/role/revocation/idempotency/endpoint/DTO; filter correlationId/PII; TLS/cloud/load | Không surface mới; P3 giữ lỗi safe, P6 nêu inherited config/HTTP/cloud chưa xác minh; chuyển task identity/ledger/Ops |
| Không schema/ADR/event/ErrorCode/env/dependency mới; no transaction retry riêng | P0/P1–P4 giữ giới hạn; bất kỳ lệch hoặc file ngoài inventory cần gate phụ |
| Success/error/recovery manual, exit propagation, cleanup, transcript UTF-8/redaction/4 ảnh | P5/P6, M01–05, §5 đã được review lại APPROVE; thiếu evidence phải liệt kê ở G4 |
| Mermaid phải render theo docs-style | P6: đã trích nguyên diagram §3 ra thư mục tạm ngoài repo, render bằng Mermaid CLI12 và Chrome, mở ảnh xác nhận. Không đổi diagram đã duyệt hoặc thêm dependency project; output ngoài repo |

**Kết quả sweep:** 6/6 DoD có row; TC01…15 và M01…06 đều có bước hoặc handoff; chưa loại case nào. Giới hạn đều có dòng ở trên, không nhận phần chưa chạy là đạt. Runtime và bằng chứng thực tế được ghi tại §8; CI/review/merge và M06 vẫn chưa hoàn tất.

### Final verification, rủi ro và cách lùi

Sau P1–P5, chạy lần lượt tại `backend/`: `npm run lint:check`; `npm run typecheck`; `npm test -- --runInBand`; `npm run test:e2e -- --runInBand`; `npm run test:db -- --runInBand`; `npm run build`. E2e dùng PostgreSQL Compose đã kiểm, DB suite dùng helper thật; `npm ci` riêng từng worktree, DB suites hai nhánh chạy tuần tự để tránh contention. Ghi số đếm/skipped và output thật. Sau mọi sửa code/test cần thiết, lặp kiểm tra liên quan rồi final checks, commit code được phép, chạy **toàn bộ §5 trên SHA code cuối**; thay code sau manual phải chạy lại cả §5. Docs/evidence commit sau đó không đổi SHA code được ghi. P6 còn phải render Mermaid ngoài repo, link check và diff check. Nếu chưa có ủy quyền commit local, không bịa SHA cho working tree; ghi hạn chế và chờ quyết định trước bàn giao chuẩn final-commit.

- Nguy cơ pool/barrier treo: deadline/timeouts, observer riêng và finally cleanup; lỗi phải fail, không rerun để xanh. Môi trường Docker đang chạy chỉ xác nhận/khởi service cần thiết, không reset/xóa volume.
- Probe tiền có thể phá invariant nếu commit: driver/test không có nhánh commit money, cleanup rollback; chỉ metadata0/lock-only transaction được commit. Không SQL sửa balance/entries để phục hồi.
- `modules/index.ts`, `modules.spec.ts`, feature index và BACKLOG có thể cùng thay đổi ở nhánh DBS-57. Hai nhánh triển khai độc lập; tích hợp sau bằng kiểm diff và giải conflict nhỏ có kiểm lại wiring/test; chưa cherry-pick/rebase/gộp nhánh lúc này. Không ghi đè tài liệu/ID backlog của task kia.
- Commit local chỉ sau G3 kèm ủy quyền: stage đúng allowlist từng bước, kiểm staged paths và commit tree không chứa workbook Jira hoặc mọi biến thể `.xls`/`.xlsx`; không `git add .`, không `--no-verify`, không commit secrets. Giữ artifact local được bảo vệ.
- Thay đổi additive: lùi bằng revert các commit source/wiring đã được ủy quyền, giữ dữ liệu DB; không migration down, không reset hard/clean hoặc xóa branch. Feature docs/backlog điều chỉnh theo trạng thái lùi.

**Quyết định G3:** Người dùng trả lời «Duyệt G3» ngày 2026-10-27 cho kế hoạch đã trình, gồm quyền commit local sau bước xanh. Bắt đầu triển khai TDD; push/PR/board/merge vẫn chưa được phép.

## 8. Kết quả

**Quyết định G4 và xuất bản:** Người dùng trả lời «duyệt G4» ngày 2026-10-28 cho DBS-55 và DBS-57, sau thông điệp bàn giao nêu rõ giới hạn kiểm thử và đề xuất push hai nhánh, tạo hai Draft PR. Bàn giao DBS-55 được chấp nhận với **M-55-06 chưa chạy** (chờ DBS-60/61 và AuditService), E2E local còn một timeout logging (BL-056) và quan sát timing JWKS (BL-054). Nhánh đã push và [Draft PR #33](https://github.com/Lawliet119/digital-banking-simulator/pull/33) đã mở với bảng đối chiếu TC. Kết quả CI của HEAD hiện tại được theo dõi tại [Checks của PR](https://github.com/Lawliet119/digital-banking-simulator/pull/33/checks); Dev review và merge chưa hoàn tất, giữ BL-057. Agent không sửa board hoặc tự merge.

**Đồng bộ upstream trước xuất bản:** nhánh đã nhận `origin/main` `b8742a3` (DBS-41) bằng merge, giữ workflow và bằng chứng CI của task đó. BL-016 đã được [DBS-41](DBS-41-testcontainers-ci.md) giải quyết trên upstream; không còn là handoff pending. BL-052 trên upstream thuộc DBS-41, nên process-gap DBS-55 đổi sang **BL-057**, không đổi phạm vi hoặc yêu cầu review/CI/merge. Đồng bộ không sửa file TypeScript trong source/test; SHA cuối đổi code và manual vẫn là `f1d7a5f321d463231868c6ab2c8b450f675c8644`. Diff PR được đối chiếu với `origin/main`, không tính các file DBS-41 đã thuộc base.

### Implementation và mức bằng chứng

Code/driver đã có tại `f1d7a5f321d463231868c6ab2c8b450f675c8644`, đã được push trên nhánh của Draft PR #33; chưa merge hoặc sửa board. Public service dùng DataSource/EntityManager thật; không dependency, migration, event hoặc ErrorCode mới. TC task và manual primitive đạt; full E2E local còn một lỗi timeout trong test logging có sẵn, nên chưa nhận baseline local cuối xanh. [Verification](screenshots/DBS-55/verification.txt) giữ cả các lượt lỗi và kết quả cuối.

| Bước | Đỏ thật → xanh thật | Commit |
|---|---|---|
| P1 | TS2307 chưa có `@modules/accounts` → DB 1 suite/5 tests đạt | `65a4541` |
| P2 | TS2339 chưa có apply; review tái hiện 4 failures/15 pass (sparse array, SET cleanup, hai allocation-cleanup probes) → DB 1/19 đạt sau sửa | `ba12e32` |
| P3 | TS2339 chưa có owned → DB 1/31 đạt, gồm Cognito sub UUID khác internal id | `078093a` |
| P4 | Unit TS2305 chưa export AccountsModule → unit 2/6 và DB 1/32 đạt. Không lặp DB compile-red cùng nguyên nhân; real Nest/PG case vẫn chạy xanh | `a3c8851` |
| P5 | Node assert driver chưa tồn tại exit1 → artifact tồn tại exit0; unsupported-mode assertion exit1 đúng trước DB. Manual `all` cuối exit0, M01–05 đạt; M06 chưa chạy | `078fbca`; `f1d7a5f` |

Các lượt DB tuần tự theo token root; targeted DB **32 tests**, unit chọn lọc **6 tests**, không skipped; full checks cuối có số đếm ở bảng dưới. Raw TDD/verification giữ cả lỗi và lần sửa. Review implementation đã sửa sparse UUID array bằng Array.from, setup/teardown quản lý runner trong outer try và giữ lỗi gốc khi cleanup thất bại; không đổi thiết kế hoặc file ngoài §7.

Review cuối còn xác minh Nest mặc định `abortOnError=true`; installed `nest-factory.js:107` chọn teardown mặc định, `errors/exceptions-zone.js:6` gọi `process.exit(1)`, có thể bỏ qua fixture finally khi DI/init lỗi. Commit `f1d7a5f` đặt `abortOnError:false` cho manual context để lỗi reject vào cleanup. Typecheck/lint exit0 và unsupported-mode assertion vẫn exit1 trước DB. Đây là source verification của failure-control fix, không nhận đã diễn tập DI failure thật; final manual dùng code SHA mới.

### Đối chiếu test case

| ID | Test hiện có | Trạng thái từ targeted và full run cuối |
|---|---|---|
| TC-55-01 | `test/db/accounts-service.db-spec.ts` › sorted/unique/subset/status/SYSTEM/uppercase snapshot | Đạt |
| TC-55-02 | Cùng file › holder-low/subject/probe-high NOWAIT | Đạt, thứ tự lấy khóa thật |
| TC-55-03 | Cùng file › opposing transactions; barriers/pg_blocking_pids | Đạt, không retry |
| TC-55-04 | Cùng file › active/released manager và failure cleanup thực của runner | Đạt; failure được chèn ở lifecycle, tiền không mock |
| TC-55-05 | Cùng file › caller visibility và rollback balance/updated_at | Đạt |
| TC-55-06 | Cùng file › >2^53, JSON string, zero delta, SQL parameters | Đạt |
| TC-55-07 | Cùng file › customer CHECK23514 + constraint | Đạt |
| TC-55-08 | Cùng file › funding/customer signed bounds, paired probes rollback | Đạt |
| TC-55-09 | Cùng file › customer/funding overflow và hai delta ngoài signed64 | Đạt, 4 scenarios22003 |
| TC-55-10 | Cùng file › missing update404/raw UPDATE tuple | Đạt |
| TC-55-11 | Cùng file › owner/same404/committed-state read, không PII | Đạt |
| TC-55-12 | Cùng file › 8 malformed pairs và valid Cognito sub UUID | Đạt |
| TC-55-13 | Cùng file › hostile/invalid/sparse/mixed-hole ids, non-bigint, trace parameters | Đạt |
| TC-55-14 | `src/modules/accounts/accounts.exports.spec.ts` › effective ESLint boundary; typecheck public surface | Đạt |
| TC-55-15 | DB spec › real AccountsModule/provider/PG; `src/modules/modules.spec.ts` › api/both/worker registry | Đạt |
| DoD6 quy trình | Draft PR #33 và bảng TC đã có; remote CI theo Checks, Dev review và PR merge | Dev review/merge chưa hoàn tất; CI xem HEAD hiện tại tại Checks; BL-057 |

### Kiểm tra cuối và lỗi ngoài phạm vi

Các lệnh dưới chạy tại `backend/`, trên code SHA `f1d7a5f321d463231868c6ab2c8b450f675c8644`; số đếm/output thô ở [verification.txt](screenshots/DBS-55/verification.txt).

| Lệnh | Kết quả |
|---|---|
| `npm run lint:check` | Exit 0 |
| `npm run typecheck` | Exit 0 |
| `npm test -- --runInBand` | Lượt cuối tuần tự: 31/31 suites, 497/497 tests đạt, 0 skipped, exit 0. Lượt trước khi chạy cùng DB: 30/31 suites, 495/497 tests đạt, hai lỗi cooldown JWKS; giữ BL-054, không nhận đã sửa flaky |
| `npm run test:db -- --runInBand` | 9/9 suites, 186/186 tests đạt, 0 skipped, PostgreSQL 17 thật, exit 0 |
| `npm run test:e2e -- --runInBand` | **Chưa xanh:** 7/8 suites, 56/57 tests đạt, 0 skipped, exit 1; TC-42-11 worker DB failure trong `test/logging-bootstrap.e2e-spec.ts` bị `spawnSync ETIMEDOUT` ở deadline 25 giây |
| `npm run build` | Exit 0 |
| Mermaid §3 | Mermaid CLI 12 và Chrome render diagram nguyên bản ngoài repo, đã mở kiểm ảnh |
| Link checker và diff whitespace | `check-doc-links.mjs`: 136 files checked, 0 broken link(s); `git diff --check`: exit 0 |

Diagnostic riêng cho TC-42-11 giữ fixture gốc, chỉ tăng deadline của launcher ngoài repo lên 60 giây: child exit 1 sau 10409 ms; startup-failed tại 10372 ms với ECONNREFUSED, năm lần kết nối cách nhau khoảng 2 giây; không treo trong lượt này. Output đã phân loại an toàn và kiểm không lộ fixture nhạy cảm. Đây là bằng chứng chẩn đoán, **không** chứng minh đã khắc phục timeout của full E2E; BL-056 vẫn mở.

Hai test JWKS tạo/sign RSA sau lần fetch nhưng giả định còn trong cooldown 200 ms; sự phụ thuộc thời gian/tải đã được ghi BL-054. Ngày 2026-10-28, sau đề nghị gate phụ sửa hai file test inherited JWKS/logging trên cả hai nhánh, người dùng chọn **«Giữ phạm vi cũ, ghi rõ lỗi/hạn chế»**. Vì vậy không sửa các file ngoài §7, không tăng timeout trong source hoặc nhận full baseline đã xanh. Đây là quyết định giữ nguyên phạm vi, không phải miễn yêu cầu báo lỗi.

### Test thủ công và ảnh

Dòng đầu [manual-test.txt](screenshots/DBS-55/manual-test.txt) là SHA `f1d7a5f321d463231868c6ab2c8b450f675c8644`. Chạy Git Bash tại `backend/` với DATABASE_URL cấp ngoài transcript, `set -euo pipefail`, rồi `npx cross-env NODE_ENV=test ts-node -r tsconfig-paths/register test/manual/accounts-service.manual.ts all 2>&1 | tee -a ../docs/features/screenshots/DBS-55/manual-test.txt`. Driver đã await đóng fixture của lượt chạy và exit 0; SQL seed chỉ metadata và accounts balance mặc định 0. Kiểm server Compose sau manual thấy 6 DB tạm chưa xác định nguồn, có thể từ lượt trước; đã ghi truy vấn và giới hạn trong verification, giữ nguyên chúng. Không nhận toàn server đã sạch hoặc quy các DB đó cho fixture cuối.

| Bước | Lệnh/nguồn và phản hồi thật rút gọn | Kết quả |
|---|---|---|
| M-55-01 | Driver `all` › OWNED balance `"0"`; FOREIGN/MISSING/SYSTEM/COGNITO_SUB_IS_NOT_USER_ID đều 404 | Đạt |
| M-55-02 | Cùng lệnh › LOCK_ORDER holderPid=904/subjectPid=906, highAvailable=true; CROSSED_LOCKS completed=2/retries=0 | Đạt, khóa thật và không retry |
| M-55-03 | Cùng lệnh › tentative ±300000 và ±9007199254740993 dạng chuỗi; COMMITTED_OBSERVER và AFTER_ROLLBACK mọi balance `"0"` | Đạt, không commit probe tiền |
| M-55-04 | Cùng lệnh › khách âm: 23514 + accounts_balance_non_negative; overflow: 22003; inactive/hostile/sparse/number bị từ chối; RECOVERED balance `"0"` | Đạt, rejection và phục hồi |
| M-55-05 | Cùng lệnh › entriesEqual/totalZero/customersNonnegative/balancesMatchEntries đều true sau rollback | Đạt trong fixture 0, không nhận double-entry trong lúc probe |
| M-55-06 | Driver báo PENDING, dependencies DBS-60/DBS-61/AuditService; chưa có luồng HTTP/ledger/audit thật để chạy | **Chưa chạy**, đã được chấp nhận đích danh trong bàn giao G4 |

Bốn ảnh dưới chụp bằng CUA từ trang local hiển thị nguyên output transcript, chỉ wrap dòng để đọc; dữ liệu lấy từ manual thật. CUA trả JPEG và được serialize thành PNG, không thay đổi nội dung ngữ nghĩa. Đây là viewer của raw output, không phải ảnh terminal hoặc Swagger. Transcript không chứa URL DB, token, Authorization, password, AWS account ID hoặc ARN.

![M-55-01: quyền sở hữu và cùng404](screenshots/DBS-55/01-ownership.png)

![M-55-02: thứ tự khóa và hai transaction chéo](screenshots/DBS-55/02-lock-order.png)

![M-55-03: tiền dạng chuỗi và rollback](screenshots/DBS-55/03-money-rollback.png)

![M-55-04/05: từ chối, phục hồi và invariant sau rollback](screenshots/DBS-55/04-rejections-invariants.png)

### Bàn giao và phạm vi

| Backlog | Bàn giao |
|---|---|
| BL-002/003 | Dev DBS-60/61 nhận primitive; thêm ledger/deposit/transfer flow, event/guard và E2E M-55-06 |
| BL-019 | Dev audit/security nhận DENIED/REJECTED audit và production permission proof |
| BL-008 | Dev nền tảng bổ sung luật lint tiền chuyên biệt; task này giữ string/bigint và chỉ kiểm luật import hiện có |
| BL-015/017 | Dev harness/Ops xử lý timing và production-role evidence; local run không đóng các gap này |
| BL-057 | Theo dõi CI theo HEAD tại Checks của Draft PR #33; Dev reviewer và người quản lý repo hoàn thành review độc lập và merge; bảng TC đã có trong PR |
| BL-054 | Dev identity/test harness xử lý hai test JWKS phụ thuộc cửa sổ cooldown/tải; lượt unit tuần tự xanh không đóng gap |
| BL-056 | Dev logging/test harness điều tra TC-42-11 subprocess timeout trong full E2E; diagnostic standalone không thay bằng chứng suite |

Đã thêm nguồn DBS-55 vào các gap tồn tại, không tạo duplicate hoặc xóa backlog chưa giải quyết. Sau commit docs/evidence `d731a48`, `git diff --stat main...HEAD` có đúng 24 file source/test/docs/evidence, khớp inventory §7; working tree sạch. Không sửa hai test inherited ngoài scope theo quyết định người dùng. Staged paths, commit tree và lịch sử nhánh đã kiểm không có workbook `.xls`/`.xlsx` hoặc `.env`.

## 9. Tài liệu đã cập nhật

- `backend/src/modules/accounts/README.md`: chữ ký, transaction/ownership/bigint contract và phần API chưa có.
- `docs/components/accounts/01-concept-brief.md`: phân biệt primitive đã kiểm với full use case còn chờ.
- `docs/features/README.md`: thêm DBS-55, chuyển Implemented sau G4; liên kết Draft PR #33, CI theo Checks, Dev review/merge chưa hoàn tất và các hạn chế local.
- `docs/BACKLOG.md`: giữ nguồn DBS-55 ở BL-002/003/008/015/017/019 và các gap BL-054/056; process-gap DBS-55 là BL-057. Đồng bộ upstream DBS-41 đã xóa BL-016; DBS-55 không tự nhận đã giải quyết gap này. Giữ nguyên BL-052 của DBS-41.
- Feature doc, hai domain-review files giữ nguyên, TDD/verification/manual transcript và bốn ảnh output thật đã đủ trong inventory, đã commit và push lên nhánh của Draft PR #33. CI theo Checks của PR; Dev review/merge chưa hoàn tất, không sửa board.

## Checklist G4 (người dùng đã duyệt ngày 2026-10-28)

- [x] TC-55-01…15 đạt đủ độ sâu; 0 ca đơn giản hóa; DoD6 quy trình chưa đạt ghi BL-057
- [x] Manual trên SHA code cuối có ở dòng đầu transcript: M01–05 đạt, đường thành công đã chạy; **M-55-06 chưa chạy**, người dùng đã chấp nhận trong bàn giao G4
- [x] Đủ bốn ảnh tên đã duyệt từ output thật; transcript không có token, Authorization, password, AWS account ID/ARN
- [x] Diff PR so với `origin/main` sau đồng bộ upstream: 24 file khớp §7, không có thay đổi code/test do merge hoặc workbook được bảo vệ
- [x] Sáu lệnh kiểm tra đã chạy và có số đếm; **E2E còn 1 lỗi/57 tests**, không nhận baseline xanh; unit từng có hai lỗi JWKS được giữ trong bằng chứng
- [x] Mọi fact thay đổi đã cập nhật; link checker 136 files/0 broken links, diff whitespace sạch; status chuyển Implemented sau khi G4 được duyệt
- [x] Bàn giao/DoD chưa đạt ghi §8 và BACKLOG, gồm BL-057/054/056; không có backlog đã giải quyết cần xóa

## Vòng 2 · Sửa sau review PR #33

> **Status vòng 2:** Plan approved (sau G3) · **Nguồn:** review code PR #33 ngày 2026-10-31, các phát hiện chấm 2 điểm trở lên trên thang "mức độ phải audit lại" (1–5) · **Nhánh:** `feat/DBS-55-accounts-service` (sửa trực tiếp theo yêu cầu người dùng) · **Cập nhật:** 2026-10-31

### R1. Bối cảnh

**Phạm vi:** chín phát hiện, đánh số theo báo cáo review. Phát hiện 4 điểm (R-2) phải chạy đủ chuẩn skill. Các mục khác cũng qua cùng các gate, vì CLAUDE.md yêu cầu gate cho mọi thay đổi file.

| ID | Điểm | Vị trí | Vấn đề | Hướng sửa đề xuất |
|---|---|---|---|---|
| R-2 | 4 | `accounts.service.ts:35` | 404 phụ thuộc tuple `[rows, rowCount]` của TypeORM; nếu tuple đổi dạng thì `affected` là `undefined`, account thiếu bị coi là thành công | Xét `rows.length === 0` từ `RETURNING id`, không đọc `rowCount` |
| R-1 | 3 | `accounts.service.ts:41` | `updated_at=now()` là thời điểm bắt đầu transaction, có thể đi lùi khi tranh chấp khóa | `clock_timestamp()`, giống lý do ở migration `CreateTransfersLedgerIdempotency` |
| R-3 | 3 | `accounts.service.ts:38` | Lỗi 23514/22003 lọt ra thành `QueryFailedError` thô; `applyBalanceChange` không kiểm tra caller đã khóa hàng | Lỗi miền có kiểu (không thêm `ErrorCode`); bắt buộc đã `lockForUpdate` trong cùng QueryRunner |
| R-7 | 3 | `accounts-service.db-spec.ts` | Mã TC trùng: TC-55-04 ×4, TC-55-11 ×3, TC-55-12 ×2 | Tách mã con (TC-55-04a…), cập nhật §4/§8 và PR |
| R-4 | 2 | `accounts.service.ts:18` | `lockForUpdate` không giới hạn số ID | Chặn trên số ID sau khi bỏ trùng |
| R-5 | 2 | `accounts.exports.spec.ts:5` | `execFileSync` chặn event loop, phụ thuộc `cwd` | `execFile` bất đồng bộ, có timeout, `cwd` tính từ `__dirname` |
| R-6 | 2 | `accounts-service-probe.ts:150` | `pollDatabase` lặp `setImmediate` không nghỉ | Nghỉ 10–20 ms giữa các lần poll |
| R-M | 2 | `modules/index.ts:21` | `AccountsModule` chỉ ở `apiModules`; worker cần `AccountsService` sẽ lỗi DI | Câu hỏi G1 #3 |
| — | 1 | `account.types.ts:13`, `README.md:28-29` | Alias `LockedAccount`; "trả404" | Ngoài phạm vi (điểm 1); typo "trả404" sửa kèm khi đụng README cho R-3 |

**Baseline 2026-10-31** trên `a9ed90a` (đầu nhánh PR): `lint:check` exit 0; `typecheck` exit 0; unit 31 suites/497 tests đạt; DB 9 suites/186 tests đạt (Testcontainers PostgreSQL 17); E2E 8 suites/57 tests đạt, 0 skipped. Máy này có dịch vụ PostgreSQL 18 native (`postgresql-x64-18`) chiếm cổng 5432, nên `localhost:5432` của compose trả `28P01`. E2E chạy trên một container `postgres:17` tạm ở cổng 55432 (đã migrate, đã xóa sau khi chạy), `DATABASE_URL` trỏ tới đó, theo `manual-testing.md`. Lỗi BL-056 không tái hiện trong lượt này, BL-056 vẫn mở.

**Người gọi các symbol bị đổi:** `lockForUpdate`, `applyBalanceChange`, `getOwnedAccount` chỉ được gọi trong `test/db/accounts-service.db-spec.ts`, `test/support/accounts-service-probe.ts`, `test/manual/accounts-service.manual.ts`. Chưa có caller production (DBS-60/61 chưa bắt đầu).

**Ngoài phạm vi:** BL-054/056 (test inherited), M-55-06 (chờ DBS-60/61), alias `LockedAccount` (điểm 1), map lỗi ra HTTP `errorCode` (việc của DBS-60/61).

**Câu hỏi mở:** xem tin nhắn G1.

**Quyết định ở G1 (vòng 2):** người dùng trả lời «duyet» ngày 2026-10-31, chấp nhận cả sáu đề xuất: (1) lỗi miền có kiểu, không thêm `ErrorCode`; (2) bắt buộc đã khóa trong cùng QueryRunner; (3) ngưỡng 16 ID; (4) giữ `AccountsModule` ở `apiModules`, chỉ sửa comment; (5) merge `main` để gỡ xung đột BACKLOG; (6) push thường lên nhánh PR, không force.

### R2. Hành vi thay đổi

Không có API HTTP. Những gì không ghi ở đây giữ nguyên như §2.

| Hành vi | Trước | Sau |
|---|---|---|
| R-2 · `applyBalanceChange` không cập nhật hàng nào | 404 nếu `rowCount === 0` (phần tử 2 của tuple) | Kết quả không có dạng `[rows[], number]` → `Error('Unexpected UPDATE result shape')`. Mảng `RETURNING id` rỗng → `AccountNotLockedError`: id đã qua kiểm tra khóa thì hàng chắc chắn tồn tại, nên rỗng chỉ có thể do transaction đã khác lúc khóa, tức là lỗi giao thức của caller. **`applyBalanceChange` không còn ném 404**, để bug nội bộ không ra client thành 404 (review v2 #2). Không bao giờ coi là thành công |
| R-1 · `updated_at` khi đổi số dư | `now()` (giờ bắt đầu transaction) | `clock_timestamp()` (giờ ghi hàng). Transaction bắt đầu sớm nhưng chờ khóa rồi commit sau vẫn có `updated_at` lớn hơn transaction commit trước |
| R-3a · khách xuống âm (23514 **và** constraint đúng là `accounts_balance_non_negative`) | `QueryFailedError` thô | `AccountBalanceNegativeError` (`accountId`, `cause` = lỗi gốc). Transaction đã bị PostgreSQL hủy; caller để `TransactionService` rollback. 23514 của constraint khác ném nguyên |
| R-3a · tràn signed bigint (22003) | `QueryFailedError` thô | `AccountBalanceOverflowError` (`accountId`, `cause`) |
| R-3a · lỗi DB khác (40P01, 57014, …) | ném nguyên | Ném nguyên, không bọc, để `isRetryableTransactionError` / `isTransientDbError` vẫn đọc `code` |
| R-3b · đổi số dư account chưa khóa | chạy UPDATE | `AccountNotLockedError` trước SQL. "Đã khóa" = id nằm trong kết quả `lockForUpdate` của **cùng QueryRunner, cùng transaction cấp ngoài cùng**. Khóa trên runner khác, id không tồn tại (không có trong snapshot), hay runner đã sang transaction mới đều bị từ chối |
| R-3c · gọi `lockForUpdate`/`applyBalanceChange` trong transaction lồng (savepoint của `manager.transaction`) | chạy | `Error('Account locks must be taken at the outermost transaction')` trước SQL. Lý do: `ROLLBACK TO SAVEPOINT` nhả khóa hàng lấy sau savepoint mà `pg_current_xact_id()` không đổi (review v2 #1). Khóa lấy ở cấp ngoài cùng sống tới hết transaction, kể cả khi savepoint về sau bị rollback. `SAVEPOINT` viết tay bằng SQL thì service không thấy được: README ghi là không hỗ trợ |
| R-4 · `lockForUpdate` nhận hơn 16 id sau khi bỏ trùng | khóa hết | `TypeError('At most 16 account ids can be locked at once')` trước SQL; đúng 16 id khác nhau vẫn chạy. Hai lớp chặn: mảng thô dài hơn 256 phần tử bị từ chối trước khi chuẩn hóa với `TypeError('At most 256 account id entries are accepted')` (review v2-2 #7); sau đó với từng phần tử: chuẩn hóa (kiểm UUID, đổi về chữ thường), rồi so với tập đã thấy, và dừng ngay khi id khác nhau thứ 17 xuất hiện (review v2 #11, v2-4 #2) |

Ba lớp lỗi mới là lỗi nội bộ module, export qua `@modules/accounts`, không phải `HttpException`, **không có `errorCode`**. Gặp chúng nghĩa là guard của caller có bug: guard của Ledger phải quyết định REJECTED (số dư, trạng thái, hạn mức) **trước** UPDATE, vì sau 23514 PostgreSQL đã hủy transaction nên không ghi được `transfers` REJECTED, audit hay response idempotency (BR-07). Vì vậy chúng **phải ra 500**, caller không map sang 422 (review v2 #3). `getErrorCode` vẫn đọc được SQLSTATE qua `cause`, nên chúng không bị coi là retryable hay transient.

Thay đổi test và harness, không đổi hành vi service:

| ID | Sau |
|---|---|
| R-5 | TC-55-14 dùng `execFile` bất đồng bộ (`promisify`), `timeout: 20000`, `cwd` = `backend/` tính từ `__dirname`; `it(..., 25_000)` lớn hơn timeout của child, vì Jest mặc định 5 s và nay timer của Jest chạy được (review v2-2 #2) |
| R-6 | `pollDatabase` nghỉ 15 ms giữa các lần thử (`setTimeout` của `node:timers/promises`), deadline 4 s giữ nguyên |
| R-7 | Mỗi `it` một mã riêng; ca trùng thành TC-55-04a…d, TC-55-11a…c, TC-55-12a/b. Một `it.each` giữ một mã cho cả bảng tham số |
| R-M | Comment `sharedModules` ghi rõ: module chỉ được module khác import (Accounts cho Ledger) thì không cần có trong danh sách role; Accounts ở `apiModules` để DI kiểm sớm ở `api` |

### R3. Kiến trúc

- **Vị trí:** `backend/src/modules/accounts/`, role `api`/`both`. Thêm `accounts.errors.ts`; sửa `accounts.service.ts`, `index.ts`, `README.md`, `modules/index.ts` (comment). Test và harness: `test/db/accounts-service.db-spec.ts`, `test/support/accounts-service-probe.ts`, `test/manual/accounts-service.manual.ts`, `src/modules/accounts/accounts.exports.spec.ts`.
- **Cấp transaction:** TypeORM giữ `transactionDepth` ở dạng `protected`. Service đọc nó qua một hàm nhỏ có kiểm kiểu: không phải số thì fail closed (ném lỗi). Có một TC khóa hành vi này để lần nâng TypeORM nào đổi tên field sẽ đỏ ngay. Yêu cầu `depth === 1` cho cả hai method thay đổi.
- **Interface:** chữ ký ba method giữ nguyên. Export thêm `AccountBalanceNegativeError`, `AccountBalanceOverflowError`, `AccountNotLockedError` (đều `extends Error`, `readonly accountId: string`, `cause`).
- **Ghi nhận khóa:** `private readonly locks = new WeakMap<QueryRunner, { txid: string; ids: Set<string> }>()`. Câu `SELECT … FOR UPDATE` trả thêm `pg_current_xact_id()::text` (cùng một truy vấn; `FOR UPDATE` vốn đã cấp xid). Nếu txid khác lần ghi trước, set được làm mới. `applyBalanceChange` kiểm id trong set trước SQL, rồi UPDATE thêm điều kiện `AND pg_current_xact_id()::text=$3` với txid đã lưu. Runner được dùng lại cho transaction mới mà chưa khóa lại thì không hàng nào khớp, ra `AccountNotLockedError` (R-2). Như vậy vẫn đúng một truy vấn mỗi lần gọi, và dấu khóa không sống quá transaction đã lấy khóa. Trường `txid` bị bỏ khỏi snapshot trả cho caller, nên type `Account` không đổi. **Không có hàng** (input `[]` trả sớm trước SQL, hoặc mọi id đều không tồn tại) thì không đụng tới map: không tạo entry, không làm mới, không gộp (review v2-2 #5).
- **Retry:** `transaction.helper.ts:87` tạo QueryRunner mới mỗi lần thử, nên dấu khóa không mang sang lần thử sau.
- **Tài liệu:** `backend/src/modules/accounts/README.md` (hợp đồng mới, sửa "trả404"), `docs/BACKLOG.md` (một dòng BL mới cho bàn giao R7), feature doc, `docs/features/README.md`.
- **Dữ liệu:** chỉ `accounts.balance`, `accounts.updated_at`. Không migration, không đổi schema.
- **Ranh giới transaction:** của caller, như cũ. Không Redis/HTTP/SQS.
- **Thay đổi cấp hệ thống:** không có (ADR, `ErrorCode`, env, event, schema giữ nguyên).

```mermaid
sequenceDiagram
  participant L as Ledger (DBS-60/61)
  participant A as AccountsService
  participant P as PostgreSQL
  L->>A: lockForUpdate([src,dst], m)
  A->>P: SELECT …, pg_current_xact_id() ORDER BY id FOR UPDATE OF a
  A-->>A: locks[m.queryRunner] = {txid, {src,dst}}
  L->>A: applyBalanceChange(src, delta, m)
  Note over A: id chưa khóa → AccountNotLockedError, không SQL
  A->>P: UPDATE … updated_at=clock_timestamp() WHERE id=$1 AND pg_current_xact_id()::text=$3 RETURNING id
  P-->>A: 23514 (đúng constraint) → AccountBalanceNegativeError · 22003 → AccountBalanceOverflowError · [] → AccountNotLockedError
```

### R4. Test cases tự động (thêm hoặc đổi)

PostgreSQL 17 thật, `test/db/accounts-service.db-spec.ts`; riêng TC-55-14 là unit.

| ID | Truy vết | Given · When · Then | Lỗi mong đợi |
|---|---|---|---|
| TC-55-07 (đổi) | DoD2, R-3a | khách 0, đã khóa, −1n → lỗi có kiểu, `cause` giữ 23514 + constraint; `getErrorCode` = 23514, `isRetryableTransactionError` và `isTransientDbError` = false, `safeErrorMetadata` có `code` 23514 và không có SQL; rollback, invariants đạt | `AccountBalanceNegativeError` |
| TC-55-09 (đổi) | DoD2, R-3a | bốn scenario tràn; cùng các kiểm tra phân loại như TC-55-07 | `AccountBalanceOverflowError`, `cause.code` 22003 |
| TC-55-10 (đổi) | DoD2, R-2 | (a) runner rollback rồi `startTransaction` lại, apply id đã khóa ở transaction cũ → lỗi, số dư không đổi; (b) spy `manager.query` trả `[[], 1]` → lỗi; (c) trả `{ records: [] }` → `Error` shape | `AccountNotLockedError` / `Error` |
| TC-55-16 | DoD2, R-1 | **có tranh chấp:** T1 mở transaction trước; T2 khóa A; T1 gọi `lockForUpdate([A])` và bị chặn (xác nhận bằng `pg_blocking_pids`); T2 apply `0n` và commit; T1 nhận khóa, apply `0n`, commit → `updated_at` T1 > T2. Với code cũ (`now()`) T1 < T2, nên đây là test đỏ hợp lệ. Delta 0 nên invariants vẫn đạt | — |
| TC-55-17 | DoD2, R-3b | (a) apply khi chưa lock → lỗi, không truy vấn; (b) lock A trên runner X, apply A trên runner Y → lỗi; (c) lock [missing, A], apply missing → lỗi; (d) đã lock → chạy | `AccountNotLockedError` |
| TC-55-18 | DoD1, R-4 | 16 id khác nhau (4 fixture + 12 UUID không tồn tại) → chạy; 17 → lỗi, không truy vấn; 20 bản của 1 id → chạy; mảng 256 UUID chữ thường khác nhau bị từ chối với **đúng 17** lần gọi `normalizeId`, chứng minh dừng sớm. Spy đặt trên instance: `jest.spyOn(service as unknown as { normalizeId(v: unknown): string }, 'normalizeId')`, restore trong `finally` (review v2-4 #2); mảng 257 phần tử (dù trùng) bị từ chối với **0** lần chuẩn hóa; 256 bản của 1 id → chạy (review v2-3 #1) | `TypeError` (thông điệp 16 / 256) |
| TC-55-19 | R-3a | (a) spy UPDATE ném lỗi 40P01 → ném nguyên, `isRetryableTransactionError` = true; (b) spy ném 23514 với constraint khác → ném nguyên, không bọc | lỗi gốc |
| TC-55-20 | R-3c | (a) lock A trong `manager.transaction(...)` lồng → lỗi, không truy vấn; (b) lock A ở cấp ngoài, rồi apply A trong transaction lồng → lỗi; (c) runner không có `transactionDepth` dạng số (thay thuộc tính) → lỗi; (d) lock A ở cấp ngoài, chạy một `manager.transaction` lồng ném lỗi (ROLLBACK TO SAVEPOINT), rồi apply A ở cấp ngoài → chạy, và runner khác `FOR UPDATE NOWAIT` trên A nhận 55P03 (khóa vẫn giữ) | `Error` / — |
| TC-55-21 | R-3b | lock A ở tx1, rollback, `startTransaction` lại cùng runner (tx2), `lockForUpdate([missing])` (0 hàng), apply A → lỗi, số dư không đổi | `AccountNotLockedError` |
| TC-55-14 (đổi) | DoD4, R-5 | `execFile` bất đồng bộ, `cwd` của child lấy từ `__dirname`. Bằng chứng không phụ thuộc cwd của Jest: test `process.chdir` sang thư mục repo gốc trước khi chạy child và trả lại trong `finally`. Nếu `cwd` bị thừa kế thì child không resolve được `eslint` (repo gốc không có `node_modules`) nên test đỏ (review v2-3 #3, v2-4 #3). Test không dùng `test.concurrent`; timeout Jest (25 s) phải lớn hơn timeout của child (20 s) để `finally` luôn trả lại cwd. Jest chỉ chạy được từ `backend/`: ts-jest đọc `tsconfig.json` theo cwd, và mình đã kiểm rằng chạy từ `backend/src` thì suite lỗi. Vì vậy không nhận "chạy từ repo gốc" (review v2-2 #1) | lint diagnostic |
| TC-55-04a…d, 11a…c, 12a/b | R-7 | chỉ đổi tên, nội dung giữ nguyên | như cũ |

Thứ tự kiểm trong `applyBalanceChange`: transaction đang chạy → cấp ngoài cùng → id → delta → đã khóa → SQL. TC-55-04 và TC-55-13 vì vậy vẫn ra đúng lỗi cũ.

### R5. Test thủ công

Driver thật `test/manual/accounts-service.manual.ts all` (Nest context với `AccountsModule` thật), chạy lại toàn bộ trên commit cuối đổi code. `manual-test.txt` được ghi đè, SHA ở dòng đầu. Driver cần sửa `expectRejection` để nhận `type` là lớp lỗi mới, kiểm `cause.code`/`cause.constraint`, và in `name` của lỗi (review v2 #5).

**Môi trường trên máy này** (cổng 5432 là PostgreSQL 18 native, review v2 #4). Chạy tại `backend/`, Git Bash:

```bash
set -euo pipefail
docker rm -f dbs55-manual-pg >/dev/null 2>&1 || true
docker run -d --name dbs55-manual-pg -e POSTGRES_DB=banking -e POSTGRES_USER=banking \
  -e POSTGRES_PASSWORD=banking_local_only -p 55432:5432 postgres:17 >/dev/null
trap 'docker rm -f dbs55-manual-pg >/dev/null 2>&1' EXIT
# Đợi qua TCP: server init của image chỉ nghe Unix socket rồi khởi động lại.
for i in $(seq 1 60); do
  docker exec dbs55-manual-pg pg_isready -h 127.0.0.1 -p 5432 -U banking -d banking >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo 'PostgreSQL 17 không sẵn sàng sau 60 s'; exit 1; }
  sleep 1
done
export DATABASE_URL=postgres://banking:banking_local_only@127.0.0.1:55432/banking   # không ghi vào transcript
OUT=../docs/features/screenshots/DBS-55/manual-test.txt
git rev-parse HEAD > "$OUT"
docker exec dbs55-manual-pg psql -h 127.0.0.1 -U banking -d banking -tAc 'SHOW server_version' | tee -a "$OUT"   # phải bắt đầu bằng 17
npx cross-env NODE_ENV=test ts-node -r tsconfig-paths/register test/manual/accounts-service.manual.ts all 2>&1 | tee -a "$OUT"
```

Driver tự tạo DB tạm từ `DATABASE_URL`, migrate rồi xóa trong `finally`. `trap … EXIT` xóa container kể cả khi driver lỗi (review v2-2 #3).

| Bước | Việc làm | Mong đợi |
|---|---|---|
| M-55-00 | `SHOW server_version` | bắt đầu bằng `17.` |
| M-55-01…03, 05 | như §5 | như §5 |
| M-55-04 (đổi) | khách −1; tràn | in `name` `AccountBalanceNegativeError` + `cause` 23514/`accounts_balance_non_negative`; `AccountBalanceOverflowError` + 22003 |
| M-55-07 | apply khi chưa lock; lock runner X rồi apply runner Y; lock trong transaction lồng; 17 id; đọc lại số dư | `AccountNotLockedError` ×2, `Error` (cấp ngoài cùng), `TypeError`; số dư 0 |
| M-55-08 | như TC-55-16: T1 bắt đầu trước, bị T2 chặn (in PID bị chặn), T2 commit `0n`, T1 commit `0n`; in hai `updated_at` | T1 > T2; số dư vẫn 0, invariants đạt |
| M-55-06 | — | **Chưa chạy**, chờ DBS-60/61 như vòng 1 |

Ảnh: chụp lại bốn ảnh từ output mới, thêm `05-lock-required.png`, `06-updated-at-order.png`.

### R6. Domain review (AI)

**Reviewer:** subagent mới, model Opus 5.5 (`claude-opus-5-5`), ngày 2026-10-31 · **Lượt 1:** 12 phát hiện (blocking 0, should-fix 5, minor 7), verdict REVISE · [nguyên văn lượt 1](screenshots/DBS-55/domain-review-v2-round-1.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | `pg_current_xact_id()` không đổi qua savepoint; `ROLLBACK TO SAVEPOINT` nhả khóa mà dấu khóa còn | đã sửa R2 (R-3c), R3, TC-55-20: bắt buộc cấp ngoài cùng (`transactionDepth === 1`) |
| 2 | should-fix | 404 trở thành lỗi giao thức nội bộ nhưng ra client thành 404 | đã sửa R2 (R-2), R3, TC-55-10: ném `AccountNotLockedError`, bỏ 404 khỏi `applyBalanceChange` |
| 3 | should-fix | Map lỗi số dư âm sang 422 vi phạm BR-07; BL-002/003 không đúng chủ đề | đã sửa R2: lỗi mới phải ra 500, guard quyết định trước; bỏ tham chiếu BL-002/003; bàn giao ở §8 vòng 2 |
| 4 | should-fix | Script manual không chạy được nguyên văn trên máy có PG18 ở 5432 | đã sửa R5: lệnh dựng PG17 ở 55432, M-55-00 kiểm phiên bản |
| 5 | should-fix | `expectRejection` của driver không kiểm được lỗi bọc; R3 thiếu file test | đã sửa R3 (Vị trí), R5 |
| 6 | minor | Bọc 23514 phải kiểm tên constraint | đã sửa R2, TC-55-19(b) |
| 7 | minor | Chưa có ca khóa việc phân loại lỗi bọc | đã sửa TC-55-07/09 |
| 8 | minor | TC-55-16 tuần tự, chưa có tranh chấp khóa | đã sửa TC-55-16, M-55-08: có chặn thật qua `pg_blocking_pids` |
| 9 | minor | Lệnh chạy Jest từ repo gốc sai | đã sửa TC-55-14 |
| 10 | minor | TC-55-04 có 4 ca, không phải 5 | đã sửa R2/R4: a…d |
| 11 | minor | Ngưỡng 16 kiểm sau khi chuẩn hóa cả mảng | đã sửa R2 (R-4), TC-55-18 |
| 12 | minor (bàn giao) | Ledger dùng cùng manager, không lồng transaction, ra 500 | chuyển sang R7, README accounts và dòng BL mới |

**Lượt 2 (re-review):** 7 phát hiện (blocking 0, should-fix 4, minor 3), verdict REVISE · [nguyên văn lượt 2](screenshots/DBS-55/domain-review-v2-round-2.md). Reviewer xác nhận đúng: caller thường ở depth 1, `AccountNotLockedError` ra 500, SQLSTATE vẫn đọc được qua `cause`, TC-55-16 đỏ với `now()`.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| v2-2 #1 | should-fix | "Chạy từ repo gốc" sai thật (đã tự kiểm) | đã sửa TC-55-14: chứng minh bằng spy `process.cwd`, không nhận chạy được từ repo gốc |
| v2-2 #2 | should-fix | Timeout 5 s mặc định của Jest | đã sửa R-5: `it(..., 25_000)` |
| v2-2 #3 | should-fix | Script đợi qua Unix socket, không giới hạn, không dọn container khi lỗi | đã sửa R5: đợi qua TCP, tối đa 60 s, `trap` xóa container, xóa container sót trước khi chạy |
| v2-2 #4 | should-fix | Bàn giao chưa có mục riêng, BACKLOG chưa có trong R3 | đã sửa: thêm R7, R3 liệt kê `docs/BACKLOG.md` và README |
| v2-2 #5 | minor | Chưa định nghĩa quy tắc map khi 0 hàng | đã sửa R3, thêm TC-55-21 |
| v2-2 #6 | minor | Chưa có test chứng minh khóa ngoài cùng còn giữ sau khi savepoint rollback | đã sửa: TC-55-20(d) |
| v2-2 #7 | minor | Mảng trùng rất dài vẫn chạy regex N lần | đã sửa R-4: chặn mảng thô > 256, thêm ca vào TC-55-18 |

**Lượt 3:** 4 phát hiện (blocking 0, should-fix 2, minor 2), verdict REVISE · [nguyên văn lượt 3](screenshots/DBS-55/domain-review-v2-round-3.md). Reviewer đã chạy thật script R5 trên máy này: PG 17.11, exit 0, container được dọn.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| v2-3 #1 | should-fix | Ca 10 000 id không chạm được tới bước dừng sớm | đã sửa TC-55-18: 256 id khác nhau dẫn tới đúng 17 lần chuẩn hóa; 257 phần tử dẫn tới 0 lần; đã ghi rõ thông điệp |
| v2-3 #2 | should-fix | Không còn 404 từ apply, nên Ledger phải tự kiểm id thiếu | đã sửa R7: thêm dòng bàn giao, kèm điều kiện đóng |
| v2-3 #3 | minor | Spy `process.cwd` không chứng minh `cwd` lấy từ `__dirname` | đã sửa TC-55-14: dùng `process.chdir` thật, trả lại trong `finally` |
| v2-3 #4 | minor | Bàn giao savepoint bỏ sót thứ tự nguy hiểm | đã sửa R7 dòng 1 |

**Lượt 4:** 3 phát hiện (blocking 0, should-fix 1, minor 2), verdict REVISE · [nguyên văn lượt 4](screenshots/DBS-55/domain-review-v2-round-4.md). Xác nhận v2-3 #1 và #4 đã sửa đúng.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| v2-4 #1 | should-fix | Bàn giao ghi đích không tồn tại ra 404, sai UC-5 6a; DENIED audit bị rollback cùng transaction | đã sửa R7 dòng 2: đích → 422 `ACCOUNT_NOT_ACTIVE`; nguồn → 404 trước transaction, audit trong transaction riêng |
| v2-4 #2 | minor | Chưa ghi cách spy `normalizeId` private, và chưa ghi thứ tự chuẩn hóa trước khi so trùng | đã sửa R-4 và TC-55-18 |
| v2-4 #3 | minor | Lý do test đỏ ở TC-55-14 ghi sai; thiếu ràng buộc timeout và concurrent | đã sửa TC-55-14 |

**Lượt 5:** 1 phát hiện (should-fix), verdict REVISE · [nguyên văn lượt 5](screenshots/DBS-55/domain-review-v2-round-5.md). Xác nhận v2-4 #1 (luồng chuyển tiền), #2, #3 đã sửa đúng.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| v2-5 #1 | should-fix | Bàn giao chưa nói luồng nạp tiền (không có kiểm sở hữu; đích thiếu → 422; thiếu funding → 500) | đã sửa R7 dòng 2 và điều kiện đóng |

**Lượt 6:** 0 phát hiện, **verdict APPROVE** · [nguyên văn lượt 6](screenshots/DBS-55/domain-review-v2-round-6.md).

### R7. Bàn giao

| Nhận | Việc | Điều kiện đóng | Ghi ở |
|---|---|---|---|
| Dev DBS-60/61 (Ledger) | Gọi `lockForUpdate` và `applyBalanceChange` trên **cùng `manager`** trong cùng `TransactionService.run`, ở cấp ngoài cùng. Không gọi trong `manager.transaction` lồng. Không có `SAVEPOINT` viết tay nào **đang mở** khi gọi `lockForUpdate`, và không `ROLLBACK TO SAVEPOINT` giữa lock và apply: service không thấy savepoint viết tay (review v2-3 #4) | E2E nạp/chuyển của DBS-60/61 chạy qua primitive mà không gặp `AccountNotLockedError` | README accounts, BL mới |
| Dev DBS-60/61 (Ledger) | So snapshot của `lockForUpdate` với các id đã yêu cầu **trước** mọi `applyBalanceChange`, vì `lockForUpdate` bỏ qua id không tồn tại và `applyBalanceChange` không còn trả 404 (review v2-3 #2). **Đích** không tồn tại thì đi qua guard: `REJECTED` / 422 `ACCOUNT_NOT_ACTIVE`, `to_account_id` NULL, lưu `transfers`, audit và response idempotency (UC-5 6a, BR-07). **Nguồn** không tồn tại hoặc không thuộc caller thì bị chặn ở kiểm tra sở hữu **trước** transaction: 404 kèm audit DENIED trong transaction riêng (AC-5.8, threat model T11) (review v2-4 #1). **Nạp tiền** (UC-3, docs/03 §6.4): không có bước kiểm sở hữu. Tài khoản khách (đích) không tồn tại thì `REJECTED` / 422 `ACCOUNT_NOT_ACTIVE`, `to_account_id` NULL, lưu `transfers`, audit và response idempotency. Thiếu hàng `funding` trong snapshot là lỗi cài đặt, ra 500, không phải 404 (review v2-5 #1) | Test ledger: chuyển tới đích không tồn tại ra 422 `ACCOUNT_NOT_ACTIVE`; nguồn không thuộc caller ra 404; nạp vào tài khoản không tồn tại ra 422 `ACCOUNT_NOT_ACTIVE`; không ca nào do khách gây ra 500 | README accounts, BL mới |
| Dev DBS-60/61 (Ledger) | Guard quyết định REJECTED (số dư, trạng thái, hạn mức) **trước** UPDATE. `AccountBalanceNegativeError`, `AccountBalanceOverflowError`, `AccountNotLockedError` là bug và phải ra 500, không map sang 422 (BR-07) | Test ledger: thiếu tiền ra 422 `INSUFFICIENT_FUNDS` từ guard; không có đường nào map lỗi mới sang 4xx | README accounts, BL mới |

**Quyết định ở G2 (vòng 2):** người dùng trả lời «oke dfuyet» ngày 2026-10-31. Chấp nhận R2–R7, đọc `transactionDepth` qua hàm có kiểm kiểu và fail closed (câu hỏi 1), chụp lại 4 ảnh cũ và thêm 2 ảnh mới (câu hỏi 2).

### R8. Kế hoạch triển khai

Mỗi bước viết test trước, chạy cho đỏ, sửa ít nhất có thể để xanh, rồi commit. Lệnh DB chạy tại `backend/`: `npm run test:db -- --runInBand --runTestsByPath test/db/accounts-service.db-spec.ts` (gọi tắt **DB**). Tất cả commit lên `feat/DBS-55-accounts-service`.

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| S0 · Tách mã TC | `test/db/accounts-service.db-spec.ts` | đổi tên TC-55-04a…d, 11a…c, 12a/b (không đổi nội dung) | không áp dụng (chỉ đổi tên); DB xanh 32 tests | DB | `test(accounts): give each DBS-55 case its own id` |
| S1 · Harness | `test/support/accounts-service-probe.ts` | không có test mới; R-6 nghỉ 15 ms trong `pollDatabase` | không áp dụng; DB xanh, TC-55-02/03 vẫn đạt | DB | `test(accounts): pause between lock-state polls` |
| S2 · R-2 kết quả UPDATE | `src/modules/accounts/accounts.service.ts`, `accounts.errors.ts` (mới), `index.ts`, db-spec | TC-55-10(b)(c) | … | DB; `npm run typecheck` | `fix(accounts): read RETURNING rows instead of the raw UPDATE tuple` |
| S3 · R-1 `clock_timestamp()` | service, db-spec, probe (helper chặn T1 bởi T2) | TC-55-16 | … | DB | `fix(accounts): stamp updated_at with clock_timestamp()` |
| S4 · R-3a lỗi có kiểu | service, `accounts.errors.ts`, db-spec | TC-55-07, TC-55-09 (đổi), TC-55-19 | … | DB | `feat(accounts): wrap balance CHECK and overflow failures in typed errors` |
| S5 · R-3b/3c khóa bắt buộc | service, db-spec (TC-55-05/06/08/09/11/15 đã khóa trước, giữ nguyên) | TC-55-17, TC-55-20, TC-55-21, TC-55-10(a) | … | DB; `npm run typecheck` | `feat(accounts): require the row lock and the outermost transaction before a balance change` |
| S6 · R-4 giới hạn id | service, db-spec | TC-55-18 | … | DB | `feat(accounts): cap how many accounts one call can lock` |
| S7 · R-5 test boundary | `src/modules/accounts/accounts.exports.spec.ts` | TC-55-14 với `process.chdir` (đỏ trước khi đặt `cwd` từ `__dirname`) | … | `npm test -- --runInBand --runTestsByPath src/modules/accounts/accounts.exports.spec.ts` | `test(accounts): run the eslint boundary probe asynchronously from a fixed cwd` |
| S8 · R-M comment | `src/modules/index.ts` | không áp dụng (comment); `src/modules/modules.spec.ts` vẫn xanh | không áp dụng | `npm test -- --runInBand --runTestsByPath src/modules/modules.spec.ts` | `docs(modules): explain why accounts is registered for api only` |
| S9 · Driver manual | `test/manual/accounts-service.manual.ts` | `expectRejection` nhận lớp lỗi và `cause`; thêm M-55-07, M-55-08 | đỏ: chạy driver mới trên code đã sửa trước khi sửa `expectRejection` → assert `code` ở cấp trên cùng fail | script R5 | `test(accounts): cover lock and timestamp rules in the manual driver` |
| S10 · Toàn bộ kiểm tra + manual | — | — | — | `lint:check`, `typecheck`, unit, DB, E2E (PG17 tạm ở 55432), `build`; script R5 | — |
| S11 · Merge `main` | `docs/BACKLOG.md` (xung đột), `docs/features/README.md` | — | — | `git merge origin/main`; chạy lại S10 nếu merge đổi file code | `chore(accounts): merge main into DBS-55` |
| S12 · Tài liệu và bằng chứng | `src/modules/accounts/README.md` (hợp đồng mới, R7, sửa "trả404"), `docs/BACKLOG.md` (BL-121 cho R7), feature doc R9, `docs/features/README.md`, `screenshots/DBS-55/` (`manual-test.txt`, `verification.txt`, `tdd-red-green.txt` thêm phần vòng 2, 6 ảnh) | — | — | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs`; `git diff --check` | `docs(accounts): record DBS-55 round-2 review fixes` |

Thứ tự migration → service → controller không áp dụng: không có migration, controller hay OpenAPI. Không có audit hay outbox.

**Rủi ro và cách lùi:**
- S5 có thể làm đỏ test cũ nào gọi apply mà chưa khóa. Mình đã rà: chỉ TC-55-04 (lỗi trước kiểm khóa) và TC-55-10 (sửa ở S5). Nếu còn ca khác đỏ thì dừng lại, không sửa test cho xanh mà không hỏi.
- `transactionDepth` là field nội bộ của TypeORM. Nếu bản nâng cấp đổi tên, TC-55-20(c) đỏ và service fail closed. Muốn lùi thì revert commit S5, các commit khác vẫn đứng được.
- Merge `main` (S11) có thể chạm file code của DBS-38/67/68/75 (hạ tầng). Nếu merge đổi file trong `backend/`, chạy lại toàn bộ S10 và manual.
- Push thường, không force. Nếu remote có commit mới của `ducp8822` thì `git pull --no-rebase` trước, rồi chạy lại S10.

**Plan sweep:**

| Nguồn | Mục | Xử lý |
|---|---|---|
| R1 phạm vi | R-1, R-2, R-3, R-4, R-5, R-6, R-7, R-M | S3, S2, S4/S5, S6, S7, S1, S0, S8 |
| R1 phạm vi | Typo "trả404" (điểm 1) | S12 README |
| R1 ngoài phạm vi | alias `LockedAccount` (điểm 1) | ngoài phạm vi, không sửa |
| R6 lượt 1–6 | 34 phát hiện | mỗi phát hiện "đã sửa" nằm trong R2–R5/R7, thực hiện ở S2–S9, S12 |
| R7 bàn giao | 3 dòng | S12: README accounts và BL-121 |
| DoD1–5 (task gốc) | khóa theo thứ tự, apply trong tx caller, 404 sở hữu, export, bigint | vẫn được TC-55-01…15 khóa lại; S10 chạy đủ |
| DoD6 quy trình | merge, Dev review, bảng TC trong PR | BL-057 giữ mở; cập nhật bảng TC trong PR body sau G4 |
| Hạn chế §8 vòng 1 | BL-054, BL-056, M-55-06, BL-008/015/017/019 | ngoài phạm vi, giữ nguyên |
| Xung đột PR | `docs/BACKLOG.md` | S11 |

**Quyết định ở G3 (vòng 2):** người dùng trả lời «duyet» ngày 2026-10-31. BL-121 cho bàn giao R7; push một lần sau G4.
