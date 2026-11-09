# Thiết kế REST API & Hợp đồng HTTP (`api-design`)

> **Status:** Implemented (12/18 endpoints trên `main`; 6 endpoints UC-10/11/12 ở trạng thái thiết kế đã chốt) · **Owner:** cả nhóm · **Verified against code:** `2026-11-08` · **Cập nhật:** `2026-11-08`
>
> Tài liệu này là nơi tập trung đặc tả hợp đồng HTTP/REST API của toàn hệ thống Digital Banking Simulator (`APP_ROLE=api`), đồng bộ với [`docs/03_HIGH_LEVEL_ARCHITECTURE.md` §7](../../03_HIGH_LEVEL_ARCHITECTURE.md#7-api-tổng-quan), [`database-design.md`](database-design.md), [`event-contract.md`](event-contract.md) và cấu hình runtime trong [`backend/src/app.setup.ts`](../../../backend/src/app.setup.ts).

---

## 1. Quy ước HTTP Toàn cục

### 1.1. Phiên bản URI & Cổng giao tiếp
- **URI Versioning:** Mọi endpoint nghiệp vụ đều mang tiền tố `/v1/...` (`VersioningType.URI, defaultVersion: '1'`).
- **Ngoại lệ duy nhất (`VERSION_NEUTRAL`):** Hai probe sức khỏe cho Load Balancer là `GET /health/live` và `GET /health/ready` không mang tiền tố `/v1` để giữ đường dẫn cố định xuyên suốt các phiên bản API.
- **OpenAPI / Swagger:** Khi chạy ở môi trường khác `production`, tài liệu Swagger UI được phục vụ tại `/docs` và JSON OpenAPI 3.0 tại `/docs-json` ([`setupSwagger`](../../../backend/src/app.setup.ts)).

### 1.2. Headers Chuẩn

| Header | Chiều | Bắt buộc? | Quy ước & Hành vi trong Code |
|---|---|---|---|
| `Authorization` | Request | Có (trừ `/health/*`) | `Bearer <Cognito_RS256_Access_Token>`. Xác thực qua [`JwtAuthGuard`](../../../backend/src/modules/identity/jwt-auth.guard.ts) + [`JwksVerifierService`](../../../backend/src/modules/identity/jwks-verifier.service.ts). Chỉ chấp nhận token có `token_use = "access"`. |
| `X-Correlation-Id` | Cả hai | Tự sinh nếu thiếu | UUID chuẩn (`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`). Nếu client gửi giá trị không khớp UUID (hoặc quá 64 ký tự), [`correlationIdMiddleware`](../../../backend/src/common/middleware/correlation-id.middleware.ts) sẽ bỏ qua và tự sinh `randomUUID()` mới để chống log injection. Luôn trả lại ở header phản hồi và trong body lỗi. |
| `X-Request-Id` | Request | Tùy chọn | Bí danh dự phòng nếu thiếu `X-Correlation-Id`. |
| `Idempotency-Key` | Request | Bắt buộc ở `POST /v1/transfers` và `POST /v1/operator/deposits` | Chuỗi `1..128` ký tự (sau `trim()`). Phạm vi khóa là `(user_id, idem_key)` được giữ ít nhất 7 ngày (cấu hình `IDEMPOTENCY_KEY_RETENTION_DAYS`, chỉ thành lệnh mới khi key hết hạn và đã bị dọn) ([ADR-05](../../adr/0005-idempotency-in-postgres.md)). Thiếu header trả `400 IDEMPOTENCY_KEY_REQUIRED`; quá 128 ký tự trả `400`; trùng key + cùng body trả lại đúng kết quả cũ; trùng key + khác body trả `422 IDEMPOTENCY_KEY_REUSED`. |
| `Retry-After` | Response | Khi `429` hoặc `503` | Số giây nguyên mà client cần chờ trước khi gửi lại request (ví dụ: số giây còn lại của phút hiện tại khi `429 RATE_LIMITED`, hoặc `1` / `5` giây khi `503 SERVICE_TEMPORARILY_UNAVAILABLE`). |
| `Cache-Control` | Response | Ở các GET nhạy cảm | Giá trị `no-store` trên lịch sử giao dịch, trạng thái lệnh chuyển, tìm kiếm tài khoản của operator và nhật ký kiểm toán. |

### 1.3. Kiểu dữ liệu Tiền tệ, Định danh & Thời gian
1. **Tiền tệ (VND):**
   - Trong mọi JSON request và response, tiền tệ **bắt buộc là `string` biểu diễn số nguyên đồng** (ví dụ `"500000"`, không có dấu chấm/phẩy, không có số 0 đứng đầu trừ `"0"`, không có phần thập phân, không dùng JSON `number`).
   - Trên request tạo giao dịch (`amount`), decorator [`@IsMoneyAmount()`](../../../backend/src/common/money/is-money-amount.decorator.ts) kiểm tra miền giá trị nguyên dương từ `"1"` đến `"9223372036854775807"` ($2^{63}-1$).
   - Trên response (`balance`, `balanceAfter`), [`installBigIntJson()`](../../../backend/src/common/money/bigint-json.ts) và [`formatBalance()`](../../../backend/src/common/money/balance.ts) đảm bảo giá trị `bigint` từ PostgreSQL luôn serialize thành chuỗi nguyên chính xác.
2. **Định danh (`UUID` & `bigint`):**
   - Các khóa `UUID` (`accountId`, `transferId`, `actorUserId`, `correlationId`) được chuẩn hóa về chữ thường (`lowercase`).
   - Các khóa tự tăng `BIGINT` (`ledger_entries.id`, `audit_log.id`) trả về dưới dạng chuỗi số thập phân (`entryId: "9007199254740994"`).
3. **Thời gian (`timestamptz`):**
   - Luôn ở múi giờ **UTC** có hậu tố `Z` theo chuẩn ISO-8601.
   - Các điểm truy vấn con trỏ (`GET /v1/accounts/:id/transactions`, `GET /v1/transfers/:id`, `GET /v1/audit/entries`) giữ nguyên độ chính xác **6 chữ số thập phân microsecond** của PostgreSQL (`"2026-11-04T08:10:00.123456Z"`) để con trỏ keyset không bị lệch.
   - Riêng hạn mức chuyển tiền theo ngày (`LIMIT_PER_DAY_EXCEEDED`) tính mốc `00:00:00` theo giờ Việt Nam (`Asia/Ho_Chi_Minh`, `UTC+7` — [DBS-84](../../features/DBS-84-daily-limit-vn-time.md)).

### 1.4. Validation, Body Size Limit & Bảo mật Chống Lộ Thông Tin (Anti-Enumeration)
- **Body Parser Limit:** Giới hạn mặc định `100kb` của Express/Nest. Body vượt ngưỡng trả `413 Payload Too Large` qua [`ProblemDetailsFilter`](../../../backend/src/common/filters/problem-details.filter.ts) mà không ghi lộ nội dung body vào log.
- **Strict ValidationPipe:** `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. Mọi trường lạ không khai báo trong DTO hoặc query param lạ đều bị từ chối với `400 Bad Request`.
- **Chống BOLA / IDOR (AC-5.8):** Khi một `customer` truyền `accountId` hoặc `transferId` không tồn tại, sai định dạng UUID, thuộc về khách hàng khác, hoặc là tài khoản hệ thống `SYSTEM_CASH`, API **luôn trả về cùng một mã `404 Not Found`** (sau khi đã ghi `audit_log` với `outcome = 'DENIED'`) thay vì `403 Forbidden`, nhằm không tiết lộ tài nguyên đó có tồn tại hay không.
- **Không lộ thông tin gian lận cho khách hàng (BR-13, AC-10.2):** Mọi response trả về cho vai trò `customer` (`AccountViewDto`, `TransactionItemDto`, `TransferStatusDto`) đều liệt kê từng trường tường minh (whitelist) và **tuyệt đối không bao giờ chứa** điểm rủi ro (`score`), mức rủi ro (`riskLevel`) hay trạng thái cờ gian lận (`fraud_flags`).

### 1.5. Phân trang bằng Con trỏ (Keyset / Cursor Pagination)
Hệ thống **không dùng `OFFSET`** trên các bảng lớn (`ledger_entries`, `audit_log`, `fraud_flags`). Thay vào đó:
- Request truyền `limit` và `cursor` (chuỗi `base64url` không đệm, khớp `^[A-Za-z0-9_-]+$`, dài tối đa 512 ký tự).
- Con trỏ mã hóa vị trí dòng cuối cùng của trang trước kèm chữ ký bộ lọc (`from`, `to`, `actorUserId`, `action`, `correlationId`). Nếu client giữ nguyên `cursor` nhưng đổi bộ lọc ở lần gọi tiếp theo, API trả `400 Bad Request`.
- Response trả `{ items/entries: [...], nextCursor: string | null }` (`nextCursor = null` khi đã hết trang).

---

## 2. Định dạng Lỗi Chuẩn (`application/problem+json` — RFC 7807 / RFC 9457)

Mọi phản hồi lỗi đều đi qua [`ProblemDetailsFilter`](../../../backend/src/common/filters/problem-details.filter.ts) với header `Content-Type: application/problem+json; charset=utf-8`:

```json
{
  "type": "about:blank",
  "title": "Unprocessable Entity",
  "status": 422,
  "detail": "Insufficient funds",
  "errorCode": "INSUFFICIENT_FUNDS",
  "transferId": "7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a",
  "correlationId": "d461b1d0-dba2-4e40-8304-d91f7b7132c9"
}
```

Khi lỗi do `ValidationPipe` (400), phản hồi có thêm mảng `errors: string[]` và không có `errorCode`:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "Validation failed",
  "errors": [
    "amount must be a positive whole VND string (1..9223372036854775807)"
  ],
  "correlationId": "d461b1d0-dba2-4e40-8304-d91f7b7132c9"
}
```

### Bảng 14 Mã lỗi chuẩn (`ErrorCode`)
Định nghĩa duy nhất tại [`backend/src/common/errors/error-code.enum.ts`](../../../backend/src/common/errors/error-code.enum.ts):

| `errorCode` | HTTP Status | Ý nghĩa & Điều kiện kích hoạt | Có lưu `transfers.reject_reason`? |
|---|---|---|---|
| `ACCOUNT_NOT_ACTIVE` | `422` | Tài khoản nguồn hoặc đích đang `LOCKED`, không tồn tại (với đích của lệnh chuyển/nạp) hoặc là `SYSTEM` (với đích nạp tiền). | Có (`transferId` trả kèm trong body 422) |
| `LIMIT_PER_TX_EXCEEDED` | `422` | Số tiền vượt `TRANSFER_LIMIT_PER_TX` (mặc định `50000000` VND = 50 triệu). | Có (`transferId` trả kèm trong body 422) |
| `LIMIT_PER_DAY_EXCEEDED` | `422` | Tổng tiền chuyển thành công trong ngày (giờ VN) cộng lệnh hiện tại vượt `TRANSFER_LIMIT_PER_DAY` (mặc định `200000000` VND = 200 triệu). | Có (`transferId` trả kèm trong body 422) |
| `INSUFFICIENT_FUNDS` | `422` | Số dư tài khoản nguồn nhỏ hơn `amount`. | Có (`transferId` trả kèm trong body 422) |
| `IDEMPOTENCY_KEY_REQUIRED` | `400` | Thiếu hoặc rỗng header `Idempotency-Key` trên `POST /v1/transfers` hoặc `POST /v1/operator/deposits`. | Không |
| `IDEMPOTENCY_KEY_REUSED` | `422` | Gửi lại cùng `(userId, Idempotency-Key)` khi key còn được giữ (tối thiểu 7 ngày) nhưng khác endpoint hoặc khác nội dung body (`request_hash`). | Không |
| `ACCOUNT_LIMIT_REACHED` | `409` | Khách hàng đã có đủ 3 tài khoản (tính cả `ACTIVE` và `LOCKED`) khi gọi `POST /v1/accounts`. | Không |
| `UNAUTHENTICATED` | `401` | Thiếu header `Authorization: Bearer`, JWT sai cấu trúc, sai chữ ký, sai `iss`/`client_id`/`token_use`, hoặc lỗi kết nối khi tra cứu `users`. | Không |
| `TOKEN_EXPIRED` | `401` | Access token có chữ ký đúng nhưng đã quá hạn `exp` (cho phép client dùng refresh token lấy token mới). | Không |
| `SESSION_REVOKED` | `401` | Access token có `iat <= floor(epoch(users.sessions_revoked_at))`; Redis ưu tiên từ chối, còn lại xác nhận SQL (phiên bị thu hồi ngay khi khóa). | Không |
| `FORBIDDEN` | `403` | Người gọi đã xác thực nhưng không thuộc nhóm vai trò mà `@Roles(...)` yêu cầu. | Không |
| `RATE_LIMITED` | `429` | Vượt ngưỡng `100 req/phút/IP` hoặc `10 lệnh chuyển/phút/khách`. Luôn kèm header `Retry-After`. | Không |
| `SERVICE_TEMPORARILY_UNAVAILABLE` | `503` | Lỗi cơ sở dữ liệu tạm thời (deadlock sau khi đã retry, lock timeout `55P03`, hết kết nối pool). Luôn kèm header `Retry-After`. | Không |
| `FLAG_ALREADY_REVIEWED` | `409` | Operator gọi duyệt cờ gian lận (`UC-10`) trên một cờ đã có kết luận trước đó (`review_status != 'OPEN'`). | Không |

---

## 3. Ma trận Tổng hợp 18 Endpoints

| # | Method & Path | Vai trò (`@Roles`) | UC | Rate Limit | Idempotency | Audit Action | Trạng thái trên `main` |
|---|---|---|---|---|---|---|---|
| 1 | `GET /health/live` | `@Public()` | — | Miễn | — | — | **Implemented** ([DBS-78](../../features/DBS-78-health-redis-degraded.md)) |
| 2 | `GET /health/ready` | `@Public()` | — | Miễn | — | — | **Implemented** ([DBS-78](../../features/DBS-78-health-redis-degraded.md)) |
| 3 | `GET /v1/identity/me` | Mọi vai trò đã đăng nhập | — | `100/phút/IP` | — | — | **Implemented** ([DBS-50](../../features/DBS-50-jwt-auth-guard-jwks.md)) |
| 4 | `POST /v1/customers/me` | `customer` | UC-1 | `100/phút/IP` | Tự nhiên theo `user_id` | `customer.onboard` / `customer.profile.read` | **Implemented** ([DBS-63](../../features/DBS-63-open-accounts.md)) |
| 5 | `GET /v1/customers/me` | `customer` | UC-1 | `100/phút/IP` | — | `customer.profile.read` | **Implemented** ([DBS-63](../../features/DBS-63-open-accounts.md)) |
| 6 | `POST /v1/accounts` | `customer` | UC-2 | `100/phút/IP` | — | `account.open` | **Implemented** ([DBS-63](../../features/DBS-63-open-accounts.md)) |
| 7 | `GET /v1/accounts` | `customer` | UC-4 | `100/phút/IP` | — | `account.list` | **Implemented** ([DBS-64](../../features/DBS-64-read-accounts.md)) |
| 8 | `GET /v1/accounts/:id` | `customer` | UC-4 | `100/phút/IP` | — | `account.read` | **Implemented** ([DBS-64](../../features/DBS-64-read-accounts.md)) |
| 9 | `GET /v1/accounts/:id/transactions` | `customer` | UC-6 | `100/phút/IP` | — | `account.transactions` | **Implemented** ([DBS-87](../../features/DBS-87-history-and-transfer-status.md)) |
| 10 | `POST /v1/transfers` | `customer` | UC-5 | `100/phút/IP` + `10/phút/khách` | Bắt buộc (`Idempotency-Key`) | `transfer.create` | **Implemented** ([DBS-61](../../features/DBS-61-customer-transfers.md)) |
| 11 | `GET /v1/transfers/:id` | `customer` | UC-7 | `100/phút/IP` | — | `transfer.read` | **Implemented** ([DBS-87](../../features/DBS-87-history-and-transfer-status.md)) |
| 12 | `POST /v1/operator/deposits` | `operator` | UC-3 | `100/phút/IP` | Bắt buộc (`Idempotency-Key`) | `deposit.create` | **Implemented** ([DBS-60](../../features/DBS-60-operator-deposits.md)) |
| 13 | `GET /v1/operator/accounts` | `operator` | UC-3, UC-11 | `100/phút/IP` | — | `operator.account.search` | **Implemented** ([DBS-88](../../features/DBS-88-operator-account-search.md)) |
| 14 | `GET /v1/audit/entries` | `auditor` | UC-8 | `100/phút/IP` | — | `audit.search` | **Implemented** ([DBS-103](../../features/DBS-103-audit-search.md)) |
| 15 | `POST /v1/operator/accounts/:id/lock` | `operator` | UC-11 | `100/phút/IP` | Idempotent theo trạng thái | `account.lock` | **Planned** (`docs/03` §6.2, §7) |
| 16 | `POST /v1/operator/accounts/:id/unlock` | `operator` | UC-11 | `100/phút/IP` | Idempotent theo trạng thái | `account.unlock` | **Planned** (`docs/03` §6.2, §7) |
| 17 | `GET /v1/operator/fraud-flags` (`+:transferId`, `POST .../review`) | `operator` | UC-10 | `100/phút/IP` | Chặn review lần 2 (`409`) | `fraud_flag.view` / `fraud_flag.review` | **Planned** ([`risk/02-architecture.md`](../risk/02-architecture.md)) |
| 18 | `GET /v1/admin/risk-config` (`+POST .../versions`) | `admin` | UC-12 | `100/phút/IP` | Version tăng đơn điệu | `risk_config.create` | **Planned** ([`risk/02-architecture.md`](../risk/02-architecture.md)) |

---

## 4. Đặc tả Chi tiết Từng Endpoint Đã Triển khai (`Implemented`)

### 4.1. Nhóm Health Probes ([`HealthController`](../../../backend/src/modules/health/health.controller.ts))

#### `GET /health/live`
- **Auth:** `@Public()` (không cần JWT, không bị đếm IP rate limit).
- **Mục đích:** Liveness probe cho ECS/ALB; trả `200 OK` ngay khi tiến trình Node.js còn sống.
- **Response `200 OK`:**
  ```json
  { "status": "ok" }
  ```

#### `GET /health/ready`
- **Auth:** `@Public()` (không cần JWT, không bị đếm IP rate limit).
- **Mục đích:** Readiness probe cho ALB Target Group. Chỉ **PostgreSQL** quyết định trạng thái sống/chết của instance (`pingCheck` timeout `1500ms`); nếu Valkey/Redis chậm hoặc mất kết nối, trường `redis` chuyển sang `"degraded"` nhưng HTTP vẫn trả `200 OK` để ALB không rút hết task khỏi vùng phục vụ ([DBS-78](../../features/DBS-78-health-redis-degraded.md)).
- **Response `200 OK`:**
  ```json
  {
    "status": "ok",
    "redis": "up",
    "info": { "database": { "status": "up" } },
    "error": {},
    "details": { "database": { "status": "up" } }
  }
  ```
- **Response `503 Service Unavailable`:** Khi PostgreSQL không phản hồi trong `1500ms`.

---

### 4.2. Nhóm Identity ([`IdentityController`](../../../backend/src/modules/identity/identity.controller.ts))

#### `GET /v1/identity/me`
- **Auth:** Mọi người dùng có Bearer Access Token hợp lệ (`customer`, `operator`, `auditor`, `admin`).
- **Hành vi:** [`JwtAuthGuard`](../../../backend/src/modules/identity/jwt-auth.guard.ts) xác thực chữ ký RS256 qua JWKS, tự động upsert dòng `users` ở lần gọi đầu tiên ([DBS-52](../../features/DBS-52-users-upsert-first-token.md)), đối chiếu mốc thu hồi Redis/SQL ([DBS-114](../../features/DBS-114-session-revocation.md)), rồi trả về thông tin định danh đã gắn trên `req.user`.
- **Response `200 OK` ([`AuthenticatedUser`](../../../backend/src/modules/identity/jwt-claims.ts)):**
  ```json
  {
    "sub": "6b94c714-3182-4a66-92a2-0123456789ab",
    "userId": "0f6a3d52-8c1b-4e7a-b6d4-2c9e1a7f5b30",
    "groups": ["customer"],
    "tokenUse": "access",
    "claims": {
      "sub": "6b94c714-3182-4a66-92a2-0123456789ab",
      "iss": "https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_example",
      "client_id": "example-client-id",
      "token_use": "access",
      "cognito:groups": ["customer"],
      "iat": 1793577600,
      "exp": 1793578500
    }
  }
  ```
- **Mã lỗi:** `401 UNAUTHENTICATED`, `401 TOKEN_EXPIRED`, `401 SESSION_REVOKED`.

---

### 4.3. Nhóm Hồ sơ Khách hàng & Tài khoản ([`CustomersController`](../../../backend/src/modules/accounts/customers.controller.ts), [`AccountsController`](../../../backend/src/modules/accounts/accounts.controller.ts))

#### `POST /v1/customers/me` (UC-1: Onboarding khách hàng)
- **Auth:** `@Roles('customer')`.
- **Request Body ([`CreateCustomerProfileDto`](../../../backend/src/modules/accounts/customer-profile.dto.ts)):**
  ```json
  {
    "fullName": "Nguyễn Minh Anh"
  }
  ```
  - `fullName`: chuỗi được tự động chuẩn hóa Unicode `NFC` và `trim()`, độ dài `1..200` ký tự, cấm ký tự điều khiển ASCII (`\u0000-\u001f`, `\u007f`).
- **Hành vi:** Idempotent theo `userId`. Nếu khách chưa có hồ sơ thì tạo mới (`INSERT INTO customers`) và ghi audit `customer.onboard`; nếu đã có hồ sơ thì giữ nguyên `fullName` lần đầu, trả về hồ sơ hiện có và ghi audit `customer.profile.read` trong cùng transaction.
- **Response `200 OK` ([`CustomerProfileDto`](../../../backend/src/modules/accounts/customer-profile.dto.ts)):**
  ```json
  {
    "id": "c747b4f1-7a29-45e3-8538-b7639ce6cd23",
    "fullName": "Nguyễn Minh Anh",
    "createdAt": "2026-11-02T00:00:00.000Z"
  }
  ```
- **Mã lỗi:** `400` (tên rỗng/quá dài/có ký tự điều khiển/thừa trường lạ), `401`, `403 FORBIDDEN`, `500`, `503 SERVICE_TEMPORARILY_UNAVAILABLE`.

#### `GET /v1/customers/me` (UC-1: Xem hồ sơ khách hàng)
- **Auth:** `@Roles('customer')`.
- **Response `200 OK`:** Cùng cấu trúc `CustomerProfileDto` như trên (ghi audit `customer.profile.read` cùng transaction).
- **Mã lỗi:** `404 Not Found` (nếu khách chưa gọi `POST /v1/customers/me`), `401`, `403`, `500`, `503`.

#### `POST /v1/accounts` (UC-2: Mở tài khoản ngân hàng)
- **Auth:** `@Roles('customer')`.
- **Request Body ([`CreateAccountDto`](../../../backend/src/modules/accounts/open-account.dto.ts)):**
  ```json
  {
    "type": "CHECKING"
  }
  ```
  - `type`: `"CHECKING"` hoặc `"SAVINGS"`.
- **Hành vi:** Khoá dòng `customers` (`SELECT ... FOR UPDATE`), đếm tổng số tài khoản của khách (cả `ACTIVE` và `LOCKED`). Nếu $< 3$, tạo tài khoản mới với `status = 'ACTIVE'`, `balance = '0'` và ghi audit `account.open` (`SUCCESS`) trong cùng transaction. Nếu đã đủ 3 tài khoản, ghi audit `account.open` (`REJECTED`) rồi trả `409 ACCOUNT_LIMIT_REACHED`.
- **Response `201 Created` ([`OpenedAccountDto`](../../../backend/src/modules/accounts/open-account.dto.ts)):**
  ```json
  {
    "id": "8f78e873-7dab-481a-9bbf-577d35e49dd7",
    "type": "CHECKING",
    "status": "ACTIVE",
    "balance": "0",
    "createdAt": "2026-11-04T00:00:00.000Z",
    "updatedAt": "2026-11-04T00:00:00.000Z"
  }
  ```
- **Mã lỗi:** `400` (sai `type`), `404` (chưa tạo hồ sơ khách hàng), `409 ACCOUNT_LIMIT_REACHED`, `503 SERVICE_TEMPORARILY_UNAVAILABLE` (+ `Retry-After`).

#### `GET /v1/accounts` (UC-4: Danh sách tài khoản của tôi)
- **Auth:** `@Roles('customer')`.
- **Hành vi:** Đọc trực tiếp từ PostgreSQL (không qua cache Redis), trả mảng các tài khoản thuộc sở hữu của người gọi (cả `ACTIVE` và `LOCKED`), ghi audit `account.list` trong cùng transaction. Nếu khách chưa mở tài khoản nào thì trả mảng rỗng `[]`.
- **Response `200 OK` ([`AccountViewDto[]`](../../../backend/src/modules/accounts/account-view.dto.ts)):**
  ```json
  [
    {
      "id": "2e859a80-d4d0-471d-8cee-e9d0de9d4bc7",
      "type": "CHECKING",
      "status": "ACTIVE",
      "balance": "1500000",
      "createdAt": "2026-11-04T00:00:00.000Z",
      "updatedAt": "2026-11-04T01:15:00.000Z"
    }
  ]
  ```

#### `GET /v1/accounts/:id` (UC-4: Chi tiết một tài khoản của tôi)
- **Auth:** `@Roles('customer')`.
- **Path Param:** `id` (UUID tài khoản).
- **Hành vi:** Kiểm tra quyền sở hữu bằng `JOIN customers ON customers.id = accounts.customer_id WHERE customers.user_id = $1`. Nếu `id` không phải UUID, không tồn tại, thuộc khách hàng khác hoặc là tài khoản `SYSTEM`, hệ thống ghi audit `account.read` (`DENIED`) và trả **cùng một `404 Not Found`**.
- **Response `200 OK`:** `AccountViewDto` như trên.

---

### 4.4. Nhóm Chuyển tiền, Lịch sử & Trạng thái Giao dịch ([`TransfersController`](../../../backend/src/modules/ledger/transfers.controller.ts), [`AccountTransactionsController`](../../../backend/src/modules/ledger/account-transactions.controller.ts))

#### `POST /v1/transfers` (UC-5: Chuyển tiền nội bộ giữa 2 tài khoản khách hàng)
- **Auth:** `@Roles('customer')`.
- **Rate Limit:** Giới hạn kép: `100 req/phút/IP` và `10 req/phút/customer` (`@LimitTransfers()`). Vượt ngưỡng trả `429 RATE_LIMITED` + header `Retry-After` trước khi chạm vào PostgreSQL.
- **Required Header:** `Idempotency-Key: <string 1..128 chars>`.
- **Request Body ([`TransferDto`](../../../backend/src/modules/ledger/transfer.dto.ts)):**
  ```json
  {
    "fromAccountId": "2e859a80-d4d0-471d-8cee-e9d0de9d4bc7",
    "toAccountId": "9a14c320-11b8-4c55-a120-55d89e123456",
    "amount": "300000"
  }
  ```
- **Hành vi nguyên tử trong 1 Transaction PostgreSQL ([`TransferService`](../../../backend/src/modules/ledger/transfer.service.ts)):**
  1. Kiểm tra `(user_id, idem_key)` trong `idempotency_keys`: nếu đã có và cùng `request_hash` thì phát lại (replay) nguyên văn status code + body lần đầu; nếu khác `request_hash` thì trả `422 IDEMPOTENCY_KEY_REUSED`.
  2. Kiểm tra `fromAccountId !== toAccountId` (nếu trùng trả `400`) và kiểm tra quyền sở hữu `fromAccountId` (nếu của người khác / không tồn tại / `SYSTEM` thì ghi audit `DENIED` và trả `404`).
  3. Khoá `SELECT ... FOR UPDATE` trên 2 tài khoản theo **thứ tự UUID tăng dần** để chống deadlock.
  4. Kiểm tra tuần tự 4 chốt chặn tại [`SyncGuardService.checkGuards`](../../../backend/src/modules/ledger/sync-guard.service.ts) (dừng ở lý do vi phạm đầu tiên):
     - Cả 2 tài khoản đều tồn tại, thuộc loại khách hàng và có `status = 'ACTIVE'` $\rightarrow$ vi phạm trả `422 ACCOUNT_NOT_ACTIVE`.
     - `amount <= TRANSFER_LIMIT_PER_TX` $\rightarrow$ vi phạm trả `422 LIMIT_PER_TX_EXCEEDED`.
     - Tổng tiền đã `DEBIT` trong ngày giờ Việt Nam + `amount <= TRANSFER_LIMIT_PER_DAY` $\rightarrow$ vi phạm trả `422 LIMIT_PER_DAY_EXCEEDED`.
     - `fromAccount.balance >= amount` $\rightarrow$ vi phạm trả `422 INSUFFICIENT_FUNDS`.
  5. **Nếu bị từ chối ở bước 4:** Vẫn `COMMIT` dòng `transfers (status = 'REJECTED', reject_reason = ...)`, lưu `idempotency_keys`, ghi `audit_log (outcome = 'REJECTED')`, **không** ghi `ledger_entries` và **không** phát sự kiện outbox, rồi trả `422` kèm `transferId`.
  6. **Nếu hợp lệ:** Ghi dòng `transfers (status = 'COMPLETED')`, ghi 2 dòng `ledger_entries` (`1 DEBIT` trên tài khoản nguồn, `1 CREDIT` trên tài khoản đích), cập nhật `accounts.balance`, ghi `outbox_events (event_type = 'TransferCompleted', status = 'PENDING')`, lưu `idempotency_keys`, ghi `audit_log (outcome = 'SUCCESS')` rồi `COMMIT`.
- **Response `201 Created` ([`TransferResultDto`](../../../backend/src/modules/ledger/transfer.dto.ts)):**
  ```json
  {
    "transferId": "7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a",
    "status": "COMPLETED"
  }
  ```
- **Response `422 Unprocessable Entity` (Khi bị từ chối nghiệp vụ):**
  ```json
  {
    "type": "about:blank",
    "title": "Unprocessable Entity",
    "status": 422,
    "detail": "Transfer rejected: INSUFFICIENT_FUNDS",
    "errorCode": "INSUFFICIENT_FUNDS",
    "transferId": "7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a",
    "correlationId": "d461b1d0-dba2-4e40-8304-d91f7b7132c9"
  }
  ```

#### `GET /v1/transfers/:id` (UC-7: Tra cứu trạng thái lệnh chuyển tiền)
- **Auth:** `@Roles('customer')`.
- **Response Header:** `Cache-Control: no-store`.
- **Hành vi bảo mật ([`TransferQueryService`](../../../backend/src/modules/ledger/transfer-query.service.ts)):**
  - Người gửi (`fromAccount` thuộc caller) xem được cả lệnh `COMPLETED` lẫn `REJECTED`.
  - Người nhận (`toAccount` thuộc caller) **chỉ** xem được lệnh `COMPLETED` (nếu lệnh `REJECTED` thì người nhận nhận `404` + audit `DENIED`).
  - Với lệnh `REJECTED`, response trả `rejectReason` nhưng **không bao giờ trả `toAccountId`** để người gửi không thể dò xem tài khoản đích là không tồn tại, đang `LOCKED` hay là `SYSTEM_CASH`.
  - Với lệnh `DEPOSIT`, response không trả `fromAccountId` (ẩn tài khoản `SYSTEM_CASH`).
- **Response `200 OK` ([`TransferStatusDto`](../../../backend/src/modules/ledger/transfer-status.dto.ts)):**
  ```json
  {
    "transferId": "7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a",
    "type": "TRANSFER",
    "status": "COMPLETED",
    "amount": "300000",
    "fromAccountId": "2e859a80-d4d0-471d-8cee-e9d0de9d4bc7",
    "toAccountId": "9a14c320-11b8-4c55-a120-55d89e123456",
    "createdAt": "2026-11-04T08:10:00.123456Z"
  }
  ```

#### `GET /v1/accounts/:id/transactions` (UC-6: Lịch sử biến động số dư của tài khoản)
- **Auth:** `@Roles('customer')`.
- **Response Header:** `Cache-Control: no-store`.
- **Query Params ([`HistoryQueryPipe`](../../../backend/src/modules/ledger/transaction-history.query.ts)):**
  - `limit` (tùy chọn): số nguyên `1..100`, mặc định `20`.
  - `from` (tùy chọn): mốc thời gian UTC `Z` bắt đầu (bao gồm, `>= from`).
  - `to` (tùy chọn): mốc thời gian UTC `Z` kết thúc (không bao gồm, `< to`, phải lớn hơn `from`).
  - `cursor` (tùy chọn): chuỗi con trỏ `base64url` nhận từ `nextCursor` của trang trước.
- **Response `200 OK` ([`TransactionPageDto`](../../../backend/src/modules/ledger/transaction-history.dto.ts)):**
  ```json
  {
    "items": [
      {
        "entryId": "9007199254740994",
        "transferId": "7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a",
        "type": "TRANSFER",
        "direction": "DEBIT",
        "amount": "300000",
        "balanceAfter": "1200000",
        "counterpartyAccountId": "9a14c320-11b8-4c55-a120-55d89e123456",
        "createdAt": "2026-11-04T08:10:00.123456Z"
      }
    ],
    "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTExLTA0VDA4OjEwOjAwLjEyMzQ1NloiLCJpZCI6IjkwMDcxOTkyNTQ3NDA5OTQifQ"
  }
  ```

---

### 4.5. Nhóm Nghiệp vụ Operator Đã Triển khai ([`OperatorDepositsController`](../../../backend/src/modules/ledger/operator-deposits.controller.ts), [`OperatorAccountsController`](../../../backend/src/modules/accounts/operator-accounts.controller.ts))

#### `POST /v1/operator/deposits` (UC-3: Nạp tiền tại quầy từ tài khoản hệ thống `SYSTEM_CASH`)
- **Auth:** `@Roles('operator')`.
- **Required Header:** `Idempotency-Key: <string 1..128 chars>`.
- **Request Body ([`DepositDto`](../../../backend/src/modules/ledger/deposit.dto.ts)):**
  ```json
  {
    "toAccountId": "2e859a80-d4d0-471d-8cee-e9d0de9d4bc7",
    "amount": "1000000"
  }
  ```
- **Hành vi:** Khoá tài khoản `SYSTEM_CASH` và `toAccountId` theo thứ tự UUID tăng dần; nếu `toAccountId` không tồn tại, đang `LOCKED` hoặc là tài khoản `SYSTEM`, lưu dòng `transfers (type = 'DEPOSIT', status = 'REJECTED', reject_reason = 'ACCOUNT_NOT_ACTIVE')` và trả `422 ACCOUNT_NOT_ACTIVE` kèm `transferId`. Nếu hợp lệ, ghi bút toán kép (`DEBIT` tài khoản `SYSTEM_CASH`, `CREDIT` tài khoản khách), ghi `outbox_events (TransferCompleted)`, lưu `idempotency_keys` và `audit_log` trong cùng transaction.
- **Response `201 Created` ([`DepositResultDto`](../../../backend/src/modules/ledger/deposit.dto.ts)):**
  ```json
  {
    "transferId": "3f4e5d6c-7b8a-4910-9a1b-2c3d4e5f6a7b",
    "status": "COMPLETED"
  }
  ```

#### `GET /v1/operator/accounts` (UC-3, UC-11: Tìm kiếm tài khoản khách hàng cho Operator)
- **Auth:** `@Roles('operator')`.
- **Response Header:** `Cache-Control: no-store`.
- **Query Param:** `q` (bắt buộc, `1..100` ký tự sau khi chuẩn hóa `NFC` + `trim()`, cấm ký tự điều khiển).
  - Nếu `q` là một UUID đầy đủ: tìm chính xác theo `accounts.id`.
  - Ngược lại: tìm khớp một phần không phân biệt hoa/thường (`ILIKE`) trên `customers.full_name` (ký tự `%` và `_` được escape thành ký tự thường).
- **Bảo mật dữ liệu (FR-ACC-04, BR-10):** Trả tối đa 20 tài khoản, **không bao giờ trả cột `balance`** và không bao giờ trả tài khoản `SYSTEM`. Mọi lần tìm kiếm hợp lệ (kể cả kết quả rỗng) đều ghi `audit_log (action = 'operator.account.search')` lưu số lượng kết quả và `accountId` hoặc 32 ký tự đầu của băm `SHA-256(q)` (không lưu tên khách dạng rõ vào `audit_log`).
- **Response `200 OK` ([`OperatorAccountSearchDto`](../../../backend/src/modules/accounts/operator-account-search.dto.ts)):**
  ```json
  {
    "items": [
      {
        "id": "2e859a80-d4d0-471d-8cee-e9d0de9d4bc7",
        "type": "CHECKING",
        "status": "ACTIVE",
        "ownerName": "Nguyễn Minh Anh"
      }
    ]
  }
  ```

---

### 4.6. Nhóm Kiểm toán Độc lập ([`AuditController`](../../../backend/src/modules/audit/audit.controller.ts))

#### `GET /v1/audit/entries` (UC-8: Tra cứu nhật ký kiểm toán bất biến)
- **Auth:** `@Roles('auditor')`.
- **Response Header:** `Cache-Control: no-store`.
- **Query Params ([`AuditSearchQueryPipe`](../../../backend/src/modules/audit/audit-search.query.ts)):**
  - `actorUserId` (tùy chọn): UUID của người thực hiện hành động (`users.id`).
  - `action` (tùy chọn): chuỗi phân biệt hoa/thường (`1..128` ký tự, ví dụ `transfer.create`, `account.open`).
  - `from` (tùy chọn): mốc thời gian UTC `Z` bắt đầu (bao gồm).
  - `to` (tùy chọn): mốc thời gian UTC `Z` kết thúc (không bao gồm, `to > from`).
  - `correlationId` (tùy chọn): UUID vết request cần tra.
  - `limit` (tùy chọn): số nguyên `1..100`, mặc định `50`.
  - `cursor` (tùy chọn): con trỏ keyset `base64url` gắn với bộ lọc hiện tại.
- **Hành vi Self-Audit nguyên tử:** Mọi lượt tra cứu hợp lệ (kể cả trang rỗng) đều thực hiện `INSERT` một dòng `audit.search` (mang `correlationId` của chính request tra cứu) và `SELECT` trang kết quả trong **cùng một transaction**; nếu ghi `audit.search` thất bại thì không dòng dữ liệu nào được trả ra.
- **Response `200 OK` ([`AuditEntriesPageDto`](../../../backend/src/modules/audit/audit-search.dto.ts)):**
  ```json
  {
    "entries": [
      {
        "id": "9007199254740994",
        "occurredAt": "2026-11-04T08:10:00.123456Z",
        "actorUserId": "0f6a3d52-8c1b-4e7a-b6d4-2c9e1a7f5b30",
        "actorRole": "customer",
        "action": "transfer.create",
        "outcome": "SUCCESS",
        "target": {
          "type": "transfer",
          "id": "7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a"
        },
        "correlationId": "d461b1d0-dba2-4e40-8304-d91f7b7132c9",
        "metadata": {
          "amount": "300000"
        }
      }
    ],
    "nextCursor": null
  }
  ```

---

## 5. Đặc tả 6 Endpoints Đã Chốt Thiết kế (`Planned` — UC-10, UC-11, UC-12)

Các endpoint dưới đây đã được chốt hợp đồng trong [`docs/03_HIGH_LEVEL_ARCHITECTURE.md` §6.2, §6.5, §7](../../03_HIGH_LEVEL_ARCHITECTURE.md), [`docs/components/risk/02-architecture.md` §3.3](../risk/02-architecture.md#33-endpoint-http-chạy-ở-role-api) và [`FRAUD-API-01`](../../features/FRAUD-API-01-external-ai-decision.md):

### 5.1. Khoá & Mở khoá Tài khoản (UC-11 — `operator`)

| Endpoint | Hành vi Transaction & Bảo mật | Response |
|---|---|---|
| `POST /v1/operator/accounts/:id/lock` | `@Roles('operator')`. Khoá dòng `accounts` (`FOR UPDATE`), đổi `status = 'LOCKED'`, gọi `IdentityService.revokeSessions(manager, ownerUserId)` để cập nhật `users.sessions_revoked_at = clock_timestamp()`, ghi `outbox_events (AccountStatusChanged)` và `audit_log (action = 'account.lock')` trong **cùng một transaction**. Sau COMMIT mới SET cache marker; Redis lỗi không rollback thao tác, guard vẫn xác nhận SQL. Mọi access token phát hành trước mốc này sẽ nhận `401 SESSION_REVOKED` ngay lập tức. Tài khoản `SYSTEM` hoặc không tồn tại trả `404`. | `200 OK` `{ "id": "<uuid>", "status": "LOCKED", "updatedAt": "<iso>" }` |
| `POST /v1/operator/accounts/:id/unlock` | `@Roles('operator')`. Khoá dòng `accounts`, đổi `status = 'ACTIVE'`, ghi `outbox_events (AccountStatusChanged)` và `audit_log (action = 'account.unlock')` cùng transaction. | `200 OK` `{ "id": "<uuid>", "status": "ACTIVE", "updatedAt": "<iso>" }` |

### 5.2. Tra cứu & Duyệt Cờ Gian lận (UC-10 — `operator`)

| Endpoint | Query / Request Body | Response & Hành vi |
|---|---|---|
| `GET /v1/operator/fraud-flags` | Query: `status` (`OPEN` mặc định \| `CONFIRMED_FRAUD` \| `FALSE_POSITIVE`), `level` (`MEDIUM` \| `HIGH`), `limit` (`1..100`), `cursor`. | `200 OK` `{ items: FraudFlagSummaryDto[], nextCursor }`. Sắp xếp `HIGH` trước, `created_at DESC` trước. |
| `GET /v1/operator/fraud-flags/:transferId` | Path: `transferId` (`uuid`). | `200 OK`: Trả `score` (tổng chuẩn), `riskLevel`, `reviewStatus`, mảng `hits[]` (chỉ chứa các luật `R1..R6` kích hoạt kèm `weight` và `explanation` tiếng Việt; có thể rỗng nếu cờ chỉ do tín hiệu AI), khối `aiAssessment` riêng (`null` ở chế độ `rule_only`) và 10 giao dịch gần nhất của tài khoản nguồn. Ghi `audit_log (action = 'fraud_flag.view')` cùng transaction. |
| `POST /v1/operator/fraud-flags/:transferId/review` | Body: `{ "decision": "CONFIRMED_FRAUD" \| "FALSE_POSITIVE", "note"?: string }`. | Thực thi `UPDATE fraud_flags SET review_status = $1, reviewed_by = $2, reviewed_at = clock_timestamp(), review_note = $3 WHERE transfer_id = $4 AND review_status = 'OPEN'` + `AuditService.record` trong cùng transaction. Nếu cờ đã được duyệt trước đó (`rowCount === 0`), rollback và trả **`409 Conflict` (`errorCode: "FLAG_ALREADY_REVIEWED"`)**. |

### 5.3. Quản lý Phiên bản Cấu hình Luật Rủi ro (UC-12 — `admin`)

| Endpoint | Request Body | Response & Hành vi |
|---|---|---|
| `GET /v1/admin/risk-config` | — | `@Roles('admin')`. Trả phiên bản cấu hình `risk_rule_sets` mới nhất đang có hiệu lực (`version`, `config`, `createdAt`, `createdBy`). |
| `POST /v1/admin/risk-config/versions` | Body: `{ "config": RuleSetConfig }` (ngưỡng `medium`/`high`, trọng số & tham số `R1..R6`, cấu hình `ai.*`). | `@Roles('admin')`. Validate chặt cấu trúc `config` (chặn cấu hình `ai.*` sai ngay lúc tạo), chèn phiên bản mới `version = max(version) + 1` vào bảng chỉ-thêm `risk_rule_sets`, ghi `audit_log` và làm mới khóa Redis `cfg:risk:latest` / `cfg:risk:v{n}`. |
