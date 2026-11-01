# DBS-52 · Tạo dòng users bằng upsert theo cognito_sub ở token hợp lệ đầu tiên

<!-- Tài liệu làm việc: §1 điền ở Phase 1 (G1). §2–§9 điền ở các phase sau. -->

> **Status:** Implemented (sau G4, 2026-11-01) · **Vai:** Dev · **Cặp đôi review:** Dev khác (chưa chỉ định) · **Nhánh:** `feat/DBS-52-users-upsert-first-token` · **PR:** — · **Cập nhật:** 2026-11-01

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 2, ưu tiên High, Deliverable/Demo P2, Status "To Do" (cần bạn chuyển sang In Progress). Vai board `Dev` khớp loại việc (backend code, không có migration).
- **Expect:** "Mọi người dùng hợp lệ đều có dòng users mà không cần bước đăng ký riêng."
- **DoD** (chép nguyên văn):
  1. Upsert trong guard hoặc service được gọi sau khi verify token; ánh xạ sub → userId cache trong tiến trình
  2. Test Postgres thật: 20 request đầu tiên song song của cùng một sub → đúng 1 dòng users, không lỗi unique
  3. Áp dụng cho cả customer, operator, auditor, admin
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Thực trạng (board):** docs/03 §12 và database-design §4.1: dòng `users` tạo bằng `INSERT … ON CONFLICT (cognito_sub) DO NOTHING` ở token hợp lệ đầu tiên của mọi vai trò; ánh xạ `sub → users.id` không bao giờ đổi. Chưa có code. **Đã kiểm bằng grep:** không có chỗ nào trong `backend/src` ghi vào `users` ngoài migration.
- **Phụ thuộc** (cả ba đều có thật trong repo):

