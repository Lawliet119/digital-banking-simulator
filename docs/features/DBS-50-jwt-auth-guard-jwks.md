# DBS-50 · Identity: JwtAuthGuard xác minh JWT bằng JWKS có cache

> **Status:** Implemented · **Vai:** Dev (AI — vòng 1 qua Plan mode, vòng 2 xử lý domain-review theo đúng skill `dbs-delivering-task`) · **Nhánh:** `feat/DBS-50-jwt-auth-guard-jwks` · **PR:** — · **Cập nhật:** 2026-10-26

## 1. Bối cảnh

- **Task trên board:** Story, Tuần 2, ưu tiên Highest, Deliverable/Demo **P2**, Status "To Do".
- **Expect:** "Mọi endpoint biết token có hợp lệ hay không."
- **DoD** (chép nguyên văn):
  1. Guard kiểm chữ ký bằng JWKS (cache khóa công khai; gặp kid lạ thì tải lại tối đa 1 lần/phút), kiểm iss, client_id, token_use = access, exp; không tin claim nào trước khi verify
  2. Không token / sai chữ ký / hết hạn / sai iss → 401 problem+json với errorCode đúng; không log token
  3. Swagger khai báo bearerAuth
  4. Test với token ký bằng khóa thử nghiệm (đường local/test ở DBS-53), kể cả JWKS xoay khóa
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:** không có (board ghi "làm được ngay"). DBS-53 (local/test JWKS qua file, `AUTH_MODE=local`, CLI `auth:dev-token`) **chưa merge** — xác nhận qua `docs/security/threat-model.md:73`, `docs/adr/0006-cognito-ecs-fargate.md:67,74` và `references/testing.md`/`manual-testing.md` (đều ghi "once merged"). Task này không phụ thuộc DBS-53: tự sinh keypair trong RAM cho test, đúng như ADR-06 gợi ý ("Test e2e sinh cặp khóa trong bộ nhớ").
- **Đã có gì trước khi làm:** `backend/src/modules/identity/` chỉ có `README.md` (chưa có code nào). Không có `CanActivate` nào trong repo trước đây. Không có thư viện JWT/JWKS nào được cài (`jsonwebtoken`, `jose`, `jwks-rsa`, `aws-jwt-verify` đều không có trong `package.json`). `auth.config.ts` đã có `cognito.{userPoolId,clientId,issuer}` và `accessTokenTtlSeconds`, chưa có `jwksUri`. `error-code.enum.ts` đã có `SESSION_REVOKED` nhưng chưa có code 401 nào cho lỗi xác thực token. `app.setup.ts` đã đăng ký `bearerAuth` tên scheme `'access-token'`. `ADR-06` (Accepted, 2026-10-11) là nguồn quyết định chính: kiểm `iss`, `client_id`, `token_use = access`, `exp`; vai trò từ `cognito:groups`, không nhóm = `customer`; access token không có `aud`.
- **Ngoài phạm vi:** role guard (`@Roles()`), decorator `@CurrentUser()`, kiểm tra revocation (`sessions_revoked_at`), upsert bảng `users` — đều thuộc các task khác (ADR-06 liệt kê DBS-50/51/159). Guard chỉ gắn claims đã verify (gồm `cognito:groups`) vào `request.user` để các guard sau dùng. `AUTH_MODE=local`/file-based JWKS (DBS-53) không làm ở đây.
- **Quyết định (qua Plan mode, 2026-10-24):** người dùng duyệt kế hoạch thiết kế đầy đủ (thư viện `jose`, cấu hình, error code, cấu trúc file, logic guard, test plan) trước khi code — xem `C:\Users\ROG\.claude\plans\plan-dbs-50-i-silly-oasis.md`. Không có domain-review subagent riêng (§6 bỏ trống có chủ đích); việc thiết kế + review nằm trong chính phiên Plan mode đó.

## 2. Hành vi

### 2.1 `GET /v1/identity/me` (endpoint demo, dùng để test guard)

| Điều kiện | Kết quả | `errorCode` |
|---|---|---|
| Không có header `Authorization` | 401 `problem+json` | `UNAUTHENTICATED` |
| `Authorization` không phải scheme `Bearer`, hoặc `Bearer` không kèm token | 401 (verifier **không** được gọi) | `UNAUTHENTICATED` |
| Token sai định dạng / sai chữ ký / `kid` lạ không tìm được sau khi refetch | 401 | `UNAUTHENTICATED` |
| Token đúng `iss` cấu hình nhưng khác | 401 | `UNAUTHENTICATED` |
| `client_id` trong token khác cấu hình | 401 | `UNAUTHENTICATED` |
| `token_use` khác `'access'` (ví dụ ID token) | 401 | `UNAUTHENTICATED` |
| `exp` đã qua | 401 | `TOKEN_EXPIRED` |
| Token hợp lệ | 200, body `{ sub, groups, tokenUse, claims }` | — |

