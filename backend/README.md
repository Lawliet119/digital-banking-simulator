# backend

Một ứng dụng NestJS (TypeScript strict). **Một image, chạy theo `APP_ROLE`:** trên ECS là hai service dùng chung image, ở local chạy cả hai trong một process.

| `APP_ROLE` | Chạy | Không chạy | Dùng ở |
|---|---|---|---|
| `api` | HTTP (controller) | consumer, scheduler | ECS service `api` |
| `worker` | module dùng chung (Outbox, Audit, Risk). `workerModules` hiện có outbox relay và consumer thông báo (ghi log); đích còn thiếu: risk scoring | HTTP listener | ECS service `worker` |
| `both` *(mặc định)* | tất cả | — | máy local, test |

## Chạy local

Yêu cầu: Node.js ≥ 24 (có `.nvmrc`, khớp với image Docker), Docker.

```bash
# từ thư mục gốc của repo
cp .env.example .env
docker compose up -d                 # PostgreSQL, Valkey (Redis), ElasticMQ (SQS)

# từ thư mục backend/
cd backend
npm install
cp env/.env.example env/.env.development
npm run start:dev                    # APP_ROLE=both, tự reload khi sửa code
```

| URL | Là gì |
|---|---|
| http://localhost:3000/health/live | process đang sống |
| http://localhost:3000/health/ready | PostgreSQL ổn →200, thêm redis=up/degraded; Redis lỗi không làm ALB drain task. PostgreSQL lỗi →503 (DBS-78) |
| http://localhost:3000/docs | Swagger UI (không có ở production) |

Muốn chạy tách như trên AWS: mở hai terminal, `npm run start:dev:api` và `npm run start:dev:worker`.

## Lệnh