| Task | Board | Thực tế trong repo |
|---|---|---|
| DBS-50 JwtAuthGuard + JWKS | Done | Có trên `main` (PR #29). `request.user = { sub, groups, tokenUse, claims }`. |
| DBS-20 migration `users`, `customers`, `accounts` | Done | Có: `1791763200000-CreateUsersCustomersAccounts.ts`. `users(id uuid PK default gen_random_uuid(), cognito_sub text NOT NULL, sessions_revoked_at, created_at)`, ràng buộc `users_cognito_sub_key UNIQUE (cognito_sub)`. |
| DBS-39 Testcontainers Postgres | Done | Có: `test/support/postgres.container.ts`, `temp-database.ts`, `jest-db.js`. |

- **Đã có gì:**
  - [`jwt-auth.guard.ts`](../../backend/src/modules/identity/jwt-auth.guard.ts): sau `verifyAccessToken` gán `request.user`; chưa đụng DB. Route `@Public()` bỏ qua guard nên không bao giờ upsert.
  - [`jwt-claims.ts`](../../backend/src/modules/identity/jwt-claims.ts): `AuthenticatedUser` chưa có `userId`.
  - [`identity.module.ts`](../../backend/src/modules/identity/identity.module.ts): chỉ có `JwksVerifierService`, `JwtAuthGuard`, `IdentityController`; chưa có `IdentityService` (README module đã hứa `IdentityService.revokeSessions`, task khác làm).
  - [`database.module.ts`](../../backend/src/database/database.module.ts): `@Global()`, export `TransactionService`; `IdentityService` dùng `TransactionService` này (không dùng `DataSource` trực tiếp).
  - [`problem-details.filter.ts`](../../backend/src/common/filters/problem-details.filter.ts): lỗi DB tạm thời (`isTransientDbError`) tự ra **503 + `SERVICE_TEMPORARILY_UNAVAILABLE`**, không cần mã mới.
  - Mẫu test: `test/db/accounts-service.db-spec.ts` (DB tạm đã migrate), `test/identity.e2e-spec.ts` (JWKS giả trong RAM, **không** có DB), `test/app-guard.e2e-spec.ts` (AppModule thật).
  - Quyền DB: ma trận database-design §8 cho `dbs_api` `users` = S I U (`sessions_revoked_at`), nên upsert chạy được bằng role production, không cần xin thêm quyền.
- **Người gọi (grep) của symbol sẽ đổi:** `AuthenticatedUser` (thêm `userId`): `jwt-auth.guard.ts`, `identity.controller.ts`, `index.ts`, `jwt-auth.guard.spec.ts`. `JwtAuthGuard` (thêm phụ thuộc): `app.module.ts`, `identity.module.ts`, `identity.controller.ts`, `jwt-auth.guard.spec.ts`. Khi guard cần DB, `identity.e2e-spec.ts` (hiện không có DB) phải cấp thêm provider; sẽ nêu ở §3.
- **Baseline** (2026-11-01, `main` = `5ff4c8c`, Postgres compose remap cổng 5433 vì máy có PostgreSQL native trên 5432, xem [DBS-51 §1](DBS-51-roles-guard-current-user.md)):

| Lệnh | Kết quả |
|---|---|
| `npm run lint:check` | sạch |
| `npm run typecheck` | sạch |
| `npm test` | 42 suites, **576 test** đạt |
| `npm run test:e2e` | 8 suites, **57 test** đạt |
| `npm run test:db` | 13 suites, **301 test** đạt (Postgres Testcontainers, ~217 s) |

- **Backlog cùng module** (`docs/BACKLOG.md`): `BL-030` đã cũ (PR #29 đã merge), thuộc chủ DBS-50, không đụng. `BL-112` (hai test cooldown của `jwks-verifier.service.spec.ts` lúc đỏ khi máy bận) không liên quan, giữ nguyên; guard spec sẽ bị chạm nhưng verifier spec thì không. Không dòng nào được đưa vào phạm vi.
- **Ngoài phạm vi:**
  - Tạo dòng `customers` (onboarding, task accounts khác); chỉ tạo `users`.
  - `sessions_revoked_at` và `SESSION_REVOKED`, cache Redis `revoked_at:{userId}` (task thu hồi phiên).
  - `@Roles`, `RolesGuard`, `@CurrentUser` (DBS-51, làm ngay sau task này; dùng `request.user.userId` do task này cấp).
  - Token mẫu và `AUTH_MODE=local` (DBS-53).
  - Chuyển `dbs_api` sang role riêng (BL-103).
- **Câu hỏi mở:** đã trình ở tin nhắn G1 (9 câu, mỗi câu có đề xuất).
- **Quyết định ở G1 (2026-11-01):** duyệt G1 theo đề xuất của agent, gồm: (2) upsert đặt ở `IdentityService.resolveUserId(sub)`, `JwtAuthGuard` gọi sau khi verify và gán `request.user.userId`; (3) `ON CONFLICT (cognito_sub) DO NOTHING`, không dùng `DO UPDATE`; (4) cache `Map` giới hạn kích thước, cache cả promise đang chạy, không cache lỗi; (5) DB lỗi khi upsert thì 503 `SERVICE_TEMPORARILY_UNAVAILABLE` cho mọi route có JWT, không thêm `ErrorCode`; (8) test thủ công bằng script `manual-smoke.dbs52.ts` thay cho DBS-53. Chi tiết (3) được chỉnh ở thiết kế, xem §2 "Ghi chú lệch so với G1" và câu hỏi 1 của G2.

## 2. Hành vi

**Quy tắc.** Sau khi `JwtAuthGuard` xác minh xong một access token (chữ ký, `iss`, `client_id`, `token_use`, `exp`), guard lấy `sub` từ claims **đã verify** và gọi `IdentityService.resolveUserId(sub)`. Kết quả là `users.id` (uuid) và được gán vào `request.user.userId`. Token chưa verify thì không bao giờ chạm DB. Route `@Public()` không có token nên không upsert.

| Điều kiện | Kết quả |
|---|---|
| Token hợp lệ, `sub` chưa có trong `users` | INSERT một dòng; trả `id` mới; request đi tiếp |
| Token hợp lệ, `sub` đã có (do request khác, tiến trình khác hoặc lần trước) | Không ghi gì; trả `id` cũ; `created_at` và `sessions_revoked_at` giữ nguyên |
| Nhiều request cùng `sub` mới chạy song song, trong một hoặc nhiều tiến trình | Đúng 1 dòng; mọi request nhận cùng `id`; không request nào lỗi unique |
| Mọi vai: nhóm `customer`, `operator`, `auditor`, `admin`, nhiều nhóm, hoặc không có nhóm | Cùng một đường, cùng kết quả. Vai trò không được lưu (database-design §4.1) |
| Không token, chữ ký sai, hết hạn, sai `iss`/`client_id`/`token_use` | 401 như DBS-50; **không** có dòng `users` nào được tạo (kẻ lạ không làm đầy bảng được) |
| Claim `sub` thiếu, không phải chuỗi, hoặc chuỗi rỗng (token đã verify nhưng sai hình dạng) | 401 `UNAUTHENTICATED`; không chạm DB |
| Lỗi DB tạm thời khi upsert (mất kết nối, `57P01`, `53300`, `ECONNREFUSED`, …) | 503 `SERVICE_TEMPORARILY_UNAVAILABLE` + `Retry-After: 5` qua `ProblemDetailsFilter`; không cache lỗi; request sau thử lại |
| Upsert phải chờ lâu hơn `DATABASE_LOCK_TIMEOUT_MS` (mặc định 2 s). Chỉ có hai nguyên nhân thật: một transaction khác **chưa commit** `INSERT` cùng `cognito_sub` (INSERT của ta chờ nó), hoặc một khóa bảng (`LOCK TABLE users`, `ALTER TABLE`). Dòng `users` đã commit **không** gây chờ: `ON CONFLICT DO NOTHING` không khóa dòng đã có và `SELECT` thường không bị `FOR UPDATE` chặn | `55P03` → 503 như trên, **không treo**; kết nối pool được trả lại |
| Lỗi DB khác (không phân loại là tạm thời) | 500 chung, không lộ SQL (hành vi sẵn có của filter) |

Ví dụ: `GET /v1/identity/me` với token của khách vừa tự đăng ký (không có nhóm):

```json
{
  "sub": "5b0d7c1e-3f4a-4c8e-9d2b-7a1e6f0c9a42",
  "groups": [],
  "tokenUse": "access",
  "userId": "0f6a3d52-8c1b-4e7a-b6d4-2c9e1a7f5b30",
  "claims": { "sub": "5b0d7c1e-…", "iss": "…", "client_id": "…", "token_use": "access", "exp": 1793000000, "iat": 1792999100 }
}
```

Lỗi DB tạm thời (problem+json, `Retry-After: 5`):

```json
{ "type": "about:blank", "title": "Service Unavailable", "status": 503,
  "detail": "Service temporarily unavailable — please retry.",
  "errorCode": "SERVICE_TEMPORARILY_UNAVAILABLE", "correlationId": "…" }
```

**Ca biên:** `sub` chứa ký tự SQL (`x'; DROP TABLE users;--`) được lưu nguyên văn vì truy vấn có tham số; `sub` dài 36 ký tự (UUID) là trường hợp thật; hai `sub` chỉ khác hoa/thường là hai user khác nhau (so sánh chính xác, không chuẩn hóa).

**Ghi chú lệch so với G1 (cần bạn xem ở G2):**
1. Ở G1 mình nói "cả hai câu SQL chạy trong một lần gọi". Không đúng: gộp thành một câu CTE (`WITH ins AS (INSERT … RETURNING id) SELECT … UNION ALL SELECT …`) có đua: câu SELECT dùng snapshot cũ nên có thể không thấy dòng mà request song song vừa commit. Thiết kế đúng là **hai câu riêng**: `INSERT … ON CONFLICT (cognito_sub) DO NOTHING RETURNING id`; nếu không trả dòng thì `SELECT id FROM users WHERE cognito_sub = $1`. Ở READ COMMITTED câu INSERT thứ hai chờ bên kia commit rồi trả rỗng, và câu SELECT sau đó thấy dòng đã commit (mỗi câu có snapshot mới). Hai câu nằm trong một `TransactionService.run` chỉ để có `lock_timeout`/`statement_timeout` (xem §3), không phải vì cần tính nguyên tử giữa chúng. Nếu bên giữ khóa `ROLLBACK`, một người chờ chèn được dòng và những người còn lại chờ người đó, rồi cùng nhận id.
2. Ở G1 câu 5 nói "DB lỗi thì 503". Thực tế `ProblemDetailsFilter` chỉ đổi 503 khi lỗi có mã phân loại được. **Lỗi hết thời gian chờ kết nối của pool** (`timeout exceeded when trying to connect`, pg-pool không gắn `code`) và `Connection terminated unexpectedly` hiện ra **500**. Đó là hành vi sẵn có của `pg-error.util.ts` cho mọi route chạm DB, không phải riêng task này. Đề xuất: không sửa util dùng chung trong PR này (ngoài phạm vi, đổi hành vi của mọi module), ghi `BL-NNN` cho việc phân loại hai lỗi này; test của task chỉ khẳng định 503 cho các mã đã phân loại.

## 3. Kiến trúc

- **Vị trí:** module `identity`, role `api` (module này chỉ nạp ở `api`/`both`, xem `modules/index.ts`).
- **Interface cung cấp (chữ ký thật sẽ viết):**

```ts
// backend/src/modules/identity/identity.service.ts (mới)
@Injectable()
export class IdentityService {
  constructor(private readonly tx: TransactionService) {}
  /** users.id của sub đã verify; tạo dòng ở lần đầu. Mapping không bao giờ đổi nên cache vĩnh viễn trong tiến trình. */
  resolveUserId(sub: string): Promise<string>;
}
// jwt-claims.ts: AuthenticatedUser thêm  userId: string
// jwt-auth.guard.ts: constructor(verifier, reflector, identity: IdentityService)
// index.ts: export { IdentityService }
```

- **Interface dùng:** `TransactionService` (global từ `DatabaseModule`), `JwksVerifierService`, `ErrorCode.UNAUTHENTICATED`.
- **Ranh giới transaction (đổi sau review vòng 2 #1):** hai câu lệnh chạy trong **một** `TransactionService.run(async manager => …)` ngắn, không phải hai `source.query` trần. Lý do: chỉ `withTransaction` đặt `lock_timeout` (mặc định 2 s) và `statement_timeout` (5 s) theo `set_config(…, true)` (`transaction.helper.ts`); hai câu trần có timeout 0 (chờ vô hạn). Mọi route đều cần token, nên một khóa treo trên `users` (migration dài, `LOCK` tay, một writer tương lai giữ transaction lâu) sẽ làm mỗi request của `sub` mới giữ một kết nối pool mãi và cạn pool của cả API. Có timeout thì chờ khóa quá hạn ra `55P03`, `57014`, hai mã mà `ProblemDetailsFilter` đã đổi thành 503. Bên trong `run` chỉ có hai câu SQL tới `users`: không Redis/HTTP/SQS (CONTRIBUTING §5), và chạy lại khi deadlock là an toàn (cả hai câu idempotent). Insert của hàng giữ khóa tới commit, tức vài mili giây.
- **Cache:** `Map<string, Promise<string>>` trong `IdentityService`, giới hạn `USER_ID_CACHE_MAX = 10_000` (hằng số trong code, không thêm biến môi trường), loại mục cũ nhất (LRU qua thứ tự chèn của `Map`: lần trúng thì xóa rồi chèn lại). Cache **promise đang chạy** để N request song song cùng `sub` chỉ phát một cặp câu lệnh (single-flight). Promise bị từ chối thì xóa khỏi cache ngay, **chỉ khi mục hiện tại vẫn chính là promise đó** (`if (cache.get(sub) === p) cache.delete(sub)`), vì LRU có thể đã loại mục và một lời gọi mới đã đặt promise khác cho cùng `sub`. Giả định ghi thành comment trong `resolveUserId`: id không bao giờ bị xóa hay đổi vì `dbs_api` không có `DELETE` trên `users` (database-design §8); môi trường dev chạy `migration:revert` rồi `run` khi tiến trình còn sống thì phải khởi động lại tiến trình. Không TTL vì `sub → id` bất biến. Hai tiến trình có hai cache riêng; tính đúng đắn dựa vào `ON CONFLICT`, không dựa vào cache.
- **Dữ liệu:** bảng `users` (`id`, `cognito_sub` UNIQUE `users_cognito_sub_key`), chỉ INSERT và SELECT. Không có migration, không đổi schema. `dbs_api` có S I U trên `users` (database-design §8) nên đủ quyền.
- **Module:** `IdentityModule` thêm `IdentityService` vào **cả `providers` và `exports`**. `JwtAuthGuard` làm `APP_GUARD` (`useClass` trong `AppModule`) được resolve từ injector của `AppModule`, nên mọi phụ thuộc của nó phải được `IdentityModule` export (hiện export `JwksVerifierService` vì lý do đó). Thiếu `exports` thì tiến trình `api` không boot (`Nest can't resolve dependencies of JwtAuthGuard`); TC-52-22 bắt lỗi này.
- **Người gọi bị đổi:** liệt kê ở §1, **bổ sung** `backend/src/scripts/manual-smoke.dbs50.ts` (boot `IdentityModule` riêng, không DB; header ghi "no Postgres needed"). Sau thay đổi, `JwtAuthGuard` cần `IdentityService` nên script này không boot nếu không sửa. Một provider anh em **không** thay được `IdentityService` khai báo trong `providers` của `IdentityModule` (và `JwtAuthGuard` resolve nó từ bên trong `IdentityModule`), nên cách "cấp `useValue` ở module của script" là sai. Cách đúng, tùy file: (1) `identity.e2e-spec.ts` dùng `Test.createTestingModule(...).overrideProvider(IdentityService).useValue({ resolveUserId: async () => '<uuid cố định>' })`; (2) `manual-smoke.dbs50.ts` dùng `NestFactory.create` (không có `overrideProvider`) nên thêm một `@Global()` module giả xuất `TransactionService` giả: `run(fn)` gọi `fn({ query: async () => [{ id: '<uuid cố định>' }] })`, để `IdentityService` thật vẫn dựng được mà script không cần Postgres; cập nhật header của script cho khớp. Đây là các đổi file **ngoài phạm vi ban đầu** của §1, được liệt kê ở §7. Interface cho DBS-51: trường tên `userId: string`, không bao giờ `undefined` sau guard (guard ném 401/503 thay vì để trống); ghi trong PR và README identity. Test thật với Postgres đặt ở `test/db/` (job CI `e2e` có service Postgres nhưng không chạy migration, nên không có bảng `users`: `ci.yml` job `e2e`).
- **Sơ đồ:**

```mermaid
sequenceDiagram
    participant C as Client
    participant G as JwtAuthGuard
    participant V as JwksVerifierService
    participant S as IdentityService (cache)
    participant DB as PostgreSQL users
    C->>G: GET /v1/... Bearer token
    G->>V: verifyAccessToken(token)
    V-->>G: claims (đã verify) | 401
    G->>S: resolveUserId(claims.sub)
    alt đã cache (kể cả đang chạy)
        S-->>G: userId
    else chưa cache
        S->>DB: INSERT … ON CONFLICT (cognito_sub) DO NOTHING RETURNING id
        alt trả dòng
            DB-->>S: id
        else xung đột (dòng đã có hoặc đang được commit)
            S->>DB: SELECT id WHERE cognito_sub = $1
            DB-->>S: id
        end
        S-->>G: userId (rồi ghi vào cache)
    end
    G-->>C: request.user = {sub, groups, userId, …}
```

- **Thay đổi cấp hệ thống:** không sửa ADR hay docs/03 (tài liệu đã mô tả đúng ý). Phase 5 sửa `backend/src/modules/identity/README.md` (export mới); thêm ghi chú ngoại lệ audit vào database-design §4.1 nếu G2 duyệt miễn.
- **Bàn giao cho người khác** (mỗi mục thành một `BL-NNN` ở Phase 5, ghi vào §8):

| Việc | Chủ đề xuất | Điều kiện đóng |
|---|---|---|
| `pg-error.util.ts`: hết thời gian chờ kết nối của pool (`timeout exceeded when trying to connect`) và `Connection terminated unexpectedly` không có `code` nên ra 500 thay vì 503, trên mọi route đã xác thực | Dev chủ foundation/data (common utils) | Hai lỗi được phân loại tạm thời, có test, route ra 503 + `Retry-After` |
| Audit cho việc cấp phát `users` (`user.provisioned`, actor hệ thống) | Dev chủ audit (DBS-56) | `AuditService` ghi được hành động này hoặc có ngoại lệ chính thức trong docs |
| `identity.e2e-spec.ts` và `manual-smoke.dbs50.ts` bị sửa trong PR này | Dev chủ DBS-50 (chỉ để biết, review PR) | PR được review. **Không tạo `BL-NNN`** (không còn việc dang dở), chỉ nêu trong mô tả PR |

Hai dòng đầu thành `BL-129` (lỗi pool) và `BL-130` (audit); `BL-131` ở §7 dành cho DoD #4 (quy trình PR) chưa kiểm được tới G4.

## 4. Test cases tự động

| ID | Truy vết | Lớp | Given · When · Then | `errorCode` |
|---|---|---|---|---|
| TC-52-01 | DoD #1 | unit | `TransactionService.run` giả chạy callback với `manager.query` giả; `resolveUserId('sub-a')` lần đầu; INSERT trả dòng → trả id; chỉ 1 lần gọi query, không có SELECT | — |
| TC-52-02 | DoD #1 | unit | INSERT trả rỗng (đã có) → chạy `SELECT id … WHERE cognito_sub = $1` và trả id đó; cả hai truy vấn dùng tham số, không nối chuỗi | — |
| TC-52-03 | DoD #1 | unit | Gọi lần hai cùng `sub` → trả id từ cache, `query` không bị gọi thêm | — |
| TC-52-04 | DoD #2 | unit | 20 lời gọi song song cùng `sub` mà `query` còn treo → đúng 1 INSERT; cả 20 nhận cùng id (single-flight) | — |
| TC-52-05 | DoD #1 | unit | `query` ném lỗi ở lần đầu → lời gọi ném lỗi; lần sau gọi lại `query` (lỗi không bị cache) và thành công | — |
| TC-52-06 | DoD #1 | unit | Điền 10.001 `sub` khác nhau → kích thước cache không vượt 10.000; `sub` cũ nhất bị loại, `sub` dùng gần đây vẫn trong cache | — |
| TC-52-07 | Bảo mật | unit | `sub` rỗng, không phải chuỗi (`undefined`, số) → `resolveUserId` ném, không gọi `query` | — |
| TC-52-08 | DoD #1 | unit (guard) | Verifier trả claims; guard gọi `identity.resolveUserId(claims.sub)` **sau** verify và gán `request.user.userId` | — |
| TC-52-09 | Bảo mật | unit (guard) | Verifier ném (hết hạn / chữ ký sai / lỗi lạ) → `resolveUserId` không bao giờ được gọi | `TOKEN_EXPIRED` / `UNAUTHENTICATED` |
| TC-52-10 | Bảo mật | unit (guard) | Route `@Public()` → không verify, không gọi `resolveUserId` | — |
| TC-52-11 | Bảo mật | unit (guard) | Claims đã verify nhưng `sub` thiếu/rỗng → 401, `resolveUserId` không gọi | `UNAUTHENTICATED` |
| TC-52-12 | DoD #1 | unit (guard) | `resolveUserId` ném lỗi DB → guard để lỗi đi tiếp (không đổi thành 401), để filter xử lý | — |
| TC-52-13 | DoD #2 | integration (Postgres thật) | DB tạm đã migrate; **20 `IdentityService` riêng**, mỗi cái một `DataSource` riêng (hoặc một `DataSource` có `extra: { max: 25 }`; mặc định của pg-pool là 10 nên 20 phiên không bao giờ cùng chờ, test treo tới `testTimeout` 120 s). Các `TransactionService` của case này dựng với `lockTimeoutMs` và `statementTimeoutMs` = 30 000, **lớn hơn hạn poll** (mặc định 2 s/5 s sẽ làm người chờ sớm nhất chết `55P03` trước khi poll thấy đủ 20 phiên, trên runner CI bận); thêm khẳng định không lời gọi nào bị từ chối `55P03`. Rào chắn thật: một transaction của test `INSERT` cùng `cognito_sub` và **chưa commit**; bắn 20 lời gọi `resolveUserId`; poll `pg_stat_activity` tới khi đủ 20 phiên khớp **`datname = <DB tạm> AND pid <> <pid giữ rào> AND wait_event_type = 'Lock' AND wait_event = 'transactionid' AND application_name = 'dbs52-race'`** (mỗi `DataSource` của case đặt `applicationName: 'dbs52-race'`, nên bộ lọc không phụ thuộc cách viết hoa/thường hay xuống dòng của câu SQL; không dùng `ltrim(query) LIKE …` vì `ltrim` một đối số chỉ bỏ dấu cách, không bỏ `\n`) (lọc kỹ vì `test:db` chạy song song các suite khác trên cùng server, ci.yml dòng 168; PG 17 báo `ON CONFLICT DO NOTHING` đang chờ là `Lock/transactionid`); poll có hạn riêng 10 s và báo lỗi rõ ràng khi hết hạn; rồi `COMMIT`. Đúng 1 dòng `users`, 20 lời gọi cùng id (bằng id của transaction giữ rào), không lỗi `23505` | — |
| TC-52-14 | DoD #2 | integration | Như TC-52-13 (cùng cách lọc và hạn poll) nhưng transaction giữ rào `ROLLBACK`: đúng một trong 20 người chờ chèn được dòng, 19 người còn lại chờ người đó rồi nhận cùng id; đúng 1 dòng, không `23505` | — |
| TC-52-14b | DoD #2 | integration | **20 lời gọi song song cùng `sub` mới qua MỘT `IdentityService`** (không rào) → đúng 1 dòng, cùng id. Case này chứng minh single-flight, **không** chứng minh `ON CONFLICT` (TC-52-13/14 làm việc đó); ghi rõ để không đọc nhầm | — |
| TC-52-15 | DoD #3 | integration | Token bốn vai (`customer`, `operator`, `auditor`, `admin`) cộng một token không có nhóm, mỗi bên một `sub` → năm dòng `users`, id khác nhau | — |
| TC-52-16 | DoD #1 | integration | Seed SQL một dòng `users` (có `sessions_revoked_at`, `created_at` cố định) → `resolveUserId` trả id đó; `created_at`, `sessions_revoked_at` không đổi; số dòng không đổi | — |
| TC-52-17 | Bảo mật | integration | `sub = "x'; DROP TABLE users;--"` → lưu nguyên văn, bảng `users` còn nguyên | — |
| TC-52-18 | DoD #1, #3 | db-spec HTTP (`test/db/`, JWKS giả trong RAM + DB tạm đã migrate; không đặt ở `test:e2e` vì job CI `e2e` không migrate) | Token hợp lệ không nhóm → `GET /v1/identity/me` 200, `userId` khớp dòng DB; gọi lần hai cùng `userId`; số dòng vẫn 1 | — |
| TC-52-19 | Bảo mật | db-spec HTTP | Token chữ ký sai / hết hạn / `token_use=id` → 401; số dòng `users` không tăng | `UNAUTHENTICATED`, `TOKEN_EXPIRED` |
| TC-52-20 | DoD #2 | db-spec HTTP | 20 request HTTP song song cùng `sub` mới → tất cả 200, cùng `userId`, 1 dòng (đường HTTP đầy đủ; cuộc đua DB đã chứng minh ở TC-52-13/14) | — |
| TC-52-21 | Phục hồi | db-spec HTTP | `jest.spyOn(TransactionService.prototype, 'run').mockRejectedValueOnce(lỗi 57P01)` (ép lỗi ở tầng thấp hơn để `IdentityService` và cache thật vẫn chạy) → 503 + `Retry-After` + `SERVICE_TEMPORARILY_UNAVAILABLE`; request kế tiếp cùng `sub` 200 và có đúng 1 dòng (chứng minh lỗi không bị cache) | `SERVICE_TEMPORARILY_UNAVAILABLE` |
| TC-52-22 | Hồi quy | e2e | `identity.e2e-spec.ts` (`overrideProvider(IdentityService)` bằng bản giả), `app-guard.e2e-spec.ts` (**`AppModule` thật boot được**: chứng minh `IdentityService` đã nằm trong `exports` của `IdentityModule`, nếu không `JwtAuthGuard` làm `APP_GUARD` không resolve được) vẫn đạt | — |
| TC-52-23 | Bảo mật | unit | INSERT trả rỗng **và** SELECT cũng rỗng (dòng bị xóa tay hoặc lỗi) → `resolveUserId` ném lỗi (500 chung), không trả `undefined`, không cache | — |
| TC-52-24 | Hồi quy | chạy tay (script, không phải jest) | `npx ts-node -r tsconfig-paths/register src/scripts/manual-smoke.dbs50.ts` từ `backend/` vẫn boot được sau thay đổi (xem §3 "Người gọi bị đổi", `TransactionService` giả) và 5 bước DBS-50 cho cùng kết quả như trước; không cần Postgres. Kết quả ghi ở §8 như một test thủ công, không tính vào số test jest | — |
| TC-52-25 | Phục hồi | db-spec HTTP | Chặn **thật** bằng một transaction của test giữ `INSERT` cùng `cognito_sub` **chưa commit** (một dòng đã commit không chặn được: `ON CONFLICT DO NOTHING` không khóa dòng đã có, `SELECT` thường không bị `FOR UPDATE` chặn). `lockTimeoutMs` của `TransactionService` đặt 300 ms. (a) `resolveUserId` ném `55P03` trong khoảng ~1 s, không treo. (b) Qua HTTP với JWKS giả: `GET /v1/identity/me` ra **503** `SERVICE_TEMPORARILY_UNAVAILABLE` + `Retry-After: 5` (đường thật khóa chờ → `55P03` → filter, khác TC-52-21 chỉ giả lỗi `57P01`). (c) Kiểm pool: giữ `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`, bắn **25 `sub` khác nhau đồng thời** (nhiều hơn `DATABASE_POOL_MAX` = 10, và khác `sub` nên single-flight không gộp được) → cả 25 nhận 503 `55P03`; sau khi nhả khóa, một `sub` mới nhận 200 trong `connectionTimeoutMillis` (5 s), chứng minh kết nối được trả lại. Một `sub` lặp 25 lần tuần tự không kiểm được pool nên không dùng | `SERVICE_TEMPORARILY_UNAVAILABLE` |
| TC-52-26 | Tính đúng cache | unit | Single-flight bị loại khỏi cache bởi LRU giữa chừng, rồi một lời gọi mới đặt promise thứ hai cùng `sub`; promise đầu bị từ chối → mục của promise thứ hai **vẫn còn** trong cache (xóa có điều kiện `cache.get(sub) === p`) | — |
| — | DoD #4 | quy trình | PR merge, CI xanh, Dev review, bảng đối chiếu: chưa làm tới bàn giao (xem §8, `BL-NNN`) | — |

**Bảng bảo mật** (`references/testing.md`): *vai trò đúng ở endpoint* và *kiểm sở hữu/404*: không áp dụng, task không tạo endpoint nghiệp vụ (DBS-51 và các task module làm). *SQL tham số hóa + đầu vào độc hại*: TC-52-02, TC-52-17. *Lỗi không lộ nội bộ, có `correlationId`*: TC-52-21 (qua filter). *Không PII trong log*: task không thêm log mới chứa `sub`; kiểm bằng grep ở Phase 4b. *Idempotency theo user*, *fraud flag*, *TLS*: không áp dụng. *Audit* (FR-AUD-01 "ghi nhật ký mọi thao tác thay đổi dữ liệu"): **quyết định thiết kế: miễn audit cho việc cấp phát `users`, cần bạn xác nhận ở G2 (câu 1).** FR-AUD-01 (Must) và NFR-AUD-01 không liệt kê ngoại lệ nào, nên việc miễn phải do người có thẩm quyền xác nhận, không phải do thiết kế tự quyết. Lý do đề xuất miễn: tạo `users` là hệ thống tự cấp phát ở lần xác thực đầu, không phải thao tác do người dùng hay nhân viên ra lệnh; `AuditService` (DBS-56) chưa merge (`modules/audit` mới có README); và ghi `audit_log` mỗi lần cấp phát kéo bảng audit vào đường xác thực của mọi route. Nếu duyệt, Phase 5 thêm ghi chú ngoại lệ vào database-design §4.1 và `BL-NNN` giao chủ audit (DBS-56) ghi hành động `user.provisioned` với `actor_user_id` NULL (hệ thống) khi `AuditService` có. Nếu không duyệt miễn, task này bị chặn bởi DBS-56 và phải đổi phạm vi.

## 5. Test thủ công

Điều kiện chạy: `docker compose up -d` (Postgres remap cổng 5433 ở máy này, `DATABASE_URL=postgres://banking:…@localhost:5433/banking`), `npm run migration:run` từ `backend/`. DBS-53 chưa có nên không có `auth:dev-token`: dùng script `backend/src/scripts/manual-smoke.dbs52.ts` (giữ trong repo, như DBS-50) dựng **JWKS giả trong RAM** và ký token từng vai. Script boot Nest thật gồm `IdentityModule` + `DatabaseModule` (cần để có `TransactionService`; `DatabaseModule` đòi `databaseConfig.KEY` và `appConfig.KEY`, nên script cấp một module config `@Global()` giả như `ManualSmokeAuthConfigModule` của DBS-50, đọc `DATABASE_URL` từ môi trường) trỏ vào DB compose, và gọi `GET /v1/identity/me` bằng HTTP thật.

Để từng bước quan sát được **số dòng ngay sau bước đó**, script có các chế độ riêng (đối số dòng lệnh), mỗi chế độ tự in `SELECT count(*) FROM users` và `SELECT id FROM users WHERE cognito_sub = $sub` bằng `DataSource` riêng sau mỗi bước: `main` (M-52-02…06), `rerun` (M-52-07: ký token **mới** với `sub` cố định của M-52-02 rồi gọi `/me` một lần), `outage` (M-52-08, 09). `psql` chỉ để đối chiếu chéo ở M-52-01 và cuối `main`. Seed SQL: **không dùng** (chỉ đọc `users`).

**Đặt lại DB trước khi chạy** (volume `pgdata` của compose giữ dòng từ lần chạy trước, và `dbs_api` không có `DELETE` trên `users`): dùng **một database riêng dùng một lần**, chỉ cần repo (không cần file override trên máy; nếu cổng 5432 bị chiếm thì remap theo `manual-testing.md`): `docker compose exec postgres psql -U banking -d postgres -c "DROP DATABASE IF EXISTS dbs52_manual" -c "CREATE DATABASE dbs52_manual"`, rồi `DATABASE_URL=postgres://banking:banking_local_only@localhost:<cổng>/dbs52_manual npm run migration:run`, và chạy script với cùng `DATABASE_URL`. Không `TRUNCATE users CASCADE` (xóa luôn `customers` và tài khoản SYSTEM `funding`) và không `down -v` (xóa mọi volume compose). Làm vậy N0 = 0 và các `sub` **cố định** (in ra, tái lập được) luôn là `sub` mới ở lần chạy `main` đầu. Chạy `main` lần hai trên cùng DB thì không còn dòng mới (đó là hành vi đúng của upsert, không phải lỗi); muốn chạy lại từ đầu thì đặt lại DB.

**Cách bàn giao điều khiển cho người chạy ở chế độ `outage`:** script boot khi Postgres đang chạy (TypeORM `retryAttempts: 5` làm boot lỗi nếu DB tắt), in `Tắt Postgres bây giờ (docker compose stop postgres), đợi 35 s rồi nhấn Enter`, **chờ Enter trên stdin**, gọi `/me`, in kết quả, rồi in `Bật lại Postgres (docker compose start postgres), đợi healthy rồi nhấn Enter`, chờ Enter, gọi `/me` lần nữa. `count(*)` bị bỏ qua trong lúc DB tắt, in lại ở cuối sau khi DB sống lại.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-52-01 | Tạo `dbs52_manual` và `migration:run` như trên; `docker compose exec postgres psql -U banking -d dbs52_manual -c "SELECT count(*) FROM users"` ghi lại N0 | N0 = 0 (DB mới) |
| M-52-02 | Script `main`: token khách tự đăng ký (không nhóm), `sub` là UUID cố định `5b0d7c1e-3f4a-4c8e-9d2b-7a1e6f0c9a42` (giống `sub` Cognito thật; tên khách chỉ là nhãn in ra, không vào token hay DB), gọi `/me` | 200, có `userId`; `psql -d dbs52_manual`: đúng 1 dòng mới có `cognito_sub` đó, id khớp |
| M-52-03 | Cùng token, gọi lại 3 lần | 200, cùng `userId`; script in `count(*)` = N0 + 1 |
| M-52-04 | Token `operator`, `auditor`, `admin` (mỗi vai một sub) | 200 cả ba, ba `userId` khác nhau; `count(*)` = N0 + 4 |
| M-52-05 | Script bắn **20 request song song** (`Promise.all`) cùng một sub mới | 20 phản hồi 200 cùng `userId`; `count(*)` = N0 + 5; không có 500 |
| M-52-06 | Token ký bằng khóa lạ, rồi token hết hạn, rồi không token | 401 `UNAUTHENTICATED`, 401 `TOKEN_EXPIRED`, 401; `count(*)` không đổi (N0 + 5) |
| M-52-07 | Chạy `rerun` (tiến trình mới: cache rỗng, **khóa RSA và JWKS mới**, nên token cũ không còn verify được). Ký **token mới với cùng `sub`** của M-52-02, gọi `/me` một lần | 200, **`userId` y hệt** bước M-52-02 (đọc từ DB, không từ cache); `count(*)` không đổi |
| M-52-08 | Script `outage`: sub UUID mới chưa từng gặp; `docker compose stop postgres`; **đợi 35 s** (hơn `idleTimeoutMillis` 30 s của pool, để kết nối chết bị loại và pool phải mở kết nối mới); gọi `/me` | **503** `SERVICE_TEMPORARILY_UNAVAILABLE`, header `Retry-After: 5`. Kết nối mới tới cổng đã đóng lỗi `ECONNREFUSED`, mã thuộc `TRANSIENT_NODE_CODES` nên ra 503 (`pg-error.util.ts`). Ra 500 là **lỗi cần điều tra**, không phải kết quả chấp nhận được: dừng, ghi nguyên văn, quay lại 4a. Ca lỗi pool timeout (`timeout exceeded when trying to connect`, không có `code`) là bằng chứng của `BL-NNN` và sẽ có bước riêng nếu tái hiện được ổn định, không gộp vào đây |
| M-52-09 | `docker compose start postgres`, đợi healthy, gọi lại `/me` cùng token | 200, có `userId`; đúng 1 dòng cho sub đó |

Bước M-52-08/09 là ca lỗi và phục hồi. Output thô lưu ở `docs/features/screenshots/DBS-52/manual-test.txt`, dòng đầu là SHA commit cuối đổi code.

## 6. Domain review (AI)

**Reviewer:** subagent mới mỗi vòng (không có ngữ cảnh task, vòng 2 không được đọc kết quả vòng 1), model `fable`, 2026-11-01 · **Vòng 1:** 9 phát hiện (blocking 2, should-fix 4, minor 3), verdict **REVISE** · [trả lời nguyên văn](screenshots/DBS-52/domain-review.md) · **Vòng 2:** 7 phát hiện (blocking 0, should-fix 4, minor 3), verdict **REVISE** · [trả lời nguyên văn](screenshots/DBS-52/domain-review-round2.md) · **Vòng 3:** 12 phát hiện (blocking 0, should-fix 7, minor 3, bàn giao 2), verdict **REVISE** · [trả lời nguyên văn](screenshots/DBS-52/domain-review-round3.md) · **Vòng 4:** 8 phát hiện (blocking 1, should-fix 2, minor 4, bàn giao 1), verdict **REVISE** · [trả lời nguyên văn](screenshots/DBS-52/domain-review-round4.md) · **Trần 3 vòng:** bạn đã chốt tối đa 3 vòng review nên **không chạy vòng 5**. Vòng 4 đã chạy trước khi có trần, mình vẫn xử lý hết phát hiện của nó. **Các chỗ sửa theo vòng 4 chưa được reviewer nào xem lại**, nên verdict cuối vẫn là **REVISE** (không phải APPROVE).

Mình đã kiểm các phát hiện 1, 2, 6, 7 với nguồn trước khi sửa: #2 đúng (`ci.yml` job `e2e` có service Postgres nhưng không có bước migrate, `jest-e2e.js` không có globalSetup); #7 đúng (`idleTimeoutMillis: 30_000` ở `database.module.ts`).

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | TC-52-13/14/20 không đua thật trên DB: single-flight cache nuốt cuộc đua, `ON CONFLICT` chưa được chứng minh | đã sửa §4: TC-52-13 dùng 20 `IdentityService` riêng (20 cache), rào bằng transaction giữ `INSERT` chưa commit, poll `pg_stat_activity` thấy 20 phiên chờ `Lock` rồi `COMMIT`; TC-52-14 là biến thể `ROLLBACK`; TC-52-14b giữ ca một service nhưng ghi rõ chỉ chứng minh single-flight |
| 2 | blocking | Test e2e có Postgres đặt ở `test:e2e`, CI không migrate nên thiếu bảng `users` | đã sửa §4 và §3: TC-52-18..21 chuyển sang `test/db/*.db-spec.ts` (DB tạm đã migrate) |
| 3 | should-fix | `IdentityService` phải nằm trong `exports` của `IdentityModule` vì `JwtAuthGuard` là `APP_GUARD` | đã sửa §3 (thêm mục "Module"); TC-52-22 nay khẳng định `AppModule` thật boot |
| 4 | should-fix | Thiếu `manual-smoke.dbs50.ts` trong danh sách người gọi | đã sửa §3: thêm vào danh sách, cấp `IdentityService` giả cho script, thêm TC-52-24 chạy lại script DBS-50. Ghi ở §7 là file ngoài phạm vi §1 ban đầu |
| 5 | should-fix | Audit (FR-AUD-01) ghi "không áp dụng" mà không có lý do | đã sửa §4: nêu lý do đề xuất miễn, **thành câu hỏi 2 ở G2** |
| 6 | should-fix | M-52-07 không chạy được: khóa RSA đổi sau mỗi lần chạy script, token cũ không verify | đã sửa §5: ký token mới cùng `sub` |
| 7 | minor | M-52-08 không xác định (500 hay 503 tùy kết nối cũ trong pool) | đã sửa §5: đợi 35 s cho kết nối chết bị loại; nếu vẫn 500 thì ghi "không đạt, đã biết" kèm bằng chứng cho `BL-NNN` |
| 8 | minor | Thiếu ca INSERT rỗng + SELECT rỗng | đã sửa §4: thêm TC-52-23 |
| 9 | minor | `sub` là tên người, giống PII, sẽ vào `manual-test.txt` | đã sửa §5: dùng UUID, tên chỉ là nhãn in ra |

**Vòng 2** (đã kiểm #1, #2 với `transaction.helper.ts`, `temp-database.ts`, `ci.yml`, `database-design.md` §9 trước khi sửa; reviewer cũng xác nhận đúng: upsert hai câu đúng dưới READ COMMITTED với COMMIT, ROLLBACK đồng thời; chỉ token đã verify chạm DB):

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| R2-1 | should-fix | Hai câu `source.query` trần không có `lock_timeout`/`statement_timeout` (mặc định 0 = chờ vô hạn): một khóa treo trên `users` làm cạn pool của cả API vì mọi route đều cần token | đã sửa §2, §3: chạy hai câu trong một `TransactionService.run` (timeout 2 s/5 s có sẵn, `55P03`/`57014` đã ra 503); thêm TC-52-25 (giữ khóa quá hạn → lỗi nhanh, 503, pool không cạn) |
| R2-2 | should-fix | Rào TC-52-13/14 có thể treo (pool mặc định 10 < 20 phiên) và poll không lọc nên suite song song khác có thể làm thỏa điều kiện sai | đã sửa §4: 20 `DataSource` hoặc `max: 25`; poll lọc `datname`, `pid`, `wait_event = 'transactionid'`, `query LIKE 'INSERT INTO users%'`; hạn poll 10 s có thông báo lỗi rõ |
| R2-3 | should-fix | M-52-01…06 cần `count(*)` giữa các bước nhưng script chạy một mạch | đã sửa §5: script tự in `count(*)` và `id` sau mỗi bước bằng `DataSource` riêng; có chế độ `main`, `rerun`, `outage`; `psql` chỉ đối chiếu chéo |
| R2-4 | should-fix | M-52-07 "chạy lại từ đầu" làm số đếm không xác định | đã sửa §5: chế độ `rerun` chỉ ký token mới cho `sub` cố định của M-52-02; mọi `sub` cố định |
| R2-5 | minor | LRU có thể loại promise đang chạy; lỗi của promise cũ xóa nhầm mục của promise mới | đã sửa §3: xóa có điều kiện `cache.get(sub) === p`; thêm TC-52-26 |
| R2-6 | minor | Cache không bao giờ hết hạn: dòng bị xóa/reset khi tiến trình còn sống để lại id cũ | đã sửa §3: ghi giả định vào comment (`dbs_api` không có DELETE, database-design §8); dev chạy `migration:revert`+`run` thì khởi động lại tiến trình. Không thêm cơ chế loại cache theo FK `23503` (quá mức cho rủi ro thấp) |
| R2-7 | minor (bàn giao) | Lỗi pool timeout và `Connection terminated unexpectedly` ra 500 trên mọi route đã xác thực | giữ nguyên: `BL-NNN` ở Phase 5, không sửa util chung trong PR này |

**Vòng 3** (reviewer đã xác nhận đúng: upsert hai câu dưới READ COMMITTED, ROLLBACK, retry deadlock, sự kiện chờ `Lock/transactionid` của PG 17, xóa cache có điều kiện, không chạm DB trước verify):

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| R3-1 | should-fix | Cách "cấp `useValue` ở module của script/e2e" sai: provider anh em không thay được `IdentityService` nằm trong `providers` của `IdentityModule`; `NestFactory.create` không có `overrideProvider` | đã sửa §3: e2e dùng `overrideProvider(IdentityService)`; script DBS-50 thêm `@Global()` module xuất `TransactionService` giả. TC-52-22/24 cập nhật |
| R3-2 | should-fix | TC-52-13/14 chạy trong `TransactionService.run` nên `lock_timeout` 2 s có thể giết người chờ sớm nhất trước khi poll thấy đủ 20 | đã sửa §4: `lockTimeoutMs` và `statementTimeoutMs` = 30 000 cho hai case này, thêm khẳng định không có `55P03` |
| R3-3 | should-fix | §2/TC-52-25 sai: dòng `users` đã commit không gây `55P03` (`ON CONFLICT DO NOTHING` không khóa, `SELECT` thường không bị `FOR UPDATE` chặn) | đã sửa §2 và §4: nguyên nhân thật là `INSERT` chưa commit cùng `sub` hoặc khóa bảng; TC-52-25 chặn bằng `INSERT` chưa commit, có biến thể `LOCK TABLE` |
| R3-4 | should-fix | TC-52-25 ghi "qua HTTP" nhưng không có bước HTTP; TC-52-21 chỉ giả `57P01` | đã sửa §4: TC-52-25 thành db-spec HTTP, `GET /me` ra 503 từ khóa chờ thật |
| R3-5 | should-fix | M-52-08/09 không nói cách script dừng chờ người tắt/bật Postgres | đã sửa §5: bắt tay qua stdin (Enter), `count(*)` bỏ qua lúc DB tắt |
| R3-6 | should-fix | M-52-08 chấp nhận cả 503 lẫn 500 | đã sửa §5: chỉ chấp nhận 503 (`ECONNREFUSED` thuộc `TRANSIENT_NODE_CODES`); 500 là lỗi cần điều tra, ca pool timeout tách riêng cho `BL-NNN` |
| R3-7 | should-fix | N0 = 0 không có bước tạo DB mới; `sub` cố định làm lần chạy thứ hai không còn "dòng mới" | đã sửa §5: thêm bước đặt lại DB (`down -v`, `up -d`, `migration:run`), nói rõ lần chạy hai trên cùng DB không thêm dòng |
| R3-8 | minor | `query LIKE 'INSERT…'` neo ở đầu chuỗi, template literal xuống dòng sẽ không khớp | đã sửa §4: dùng `ltrim(query)` |
| R3-9 | minor | ID TC lệch thứ tự, TC-52-24 ghi "unit/script" mà là chạy tay | đã sửa §4: sắp lại thứ tự, TC-52-24 ghi rõ "chạy tay (script, không phải jest)" kèm lệnh |
| R3-10 | minor | Audit (FR-AUD-01) chưa có quyết định | giữ là **câu hỏi 2 ở G2**; lý do thật là `AuditService` (DBS-56) chưa merge, không phải "không thể audit" (schema cho phép actor hệ thống). Sẽ ghi quyết định và `BL-NNN` nếu miễn |
| R3-11 | bàn giao | Hai lỗi pool không có `code` ra 500 trên mọi route đã xác thực | `BL-NNN` ở Phase 5 (đã có trong §3) |
| R3-12 | bàn giao | DBS-51 phụ thuộc `request.user.userId` | đã ghi §3: trường `userId: string`, không bao giờ `undefined` sau guard; ghi trong PR và README identity |

**Vòng 4** (reviewer xác nhận 1 phát hiện blocking là đúng: `ltrim` một đối số chỉ bỏ dấu cách):

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| R4-1 | blocking | Bộ lọc poll `ltrim(query) LIKE 'INSERT INTO users%'` không khớp SQL bắt đầu bằng xuống dòng (`ltrim` bỏ dấu cách, không bỏ `\n`); câu sửa của vòng 3 vẫn sai | đã sửa §4 TC-52-13/14: lọc theo `application_name = 'dbs52-race'` do 20 `DataSource` đặt, không phụ thuộc cách viết câu SQL |
| R4-2 | should-fix | Script thủ công mô tả `IdentityModule` + `TypeOrmModule` thì không boot: `IdentityService` cần `TransactionService`, chỉ có từ `DatabaseModule` (đòi `databaseConfig`/`appConfig`) | đã sửa §5: script import `DatabaseModule` kèm module config `@Global()` giả như `ManualSmokeAuthConfigModule` |
| R4-3 | should-fix | TC-52-25(c) "lặp 25 lần cùng `sub`" không kiểm được pool (single-flight gộp, tuần tự nhả kết nối) | đã sửa §4: giữ `LOCK TABLE`, bắn 25 `sub` khác nhau đồng thời (> `poolMax` 10), kỳ vọng 25 lỗi 503 rồi một `sub` mới 200 sau khi nhả khóa |
| R4-4 | should-fix | Audit (FR-AUD-01 Must) để ngỏ như câu hỏi, chưa có người có thẩm quyền quyết | đã sửa §4: viết thành quyết định thiết kế "miễn audit" cần xác nhận ở **G2 câu 1**, kèm hai nhánh (duyệt: ghi ngoại lệ vào database-design §4.1 + `BL-NNN` cho DBS-56; không duyệt: task bị chặn bởi DBS-56) |
| R4-5 | minor | §1 còn câu cũ "`@InjectDataSource()` dùng được như `AccountsService`" | đã sửa §1 |
| R4-6 | minor | TC-52-21 giả lỗi ở tầng `IdentityService` nên không chứng minh "lỗi không bị cache" qua cache thật | đã sửa §4: `jest.spyOn(TransactionService.prototype, 'run').mockRejectedValueOnce(57P01)` |
| R4-7 | minor | Bước đặt lại DB phụ thuộc file override chỉ có trên máy này và `down -v` xóa mọi volume | đã sửa §5: dùng database dùng một lần `dbs52_manual` (DROP/CREATE + `migration:run`), chỉ cần repo; nêu rõ không dùng `TRUNCATE users CASCADE` (xóa luôn tài khoản `funding`) |
| R4-8 | bàn giao | Cần danh sách bàn giao có chủ cho: lỗi pool ra 500, audit cho cấp phát `users`, hai file DBS-50 bị sửa | đã sửa §3: bảng "Bàn giao cho người khác", mỗi dòng thành `BL-NNN` ở Phase 5 |

**Bàn giao (không thuộc thiết kế này):** lỗi hết thời gian chờ của pool và `Connection terminated unexpectedly` ra 500 thay vì 503 (`pg-error.util.ts` dùng chung) → `BL-NNN` ở Phase 5, giao chủ foundation/data.

**Quyết định ở G2 (2026-11-01):** duyệt G2 theo đề xuất của agent cho cả 5 câu: (1) miễn audit cho việc cấp phát `users`, Phase 5 ghi ngoại lệ vào database-design §4.1 và `BL-NNN` giao DBS-56; (2) không sửa `pg-error.util.ts`, chỉ `BL-NNN`; (3) duyệt sửa `identity.e2e-spec.ts` và `manual-smoke.dbs50.ts` (ngoài phạm vi G1, ghi ở §7); (4) chấp nhận verdict cuối REVISE, không chạy vòng 5; (5) việc sửa skill (trần 3 vòng review) để sau G3 của DBS-52, nhánh `docs/skill-review-max-3-rounds` đã tạo, chưa có commit.

## 7. Kế hoạch triển khai

Không có migration, biến môi trường, `ErrorCode` hay dependency mới (cache là `Map`). Mọi lệnh chạy từ `backend/`; lệnh DB dùng `DATABASE_URL=postgres://banking:banking_local_only@localhost:5433/banking` ở máy này. Mỗi bước: viết test, chạy thấy đỏ đúng lý do, viết code tối thiểu, chạy xanh, commit `type(module): imperative` kèm dòng đồng tác giả.

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `src/modules/identity/identity.service.ts` (mới), `identity.service.spec.ts` (mới) | TC-52-01…07, 23, 26 | 13/13 đỏ với bản khung `resolveUserId` trả `''` (assertion sai giá trị và số lần gọi `query`); hai lần chạy đầu làm sập cả worker Jest vì lỗi của chính test (khung ném `Error`, rồi một promise bị từ chối không ai bắt ở TC-52-26), đã sửa test trước khi coi là đỏ hợp lệ | `npm test -- identity.service` | `feat(identity): add IdentityService.resolveUserId with bounded single-flight cache` |
| 2 | `jwt-claims.ts` (+`userId`), `jwt-auth.guard.ts`, `identity.module.ts` (`providers`+`exports`), `index.ts`; cập nhật người gọi: `jwt-auth.guard.spec.ts`, `test/identity.e2e-spec.ts` (`overrideProvider`), `src/scripts/manual-smoke.dbs50.ts` (module `@Global()` giả `TransactionService`, sửa header) | TC-52-08…12 (viết trong `jwt-auth.guard.spec.ts`), TC-52-22, TC-52-24 | `jwt-auth.guard.spec.ts` không biên dịch được trước khi sửa guard (`TS2554` thừa tham số, `TS2339` thiếu `userId` trong `AuthenticatedUser`); `identity.e2e-spec.ts` đỏ 4/4 với `Nest can't resolve dependencies of the IdentityService (?) ... TransactionService at index [0]` đúng như review vòng 3 dự đoán | `npm test -- jwt-auth.guard`; `npm run test:e2e`; chạy `manual-smoke.dbs50.ts` | `feat(identity): resolve users.id after JWT verification` |
| 3 | `test/db/identity-users.db-spec.ts` (mới), `test/support/identity-users-probe.ts` (mới: `DataSource`/`TransactionService` theo `applicationName`, barrier `INSERT` chưa commit, poll `pg_stat_activity`) | TC-52-13, 14, 14b, 15, 16, 17 | Code đã có từ bước 1 nên không có lần đỏ tự nhiên; chứng minh bằng **đột biến**: bỏ `ON CONFLICT (cognito_sub) DO NOTHING` khỏi `INSERT_USER_SQL` thì TC-52-13, 14, 16 đỏ với `duplicate key value violates unique constraint "users_cognito_sub_key"` (3/6 đỏ); TC-52-14b vẫn xanh vì chỉ chứng minh single-flight (đúng như §4). Đã khôi phục file, 6/6 xanh | `npm run test:db -- identity-users` | `test(identity): prove users upsert races on PostgreSQL` |
| 4 | `test/db/identity-users-http.db-spec.ts` (mới; JWKS giả `test/support/jwks-fixture.ts` có sẵn, `AppModule`-con gồm `IdentityModule` + `DatabaseModule`) | TC-52-18…21, 25 | Code đã có từ bước 1–2 nên không có lần đỏ tự nhiên; chứng minh bằng **hai đột biến**, mỗi lần khôi phục file và chạy lại 10/10 xanh. (A) thêm `SET LOCAL lock_timeout = 0` vào `lookupOrCreate` thì TC-52-25 (a,b) và (c) đỏ (2/10 đỏ): không còn 503 nhanh, request treo tới giới hạn khác. (B) gọi `resolveUserId` bằng `sub` đọc thô từ payload **trước** `verifyAccessToken` thì TC-52-19 đỏ (1/10): token chữ ký sai tạo được dòng `users`. Lần chạy đầu của chính spec đỏ vì lỗi kiểu của test (`QueryRunner.query` không nhận generic, `Promise<Response>` không có `.expect`), đã sửa test | `npm run test:db -- identity-users-http` | `test(identity): cover users provisioning over HTTP and lock timeouts` |
| 5 | `src/scripts/manual-smoke.dbs52.ts` (mới, chế độ `main`/`rerun`/`outage`) | (không phải test jest; kiểm bằng §5) | không áp dụng | chạy M-52-01…09 trên DB `dbs52_manual`, lưu `docs/features/screenshots/DBS-52/manual-test.txt` (dòng đầu SHA) và ảnh chụp | `test(identity): add DBS-52 manual smoke script` |
| 6 | `backend/src/modules/identity/README.md`; `docs/components/_shared/database-design.md` §4.1 (ngoại lệ audit); `docs/BACKLOG.md` (+`BL-129`…`BL-131`); `docs/features/README.md` (+dòng DBS-52); feature doc §8, §9; `docs/components/identity/01-concept-brief.md` nếu còn ghi "chưa có code" | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | không áp dụng | link check sạch; `git diff --stat main...HEAD` | `docs(identity): record DBS-52 handover` |

Thứ tự bước 2: cùng một commit sửa guard **và** các người gọi của nó, vì đổi constructor của `JwtAuthGuard` làm đỏ `jwt-auth.guard.spec.ts`, `identity.e2e-spec.ts`, `app-guard.e2e-spec.ts`; tách ra thì có commit làm CI đỏ. Bước 1 và 3 không chạm file nào đã tồn tại.

**Bản đồ file (để đối chiếu `git diff --stat` ở G4):** mới 7 (`identity.service.ts`, `identity.service.spec.ts`, `identity-users.db-spec.ts`, `identity-users-http.db-spec.ts`, `identity-users-probe.ts`, `manual-smoke.dbs52.ts`, và bằng chứng `screenshots/DBS-52/*`); sửa 11 (`jwt-claims.ts`, `jwt-auth.guard.ts`, `identity.module.ts`, `index.ts`, `jwt-auth.guard.spec.ts`, `identity.e2e-spec.ts`, `manual-smoke.dbs50.ts`, `identity/README.md`, `database-design.md`, `BACKLOG.md`, `features/README.md`); cộng feature doc này. File ngoài danh sách là lệch kế hoạch và phải qua gate phụ. Hai file DBS-50 (`identity.e2e-spec.ts`, `manual-smoke.dbs50.ts`) đã được duyệt ở G2 câu 3.

**Quét theo DoD và giới hạn đã nêu (plan sweep):**

| Mục | Dòng kế hoạch hoặc ngoài phạm vi |
|---|---|
| DoD #1 (upsert sau verify, cache `sub → userId`) | Bước 1, 2 (TC-52-01…12, 18) |
| DoD #2 (20 request song song đầu tiên → 1 dòng, không lỗi unique) | Bước 3, 4 (TC-52-04, 13, 14, 14b, 20) |
| DoD #3 (mọi vai) | Bước 3, 4 (TC-52-15, 18); bước 5 (M-52-04) |
| DoD #4 (PR merge, CI xanh, review, bảng đối chiếu) | Quy trình, chưa kiểm được tới G4; bước 6 thêm `BL-131` |
| Ngoại lệ audit FR-AUD-01 (G2 câu 1) | Bước 6: ghi chú database-design §4.1 + `BL-130` (giao DBS-56) |
| Lỗi pool ra 500 (G2 câu 2) | Bước 6: `BL-129`; không sửa `pg-error.util.ts` |
| `BL-030`, `BL-112` (cùng module) | Ngoài phạm vi: không đụng (đã nêu ở §1) |
| `customers`, `sessions_revoked_at`, `@Roles`/`@CurrentUser`, `AUTH_MODE=local` | Ngoài phạm vi (§1): DBS-51, DBS-53, task thu hồi phiên |
| Hai file DBS-50 bị sửa | Bước 2; thông báo chủ DBS-50 trong PR, không tạo `BL-NNN` (không còn việc dang dở). Sửa lại bảng "Bàn giao" ở §3: dòng thứ ba chỉ ghi trong PR, hai dòng đầu thành `BL-129`, `BL-130` |

**Rủi ro và cách lùi:**
- Mọi route có JWT nay phụ thuộc DB. DB hỏng thì mọi route đã xác thực ra 503 (hoặc 500 với hai lỗi pool chưa phân loại, `BL-129`). `/health/*` là `@Public()` nên không bị ảnh hưởng. Cách lùi: revert commit bước 2 trả guard về trạng thái DBS-50; không có migration nên không có gì phải hoàn tác ở DB.
- `users` có thêm dòng cho mỗi `sub` hợp lệ lần đầu: đúng thiết kế (database-design §4.1), không tạo `customers` nên không ảnh hưởng tài khoản hay sổ cái.
- Test đua dùng `pg_stat_activity` có thể chập chờn trên runner chậm: hạn poll 10 s, lock timeout 30 s, lọc theo `application_name`; nếu đỏ ngắt quãng thì coi là lỗi đua, không chạy lại cho tới khi xanh (`testing.md`).
- Số `BL-129`…`BL-131` có thể bị nhánh khác lấy trước (hiện lớn nhất trên `main` là `BL-128`): đánh lại số khi rebase lên `main` ở Phase 5.

**Quyết định ở G3 (2026-11-01):** duyệt G3 theo đề xuất của agent: (1) giữ `BL-129`…`BL-131`, đánh lại số khi rebase nếu bị lấy trước; (2) chưa mở Draft PR; (3) làm hết Phase 4 của DBS-52 trước, sau đó mới quay lại DBS-51 và việc sửa skill.

## 8. Kết quả

- **Lệnh kiểm tra** (chạy sau commit cuối đổi code `52c6c1a`, Postgres compose cổng 5433; `jest` không có `.skip`/`.only`/`.todo` trong file của task, đã grep):

| Lệnh | Kết quả | So với baseline §1 |
|---|---|---|
| `npm run lint:check` | sạch | như cũ |
| `npm run typecheck` | sạch | như cũ |
| `npm run format:check` | sạch | |
| `npm test` | 43 suites, **597** test đạt | 576 → 597 (+13 `identity.service.spec`, +8 `jwt-auth.guard.spec`) |
| `npm run test:e2e` | 8 suites, **57** test đạt | không đổi |
| `npm run test:db` | 15 suites, **317** test đạt | 301 → 317 (+6 `identity-users`, +10 `identity-users-http`) |

  Một lần chạy `npm test` toàn bộ có **1 test đỏ** ở `jwks-verifier.service.spec.ts` (suite 41 s); chạy riêng suite đó đạt 13/13 và chạy lại toàn bộ đạt 597/597. **Tên test đỏ không được ghi lại** (lúc đó mình chỉ lọc dòng tóm tắt), nên mình không khẳng định đó chính là hai test cooldown của `BL-112`; triệu chứng (một test của đúng file đó, đỏ lúc máy bận, xanh khi chạy lại) khớp mô tả của `BL-112`. Mình không sửa file này, không thuộc task này, `BL-112` giữ nguyên. Người review nên chú ý nếu CI đỏ ở file này.

- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-52-01…05, 07 | `src/modules/identity/identity.service.spec.ts` › `TC-52-01…05`, `TC-52-07` (5 giá trị xấu) | đạt |
| TC-52-06 | `identity.service.spec.ts` › `TC-52-06` (10.001 sub, LRU) | đạt |
| TC-52-23, 26 | `identity.service.spec.ts` › `TC-52-23`, `TC-52-26` | đạt |
| TC-52-08, 09, 11, 12 | `jwt-auth.guard.spec.ts` › `TC-52-08`, `TC-52-09` (3 ca), `TC-52-11` (3 ca), `TC-52-12` | đạt |
| TC-52-10 | `jwt-auth.guard.spec.ts` › "allows the request without calling the verifier when the handler is @Public()" (thêm khẳng định `resolveUserId` không được gọi, ghi chú `TC-52-10` trong code) | đơn giản hóa (không có `TC-52-10` trong tên test; test cũ của DBS-50 được thêm một khẳng định) |
| TC-52-13, 14 | `test/db/identity-users.db-spec.ts` › `TC-52-13`, `TC-52-14` (20 `IdentityService`, rào `INSERT` chưa commit, poll `pg_stat_activity` theo `application_name`) | đạt; đã thử đột biến bỏ `ON CONFLICT`: đỏ với `users_cognito_sub_key` |
| TC-52-14b, 15, 16, 17 | `identity-users.db-spec.ts` › `TC-52-14b`, `15`, `16`, `17` | đạt |
| TC-52-18, 19, 20, 21 | `test/db/identity-users-http.db-spec.ts` › `TC-52-18` (và 4 vai), `19`, `20`, `21` | đạt; đã thử đột biến gọi `resolveUserId` trước verify: TC-52-19 đỏ |
| TC-52-22 | `test/identity.e2e-spec.ts` (`overrideProvider`) và `test/app-guard.e2e-spec.ts` (`AppModule` thật boot) | đạt |
| TC-52-24 | chạy tay `manual-smoke.dbs50.ts`, output ở `manual-test.txt` | đạt (chạy tay, không tính vào số test jest) |
| TC-52-25 | `identity-users-http.db-spec.ts` › `TC-52-25 (a,b)` (lock thật → 503 trong < 2,5 s, rồi phục hồi) và `(c)` (25 sub khác nhau, khóa bảng, pool vẫn dùng được) | đơn giản hóa: ý (a) "`resolveUserId` ném `55P03` trong ~1 s" chỉ kiểm qua HTTP (503, < 2,5 s), không có khẳng định riêng ở tầng service; đã thử đột biến `lock_timeout = 0`: cả (a,b) và (c) đỏ |
| — (DoD #4) | quy trình | **chưa làm**: PR chưa mở; `BL-131` |

  **Tổng: 27 case (26 đánh số + 14b); 25 đạt, 2 đơn giản hóa (TC-52-10, TC-52-25), 0 chưa làm; riêng DoD #4 là quy trình, chưa kiểm được.**

- **Test thủ công** (SHA đầu `manual-test.txt` = `52c6c1a`, commit cuối đổi code; DB dùng một lần `dbs52_manual`; output thô ở [manual-test.txt](screenshots/DBS-52/manual-test.txt); đã quét không còn token, `Authorization`, mật khẩu, ARN, id tài khoản AWS; không dùng seed SQL):

| Bước | Kết quả thật | |
|---|---|---|
| M-52-01 | `DROP/CREATE DATABASE dbs52_manual`, `migration:run`, `count(*) = 0` | đạt |
| M-52-02 | 200, `userId=1edccffb-…`, `groups=[]`; `users` = 1 dòng, id khớp | đạt (đối chiếu `psql` ở cuối `main`, không ngay sau bước: script tự đếm bằng một `DataSource` riêng) |
| M-52-03 | 3 lần gọi lại: cùng `userId`, `users` = 1 | đạt |
| M-52-04 | operator, auditor, admin: 200, ba `userId` khác nhau, `users` = 4 | đạt |
| M-52-05 | 20 request song song, cùng sub mới: 20 × 200, 1 `userId`, `users` = 5 | đạt |
| M-52-06 | khóa lạ → 401 `UNAUTHENTICATED`; hết hạn → 401 `TOKEN_EXPIRED`; không token → 401; không có dòng cho sub đó, `users` vẫn 5 | đạt |
| M-52-07 | tiến trình mới (khóa RSA mới, cache rỗng), cùng sub của M-52-02: 200, **cùng `userId`**, `users` vẫn 5 | đạt |
| M-52-08 | Postgres tắt, đợi 35 s: **503 `SERVICE_TEMPORARILY_UNAVAILABLE`, `retry-after=5`** (`ECONNREFUSED`) | đạt |
| M-52-09 | Postgres bật lại, healthy: 200, có `userId`, đúng 1 dòng, `users` = 6 | đạt |

  Bước M-52-08/09 do agent điều khiển bằng cách nạp Enter vào stdin của script và chạy `docker compose stop/start postgres` (bạn đã đồng ý). Chỉ container Postgres của dự án này bị ảnh hưởng.

- **Phạm vi so với §7:** `git diff --stat main...HEAD` (trước khi thêm ảnh và feature doc này): 23 file, +1400 −19. Khớp danh sách §7; hai khác biệt nhỏ: (1) `docs/components/identity/01-concept-brief.md` được sửa (có trong §7 dưới dạng "nếu còn ghi chưa có code", và còn ghi vậy); (2) 3 file `domain-review-round2…4.md` và 5 ảnh PNG là bằng chứng, không có trong bản đồ file. Mới 6 file code/test (`identity.service.ts`, `identity.service.spec.ts`, `identity-users.db-spec.ts`, `identity-users-http.db-spec.ts`, `identity-users-probe.ts`, `manual-smoke.dbs52.ts`), sửa 12 file (11 trong §7 cộng concept brief).
- **Ảnh chụp** (dựng từ output thật của `manual-test.txt`, không phải ảnh màn hình terminal; mỗi ảnh ghi rõ dòng nguồn):

![M-52-02, 03: token đầu tiên tạo đúng một dòng](screenshots/DBS-52/01-first-token-creates-row.png)
![M-52-04, 05: bốn vai và 20 request song song](screenshots/DBS-52/02-all-roles-and-20-parallel.png)
![M-52-06: token xấu bị từ chối, không tạo dòng](screenshots/DBS-52/03-rejected-tokens-no-row.png)
![M-52-07: tiến trình mới, cùng sub, cùng userId](screenshots/DBS-52/04-same-userid-after-restart.png)
![M-52-08, 09: DB tắt ra 503, bật lại ra 200](screenshots/DBS-52/05-outage-503-then-recovery.png)

- **Lệch so với kế hoạch:**
  - **Thiết kế đổi sau khi G1 đã nói:** hai câu SQL chạy trong `TransactionService.run` (không phải "một lần gọi") để có `lock_timeout`/`statement_timeout`; ghi ở §2 và §3, duyệt cùng G2.
  - **Hai file của DBS-50 bị sửa** (`identity.e2e-spec.ts`, `manual-smoke.dbs50.ts`): duyệt ở **G2 câu 3** (2026-11-01).
  - **`TC-52-25 (d)`** (biến thể `LOCK TABLE` riêng) được gộp vào (c); không còn là một case riêng.
  - **Trần 3 vòng review:** G2 đã chấp nhận verdict cuối REVISE sau vòng 4 (G2 câu 4).
  - Mọi lệch khác không có.
- **Bàn giao cho vai khác** (đã thêm vào [`docs/BACKLOG.md`](../BACKLOG.md)):
  - `BL-129`: lỗi pool timeout và `Connection terminated unexpectedly` ra 500 thay vì 503, trên mọi route đã xác thực (chủ: foundation/data, `pg-error.util.ts`).
  - `BL-130`: audit cho việc cấp phát `users`, miễn theo G2 câu 1; `AuditService` ghi `user.provisioned` khi có (chủ: audit, DBS-56).
  - `BL-131`: DoD #4 (PR merge, CI xanh, review, bảng đối chiếu) chưa kiểm được.
  - Không tạo `BL-NNN` cho hai file DBS-50 bị sửa (chỉ báo trong mô tả PR) và không đụng `BL-030`, `BL-112`.

## 9. Tài liệu đã cập nhật

- `backend/src/modules/identity/README.md`: mô tả `resolveUserId`, `userId` trong `request.user`, cache, ranh giới transaction; liệt kê đúng cái đã có và chưa có.
- `docs/components/_shared/database-design.md` §4.1: ghi ngoại lệ audit cho việc cấp phát `users` (G2 câu 1).
- `docs/components/identity/01-concept-brief.md`: "Verified against code" từ "n/a" thành "một phần".
- `docs/BACKLOG.md`: thêm `BL-129`, `BL-130`, `BL-131`; không xóa dòng nào (không dòng nào được task này xử lý).
- `docs/features/README.md`: thêm dòng DBS-52 (trạng thái "Plan approved (chờ G4)"; chuyển thành Implemented sau G4).
- `docs/features/screenshots/DBS-52/`: 4 file trả lời domain review nguyên văn, `manual-test.txt`, 5 ảnh.
- `check-doc-links.mjs`: 179 file, 0 liên kết hỏng.
- **Không** đưa `docs/features/DBS-51-roles-guard-current-user.md` vào PR này (tài liệu của DBS-51, đang dừng sau G1, vẫn chưa commit).
