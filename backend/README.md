# backend

Một ứng dụng NestJS (TypeScript strict). **Một image, chạy theo `APP_ROLE`:** trên ECS là hai service dùng chung image, ở local chạy cả hai trong một process.

| `APP_ROLE` | Chạy | Không chạy | Dùng ở |
|---|---|---|---|
| `api` | HTTP (controller) | consumer, scheduler | ECS service `api` |
| `worker` | outbox relay, risk scoring, notification | HTTP listener | ECS service `worker` |
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
| http://localhost:3000/health/ready | kết nối được PostgreSQL |
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
| `npm run migration:run` · `migration:revert` · `migration:show` | migration trên DB local |
| `npm run migration:generate -- src/database/migrations/<Tên>` | sinh migration từ thay đổi entity |
| `npm run migration:create -- src/database/migrations/<Tên>` | tạo migration rỗng |

Trước khi mở Pull Request: `npm run lint:check && npm run typecheck && npm test && npm run test:e2e && npm run test:db`. CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) giữ sáu job `lint`, `typecheck`, `unit`, `e2e`, `db`, `build`. Job `e2e` chạy thêm sample DBS-39 và migration run → revert → run qua Testcontainers với `DATABASE_URL` được gỡ bỏ; job `db` vẫn chạy toàn bộ DB suite trên PostgreSQL service. Lệnh này không revert database dùng chung: test tạo và xóa database `dbs_test_*` riêng. Cách đọc kết quả: [CONTRIBUTING mục 4b](../CONTRIBUTING.md#4b-đọc-kết-quả-ci-trên-github-actions).

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
│   ├── libs/                # adapter dịch vụ ngoài (redis, sqs, cognito)
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
Không bao giờ chạy lúc app khởi động (`synchronize: false`). Viết theo kiểu **expand → migrate → contract** để bản cũ vẫn chạy được trong lúc deploy. Trên pipeline: `npm run migration:run:prod` (chạy từ `dist/`). Entity và SQL viết tay dùng chung tên cột nhờ `SnakeNamingStrategy` (`src/database/snake-naming.strategy.ts`, bật ở cả app lẫn CLI); entity ghi tên bảng tường minh (`@Entity('accounts')`). Mỗi migration có test trong `test/db/` (`npm run test:db`). `npm run migration:revert` chỉ hoàn tác migration **mới nhất**; migration `down` có `DROP TABLE` tự từ chối khi bảng đã có dữ liệu (migration 1, 2, outbox và audit). Migration 2 (`CreateTransfersLedgerIdempotency`) cần quyền superuser trong test `test:db` ở ca TC-21-24 (dùng `session_replication_role`); role `banking` của docker compose đã là superuser.


**Schema outbox.**

Migration `1792627200000-CreateOutboxEventsProcessedEvents` tạo outbox/processed và hai partial index. Down cần transaction READ COMMITTED; khóa bảng trước kiểm dữ liệu, không cho DROP nếu còn dòng. Test schema legacy dùng `migrateThrough` phiên bản thật; CLI regression vẫn chạy production tới latest và revert từng bước. Runtime writer/relay chưa có.

**Schema audit.**

Migration `1792627200001-CreateAuditLog` ([DBS-26](../docs/features/DBS-26-migration-audit-log.md)) tạo `audit_log` với ba index theo correlation, actor/thời gian và action/thời gian. Revert audit yêu cầu transaction READ COMMITTED và bảng rỗng: guard kiểm isolation trước khóa ACCESS EXCLUSIVE, sau đó kiểm dữ liệu bằng statement mới; có dữ liệu thì SQLSTATE `55000` và giữ schema/history. Không xóa audit để ép rollback. Test nền 20/21 chọn prefix bằng helper test, còn CLI production luôn chạy latest theo lịch sử thực.

**Append-only.**

Migration `1792627200002-AddAppendOnlyTriggers` đặt hàm `public.forbid_mutation()` và sáu trigger cho `transfers`, `ledger_entries`, `audit_log`: [DBS-27](../docs/features/DBS-27-append-only-triggers.md). INSERT vẫn được; UPDATE/DELETE có hàng và TRUNCATE kể cả bảng rỗng bị `42501` từ trigger. Revert27 chỉ gỡ trigger/hàm, giữ dữ liệu/sequence, nên phải đánh giá việc bỏ lớp bảo vệ trước khi dùng ngoài DB tạm. Test schema của từng migration dùng prefix thật; CLI vẫn run latest và đọc lịch sử khi revert. Quyền production thuộc task roles, không suy ra từ owner fixture.

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

`MoneyError` (`reason`: `INVALID`, `OVERFLOW`, `UNDERFLOW`, `NOT_POSITIVE`) không phải lỗi HTTP: bắt nó ở chỗ có ý nghĩa nghiệp vụ; lọt ra ngoài thì thành 500 chung chung, không lộ gì. Lỗi DTO là 400 với danh sách `errors`, **không có `errorCode`** (client chỉ cần sửa và gửi lại). `main.ts` và `configureHttpApp` gọi `installBigIntJson()` để `JSON.stringify` ra chuỗi cho `bigint` còn sót; đó là lưới an toàn, không thay cho `formatMoney`. Chưa có luật lint chặn `parseInt`/`Number` trên tiền (BL-008): review code phải bắt.

### 8. Log JSON

Log ứng dụng dùng `nestjs-pino`, mỗi dòng là một JSON object trên stdout, áp dụng cả API, worker và bootstrap. Thông báo npm/compiler/Docker không thuộc log ứng dụng.

| Trường | Quy ước |
|---|---|
| `level` | Số Pino: trace 10, debug 20, info 30, warn 40, error 50, fatal 60 |
| `time` | ISO 8601 UTC, có `Z` |
| `message` | Thông điệp chẩn đoán cố định, không nội suy dữ liệu cá nhân hoặc error text |
| `role` | `api` hoặc `worker`; tiến trình `both` mặc định `api`, HTTP luôn `api` |
| `appRole` | Vai trò tiến trình `api`, `worker` hoặc `both` |
| `correlationId` | UUID server của HTTP request; `null` ngoài request/context |

`LOG_LEVEL` giữ nguyên sáu giá trị: `verbose`→trace, `debug`→debug, `log`→info, `warn`→warn, `error`→error, `fatal`→fatal. Chỉ ghi mức đã chọn và các mức nghiêm trọng hơn. Dùng `new Logger(TenService.name)` từ Nest để log đi qua cùng cấu hình.

HTTP completion chỉ ghi method, status và thời gian xử lý; không ghi URL/path/query, headers/cookies, địa chỉ mạng hoặc request/response body. Logger gắn trước CORS và body parser để cả preflight và JSON lỗi có correlationId. Log retry và filter lỗi chỉ ghi thông điệp cố định, số lần thử và mã SQLSTATE/network được phép. Error message/stack/cause và SQL/parameters không được ghi.

**Che dữ liệu nhạy cảm.** Khoá được chuẩn hóa (chữ thường, bỏ `_` và `-`) rồi so với danh sách: `authorization`, `password`, `passwd`, `pwd`, `secret`, `token`, `cookie`, `credential`, `apikey`, `privatekey`, `passphrase`, `jwt`, `iban`, `cvv`, `securitycode`, `connectionstring`, `databaseurl` (chứa chuỗi con); `pan`, `cardpan`, `pannumber`, `otpcode`, `totp`, `mfacode`, `smscode`, `pincode`, `cvc2`, `sid`, `sessionid`, `pass`, `dsn`, `signature`, `auth` (nguyên khoá); và khoá kết thúc bằng `accountno`, `accountnum`, `cardno`, `cardnum`, `pin`, `otp`, `cvc` (ví dụ `toAccountNo`, `newPin`). `headers` và `rawHeaders` bị bỏ hẳn. `footprint`, `panel`, `span`, `cardNotPresent`, `accountNotFound` không bị che. Mọi giá trị chuỗi (không chỉ `message`) còn được quét: URI có credential, `Bearer`/`Basic`, `Authorization: …`, các cặp `tên=giá trị` như `PGPASSWORD`, `client_secret`, `password_hash` (kể cả JSON và JSON mã hóa hai lần) và JWT thô. Đây là lớp bảo vệ bổ sung: **không truyền payload khách hàng hoặc chuỗi lỗi thô vào logger**. Log vận hành không thay cho audit log trong transaction.

**Envelope và độ bền.** Mỗi khoá `level`, `time`, `message`, `appRole`, `role`, `correlationId` xuất hiện đúng một lần: object bạn truyền vào log không đặt được các khoá này (kể cả giá trị hợp lệ). `message` luôn là chuỗi; đối số không có chỗ điền trong chuỗi định dạng bị bỏ. Một lời gọi log hỏng (getter ném lỗi, Proxy bị thu hồi) không bao giờ làm hỏng kết quả của caller: `SafeLogger` (bọc `Logger` của Nest) và hook của pino ghi dòng cố định `Log call failed` thay vì ném lỗi. Chuỗi dài hơn 4096 ký tự thành `[Omitted]`, mỗi lần ghi log quét tối đa 64 KiB và giữ 1000 phần tử đầu của một mảng.

**Lỗi khi khởi động và lỗi cấp tiến trình.** Cấu hình sai (Joi hoặc `APP_ROLE`) ghi một dòng `Application startup failed` có `invalidKeys`: tên biến sai, hoặc `<cross-field>` cho quy tắc giữa nhiều biến, **không** kèm giá trị. `uncaughtException` và `unhandledRejection` ghi đúng một dòng JSON `level:60` rồi thoát mã 1, không in stack ra stderr.

**Giới hạn đã biết:**
- Heuristic che số từ 8 chữ số chỉ chạy trên `message`; số tài khoản trong field khác chỉ được che theo tên khoá (v1 định danh tài khoản bằng UUID).
- Tên khoá bí mật không có trong danh sách ở trên vẫn lọt; giá trị bí mật dạng khác (ví dụ chuỗi base64 trần) không bị quét.
- Binding của `logger.child(...)`, `PinoLogger.assign()` và `runInContext` do code khác tạo **không** được che hay khử trùng khoá (pino đặt lại bộ lọc binding ở mỗi child); gán lại `correlationId` trên logger đã có cho hai khoá. Code gọi thẳng `PinoLogger` hoặc `req.log` chỉ được bảo vệ ở hook của pino, không qua `SafeLogger`.
- Lỗi ném đồng bộ khi nạp `env.bootstrap` và cảnh báo `process.emitWarning` (ví dụ `sslmode` của `pg-connection-string`) vẫn ra stderr dạng text.
- Dòng log đang ghi dở khi tiến trình crash có thể bị cắt và dính với dòng `fatal`; dòng trước crash có thể xuất hiện sau `fatal` (dùng `time` để sắp xếp).
- Lỗi nội bộ do Nest hoặc TypeORM phát ra (`ExceptionHandler`, `TypeOrmModule`) chỉ còn `context`, loại lỗi, mã SQLSTATE và thông điệp `Diagnostic event`, vì message gốc có thể chứa SQL hoặc credential.
- Khi chạy `both`, tác vụ nền log `role=api` cho tới khi DBS-43 gắn context (`role=worker`); context xuyên worker/message và provider AsyncLocalStorage chung thuộc DBS-43.

Chi tiết và bằng chứng: [DBS-42](../docs/features/DBS-42-json-logger.md).

## Docker

```bash
docker build -t dbs-backend backend
docker run --rm -e APP_ROLE=api    --env-file backend/env/.env.development dbs-backend
docker run --rm -e APP_ROLE=worker --env-file backend/env/.env.development dbs-backend
```

### Kết nối RDS qua TLS
Staging và production bắt buộc `DATABASE_SSL=true`, và app **luôn** xác minh chứng chỉ của server. Node không tin CA của Amazon RDS mặc định, nên cần tải bundle CA của AWS (`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`) vào image trong pipeline và đặt `DATABASE_SSL_CA_PATH` trỏ tới file đó. **Không** tắt xác minh chứng chỉ để "cho kết nối được": như vậy vẫn mã hóa nhưng chấp nhận mọi chứng chỉ, kể cả của kẻ tấn công. Bước tải bundle chưa được thử trên RDS thật — #5 kiểm khi dựng RDS ở tuần 2.

### Hạ tầng phía trước app
Staging và production bắt buộc `TRUST_PROXY_HOPS` (≥ 1; ALB = 1). Để 0 thì mọi khách chung địa chỉ IP của ALB và rate limit theo IP sẽ chặn nhầm tất cả.

Image không có `HEALTHCHECK`: service `api` được load balancer kiểm tra qua `/health/ready`, service `worker` không có cổng HTTP: ECS thay task khi tiến trình thoát, còn worker treo được phát hiện qua alarm tuổi outbox và tuổi message (docs/03 §14).
