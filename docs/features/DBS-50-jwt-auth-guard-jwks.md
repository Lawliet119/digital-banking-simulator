# DBS-50 · Identity: JwtAuthGuard xác minh JWT bằng JWKS có cache

> **Status:** Implemented · **Vai:** Dev (AI, qua Plan mode — xem "Quyết định" dưới) · **Nhánh:** `feat/DBS-50-jwt-auth-guard-jwks` · **PR:** — · **Cập nhật:** 2026-10-24

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
- Không bao giờ log raw token — chỉ log loại lỗi (`err.name`), kèm `correlationId` có sẵn từ `ProblemDetailsFilter`.

## 3. Kiến trúc

- **Vị trí:** `backend/src/modules/identity/` (role `api`, khớp README cũ của module). Đăng ký ở `apiModules` trong `backend/src/modules/index.ts` (không phải `sharedModules` — module chỉ có controller, không consumer/scheduler).
- **File chính:**
  - `jwt-claims.ts` — `CognitoAccessTokenClaims`, `AuthenticatedUser`.
  - `identity.errors.ts` — `TokenExpiredError`, `TokenVerificationError`.
  - `jwks-verifier.service.ts` — bọc `jose`'s `createRemoteJWKSet` + `jwtVerify`; tự kiểm `client_id`/`token_use` sau khi `jwtVerify` xác nhận chữ ký/`iss`/`exp`.
  - `jwt-auth.guard.ts` — `CanActivate`; trích token từ header, gọi verifier, map lỗi → `ErrorCode`, gắn `request.user`.
  - `identity.controller.ts` — `GET /identity/me`, `@ApiBearerAuth('access-token')`.
  - `identity.module.ts`, `index.ts` (barrel).
- **Interface cung cấp (qua `index.ts`):** `IdentityModule`, `JwtAuthGuard`, `RequestWithUser`, `JwksVerifierService`, `AuthenticatedUser`, `CognitoAccessTokenClaims`, `TokenExpiredError`, `TokenVerificationError`. Chưa có ai gọi (module đầu tiên dùng các export này).
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
| — | DoD #5 | quy trình | Merge PR sau Dev review + CI xanh + bảng đối chiếu — chưa làm (xem §8) | — |

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

Script test tay (`manual-smoke.dbs50.ts`, tạm thời, đã xóa sau khi chạy — không commit): boot bằng `ts-node -r tsconfig-paths/register`, dùng `jose` sinh keypair RSA trong RAM, serve JWKS qua `node:http`, gọi thật bằng `fetch`. Không cần Docker vì Docker Desktop không chạy được trên máy này lúc làm task (`failed to connect to the docker API`) — không chặn task vì guard không cần DB/Redis.

## 6. Domain review (AI)

**Reviewer:** subagent `code-review` (skill, effort `high`), model Sonnet 5, 2026-10-24 · **Kết quả:** 5 phát hiện, verdict tất cả CONFIRMED/PLAUSIBLE.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | `JwksVerifierService` throw ở constructor khi `COGNITO_ISSUER` chưa set (optional ở local dev) → `IdentityModule` nằm trong `apiModules` làm **crash toàn bộ app khi boot** nếu không cấu hình Cognito | **đã sửa** — chuyển check sang lazy, chỉ throw (sạch, không crash process) khi có request thật gọi `verifyAccessToken()`; thêm TC-50-09b |
| 2 | should-fix | Kiểm `client_id` dùng `payload.client_id !== this.cfg.cognito.clientId`; khi `COGNITO_CLIENT_ID` chưa set, cả hai phía là `undefined` → so sánh `false`, bỏ qua kiểm tra | **đã sửa** — thêm `!this.cfg.cognito.clientId ||` vào điều kiện; thêm TC-50-09c |
| 3 | should-fix | `JWKS_REFETCH_COOLDOWN_MS` có trong schema + config nhưng thiếu trong `env/.env.example`, vi phạm CONTRIBUTING §5b (3 bước bắt buộc cho biến môi trường mới) | **đã sửa** — thêm dòng vào `env/.env.example` |
| 4 | minor | `jwksUri` nối chuỗi từ `COGNITO_ISSUER` không strip trailing slash → double slash nếu issuer có `/` cuối, JWKS 404 toàn bộ mà không có cảnh báo lúc boot | **đã sửa** — `issuer.replace(/\/+$/, '')` trước khi nối |
| 5 | minor | `baseClaims()` trong `test/identity.e2e-spec.ts` lặp lại y nguyên logic trong `jwks-verifier.service.spec.ts` | **không sửa** — hai file dùng claim test *data* khác mục đích với fixture *JWKS machinery* (file đã trùng lặp có chủ đích vì ranh giới module/test, xem "Lệch so với kế hoạch"); để `baseClaims` trùng là chấp nhận được, hợp nhất sẽ phải phá ranh giới đó lần nữa |

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

## 8. Kết quả

