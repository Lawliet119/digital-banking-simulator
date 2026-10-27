# DBS-55 · AccountsService: khóa tài khoản, đổi số dư và kiểm tra sở hữu

> **Status:** Plan approved (G3 đã duyệt; đang triển khai) · **Vai:** Dev · **Cặp đôi review:** Dev khác, chưa chỉ định · **Nhánh:** `feat/DBS-55-accounts-service` · **PR:** — · **Cập nhật:** 2026-10-27

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

- Worktree riêng tạo từ `main` đã cập nhật tới `ab53152`; chưa có thay đổi production trong task này.
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

Các lệnh dưới chạy trong `backend/` của worktree DBS-55 trừ khi ghi rõ. Commit chỉ là **đề xuất sau khi được người dùng ủy quyền commit local ở G3**; hiện chưa commit. Mỗi hành vi: thêm case → chạy đỏ đúng nguyên nhân → code tối thiểu → xanh → dọn code. Cột đỏ dưới đây là **dự kiến, chưa phải output đã chạy**; Phase 4 thay bằng lỗi quan sát thật.

| Bước | File được phép thêm/sửa (từ root repo) | Test trước và kết quả đỏ dự kiến | Lệnh chứng minh | Commit đề xuất |
|---|---|---|---|---|
| P0 · Môi trường/schema | Không sửa file repo. `npm ci` theo `backend/package-lock.json`; xác nhận Node≥24, Docker và Compose hiện tại, không reset/đụng volume. Dùng migration production hiện có qua helper; không migration mới/down | Không thêm hành vi; baseline đã ghi §1, kiểm lại khi môi trường thay đổi | `node --version`; `npm --version`; `npm ci`; `docker compose ps` tại root | Không |
| P1 · Khóa, snapshot và guard | `backend/src/modules/accounts/account.types.ts`; `backend/src/modules/accounts/accounts.service.ts`; `backend/src/modules/accounts/index.ts`; `backend/test/db/accounts-service.db-spec.ts`; `backend/test/support/accounts-service-probe.ts` | TC-55-01/02/03, phần lock của04/13. **CHƯA CHẠY**: thiếu export/service hoặc chưa khóa low trước high/guard chưa chặn manager. Helper chỉ fixture0/barrier/poll/cleanup/SQL checks thật, không fake service | `npm run test:db -- --runInBand --runTestsByPath test/db/accounts-service.db-spec.ts`; `npm run typecheck` | `feat(accounts): lock accounts in deterministic id order` |
| P2 · Đổi số dư trong caller transaction | `backend/src/modules/accounts/accounts.service.ts`; `backend/test/db/accounts-service.db-spec.ts`; `backend/test/support/accounts-service-probe.ts` | Phần apply của04/13 và TC-55-05…10. **CHƯA CHẠY**: apply thiếu/chưa đổi số dư hoặc rollback/bigint/UPDATE tuple sai. Test viết trước từng hành vi: atomic update → rollback/visibility → precision/bounds → missing/type rejection | Cùng lệnh DB P1; `npm run typecheck` | `feat(accounts): apply balance changes in caller transactions` |
| P3 · Quyền sở hữu | `backend/src/modules/accounts/accounts.service.ts`; `backend/test/db/accounts-service.db-spec.ts`; `backend/test/support/accounts-service-probe.ts` | TC-55-11/12. **CHƯA CHẠY**: owned chưa có hoặc missing/foreign/SYSTEM/malformed chưa cùng404; chỉ internal users.id được nhận | Cùng lệnh DB P1; `npm run typecheck` | `feat(accounts): enforce uniform ownership checks` |
| P4 · Public API và Nest wiring | `backend/src/modules/accounts/accounts.module.ts`; `backend/src/modules/accounts/index.ts`; `backend/src/modules/accounts/accounts.exports.spec.ts`; `backend/src/modules/index.ts`; `backend/src/modules/modules.spec.ts`; `backend/test/db/accounts-service.db-spec.ts` | TC-55-14/15. **CHƯA CHẠY**: chưa có public module/provider/api registration; lint probe phải từ chối deep alias/relative và nhận public import. Probe dùng effective rule của config hiện có, không sửa eslint | `npm test -- --runInBand --runTestsByPath src/modules/accounts/accounts.exports.spec.ts src/modules/modules.spec.ts`; DB P1; `npm run lint:check`; `npm run typecheck` | `feat(accounts): expose and register accounts service` |
| P5 · Driver và lỗi vận hành | `backend/test/manual/accounts-service.manual.ts`; `backend/test/support/accounts-service-probe.ts` | Dùng TC-55-01…15 đã xanh; M-55-01…05. **CHƯA CHẠY**: trước driver chưa có executable manual; khi thêm assertion lỗi thử driver phải exit≠0, cleanup luôn chạy. Không tính kiểm exit này thay TC hoặc success manual | Lệnh Git Bash §5 với `all`, `pipefail`; final run sau code commit được phép; không token/URL trong output | `test(accounts): add real PostgreSQL manual probes` |
| P6 · Docs, đối chiếu và evidence | Các path chính xác ở bảng inventory dưới; không thêm path khác | Đối chiếu TC-55-01…15, M-55-01…06 và DoD1…6; chưa chạy không ghi đạt. **CHƯA CHẠY**: checker có thể báo thiếu link/evidence trước hoàn thiện; không giả tạo output đỏ | Full checks và manual như bên dưới; root: `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs`; `git diff --check` | `docs(accounts): record service verification and handoffs` |