| Lệnh | Việc |
|---|---|
| `npm run build` | biên dịch ra `dist/` |
| `npm run typecheck` | kiểm tra kiểu, không sinh file |
| `npm run lint` / `lint:check` | eslint (có sửa / chỉ kiểm tra) |
| `npm run format` / `format:check` | prettier |
| `npm test` | unit test (`src/**/*.spec.ts`) |
| `npm run test:e2e` | e2e (`test/*.e2e-spec.ts`) |
| `npm run test:db` | test trên PostgreSQL thật (`test/db/*.db-spec.ts`): ràng buộc DB, migration run → revert → run. Tự động khởi tạo PostgreSQL 17 qua Testcontainers (hoặc dùng `DATABASE_URL` có sẵn nếu đã xuất ra môi trường). Cần Docker Desktop bật; nếu Docker tắt thì test báo lỗi ngay, không treo |
| `npm run test:services -- --runInBand` | sample Valkey 8 và ElasticMQ thật (`test/services/`): mỗi lần chạy tự tạo container/cổng động, thử SET/GET, SQS send/receive, pause/resume và stop/start rồi dọn container. Cần Docker; không lấy endpoint từ Compose |
| `npm run check:invariants` | kiểm năm bất biến sổ cái trên `DATABASE_URL` (hoặc bộ `DB_*` như ECS): exit 0 sạch, 1 có vi phạm, 2 không nhận là sạch; mã thoát là thẩm quyền cuối cùng |
| `npm run auth:dev-keys` | sinh khóa ký thử nghiệm và JWKS vào `backend/.auth-local/` (bị gitignore); chỉ chạy được khi `NODE_ENV` là `development`, `test` hoặc để trống. Xem [mục 10](#10-token-thử-ở-local) |
| `npm run --silent auth:dev-token -- --role <vai>` | in một access token mẫu của `customer`, `operator`, `auditor` hoặc `admin` (stdout chỉ có token); tùy chọn `--sub`, `--iat`, `--exp`, `--dir` |
| `npm run seed` | tạo dữ liệu demo qua API (3 khách hàng, 4 tài khoản, 85tr nạp, 2 chuyển tiền mẫu); an toàn, idempotent, bảo toàn bất biến sổ cái (DBS-70). Xem [mục 12](#12-dữ-liệu-demo-scriptsseedts-dbs-70) |
| `npm run migration:run` · `migration:revert` · `migration:show` | migration trên DB local |
| `npm run migration:generate -- src/database/migrations/<Tên>` | sinh migration từ thay đổi entity |
| `npm run migration:create -- src/database/migrations/<Tên>` | tạo migration rỗng |

Trước khi mở Pull Request: `npm run lint:check && npm run typecheck && npm test && npm run test:e2e && npm run test:db`. CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) giữ sáu job `lint`, `typecheck`, `unit`, `e2e`, `db`, `build`. Job `e2e` chạy thêm sample DBS-39, migration run → revert → run và suite DBS-65 qua Testcontainers với `DATABASE_URL` được gỡ bỏ; job `db` vẫn chạy toàn bộ DB suite trên PostgreSQL service. Lệnh này không revert database dùng chung: test tạo và xóa database `dbs_test_*` riêng. Cách đọc kết quả: [CONTRIBUTING mục 4b](../CONTRIBUTING.md#4b-đọc-kết-quả-ci-trên-github-actions).

Kiểm luồng tuần2 riêng: `npm run test:db -- --runInBand --runTestsByPath test/db/money-flow.db-spec.ts`. Suite tạo hồ sơ và tài khoản qua HTTP, operator nạp, customer chuyển rồi kiểm list/detail, audit, outbox và năm bất biến; có replay, key theo user, thiếu tiền, kiểm quyền và số tiền lớn hơn2^53. PostgreSQL/Valkey là thật; giữ JWT, role guard và rate limit mặc định. Valkey riêng của suite vẫn cần Docker kể cả khi có `DATABASE_URL`. Không thể dùng Docker thì suite thất bại, không skip thành xanh.

Kiểm quyền DB API/worker: `npm run test:db -- --runInBand --runTestsByPath test/db/db-role-permissions.db-spec.ts`; test tay độc lập `node scripts/manual-dbs122.cjs`. [DBS-122](../docs/features/DBS-122-db-role-permissions.md) dùng PostgreSQL17 container riêng kể cả khi có `DATABASE_URL`, chạy migration thật và đăng nhập bằng `dbs_api`/`dbs_worker`; chỉ bật LOGIN/password ngẫu nhiên trong container đó. Không thay role/credential của Compose hoặc CI service. Tiền setup qua HTTP thật; cờ/audit là SQL đầu vào phép thử quyền, không phải kết quả consumer fraud. Bằng chứng `42501` kiểm đúng ACL, có valid-input/negative control và cleanup container.

Chạy tay local: `node scripts/manual-dbs65.cjs` từ backend. Driver tự tạo PostgreSQL/Valkey riêng, giữ mọi thao tác nghiệp vụ qua HTTP và chỉ SELECT để hậu kiểm; in code SHA ở dòng đầu, che tên/JWT/credential và dọn tài nguyên tự tạo trong finally. Khi ghi transcript bằng Git Bash, kiểm cả exit code driver và `tee` theo [DBS-65 §5](../docs/features/DBS-65-money-flow-e2e.md#5-test-thủ-công). Kết quả local không chứng minh cloud, Cognito hoặc quyền DB production; runbook cloud và khoảng thiếu bằng chứng nằm ở feature doc.

Helper DBS-40 ở `test/support/valkey.container.ts` và `elasticmq.container.ts` trả endpoint động và `pause()`, `resume()`, `stop()`. `pause()` làm dịch vụ không phản hồi để kiểm timeout/fallback; nó không mô phỏng được độ trễ hữu hạn tùy chỉnh. ElasticMQ quảng bá queue URL theo địa chỉ nội bộ trong config; helper lấy đường dẫn queue thật rồi ghép với endpoint Testcontainers. Image ElasticMQ ghim digest (hằng số `ELASTICMQ_IMAGE`, cùng giá trị với `docker-compose.yml`, BL-225): đổi digest phải chạy lại `dlq-isolation`, `worker-recovery` và runbook trước, xem [runbook DLQ](../docs/runbooks/dlq-redrive.md#nâng-image-elasticmq). Job CI `e2e` chạy đầy đủ `test:services` cho `testcontainers.services-spec.ts` (DBS-40), `sqs-adapter` (DBS-77), `outbox-relay` (DBS-90), `redis-adapter` (DBS-76), `health-readiness` (DBS-78) và `rate-limit` (DBS-89).

## Cấu trúc

```
backend/
├── src/
│   ├── main.ts              # chọn http hay worker theo APP_ROLE
│   ├── app.module.ts
│   ├── app.setup.ts         # cấu hình HTTP dùng chung với test: correlation id, helmet, CORS, version, filter, pipe
│   ├── common/              # app-role, errors (ErrorCode), filters, middleware, money (@common/money), utils — không chứa nghiệp vụ
│   ├── config/              # mỗi nhóm cấu hình một file + validation.schema.ts (Joi)
│   ├── database/            # kết nối, TransactionService / withTransaction, migrations/
│   ├── libs/                # adapter dịch vụ ngoài (redis, sqs)
│   ├── modules/             # module nghiệp vụ — xem modules/README.md
│   └── scripts/             # công cụ chạy một lần
├── test/                    # e2e + cấu hình jest
├── env/.env.example
└── Dockerfile
```

Alias: `@common/*`, `@config/*`, `@database/*`, `@libs/*`, `@modules/*`. Dùng alias để import code ở thư mục khác; `../` chỉ trong phạm vi module của mình.

## Những điều mọi người phải biết

### 1. Cấu hình bị validate lúc khởi động
`src/config/validation.schema.ts` kiểm tra toàn bộ biến môi trường. Thiếu hoặc sai là app **từ chối chạy** và liệt kê mọi lỗi một lần. Staging và production còn bắt buộc TLS cho PostgreSQL (`DATABASE_SSL=true`) và Redis (`rediss://`).

Thêm biến mới: khai báo trong `Env` + `validationSchema`, đọc nó trong một file `*.config.ts`, thêm vào `env/.env.example`. Có test kiểm tra `env/.env.example` luôn hợp lệ.

### 2. Transaction: dùng `TransactionService`, đừng tự quản lý
```ts
constructor(private readonly tx: TransactionService) {}

await this.tx.run(async manager => {
  await accounts.lockForUpdate([fromId, toId], manager);
  // … mọi đọc/ghi đều qua `manager`
});
```
- Mặc định READ COMMITTED; đúng-sai nhờ `SELECT … FOR UPDATE`, không nhờ isolation.
- Deadlock (`40P01`) và serialization failure (`40001`) được **chạy lại cả callback** trong transaction mới (tối đa 3 lần).
- Vì vậy callback **phải chạy lại được an toàn**: không gọi Redis, HTTP, SQS bên trong. Sự kiện đi qua bảng outbox.
- Truyền `manager` sang module khác để cùng một transaction.
- **Mỗi transaction luôn có giới hạn chờ:** `lock_timeout` 2 giây, `statement_timeout` 5 giây, `idle_in_transaction_session_timeout` 10 giây (cấu hình `DATABASE_*_TIMEOUT_MS`). Lý do: nhiều lệnh cùng chờ khóa của một tài khoản nóng, mỗi lệnh giữ một kết nối trong pool; không có giới hạn thì pool cạn và mọi request khác — kể cả `/health/ready` — đứng chờ theo. Hết hạn thì trả **503 + `Retry-After`** và **không** tự thử lại (chờ thêm chỉ làm hàng đợi dài hơn). Một transaction đặc biệt (ví dụ job đối soát) được nâng giới hạn của riêng nó: `tx.run(fn, { statementTimeoutMs: 60000 })`.
- Giữ transaction **ngắn**: không gọi dịch vụ ngoài, không xử lý nặng khi đang giữ khóa.

### 3. Lỗi: dùng `ErrorCode`, test theo mã, không theo câu chữ
Mọi lỗi trả về `application/problem+json`:
```json
{ "type": "about:blank", "title": "Unprocessable Entity", "status": 422,
  "detail": "…", "errorCode": "INSUFFICIENT_FUNDS",
  "transferId": "…", "correlationId": "…" }
```
- Ném `HttpException` kèm `errorCode` (và các trường khác muốn trả); filter chuyển tiếp chúng. Các trường RFC (`type`, `title`, `status`, `detail`) luôn thắng — đừng gửi `status: 'REJECTED'`, hãy dùng `errorCode` + `transferId`.
- Chỉ thêm member vào `ErrorCode` khi client **phải rẽ nhánh** theo nó.
- Lỗi DB tạm thời (deadlock còn sót sau retry, mất kết nối) → **503 + `Retry-After`**; client gửi lại **cùng `Idempotency-Key`** là an toàn.
- Lỗi lạ → 500 với nội dung chung chung; log chỉ giữ loại lỗi, mã kỹ thuật an toàn và `correlationId`. Không ghi raw error message, stack, SQL hoặc credential.
- **`correlationId` luôn do server sinh** (header `X-Correlation-Id`); client không chọn được, nên không ai dùng lại id của người khác để làm nhiễu truy vết audit. Id do client gửi qua `X-Request-Id` (phải là UUID) chỉ được trả lại nguyên vẹn để client đối chiếu request, không dùng cho audit.

### 4. Ranh giới module do eslint ép
Xem `src/modules/README.md`. Import xuyên module chỉ qua `@modules/<tên>`; với tay vào ruột module khác (alias hoặc `../`) là lỗi lint.

### 5. Test
- Unit test đặt **cạnh file** được test (`*.spec.ts`).
- Test đúng-sai về tiền (đồng thời, idempotency) chạy trên **PostgreSQL thật** (Testcontainers), không mock database. Test `withTransaction` hiện tại dùng fake chỉ để kiểm tra logic retry/rollback — nó **không** chứng minh hành vi khóa của Postgres.
- Test e2e dùng `configureHttpApp` từ `app.setup.ts` để chạy đúng cấu hình như production.

#### Cách làm sạch và cô lập dữ liệu khi kiểm thử (Data Isolation & Cleanup)
Hệ thống sử dụng bảng sổ cái chỉ-thêm (`append-only ledger` như `transfers`, `ledger_entries`) với ràng buộc khóa ngoại chặt chẽ và phụ thuộc vào tài khoản cấp vốn hệ thống (`SYSTEM` funding account với UUID `00000000-0000-4000-8000-000000000001`). Vì vậy, **tuyệt đối không sử dụng `TRUNCATE` hoặc `DELETE` bừa bãi** giữa các ca kiểm thử vì sẽ phá vỡ sequence, trigger và làm mất tài khoản hệ thống.

Để kiểm thử hoàn toàn độc lập, an toàn và có thể chạy song song:
1. **Cô lập theo Test Suite bằng Database tạm thời (Temp Database):** Khuyến nghị mặc định là mỗi test file (`*.db-spec.ts`) gọi `createTempDatabase()` trong `beforeAll` để tạo một database hoàn toàn độc lập (`dbs_test_<random_hex>`) trên PostgreSQL container, chạy migration trên đó và tự động xóa sạch database (`db.drop()`) trong `afterAll`. Nhờ vậy các test suite chạy song song không bao giờ xung đột dữ liệu.
2. **Cô lập giữa các test case trong cùng suite:** Sử dụng transaction `BEGIN` trong `beforeEach` và `ROLLBACK` trong `afterEach`. Mọi thay đổi dữ liệu của từng ca kiểm thử sẽ được hoàn tác sạch sẽ mà không tốn chi phí khởi tạo lại schema.
   - **Giới hạn:** cách này chỉ đúng khi test dùng **một kết nối** (một `QueryRunner`). Test đồng thời (hai kết nối để thử khóa, `SELECT ... FOR UPDATE`) không thấy dữ liệu chưa commit của nhau, và `ROLLBACK` không dọn được dữ liệu đã commit ở kết nối khác. Test loại đó dựa vào temp database riêng của spec (mục 1) và tự tạo dữ liệu của mình, không dùng `BEGIN`/`ROLLBACK` để cô lập.


### 6. Migration
Không bao giờ chạy lúc app khởi động (`synchronize: false`). Viết theo kiểu **expand → migrate → contract** để bản cũ vẫn chạy được trong lúc deploy. Trên pipeline: `npm run migration:run:prod` (chạy từ `dist/`) là một task ECS chạy một lần trước khi deploy, không phải lúc app khởi động ([DBS-68](../docs/features/DBS-68-migration-step.md)); chạy tay trên cloud bằng `IMAGE_TAG=<sha-40-ky-tu> bash .github/scripts/migrate.sh` (xem `infra/terraform/README.md`, mục "Migration trước deploy"). Task đọc kết nối từ `DB_*` (DBS-67), nên chạy được cả khi `DATABASE_URL` không có. Entity và SQL viết tay dùng chung tên cột nhờ `SnakeNamingStrategy` (`src/database/snake-naming.strategy.ts`, bật ở cả app lẫn CLI); entity ghi tên bảng tường minh (`@Entity('accounts')`). Mỗi migration có test trong `test/db/` (`npm run test:db`). `npm run migration:revert` chỉ hoàn tác migration **mới nhất**; migration `down` có `DROP TABLE` tự từ chối khi bảng đã có dữ liệu (migration 1, 2, outbox và audit). Migration 2 (`CreateTransfersLedgerIdempotency`) cần quyền superuser trong test `test:db` ở ca TC-21-24 (dùng `session_replication_role`); role `banking` của docker compose đã là superuser.


**Schema outbox.**

Migration `1792627200000-CreateOutboxEventsProcessedEvents` tạo outbox/processed và hai partial index. Down cần transaction READ COMMITTED; khóa bảng trước kiểm dữ liệu, không cho DROP nếu còn dòng. Test schema legacy dùng `migrateThrough` phiên bản thật; CLI regression vẫn chạy production tới latest và revert từng bước.

`OutboxModule`/`OutboxWriter` export qua `@modules/outbox`, dùng được ở API và worker. Producer import module rồi gọi `writer.add(manager, event)` trong `TransactionService.run`: chỉ một INSERT, kiểm common/events và snapshot JSON, không gửi queue hoặc tự mở transaction. Event phải có correlationId hợp lệ; context ALS nếu có phải nhất quán. Lỗi schema/serialization/unique làm transaction caller rollback khi để lỗi lan ra; writer không upsert/nuốt lỗi. Payload lưu toàn envelope; thời gian TransferCompleted do producer lấy từ `transfers.created_at` của DB rồi ISO Z. Relay/consumer chưa có. Chi tiết [module outbox](src/modules/outbox/README.md) và [DBS-57](../docs/features/DBS-57-outbox-writer.md).

**Schema audit.**

Migration `1792627200001-CreateAuditLog` ([DBS-26](../docs/features/DBS-26-migration-audit-log.md)) tạo `audit_log` với ba index theo correlation, actor/thời gian và action/thời gian. Revert audit yêu cầu transaction READ COMMITTED và bảng rỗng: guard kiểm isolation trước khóa ACCESS EXCLUSIVE, sau đó kiểm dữ liệu bằng statement mới; có dữ liệu thì SQLSTATE `55000` và giữ schema/history. Không xóa audit để ép rollback. Test nền 20/21 chọn prefix bằng helper test, còn CLI production luôn chạy latest theo lịch sử thực.

**Append-only.**

Migration `1792627200002-AddAppendOnlyTriggers` đặt hàm `public.forbid_mutation()` và sáu trigger cho `transfers`, `ledger_entries`, `audit_log`: [DBS-27](../docs/features/DBS-27-append-only-triggers.md). INSERT vẫn được; UPDATE/DELETE có hàng và TRUNCATE kể cả bảng rỗng bị `42501` từ trigger. Revert27 chỉ gỡ trigger/hàm, giữ dữ liệu/sequence, nên phải đánh giá việc bỏ lớp bảo vệ trước khi dùng ngoài DB tạm. Test schema của từng migration dùng prefix thật; CLI vẫn run latest và đọc lịch sử khi revert. Quyền production thuộc task roles, không suy ra từ owner fixture.

**Kết quả đối soát.**

Migration `1793577600000-CreateReconciliationRuns` tạo bảng9 cột `reconciliation_runs`: [schema chuẩn](../docs/components/_shared/database-design.md#49-notificationlog-reconciliationruns). `details` là SQL NULL hoặc mảng các object đóng `accountId`, `balance`, `ledgerBalance`; hai giá trị tiền là chuỗi signed bigint chính xác, không JSON number hoặc văn bản tự do. Revert cần transaction READ COMMITTED, khóa rồi kiểm rỗng; có dữ liệu trả `55000`, giữ nguyên bảng/history. Schema không cung cấp scheduler hoặc quyền production.

Chạy driver vận hành bằng `npx ts-node -r tsconfig-paths/register test/manual/reconciliation-runs.manual.ts` từ `backend/`, với Docker sẵn sàng. Driver dùng PostgreSQL17 riêng, CLI migration thật và database tạm do nó tạo; không ghi database phát triển. Dòng đầu cho biết SHA code hoặc snapshot working tree chưa commit. Test/manual27 chọn đúng prefix và hoàn tác suffix qua migration down thật, nên việc có migration mới không làm revert nhầm. [Evidence và giới hạn bàn giao](../docs/features/DBS-116-reconciliation-runs.md).

### 7. Tiền: một cách duy nhất, qua `@common/money`
`JSON` và `Number`/`parseInt` làm tròn mọi số trên 2^53: `9007199254740993` thành `9007199254740992` mà không báo lỗi. Nên tiền trên dây (API, event, tham số SQL) là **chuỗi** số nguyên đồng, trong domain là **`bigint`**, và chỉ đổi qua lại bằng `@common/money` (import `from '@common/money'`, không import file bên trong).

| Cần | Dùng |
|---|---|
| số tiền của một lệnh (0 .. 2^63−1) | `Money`, `parseMoney`, `addMoney`, `subtractMoney` |
| số tiền chuyển hoặc nạp (phải > 0) | `parsePositiveMoney` ở service, `@IsMoneyAmount()` ở DTO |
| số dư có dấu (`funding` âm theo ADR-09) | `Balance`, `parseBalance`, `creditBalance`, `debitBalance` |
| `bigint` tính ra ngoài thư viện (một `SUM`) | `toMoney`, `toBalance` (kiểm miền rồi gắn kiểu) |
| ra chuỗi (response, event, tham số SQL) | `formatMoney`, `formatBalance` |

```ts
class TransferDto {
  @IsMoneyAmount() // trường kiểu string; số JSON bị 400 kể cả khi chính xác
  amount!: string;
}

// trong service
const amount = parsePositiveMoney(dto.amount); // ném MoneyError nếu sai
const next = debitBalance(parseBalance(row.balance), amount); // số dư đọc từ pg là chuỗi
await manager.query('UPDATE accounts SET balance = $1 WHERE id = $2', [formatBalance(next), id]);
return { amount: formatMoney(amount) };
```

**Điều cấm:**
- `parseInt`, `parseFloat`, `Number(…)`, `+x`, `Math.*` trên tiền; kiểu `number` cho số tiền hay số dư, kể cả `amount: number` trong DTO.
- `@Transform` của class-transformer đổi chuỗi tiền thành `bigint`: nó chạy **trước** validator nên validator không còn thấy dữ liệu client gửi.
- Số JSON cho tiền (`{"amount": 1000}`): luôn 400. Tiền luôn là chuỗi `"1000"`.
- Bỏ `parsePositiveMoney` ở service vì "DTO đã kiểm": lệnh đi vào từ worker không qua DTO, và `0` rơi xuống `CHECK (amount > 0)` thành lỗi 500.
- So `===` giữa `Money` và `Balance` (hai kiểu khác nhãn): dùng `<`, `>`, hoặc mở rộng trước `(a as bigint) === b`.

`MoneyError` (`reason`: `INVALID`, `OVERFLOW`, `UNDERFLOW`, `NOT_POSITIVE`) không phải lỗi HTTP: bắt nó ở chỗ có ý nghĩa nghiệp vụ; lọt ra ngoài thì thành 500 chung chung, không lộ gì. Lỗi DTO là 400 với danh sách `errors`, **không có `errorCode`** (client chỉ cần sửa và gửi lại). `main.ts` và `configureHttpApp` gọi `installBigIntJson()` để `JSON.stringify` ra chuỗi cho `bigint` còn sót; đó là lưới an toàn, không thay cho `formatMoney`. Luật ESLint `no-restricted-syntax` trong `eslint.config.mjs` chặn trực tiếp `Number()`, `parseInt()`, `parseFloat()` trong `src/modules/ledger/**` và `src/modules/accounts/**`.

### Job dọn dữ liệu chống trùng

Worker/both chạy `OutboxCleanupService` khi khởi động và mỗi giờ: dọn key theo `IDEMPOTENCY_KEY_RETENTION_DAYS` (7–3650, mặc định7), marker theo `PROCESSED_EVENTS_RETENTION_DAYS` (7–3650, mặc định7). Giữ dòng bằng cutoff; khóa advisory riêng,1000dòng/lô,200lô mỗi bảng, transaction giới hạn500ms chờ khóa/2s statement/2s idle. Envkey dưới7ngày bị từ chối khi boot. Queue4ngày/DLQ6ngày; tăng cửa sổ queue/redrive phải nâng retention marker trước.

Test riêng: `npm run test:db -- --runInBand --runTestsByPath test/db/dedup-cleanup.db-spec.ts`. Test tay: `node scripts/manual-dbs136.cjs`; fixture tự tạo PG17 riêng, actual LOGIN worker và API/JWT thật, không đổi credential Compose. Key còn tồn tại thì replay; sau khi hết hạn và đã bị dọn, cùng key được coi là lệnh mới. [Thiết kế và bằng chứng DBS-136](../docs/features/DBS-136-dedup-cleanup.md).

### 8. Log JSON

Log ứng dụng dùng `nestjs-pino`, mỗi dòng là một JSON object trên stdout, áp dụng cả API, worker và bootstrap. Thông báo npm/compiler/Docker không thuộc log ứng dụng.

| Trường | Quy ước |
|---|---|
| `level` | Số Pino: trace 10, debug 20, info 30, warn 40, error 50, fatal 60 |
| `time` | ISO 8601 UTC, có `Z` |
| `message` | Thông điệp chẩn đoán cố định, không nội suy dữ liệu cá nhân hoặc error text |
| `role` | `api` hoặc `worker`; HTTP luôn `api`; polling loop, consumer và tác vụ nền luôn `worker` kể cả trong tiến trình `both`; ngoài mọi context (khởi động, tắt máy) tiến trình `both` mặc định `api` |
| `appRole` | Vai trò tiến trình `api`, `worker` hoặc `both` |
| `correlationId` | UUID server của HTTP request hoặc UUID trong event của message; `null` ngoài request/message |

`LOG_LEVEL` giữ nguyên sáu giá trị: `verbose`→trace, `debug`→debug, `log`→info, `warn`→warn, `error`→error, `fatal`→fatal. Chỉ ghi mức đã chọn và các mức nghiêm trọng hơn. Dùng `new Logger(TenService.name)` từ Nest để log đi qua cùng cấu hình.

HTTP completion chỉ ghi method, status và thời gian xử lý; không ghi URL/path/query, headers/cookies, địa chỉ mạng hoặc request/response body. Logger gắn trước CORS và body parser để cả preflight và JSON lỗi có correlationId. Log retry và filter lỗi chỉ ghi thông điệp cố định, số lần thử và mã SQLSTATE/network được phép. Error message/stack/cause và SQL/parameters không được ghi.

**Che dữ liệu nhạy cảm.** Khoá được chuẩn hóa (chữ thường, bỏ `_` và `-`) rồi so với danh sách: `authorization`, `password`, `passwd`, `pwd`, `secret`, `token`, `cookie`, `credential`, `apikey`, `privatekey`, `passphrase`, `jwt`, `iban`, `cvv`, `securitycode`, `connectionstring`, `databaseurl` (chứa chuỗi con); `pan`, `cardpan`, `pannumber`, `otpcode`, `totp`, `mfacode`, `smscode`, `pincode`, `cvc2`, `sid`, `sessionid`, `pass`, `dsn`, `signature`, `auth` (nguyên khoá); và khoá kết thúc bằng `accountno`, `accountnum`, `cardno`, `cardnum`, `pin`, `otp`, `cvc` (ví dụ `toAccountNo`, `newPin`). `headers` và `rawHeaders` bị bỏ hẳn. `footprint`, `panel`, `span`, `cardNotPresent`, `accountNotFound` không bị che. Mọi giá trị chuỗi (không chỉ `message`) còn được quét: URI có credential, `Bearer`/`Basic`, `Authorization: …`, các cặp `tên=giá trị` như `PGPASSWORD`, `client_secret`, `password_hash` (kể cả JSON và JSON mã hóa hai lần) và JWT thô. Đây là lớp bảo vệ bổ sung: **không truyền payload khách hàng hoặc chuỗi lỗi thô vào logger**. Log vận hành không thay cho audit log trong transaction.

**Envelope và độ bền.** Mỗi khoá `level`, `time`, `message`, `appRole`, `role`, `correlationId` xuất hiện đúng một lần: object bạn truyền vào log không đặt được các khoá này (kể cả giá trị hợp lệ). `message` luôn là chuỗi; đối số không có chỗ điền trong chuỗi định dạng bị bỏ. Một lời gọi log hỏng (getter ném lỗi, Proxy bị thu hồi) không bao giờ làm hỏng kết quả của caller: `SafeLogger` (bọc `Logger` của Nest) và hook của pino ghi dòng cố định `Log call failed` thay vì ném lỗi. Chuỗi dài hơn 4096 ký tự thành `[Omitted]`, mỗi lần ghi log quét tối đa 64 KiB và giữ 1000 phần tử đầu của một mảng.

**Context log (BL-024).** Mở context bằng một hàm duy nhất, `runInLogContext(fn, { role, correlationId })` trong `@common/logging/log-context` (HTTP middleware, `ConsumerBase` và `PollingLoop` đều dùng nó; `runAsWorker(fn)` cho tác vụ nền). Hàm bind `role` và `correlationId` đúng một lần từ giá trị đã kiểm (`role` chỉ `api|worker`, `correlationId` chỉ UUID, sai thì `null`), lưu bằng AsyncLocalStorage nên request hoặc message chạy song song không lẫn ID, và luôn bắt đầu từ logger gốc nên việc chạy nền khởi động từ trong request không thừa hưởng ID của request. Binding do code khác tạo (`logger.child`, `PinoLogger.assign`) đi qua hook `onChild` của pino: `role` và `correlationId` giữ giá trị đã bind trước đó (không gán lại được), `role` sai bị bỏ còn `correlationId` không phải UUID thành dấu `[Invalid]` (không ghi giá trị gốc, và outbox writer vẫn từ chối ghi event trong context hỏng, TC-57-07), khoá `level`/`time`/`message`/`msg`/`appRole` bị bỏ, các khoá còn lại được che như object log; mỗi khoá xuất hiện đúng một lần. Không dùng `PinoLogger` hay `req.log` trong code mới: ESLint (`no-restricted-syntax`) chặn chúng ngoài `common/logging`, test và sáu file cũ ghi trong `eslint.config.mjs`; log bằng `Logger` của Nest để đi qua `SafeLogger`. Consumer không đọc `customers` và không log tên khách: khoá `fullName`, `full_name`, `ownerName`, `customerName` luôn bị che.

**Lỗi nội bộ của Nest/TypeORM (BL-026).** Mặc định chỉ ghi `context`, loại lỗi và `Diagnostic event`. Ngoại lệ là allowlist thông điệp cố định theo `context` (`INTERNAL_MESSAGES` trong `logging.options.ts`): `TypeOrmModule` «Unable to connect to the database. Retrying (n)...» và ba câu cố định của `ExceptionHandler` (không giải được dependency, không tạo được module, export sai). Khớp chặt theo regex neo đầu, chỉ chữ số và định danh điền vào chỗ trống; câu khớp dạng tiền tố chỉ ghi phần khớp, không ghi phần sau. Thêm một thông điệp phải kèm test không lộ giá trị. `process.emitWarning` đi qua logger JSON thành một dòng `warn` `Process warning` có `warningName` và `warningCode` (đúng định dạng, không thì bỏ); message chỉ được ghi khi là câu cố định trong allowlist (hiện có cảnh báo `sslmode` của `pg-connection-string`).

**Lỗi khi khởi động và lỗi cấp tiến trình.** Cấu hình sai (Joi hoặc `APP_ROLE`) ghi một dòng `Application startup failed` có `invalidKeys`: tên biến sai, hoặc `<cross-field>` cho quy tắc giữa nhiều biến, **không** kèm giá trị. `uncaughtException` và `unhandledRejection` ghi đúng một dòng JSON `level:60` rồi thoát mã 1, không in stack ra stderr. Lỗi ném đồng bộ khi nạp `env.bootstrap` (trước khi logger có) ghi một dòng `fatal` cố định `Environment bootstrap failed`, không message, rồi thoát mã 1.

**Giới hạn đã biết:**
- Heuristic che số từ 8 chữ số chỉ chạy trên `message`; số tài khoản trong field khác chỉ được che theo tên khoá (v1 định danh tài khoản bằng UUID).
- Tên khoá bí mật không có trong danh sách ở trên vẫn lọt; giá trị bí mật dạng khác (ví dụ chuỗi base64 trần) không bị quét.
- `onChild` không thấy `logger.setBindings(...)` gọi thẳng trên một logger (pino không gọi hook ở đó); ESLint chặn `PinoLogger`/`req.log` nên đường này chỉ còn trong sáu file cũ. Code còn giữ `PinoLogger` chỉ được bảo vệ ở hook của pino, không qua `SafeLogger`.
- Hai dòng cảnh báo cấu hình `DB_*`/`REDIS_*` thiếu hoặc sai của `env.bootstrap` vẫn ra stderr dạng text: chúng chỉ nêu **tên** biến, không có giá trị, và nằm trước khi logger có. Dòng `fatal` của lỗi đồng bộ trong `env.bootstrap` và cảnh báo tiến trình sau khi nạp `process-logging.bootstrap` thì đã là JSON; cảnh báo phát ra **trước** `process-logging.bootstrap` (trong khi nạp `env.bootstrap`) vẫn là text của Node.
- Tác vụ nền không đi qua `PollingLoop` (timer của `MetricsService`) vẫn ghi `role=api` trong tiến trình `both`, vì chúng là của tiến trình chứ không riêng worker.
- Dòng log đang ghi dở khi tiến trình crash có thể bị cắt và dính với dòng `fatal`; dòng trước crash có thể xuất hiện sau `fatal` (dùng `time` để sắp xếp).
- Lỗi nội bộ do Nest hoặc TypeORM phát ra chỉ được ghi thông điệp gốc khi nằm trong allowlist ở trên; mọi thông điệp khác (có thể chứa SQL hoặc credential) vẫn chỉ còn `context`, loại lỗi, mã SQLSTATE và `Diagnostic event`.

Chi tiết và bằng chứng: [DBS-42](../docs/features/DBS-42-json-logger.md).

### 9. Kiểm tra bất biến sổ cái

Chạy sau money test hoặc load run, từ checkout có devDependencies và quyền SELECT ba bảng `public.accounts`, `public.transfers`, `public.ledger_entries`:

```bash
# từ backend/; DATABASE_URL hoặc bộ DB_* của ECS được cấp qua môi trường hoặc env/.env.<NODE_ENV>
npm run --silent check:invariants
npm run check:invariants -- --help
```

[Nguồn SQL](test/support/invariants.sql) và [hàm/CLI](test/support/invariants.ts) dùng chung một SELECT để năm phép kiểm nhìn cùng snapshot:

1. Tổng DEBIT = tổng CREDIT.
2. Mỗi `accounts.balance` = SUM(CREDIT) − SUM(DEBIT); không có entry thì kỳ vọng 0.
3. SUM(balance) toàn hệ thống = 0, **gồm tài khoản SYSTEM funding**.
4. Không tài khoản khách nào âm; funding được phép âm.
5. Mỗi COMPLETED có đúng một DEBIT và một CREDIT, đúng amount và tài khoản nguồn/đích của transfer; bắt cả transfer chưa có entry.

PASS/FAIL là JSON trên stdout, gồm `totals` và `violations` với `check`, `accountId`/`transferId`, `actual`, `expected`. Mọi số tiền, tổng và count là chuỗi chính xác, kể cả SUM vượt int64. Không parse aggregate bằng `Number`, `parseInt` hoặc parser `Money` giới hạn int64.

| Exit | Ý nghĩa | Cách xử lý |
|---|---|---|
| 0 | PASS, đủ năm phép kiểm sạch | Có thể tiếp tục bước sau |
| 1 | FAIL, có vi phạm | Giữ IDs/report, điều tra; công cụ không tự sửa dữ liệu |
| 2 | Không nhận là sạch: ERROR trên stderr (cấu hình, kết nối, quyền, schema, I/O, timeout, hoặc dọn dẹp lỗi sau commit). Có thể kèm report PASS trên stdout | Mã thoát là **thẩm quyền cuối cùng**: exit 2 kèm PASS là "không nhận là sạch". Sửa môi trường rồi chạy lại |

Dùng `--silent` khi cần parse JSON; npm không silent có thể thêm banner. `psql -f test/support/invariants.sql` chỉ trả report, không tự đổi FAIL thành exit khác 0; CI/load gate dùng CLI và giữ nguyên mã thoát.

Ví dụ từ file test trong `test/db/`, với QueryRunner đã kết nối:

```ts
import { checkLedgerInvariants } from '../support/invariants';

const report = await checkLedgerInvariants(db.runner);
expect(report.status).toBe('PASS');
expect(report.violations).toEqual([]);
```

Hàm không tạo kết nối, log, đổi timeout hoặc mở/commit/rollback transaction. Dùng cùng runner để kiểm dữ liệu của transaction caller; kết nối khác chỉ nhìn dữ liệu đã commit. Test cố ý làm lệch assert FAIL rồi rollback/drop DB tạm, không ép thành PASS bằng sửa/xóa sổ.

CLI chỉ đọc `NODE_ENV`, `DATABASE_URL`, `DATABASE_SSL`, `DATABASE_SSL_CA_PATH` và bộ `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (như task ECS), không cần Redis/SQS/Cognito. `DATABASE_URL` không rỗng luôn thắng; không có thì CLI ghép URL từ `DB_*` bằng `composeDatabaseUrl` của ứng dụng (mật khẩu được mã hóa URL). Lỗi cấu hình in `{"status":"ERROR","kind":"INVALID_CONFIG","invalid":[…]}` với **tên** biến sai (ví dụ `["DB_PORT"]`), không bao giờ in giá trị, đường dẫn hay URL. Luật TLS dùng validator hiện có: staging/production bắt buộc TLS và xác minh chứng chỉ; CA tùy chọn qua đường dẫn cấu hình. Query key `ssl*` và `uselibpqcompat` trong URL bị từ chối để không ghi đè CA/xác minh. ERROR chỉ có loại lỗi và SQLSTATE/network code được phép, không in URL, password, SQL hoặc stack.

CLI mở transaction READ ONLY với connect timeout 5 giây, lock timeout 2 giây, statement timeout 60 giây, idle timeout 10 giây. Đây là full scan, không cắt IDs; bảng quá lớn hoặc DB không đáp ứng sẽ trả ERROR. Công cụ không kiểm lịch sử `balance_after`, không thay constraint lúc commit và không phải scheduler đối soát. Nó cần checkout cùng `test/`/devDependencies, không nằm trong image ứng dụng. Hướng dẫn và bằng chứng: [DBS-69](../docs/features/DBS-69-ledger-invariants.md).

### 10. Token thử ở local

Không cần Cognito. Ở máy dev, app xác minh token bằng một JWKS trong file do bạn tự sinh (ADR-06, DBS-53); mọi kiểm tra khác (`iss`, `client_id`, `token_use`, `exp`, vai trò) giữ nguyên như với token Cognito.

```bash
# từ backend/, lần đầu
npm run auth:dev-keys        # tạo .auth-local/private.pem và .auth-local/jwks.json
```

1. Trong `env/.env.development` **chú thích mọi dòng `COGNITO_*`** (chế độ local cấm chúng, app sẽ không khởi động nếu còn) rồi thêm:

   ```
   AUTH_MODE=local
   AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json
   ```

2. Chạy app: `npm run start:dev`. Log có một dòng cảnh báo `AUTH_MODE=local` là đúng.
3. Lấy token, vai là một trong `customer`, `operator`, `auditor`, `admin`:

   ```bash
   npm run --silent auth:dev-token -- --role operator
   ```

4. Mở http://localhost:3000/docs, bấm **Authorize**, dán token (không gõ `Bearer`), rồi thử endpoint. Hoặc dùng curl:

   ```bash
   TOKEN=$(npm run --silent auth:dev-token -- --role admin)
   curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/identity/me
   ```

Token sống 15 phút. `sub` mặc định là `dev-<vai>`, ổn định giữa các lần chạy nên dùng chung một dòng `users`. Đặt `--sub nguyen-van-an` để tạo thêm một người dùng khác, hoặc `--iat` và `--exp` (giây epoch) để thử token cũ hay đã hết hạn.

- **Đổi khóa:** `npm run auth:dev-keys -- --force` thay cả hai file. App đọc file một lần lúc khởi động, nên phải **khởi động lại** app (`nest start --watch` chỉ theo dõi `src/`); token cấp từ khóa cũ không còn dùng được.
- **Không chạy ở nơi khác:** `AUTH_MODE=local` và `AUTH_LOCAL_JWKS_PATH` bị từ chối khi `NODE_ENV` là `staging` hoặc `production` (app không khởi động); hai lệnh trên cũng từ chối chạy khi `NODE_ENV` không phải `development`, `test` hay trống. Thư mục `.auth-local/` nằm trong `.gitignore` và `.dockerignore`, nên khóa không vào git hay image.
- **Test e2e:** dùng `createDevTokenIssuer()` trong `test/support/dev-tokens.ts` (khóa trong bộ nhớ, không ghi đĩa) và `startLocalAuthApp()` trong `test/support/local-auth-app.ts`. Ví dụ: `test/dev-auth.e2e-spec.ts`.
- **Quyền file:** `private.pem` được tạo với quyền 0600 nếu hệ điều hành hỗ trợ (trên Windows thì không có ý nghĩa); bảo vệ thật là thư mục bị gitignore và việc môi trường triển khai từ chối chế độ này.

### 11. Tra cứu nhật ký kiểm toán

Sau khi migration và ứng dụng local đã chạy, lấy token auditor theo [mục 10](#10-token-thử-ở-local) và tra cứu:

```bash
DBS_AUDIT_TOKEN=$(npm run --silent auth:dev-token -- --role auditor)
curl -sS --get 'http://localhost:3000/v1/audit/entries' \
  -H "Authorization: Bearer $DBS_AUDIT_TOKEN" \
  --data-urlencode 'limit=50'
```

Chỉ nhóm auditor được phép; admin-only cũng nhận 403. Thêm `actorUserId`, `action`, `from`, `to` hoặc `correlationId` để lọc; request sau giữ nguyên bộ lọc và thêm `cursor` lấy từ `nextCursor`, dừng khi null. Mỗi request hợp lệ tự ghi `audit.search` trước khi trả kết quả, kể cả trang rỗng. Response không cache; ID bigint là string, thời gian UTC giữ microsecond. API không có mutation audit. Contract, transaction boundary và giới hạn live keyset ở [module audit](src/modules/audit/README.md#api-tra-cứu-cho-auditor).

`test/manual/audit-search-session.ts` cung cấp session kiểm thủ công trên **DB tạm riêng**, AppModule thật và dữ liệu audit SQL fixture. Chạy với `NODE_ENV=test`, `APP_ROLE=api`, local JWT keys và `DATABASE_URL` quản trị được cấp ngoài transcript; helper nhận `--port` và `--db-name-file`, chỉ bind loopback và in database name/fixture metadata, không in URL hoặc token. Giữ stdin mở rồi gửi `quit` hoặc Ctrl+C để đóng app, khôi phục admin URL và drop đúng DB tạm. Kịch bản Git Bash/curl/psql, đường dẫn Windows và bằng chứng nằm tại [DBS-103](../docs/features/DBS-103-audit-search.md#5-test-thủ-công).

Session helper và dev signing tools chỉ có trong checkout dev/test, không đóng gói vào `dist/`. Role grants có trong code/test DBS-119, triển khai RDS/ECS thật còn BL-103/195; thu hồi phiên Redis/SQL local có trong DBS-114, bằng chứng cloud còn DBS-186. Local/mock/targeted evidence không thay cho production ACL, CI hoặc kiểm trên AWS.

### 12. Dữ liệu demo (scripts/seed.ts, DBS-70)

Script seed tạo dữ liệu mẫu phục vụ trình diễn và kiểm thử hoàn toàn qua HTTP REST API (onboarding khách hàng `POST /v1/customers/me`, mở tài khoản `POST /v1/accounts`, operator nạp tiền `POST /v1/operator/deposits`, chuyển tiền mẫu `POST /v1/transfers`). Script tuyệt đối **không** ghi trực tiếp vào cơ sở dữ liệu (`UPDATE balance` hay `INSERT accounts`), đảm bảo tính toàn vẹn của sổ kép và kiểm tra bất biến sổ cái (`npm run check:invariants`) luôn sạch (`PASS`).

Tính **idempotent**: Khi chạy lại nhiều lần, script tái sử dụng các tài khoản đã tồn tại và replay các lệnh nạp/chuyển tiền bằng các `Idempotency-Key` cố định tất định, không tạo tài khoản trùng và không nhân đôi số dư.

#### Chạy ở local (`AUTH_MODE=local`):
Trước tiên sinh khóa ký và khởi động ứng dụng (hoặc đã có sẵn `.auth-local/private.pem`):
```bash
# Trong thư mục backend/:
npm run seed
# Hoặc chỉ định rõ URL và đường dẫn khóa nếu khác mặc định:
npm run seed -- --url http://127.0.0.1:3000 --key-dir .auth-local
```

#### Chạy trên Cloud / Staging (`AUTH_MODE=cognito`):
Trên môi trường cloud, `dev-auth` bị vô hiệu hóa vì lý do bảo mật. Cần truyền token tương ứng cho 4 vai trò demo thông qua cờ dòng lệnh hoặc biến môi trường:
```bash
# Cách 1: Truyền qua CLI flags
npm run seed -- --auth cloud --url https://api-dev.dbs.internal \
  --operator-token "$DBS_OPERATOR_TOKEN" \
  --customer1-token "$DBS_CUSTOMER_1_TOKEN" \
  --customer2-token "$DBS_CUSTOMER_2_TOKEN" \
  --customer3-token "$DBS_CUSTOMER_3_TOKEN"

# Cách 2: Thiết lập biến môi trường
export AUTH_MODE=cognito
export DBS_API_URL=https://api-dev.dbs.internal
export DBS_OPERATOR_TOKEN="ey..."
export DBS_CUSTOMER_1_TOKEN="ey..."
export DBS_CUSTOMER_2_TOKEN="ey..."
export DBS_CUSTOMER_3_TOKEN="ey..."
npm run seed
```

**Giới hạn khi chạy lại.** Chạy lại seed không nhân đôi tiền nhờ `Idempotency-Key` cố định, nhưng bản ghi `idempotency_keys` bị job dọn xóa sau `IDEMPOTENCY_KEY_RETENTION_DAYS` ngày (mặc định 7, DBS-136). Quá hạn đó, chạy lại seed sẽ nạp và chuyển thêm một lần nữa (sổ cái vẫn cân, số dư tăng): muốn dữ liệu demo sạch thì dựng lại cơ sở dữ liệu thay vì chạy lại seed sau hạn đó (BL-213).

## Docker

```bash
docker build -t dbs-backend backend
docker run --rm -e APP_ROLE=api    --env-file backend/env/.env.development dbs-backend
docker run --rm -e APP_ROLE=worker --env-file backend/env/.env.development dbs-backend
```

### Kết nối RDS qua TLS
Staging và production bắt buộc `DATABASE_SSL=true`, và app **luôn** xác minh chứng chỉ của server (`rejectUnauthorized: true`). Node không tin CA của Amazon RDS mặc định, nên Dockerfile tải `global-bundle.pem` vào `/etc/ssl/rds/global-bundle.pem` (`ADD --checksum=sha256:…`, cần BuildKit) và task đặt `DATABASE_SSL_CA_PATH` trỏ tới file đó. **Không** tắt xác minh chứng chỉ để "cho kết nối được".

**Ghép `DATABASE_URL` từ secret (DBS-67).** ECS `secrets` không nối chuỗi được, nên task truyền `DB_HOST`, `DB_PORT`, `DB_NAME` (biến thường) và `DB_USER`, `DB_PASSWORD` (từ secret master do RDS quản lý). `env.bootstrap` ghép thành `DATABASE_URL` (user và mật khẩu được mã hóa URL). `DATABASE_URL` đã có giá trị thì được giữ nguyên. Giá trị `DB_*` sai chỉ làm log nêu **tên** biến, không in giá trị. CLI typeorm cũng đi qua `env.bootstrap` nên dùng được cách này.

**Làm mới hash khi AWS đổi bundle.** Build đỏ ở dòng `ADD --checksum` nghĩa là AWS đã cập nhật bundle. Tải bản mới từ nguồn chính thức của AWS RDS, kiểm tra nội dung PEM, tính SHA-256 rồi cập nhật hằng số trong `backend/Dockerfile`:
```bash
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /tmp/global-bundle.pem
sha256sum /tmp/global-bundle.pem
# Thay giá trị --checksum=sha256:<hash_mới> ở dòng ADD trong backend/Dockerfile, sau đó kiểm tra:
npm test -- test/support/dockerfile.spec.ts
```

Bước `docker build` và kết nối RDS thật **chưa chạy** (BL-106).

### Kết nối Redis (Valkey) trên AWS

**Ghép `REDIS_URL` (DBS-75).** Giống `DATABASE_URL`: task truyền `REDIS_HOST`, `REDIS_PORT` (biến thường) và `REDIS_AUTH_TOKEN` (từ secret `dbs/dev/redis-auth`). `env.bootstrap` ghép thành `rediss://:<token đã mã hóa URL>@<host>:<port>`. `REDIS_URL` đã có giá trị (local, CI) thì được giữ nguyên; thiếu `REDIS_HOST` thì không ghép. Giá trị sai (host lạ, cổng ngoài 1–65535, token rỗng) chỉ làm log nêu **tên** biến, không in giá trị, và schema báo thiếu `REDIS_URL`. Staging và production bắt buộc `rediss://` (TLS). Client Redis có ở `@libs/redis` (DBS-76) nhưng chưa nối vào module nào.

### Hạ tầng phía trước app
Staging và production bắt buộc `TRUST_PROXY_HOPS` (≥ 1; ALB = 1). Để 0 thì mọi khách chung địa chỉ IP của ALB và rate limit theo IP sẽ chặn nhầm tất cả.

Image không có `HEALTHCHECK`: service `api` được load balancer kiểm tra qua `/health/ready`, service `worker` không có cổng HTTP: ECS thay task khi tiến trình thoát, còn worker treo được phát hiện qua alarm tuổi outbox và tuổi message (docs/03 §14).


### Thu hồi phiên ngay khi khóa tài khoản

Guard ưu tiên marker epoch giây trong Redis để từ chối token cũ; miss/lỗi/chậm hoặc marker chưa đủ kết luận thì đọc PostgreSQL. Không cacheNULL, không cho phép từ cache cũ. Endpoint khóa publish cache chỉ sau COMMIT của attempt cuối; Redis SET lỗi vẫn giữ kết quả SQL. TTL dùng ACCESS_TOKEN_TTL_SECONDS, mặc định900. Unlock không hồi sinh token cũ.

Chạy riêng: npm run test:db -- --runInBand --runTestsByPath test/db/session-revocation-cache.db-spec.ts (PG17/Valkey/proxy riêng, actual API role). Manual Git Bash: node scripts/manual-dbs114.cjs; có rollback, retry40001, stop/start/slow Redis và haiAPI dùng stale cache khi SET bị ACL từ chối. [Thiết kế/bằng chứng DBS-114](../docs/features/DBS-114-session-revocation.md).
