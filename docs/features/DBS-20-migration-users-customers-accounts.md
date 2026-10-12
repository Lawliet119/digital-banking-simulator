# DBS-20 · Migration 1: users, customers, accounts và tài khoản SYSTEM funding

> **Status:** Implemented (chờ G4) · **Vai:** #1 Ledger · **Cặp đôi:** #4 Fraud · **Nhánh:** `feat/DBS-20-migration-users-customers-accounts` · **PR:** — · **Cập nhật:** 2026-10-12

## 1. Bối cảnh

- **Task trên board:** Story, Tuần 1, ưu tiên Highest, Deliverable/Demo **P2**. Tóm tắt: "Migration 1: users, customers, accounts và tài khoản SYSTEM funding".
- **Expect:** "Bảng nền tồn tại và chính DB bảo vệ các bất biến của tài khoản."
- **DoD** (chép nguyên văn):
  1. Bảng users (cognito_sub UNIQUE, sessions_revoked_at), customers (user_id UNIQUE), accounts đúng database-design §4; khóa chính uuid qua gen_random_uuid(); mọi cột thời gian là timestamptz
  2. Ràng buộc: accounts_balance_non_negative, accounts_owner_matches_type, type/status CHECK, index accounts_single_system (đúng một tài khoản SYSTEM)
  3. Tài khoản SYSTEM funding id cố định được tạo trong migration (seed trong migration, không phải script rời)
  4. SnakeNamingStrategy bật; cột tiền là bigint
  5. migration:run → migration:revert → migration:run xanh trên DB trống (kiểm bằng docker compose cho tới khi có Testcontainers)
  6. Kiểm tay hoặc bằng script: chèn khách có số dư âm, SYSTEM thứ hai, SYSTEM có customer_id, CHECKING không có customer → đều bị DB từ chối
  7. PR đã merge vào main (CI xanh); #4 review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:** không có ("làm được ngay"). Trạng thái thật trong repo:
  - `backend/src/database/migrations/` rỗng; [`data-source.ts`](../../backend/src/database/data-source.ts) (CLI) và [`database.module.ts`](../../backend/src/database/database.module.ts) (app) đã có, `synchronize: false`, `migrationsRun: false`. Khớp cột "Thực trạng" của board.
  - Chưa có `SnakeNamingStrategy` ở đâu; `typeorm-naming-strategies` không có trong `package.json`.
  - Chưa có harness Testcontainers (việc của #6); `test/` chỉ có e2e dùng `fake-data-source.ts`.
  - **Chưa có `.github/workflows/`** (CI là việc của #5), nên phần "CI xanh" của DoD #7 chưa kiểm được ở PR này.
  - `docker-compose.yml` đã chạy Postgres 17 với `timezone=UTC` (điểm 12 của database-design §13 đã xong).
- **Đã có gì để dựa vào:** [database-design §4.1, §4.2, §5, §11, §12](../components/_shared/database-design.md), [ADR-09](../adr/0009-funding-system-account.md) (một hàng `funding`), [ADR-07](../adr/0007-nestjs-typeorm-explicit-sql.md) (`SnakeNamingStrategy`), [ADR-02](../adr/0002-postgresql-ledger.md), README của module [`accounts`](../../backend/src/modules/accounts/README.md) và [`identity`](../../backend/src/modules/identity/README.md). Chưa có feature doc nào trước task này.
- **Baseline** (nhánh mới từ `main` 15b27f0, 2026-10-12): `lint:check` sạch, `typecheck` sạch, `npm test` 11 suite / 120 test đạt, `npm run test:e2e` 3 suite / 20 test đạt.
- **Ghi chú môi trường local:** máy này có một PostgreSQL cài trên Windows cũng nghe `localhost:5432`, che mất container. Khi kiểm, container được map thêm cổng `5433` bằng file override ngoài repo và `DATABASE_URL` trỏ `localhost:5433`. Không thay đổi gì trong repo vì chuyện này.
- **Ngoài phạm vi:**
  - Entity TypeORM cho `users`/`customers`/`accounts` và mọi service (`AccountsService`, upsert `users`…): thuộc module `identity`/`accounts` của #2, làm ở task của họ.
  - Bảng khác (migration 2–7 ở database-design §11), trigger `forbid_mutation`, role `dbs_api`/`dbs_worker` và `GRANT`: task riêng.
  - Giới hạn 3 tài khoản/khách (BR-14): không biểu diễn được bằng ràng buộc DB, thuộc task mở tài khoản.
  - Workflow CI và harness Testcontainers (#5, #6).
- **Câu hỏi mở** (kèm đề xuất):
  1. **Giá trị id cố định của `funding`.** Tài liệu chỉ nói "id cố định", chưa chốt giá trị. *Đề xuất:* `00000000-0000-4000-8000-000000000001` (đúng định dạng uuid v4, dễ nhận ra trong log). Migration ghi literal (migration là lịch sử, không import hằng số có thể đổi sau); ghi giá trị này vào database-design §11.
  2. **Hằng số `FUNDING_ACCOUNT_ID` trong code.** *Đề xuất:* chưa thêm ở task này (chưa ai dùng; module `accounts` là của #2). Task nạp tiền sẽ export nó từ `@modules/accounts` và test rằng nó bằng hàng đã seed.
  3. **`SnakeNamingStrategy`: thêm dependency hay tự viết.** Thêm thư viện là gate phụ. *Đề xuất:* tự viết `backend/src/database/snake-naming.strategy.ts` (~30 dòng, kế thừa `DefaultNamingStrategy`, dùng `snakeCase` có sẵn trong `typeorm/util/StringUtils`), có unit test; gắn vào cả `data-source.ts` lẫn `DatabaseModule`. Không thêm package.
  4. **Kiểm ràng buộc bằng gì khi chưa có Testcontainers.** *Đề xuất:* một bộ test Jest riêng `test/db/*.db-spec.ts`, chạy bằng script mới `npm run test:db`, nối Postgres qua `DATABASE_URL` (docker compose). Mỗi lần chạy tạo một database tạm tên ngẫu nhiên, chạy `migration:run` → `revert` → `run` qua API `DataSource` của TypeORM, chèn từng hàng sai và kiểm mã lỗi Postgres `23514` / `23505` kèm **tên ràng buộc**, rồi `DROP DATABASE`. Không đưa vào `test:e2e` để e2e hiện tại vẫn chạy không cần Docker. Khi #6 làm xong harness thì chỉ đổi chỗ lấy kết nối.
  5. **`WITH (fillfactor = 80)` và `accounts_customer_idx`** có trong SQL §4.2 nhưng DoD không nhắc. *Đề xuất:* làm đúng như §4.2 (DoD #1 nói "đúng database-design §4").
  6. **`accounts.updated_at`** không có trigger tự cập nhật trong thiết kế. *Đề xuất:* giữ đúng thiết kế (code ghi `updated_at` khi đổi số dư/trạng thái, cột này có trong danh sách `GRANT UPDATE` ở §8.1); không thêm trigger.
  7. **DoD #7 "CI xanh"** không làm được vì repo chưa có CI. *Đề xuất:* ghi ở PR là chưa có CI, dán kết quả chạy local (bốn lệnh + `test:db`); phần đó đóng khi #5 có pipeline.

**Quyết định ở G1 (2026-10-12):** duyệt cả 7 đề xuất trên.

## 2. Kiến trúc

- **Vị trí:** tầng hạ tầng dùng chung `backend/src/database/`, không thuộc module nghiệp vụ nào. Migration chạy như một bước riêng trong pipeline (`npm run migration:run:prod`), không chạy ở role `api` hay `worker` (ADR-13, `DatabaseModule` đã tắt `migrationsRun`).
- **File thêm / sửa:**

| File | Việc |
|---|---|
| `src/database/migrations/1791763200000-CreateUsersCustomersAccounts.ts` | **Mới.** Class `CreateUsersCustomersAccounts1791763200000 implements MigrationInterface`; `up` tạo 3 bảng, index, seed `funding`; `down` xóa ngược thứ tự |
| `src/database/snake-naming.strategy.ts` | **Mới.** `class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface` |
| `src/database/data-source.ts` | Thêm `namingStrategy`; tách `createMigrationDataSource(url: string \| undefined): DataSource` (export có tên) để test dùng **đúng** cấu hình mà CLI dùng; `export default createMigrationDataSource(process.env.DATABASE_URL)` |
| `src/database/database.module.ts` | Tách factory thành `export function buildTypeOrmOptions(db, app): TypeOrmModuleOptions` (để unit test được), thêm `namingStrategy: new SnakeNamingStrategy()` |
| `test/jest-db.js`, `test/db/*.db-spec.ts`, `test/support/temp-database.ts` | **Mới.** Bộ test trên Postgres thật (đề xuất 4 ở G1) |
| `package.json` | Thêm script `"test:db": "jest --config ./test/jest-db.js"`; không thêm dependency |

- **Interface dùng:** `MigrationInterface { up(queryRunner: QueryRunner): Promise<void>; down(queryRunner: QueryRunner): Promise<void> }` và `DefaultNamingStrategy`, `snakeCase` từ `typeorm` 0.3.31 (`typeorm/util/StringUtils`, đã kiểm import được).
- **Interface cung cấp:** schema của 3 bảng (hợp đồng cho #2 viết entity sau này) và hàng `funding` có id `00000000-0000-4000-8000-000000000001`. Không có endpoint, event, `ErrorCode`, env var mới.
- **Dữ liệu** (đối chiếu database-design §4.1, §4.2, §5):

| Bảng | Cột | Ràng buộc / index (tên tường minh để test kiểm theo tên) |
|---|---|---|
| `users` | `id uuid PK DEFAULT gen_random_uuid()`, `cognito_sub text NOT NULL`, `sessions_revoked_at timestamptz NULL`, `created_at timestamptz NOT NULL DEFAULT now()` | `users_pkey`, `users_cognito_sub_key UNIQUE (cognito_sub)` |
| `customers` | `id uuid PK DEFAULT gen_random_uuid()`, `user_id uuid NOT NULL`, `full_name text NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()` | `customers_pkey`, `customers_user_id_key UNIQUE (user_id)`, `customers_user_id_fkey → users(id) ON DELETE RESTRICT` |
| `accounts` | `id uuid PK DEFAULT gen_random_uuid()`, `customer_id uuid NULL`, `type text NOT NULL`, `status text NOT NULL DEFAULT 'ACTIVE'`, `balance bigint NOT NULL DEFAULT 0`, `created_at`, `updated_at timestamptz NOT NULL DEFAULT now()`; `WITH (fillfactor = 80)` | `accounts_pkey`, `accounts_customer_id_fkey → customers(id) ON DELETE RESTRICT`, `accounts_type_check`, `accounts_status_check`, `accounts_balance_non_negative`, `accounts_owner_matches_type`, unique index một phần `accounts_single_system ON (type) WHERE type = 'SYSTEM'`, `accounts_customer_idx ON (customer_id) WHERE customer_id IS NOT NULL` |

  Khác SQL mẫu ở §4.1–4.2 đúng hai chỗ, đều để khớp quy tắc của chính tài liệu đó: ghi `ON DELETE RESTRICT` tường minh (quy tắc 8, checklist §12; mặc định của Postgres là `NO ACTION`), và đặt tên tường minh cho mọi `CHECK`/`UNIQUE`/`FK` (quy ước tên ở §11). Tên trùng với tên Postgres tự sinh, nên SQL mẫu vẫn đúng.

  Index dùng cho truy vấn nào (checklist §12): `accounts_customer_idx` cho "danh sách tài khoản của khách" (UC-4) và `COUNT` khi mở tài khoản (BR-14); `accounts_single_system` chỉ để giữ bất biến. Không index `balance`/`status` (để `UPDATE` là HOT, §9).
- **Ranh giới transaction:** TypeORM mặc định (`migrationsTransactionMode: 'all'`) bọc các migration đang chờ trong một transaction; toàn bộ `up` (DDL + seed) commit cùng nhau hoặc không gì cả. Không có `CREATE INDEX CONCURRENTLY` (bảng mới, rỗng) nên không cần tắt transaction.
- **Sơ đồ:**

```mermaid
flowchart LR
  subgraph Pipeline / local
    CLI["npm run migration:run<br/>(data-source.ts → createMigrationDataSource)"]
  end
  subgraph test:db
    T["*.db-spec.ts"] -->|CREATE DATABASE dbs_test_xxx| PG
    T -->|createMigrationDataSource(urlTạm)<br/>runMigrations / undoLastMigration| PG
    T -->|INSERT hàng sai → mong lỗi 23514/23505/23503 + tên ràng buộc| PG
    T -->|DROP DATABASE| PG
  end
  CLI -->|BEGIN; CREATE TABLE ×3; INDEX ×2; INSERT funding; INSERT migrations; COMMIT| PG[(PostgreSQL 17<br/>timezone=UTC)]
  APP["DatabaseModule (api/worker)<br/>namingStrategy = SnakeNamingStrategy<br/>không chạy migration"] --> PG
```

- **Thay đổi cấp hệ thống:** bảng mới nhưng đã có sẵn trong thiết kế; chỉ cần sửa trong cùng PR: database-design §11 (giá trị id `funding`; mục Quy ước ghi "tự viết `SnakeNamingStrategy`", `test:db`), header "Verified against code" của database-design, `backend/README.md` (bảng lệnh và dòng "Trước khi mở PR": thêm `npm run test:db`). Không đổi ADR, event contract, `ErrorCode`, env var.
- **Việc bàn giao cho vai khác (phát hiện ở domain review, không làm trong PR này):**
  - **#3 (event contract):** schema này ép `funding` có `customer_id NULL`, nên với `TransferCompleted` có `type = DEPOSIT`, `fromUserId` không có giá trị, trong khi [event-contract](../components/_shared/event-contract.md) khai kiểu `uuid` (không null). Đề xuất: `fromUserId: uuid | null` (null khi `DEPOSIT`) và `sameOwner = false`. Sửa ở PR của contract.
  - **#1 (task chuyển tiền):** id `funding` cố định nên dễ đoán (quy tắc 7 dựa vào việc uuid khó đoán). Sync guard hiện chỉ đòi hai tài khoản `ACTIVE`. Đề xuất: lệnh `TRANSFER` có nguồn hoặc đích là `type = 'SYSTEM'` bị từ chối `ACCOUNT_NOT_ACTIVE`, giống tài khoản không tồn tại.
  - **#5 (CI):** pipeline chạy `npm run test:db` với service Postgres 17 `timezone=UTC`, `DATABASE_URL` trỏ vào service đó.

## 3. Hành vi

Không có API. "Hành vi" ở đây là những gì DB chấp nhận và từ chối. Mã lỗi là SQLSTATE của Postgres; test kiểm **cả** `code` **và** `constraint` của lỗi `pg` (không kiểm câu chữ).

**3.1 Sau `migration:run` trên DB trống**
- Có 3 bảng `users`, `customers`, `accounts` và bảng `migrations` của TypeORM có đúng 1 dòng `CreateUsersCustomersAccounts1791763200000`.
- Có đúng một hàng trong `accounts`: `id = '00000000-0000-4000-8000-000000000001'`, `customer_id = NULL`, `type = 'SYSTEM'`, `status = 'ACTIVE'`, `balance = 0`.
- `users` và `customers` rỗng (không seed người dùng demo, §11).

**3.2 Ràng buộc**

| Thao tác | Kết quả | `code` / `constraint` |
|---|---|---|
| `INSERT accounts (customer_id = c, type 'CHECKING', balance -1)` | từ chối | `23514` / `accounts_balance_non_negative` |
| Như trên với `balance 0` | chấp nhận (biên) | — |
| `UPDATE` tài khoản `CHECKING` có số dư 100 thành `-1` | từ chối | `23514` / `accounts_balance_non_negative` |
| `UPDATE accounts SET balance = -500 WHERE id = funding` | **chấp nhận** (SYSTEM được âm, ADR-09) | — |
| `INSERT accounts (customer_id NULL, type 'SYSTEM')` (SYSTEM thứ hai) | từ chối | `23505` / `accounts_single_system` |
| `INSERT accounts (customer_id = c, type 'SYSTEM')` | từ chối | `23514` / `accounts_owner_matches_type` |
| `INSERT accounts (customer_id NULL, type 'CHECKING')` (và `SAVINGS`) | từ chối | `23514` / `accounts_owner_matches_type` |
| `type = 'CREDIT'` hoặc `'checking'` (chữ thường), với `customer_id = C`, `balance 0` | từ chối | `23514` / `accounts_type_check` |
| `status = 'CLOSED'`, với `customer_id = C`, `type 'CHECKING'` | từ chối | `23514` / `accounts_status_check` |
| `customer_id` không tồn tại | từ chối | `23503` / `accounts_customer_id_fkey` |
| `DELETE customers` còn tài khoản | từ chối | `23503` / `accounts_customer_id_fkey` |
| `users` trùng `cognito_sub` | từ chối | `23505` / `users_cognito_sub_key` |
| `customers` thứ hai cùng `user_id` | từ chối | `23505` / `customers_user_id_key` |
| `customers.user_id` không tồn tại | từ chối | `23503` / `customers_user_id_fkey` |
| `DELETE users` còn customer | từ chối | `23503` / `customers_user_id_fkey` |
| Số dư `9007199254740993` (2^53 + 1) | lưu và đọc lại nguyên vẹn dạng chuỗi `'9007199254740993'` | — |
| Số dư `9223372036854775807` (max `bigint`) | lưu và đọc lại nguyên vẹn dạng chuỗi | — |
| `UPDATE … SET balance = balance + 1` trên giá trị max | từ chối (tràn số; ledger sau này sẽ gặp mã này nếu cộng tràn) | `22003` |

Mỗi hàng sai trong test chỉ vi phạm **đúng một** ràng buộc. Postgres kiểm các `CHECK` theo thứ tự tên, nên một hàng vi phạm hai ràng buộc sẽ báo cái có tên đứng trước, và test sẽ khẳng định sai thứ.

Ví dụ lỗi `pg` mà test kiểm (chỉ hai trường này):

```json
{ "code": "23514", "constraint": "accounts_balance_non_negative" }
```

**3.3 Revert:** `migration:revert` xóa `accounts`, `customers`, `users` (ngược thứ tự FK) và dòng trong `migrations`; chạy `migration:run` lần nữa cho lại đúng trạng thái 3.1 (vẫn một hàng `funding`, cùng id).

`DROP TABLE` xóa luôn dữ liệu, và `npm run migration:revert` chạy vào bất cứ DB nào `DATABASE_URL` trỏ tới. Vì vậy `down` **tự kiểm trước khi xóa**: chỉ revert khi DB còn đúng trạng thái 3.1. Điều kiện là `users` rỗng, `customers` rỗng, `accounts` có đúng 1 hàng và hàng đó có `balance = 0`. Sai một điều kiện là `throw new Error('Refusing to revert CreateUsersCustomersAccounts…: tables hold data')`; transaction migration rollback, không bảng nào bị xóa. Trên DB trống (DoD #5) revert vẫn chạy bình thường.

**3.4 `SnakeNamingStrategy`:** tên thuộc tính camelCase của entity thành cột snake_case: `sessionsRevokedAt` → `sessions_revoked_at`, `cognitoSub` → `cognito_sub`; tên đặt tay (`@Column({ name: 'x' })`) giữ nguyên; cột khóa ngoại của quan hệ `customer` → `customer_id`. Tên bảng: entity phải ghi tên bảng tường minh (`@Entity('accounts')`), vì chiến lược sẽ sinh số ít (`account`). Áp dụng cho cả app (`DatabaseModule`) và CLI (`data-source.ts`).

**3.5 Bảo mật** (checklist trong `references/testing-and-security.md`):

| Yêu cầu | Áp dụng? |
|---|---|
| Role guard, ownership 404, idempotency, audit REJECTED/DENIED, ẩn cờ fraud, `ProblemDetailsFilter` | Không áp dụng: task không có endpoint |
| SQL tham số hóa | Migration chỉ có SQL tĩnh, không ghép đầu vào; test chèn dữ liệu bằng tham số `$1…` |
| Ít PII | `users` chỉ giữ `cognito_sub`, không email/số điện thoại (§4.1); `customers.full_name` theo thiết kế. Kiểm ở TC-20-01 (danh sách cột chính xác) |
| Không secret trong repo | Test đọc `DATABASE_URL` từ env; `env/.env.development` bị gitignore |
| TLS tới Postgres | Không đổi; `createMigrationDataSource` giữ `buildSslOptions` như hiện tại |
| Append-only / role DB | Không áp dụng ở bảng này; `GRANT` theo cột cho `accounts` thuộc migration 7 |

## 4. Test cases

Lớp "db" = `npm run test:db`, Postgres thật (docker compose), mỗi file một database tạm chạy migration thật. Lớp "unit" = `npm test`.

Quy ước của lớp db:
- `DATABASE_URL` lấy từ môi trường. Jest đặt `NODE_ENV=test` nên file `env/.env.development` **không** được nạp. Thiếu biến hoặc không kết nối được thì test **fail** với thông báo "chạy `docker compose up -d` và đặt `DATABASE_URL`". Không có chuyện tự bỏ qua để báo xanh giả.
- Helper chỉ `DROP` database do chính nó tạo (tiền tố `dbs_test_` + chuỗi ngẫu nhiên).
- Case nào ghi dữ liệu thì chạy trong `BEGIN … ROLLBACK`, nên các case độc lập nhau. Riêng TC-20-07 sửa số dư trực tiếp bằng `UPDATE`, **chỉ để thử ràng buộc** (chưa có API nạp tiền), và cũng được rollback. TC-20-13 và 18 dùng database riêng; TC-20-12 dùng chung database của file nhưng mọi case khác đều rollback nên nó luôn thấy trạng thái vừa migrate.

| ID | Truy vết | Lớp | Given · When · Then | Mã mong đợi |
|---|---|---|---|---|
| TC-20-01 | DoD #1, #4 | db | DB đã migrate · đọc `information_schema.columns` của 3 bảng · danh sách cột, kiểu (`uuid`, `text`, `bigint`, `timestamp with time zone`), `NULL`/`NOT NULL` và default (`gen_random_uuid()`, `now()`, `'ACTIVE'`, `0`) đúng bảng ở §2, không thừa cột | — |
| TC-20-02 | DoD #1 | db | DB đã migrate · tìm cột `timestamp without time zone`, `numeric`, `real`, `double precision`, `integer` trong 3 bảng · không có cột nào | — |
| TC-20-03 | DoD #1 | db | `users` có `cognito_sub = 'sub-a'` · chèn thêm `'sub-a'` · từ chối | `23505` / `users_cognito_sub_key` |
| TC-20-04 | DoD #1 | db | user U có customer · chèn customer thứ hai cho U · từ chối | `23505` / `customers_user_id_key` |
| TC-20-05 | DoD #1, quy tắc 8 | db | (a) chèn customer với `user_id` ngẫu nhiên · (b) xóa user còn customer · (c) chèn account với `customer_id` ngẫu nhiên · (d) xóa customer còn account · cả bốn bị từ chối | `23503` / `customers_user_id_fkey` (a, b), `accounts_customer_id_fkey` (c, d) |
| TC-20-06 | DoD #2, #6 | db | customer C · chèn `CHECKING` của C với `balance -1` · từ chối; với `balance 0` · chấp nhận; `UPDATE` thành `-1` · từ chối | `23514` / `accounts_balance_non_negative` |
| TC-20-07 | DoD #2, ADR-09 | db | hàng `funding` · `UPDATE balance = -500` · chấp nhận, đọc lại `'-500'` | — |
| TC-20-08 | DoD #2, #6 | db | đã có `funding` · chèn SYSTEM thứ hai (`customer_id NULL`) · từ chối | `23505` / `accounts_single_system` |
| TC-20-09 | DoD #2, #6 | db | customer C · chèn `SYSTEM` có `customer_id = C` · từ chối | `23514` / `accounts_owner_matches_type` |
| TC-20-10 | DoD #2, #6 | db | chèn `CHECKING` và `SAVINGS` với `customer_id NULL` · cả hai bị từ chối | `23514` / `accounts_owner_matches_type` |
| TC-20-11 | DoD #2 | db | customer C · chèn (`customer_id = C`, `balance 0`) với `type` = `'CREDIT'`, `'checking'` · từ chối; chèn (`customer_id = C`, `type 'CHECKING'`) với `status = 'CLOSED'` · từ chối | `23514` / `accounts_type_check`, `accounts_status_check` |
| TC-20-12 | DoD #3 | db | DB vừa migrate · `SELECT * FROM accounts` · đúng 1 hàng, giá trị như §3.1; `users`, `customers` rỗng | — |
| TC-20-13 | DoD #5 | db | database tạm trống · chạy **đúng ba lệnh CLI** `npm run migration:run` → `npm run migration:revert` → `npm run migration:run` (tiến trình con, `DATABASE_URL` = database tạm) · cả ba thoát mã 0; sau revert không còn 3 bảng và bảng `migrations` không còn dòng; sau lần chạy thứ hai có lại đúng 1 hàng `funding` cùng id | — |
| TC-20-14 | DoD #4, rủi ro 2^53 | db | customer C · chèn `CHECKING` với `balance = '9007199254740993'` (tham số chuỗi) · đọc lại bằng `pg` · nhận chuỗi `'9007199254740993'` | — |
| TC-20-15 | DoD #1 (§4.2), quy tắc 8 | db | DB đã migrate · đọc `pg_class.reloptions`, `pg_indexes`, `pg_constraint` · `accounts` có `fillfactor=80`; `accounts_single_system` là `UNIQUE … WHERE type = 'SYSTEM'`; `accounts_customer_idx` có `WHERE customer_id IS NOT NULL`; `customers_user_id_fkey` và `accounts_customer_id_fkey` có `confdeltype = 'r'` (RESTRICT, không phải `NO ACTION`/`CASCADE`) | — |
| TC-20-18 | §3.3 (review #1) | db | database đã migrate, có 1 user + 1 customer (hoặc `funding.balance = -1`) · `undoLastMigration` · ném lỗi "Refusing to revert", 3 bảng và dữ liệu còn nguyên, dòng `migrations` còn | — |
| TC-20-19 | DoD #4 (review #8) | db | customer C · chèn `balance = '9223372036854775807'` · đọc lại đúng chuỗi đó; `UPDATE … SET balance = balance + 1` · từ chối | `22003` |
| TC-20-20 | DoD #5 (review #4) | thủ công, log ở §7 | `npm run build && npm run migration:run:prod` vào một database trống · migration đã biên dịch trong `dist/` được nạp và chạy | — |
| TC-20-16 | DoD #4 | unit | `new SnakeNamingStrategy()` · `columnName('sessionsRevokedAt', undefined, [])` → `'sessions_revoked_at'`; tên đặt tay giữ nguyên; tiền tố embedded (`['audit']` + `createdAt` → `audit_created_at`); `joinColumnName('customer', 'id')` → `'customer_id'`; `tableName('Account', 'accounts')` → `'accounts'` | — |
| TC-20-17 | DoD #4 | unit | `buildTypeOrmOptions(db, app)` và `createMigrationDataSource('postgres://x').options` · cả hai có `namingStrategy` là `SnakeNamingStrategy`; `synchronize` và `migrationsRun` vẫn `false` | — |
| — | DoD #7 | quy trình | PR có bảng «Đối chiếu test case»; #4 review; CI: chưa có workflow (G1, quyết định 7) | — |

Mọi gạch đầu dòng DoD #1–#6 có ít nhất một case; DoD #7 là bước quy trình.

## 5. Domain review (AI)

**Reviewer:** subagent mới (không có lịch sử), model Claude Opus, ngày 2026-10-12 · **Kết quả:** 9 phát hiện (blocking 0, should-fix 6, minor 3), verdict REVISE → đã sửa doc như dưới.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | `down` xóa 3 bảng kèm dữ liệu, chỉ có một comment ngăn; `migration:revert` chạy được vào DB dùng chung | **Đã sửa** §3.3: `down` kiểm DB còn trạng thái ban đầu rồi mới xóa, nếu không thì `throw`. Thêm TC-20-18 |
| 2 | should-fix | Postgres kiểm `CHECK` theo thứ tự tên; TC-20-11 không nêu `customer_id` nên có thể nhận `accounts_owner_matches_type` thay vì `accounts_type_check` | **Đã sửa** §3.2, TC-20-11: ghi đủ Given; quy tắc "mỗi hàng sai vi phạm đúng một ràng buộc" |
| 3 | should-fix | Không test nào phân biệt `RESTRICT` với `NO ACTION` | **Đã sửa** TC-20-15: kiểm `pg_constraint.confdeltype = 'r'` |
| 4 | should-fix | TC-20-13 gọi API chứ không qua CLI thật như DoD #5; đường `dist/` chưa được kiểm | **Đã sửa** TC-20-13 chạy đúng 3 lệnh npm; thêm TC-20-20 (`migration:run:prod` từ `dist/`, log ở §7) |
| 5 | should-fix | `funding` không có chủ → `fromUserId` của `DEPOSIT` không có giá trị, trong khi contract khai `uuid` không null | **Không sửa ở PR này** (contract là của #3, không đổi trong task migration). Đã ghi ở §2 "Việc bàn giao", đề xuất `uuid \| null` |
| 6 | should-fix | Jest đặt `NODE_ENV=test` nên `.env.development` không được nạp; chưa rõ thiếu DB thì skip hay fail; `test:db` không nằm trong lệnh trước PR / CI | **Đã sửa** §4 (quy ước lớp db: fail, không skip), §2 (thêm `test:db` vào README "Trước khi mở PR"; bàn giao #5 cho CI). **Không** chặn host khác localhost: helper chỉ tạo/xóa database của chính nó, và CI sẽ dùng host service |
| 7 | minor | TC-20-07 sửa `funding` thẳng, TC-20-12 kỳ vọng 0; chưa chắc độc lập | **Đã sửa** §4: case ghi dữ liệu chạy trong `BEGIN … ROLLBACK`; TC-20-12/13/18 có database riêng; ghi rõ `UPDATE` số dư chỉ để thử ràng buộc |
| 8 | minor | Thiếu biên trên `bigint` và mã tràn số | **Đã sửa** §3.2, thêm TC-20-19 (`22003`) |
| 9 | minor | Id `funding` dễ đoán; sync guard chưa cấm `TRANSFER` vào SYSTEM | **Không sửa ở PR này** (id cố định đã duyệt ở G1, guard thuộc task chuyển tiền). Ghi ở §2 "Việc bàn giao" |

**Quyết định ở G2 (2026-10-12):** duyệt thiết kế. Ba câu hỏi theo đề xuất: (1) ghi chú contract ở §2 và nhắc lại trong mô tả PR cho #3; (2) chặn `TRANSFER` vào SYSTEM để cho task chuyển tiền; (3) thêm `npm run test:db` vào dòng "Trước khi mở PR" của `backend/README.md`.

## 6. Kế hoạch triển khai

Mọi lệnh chạy từ `backend/`. Ở máy này `DATABASE_URL=postgres://banking:banking_local_only@localhost:5433/banking` (xem §1, ghi chú môi trường). Mỗi bước: viết test → chạy, thấy đỏ **đúng lý do** → viết code tối thiểu → xanh → commit.

| Bước | File | Test viết trước | Lệnh chứng minh | Commit |
|---|---|---|---|---|
| 1 | `src/database/snake-naming.strategy.ts` (mới) | TC-20-16: `src/database/snake-naming.strategy.spec.ts`. Đỏ vì module chưa tồn tại | `npm test -- snake-naming` | `feat(database): add SnakeNamingStrategy` |
| 2 | `src/database/database.module.ts` (tách `buildTypeOrmOptions`), `src/database/data-source.ts` (tách `createMigrationDataSource`), cả hai gắn `namingStrategy` | TC-20-17: `src/database/typeorm-options.spec.ts`. Đỏ vì hai hàm chưa export / chưa có `namingStrategy` | `npm test -- typeorm-options` | `feat(database): enable snake_case naming for app and CLI` |
| 3 | `test/jest-db.js`, `test/support/temp-database.ts` (tạo/xóa database `dbs_test_<hex>`, fail khi thiếu `DATABASE_URL`), script `test:db` trong `package.json` | Bộ khung `test/db/accounts-schema.db-spec.ts` với TC-20-12 (hàng `funding`). Đỏ vì bảng `accounts` không tồn tại (migration chưa có), **không** phải vì lỗi kết nối | `npm run test:db` | gộp với bước 4 |
| 4 | `src/database/migrations/1791763200000-CreateUsersCustomersAccounts.ts`: `up` (3 bảng, 2 index, seed `funding`) | TC-20-01, 02, 03–11, 12, 14, 15, 19 trong `accounts-schema.db-spec.ts`; viết hết trước, chạy thấy đỏ, rồi viết `up` | `npm run test:db` | `feat(database): migration 1 users, customers, accounts and funding account` |
| 5 | Cùng file migration: `down` có kiểm "DB còn trạng thái ban đầu" | TC-20-13 (ba lệnh CLI qua `execFileSync`) và TC-20-18 trong `test/db/migration-revert.db-spec.ts`; TC-20-18 đỏ khi `down` chưa có kiểm | `npm run test:db` | `feat(database): guard migration 1 revert against data loss` |
| 6 | — | TC-20-20 kiểm tay | `npm run build && DATABASE_URL=<db trống> npm run migration:run:prod` (dán log vào §7) | — |
| 7 | `backend/README.md`, `docs/components/_shared/database-design.md` §11 + header, `docs/features/README.md`, feature doc §7–§8 | — | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(database): record migration 1 and test:db` |
| 8 | — | Toàn bộ | `npm run lint:check && npm run typecheck && npm test && npm run test:e2e && npm run test:db`, ảnh chụp ở `docs/features/screenshots/DBS-20/` | — |

Không có controller, DTO, OpenAPI, audit, outbox: task không có endpoint và không ghi nghiệp vụ.

**Ảnh chụp dự kiến** (Phase 5): `01-migration-run-revert-run.png` (terminal ba lệnh CLI), `02-schema-accounts.png` (`\d accounts` trong psql: cột, CHECK, index), `03-funding-row.png` (`SELECT` hàng `funding`), `04-constraint-rejections.png` (kết quả `npm run test:db`).

**Rủi ro và cách lùi:**
- *Postgres trên Windows chiếm cổng 5432:* chỉ ảnh hưởng máy này; test lấy cổng từ `DATABASE_URL`, không ghi cứng.
- *`execFileSync('npm', …)` trên Windows cần `shell: true` hoặc `npm.cmd`:* helper chọn theo `process.platform`.
- *Tách factory của `DatabaseModule` làm đổi hành vi app:* `buildTypeOrmOptions` trả đúng object cũ cộng `namingStrategy`; TC-20-17 kiểm `synchronize`/`migrationsRun` vẫn `false`; `test:e2e` (`transaction-wiring`) chạy lại ở bước 8.
- *Cách lùi:* PR chỉ thêm file mới và hai thay đổi nhỏ trong `src/database/`; revert PR là đủ. Chưa có môi trường nào đã chạy migration này.

**Quyết định ở G3 (2026-10-12):** duyệt kế hoạch.

## 7. Kết quả

- **Lệnh kiểm tra** (chạy lúc bàn giao, 2026-10-12, nhánh `feat/DBS-20-migration-users-customers-accounts`, từ `backend/`, Postgres 17 của docker compose qua `localhost:5433`):

```text
npm run lint:check   → sạch (0 lỗi, 0 cảnh báo)
npm run typecheck    → sạch
npm test             → Test Suites: 13 passed, 13 total · Tests: 128 passed, 128 total   (baseline 11 / 120; +2 suite, +8 test)
npm run test:e2e     → Test Suites: 3 passed, 3 total   · Tests: 20 passed, 20 total     (không đổi)
npm run test:db      → Test Suites: 2 passed, 2 total   · Tests: 17 passed, 17 total     (mới)
```

  TC-20-20 (kiểm tay, `dist/`): `npm run build` rồi `DATABASE_URL=…/dbs_manual_prod npm run migration:run:prod` vào database trống. Output (rút gọn):

```text
query: CREATE UNIQUE INDEX accounts_single_system ON accounts (type) WHERE type = 'SYSTEM'
query: CREATE INDEX accounts_customer_idx ON accounts (customer_id) WHERE customer_id IS NOT NULL
query: INSERT INTO accounts (id, customer_id, type, status, balance)
      VALUES ('00000000-0000-4000-8000-000000000001', NULL, 'SYSTEM', 'ACTIVE', 0)
query: INSERT INTO "migrations"("timestamp", "name") VALUES ($1, $2) -- PARAMETERS: [1791763200000,"CreateUsersCustomersAccounts1791763200000"]
Migration CreateUsersCustomersAccounts1791763200000 has been executed successfully.
query: COMMIT
```

- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-20-01 | `test/db/accounts-schema.db-spec.ts` › TC-20-01 has exactly the designed columns, types, nullability and defaults | đạt |
| TC-20-02 | `accounts-schema.db-spec.ts` › TC-20-02 has no time column without time zone and no non-bigint number column | đạt |
| TC-20-03 | `accounts-schema.db-spec.ts` › TC-20-03 rejects a second user with the same cognito_sub | đạt |
| TC-20-04 | `accounts-schema.db-spec.ts` › TC-20-04 rejects a second customer for the same user | đạt |
| TC-20-05 | `accounts-schema.db-spec.ts` › TC-20-05 rejects dangling references and deleting a referenced row | đạt |
| TC-20-06 | `accounts-schema.db-spec.ts` › TC-20-06 rejects a negative customer balance, on insert and on update; 0 is allowed | đạt |
| TC-20-07 | `accounts-schema.db-spec.ts` › TC-20-07 lets the SYSTEM funding account go negative (ADR-09) | đạt |
| TC-20-08 | `accounts-schema.db-spec.ts` › TC-20-08 rejects a second SYSTEM account | đạt |
| TC-20-09 | `accounts-schema.db-spec.ts` › TC-20-09 rejects a SYSTEM account that has a customer | đạt |
| TC-20-10 | `accounts-schema.db-spec.ts` › TC-20-10 rejects a CHECKING or SAVINGS account without a customer | đạt |
| TC-20-11 | `accounts-schema.db-spec.ts` › TC-20-11 rejects an unknown type or status | đạt |
| TC-20-12 | `accounts-schema.db-spec.ts` › TC-20-12 creates exactly one SYSTEM funding account with the fixed id, and no users | đạt |
| TC-20-13 | `test/db/migration-revert.db-spec.ts` › TC-20-13 migration:run → migration:revert → migration:run is green on an empty database | đạt (ba lệnh npm thật, tiến trình con) |
| TC-20-14 | `accounts-schema.db-spec.ts` › TC-20-14 keeps an amount above 2^53 exact, as a string | đạt |
| TC-20-15 | `accounts-schema.db-spec.ts` › TC-20-15 accounts: fillfactor 80, partial indexes, RESTRICT foreign keys | đạt |
| TC-20-16 | `src/database/snake-naming.strategy.spec.ts` › SnakeNamingStrategy (6 test) | đạt |
| TC-20-17 | `src/database/typeorm-options.spec.ts` › TypeORM options (2 test) | đạt |
| TC-20-18 | `migration-revert.db-spec.ts` › TC-20-18 refuses to revert, and drops nothing, once the tables hold data | đạt |
| TC-20-19 | `accounts-schema.db-spec.ts` › TC-20-19 stores the bigint maximum and refuses to overflow it | đạt |
| TC-20-20 | kiểm tay `migration:run:prod` từ `dist/` (log ở trên) | đạt |
| DoD #6 "kiểm tay" | psql chèn 4 hàng sai, ảnh 03 | đạt |
| DoD #7 | PR, review, CI | PR mở sau G4; **CI chưa làm**: repo chưa có CI (quyết định G1 số 7), ghi ở [BL-001](../BACKLOG.md) |

- **Ảnh chụp** (`docs/features/screenshots/DBS-20/`). Ảnh dựng từ output thật của các lệnh (chép nguyên văn, chỉ lọc dòng `query:` ở ảnh 01), hiển thị kiểu terminal bằng Chrome headless:

![migration:run → revert → run trên database trống, cả ba thoát mã 0](screenshots/DBS-20/01-migration-run-revert-run.png)

![\d accounts: cột, CHECK, index một phần, FK ON DELETE RESTRICT](screenshots/DBS-20/02-schema-accounts.png)

![Hàng funding và bốn hàng sai của DoD #6 bị DB từ chối](screenshots/DBS-20/03-db-rejects-bad-rows.png)

![npm run test:db: 17 test đạt](screenshots/DBS-20/04-test-db-results.png)

- **Lệch so với kế hoạch:**
  - Helper test dùng `DataSource`/`QueryRunner` của TypeORM thay vì `pg.Client`: repo không có `@types/pg`, và thêm nó là thêm dependency (gate phụ). Lỗi `QueryFailedError` của TypeORM mang nguyên `code` và `constraint` của `pg`, nên test vẫn kiểm theo SQLSTATE và tên ràng buộc.
  - TC-20-13 gọi `node $npm_execpath run …`, không qua shell (tránh cảnh báo `DEP0190` của Node). Vì vậy bộ `test:db` phải được chạy bằng `npm run test:db`; chạy `npx jest` thẳng thì TC-20-13 báo lỗi rõ ràng.
  - TC-20-12 dùng chung database của file (đã sửa ghi chú ở §4).
- **Việc để lại cho vai khác:** xem §2 "Việc bàn giao", đã ghi vào [`docs/BACKLOG.md`](../BACKLOG.md): BL-001 (CI, gồm `test:db`), BL-002 (contract `fromUserId` khi `DEPOSIT`), BL-003 (chặn `TRANSFER` vào/ra SYSTEM). Entity của `users`/`customers`/`accounts` làm ở task của #2.

## 8. Tài liệu đã cập nhật

- [`docs/components/_shared/database-design.md`](../components/_shared/database-design.md): header "Verified against code"; §11 Quy ước (`SnakeNamingStrategy` tự viết, tên ràng buộc, `test:db`), Dữ liệu khởi tạo (id `funding`), Nguyên tắc triển khai (`down` tự kiểm trước khi `DROP`).
- [`backend/README.md`](../../backend/README.md): bảng lệnh (`test:db`), dòng "Trước khi mở Pull Request", mục 6 Migration.
- [`docs/features/README.md`](README.md): thêm dòng DBS-20.
- [`docs/BACKLOG.md`](../BACKLOG.md) (file mới): BL-001, BL-002, BL-003; [`docs/README.md`](../README.md): link tới backlog.