Không tách abstraction production mới ngoài service/types/module/index. Helper P1 phục vụ cả DB spec và manual driver để giữ cùng fixture0/cleanup/invariant SQL; assertions từng case vẫn ở spec/driver. Tranh chấp dùng QueryRunner trực tiếp, không TransactionService retry; money probes chỉ gọi service và rollback trước invariant. Không sửa migration, `TransactionService`, `@common/money`, filter, config hoặc package/lockfile; nếu thiếu khả năng trong inventory thì xin gate phụ trước khi sửa.

### Inventory P6: tài liệu và output

| Path chính xác | Việc làm |
|---|---|
| `backend/src/modules/accounts/README.md` | Chữ ký/contract thật, transaction precondition, owner404, hạn chế caller ledger |
| `docs/components/accounts/01-concept-brief.md` | Tình trạng primitive đã kiểm; không nhận hoàn thành endpoint/UC |
| `docs/features/README.md` | Thêm hàng DBS-55, link hồ sơ |
| `docs/BACKLOG.md` | Thêm nguồn DBS-55 vào các gap audit/producer/manual E2E đã có, không tạo duplicate; giữ BL-008/019 và handoff ngoài scope. Dành **BL-052** cho DoD6 DBS-55 (**BL-053** thuộc DBS-57), kiểm lại ID trống khi thực thi nếu base đổi; không xóa gap chưa giải quyết |
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
| Mermaid phải render theo docs-style; hiện chưa có mmdc local | P6: trích nguyên diagram §3 ra thư mục tạm ngoài repo; chạy Mermaid CLI tạm qua `npm exec --yes --package @mermaid-js/mermaid-cli -- mmdc -i <temp-source> -o <temp-svg>`, đọc exit và mở SVG xác nhận. Không đổi diagram đã duyệt hoặc thêm dependency project; output ngoài repo |

**Kết quả sweep:** 6/6 DoD có row; TC01…15 và M01…06 đều có bước hoặc handoff; chưa loại case nào. Giới hạn đều có dòng ở trên, không nhận phần chưa chạy là đạt. Chưa thực hiện kiểm runtime của kế hoạch.

### Final verification, rủi ro và cách lùi