- `groups` lấy từ `cognito:groups`; không có nhóm → mảng rỗng `[]` (không phải `undefined`), để role guard sau này áp "không nhóm = customer" không cần null-check.
- JWKS: cache khóa theo `kid`; gặp `kid` lạ thì refetch, tối đa 1 lần mỗi `JWKS_REFETCH_COOLDOWN_MS` (mặc định 60 000ms = 1 phút, cấu hình được qua env, test dùng giá trị ngắn hơn).
- JWKS endpoint không tới được (network, timeout, JSON hỏng) → cùng lỗi với "sai chữ ký": `TokenVerificationError` → 401 `UNAUTHENTICATED`, không crash, không treo request (TC-50-26, vòng 2 §6 #4).
- Không bao giờ log raw token — chỉ log loại lỗi (`err.name`), kèm `correlationId` có sẵn từ `ProblemDetailsFilter`.

### 2.2 Mọi route khác (hành vi hệ thống, không riêng module `identity`)

`JwtAuthGuard` là **guard toàn cục mặc định** (vòng 2, domain-review §6 #1): mọi route của mọi controller tương lai yêu cầu access token hợp lệ, trừ khi được đánh dấu `@Public()`. Một route không có `@UseGuards` và không có `@Public()` **vẫn bị chặn** — không còn kiểu lỗi "quên gắn guard = endpoint public hoàn toàn".

| Route | Có cần token? | Vì sao |
|---|---|---|
| `GET /v1/identity/me` | Có (mặc định) | Không đánh dấu `@Public()` |
| `GET /health/live`, `GET /health/ready` | Không | `HealthController` đánh dấu `@Public()` (ALB gọi không có token) |
| Route tương lai không `@UseGuards`, không `@Public()` | Có (mặc định) | An toàn theo mặc định — khác với trước vòng 2 |

## 3. Kiến trúc

- **Vị trí:** `backend/src/modules/identity/` (role `api`, khớp README cũ của module). Đăng ký ở `apiModules` trong `backend/src/modules/index.ts` (không phải `sharedModules` — module chỉ có controller, không consumer/scheduler).
- **File chính:**
  - `jwt-claims.ts` — `CognitoAccessTokenClaims`, `AuthenticatedUser`.
  - `identity.errors.ts` — `TokenExpiredError`, `TokenVerificationError`.
  - `jwks-verifier.service.ts` — bọc `jose`'s `createRemoteJWKSet` + `jwtVerify`; tự kiểm `client_id`/`token_use` sau khi `jwtVerify` xác nhận chữ ký/`iss`/`exp`.
  - `jwt-auth.guard.ts` — `CanActivate`; đọc `@Public()` qua `Reflector` trước tiên (vòng 2); nếu không public, trích token từ header, gọi verifier, map lỗi → `ErrorCode`, gắn `request.user`.
  - `identity.controller.ts` — `GET /identity/me`, `@ApiBearerAuth('access-token')`.
  - `identity.module.ts`, `index.ts` (barrel).
  - `backend/src/common/auth/public.decorator.ts` (vòng 2, ở `common` không ở `identity`) — `@Public()` + hằng `IS_PUBLIC_KEY`, đặt ở `common` vì `app.module.ts` (gốc) và module khác (`health`) đều cần đọc/gắn nó, không riêng `identity`.
- **Guard toàn cục (vòng 2):** `backend/src/app.module.ts` đăng ký `{ provide: APP_GUARD, useClass: JwtAuthGuard }` trong `providers`, **có điều kiện theo `runsHttp()`** — chỉ khi process này serve HTTP (`api`/`both`). Role `worker` không import `IdentityModule` (xem `modules/index.ts`), nên đăng ký `APP_GUARD` không điều kiện sẽ thiếu `JwksVerifierService` trong container và crash worker lúc boot; đây là lỗi mà domain-review vòng 1 #1 đã bắt ở một biến thể khác (constructor eager), nay lặp lại ở tầng `AppModule` nếu không cẩn thận — đã tránh bằng điều kiện trên.
- **Interface cung cấp (qua `index.ts`):** `IdentityModule`, `JwtAuthGuard`, `RequestWithUser`, `JwksVerifierService`, `AuthenticatedUser`, `CognitoAccessTokenClaims`, `TokenExpiredError`, `TokenVerificationError`. Dùng bởi `app.module.ts` (vòng 2, `@modules/identity` cho `JwtAuthGuard`).
- **Cấu hình (sửa):**
  - `backend/src/config/validation.schema.ts`: thêm `JWKS_REFETCH_COOLDOWN_MS` (Joi, int 1 000–300 000, mặc định 60 000).
  - `backend/src/config/auth.config.ts`: thêm `cognito.jwksUri` (suy ra từ `COGNITO_ISSUER` + `/.well-known/jwks.json`, quy ước cố định của Cognito — không thêm biến env riêng) và `cognito.jwksCooldownMs`.
- **`ErrorCode` (sửa `backend/src/common/errors/error-code.enum.ts`):** thêm `UNAUTHENTICATED` và `TOKEN_EXPIRED` (2 code, không phải 1 hay nhiều — theo đúng rule của enum: "thêm member chỉ khi client phải branch khác nhau"; expired vs mọi lỗi auth khác là fork hành vi thực sự duy nhất, giống cách `SESSION_REVOKED` đã tách biệt).
- **Dữ liệu:** không chạm bảng nào (không upsert `users`, không đọc `sessions_revoked_at` — thuộc task khác).
- **Ranh giới transaction:** không có — guard không mở transaction, chỉ gọi JWKS qua HTTP (I/O ngoài transaction là đúng theo quy tắc chung).
- **Thay đổi cấp hệ thống:** không sửa `docs/03`, `_shared`, hay ADR nào (ADR-06 đã có sẵn, task này triển khai đúng theo ADR, không lệch).
- **Thư viện:** `jose@5.10.0` (không dùng v6 — v6 chỉ build ESM, không `require()` được trong môi trường CommonJS/ts-jest hiện tại của repo; v5 có build CJS song song, API giống v6). `createRemoteJWKSet`'s `cooldownDuration` tự đáp ứng đúng yêu cầu "cache khóa, kid lạ thì refetch tối đa 1 lần/phút" mà không cần `jwks-rsa` + `jsonwebtoken` riêng.

## 4. Test cases tự động

| ID | Truy vết (DoD) | Lớp | Given · When · Then | `errorCode` mong đợi |
|---|---|---|---|---|
| TC-50-01 | DoD #1 | unit (`jwks-verifier.service.spec.ts`) | Token ký đúng, đủ claim hợp lệ → verify trả về claims | — |
| TC-50-02 | DoD #1 | unit | `iss` sai → reject | (ném `TokenVerificationError`, guard map `UNAUTHENTICATED`) |
| TC-50-03 | DoD #1, #2 | unit | `exp` đã qua → reject | `TOKEN_EXPIRED` |
| TC-50-04 | DoD #1 | unit | `client_id` sai → reject | `UNAUTHENTICATED` |
| TC-50-05 | DoD #1 | unit | `token_use` khác `access` → reject | `UNAUTHENTICATED` |
| TC-50-06 | DoD #1 | unit | Ký bằng khóa chưa publish (`kid` lạ) → reject, đúng 1 lần refetch | `UNAUTHENTICATED` |
| TC-50-07 | DoD #1, #4 | unit | JWKS xoay khóa, đợi qua cooldown → refetch thành công; gọi lại trong cooldown với `kid` lạ khác → **không** refetch thêm | — / `UNAUTHENTICATED` |
| TC-50-08 | DoD #1, #4 | unit | Lặp lại TC-50-07 chi tiết hơn: refetch sau rotation → 1 lần; ngay sau đó 1 `kid` lạ khác trong cooldown → 0 lần refetch thêm; đợi qua cooldown → refetch lần 2 | `UNAUTHENTICATED` rồi thành công |
| TC-50-09 | DoD #2 | unit | Token hết hạn → log chỉ có `Logger.warn`, không chứa raw token string | — |
| TC-50-09b | — (phát hiện ở code-review) | unit | `COGNITO_ISSUER` không set → constructor **không throw**; `verifyAccessToken` reject sạch, không crash | — |
| TC-50-09c | — (phát hiện ở code-review) | unit | `COGNITO_CLIENT_ID` không set, claim `client_id` cũng không có → vẫn reject (không bị `undefined !== undefined` cho qua) | — |
| TC-50-10 | DoD #1 | unit (`jwt-auth.guard.spec.ts`) | Không header → 401, verifier không được gọi | `UNAUTHENTICATED` |
| TC-50-11 | DoD #1 | unit | Scheme không phải `Bearer`, hoặc `Bearer` rỗng → 401, verifier không được gọi | `UNAUTHENTICATED` |
| TC-50-12 | — | unit | Verifier resolve → `true`, `request.user` đúng shape; không `cognito:groups` → `groups = []` | — |
| TC-50-13 | DoD #2 | unit | Verifier reject `TokenExpiredError` → 401 | `TOKEN_EXPIRED` |
| TC-50-14 | DoD #2 | unit | Verifier reject lỗi khác (và lỗi bất ngờ, fail-closed) → 401 | `UNAUTHENTICATED` |
| TC-50-15 | DoD #2 | e2e (`test/identity.e2e-spec.ts`) | `GET /v1/identity/me` không header → 401 `application/problem+json` | `UNAUTHENTICATED` |
| TC-50-16 | DoD #2 | e2e | Token rác → 401 | `UNAUTHENTICATED` |
| TC-50-17 | DoD #1 | e2e | Token hợp lệ → 200, body đúng `sub/groups/tokenUse` | — |
| TC-50-18 | DoD #1 | e2e | `token_use: 'id'` → 401 | `UNAUTHENTICATED` |
| TC-50-19 | DoD #1 | e2e | `client_id` sai → 401 | `UNAUTHENTICATED` |
| TC-50-20 | DoD #1, #2 | e2e | Hết hạn → 401 | `TOKEN_EXPIRED` |
| TC-50-21 | DoD #1, #4 | e2e | Xoay khóa JWKS giữa hai request thật, không restart app → request thứ hai vẫn 200 | — |
| TC-50-22 | — (vòng 2, §6 #1) | e2e (`test/app-guard.e2e-spec.ts`, boot `AppModule` thật) | Route `/v1/identity/me` không `@Public()`, không gì đặc biệt ngoài là controller thường → vẫn 401 không header, **do guard toàn cục**, không do code riêng của route | `UNAUTHENTICATED` |
| TC-50-23 | — (vòng 2) | e2e | `GET /health/live` không header → 200 (`@Public()`) | — |
| TC-50-24 | — (vòng 2) | e2e | `GET /health/ready` không header → không 401 (200 hoặc 503 theo DB, `@Public()`) | — |
| TC-50-25 | — (vòng 2, `public.decorator.spec.ts`) | unit | `@Public()` gắn `IS_PUBLIC_KEY=true` đọc được qua `Reflector`, trên cả method và class | — |
| TC-50-26 | — (vòng 2, §6 #4) | unit (`jwks-verifier.service.spec.ts`) | JWKS endpoint đóng hẳn (connection refused, không phải 4xx/5xx) khi verify token có `kid` chưa cache → reject, không crash, không treo | `UNAUTHENTICATED` (qua guard) |
| — | DoD #5 | quy trình | Merge PR sau Dev review + CI xanh + bảng đối chiếu — chưa làm (xem §8, `BL-030`) | — |

Mọi gạch đầu dòng DoD #1–#4 có ít nhất một case (unit lẫn e2e). DoD #5 là quy trình, chưa qua (chưa mở PR).

## 5. Test thủ công

Điều kiện chạy: không cần Docker/Postgres/Redis (guard không chạm DB). Dùng Node + `jose` để tự ký token test, một JWKS server tạm trong RAM (không cần CLI `auth:dev-token` của DBS-53, vì task đó chưa merge).

| Bước | Việc làm | Kết quả mong đợi | Kết quả thật |
|---|---|---|---|
| M-50-01 | Boot một Nest app thật (HTTP thật, Swagger thật, chỉ `IdentityModule` + config giả trỏ tới JWKS server RAM ở `http://127.0.0.1:4567`), gọi `GET /v1/identity/me` **không** có header | 401, `content-type: application/problem+json`, `errorCode: UNAUTHENTICATED` | **Đạt** — `{"errorCode":"UNAUTHENTICATED","type":"about:blank","title":"Unauthorized","status":401,"detail":"Missing or malformed Authorization header","correlationId":"…"}` |
| M-50-02 | Gọi lại với `Authorization: Bearer not-a-jwt` | 401 `UNAUTHENTICATED` | **Đạt** — log server chỉ in `access token failed verification: JWSInvalid` (không có raw token trong log) |
| M-50-03 | Ký token hợp lệ (`client_id`, `token_use: access`, `cognito:groups: ['operator']`) bằng khóa thử, gọi lại | 200, body có `sub/groups/tokenUse` | **Đạt** — `{"sub":"user-123","groups":["operator"],"tokenUse":"access","claims":{…}}` |
| M-50-04 | Ký token đã hết hạn (`exp` quá khứ), gọi lại | 401, `errorCode: TOKEN_EXPIRED` | **Đạt** — `{"errorCode":"TOKEN_EXPIRED","type":"about:blank","title":"Unauthorized","status":401,"detail":"Access token expired","correlationId":"…"}` |
| M-50-05 | Gọi `GET /docs-json`, kiểm `components.securitySchemes` và `security` của path `/v1/identity/me` | `access-token` scheme `bearer`/`JWT`; endpoint có `security: [{"access-token":[]}]` | **Đạt** — `{"access-token":{"scheme":"bearer","bearerFormat":"JWT","type":"http"}}` / `[{"access-token":[]}]` |
| M-50-06 | (vòng 2) `npm run start:dev` (`APP_ROLE=both`, Docker + Postgres thật), gọi `GET /v1/identity/me` không header, rồi `GET /health/live` và `GET /health/ready` không header | `/v1/identity/me` vẫn 401 `UNAUTHENTICATED` **do guard toàn cục**, không do code riêng của route; hai route `health` vẫn qua được nhờ `@Public()` | **Đạt** — `/v1/identity/me`: `{"errorCode":"UNAUTHENTICATED",…}` 401; `/health/live`: `{"status":"ok"}` 200; `/health/ready`: `{"status":"ok","info":{"database":{"status":"up"}}}` 200 (chi tiết: `manual-test.txt`) |

Script test tay (`backend/src/scripts/manual-smoke.dbs50.ts`): boot bằng `ts-node -r tsconfig-paths/register`, dùng `jose` sinh keypair RSA trong RAM, serve JWKS qua `node:http`, gọi thật bằng `fetch`. **Giữ lại trong repo** (vòng 2, §6 #2 — không xóa sau khi chạy), để bước M-50-01…05 tái lập được từ đầu, đúng `references/manual-testing.md` ("kept in the PR or the feature doc"). Không cần Docker cho M-50-01…05 (guard/verifier không chạm DB/Redis); M-50-06 cần Docker + Postgres thật qua `docker compose up -d` vì boot `AppModule` đầy đủ (có `DatabaseModule`).

## 6. Domain review (AI)

### Vòng 1 (ghi lại bởi tác giả gốc, qua Plan mode — không phải subagent domain-review độc lập của skill)

**Reviewer:** subagent `code-review` (skill, effort `high`), model Sonnet 5, 2026-10-24 · **Kết quả:** 5 phát hiện, verdict tất cả CONFIRMED/PLAUSIBLE.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | `JwksVerifierService` throw ở constructor khi `COGNITO_ISSUER` chưa set (optional ở local dev) → `IdentityModule` nằm trong `apiModules` làm **crash toàn bộ app khi boot** nếu không cấu hình Cognito | **đã sửa** — chuyển check sang lazy, chỉ throw (sạch, không crash process) khi có request thật gọi `verifyAccessToken()`; thêm TC-50-09b |
| 2 | should-fix | Kiểm `client_id` dùng `payload.client_id !== this.cfg.cognito.clientId`; khi `COGNITO_CLIENT_ID` chưa set, cả hai phía là `undefined` → so sánh `false`, bỏ qua kiểm tra | **đã sửa** — thêm `!this.cfg.cognito.clientId ||` vào điều kiện; thêm TC-50-09c |
| 3 | should-fix | `JWKS_REFETCH_COOLDOWN_MS` có trong schema + config nhưng thiếu trong `env/.env.example`, vi phạm CONTRIBUTING §5b (3 bước bắt buộc cho biến môi trường mới) | **đã sửa** — thêm dòng vào `env/.env.example` |
| 4 | minor | `jwksUri` nối chuỗi từ `COGNITO_ISSUER` không strip trailing slash → double slash nếu issuer có `/` cuối, JWKS 404 toàn bộ mà không có cảnh báo lúc boot | **đã sửa** — `issuer.replace(/\/+$/, '')` trước khi nối |
| 5 | minor | `baseClaims()` trong `test/identity.e2e-spec.ts` lặp lại y nguyên logic trong `jwks-verifier.service.spec.ts` | **không sửa** — hai file dùng claim test *data* khác mục đích với fixture *JWKS machinery* (file đã trùng lặp có chủ đích vì ranh giới module/test, xem "Lệch so với kế hoạch"); để `baseClaims` trùng là chấp nhận được, hợp nhất sẽ phải phá ranh giới đó lần nữa |

### Vòng 2 (domain-review bắt buộc của skill, chạy khi bàn giao lại task để qua gate) — subagent `general-purpose`, 2026-10-26

Vòng 1 không phải domain-review độc lập theo đúng `SKILL.md` (tác giả tự ghi "không có domain-review subagent riêng"). Vòng này là domain-review thật, nguyên văn ở [`screenshots/DBS-50/domain-review.md`](screenshots/DBS-50/domain-review.md). **Verdict: REVISE.**

| # | Mức | Phát hiện | Xử lý (duyệt G2: tất cả đề xuất của agent) |
|---|---|---|---|
| 1 | blocking | `JwtAuthGuard` chỉ gắn thủ công bằng `@UseGuards` trên từng controller, không có `APP_GUARD` toàn cục/default-deny; mâu thuẫn với `docs/03` ("JWT xác minh ở mọi request") — mọi controller tương lai phải tự nhớ gắn guard | **sẽ sửa** — đăng ký `JwtAuthGuard` làm `APP_GUARD` toàn cục trong `app.module.ts`, thêm decorator `@Public()` (qua `Reflector`) cho route không cần auth (`health/live`, `health/ready`); xem §7 bước mới |
| 2 | should-fix | Script test tay (`manual-smoke.dbs50.ts`) đã bị xóa, không tái lập được M-50-01…05 từ đầu | **sẽ sửa** — giữ script trong repo tại `backend/scripts/manual-smoke.dbs50.ts` (commit thường, không có secret), dẫn lại trong §5 |
| 3 | should-fix | Thiếu `BL-NNN` cho DoD #5 chưa đạt; thiếu dòng DBS-50 ở `docs/features/README.md` | **sẽ sửa** — thêm `BL-018`, thêm dòng vào README (Phase 5) |
| 4 | should-fix | Không có test khi JWKS endpoint down/timeout/trả JSON hỏng (khác với "kid lạ") | **sẽ sửa** — thêm TC-50-22, test đóng JWKS fixture server trước khi verify |
| 5 | minor | So khớp scheme `Bearer` phân biệt hoa/thường, chặt hơn RFC 7235 | **không sửa** — chủ ý giữ chặt (mọi client nội bộ luôn gửi đúng `Bearer`); thêm 1 dòng comment giải thích lý do |

## 7. Kế hoạch triển khai (đã thực hiện)

| Bước | File | Test | Lệnh chứng minh |
|---|---|---|---|
| 1 | `backend/package.json` (+`jose@5.10.0`) | — | `npm install jose@5.10.0` |
| 2 | `config/validation.schema.ts`, `config/auth.config.ts` | gián tiếp qua test verifier | `npm run typecheck` |
| 3 | `common/errors/error-code.enum.ts` (+`UNAUTHENTICATED`, `TOKEN_EXPIRED`) | — | `npm run typecheck` |
| 4 | `modules/identity/{jwt-claims,identity.errors,jwks-verifier.service,jwt-auth.guard,identity.controller,identity.module,index}.ts` | TC-50-01…14 | `npm test -- src/modules/identity` |
| 5 | `modules/index.ts` (đăng ký `IdentityModule` vào `apiModules`) | TC-50-15…21 | `npm run test:e2e -- test/identity.e2e-spec.ts` |
| 6 | `test/identity.e2e-spec.ts` | TC-50-15…21 | `npm run test:e2e` |
| 7 | Test tay (script tạm, đã xóa) | M-50-01…05 | xem §5 |

Không có rủi ro cần lùi (không sửa migration, không đổi behavior của endpoint có sẵn — `/identity/me` là endpoint mới).

## 7b. Kế hoạch bổ sung — xử lý domain-review vòng 2 (G3)

Tiếp nối §7, trên commit `0114a34`. Mỗi bước viết test trước, chạy đỏ, rồi code.

| Bước | File | Test viết trước (đỏ 1 dòng) | Việc làm | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 8 | `src/common/auth/public.decorator.ts` (mới), `.spec.ts` | `@Public()` gắn metadata `IS_PUBLIC_KEY=true` đọc được qua `Reflector` | Tạo decorator `SetMetadata(IS_PUBLIC_KEY, true)`, không phụ thuộc module nào (đặt ở `common`, không ở `identity`, vì guard global đọc nó từ `app.module.ts`, ngoài phạm vi module `identity`) | `npm test -- src/common/auth` | `feat(common): add @Public() decorator for global JwtAuthGuard` |
| 9 | `src/modules/identity/jwt-auth.guard.ts`, `.spec.ts` | Thêm case: `Reflector` trả `isPublic=true` ở handler hoặc class → `canActivate` trả `true` ngay, không gọi verifier | Inject `Reflector` vào `JwtAuthGuard`; đầu `canActivate` kiểm `getAllAndOverride(IS_PUBLIC_KEY, [handler, class])` | `npm test -- src/modules/identity` | `feat(identity): JwtAuthGuard honours @Public()` |
| 10 | `src/app.module.ts`; `src/modules/health/health.controller.ts` (+`@Public()` ở cả 2 route) | e2e mới (bước 11) | Đăng ký `{ provide: APP_GUARD, useClass: JwtAuthGuard }` trong `providers` của `AppModule`; `IdentityModule` phải xuất `JwtAuthGuard`+`JwksVerifierService` ra DI container gốc — kiểm tra `AppModule` import `IdentityModule` (đã có, qua `apiModules`) nên `useClass` tự resolve được qua Nest DI, không cần import thủ công thêm | `npm run typecheck` | `feat(identity): make JwtAuthGuard the default global guard` |
| 11 | `test/app-guard.e2e-spec.ts` (mới, boot `AppModule` thật — lần đầu một e2e spec làm vậy, cần `DatabaseModule` giả hoặc `DATABASE_URL` giả giống `transaction-wiring.e2e-spec.ts`) | TC-50-22…25 | 4 test: (a) route mới không `@Public()`, không `@UseGuards` tường minh → vẫn 401 không header; (b) `/v1/health/live` không cần header → 200; (c) `/v1/health/ready` không cần header → 200/503 theo DB; (d) `/v1/identity/me` vẫn hoạt động y như trước (không đổi hành vi, không phải guard đôi) | `npm run test:e2e -- test/app-guard.e2e-spec.ts` | `test(app): prove JwtAuthGuard applies to every route by default` |
| 12 | `backend/src/modules/identity/jwks-verifier.service.spec.ts` | TC-50-26 | Thêm case: đóng JWKS fixture server trước khi gọi `verifyAccessToken` với `kid` chưa cache (buộc phải fetch) → reject `TokenVerificationError`, không throw lỗi khác, không treo quá `timeoutDuration` | `npm test -- src/modules/identity` | `test(identity): JWKS fetch failure fails closed` |
| 13 | `backend/src/modules/identity/jwt-auth.guard.ts` (1 dòng comment) | — | Ghi lý do giữ `scheme !== 'Bearer'` phân biệt hoa/thường (finding #5, không sửa logic) | `npm run lint:check` | gộp vào commit bước 9 |
| 14 | `backend/scripts/manual-smoke.dbs50.ts` (mới, giữ lại, không xóa) | — | Viết lại script boot app thật + JWKS RAM server (nội dung tương đương script cũ đã mô tả rời rạc ở §5), dùng để chạy M-50-01…06 ở Phase 4c | `npx ts-node -r tsconfig-paths/register backend/scripts/manual-smoke.dbs50.ts` | `test(identity): keep the manual smoke script used for M-50` |
| 15 | `docs/BACKLOG.md` (+`BL-018`), `docs/features/README.md` (+dòng DBS-50) | — | Phase 5: `BL-018` cho DoD #5 (merge + Dev review) chưa đạt; dòng README trạng thái "Implemented" | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(features): DBS-50 backlog row and README entry` |
| 16 | `docs/features/DBS-50-jwt-auth-guard-jwks.md` §2–§5, §8 | — | Cập nhật §2 (route mới không header vẫn 401 — hành vi hệ thống, không riêng `/identity/me`), §3 (kiến trúc: guard global + `@Public()`), §4 (TC-50-22…26), §5 (M-50-06: gọi 1 route bất kỳ không có header → 401, không cần code route đó biết gì về auth), §8 (đối chiếu đầy đủ) | — | gộp vào commit bước 15 |

**Rủi ro và cách lùi:** đổi `JwtAuthGuard` thành global guard là thay đổi hành vi áp dụng cho **mọi** route tương lai (không route hiện tại nào đổi, vì `health` sẽ có `@Public()` và `identity/me` vẫn cần token như cũ) — rủi ro duy nhất là quên `@Public()` ở một route không cần auth trong **task này** (không có route nào khác trong task này). Lùi bằng cách gỡ `APP_GUARD` khỏi `app.module.ts` (1 dòng), không đụng migration hay dữ liệu.

**Quét theo DoD/giới hạn đã nêu:** không có dòng `docs/BACKLOG.md` nào khác liên quan `identity`/`JWT`/`Cognito` ngoài việc tự mở `BL-018` ở bước 15 (đã kiểm bằng grep ở Phase 1).

**Rebase lên `main` sau G4 (2026-10-26):** `main` đã tiến thêm từ lúc task bắt đầu (`LoggingModule` ở DBS-42, Terraform bootstrap DBS-31) và đã dùng hết `BL-018`…`BL-029`. Rebase conflict ở `backend/package.json`/`package-lock.json` (giữ cả `jose` và `nestjs-pino`, lockfile regenerate qua `npm install --package-lock-only`), `backend/src/app.module.ts` (giữ cả `LoggingModule` trong `imports` và `providers: httpGuardProviders`, không có xung đột logic thật), `docs/BACKLOG.md` và `docs/features/README.md` (giữ cả hai phía, mỗi bên thêm dòng riêng). Dòng backlog của task này đổi số từ `BL-018` dự kiến sang **`BL-030`** (số tự do mới nhất sau rebase). Baseline chạy lại đầy đủ sau rebase, xem §8.

## 8. Kết quả

### Vòng 1 (2026-10-24)

- **Lệnh kiểm tra:** `lint:check` sạch; `typecheck` sạch; `npm test` → 27 suite / 388 test đạt; `npm run test:e2e` → 5 suite / 32 test đạt.
- **Test thủ công:** M-50-01…05 đạt (script tạm, lúc đó bị xóa sau khi chạy — xem §6 vòng 2 #2).

### Vòng 2 — xử lý domain-review REVISE (2026-10-26)

- **Lệnh kiểm tra** (chạy lại toàn bộ trên commit `ecc4948`, từ `backend/`, Docker + Postgres thật qua `docker compose up -d`):
  - `npm run lint:check` → sạch.
  - `npm run typecheck` → sạch.
  - `npm test` (unit, toàn repo) → **28 suite / 393 test đạt** (393 = 388 vòng 1 + 2 `public.decorator.spec.ts` + 2 case mới trong `jwt-auth.guard.spec.ts` + 1 case mới trong `jwks-verifier.service.spec.ts`).
  - `npm run test:e2e` (toàn repo) → **6 suite / 35 test đạt** (35 = 32 vòng 1 + 3 case mới trong `test/app-guard.e2e-spec.ts`).
  - 0 test `.skip`/`.only`/`.todo` trong toàn bộ `src`/`test` (đã grep).
- **Lệnh kiểm tra sau khi rebase lên `origin/main`** (commit cuối sau rebase, Docker + Postgres thật, chạy `npm run migration:run` lấy migration mới của DBS-26/27 trước khi test):
  - `npm run lint:check` → sạch. `npm run typecheck` → sạch.
  - `npm test` (toàn repo) → **30 suite / 495 test đạt** (tăng so với trước rebase vì `main` đã thêm DBS-26, DBS-27, DBS-31, DBS-42 — các test của DBS-50 không đổi số lượng).
  - `npm run test:e2e` (toàn repo) → **8 suite / 57 test đạt**.
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-50-01…09, 09b, 09c, 26 | `src/modules/identity/jwks-verifier.service.spec.ts` | đạt |
| TC-50-10…14 | `src/modules/identity/jwt-auth.guard.spec.ts` | đạt |
| TC-50-15…21 | `test/identity.e2e-spec.ts` | đạt |
| TC-50-22…24 | `test/app-guard.e2e-spec.ts` | đạt |
| TC-50-25 | `src/common/auth/public.decorator.spec.ts` | đạt |
| DoD #5 | merge PR, Dev review, bảng đối chiếu | **chưa làm** — PR chưa mở, xem `BL-030` |

- **Test thủ công:** M-50-01…06 — tất cả **đạt**, chi tiết ở §5 và `docs/features/screenshots/DBS-50/manual-test.txt` (SHA `ecc4948` ở đầu file). Không chụp ảnh (task không có UI — API thuần, không có giao diện để chụp).
- **Phạm vi so với §7+§7b:** `git diff --stat main...HEAD` (xem danh sách dưới, cả hai vòng) khớp danh sách file đã lập kế hoạch; không có file lạ ngoài kế hoạch.

```
backend/package.json                                        |   1 +
backend/package-lock.json                                    | nhiều dòng (jose@5.10.0)
backend/env/.env.example                                      |   2 +
backend/src/common/auth/public.decorator.ts                   (mới, vòng 2)
backend/src/common/auth/public.decorator.spec.ts               (mới, vòng 2)
backend/src/common/errors/error-code.enum.ts                  |  13 +
backend/src/config/auth.config.ts                             |   7 +
backend/src/config/validation.schema.ts                       |   3 +
backend/src/app.module.ts                                      (sửa, vòng 2 — APP_GUARD)
backend/src/modules/index.ts                                  |   5 +-
backend/src/modules/health/health.controller.ts                (sửa, vòng 2 — @Public())
backend/src/modules/identity/identity.controller.ts            (mới)
backend/src/modules/identity/identity.errors.ts                (mới)
backend/src/modules/identity/identity.module.ts                (mới)
backend/src/modules/identity/index.ts                          (mới)
backend/src/modules/identity/jwks-verifier.service.ts          (mới)
backend/src/modules/identity/jwks-verifier.service.spec.ts     (mới; +1 case vòng 2)
backend/src/modules/identity/jwt-auth.guard.ts                 (mới; sửa vòng 2 — Reflector)
backend/src/modules/identity/jwt-auth.guard.spec.ts            (mới; +2 case vòng 2)
backend/src/modules/identity/jwt-claims.ts                     (mới)
backend/src/scripts/manual-smoke.dbs50.ts                      (mới, vòng 2 — giữ lại, không xóa)
backend/test/identity.e2e-spec.ts                              (mới)
backend/test/support/jwks-fixture.ts                           (mới)
backend/test/app-guard.e2e-spec.ts                             (mới, vòng 2)
docs/BACKLOG.md                                                (sửa, vòng 2 — +BL-030)
docs/features/README.md                                       (sửa, vòng 2 — +dòng DBS-50)
```

- **Ảnh chụp:** không áp dụng (task không có UI, không yêu cầu ảnh theo DoD).
- **Lệch so với kế hoạch (vòng 1):**
  - Kế hoạch gốc dùng `jose@6`; `jose@6` chỉ build ESM, không chạy được qua `ts-jest`/CommonJS của repo → đổi sang `jose@5.10.0` (có build CJS, API giống nhau).
  - Kế hoạch gốc dùng `test/support/jwks-fixture.ts` chung cho cả unit lẫn e2e; ESLint boundary rule (`no-restricted-imports`) cấm `*.spec.ts` trong `src/modules/identity` import tương đối ra `test/support/`. Xử lý: viết lại fixture JWKS trực tiếp trong `jwks-verifier.service.spec.ts`, giữ bản ở `test/support/jwks-fixture.ts` chỉ cho e2e dùng — trùng lặp code (~45 dòng) nhưng đúng convention của repo.
  - Thời gian chờ cooldown JWKS trong test dùng `setTimeout` thật (200ms) thay vì fake timers của Jest (`jose`'s `createRemoteJWKSet` dùng `Date.now()` nội bộ, khó mock cùng `async`/`await` HTTP thật).
- **Lệch so với kế hoạch (vòng 2, §7b):** script `manual-smoke.dbs50.ts` đặt ở `backend/src/scripts/` (đúng convention sẵn có của repo, xem `src/scripts/README.md`), không phải `backend/scripts/` như §7b ghi ban đầu khi lập kế hoạch — `backend/scripts/` không tồn tại trong repo.
- **Bàn giao cho vai khác:** `BL-030` (DoD #5 — PR merge + Dev review + bảng đối chiếu, chưa đạt tới lúc bàn giao lại). Không có BL-NNN khác — role guard (`@Roles()`), `@CurrentUser()`, revocation check vẫn là các task riêng theo ADR-06.

## 9. Tài liệu đã cập nhật

- `docs/BACKLOG.md` — thêm `BL-030`.
- `docs/features/README.md` — thêm dòng DBS-50 (trạng thái Implemented).

## Checklist G4

- [x] 26 (unit+e2e, riêng `identity`+`common/auth`+`app-guard`)/26 test case liên quan đạt đủ độ sâu, 0 đơn giản hóa
- [x] Test thủ công chạy trên commit cuối đổi code (`ecc4948`): M-50-01…06 đều đạt; đường thành công (M-50-03, M-50-06) đã chạy
- [ ] Ảnh chụp — không áp dụng (không có UI)
- [x] `git diff --stat main...HEAD` khớp danh sách file ở §7+§7b
- [x] Hai lệnh kiểm tra chính (`lint:check`, `typecheck`) sạch; sau rebase lên `main`: `test` 495/495 (toàn repo); `test:e2e` 57/57 (toàn repo) — có số đếm ở §8
- [x] Không có doc khác bị đổi fact ngoài `BACKLOG.md` và `features/README.md` (liệt ở §9)
- [x] `BL-030` đã mở cho DoD #5 chưa đạt; không có BL-NNN khác cần thêm
- [x] Domain-review vòng 2 chạy thật (subagent, không phải tự review), verdict REVISE, mọi finding blocking/should-fix đã xử lý, finding minor ghi lý do không sửa — §6