- **Lệnh kiểm tra** (chạy lúc bàn giao, 2026-10-24, từ `backend/`):
  - `npm run lint:check` → sạch.
  - `npm run typecheck` → sạch.
  - `npm test` (unit) → **27 suite / 388 test đạt** (21 test mới của `identity`, gồm 3 test regression thêm sau code-review).
  - `npm run test:e2e` → **5 suite / 32 test đạt** (7 test mới của `identity.e2e-spec.ts`).
  - `npm run build` → chưa chạy riêng (không nằm trong 4 lệnh gate chính của skill; `typecheck` đã phủ lỗi kiểu).
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-50-01…09, 09b, 09c | `src/modules/identity/jwks-verifier.service.spec.ts` | đạt |
| TC-50-10…14 | `src/modules/identity/jwt-auth.guard.spec.ts` | đạt |
| TC-50-15…21 | `test/identity.e2e-spec.ts` | đạt |
| DoD #5 | merge PR, Dev review, bảng đối chiếu | **chưa làm** — PR chưa mở (xem "Lệch so với kế hoạch") |

- **Test thủ công:** M-50-01…05 — tất cả **đạt**, chi tiết ở §5. Không chụp ảnh (task không có UI).
- **Phạm vi so với §7:** `git diff --stat main...HEAD` khớp danh sách file ở §7 (xem danh sách dưới); không có file lạ ngoài kế hoạch.

```
backend/package.json                                     |   1 +
backend/package-lock.json                                 | nhiều dòng (jose@5.10.0)
backend/src/common/errors/error-code.enum.ts               |  11 +
backend/src/config/auth.config.ts                          |   4 +
backend/src/config/validation.schema.ts                     |   3 +
backend/env/.env.example                                     |   2 +
backend/src/modules/index.ts                                |   3 +-
backend/src/modules/identity/identity.controller.ts          (mới)
backend/src/modules/identity/identity.errors.ts              (mới)
backend/src/modules/identity/identity.module.ts               (mới)
backend/src/modules/identity/index.ts                          (mới)
backend/src/modules/identity/jwks-verifier.service.ts           (mới)
backend/src/modules/identity/jwks-verifier.service.spec.ts       (mới)
backend/src/modules/identity/jwt-auth.guard.ts                    (mới)
backend/src/modules/identity/jwt-auth.guard.spec.ts                (mới)
backend/src/modules/identity/jwt-claims.ts                          (mới)
backend/test/identity.e2e-spec.ts                                    (mới)
backend/test/support/jwks-fixture.ts                                  (mới)
```

- **Ảnh chụp:** không áp dụng (task không có UI, không yêu cầu ảnh theo DoD).
- **Lệch so với kế hoạch:**
  - Kế hoạch gốc dùng `jose@6` (bản mới nhất lúc viết plan); khi code thực tế phát hiện `jose@6` chỉ build ESM, không chạy được qua `ts-jest`/CommonJS của repo → đổi sang `jose@5.10.0` (có build CJS, API giống nhau). Chưa có người duyệt riêng cho lệch này (người dùng chỉ nói "làm cho tôi đi", không có gate G2 tách riêng) — cần Dev review xác nhận khi mở PR.
  - Kế hoạch gốc dùng `test/support/jwks-fixture.ts` chung cho cả unit lẫn e2e; khi code phát hiện ESLint boundary rule (`no-restricted-imports`, "A module's internals never reach into test/") cấm `src/modules/identity/*.spec.ts` import tương đối ra `test/support/`. Xử lý: viết lại fixture JWKS trực tiếp trong `jwks-verifier.service.spec.ts` (không export, không dùng chung), giữ bản ở `test/support/jwks-fixture.ts` chỉ cho e2e dùng — có trùng lặp code (~45 dòng) nhưng tuân đúng convention có sẵn của repo.
  - Thời gian chờ cooldown JWKS trong test (unit lẫn e2e) dùng `setTimeout` thật (200ms) thay vì fake timers của Jest, vì `jose`'s `createRemoteJWKSet` dùng `Date.now()` nội bộ không mock được dễ dàng qua Jest fake timers kết hợp `async`/`await` HTTP thật.
  - Sau khi code xong, chạy subagent `code-review` (effort `high`) tự phát hiện 1 lỗi blocking (crash app khi boot thiếu `COGNITO_ISSUER`) và 3 should-fix/minor khác — không có trong kế hoạch gốc vì kế hoạch không lường hết việc Nest khởi tạo `JwksVerifierService` eager. Đã sửa cả 4 (trừ 1 minor cố ý không sửa), thêm 3 test mới (TC-50-09b/09c), xem §6.
- **Bàn giao cho vai khác:** không có BL-NNN mới — role guard (`@Roles()`), decorator `@CurrentUser()`, revocation check đã là các task riêng theo ADR-06 (không phải phát hiện mới của task này).

## 9. Tài liệu đã cập nhật

Không có — không sửa file docs nào khác ngoài tài liệu này.

## Checklist G4

- [x] 23 (unit+e2e, riêng `identity`)/23 test case liên quan đạt đủ độ sâu, 0 đơn giản hóa (gồm 3 test thêm sau code-review)
- [x] Test thủ công chạy trên commit cuối đổi code: M-50-01…05 đều đạt; đường thành công (M-50-03) đã chạy
- [ ] Ảnh chụp — không áp dụng (không có UI)
- [x] `git diff --stat main...HEAD` khớp danh sách file ở §7
- [x] Hai lệnh kiểm tra chính (`lint:check`, `typecheck`) sạch; `test` 388/388 (toàn repo); `test:e2e` 32/32 (toàn repo) — có số đếm ở §8
- [x] Không có doc khác bị đổi fact
- [x] Không có BL-NNN cần thêm; DoD chưa đạt (#5 — merge, Dev review) đã ghi ở §8, chưa qua G4 thật sự vì chưa có PR/Dev review theo đúng CONTRIBUTING §5/§5b