Sau P1–P5, chạy lần lượt tại `backend/`: `npm run lint:check`; `npm run typecheck`; `npm test -- --runInBand`; `npm run test:e2e -- --runInBand`; `npm run test:db -- --runInBand`; `npm run build`. E2e dùng PostgreSQL Compose đã kiểm, DB suite dùng helper thật; `npm ci` riêng từng worktree, DB suites hai nhánh chạy tuần tự để tránh contention. Ghi số đếm/skipped và output thật. Sau mọi sửa code/test cần thiết, lặp kiểm tra liên quan rồi final checks, commit code được phép, chạy **toàn bộ §5 trên SHA code cuối**; thay code sau manual phải chạy lại cả §5. Docs/evidence commit sau đó không đổi SHA code được ghi. P6 còn phải render Mermaid ngoài repo, link check và diff check. Nếu chưa có ủy quyền commit local, không bịa SHA cho working tree; ghi hạn chế và chờ quyết định trước bàn giao chuẩn final-commit.

- Nguy cơ pool/barrier treo: deadline/timeouts, observer riêng và finally cleanup; lỗi phải fail, không rerun để xanh. Môi trường Docker đang chạy chỉ xác nhận/khởi service cần thiết, không reset/xóa volume.
- Probe tiền có thể phá invariant nếu commit: driver/test không có nhánh commit money, cleanup rollback; chỉ metadata0/lock-only transaction được commit. Không SQL sửa balance/entries để phục hồi.
- `modules/index.ts`, `modules.spec.ts`, feature index và BACKLOG có thể cùng thay đổi ở nhánh DBS-57. Hai nhánh triển khai độc lập; tích hợp sau bằng kiểm diff và giải conflict nhỏ có kiểm lại wiring/test; chưa cherry-pick/rebase/gộp nhánh lúc này. Không ghi đè tài liệu/ID backlog của task kia.
- Commit local chỉ sau G3 kèm ủy quyền: stage đúng allowlist từng bước, kiểm staged paths và commit tree không chứa workbook Jira hoặc mọi biến thể `.xls`/`.xlsx`; không `git add .`, không `--no-verify`, không commit secrets. Giữ artifact local được bảo vệ.
- Thay đổi additive: lùi bằng revert các commit source/wiring đã được ủy quyền, giữ dữ liệu DB; không migration down, không reset hard/clean hoặc xóa branch. Feature docs/backlog điều chỉnh theo trạng thái lùi.

**Quyết định G3:** Người dùng trả lời «Duyệt G3» ngày 2026-10-27 cho kế hoạch đã trình, gồm quyền commit local sau bước xanh. Bắt đầu triển khai TDD; push/PR/board/merge vẫn chưa được phép.

## 8. Kết quả

Chưa thực hiện; chờ G3 để triển khai và xác minh, trình G4. Chưa có kết quả test của task, transcript hoặc ảnh thủ công.

## 9. Tài liệu đã cập nhật

Đã tạo/cập nhật hồ sơ này (§1–7) và lưu hai phản hồi domain review nguyên văn. Chưa sửa BACKLOG hoặc feature index; chưa có thay đổi implementation.

## Checklist G4 (chưa áp dụng; chờ triển khai)

- [ ] N/M test case đạt đủ độ sâu, K đơn giản hóa (nêu lý do từng cái)
- [ ] Test thủ công chạy trên commit cuối đổi code (SHA ở dòng đầu `manual-test.txt`): kết quả từng bước; đường thành công đã chạy (trừ khi G1 đã miễn); mọi bước chưa chạy nêu tên để người duyệt chấp nhận
- [ ] Ảnh chụp có đủ, hoặc nêu từng ảnh còn thiếu; transcript đã xóa token, Authorization, id tài khoản AWS và ARN
- [ ] Diff khớp danh sách file ở §7; mọi file ngoài kế hoạch có gate phụ ghi ở §8
- [ ] Các lệnh kiểm tra lúc bàn giao có kết quả và số đếm
- [ ] Mọi doc có fact bị đổi đã sửa; link checker sạch; status theo gate
- [ ] Bàn giao và DoD chưa đạt có ở §8 và BACKLOG; backlog task đã giải quyết được xóa
