# DBS-119 · Migration cuối: tạo dbs_api, dbs_worker, dbs_migrator và GRANT theo ma trận §8.1

<!-- Tài liệu làm việc, không phải báo cáo: ưu tiên bảng hơn văn xuôi; không chép lại DoD hay danh sách case ở §8 ngoài ID. Task nhỏ nên trong khoảng 2.500 từ; nếu dài hơn thì cắt văn xuôi trước, không bao giờ cắt kết quả test thủ công. -->

> **Status:** Implemented · **Vai:** Dev · **Cặp đôi review:** Dev · **Nhánh:** `feat/DBS-119-db-roles-grant-matrix` · **PR:** [#99](https://github.com/Lawliet119/digital-banking-simulator/pull/99) · **Cập nhật:** 2026-11-08

## 1. Bối cảnh

- **Task trên board:** Task · Tuần 4 · Ưu tiên: High · Assignee: `Dev` · Status: `In Progress` · Deliverable/Demo: `P3`.
  - **Thực trạng (trên board):** «App đang dùng một user DB chung. Ma trận quyền ở database-design §8.1 (UPDATE theo cột cho accounts: balance, status, updated_at); view v_transfer_facts ở §8.2. [Cập nhật 12/10] Chuyển từ #5 sang #1: migration và quyền DB do #1 sở hữu (database-design); #5 giữ hạ tầng và vận hành.»
  - **Expect (nguyên văn):** «Mỗi tiến trình chỉ có quyền DB tối thiểu.»
- **DoD (nguyên văn, đánh số từng gạch đầu dòng):**
  1. Migration bước 7 (§11) tạo 3 role và GRANT đúng ma trận; chạy bằng tài khoản đủ quyền (master/migrator pipeline), idempotent
  2. Ứng dụng không bao giờ kết nối bằng dbs_migrator (cấu hình pipeline chỉ dùng nó cho bước migration)
  3. Cấu hình local/Testcontainers dùng cùng role để test phản ánh production
  4. database-design §8 khớp migration
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc (kiểm trên board và xác minh trực tiếp trong repo):**
  - `DBS-21` (*Migration 2: transfers, ledger_entries, idempotency_keys, view v_transfer_facts*, Tuần 1): Đã có ([`1791849600000-CreateTransfersLedgerIdempotency.ts`](../../backend/src/database/migrations/1791849600000-CreateTransfersLedgerIdempotency.ts)).
  - `DBS-25` (*Migration: outbox_events và processed_events*, Tuần 1): Đã có ([`1792627200000-CreateOutboxEventsProcessedEvents.ts`](../../backend/src/database/migrations/1792627200000-CreateOutboxEventsProcessedEvents.ts)).
  - `DBS-26` (*Migration: audit_log*, Tuần 1): Đã có ([`1792627200001-CreateAuditLog.ts`](../../backend/src/database/migrations/1792627200001-CreateAuditLog.ts)).
  - `DBS-96` (*Migration: notification_log*, Tuần 3): Đã có ([`1792886400000-CreateNotificationLog.ts`](../../backend/src/database/migrations/1792886400000-CreateNotificationLog.ts)).
  - `DBS-58` (*Migration fraud: risk_rule_sets, fraud_flags, fraud_rule_hits*, Tuần 2): Đã có ([`1792713600000-CreateFraudStorage.ts`](../../backend/src/database/migrations/1792713600000-CreateFraudStorage.ts)).
  - `DBS-116` (*Migration: reconciliation_runs*, Tuần 4): Đã có ([`1793577600000-CreateReconciliationRuns.ts`](../../backend/src/database/migrations/1793577600000-CreateReconciliationRuns.ts)).
  - `DBS-27` (*Hàm forbid_mutation và trigger chặn sửa/xóa*, Tuần 1): Đã có ([`1792627200002-AddAppendOnlyTriggers.ts`](../../backend/src/database/migrations/1792627200002-AddAppendOnlyTriggers.ts)).
  Toàn bộ 7 phụ thuộc đều đã hoàn tất trên nhánh `main`.
- **Đã có gì trong codebase:**
  - File SQL độc lập [`infra/scripts/db-roles.sql`](../../infra/scripts/db-roles.sql) tạo `dbs_api` và `dbs_worker` NOLOGIN, cấp quyền theo ma trận §8.1.
  - Test suite [`backend/test/db/db-roles.db-spec.ts`](../../backend/test/db/db-roles.db-spec.ts) chạy kiểm tra quyền của `dbs_api` và `dbs_worker` (nhưng hiện tại phải nạp tay file SQL rời thay vì chạy tự động qua migration pipeline).
  - Định nghĩa kiến trúc và ma trận phân quyền chi tiết tại [`docs/components/_shared/database-design.md`](../components/_shared/database-design.md) §8.1 và thứ tự migration tại §11 bước 7.
  - Các mục tồn đọng liên quan trên [`docs/BACKLOG.md`](../BACKLOG.md):
    - `BL-005`: Chuyển chủ view `v_transfer_facts` sang `dbs_migrator` (view chạy bằng quyền chủ view, không dùng `security_invoker`) để `dbs_worker` truy vấn được mà không cần quyền trên `transfers`.
    - `BL-017`: Kiểm tra quyền của role ứng dụng trên bảng chỉ-thêm (`UPDATE`/`DELETE` bị từ chối) bằng role không phải superuser.
    - `BL-019`: Cấp quyền và kiểm tra AC-8.1/8.2 cho audit log bằng role thật.
    - `BL-103`: Bàn giao từ DBS-66 cho #5 Platform & Ops (gắn login/password từ Secrets Manager trên AWS).
- **Baseline kiểm tra:**
  - `npm --prefix backend run lint:check`: `0` lỗi, `0` cảnh báo.
  - `npm --prefix backend run typecheck`: `0` lỗi.
  - `npm --prefix backend test -- --runInBand`: `69` suites, `1129` tests pass.
  - `npm --prefix backend run test:db -- test/db/db-roles.db-spec.ts`: `1` suite, `4` tests pass (5.38 s).
  - `node .agents/skills/dbs-delivering-task/scripts/check-doc-links.mjs`: `256` files checked, `0` broken link(s).
- **Ngoài phạm vi:**
  - Không triển khai hạ tầng ECS service `worker` trên AWS (thuộc `BL-161` của vai #5 Platform & Ops).
  - Không cấu hình tự động xoay mật khẩu master RDS hay secret trên AWS (thuộc `BL-103`, `BL-107` của vai #5).
  - Không sửa đổi schema hay nghiệp vụ của các bảng dữ liệu hiện có.
- **Câu hỏi mở:**
  1. *Hình thức triển khai Migration bước 7:* Tạo migration TypeORM chính thức `backend/src/database/migrations/1793664000000-CreateDbRolesAndGrants.ts` để pipeline `migration:run` / `migration:run:prod` và test tự động áp dụng ma trận quyền ngay sau các migration tạo bảng. Migration bước 7 được thực thi bởi user quản trị/master (kết nối migration pipeline hiện tại trên RDS / Testcontainers) như quy định tại `database-design.md` §11 («chạy bằng tài khoản đủ quyền») để khởi tạo 3 roles; sau khi Migration 7 hoàn tất thì task chạy migration mới có thể kết nối bằng `dbs_migrator`. Giữ đồng bộ song song với `infra/scripts/db-roles.sql` cho mục đích tham chiếu hạ tầng. (Đề xuất: Duyệt).
  2. *Quyền và vai trò của `dbs_migrator` (DoD #1, DoD #2):* Tạo role `dbs_migrator` NOLOGIN NOSUPERUSER; cấp `USAGE, CREATE ON SCHEMA public` và `ALL PRIVILEGES` trên toàn bộ bảng/sequence/routine trong schema public. Đồng thời đổi chủ sở hữu view `v_transfer_facts` sang `dbs_migrator` để `dbs_worker` có thể SELECT view mà không cần quyền trên `transfers` (giải quyết triệt để `BL-005`). (Đề xuất: Duyệt).
  3. *Quy tắc ứng dụng không bao giờ kết nối bằng `dbs_migrator` (DoD #2):* Bổ sung cơ chế kiểm tra (guard/check `assertNotMigratorUser`) khi ứng dụng khởi động (`DatabaseModule` và test harness `startDepositApp`): nếu `url` chứa user `dbs_migrator`, ứng dụng từ chối khởi động (`APP_ROLE` api/worker không được dùng `dbs_migrator`). (Đề xuất: Duyệt).
  4. *Đóng các hàng Backlog:* DBS-119 sẽ giải quyết và đóng dứt điểm `BL-005`, `BL-017`; cập nhật `BL-019` và `BL-103`. (Đề xuất: Duyệt).
- **Quyết định ở G1 (2026-11-08):** Người dùng duyệt «duyệt g1». Thống nhất toàn bộ 4 đề xuất trên.

---

## 2. Hành vi

### 2.1 Hành vi tạo 3 role và phân quyền tối thiểu (Migration bước 7)
- **Tạo roles NOLOGIN (idempotent):**
  - Chạy bởi kết nối migration quản trị có quyền DDL/Role trên database:
  - Kiểm tra `pg_roles`, tạo nếu chưa có:
    - `dbs_migrator`: Role migration, sở hữu DDL và toàn quyền trên schema `public`.
    - `dbs_api`: Role tiến trình HTTP API (`APP_ROLE=api` hoặc `both`).
    - `dbs_worker`: Role tiến trình xử lý nền (`APP_ROLE=worker`).
  - Toàn bộ 3 role được tạo với cấu hình an toàn: `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`.
- **Cấp quyền cho `dbs_migrator`:**
  - `GRANT USAGE, CREATE ON SCHEMA public TO dbs_migrator;`
  - `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO dbs_migrator;`
  - `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO dbs_migrator;`
  - `GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO dbs_migrator;`
  - Cập nhật chủ sở hữu view `v_transfer_facts` sang `dbs_migrator`:
    - `ALTER VIEW public.v_transfer_facts OWNER TO dbs_migrator;`
    - View chạy với quyền của owner (không dùng `security_invoker`), cho phép `dbs_worker` truy vấn các cột cần thiết của view mà không cần cấp quyền `SELECT` trên bảng dữ liệu nhạy cảm `transfers` (đóng `BL-005`).
- **Phân quyền tối thiểu theo ma trận §8.1 cho `dbs_api` và `dbs_worker`:**
  - Bắt đầu bằng việc thu hồi toàn bộ quyền cũ để đảm bảo tính idempotent và đồng bộ:
    - `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dbs_api, dbs_worker;`
    - `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM dbs_api, dbs_worker;`
    - `REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM dbs_api, dbs_worker;`
    - `GRANT USAGE ON SCHEMA public TO dbs_api, dbs_worker;`
  - **Quyền của `dbs_api`:**
    - `users`: `SELECT, INSERT`, `UPDATE (sessions_revoked_at)`
    - `customers`: `SELECT, INSERT`, `UPDATE (full_name)` (cần thiết cho `SELECT ... FOR UPDATE` khi mở tài khoản, BR-14)
    - `accounts`: `SELECT, INSERT`, `UPDATE (balance, status, updated_at)`
    - `transfers`: `SELECT, INSERT`
    - `ledger_entries`: `SELECT, INSERT`
    - `idempotency_keys`: `SELECT, INSERT`, `UPDATE (transfer_id, response_code, response_body)`
    - `outbox_events`: `INSERT` (chỉ ghi, không đọc)
    - `audit_log`: `SELECT, INSERT`
    - `fraud_flags`: `SELECT`, `UPDATE (review_status, reviewed_by, reviewed_at, review_note)`
    - `fraud_rule_hits`: `SELECT`
    - `risk_rule_sets`: `SELECT, INSERT`
    - `reconciliation_runs`: `SELECT` (chỉ xem, không ghi)
    - Toàn bộ sequences: `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dbs_api;`
  - **Quyền của `dbs_worker`:**
    - `accounts`: `SELECT` (cho job đối soát)
    - `v_transfer_facts`: `SELECT` (view contract chỉ-đọc)
    - `ledger_entries`: `SELECT` (cho job đối soát)
    - `idempotency_keys`: `SELECT, DELETE` (cho job dọn dẹp)
    - `outbox_events`: `SELECT, DELETE`, `UPDATE (published_at)` (cho outbox relay)
    - `processed_events`: `SELECT, INSERT, DELETE` (cho consumer dedup)
    - `audit_log`: `INSERT` (ghi nhật ký hành động worker)
    - `fraud_flags`: `SELECT, INSERT` (cho risk consumer)
    - `fraud_rule_hits`: `SELECT, INSERT` (cho risk consumer)
    - `risk_rule_sets`: `SELECT` (cho risk consumer)
    - `notification_log`: `SELECT, INSERT, DELETE` (cho notification consumer)
    - `reconciliation_runs`: `SELECT, INSERT, DELETE` (cho reconciliation job)
    - Toàn bộ sequences: `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dbs_worker;`
- **Đồng bộ song song `infra/scripts/db-roles.sql`:**
  - Cập nhật script `infra/scripts/db-roles.sql` đồng bộ 100% với migration: tạo role `dbs_migrator`, gán owner `v_transfer_facts` sang `dbs_migrator`, và cấp `USAGE, SELECT ON ALL SEQUENCES` cho cả 3 roles.
- **Hành vi `down()` của Migration bước 7:**
  - Hoàn tác quyền sở hữu view `v_transfer_facts` về `CURRENT_USER` (tài khoản chạy migration ban đầu):
    - `ALTER VIEW public.v_transfer_facts OWNER TO CURRENT_USER;`
  - Thu hồi toàn bộ quyền trên bảng, sequence, routine và schema public từ `dbs_api`, `dbs_worker`, `dbs_migrator`:
    - `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dbs_api, dbs_worker, dbs_migrator;`
    - `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM dbs_api, dbs_worker, dbs_migrator;`
    - `REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM dbs_api, dbs_worker, dbs_migrator;`
    - `REVOKE USAGE, CREATE ON SCHEMA public FROM dbs_api, dbs_worker, dbs_migrator;`
  - Khôi phục quyền mặc định an toàn, không để lại quan hệ phụ thuộc dở dang trên view.

### 2.2 Hành vi ngăn chặn ứng dụng kết nối bằng `dbs_migrator` (DoD #2)
- Khi ứng dụng khởi động (`DatabaseModule` nạp cấu hình `databaseConfig` và `startDepositApp` trong test):
  - Hàm thẩm tra `assertNotMigratorUser(url)` kiểm tra chuỗi kết nối:
    - Nếu URL phân tích có username là `dbs_migrator`:
      - Ném lỗi cấu hình `ConfigError` / `Error`:
        `"Ứng dụng (APP_ROLE=api|worker|both) không bao giờ được kết nối DB bằng dbs_migrator. Chỉ sử dụng dbs_api hoặc dbs_worker theo nguyên tắc quyền tối thiểu."`
      - Ứng dụng từ chối khởi động ngay lập tức, ngăn ngừa hoàn toàn nguy cơ chạy nghiệp vụ với quyền DDL owner.
  - Ngoại lệ: Chỉ CLI TypeORM chạy migration (`data-source.ts` / `npm run migration:run:prod`) mới được phép dùng thông tin kết nối của `dbs_migrator`.

### 2.3 Hành vi từ chối thao tác vi phạm quyền (ACL Enforcement — DoD #1, #3, BL-017)
- **Khi kết nối là `dbs_api`:**
  - Cố tình `UPDATE` hoặc `DELETE` trên bảng `transfers`, `ledger_entries`, `audit_log` $\rightarrow$ PostgreSQL từ chối với mã lỗi `42501` (`permission denied for table ...`). Đây là lớp phòng thủ thứ nhất (DB ACL) trước khi trigger `forbid_mutation()` can thiệp (chứng minh dứt điểm `BL-017`).
  - Cố tình sửa cột `type` hoặc `customer_id` trên `accounts` $\rightarrow$ `42501 permission denied for column ...`.
  - Cố tình đọc `outbox_events` hoặc `processed_events` $\rightarrow$ `42501 permission denied`.
  - Cố tình ghi vào `reconciliation_runs` hoặc `notification_log` $\rightarrow$ `42501 permission denied`.
- **Khi kết nối là `dbs_worker`:**
  - `SELECT` trên `v_transfer_facts` thành công trả về dòng giao dịch cần thiết.
  - Cố tình `SELECT` trực tiếp trên bảng `transfers` $\rightarrow$ `42501 permission denied for table transfers` (`BL-005`).
  - Cố tình `UPDATE` hoặc `DELETE` trên `accounts`, `ledger_entries` $\rightarrow$ `42501 permission denied`.
  - Cố tình đọc bảng `customers` hoặc `users` $\rightarrow$ `42501 permission denied`.

---

## 3. Kiến trúc

### 3.1 Vị trí và phân vai trong codebase
- **Module:** Database (`@database`), Config (`@config`), Testing Support (`test/support`).
- **File thêm mới và chỉnh sửa:**
  - `backend/src/database/migrations/1793664000000-CreateDbRolesAndGrants.ts`: Migration bước 7 TypeORM tạo roles và GRANT.
  - `infra/scripts/db-roles.sql`: Script SQL đồng bộ cho việc khởi tạo môi trường RDS / Terraform (bổ sung `dbs_migrator`, owner `v_transfer_facts` và quyền sequences).
  - `backend/src/database/database-url.guard.ts`: Thẩm định cấm kết nối bằng `dbs_migrator` (`assertNotMigratorUser`).
  - `backend/src/database/database.module.ts`: Tích hợp `assertNotMigratorUser` trong `buildTypeOrmOptions`.
  - `backend/test/support/deposit-app.ts`: Tích hợp `assertNotMigratorUser` trong fixture `startDepositApp`.
  - `backend/test/db/db-roles.db-spec.ts`: Cập nhật suite test tích hợp PostgreSQL 17 thật để kiểm chứng cả 3 roles tự động sau `migrate(db.url)`, kiểm tra trigger của `dbs_migrator`, kiểm tra cấm `dbs_migrator` ở app, và kiểm tra `down()`.
  - `backend/test/db/reconciliation-migration-revert.db-spec.ts`: Áp dụng mẫu chuẩn cô lập migration target (tương tự `outbox-schema.db-spec.ts` dòng 98–106, 389–395 và `append-only.db-spec.ts` dòng 441–444):
    (1) Thêm helper `revertSuccessors()` hoàn tác các migration mới hơn `TARGET = CreateReconciliationRuns1793577600000` trong `beforeEach`.
    (2) Trong `TC-116-18`: gọi `await revertSuccessors()` ngay sau mỗi lần thực thi `cli('migration:run')` (dòng 89, 90, 111) để ghim `TARGET` ở đỉnh lịch sử trước khi assert `catalog()` và trước khi chạy `cli('migration:revert')`.
    (3) Trong `TC-116-20`, `TC-116-21` (dòng 161) và `TC-116-25` (dòng 239): thay thế `await migrate(db.url)` bằng `await migrateThrough(db.url, TARGET)` để history không bị nạp dư Migration 7.
    Bảo đảm toàn bộ 4 test case revert của reconciliation tiếp tục PASS 100% khi có Migration 7 (DoD #5).

### 3.2 Interfaces và chữ ký thật
- **Migration bước 7:**
  ```typescript
  import type { MigrationInterface, QueryRunner } from 'typeorm';

  export class CreateDbRolesAndGrants1793664000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void>;
    public async down(queryRunner: QueryRunner): Promise<void>;
  }
  ```
- **Guard kiểm tra username `dbs_migrator`:**
  ```typescript
  export function assertNotMigratorUser(databaseUrl: string | undefined): void {
    if (!databaseUrl) return;
    try {
      const parsed = new URL(databaseUrl);
      if (decodeURIComponent(parsed.username).toLowerCase() === 'dbs_migrator') {
        throw new Error(
          'Security violation: The application must never connect to the database as dbs_migrator (DoD #2). ' +
            'Use dbs_api for the API role or dbs_worker for the worker role.',
        );
      }
    } catch (err) {
      if ((err as Error).message.includes('Security violation')) throw err;
    }
  }
  ```

### 3.3 Sơ đồ quan hệ phân quyền 3 roles (Mermaid)

```mermaid
graph TD
    subgraph Pipeline["Migration Pipeline (CI/CD)"]
        MigrateTask["ECS Task: dbs-migrate / CLI"]
    end

    subgraph AppRoles["Application Processes (Runtime)"]
        ApiRole["ECS Task / Process: api (dbs_api)"]
        WorkerRole["ECS Task / Process: worker (dbs_worker)"]
    end

    subgraph DBRoles["PostgreSQL Roles (database-design §8.1)"]
        MigratorRole["Role: dbs_migrator (Owner / DDL)"]
        ApiDbRole["Role: dbs_api (Least Privilege)"]
        WorkerDbRole["Role: dbs_worker (Least Privilege)"]
    end

    subgraph TablesViews["Database Objects (Schema: public)"]
        ViewFacts["View: v_transfer_facts (Owner: dbs_migrator)"]
        TblMoney["transfers, ledger_entries, accounts"]
        TblBackground["outbox_events, processed_events, notification_log, reconciliation_runs"]
        TblAudit["audit_log, users, customers, fraud_flags, risk_rule_sets"]
    end

    MigrateTask -->|Nối bằng role| MigratorRole
    MigratorRole -->|Sở hữu DDL & ALL PRIVILEGES| TablesViews

    ApiRole -->|Nối bằng role| ApiDbRole
    WorkerRole -->|Nối bằng role| WorkerDbRole

    ApiRole -.->|CẤM KẾT NỐI (Guard DoD #2)| MigratorRole
    WorkerRole -.->|CẤM KẾT NỐI (Guard DoD #2)| MigratorRole

    ApiDbRole -->|SELECT, INSERT, UPDATE cột| TblMoney
    ApiDbRole -->|INSERT outbox / SELECT audit / UPDATE fraud| TblAudit
    ApiDbRole -.-x|BỊ CHẶN: UPDATE/DELETE transfers/ledger, đọc outbox/worker| TblMoney

    WorkerDbRole -->|SELECT view hợp đồng (BL-005)| ViewFacts
    WorkerDbRole -->|SELECT, UPDATE, DELETE| TblBackground
    WorkerDbRole -->|INSERT audit, SELECT/INSERT fraud| TblAudit
    WorkerDbRole -.-x|BỊ CHẶN: SELECT transfers, UPDATE accounts/ledger| TblMoney
```

---

## 4. Test cases tự động

| ID | Truy vết (DoD / AC) | Lớp (integration Postgres 17 thật) | Given · When · Then | `errorCode` / Trạng thái mong đợi |
|---|---|---|---|---|
| `TC-119-01` | DoD #1, §11 Bước 7 | integration Postgres thật (`db-roles.db-spec.ts`) | **Given** Database PostgreSQL 17 tạm thời chưa có 3 role · **When** chạy `migrate(db.url)` áp dụng migration `CreateDbRolesAndGrants1793664000000`, sau đó chạy lại `migrate` lần 2 (idempotent); sau đó chạy hoàn tác revert `down()` (trả owner `v_transfer_facts` về `CURRENT_USER` và thu hồi quyền sạch sẽ), rồi chạy lại `up()` · **Then** 3 role `dbs_migrator`, `dbs_api`, `dbs_worker` được tạo thành công, ma trận quyền khớp chính xác §8.1; không có lỗi duplicate role, không lỗi phụ thuộc owner view dở dang, không conflict quyền | Thành công (0 lỗi DDL) |
| `TC-119-02` | DoD #1, DoD #3, `BL-017`, `AC-8.1` | integration Postgres thật (`db-roles.db-spec.ts`) | **Given** Database đã migrate đầy đủ, kết nối bằng role `dbs_api` · **When** thực hiện: (a) nạp tiền qua operator, chuyển tiền, replay idempotency, mở tài khoản SAVINGS (`FOR UPDATE`), thu hồi phiên `users`; (b) cố ý chạy `UPDATE/DELETE` trên `transfers`, `ledger_entries`, `audit_log`, `UPDATE` cột `type/customer_id` trên `accounts`, đọc `outbox_events`, ghi `reconciliation_runs` · **Then** tại (a) toàn bộ luồng nghiệp vụ API chạy thành công, bất biến sổ cái đạt `PASS`; tại (b) PostgreSQL từ chối với lỗi `42501 permission denied` (lớp phòng thủ ACL thứ nhất trước khi trigger can thiệp) | Luồng nghiệp vụ: 200/201; Thao tác ngoài ma trận: `42501` |
| `TC-119-03` | DoD #1, DoD #3, `BL-005`, `AC-8.1` | integration Postgres thật (`db-roles.db-spec.ts`) | **Given** Database đã migrate đầy đủ, kết nối bằng role `dbs_worker` · **When** thực hiện: (a) `SELECT` trên `v_transfer_facts`, chạy relay `outbox_events`, ghi và dọn `processed_events`, ghi `notification_log`, ghi `reconciliation_runs`; (b) cố ý `SELECT` trực tiếp bảng `transfers`, `customers`, `users`, hoặc sửa số dư `accounts` · **Then** tại (a) `dbs_worker` truy vấn view `v_transfer_facts` thành công và nhận đủ dữ liệu giao dịch dù **hoàn toàn không có quyền trên bảng `transfers`** (`BL-005`); tại (b) PostgreSQL từ chối với lỗi `42501 permission denied` | Luồng nền: thành công; Thao tác ngoài ma trận: `42501` |
| `TC-119-04` | DoD #2 | integration NestJS (`db-roles.db-spec.ts` & `deposit-app.ts`) | **Given** Cấu hình ứng dụng NestJS (`startDepositApp` và `buildTypeOrmOptions` trong `DatabaseModule`) · **When** cố tình cấu hình `DATABASE_URL` chứa username `dbs_migrator` (ví dụ `postgres://dbs_migrator:pass@host:5432/db`) và khởi chạy ứng dụng · **Then** ứng dụng ném ngoại lệ bảo mật cấm kết nối ngay từ bootstrap, từ chối khởi động | Ném lỗi bảo mật DoD #2 |
| `TC-119-05` | DoD #1, `AC-8.1`, `database-design.md` §8.3 | integration Postgres thật (`db-roles.db-spec.ts`) | **Given** Database đã migrate đầy đủ, kết nối bằng role `dbs_migrator` · **When** thực hiện: (a) tạo bảng tạm DDL, kiểm tra schema catalog, kiểm tra quyền sở hữu view `v_transfer_facts` (`viewowner = 'dbs_migrator'`); (b) cố tình chạy `UPDATE` hoặc `DELETE` trên các bảng chỉ-thêm (`transfers`, `ledger_entries`, `audit_log`, `risk_rule_sets`) · **Then** tại (a) `dbs_migrator` sở hữu đầy đủ quyền DDL và DML trên schema public; tại (b) dù có toàn quyền DB ACL, thao tác `UPDATE/DELETE` vẫn bị trigger `forbid_mutation()` chặn với mã lỗi `42501` và thông điệp `append-only` (chứng minh phòng thủ chiều sâu theo `database-design.md` §8.3) | DDL/DML: thành công; Mutation trên bảng chỉ-thêm: `42501 append-only` |
| `Quy trình` | DoD #5: PR đã merge vào `main` (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ | Quy trình bàn giao | Mở PR sau G4, điền đầy đủ bảng «Đối chiếu test case», chờ CI xanh và Dev đồng nghiệp review trước khi merge | — |

---

## 5. Test thủ công

Kịch bản chạy bằng lệnh shell trực tiếp:
```bash
node backend/scripts/manual-dbs119.cjs
```
Script tự động hóa hoàn toàn việc khởi chạy PostgreSQL 17 thật trên database tạm, chạy migration TypeORM bước 7, xác minh catalog quyền của cả 3 roles, thử nghiệm toàn bộ luồng nghiệp vụ API dưới vai `dbs_api`, thử nghiệm đọc view hợp đồng dưới vai `dbs_worker` (không có quyền trên `transfers`), kiểm tra trigger chặn `dbs_migrator` và kiểm tra guard từ chối `dbs_migrator`. Toàn bộ log stdout/stderr được xuất ra file `docs/features/screenshots/DBS-119/manual-test.txt` với dòng đầu tiên là SHA của commit code cuối cùng.

- **Điều kiện chạy:** Docker Desktop đang bật (PostgreSQL 17); các giao dịch thực hiện trên database tạm thời được cấp phát độc lập.

| Bước | Lệnh hoặc thao tác trong `manual-dbs119.cjs` | Kết quả quan sát mong đợi |
|---|---|---|
| **M-119-01** | `node backend/scripts/manual-dbs119.cjs` (Bước 1): Chạy migration bước 7 `CreateDbRolesAndGrants1793664000000` trên DB tạm; chạy lại lần 2 (idempotency); chạy `migration:revert` (`down()`) xác nhận hoàn tác owner view về `CURRENT_USER` và thu hồi quyền sạch; chạy lại `migration:run` (`up()`); kiểm tra catalog `pg_roles` có đủ 3 role `dbs_migrator`, `dbs_api`, `dbs_worker` với `rolcanlogin = false`; kiểm tra view `v_transfer_facts` có `viewowner = 'dbs_migrator'` | 3 role tồn tại; view `v_transfer_facts` thuộc quyền sở hữu của `dbs_migrator`; chu trình vòng đời migration sạch sẽ; log ghi nhận `M-119-01 PASS` |
| **M-119-02** | `node backend/scripts/manual-dbs119.cjs` (Bước 2): Cấp mật khẩu test và kết nối bằng `dbs_api`; nạp tiền `5.000.000`, chuyển tiền `1.500.000`, replay idempotency qua API HTTP thật; sau đó chạy lệnh SQL cố ý `UPDATE ledger_entries` và `DELETE transfers` | Luồng tiền thành công (201); thao tác sửa/xóa bảng chỉ-thêm bị PostgreSQL từ chối với lỗi `42501 permission denied`; `checkLedgerInvariants` trả `PASS`; log ghi nhận `M-119-02 PASS` |
| **M-119-03** | `node backend/scripts/manual-dbs119.cjs` (Bước 3): Kết nối bằng `dbs_worker`; thực hiện truy vấn `SELECT id, amount, status FROM v_transfer_facts`; sau đó thực hiện lệnh SQL `SELECT * FROM transfers` | Truy vấn qua view `v_transfer_facts` thành công trả về dòng giao dịch; truy vấn trực tiếp bảng `transfers` bị từ chối với `42501 permission denied for table transfers`; log ghi nhận `M-119-03 PASS` |
| **M-119-04** | `node backend/scripts/manual-dbs119.cjs` (Bước 4): Kết nối bằng `dbs_migrator`, chạy DDL tạo bảng tạm thành công; cố ý `UPDATE ledger_entries` bị trigger `forbid_mutation` chặn (`42501 append-only`); thử khởi động NestJS application với `DATABASE_URL` chứa username `dbs_migrator` bị guard chặn ngay lập tức; dọn dẹp database tạm sạch sẽ | `dbs_migrator` bị trigger chặn khi sửa bảng chỉ-thêm; app khởi động thất bại với lỗi cấm `dbs_migrator`; đóng kết nối và xóa DB tạm sạch sẽ; log ghi nhận `M-119-04 PASS` |

---

## 6. Domain review (AI)

- **Reviewer:** Subagent `research` độc lập (`conversationId: 9fffe5c2-b391-4498-a43b-b1cd09442b41`, model `inherit`).
- **Bản lưu nguyên văn:** [`docs/features/screenshots/DBS-119/domain-review-round1.md`](screenshots/DBS-119/domain-review-round1.md).
- **Tóm tắt các phát hiện và xử lý (Round 1):**
  1. `blocking` (§1 DoD #1, §2.1): Về mặt kỹ thuật, Migration bước 7 không thể chạy bằng `dbs_migrator` vì role chưa tồn tại và không có quyền `CREATE ROLE` hay đổi owner bảng cũ. `database-design.md` §11 quy định bước 7 chạy bằng «tài khoản đủ quyền» (master/owner user).
     $\rightarrow$ **Đã sửa:** Làm rõ trong §1 và §2.1: Migration bước 7 được thực thi bởi user quản trị/master của pipeline migration; sau bước 7 thì pipeline mới có thể chạy bằng `dbs_migrator`.
  2. `should-fix` (§2.1 `down()`, §4 `TC-119-01`): `down()` thu hồi quyền của `dbs_migrator` nhưng không hoàn tác quyền sở hữu `v_transfer_facts` về `CURRENT_USER`, làm view lỗi và cản trở việc drop/revert sạch role.
     $\rightarrow$ **Đã sửa:** Bổ sung `ALTER VIEW public.v_transfer_facts OWNER TO CURRENT_USER;` vào `down()` trước khi thu hồi quyền.
  3. `should-fix` (§2.2, §3.1, §4 `TC-119-04`): Fixture `startDepositApp` trong `test/support/deposit-app.ts` không dùng `DatabaseModule`, dẫn đến `TC-119-04` nếu chạy qua test harness sẽ không kích hoạt guard.
     $\rightarrow$ **Đã sửa:** Tích hợp `assertNotMigratorUser` vào cả `buildTypeOrmOptions` và `startDepositApp`.
  4. `should-fix` (§4 `TC-119-05`): `database-design.md` §8.3 yêu cầu bắt buộc: test chứng minh kết nối bằng `dbs_migrator` cố `UPDATE/DELETE` bảng chỉ-thêm cũng bị trigger `forbid_mutation()` chặn (AC-8.1).
     $\rightarrow$ **Đã sửa:** Bổ sung vào `TC-119-05` và `M-119-04` assertion kiểm tra trigger `forbid_mutation` chặn `dbs_migrator` với lỗi `42501 append-only`.
  5. `should-fix` (§1, §3.1): `infra/scripts/db-roles.sql` hiện tại thiếu `dbs_migrator`, thiếu đổi owner `v_transfer_facts`, và thiếu quyền sequences.
     $\rightarrow$ **Đã sửa:** Cam kết cập nhật `infra/scripts/db-roles.sql` đồng bộ 100% với migration bước 7.
  6. `minor` (§2.2 vs §3.2): Không nhất quán tên hàm `assertNotMigratorDatabaseUrl` vs `assertNotMigratorUser`.
     $\rightarrow$ **Đã sửa:** Thống nhất dùng `assertNotMigratorUser`.
  7. `minor` (§5 `M-119-01`): Kịch bản manual thiếu bước kiểm tra idempotent (chạy 2 lần) và hoàn tác `down()` rồi chạy lại `up()`.
     $\rightarrow$ **Đã sửa:** Bổ sung chu trình chạy lại lần 2, revert `down()` và rerun `up()` vào bước `M-119-01`.
- **Bản lưu Round 2 nguyên văn:** [`docs/features/screenshots/DBS-119/domain-review-round2.md`](screenshots/DBS-119/domain-review-round2.md).
- **Tóm tắt các phát hiện và xử lý (Round 2):**
  1. `should-fix` (§3.1, §4, §7): Khi thêm Migration 7, test suite `reconciliation-migration-revert.db-spec.ts` sẽ bị gãy 4 test case do mặc định `CreateReconciliationRuns` luôn ở đỉnh history.
     $\rightarrow$ **Đã sửa:** Bổ sung `backend/test/db/reconciliation-migration-revert.db-spec.ts` vào danh sách file sửa đổi và bổ sung helper `revertSuccessors()` trong `beforeEach` (theo mẫu chuẩn `outbox-schema.db-spec.ts`) để hoàn tác các migration mới về trước mốc TARGET trước khi kiểm tra revert reconciliation.
  2. `minor` (§3.2): Guard `assertNotMigratorUser` chưa decode URL percent-encoding (`dbs%5Fmigrator`).
     $\rightarrow$ **Đã sửa:** Dùng `decodeURIComponent(parsed.username).toLowerCase() === 'dbs_migrator'`.
- **Bản lưu Round 3 nguyên văn:** [`docs/features/screenshots/DBS-119/domain-review-round3.md`](screenshots/DBS-119/domain-review-round3.md).
- **Tóm tắt các phát hiện và xử lý (Round 3):**
  1. `should-fix` (§3.1): Cần làm rõ phạm vi áp dụng `revertSuccessors()` và `migrateThrough()` trong `TC-116-18`, `TC-116-20`, `TC-116-21`, `TC-116-25` khi `cli('migration:run')` nạp lại Migration 7.
     $\rightarrow$ **Đã sửa:** Cập nhật chi tiết kỹ thuật tại §3.1: gọi `revertSuccessors()` sau mỗi lần `cli('migration:run')` ở `TC-116-18`, và dùng `migrateThrough(db.url, TARGET)` ở `TC-116-20/21/25` theo đúng mẫu chuẩn của `outbox-schema.db-spec.ts`.
- **Bản lưu Round 4 (chung cuộc) nguyên văn:** [`docs/features/screenshots/DBS-119/domain-review.md`](screenshots/DBS-119/domain-review.md).
- **Kết luận Round 4:** 0 blocking, 0 should-fix, 0 minor (`Verdict: APPROVE`).

---

## 7. Kế hoạch triển khai

### Bước 1 — Cô lập migration target trong `reconciliation-migration-revert.db-spec.ts` trước khi thêm Migration 7
- **Mục tiêu:** Áp dụng mẫu chuẩn `revertSuccessors` từ `outbox-schema.db-spec.ts` vào `reconciliation-migration-revert.db-spec.ts` để khi Migration 7 xuất hiện, suite này không bị gãy (DoD #5).
- **Files:**
  - `backend/test/db/reconciliation-migration-revert.db-spec.ts`
- **Test (chạy trước):**
  - Chạy: `npm --prefix backend run test:db -- test/db/reconciliation-migration-revert.db-spec.ts`
  - Kết quả: PASS (4 tests).
- **Code tối thiểu:**
  - Bổ sung helper `revertSuccessors()` vào suite.
  - Trong `beforeEach`: gọi `await migrate(db.url); await revertSuccessors();`
  - Trong `TC-116-18`: gọi `await revertSuccessors();` sau mỗi lần gọi `cli('migration:run')` (dòng 89, 90, 111).
  - Trong `TC-116-20`, `TC-116-21`, `TC-116-25`: thay `await migrate(db.url)` bằng `await migrateThrough(db.url, TARGET)`.
- **Lệnh kiểm chứng:** `npm --prefix backend run test:db -- test/db/reconciliation-migration-revert.db-spec.ts && npm --prefix backend run typecheck && npm --prefix backend run lint:check` (exit code `0`).
- **Commit dự kiến:** `test(ledger): isolate reconciliation revert test harness from successor migrations (DBS-119)`

### Bước 2 — Guard cấm ứng dụng kết nối bằng `dbs_migrator` (DoD #2)
- **Mục tiêu:** Xây dựng guard `assertNotMigratorUser(url)` và tích hợp vào `buildTypeOrmOptions` (`DatabaseModule`) và `startDepositApp` (`test/support/deposit-app.ts`).
- **Files:**
  - `backend/src/database/database-url.guard.ts` *(mới)*
  - `backend/src/database/database-url.guard.spec.ts` *(mới — unit test cho guard)*
  - `backend/src/database/database.module.ts`
  - `backend/test/support/deposit-app.ts`
- **Test (viết trước — phải đỏ):**
  - Viết `backend/src/database/database-url.guard.spec.ts` kiểm tra các định dạng URL chứa username `dbs_migrator` (thường và percent-encoded `dbs%5Fmigrator`), kiểm tra ném lỗi đúng thông điệp bảo mật; kiểm tra URL hợp lệ (`dbs_api`, `dbs_worker`, `postgres`) đi qua bình thường.
  - Lệnh chạy đỏ: `npm --prefix backend test -- src/database/database-url.guard.spec.ts`
  - Kết quả đỏ: `Cannot find module './database-url.guard'`.
- **Code tối thiểu để xanh:**
  - Viết hàm `assertNotMigratorUser(url)` trong `backend/src/database/database-url.guard.ts`.
  - Tích hợp gọi guard trong `buildTypeOrmOptions` (`database.module.ts`) và `startDepositApp` (`deposit-app.ts`).
- **Lệnh kiểm chứng:** `npm --prefix backend test -- src/database/database-url.guard.spec.ts && npm --prefix backend run typecheck && npm --prefix backend run lint:check` (exit code `0`).
- **Commit dự kiến:** `feat(database): guard runtime applications from connecting as dbs_migrator (DBS-119)`

### Bước 3 — Migration bước 7 (`1793664000000-CreateDbRolesAndGrants.ts`) & đồng bộ `infra/scripts/db-roles.sql` (DoD #1, DoD #4)
- **Mục tiêu:**
  - Viết migration TypeORM bước 7 `backend/src/database/migrations/1793664000000-CreateDbRolesAndGrants.ts` triển khai đầy đủ ma trận quyền §8.1 cho `dbs_api`, `dbs_worker`, và `dbs_migrator`, đổi chủ view `v_transfer_facts` sang `dbs_migrator`.
  - Cập nhật script `infra/scripts/db-roles.sql` đồng bộ 100% với migration.
- **Files:**
  - `backend/src/database/migrations/1793664000000-CreateDbRolesAndGrants.ts` *(mới)*
  - `infra/scripts/db-roles.sql` *(cập nhật)*
- **Test (viết trước — phải đỏ):**
  - Chạy test kiểm tra migration chưa tồn tại: `npm --prefix backend run test:db -- test/db/db-roles.db-spec.ts -t "TC-119-01"`
  - Kết quả đỏ: `TC-119-01 does not exist`.
- **Code tối thiểu để xanh:**
  - Viết class `CreateDbRolesAndGrants1793664000000` với `up()` và `down()` (trong `down()` hoàn tác view owner về `CURRENT_USER` trước khi thu hồi quyền).
  - Cập nhật `infra/scripts/db-roles.sql`.
- **Lệnh kiểm chứng:** `npm --prefix backend run typecheck && npm --prefix backend run lint:check` (exit code `0`).
- **Commit dự kiến:** `feat(database): add migration step 7 for least-privilege db roles and grants (DBS-119)`

### Bước 4 — Cập nhật và mở rộng DB integration tests `db-roles.db-spec.ts` (`TC-119-01` đến `TC-119-05`) (DoD #1, DoD #2, DoD #3, `BL-005`, `BL-017`)
- **Mục tiêu:**
  - Cập nhật `backend/test/db/db-roles.db-spec.ts` chạy trực tiếp `migrate(db.url)` (không cần nạp file SQL rời thủ công).
  - Kiểm tra toàn bộ 5 test cases:
    - `TC-119-01`: chu trình `migrate` idempotent (chạy 2 lần), revert `down()` và rerun `up()`.
    - `TC-119-02`: quyền `dbs_api`, từ chối `42501` khi sửa bảng chỉ-thêm (`BL-017`).
    - `TC-119-03`: quyền `dbs_worker`, đọc `v_transfer_facts` thành công dù không có quyền bảng `transfers` (`BL-005`), từ chối `42501` khi đọc bảng nhạy cảm / sửa số dư.
    - `TC-119-04`: guard chặn ứng dụng khi kết nối bằng `dbs_migrator` (DoD #2).
    - `TC-119-05`: quyền `dbs_migrator` chạy DDL và trigger `forbid_mutation` chặn `dbs_migrator` khi sửa bảng chỉ-thêm (`AC-8.1`).
- **Files:**
  - `backend/test/db/db-roles.db-spec.ts`
- **Lệnh kiểm chứng:** `npm --prefix backend run test:db -- test/db/db-roles.db-spec.ts && npm --prefix backend run test:db -- test/db/reconciliation-migration-revert.db-spec.ts` (exit code `0`).
- **Commit dự kiến:** `test(database): verify least-privilege roles, migrator guard and append-only trigger enforcement (DBS-119)`

### Bước 5 — Kịch bản test thủ công `manual-dbs119.cjs`, bằng chứng và tài liệu hệ thống (Phase 5)
- **Mục tiêu:**
  - Viết script `backend/scripts/manual-dbs119.cjs` thực thi chu trình M-119-01..04 trên PostgreSQL 17 thật.
  - Chạy ghi log vào `docs/features/screenshots/DBS-119/manual-test.txt` (dòng 1 là SHA commit code cuối).
  - Chụp ảnh màn hình `01-manual-db-roles.png`.
  - Cập nhật `docs/components/_shared/database-design.md`, `docs/BACKLOG.md` (xóa BL-005, BL-017; cập nhật BL-019, BL-103; thêm BL-182 theo dõi PR review).
  - Cập nhật `docs/features/README.md` và `docs/features/DBS-119-db-roles-grant-matrix.md`.
- **Files:**
  - `backend/scripts/manual-dbs119.cjs` *(mới)*
  - `docs/features/screenshots/DBS-119/manual-test.txt` *(mới)*
  - `docs/features/screenshots/DBS-119/01-manual-db-roles.png` *(mới)*
  - `docs/components/_shared/database-design.md`
  - `docs/BACKLOG.md`
  - `docs/features/README.md`
  - `docs/features/DBS-119-db-roles-grant-matrix.md`
- **Lệnh kiểm chứng:**
  - `node backend/scripts/manual-dbs119.cjs` (exit code `0`).
  - 6 lệnh kiểm tra: `npm --prefix backend run lint:check && npm --prefix backend run typecheck && npm --prefix backend test -- --runInBand && npm --prefix backend run test:db -- --runInBand && npm --prefix backend run test:e2e -- --runInBand && node .agents/skills/dbs-delivering-task/scripts/check-doc-links.mjs` (exit code `0`).
- **Commit dự kiến:**
  - `test(database): add manual verification script for db roles and grants (DBS-119)`
  - `docs(database): record DBS-119 verification results and evidence`

### Rà soát kế hoạch (Plan sweep)

| Hạng mục kiểm tra | Kết quả |
|---|---|
| Mọi `TC-119-xx` trong §4 đều xuất hiện trong một bước | Đạt — `TC-119-01`..`05` ở Bước 4; guard unit test ở Bước 2 |
| Không bước nào chạm hai module nghiệp vụ mà không có lý do | Đạt — chỉ chỉnh sửa trong hạ tầng database, test fixture, và script kiểm thử |
| Migration tiến và lùi sạch | Đạt — Bước 3 triển khai đầy đủ `up()` và `down()`, Bước 4 kiểm chứng hoàn tác |
| Không can thiệp vào các bảng append-only | Đạt — không chèn hoặc xóa trực tiếp trên `transfers`/`ledger_entries`/`audit_log` |
| Danh sách tài liệu cần cập nhật ở Phase 5 đã liệt kê đủ | Đạt — `database-design.md`, `BACKLOG.md`, `docs/features/README.md`, `DBS-119-db-roles-grant-matrix.md` |
| Không làm gãy các migration revert test hiện có | Đạt — Bước 1 cô lập target trong `reconciliation-migration-revert.db-spec.ts` trước khi thêm Migration 7 |

### Rollback
- Nếu cần lùi: `git revert` các commit trên nhánh `feat/DBS-119-db-roles-grant-matrix`. Rollback migration bằng `npm run migration:revert`.

## 8. Kết quả

### 8.1 Lệnh kiểm tra và kết quả tự động

| Lệnh | Kết quả quan sát | Ghi chú |
|---|---|---|
| `npm --prefix backend run lint:check` | `PASS` (0 errors, 0 warnings) | Mã nguồn và test tuân thủ đầy đủ eslint + prettier |
| `npm --prefix backend run typecheck` | `PASS` (0 errors) | TypeScript compile không lỗi |
| `npm --prefix backend test -- --runInBand` | `PASS` (69 test suites, 1129 tests) | Unit tests toàn bộ backend đạt 100% |
| `npm --prefix backend run test:db -- test/db/db-roles.db-spec.ts` | `PASS` (1 suite, 7 tests, 5.53s) | Toàn bộ 5 test case `TC-119-01`..`05` đạt trên PostgreSQL 17 thật |
| `npm --prefix backend run test:db -- test/db/reconciliation-migration-revert.db-spec.ts` | `PASS` (1 suite, 11 tests, 77.44s) | 11/11 tests revert reconciliation tiếp tục đạt 100% không bị ảnh hưởng |
| `node .agents/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `PASS` (0 broken links) | Toàn bộ liên kết markdown hợp lệ |

### 8.2 Bảng đối chiếu test case (DoD / AC Traceability)

| ID | Tên test case | File test | Trạng thái |
|---|---|---|---|
| `TC-119-01` | migration step 7 creates dbs_migrator, dbs_api, dbs_worker, is idempotent, and reverts/re-applies cleanly | `backend/test/db/db-roles.db-spec.ts` | `PASS` |
| `TC-119-02` | real API flows run as dbs_api: users row, deposit, transfer, replay, open account, revocation | `backend/test/db/db-roles.db-spec.ts` | `PASS` |
| `TC-119-02` | dbs_api cannot change history, other columns, or read worker tables (BL-017) | `backend/test/db/db-roles.db-spec.ts` | `PASS` |
| `TC-119-03` | dbs_worker reads transfers only through view v_transfer_facts, manages worker tables, and cannot touch money (BL-005) | `backend/test/db/db-roles.db-spec.ts` | `PASS` |
| `TC-119-03` | the real outbox relay runs as dbs_worker with only its grants | `backend/test/db/db-roles.db-spec.ts` | `PASS` |
| `TC-119-04` | assertNotMigratorUser guard blocks applications from connecting as dbs_migrator (DoD #2) | `backend/test/db/db-roles.db-spec.ts` & `src/database/database-url.guard.spec.ts` | `PASS` |
| `TC-119-05` | dbs_migrator owns public DDL/DML but append-only tables are protected by forbid_mutation trigger (AC-8.1) | `backend/test/db/db-roles.db-spec.ts` | `PASS` |

### 8.3 Kết quả test thủ công (Phase 4c)

- **Script thực thi:** `node backend/scripts/manual-dbs119.cjs`
- **Output thô:** [`docs/features/screenshots/DBS-119/manual-test.txt`](screenshots/DBS-119/manual-test.txt)
- **SHA commit code cuối (dòng 1 của manual-test.txt):** `0109155011d61db406cc06b2dc001371711aa975`

| Bước | Mô tả và kết quả quan sát thật | Trạng thái |
|---|---|---|
| **M-119-01** | Tạo database tạm trên PostgreSQL 17 thật; chạy migration bước 7 `CreateDbRolesAndGrants1793664000000`; kiểm tra `pg_roles` có đủ 3 role `dbs_api`, `dbs_migrator`, `dbs_worker`; kiểm tra `pg_views` xác nhận `v_transfer_facts` thuộc quyền sở hữu của `dbs_migrator`; chạy lại migration up lần 2 thành công (idempotent); chạy `undoLast` (`down()`) xác nhận hoàn tác owner về `CURRENT_USER` và thu hồi quyền; chạy lại `up` phục hồi owner `dbs_migrator` | `Đạt` |
| **M-119-02** | Cấp mật khẩu và kết nối vai `dbs_api`; khởi động ứng dụng NestJS; nạp tiền 5.000.000 qua operator (201); chuyển tiền 1.500.000 (201); replay idempotency với cùng key trả 201 cùng body; cố ý chạy `UPDATE ledger_entries` và `DELETE FROM transfers` bị PostgreSQL từ chối với lỗi `42501 permission denied`; kiểm tra bất biến sổ cái `checkLedgerInvariants` trả `PASS` | `Đạt` |
| **M-119-03** | Kết nối vai `dbs_worker`; truy vấn `SELECT id, amount, status FROM v_transfer_facts` trả về dòng giao dịch 1.500.000 (`COMPLETED`); cố ý truy vấn trực tiếp bảng `transfers` bị PostgreSQL từ chối với lỗi `42501 permission denied for table transfers` (chứng minh dứt điểm `BL-005`) | `Đạt` |
| **M-119-04** | Kết nối vai `dbs_migrator`; thực thi DDL tạo bảng tạm `dbs_manual_migrator_test`, insert và drop bảng thành công; cố ý `UPDATE ledger_entries` bị trigger `forbid_mutation` chặn với mã `42501` và thông điệp `append-only` (AC-8.1); cố ý khởi động ứng dụng với `DATABASE_URL` chứa username `dbs_migrator` bị guard `assertNotMigratorUser` chặn bootstrap (DoD #2) | `Đạt` |
| **M-119-cleanup** | Đóng app HTTP, hủy các kết nối DataSource, drop database tạm thời và dừng container PostgreSQL Testcontainers sạch sẽ | `Đạt` |

### 8.4 Ảnh chụp bằng chứng

![Kết quả kiểm thử thủ công DBS-119](screenshots/DBS-119/01-manual-db-roles.png)

**Sau rebase (techlead review PR #99, 2026-11-09):** rebase lên `main` `18f93dc`; giữ cả `TC-92-13` (DBS-92) và `TC-119-04/05` trong `db-roles.db-spec.ts`. `db-roles.db-spec` và `reconciliation-migration-revert.db-spec` chạy lại trên PostgreSQL 17 thật: 19/19 đạt; unit `src/database` 49/49; lint và typecheck sạch; tập lệnh `GRANT` của migration và `infra/scripts/db-roles.sql` đã so từng dòng, khớp 100%. `BL-181` của PR bị đánh lại thành `BL-194` vì main đã dùng `BL-181`. Rủi ro review phát hiện, chưa kiểm được ở đây: đổi chủ view trên RDS bằng user master (`BL-195`). Bằng chứng `manual-test.txt` và ảnh là của lượt trước rebase.

### 8.5 Độ lệch so với kế hoạch (Deviations)
- Không có độ lệch nào so với kế hoạch đã được phê duyệt ở Gate G3.

### 8.6 Bàn giao và trạng thái Backlog
- **Đóng dứt điểm `BL-005`:** Quyền sở hữu view `v_transfer_facts` được chuyển giao cho `dbs_migrator`, cho phép `dbs_worker` truy vấn view giao dịch mà không có quyền trên bảng `transfers`. Đã xóa khỏi `docs/BACKLOG.md`.
- **Đóng dứt điểm `BL-017`:** Ma trận quyền ACL tối thiểu được PostgreSQL thực thi ở tầng DB, ngăn chặn hoàn toàn thao tác `UPDATE/DELETE` trên các bảng chỉ-thêm (`transfers`, `ledger_entries`, `audit_log`). Đã xóa khỏi `docs/BACKLOG.md`.
- **Cập nhật `BL-019`:** Ghi nhận DBS-119 đã hoàn tất production role grants và AC-8.1/8.2 checks trên PostgreSQL thật.
- **Cập nhật `BL-103`:** Ghi nhận DBS-119 đã hoàn tất tạo role và grants qua Migration bước 7 và `infra/scripts/db-roles.sql`.
- **Mở mới `BL-194`:** Theo dõi quy trình DoD #5: PR merge vào main (CI xanh, Dev review và điền bảng «Đối chiếu test case»).

---

## 9. Tài liệu đã cập nhật

- `backend/src/database/migrations/1793664000000-CreateDbRolesAndGrants.ts`: Migration TypeORM bước 7 tạo roles, đổi owner view `v_transfer_facts` và cấp quyền theo ma trận §8.1.
- `infra/scripts/db-roles.sql`: Cập nhật script SQL đồng bộ bổ sung `dbs_migrator`, sequence grants và owner view.
- `backend/src/database/database-url.guard.ts`: Guard `assertNotMigratorUser` cấm ứng dụng runtime kết nối bằng `dbs_migrator`.
- `backend/src/database/database-url.guard.spec.ts`: Unit test cho guard URL.
- `backend/src/database/database.module.ts`: Tích hợp guard vào `buildTypeOrmOptions`.
- `backend/test/support/deposit-app.ts`: Tích hợp guard vào test fixture `startDepositApp`.
- `backend/test/db/db-roles.db-spec.ts`: Cập nhật bộ test tích hợp Postgres 17 thật phủ 5 ca `TC-119-01`..`05`.
- `backend/test/db/reconciliation-migration-revert.db-spec.ts`: Cô lập migration target bảo vệ test suite revert reconciliation.
- `backend/scripts/manual-dbs119.cjs`: Script kiểm thử thủ công PostgreSQL 17 thật.
- `docs/features/screenshots/DBS-119/manual-test.txt`: Log kết quả test thủ công có SHA commit code cuối ở dòng 1.
- `docs/features/screenshots/DBS-119/01-manual-db-roles.png`: Ảnh chụp terminal test thủ công.
- `docs/components/_shared/database-design.md`: Cập nhật §8.1, §8.3, §11 khớp migration bước 7.
- `docs/BACKLOG.md`: Xóa BL-005, BL-017; cập nhật BL-019, BL-103; thêm BL-194 theo dõi DoD #5.
- `docs/features/README.md`: Bổ sung dòng task DBS-119 vào danh mục tính năng.
- `docs/features/DBS-119-db-roles-grant-matrix.md`: Hoàn thành toàn diện hồ sơ tính năng DBS-119.



