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
| `npm run migration:run` · `migration:revert` · `migration:show` | migration trên DB local |
| `npm run migration:generate -- src/database/migrations/<Tên>` | sinh migration từ thay đổi entity |
| `npm run migration:create -- src/database/migrations/<Tên>` | tạo migration rỗng |

Trước khi mở Pull Request: `npm run lint:check && npm run typecheck && npm test && npm run test:e2e`.

## Cấu trúc

```
backend/
├── src/
│   ├── main.ts              # chọn http hay worker theo APP_ROLE
│   ├── app.module.ts
│   ├── app.setup.ts         # cấu hình HTTP dùng chung với test: correlation id, helmet, CORS, version, filter, pipe
│   ├── common/              # app-role, errors (ErrorCode), filters, middleware, utils — không chứa nghiệp vụ
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
- Lỗi lạ → 500 với nội dung chung chung; chi tiết thật chỉ nằm trong log (kèm `correlationId`), không bao giờ ra client.
- **`correlationId` luôn do server sinh** (header `X-Correlation-Id`); client không chọn được, nên không ai dùng lại id của người khác để làm nhiễu truy vết audit. Id do client gửi qua `X-Request-Id` (phải là UUID) chỉ được trả lại nguyên vẹn để client đối chiếu request, không dùng cho audit.

### 4. Ranh giới module do eslint ép
Xem `src/modules/README.md`. Import xuyên module chỉ qua `@modules/<tên>`; với tay vào ruột module khác (alias hoặc `../`) là lỗi lint.

### 5. Test
- Unit test đặt **cạnh file** được test (`*.spec.ts`).
- Test đúng-sai về tiền (đồng thời, idempotency) chạy trên **PostgreSQL thật** (Testcontainers), không mock database. Test `withTransaction` hiện tại dùng fake chỉ để kiểm tra logic retry/rollback — nó **không** chứng minh hành vi khóa của Postgres.
- Test e2e dùng `configureHttpApp` từ `app.setup.ts` để chạy đúng cấu hình như production.

### 6. Migration
Không bao giờ chạy lúc app khởi động (`synchronize: false`). Viết theo kiểu **expand → migrate → contract** để bản cũ vẫn chạy được trong lúc deploy. Trên pipeline: `npm run migration:run:prod` (chạy từ `dist/`).

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

Image không có `HEALTHCHECK`: service `api` được load balancer kiểm tra qua `/health/ready`, service `worker` không có cổng HTTP nên tự định nghĩa kiểm tra riêng ở ECS.
