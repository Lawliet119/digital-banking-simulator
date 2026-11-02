# DBS-51 · @Roles, RolesGuard và @CurrentUser; vai trò lấy từ cognito:groups

> **Status:** Implemented (sau G4) · **Vai:** Dev · **Cặp đôi review:** Dev khác (chưa chỉ định) · **Nhánh:** `feat/DBS-51-roles-guard-current-user` (từ `main` = `6528c02`) · **PR:** — (chưa mở) · **Cập nhật:** 2026-11-02

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 2, ưu tiên Highest, Deliverable/Demo P2, Status "In Progress". Vai board `Dev` khớp loại việc (backend code).
- **Expect:** "Mỗi endpoint khai báo được vai trò được phép; sai vai trò bị từ chối."
- **DoD** (chép nguyên văn):
  1. @Roles(customer|operator|auditor|admin) và RolesGuard; sai vai trò → 403 (errorCode đúng, problem+json)
  2. @CurrentUser trả {userId, sub, roles}; export qua modules/identity/index.ts
  3. Vai trò đọc từ cognito:groups, không đọc từ body hay header khác; test thử giả mạo
  4. Test: mỗi vai trò gọi endpoint mẫu của vai khác đều bị từ chối
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Thực trạng (board):** chưa có decorator hay guard phân quyền; không có cột `users.role`, vai trò chỉ lấy từ nhóm Cognito trong JWT (database-design §13 điểm 15). ADR-06 (cập nhật 11/10): token không thuộc nhóm nào (khách tự đăng ký) được coi là `customer`.
- **Phụ thuộc:**

| Task | Board | Thực tế trong repo |
|---|---|---|
| DBS-50 JwtAuthGuard + JWKS | In Review | **Đã có trên `main`** (commit `82c8e23`, PR #29). Board chậm so với repo: nên chuyển sang Done. `JwtAuthGuard` là `APP_GUARD` toàn cục, đặt `request.user = { sub, userId, groups, tokenUse, claims }` với `groups = claims['cognito:groups'] ?? []`. Kiểu khai báo là `string[]` nhưng **không ai kiểm kiểu lúc chạy**: token ký hợp lệ mang `"cognito:groups": "admin"` hay một đối tượng vẫn tới được `RolesGuard` dưới dạng không phải mảng. Vì vậy `rolesFromGroups` nhận `unknown` (§2.1). |
| DBS-52 upsert `users` theo `cognito_sub` (không phải phụ thuộc khai báo) | To Do | **Đã có trên `main`** (PR #46, commit `6528c02`). `JwtAuthGuard` gọi `IdentityService.resolveUserId(sub)` và gán `request.user.userId` (luôn có giá trị khi qua guard); đây là nguồn `userId` của DoD #2. |
| DBS-53 token mẫu theo vai (`auth:dev-token`) | To Do | **Chưa có.** Test thủ công không có cách lấy token từng vai ngoài cách tự dựng JWKS trong RAM như DBS-50 và DBS-52. |

- **Đã có gì:**
  - [`jwt-auth.guard.ts`](../../backend/src/modules/identity/jwt-auth.guard.ts), [`jwt-claims.ts`](../../backend/src/modules/identity/jwt-claims.ts) (`AuthenticatedUser` = `{ sub, userId, groups, tokenUse, claims }`), [`identity.module.ts`](../../backend/src/modules/identity/identity.module.ts), [`index.ts`](../../backend/src/modules/identity/index.ts) (chưa export decorator hay guard phân quyền), [`public.decorator.ts`](../../backend/src/common/auth/public.decorator.ts), [`app.module.ts`](../../backend/src/app.module.ts) (đăng ký `JwtAuthGuard` làm `APP_GUARD`, chỉ khi `runsHttp()`).
  - [`error-code.enum.ts`](../../backend/src/common/errors/error-code.enum.ts): có `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `SESSION_REVOKED`; **chưa có mã cho 403**.
  - [`problem-details.filter.ts`](../../backend/src/common/filters/problem-details.filter.ts) đã đẩy `errorCode` của `HttpException` ra problem+json.
  - Nhóm Cognito do Terraform tạo đúng bốn tên `customer`, `operator`, `auditor`, `admin` ([`cognito.tf`](../../infra/terraform/envs/dev/base/cognito.tf)).
  - Test mẫu để theo: [`identity.e2e-spec.ts`](../../backend/test/identity.e2e-spec.ts) (JWKS giả trong RAM), [`app-guard.e2e-spec.ts`](../../backend/test/app-guard.e2e-spec.ts) (AppModule thật), [`manual-smoke.dbs50.ts`](../../backend/src/scripts/manual-smoke.dbs50.ts).
  - Người gọi (grep) của symbol sẽ đổi: `AuthenticatedUser` được dùng bởi `jwt-auth.guard.ts`, `identity.controller.ts`, `index.ts`, các spec của identity; `app.module.ts` đăng ký `JwtAuthGuard`.
- **Baseline** (2026-11-01, `main` = `6528c02`, sau khi DBS-52 merge; Docker Desktop 27.3.1):

| Lệnh | Kết quả |
|---|---|
| `npm run lint:check` | sạch |
| `npm run typecheck` | sạch |
| `npm test` | 43 suites, **597 test**: 596 đạt, **1 đỏ** (`jwks-verifier.service.spec.ts` › `refetches on key rotation once the cooldown has elapsed, but not before`, đỏ ở cả hai lần chạy toàn bộ; chạy riêng suite đó thì 13/13 xanh). Đây là `BL-112` (test dựa vào `setTimeout` thật, đỏ khi máy bận), không liên quan phân quyền |
| `npm run test:e2e -- --forceExit` | 8 suites, **57 test** đạt |
| `npm run test:db` | 15 suites, **317 test** đạt |

  Máy này có PostgreSQL native chiếm cổng 5432 nên test đăng nhập sai vào Postgres native. Cách xử lý theo `manual-testing.md`: file override compose đặt **ngoài repo** (`~/dbs-51-compose-override.yml`) ánh xạ Postgres sang cổng 5433 và `DATABASE_URL=postgres://banking:…@localhost:5433/banking`.
- **Backlog cùng module** (`docs/BACKLOG.md`):
  - `BL-030` (DoD #5 của DBS-50, PR chưa mở): PR #29 đã merge, dòng này đã cũ nhưng thuộc DBS-50; **không đụng** trong PR này, chỉ báo để chủ DBS-50 xóa.
  - `BL-112` (hai test cooldown của `jwks-verifier.service.spec.ts` lúc đỏ khi máy bận): không liên quan phân quyền; **ngoài phạm vi**, giữ nguyên. Không gặp lỗi này trong lần baseline.
  - `BL-100`: thuộc #5, không liên quan.
- **Ngoài phạm vi:**
  - Upsert dòng `users` và ánh xạ `sub → users.id` (DBS-52).
  - Token mẫu theo vai, `AUTH_MODE=local` (DBS-53).
  - Kiểm tra sở hữu tài nguyên trong service (trả 404, AC-5.8): thuộc task endpoint/service từng module.
  - Ghi audit `DENIED` cho lần 403: chủ là DBS-56 (`AuditService`, chưa merge), điểm gọi là nhánh ném 403 của `RolesGuard` (§2.6). Task này chỉ để lại dòng log `warn`.
  - Mốc thu hồi phiên `SESSION_REVOKED`, rate limit.
  - Endpoint nghiệp vụ thật (`/v1/operator/...`): task này chỉ cung cấp cơ chế; "endpoint mẫu" của DoD #4 là controller dựng trong test.
- **Câu hỏi mở:** đã trình ở tin nhắn G1 (8 câu, mỗi câu có đề xuất).
- **Quyết định ở G1 (2026-11-01):** duyệt G1. Câu 1: chọn phương án (b), **làm DBS-52 trước**, DBS-51 tạm dừng sau G1 và quay lại khi DBS-52 xong (khi đó `userId` có nguồn thật, không stub). Các câu 2–8 duyệt theo đề xuất của agent, riêng câu 3 (thêm `ErrorCode.FORBIDDEN`) và câu 5 (route thiếu `@Roles` chỉ cần token hợp lệ) sẽ được nhắc lại ở G2 vì đổi enum và hành vi mặc định.

## 2. Hành vi

Task không thêm endpoint nghiệp vụ. Nó thêm cơ chế: một decorator khai báo vai trò, một guard thứ hai kiểm vai trò, một decorator tham số lấy người gọi.

### 2.1 Từ nhóm Cognito ra vai trò

Vai trò của request chỉ suy ra từ `request.user.groups`, tức claim `cognito:groups` của access token **đã qua** `JwtAuthGuard` (chữ ký, `iss`, `client_id`, `token_use`, `exp`). Không đọc body, query, cookie hay header nào khác.

| `cognito:groups` | `roles` |
|---|---|
| không có claim, `[]` | `["customer"]` (ADR-06) |
| `["operator"]` | `["operator"]` (không tự thêm `customer`) |
| `["operator","auditor"]` | `["operator","auditor"]` (thứ tự cố định `customer, operator, auditor, admin`, không lặp) |
| `["Admin","ops","constructor","__proto__"]` (chỉ nhóm lạ; so khớp phân biệt hoa thường) | `["customer"]` |
| `["xyz","auditor"]` | `["auditor"]` (nhóm lạ bị bỏ) |
| claim sai kiểu: `"admin"` (chuỗi), `null`, `{}`, đối tượng giống mảng `{"0":"admin","length":1}`, `[["admin"]]`, `[1,{}]` | không phải mảng thật → `["customer"]`; phần tử không phải chuỗi bị bỏ |
| `["admin "]`, `["ADMIN"]` (thừa dấu cách, khác hoa thường) | `["customer"]` (so khớp tuyệt đối, không `trim`, không đổi hoa thường) |

Cách cài đặt bắt buộc: `Array.isArray(groups)`, rồi với từng phần tử `typeof === 'string'` và `ROLES.includes(phần tử)`. Cấm dò theo khóa của đối tượng (`obj[name]`), `Array.from`, hay vòng lặp theo `length`: các cách đó để đối tượng giống mảng hoặc tên như `__proto__` lọt qua.

`roles` luôn là mảng không rỗng. **Không có phân cấp**: `admin` không tự có quyền `operator`; endpoint cho cả hai phải ghi `@Roles('operator','admin')`.

### 2.2 `@Roles(...)` và `RolesGuard`

`@Roles('operator','admin')` đặt trên method hoặc controller. Guard cho qua khi **giao** của `roles` và danh sách khai báo khác rỗng.

| Tình huống | Kết quả |
|---|---|
| Vai trò khớp | handler chạy |
| Sai vai trò | **403** `FORBIDDEN`, handler **không chạy** |
| Route không có `@Roles` (và không `@Public`) | chỉ cần token hợp lệ (quyết định G1 câu 5, **nhắc lại ở G2 câu 2**). Rủi ro: route nghiệp vụ mới mà quên `@Roles` thì mọi vai gọi được. Biện pháp giảm thiểu trong task này: TC-51-27 đỏ nếu một route của `AppModule` thật không có `@Public` hay `@Roles` |
| Mỗi lần trả 403 | ghi **một dòng log `warn`** có `userId`, method, **mẫu đường dẫn route** (`request.route?.path`, ví dụ `/v1/sample/admin`; **không** dùng `url`/`originalUrl` vì mang query string), vai trò route yêu cầu và `roles` đã suy ra của người gọi (giá trị đã ký, không bí mật, và là tín hiệu duy nhất cho biết khách đang dò route admin vì không có cột `users.role`); **không** ghi token, `sub`, `claims` hay `groups`. Đây là điểm móc cho audit `DENIED` sau này (§2.6; `audit_log.actor_role` là `NOT NULL` nên DBS-56 cần đúng giá trị này). Nếu `request.route` vắng mặt thì ghi hằng `(unknown route)`, không bao giờ rơi về `url` |
| `@Roles` ở cả controller và method | method **thay** controller (không gộp) |
| Route `@Public()` và có `@Roles` | **401** `UNAUTHENTICATED` (không có người gọi thì không có vai trò; fail closed) |
| Không token / token sai / hết hạn | `JwtAuthGuard` trả 401 `UNAUTHENTICATED` / `TOKEN_EXPIRED` trước, `RolesGuard` không chạy |
| `@Roles()` rỗng hoặc tên vai trò lạ | ném lỗi lúc khai báo (khởi động), không bao giờ thành "chặn hết" hay "cho hết" âm thầm |
| Metadata có nhưng hỏng (ai đó gọi thẳng `SetMetadata(ROLES_KEY, …)` với `[]`, không phải mảng, hay tên không thuộc `ROLES`) | **fail closed**: guard từ chối bằng 403 `FORBIDDEN` (không cho qua). Chỉ `undefined` mới nghĩa là "route không có `@Roles`". Cấm viết `if (!required?.length) return true` |

Khóa metadata là hằng `ROLES_KEY = 'dbs:roles'` (export từ `roles.decorator.ts`, dùng chung với test).

403 theo RFC 7807, `detail` cố định, **không** nêu vai trò đang có hay vai trò cần:

```json
{
  "type": "about:blank",
  "title": "Forbidden",
  "status": 403,
  "detail": "The caller's role is not allowed to use this endpoint.",
  "errorCode": "FORBIDDEN",
  "correlationId": "c1f4e0b2-5a3d-4e8f-9b61-2d7a0c9e4f10"
}
```

### 2.3 `@CurrentUser()`

Tham số handler, trả đúng ba trường (không lộ `claims` hay `groups`):

```json
{ "userId": "0f6a3d52-8c1b-4e7a-b6d4-2c9e1a7f5b30", "sub": "5b0d7c1e-3f4a-4c8e-9d2b-7a1e6f0c9a42", "roles": ["operator"] }
```

`userId` là `users.id` do DBS-52 cấp. Mỗi lần gọi trả một đối tượng mới (đổi `roles` trong handler không ảnh hưởng guard). Không có `request.user` (route `@Public`) thì ném 401 `UNAUTHENTICATED`, không trả `undefined` để service sau đó lỗi 500.

### 2.4 Giả mạo (DoD #3)

Token của khách (không nhóm) kèm `X-Role: admin`, `X-User-Roles`, `X-Cognito-Groups`, `X-Forwarded-Groups`, body `{"role":"admin","roles":["admin"],"cognito:groups":["admin"]}`, query `?role=admin`, cookie `role=admin`: gọi endpoint admin vẫn **403**, và `@CurrentUser().roles` vẫn `["customer"]`. Sửa payload token thành `admin` rồi giữ chữ ký, token ký bằng khóa khác, hoặc ID token mang nhóm `admin`: **401** `UNAUTHENTICATED` (đã có từ DBS-50, test lại ở đây vì đây là cửa leo thang đặc quyền T21).

### 2.5 OpenAPI

`@Roles` tự thêm `x-roles` (danh sách vai trò) và response 403 `FORBIDDEN` vào tài liệu của route (yêu cầu của module-notes: mỗi endpoint ghi vai trò và `ErrorCode`).

### 2.6 Cố ý không làm

Ghi audit `DENIED` khi 403. FR-AUD-02 (Must) và docs/03 §6.4 đòi nhật ký cho lần bị từ chối quyền, nhưng `AuditService` chưa có (DBS-56), và thiết kế một cổng `DenialRecorder` không có người dùng là suy đoán. Task này làm phần nhỏ nhất có thật: dòng log `warn` ở §2.2, và `RolesGuard` là chỗ duy nhất biết vai trò bị từ chối nên DBS-56 sẽ gọi `AuditService` đúng ở nhánh ném 403. Việc còn lại ghi thành dòng `BL-132` ở Phase 5 (xem G2 câu 3). Cũng không làm: kiểm sở hữu tài nguyên (service từng module, trả 404), thu hồi phiên, rate limit, đổi response của `GET /v1/identity/me`.

**Bàn giao dự kiến** (Phase 5 chép sang `docs/BACKLOG.md`, §8 ghi số `BL`; số thật kiểm lại với `origin/main` lúc đó):

| Việc | Chủ | Dòng |
|---|---|---|
| Ghi audit `DENIED` ở nhánh ném 403 của `RolesGuard` (FR-AUD-02, docs/03 §6.4); cần `roles` đã suy ra cho `actor_role` | Dev chủ audit (DBS-56) | `BL-132` (kèm liên kết từ T11 của threat model) |
| `GET /v1/identity/me` còn `@UseGuards(JwtAuthGuard)` thừa nên verify và `resolveUserId` hai lần; xóa `BL-030` đã cũ | Dev chủ DBS-50 | `BL-133` |
| Chuyển board DBS-50 và DBS-52 sang Done | người dùng (agent không sửa board) | không có dòng, nêu ở G2 và G4 |
| Thay JWKS trong RAM của script thủ công bằng `auth:dev-token` | Dev làm DBS-53 | không có dòng, DBS-53 đã có trên board |

## 3. Kiến trúc

- **Vị trí:** module `identity`, role `api` (và `both`). `worker` không có HTTP nên không đăng ký guard.
- **File mới** trong [`backend/src/modules/identity/`](../../backend/src/modules/identity/): `roles.ts`, `roles.decorator.ts`, `roles.guard.ts`, `current-user.decorator.ts`, `request-user.ts` (kèm spec cạnh từng file).
- **Interface cung cấp** (export qua `index.ts`):

```ts
export const ROLES = ['customer', 'operator', 'auditor', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export function rolesFromGroups(groups: unknown): Role[]; // §2.1, không bao giờ rỗng
export function Roles(...roles: [Role, ...Role[]]): ClassDecorator & MethodDecorator;
export class RolesGuard implements CanActivate {          // chỉ phụ thuộc Reflector
  // 403: ném HttpException({ errorCode: FORBIDDEN, message }) và ghi một dòng warn (Nest Logger, §2.2)
  canActivate(context: ExecutionContext): boolean;
}
export interface CurrentUserInfo { userId: string; sub: string; roles: Role[] }
export const CurrentUser: (...dataOrPipes: unknown[]) => ParameterDecorator;
```

- **Interface dùng:** `RequestWithUser`, `AuthenticatedUser` (DBS-50/52, **không đổi**), `IS_PUBLIC_KEY`, `Reflector.getAllAndOverride`.
- **Người gọi của symbol bị đổi (grep):** `ErrorCode` chỉ thêm `FORBIDDEN`, không nơi nào duyệt toàn enum (`Object.values(ErrorCode)` không có trong `src` và `test`). `app.module.ts` thêm một provider. `identity.controller.ts` **không đổi**: `GET /v1/identity/me` nằm trong danh sách cho phép của TC-51-27 với lý do "endpoint smoke của DBS-50, mọi vai hợp lệ". Không gắn `@Roles(...ROLES)` cho nó, vì "mọi vai" ghi như vậy trông như đã kiểm nhưng nghĩa y hệt không có `@Roles`, dễ bị sao chép, và Swagger sẽ hiện một 403 không bao giờ xảy ra. `AuthenticatedUser` và `RequestWithUser` giữ nguyên. Ghi chú không sửa: `me` còn có `@UseGuards(JwtAuthGuard)` cấp method nên token được verify và `resolveUserId` được gọi **hai lần** mỗi request; việc dọn thuộc chủ DBS-50 (§6 #10, `BL-133`).
- **Đăng ký:** trong `app.module.ts`, `httpGuardProviders` (chỉ khi `runsHttp()`) thành `[APP_GUARD JwtAuthGuard, APP_GUARD RolesGuard]`. Thứ tự này là hợp đồng: `RolesGuard` cần `request.user` do `JwtAuthGuard` gán. Chứng minh: TC-51-14 (thứ tự trong `getGlobalGuards()`), TC-51-19 (token **hết hạn** ra `TOKEN_EXPIRED`; nếu `RolesGuard` chạy trước nó chỉ thấy không có `request.user` và trả `UNAUTHENTICATED`) và TC-51-15 (token hợp lệ ra 200). Ca "không token" **không** chứng minh thứ tự vì cả hai thứ tự đều ra 401 `UNAUTHENTICATED`.
- **Vì sao `RolesGuard` không vào `exports` của `IdentityModule`:** bài học DBS-52 là mọi provider mà `APP_GUARD` cần phải export vì Nest resolve từ injector của `AppModule`. `RolesGuard` chỉ cần `Reflector` (luôn có), nên không phụ thuộc gì của `IdentityModule`. TC-51-14 chạy trên `AppModule` thật để chứng minh nó resolve được.
- **Dữ liệu:** không chạm bảng nào (vai trò không lưu ở DB, database-design §13 điểm 15). **Transaction:** không có. Không gọi Redis, HTTP.
- **`ErrorCode.FORBIDDEN`** thêm vào [`error-code.enum.ts`](../../backend/src/common/errors/error-code.enum.ts), và thêm dòng 403 vào bảng docs/03 §7.1 trong cùng PR (nguồn sự thật duy nhất). `ProblemDetailsFilter` đã đẩy `errorCode` ra, không phải sửa.

```mermaid
sequenceDiagram
    participant C as Client
    participant J as JwtAuthGuard
    participant I as IdentityService
    participant R as RolesGuard
    participant H as Handler
    C->>J: Bearer token
    J->>J: xác minh chữ ký và claim, lấy nhóm Cognito
    J->>I: resolveUserId(sub)
    I-->>J: userId
    J->>R: request.user gồm sub, userId, groups
    R->>R: rolesFromGroups(groups) so với Roles của route
    alt vai trò được phép
        R->>H: chạy handler, CurrentUser trả userId, sub, roles
    else sai vai trò
        R-->>C: 403 FORBIDDEN problem+json
    end
```

- **Thay đổi cấp hệ thống:** docs/03 §7.1 thêm dòng `FORBIDDEN` (403) và, vì bảng này là nguồn duy nhất mà đang thiếu, hai dòng `UNAUTHENTICATED` (401) và `TOKEN_EXPIRED` (401) đã có trong enum từ DBS-50; [`identity/README.md`](../../backend/src/modules/identity/README.md) (export mới); [`threat-model.md`](../security/threat-model.md) T21 sang "Đã kiểm một phần (DBS-51)" kèm link tới doc này, vì T21 còn DBS-159 chưa làm; T11 thêm liên kết tới `BL-132` kèm ghi chú "403 của `RolesGuard`: chưa ghi audit, chỉ có log `warn`". Không đổi ADR.

## 4. Test cases tự động

Dùng chung một controller mẫu chỉ có trong test (`test/support/roles-sample.module.ts`): `GET /v1/sample/{customer,operator,auditor,admin}` (mỗi cái `@Roles` đúng một vai trò), `/staff` (`operator`+`admin`), `/any` (không `@Roles`), `/public`, `/public-roles` (`@Public` + `@Roles('admin')`), `/whoami` (`@CurrentUser`), `POST /echo-admin`, và một controller `@Roles('operator')` cấp lớp có route kế thừa và route `@Roles('admin')`. Mỗi handler tăng một bộ đếm để test biết handler **có chạy hay không**. Các test e2e chạy trên `AppModule` thật (`APP_ROLE=api`) ghép với module mẫu, khóa JWKS thật trong RAM, chỉ `IdentityService` bị thay (không cần bảng). Suite **cần một PostgreSQL đang chạy** vì `DatabaseModule` kết nối lúc khởi động (như `app-guard.e2e-spec.ts`; job `e2e` của CI đã có service Postgres). `/docs-json` chỉ có sau khi gọi `setupSwagger(app)` sau `configureHttpApp`.

| ID | Truy vết | Lớp | Given · When · Then | `errorCode` |
|---|---|---|---|---|
| TC-51-01 | DoD #3, ADR-06 | unit | `rolesFromGroups` với `undefined`, `[]` → `["customer"]` | — |
| TC-51-02 | DoD #3 | unit | `["operator"]` → `["operator"]`; `["auditor","operator","operator"]` → `["operator","auditor"]` (thứ tự cố định, không lặp) | — |
| TC-51-03 | DoD #3 | unit | Chỉ nhóm lạ (`"Admin"`, `"ops"`, `"constructor"`, `"__proto__"`, `"toString"`) → `["customer"]`; lẫn `["xyz","auditor"]` → `["auditor"]` | — |
| TC-51-04 | DoD #3 | unit | Claim sai kiểu (`"admin"`, `null`, `{}`, `{"0":"admin","length":1}`, `[["admin"]]`, `[1,{}]`, `["admin "]`, `["ADMIN"]`) → `["customer"]`; `[1,"auditor"]` → `["auditor"]`; kết quả là mảng mới mỗi lần gọi | — |
| TC-51-05 | DoD #1 | unit | `@Roles('operator','admin')` ghi metadata trên method và trên class; `@Roles()` rỗng và `@Roles('superuser' as unknown as Role)` ném lỗi lúc khai báo. Hai lời gọi này sai kiểu nên test đặt `// @ts-expect-error` trên từng dòng (nếu không, `typecheck` đỏ trước khi chạy tới khẳng định) | — |
| TC-51-06 | DoD #1 | unit | Guard: metadata `undefined` (route không `@Roles`) → cho qua kể cả `request.user` rỗng. Metadata hỏng đặt bằng `SetMetadata(ROLES_KEY, …)`: `[]`, chuỗi `'admin'`, `['superuser']`, `[1]` → mỗi cái 403 `FORBIDDEN`, handler không chạy (fail closed) | `FORBIDDEN` |
| TC-51-07 | DoD #1 | unit | Guard: vai trò khớp → `true`; vai trò lệch → `HttpException` 403 với `errorCode FORBIDDEN`, body không chứa vai trò đang có hay cần | `FORBIDDEN` |
| TC-51-08 | DoD #1 | unit | Guard với `Reflector` thật: `@Roles` method thay `@Roles` class | `FORBIDDEN` |
| TC-51-09 | DoD #1, #3 | unit | Guard: route có `@Roles` mà `request.user` rỗng (route `@Public`) → 401 `UNAUTHENTICATED` | `UNAUTHENTICATED` |
| TC-51-10 | DoD #3 | unit | Guard: `request` có `headers.x-role=admin`, `body.roles=['admin']`, `query.role=admin` nhưng `user.groups=[]` → 403 trên route `admin` | `FORBIDDEN` |
| TC-51-11 | DoD #2 | unit | `@CurrentUser` trả đúng `{userId, sub, roles}` (không `claims`, không `groups`), `roles` suy từ `groups`, đối tượng mới mỗi lần | — |
| TC-51-12 | DoD #2, #3 | unit | `@CurrentUser` bỏ qua `body.roles` và header giả; không có `request.user` → 401 | `UNAUTHENTICATED` |
| TC-51-13 | DoD #2 | unit | Tạo mới `identity/index.spec.ts` (`import * as publicApi from '@modules/identity'`; chưa có kiểm tra export nào cho module này): có các giá trị `Roles`, `RolesGuard`, `CurrentUser`, `ROLES`, `rolesFromGroups`; kiểu `Role`, `CurrentUserInfo` kiểm lúc biên dịch bằng phép gán (`typecheck` đỏ nếu mất) | — |
| TC-51-14 | hạ tầng | e2e (`AppModule` thật, `APP_ROLE=api`, Postgres thật) | App khởi động được (provider của `RolesGuard` resolve); `GET /v1/identity/me` không token vẫn 401 `UNAUTHENTICATED` (không phải 403); `app.get(ApplicationConfig).getGlobalGuards()` ánh xạ `constructor.name` được đúng `['JwtAuthGuard','RolesGuard']` (thứ tự đã chứng minh bằng hành vi ở TC-51-19). Role `worker` không có HTTP nên không đăng ký (đã có `runsHttp`, `app-role.spec.ts`) | `UNAUTHENTICATED` |
| TC-51-15 | DoD #1, #4 | e2e | Ma trận 4 vai × 4 endpoint mẫu: đường chéo 200, 12 ô còn lại 403, `content-type` problem+json, `status` 403, có `correlationId`, bộ đếm handler **không tăng** ở mọi ô 403 (gồm admin vào endpoint operator: không phân cấp) | `FORBIDDEN` |
| TC-51-16 | DoD #1, #4 | e2e | `/staff` (`operator`+`admin`): operator 200, admin 200, customer 403, auditor 403 | `FORBIDDEN` |
| TC-51-17 | DoD #1, ADR-06 | e2e | Token nhiều nhóm `["operator","auditor"]`: `/operator` 200, `/auditor` 200, `/admin` 403, `/customer` 403 | `FORBIDDEN` |
| TC-51-18 | ADR-06 | e2e | Token không nhóm và token chỉ nhóm lạ: `/customer` 200, `/operator` 403; `/whoami` trả `roles ["customer"]` | `FORBIDDEN` |
| TC-51-19 | DoD #1 | e2e | Thứ tự guard: không token vào `/operator` → 401 `UNAUTHENTICATED` (không phải 403); token hết hạn → 401 `TOKEN_EXPIRED`; bộ đếm không tăng | `UNAUTHENTICATED`, `TOKEN_EXPIRED` |
| TC-51-20 | DoD #1 | e2e | `/any` (không `@Roles`): cả 4 vai và token không nhóm đều 200, không token 401; `/public` 200 không token; `/public-roles` không token → 401; `/public-roles` với **token admin hợp lệ** cũng → 401, bộ đếm không tăng (chứng minh `RolesGuard` chỉ tin `request.user`, không tự đọc header `Authorization`) | `UNAUTHENTICATED` |
| TC-51-21 | DoD #1 | e2e | Controller cấp lớp `@Roles('operator')`: route kế thừa cho operator 200, admin 403; route `@Roles('admin')` của cùng controller cho admin 200, operator 403 | `FORBIDDEN` |
| TC-51-22 | DoD #3 | e2e (security) | Token khách + header `X-Role`, `X-User-Roles`, `X-Cognito-Groups`, `X-Forwarded-Groups` = `admin`, body (`role`, `roles`, `cognito:groups`), query `?role=admin`, cookie `role=admin`: `/admin` và `POST /echo-admin` đều 403, bộ đếm không tăng; `/whoami` vẫn `["customer"]` | `FORBIDDEN` |
| TC-51-23 | DoD #3 | e2e (security) | Token khách đổi payload sang `admin` giữ chữ ký → 401; token ký khóa lạ mang nhóm `admin` → 401; ID token mang nhóm `admin` → 401; bộ đếm không tăng | `UNAUTHENTICATED` |
| TC-51-24 | DoD #2 | e2e | `/whoami`: JSON có đúng ba khóa `userId`, `sub`, `roles`; `userId` là giá trị `IdentityService` trả cho `sub` đó | — |
| TC-51-25 | bảo mật | e2e (security) | Mọi 403 của TC-51-15: body không chứa tên vai trò đang có, vai trò cần, `groups`, `claims` hay chữ ký token | `FORBIDDEN` |
| TC-51-26 | DoD #1 | e2e | Sau `configureHttpApp` gọi `setupSwagger(app)`; `GET /docs-json` có `x-roles` và response `403` trên các route mẫu có `@Roles`, và **không** có 403 trên `/any` | — |
| TC-51-27 | DoD #1 (giảm rủi ro mặc định "thiếu `@Roles` = mọi vai", §2.2) | e2e | Duyệt mọi route của `AppModule` thật (không tính module mẫu): mỗi route có `@Public` hoặc `@Roles`, hoặc nằm trong danh sách cho phép viết rõ trong test (kèm lý do từng route; hiện chỉ có `GET /v1/identity/me`). Route có **cả** `@Public` và `@Roles` cũng đỏ. Cách liệt kê route: `DiscoveryService.getControllers()` + `MetadataScanner` để lấy method gốc của từng controller (stack router của Express chỉ giữ proxy của Nest nên không đọc được metadata). Chứng minh bằng đột biến ngay trong test, mỗi cái khôi phục trong `try … finally`: (a) xóa `identity/me` khỏi danh sách cho phép thì test đỏ; (b) `@Public()` của `HealthController` đặt ở cấp **lớp**, nên `deleteMetadata` trên handler vô tác dụng: dùng `Reflect.deleteMetadata(IS_PUBLIC_KEY, HealthController)` trên **lớp**, hoặc `Reflect.defineMetadata(IS_PUBLIC_KEY, false, handler)` trên handler (`getAllAndOverride` dừng ở giá trị khác `undefined`), rồi test đỏ | — |
| TC-51-28 | DoD #2 | db (Postgres thật) | `/whoami` qua `IdentityService` thật: `userId` bằng `users.id` của `cognito_sub` trong DB, cho cả bốn vai; gọi lại vẫn cùng `userId` | — |
| TC-51-29 | DoD #3 | e2e (security) | Token **ký thật** mang `cognito:groups` sai kiểu: `"admin"`, `{"0":"admin","length":1}`, `[["admin"]]`, `["admin "]`, `["ADMIN"]`: `/admin` và `/operator` đều 403, bộ đếm không tăng, `/whoami` trả `["customer"]` (đi qua verifier và `JwtAuthGuard` thật, không dựng `request.user` tay) | `FORBIDDEN` |
| TC-51-30 | bảo mật, FR-AUD-02 (một phần) | unit | Mỗi 403: đúng một dòng log `warn` có `userId`, method, mẫu route (`request.route.path`), vai trò route yêu cầu và `roles` của người gọi; dòng log không chứa chuỗi token, `sub`, `groups`, `claims`, và **không chứa query string** (request `?role=admin&x=secret` → dòng log không có `secret`). Cho qua (200) và 401 không ghi dòng này | `FORBIDDEN` |
| TC-51-31 | bảo mật, FR-AUD-02 (một phần) | e2e (security) | Ở TC-51-30 `request.route` do test tự gán nên chưa chứng minh được gì về query. Trên app thật (Express gán `req.route`): `jest.spyOn(Logger.prototype, 'warn')`, token khách gọi `GET /v1/sample/admin?role=admin&x=secret` → đúng một lần `warn` của `RolesGuard`, trường route là `/v1/sample/admin`, không có chuỗi `secret` hay `x=` ở bất kỳ đối số nào. Thêm một ca unit: `request.route` là `undefined` → ghi `(unknown route)`, không ghi `url` | `FORBIDDEN` |
| TC-51-32 | DoD #5 | quy trình | PR merge vào `main`, CI xanh, Dev review, bảng «Đối chiếu test case» điền đủ | — |

**Bảng bảo mật** (`testing.md`): guard đúng vai trò trên endpoint → TC-51-15..18, 21. Chống giả mạo vai trò → TC-51-10, 12, 22, 23, 29. Lỗi không lộ nội bộ → TC-51-25, 30. Kiểm sở hữu (404): không áp dụng ở đây, thuộc service từng module. Ghi audit `DENIED`: **chưa làm**, đã có dòng log `warn` (TC-51-30); phần còn lại thành `BL-132` (§2.6). Idempotency, fraud flag, SQL tham số, TLS: không áp dụng (task không chạm).

## 5. Test thủ công

Script `backend/src/scripts/manual-smoke.dbs51.ts` (tạo ở Phase 4, theo mẫu `manual-smoke.dbs50.ts` và `manual-smoke.dbs52.ts`): chạy `AppModule` thật (`APP_ROLE=api`) trên PostgreSQL docker compose, ghép một module mẫu có các endpoint `@Roles`, JWKS giả trong RAM (chưa có `auth:dev-token` của DBS-53). Script in từng bước, **không in token**. Token ký bằng khóa tạo mới mỗi lần chạy.

Điều kiện chạy: `docker compose up -d` (máy này kèm file override cổng 5433, xem §1). **Dùng database dùng một lần** như DBS-52 (volume giữ dòng `users` và `dbs_api` không có `DELETE`): `docker compose exec postgres psql -U banking -d postgres -c "DROP DATABASE IF EXISTS dbs51_manual" -c "CREATE DATABASE dbs51_manual"`, rồi `DATABASE_URL=postgres://banking:banking_local_only@localhost:<cổng>/dbs51_manual npm run migration:run`; chạy script với cùng `DATABASE_URL` và `REDIS_URL=redis://localhost:6379` (bắt buộc: `AppModule` kiểm env lúc khởi động và không đọc file `env/.env.*`). Bốn `sub` của bốn vai là **UUID cố định, in ra** (để M-51-10 chạy lại cùng `userId`); `sub` của M-51-09 là `randomUUID()` mới mỗi lần (phải chưa từng thấy). Lệnh từ `backend/`: `DATABASE_URL=… REDIS_URL=… npx ts-node -r tsconfig-paths/register src/scripts/manual-smoke.dbs51.ts main` (và chế độ `outage` cho M-51-09). Mỗi lệnh ghi thêm vào `manual-test.txt` bằng `2>&1 | tee -a`.

Cách script dựng app (vì dùng `AppModule` thật, `authConfig` lấy từ env): đặt `NODE_ENV=test`, `APP_ROLE=api`; mở JWKS giả trong RAM trước; đặt `COGNITO_ISSUER=http://127.0.0.1:<cổng>`, `COGNITO_CLIENT_ID`, `COGNITO_USER_POOL_ID`; **sau đó** mới `import('../app.module')` (đúng kỹ thuật của `app-guard.e2e-spec.ts`). Sau `configureHttpApp` script gọi thêm `setupSwagger(app)`, vì `configureHttpApp` không gắn `/docs-json`. Controller mẫu **viết ngay trong file script** (như `manual-smoke.dbs52.ts` tự dựng module của nó), **không import gì từ `test/`**: `tsconfig.json` không có `rootDir`, một file trong `src/` import `test/` sẽ kéo `test/` vào bản build, đổi đầu ra thành `dist/src/main.js` trong khi Dockerfile chạy `node dist/main.js`. Script gọi bằng `fetch`, mà `fetch` của Node ném `TypeError` với `GET` có body: body chỉ gửi ở `POST /echo-admin`, còn `GET` mang giả mạo qua header, query và cookie. Mọi `sub` của chế độ `main` là UUID cố định và được in ra.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-51-01 | Khởi động script, đọc `GET /docs-json` | Các route mẫu có `x-roles` và response 403 |
| M-51-02 | Đường thành công: mỗi vai gọi endpoint đúng vai của mình | 4 lần 200; `/whoami` hiện `{userId, sub, roles}` đúng vai |
| M-51-03 | Ma trận từ chối: mỗi vai gọi 3 endpoint còn lại (12 lần) | Cả 12 lần 403 `FORBIDDEN`, `application/problem+json`; bảng đếm handler không tăng |
| M-51-04 | Token không nhóm gọi `/customer`, `/operator`; token nhiều nhóm gọi `/operator`, `/auditor`, `/admin` | 200 / 403; 200 / 200 / 403 |
| M-51-05 | Token khách kèm header `X-Role: admin`, cookie `role=admin`, `?role=admin`, gọi `GET /admin`; rồi `POST /echo-admin` kèm thêm body `{"roles":["admin"]}` (chỉ POST mới có body) | 403, bộ đếm không tăng; `/whoami` vẫn `["customer"]` |
| M-51-06 | Token khách bị sửa payload thành `admin`, và token ký bằng khóa khác | 401 `UNAUTHENTICATED` |
| M-51-07 | Không token và token hết hạn gọi `/operator` | 401 `UNAUTHENTICATED` / 401 `TOKEN_EXPIRED` (không phải 403) |
| M-51-08 | `docker compose -f docker-compose.yml -f ~/dbs-51-compose-override.yml exec postgres psql -U banking -d dbs51_manual -c "SELECT id, cognito_sub FROM users WHERE cognito_sub IN (…)"` rồi so với `userId` ở M-51-02 | `users.id` trùng `userId` cả bốn vai |
| M-51-09 | Chế độ `outage` (theo M-52-08): script dừng chờ Enter; `docker compose … stop postgres`, **đợi 35 giây** (qua `idleTimeoutMillis` 30 giây của pool, nếu không kết quả phụ thuộc kết nối cũ), nhấn Enter để gọi `/operator` bằng `sub` chưa từng thấy; `docker compose … start postgres`, gọi lại. Bước này chỉ thử đường `JwtAuthGuard` → `IdentityService` (DBS-52) đứng trước `RolesGuard`: lỗi DB không được biến thành 401 hay 403 | 503 `SERVICE_TEMPORARILY_UNAVAILABLE` kèm `Retry-After: 5`; **500 là lỗi cần điều tra, không phải đạt**; sau khi bật lại 200 |
| M-51-11 | Token ký thật mang `cognito:groups` là chuỗi `"admin"`, rồi `["admin "]`, gọi `/admin` | 403 `FORBIDDEN`; `/whoami` trả `["customer"]` |
| M-51-12 | Mặc định "không `@Roles`": gọi `/any` lần lượt bằng token 4 vai, token không nhóm, và không token; rồi `/public-roles` bằng token admin | `/any`: 200 ×5 rồi 401; `/public-roles` với token admin: 401 `UNAUTHENTICATED`. Đây là hành vi G2 câu 2 xin duyệt lại, nên cần thấy tận mắt |
| M-51-13 | Chạy script với `NO_COLOR=1` (ConsoleLogger tô màu ANSI nên grep theo chữ có thể trượt) và gộp `2>&1`; lọc theo context `[RolesGuard]`. Dòng `warn` của Nest ra **stdout**, và `JwksVerifierService` cũng ghi `warn` ở M-51-06/07, nên không lọc theo stream hay theo mức `warn`. Script in dấu phân cách theo từng bước | Đúng một dòng `[RolesGuard]` cho mỗi lần 403: M-51-03 có 12, M-51-04 có 2, M-51-05 có 2, M-51-11 có 2, tổng **18**. Mỗi dòng có `userId`, mẫu route, vai trò yêu cầu, `roles` người gọi; không có token, `sub`, `groups` hay chuỗi query |
| M-51-14 | `npm run build` từ `backend/` rồi `ls dist/main.js` | Build thành công, có `dist/main.js` (không phải `dist/src/main.js`): script thủ công không kéo `test/` vào build |
| M-51-10 | Chạy lại `main` ở tiến trình mới (khóa mới, cache rỗng) trên cùng DB. So `main` với `main`: ghi `count(*)` của `users` sau lần chạy đầu, chế độ `outage` (M-51-09) chạy **sau** M-51-10 hoặc trên DB khác vì nó thêm một dòng | Cùng `userId`, `count(*)` không đổi và cùng kết quả ma trận |

## 6. Domain review (AI)

Trần **3 vòng** (quy tắc của người dùng; file skill chưa sửa). Vòng 2 trở đi reviewer không được đọc §6 và `screenshots/DBS-51/` để khỏi bị neo vào kết quả trước.

### Vòng 1

**Reviewer:** subagent, model `opus`, 2026-11-02 · **Kết quả:** 10 phát hiện (blocking 0, should-fix 5, minor 5), verdict REVISE · [trả lời nguyên văn](screenshots/DBS-51/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | Script §5 không chạy được với lệnh ghi: `AppModule` cần `REDIS_URL` và `COGNITO_*` trong env trước khi import; `/docs-json` cần `setupSwagger` | đã sửa §5: `REDIS_URL` trong lệnh, thứ tự dựng JWKS → đặt env → `import('../app.module')`, gọi `setupSwagger` |
| 2 | should-fix | FR-AUD-02 và docs/03 §6.4 đòi nhật ký khi bị từ chối quyền; thiết kế chỉ hoãn sang §8 rỗng, không có điểm móc | một phần: thêm dòng log `warn` mỗi 403 (§2.2) + TC-51-30; `RolesGuard` là chỗ duy nhất để DBS-56 gọi `AuditService`. **Không** dựng cổng `DenialRecorder` không có người dùng. Phần còn lại thành `BL-132` ở Phase 5 (G2 câu 3) |
| 3 | should-fix | Mặc định "thiếu `@Roles` = mọi vai" nguy hiểm; TC-51-27 đang có điều kiện; §2.2 tham chiếu "câu hỏi 2" không tồn tại | đã sửa: TC-51-27 vô điều kiện (danh sách cho phép viết rõ trong test, có đột biến chứng minh); §2.2 trỏ tới G2 câu 2; không đổi mặc định đã duyệt ở G1 |
| 4 | should-fix | §1 ghi sai "`groups` luôn là mảng": `?? []` chỉ thay `null`/`undefined`, chuỗi hoặc đối tượng giống mảng lọt tới guard | đã sửa §1; §2.1 bắt buộc `Array.isArray` + `typeof` + `ROLES.includes`; TC-51-04 mở rộng, thêm TC-51-29 (token ký thật), M-51-11 |
| 5 | should-fix | M-51-09 thiếu bước đợi 35 giây quá `idleTimeoutMillis`; lệnh `docker compose` thiếu file override | đã sửa M-51-08 và M-51-09 theo M-52-08 (500 là lỗi, không phải đạt) |
| 6 | minor | `/public-roles` chưa thử với token admin hợp lệ | đã sửa TC-51-20 |
| 7 | minor | TC-51-14 chưa nêu cách quan sát thứ tự `APP_GUARD` | đã sửa: `getGlobalGuards()` ánh xạ `constructor.name`; thứ tự chứng minh bằng hành vi ở TC-51-19 |
| 8 | minor | Đặt T21 "Đã kiểm" vượt DBS-159 | đã sửa §3: "Đã kiểm một phần (DBS-51)" |
| 9 | minor | docs/03 §7.1 thiếu `UNAUTHENTICATED`, `TOKEN_EXPIRED` | đã sửa §3: thêm cả hai dòng cùng dòng `FORBIDDEN` trong PR này |
| 10 | minor | `identity/me` có `@UseGuards(JwtAuthGuard)` cấp method nên verify và `resolveUserId` hai lần; `BL-030` đã cũ | không sửa (thuộc chủ DBS-50, tránh kéo PR ra ngoài phạm vi): ghi ở §3, thành `BL-133` ở Phase 5 |

### Vòng 2

**Reviewer:** subagent, model `opus`, 2026-11-02, bị cấm đọc §6 và `screenshots/DBS-51/` · **Kết quả:** 11 phát hiện (blocking 0, should-fix 6, minor 5), verdict REVISE · [trả lời nguyên văn](screenshots/DBS-51/domain-review-round2.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| R2-1 | should-fix | Guard chưa định nghĩa metadata có nhưng hỏng (`[]`, không phải mảng, tên lạ): code `!required?.length` sẽ cho qua; chưa có tên khóa metadata | đã sửa §2.2: fail closed bằng 403, chỉ `undefined` là "không `@Roles`", hằng `ROLES_KEY`; TC-51-06 thêm bốn ca metadata hỏng |
| R2-2 | should-fix | Dòng log 403 không ghi `roles` của người gọi, trong khi roles không lưu ở đâu khác và `audit_log.actor_role` là `NOT NULL` | đã sửa §2.2 và TC-51-30: ghi `roles` đã suy ra; vẫn cấm `sub`, `groups`, `claims`, token |
| R2-3 | should-fix | "đường dẫn route" có thể thành `request.url` kèm query string | đã sửa §2.2: dùng `request.route?.path`; TC-51-30 kiểm query không xuất hiện |
| R2-4 | should-fix | Ca "không token" không chứng minh thứ tự guard (cả hai thứ tự đều 401 `UNAUTHENTICATED`) | đã sửa §3: bằng chứng thứ tự là TC-51-19 (token hết hạn ra `TOKEN_EXPIRED`), TC-51-15 và `getGlobalGuards()` |
| R2-5 | should-fix | §5: `sub` cố định cho M-51-10, `sub` mới cho M-51-09, và DB dùng một lần chưa được nêu | đã sửa §5: DB `dbs51_manual` dùng một lần như DBS-52, bốn `sub` cố định in ra, `sub` M-51-09 là `randomUUID()` |
| R2-6 | should-fix | Test thủ công không quan sát dòng log 403 và mặc định "không `@Roles`" (cái G2 xin duyệt lại) | đã sửa §5: thêm M-51-12 (`/any`, `/public-roles` với token admin) và M-51-13 (đếm và kiểm các dòng log) |
| R2-7 | minor | Chưa có kiểm tra export cho `identity/index.ts` | đã sửa TC-51-13: tạo mới `identity/index.spec.ts`, kiểu kiểm lúc biên dịch |
| R2-8 | minor | Đột biến của TC-51-27 chưa nêu cách làm | đã sửa TC-51-27: xóa khỏi danh sách cho phép và `Reflect.defineMetadata/deleteMetadata` trong `try … finally`; route có cả `@Public` và `@Roles` cũng đỏ |
| R2-9 | minor | `@Roles(...ROLES)` trên `me` chỉ để thỏa TC-51-27 sẽ bị sao chép và sinh 403 không bao giờ xảy ra | đã sửa §3: `identity.controller.ts` không đổi, `GET /v1/identity/me` vào danh sách cho phép của TC-51-27 kèm lý do |
| R2-10 | minor | §4 nói "không cần bảng" nhưng e2e cần Postgres đang chạy và `setupSwagger` | đã sửa §4 (đoạn mở đầu) và TC-51-26 |
| R2-11 | minor | §1 và §2.6 mâu thuẫn về chủ của audit `DENIED` | đã sửa §1: một chủ (DBS-56), một điểm gọi (nhánh 403 của `RolesGuard`), một dòng `BL-132` |

### Vòng 3 (vòng cuối, trần 3 vòng)

**Reviewer:** subagent, model `opus`, 2026-11-02, bị cấm đọc §6 và `screenshots/DBS-51/` · **Kết quả:** 11 phát hiện (blocking 0, should-fix 5, minor 6), verdict REVISE · [trả lời nguyên văn](screenshots/DBS-51/domain-review-round3.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| R3-1 | should-fix | Script thủ công mà import module mẫu từ `test/` sẽ kéo `test/` vào bản build (`tsconfig` không có `rootDir`, đầu ra thành `dist/src/main.js`, Dockerfile chạy `dist/main.js`) | đã sửa §5: controller mẫu viết ngay trong script, không import `test/`; thêm M-51-14 (`npm run build` ra `dist/main.js`) |
| R3-2 | should-fix | M-51-08 truy vấn database `banking`, trong khi app chạy trên `dbs51_manual` | đã sửa M-51-08: `psql -d dbs51_manual` |
| R3-3 | should-fix | Dòng `warn` của Nest ra stdout (không phải stderr); `JwksVerifierService` cũng ghi `warn`; ConsoleLogger tô màu ANSI | đã sửa M-51-13: `NO_COLOR=1`, gộp `2>&1`, lọc theo context `[RolesGuard]` |
| R3-4 | should-fix | Số dòng log mong đợi "12 + 2" sai: M-51-04 và M-51-11 cũng sinh 403 (tổng 18) | đã sửa M-51-13: 12 + 2 + 2 + 2 = 18, script in dấu phân cách theo bước |
| R3-5 | should-fix | TC-51-30 ở lớp unit tự gán `request.route`, nên "không có query" luôn đúng và không chứng minh gì; chưa có giá trị dự phòng khi `route` vắng | đã sửa: thêm TC-51-31 (e2e trên app thật với `spyOn(Logger.prototype,'warn')`, kèm ca `route` undefined); §2.2 ghi hằng `(unknown route)` |
| R3-6 | minor | `fetch` của Node ném lỗi với `GET` có body | đã sửa M-51-05 và §5: body chỉ ở `POST /echo-admin` |
| R3-7 | minor | `@Roles()` và `'superuser' as Role` là lỗi biên dịch, làm `typecheck` đỏ | đã sửa TC-51-05: `as unknown as Role` và `// @ts-expect-error` |
| R3-8 | minor | TC-51-27: chưa nêu cách liệt kê route; `@Public()` của `HealthController` ở cấp lớp nên `deleteMetadata` trên handler vô tác dụng | đã sửa TC-51-27: `DiscoveryService` + `MetadataScanner`; `deleteMetadata` nhắm vào lớp, hoặc `defineMetadata(false)` trên handler |
| R3-9 | minor | M-51-10 khẳng định "cùng `userId`" nhưng chỉ cố định `sub` của bốn vai; M-51-09 thêm một dòng `users` | đã sửa §5: mọi `sub` của chế độ `main` cố định và in ra; so `main` với `main`, `outage` chạy sau hoặc trên DB khác |
| R3-10 | minor | T11 (Repudiation) cũng cần liên kết tới việc 403 chưa có audit | đã sửa §3: T11 thêm liên kết `BL-132` |
| R3-11 | minor | Việc bàn giao nằm rải rác, không có danh sách | đã sửa §2.6: bảng "Bàn giao dự kiến" (`BL-132`, `BL-133`, board, DBS-53) |

### Verdict cuối: REVISE (hết trần 3 vòng, không chạy vòng 4)

Hai vòng đầu không có phát hiện blocking, và vòng 3 cũng không có. **Không còn phát hiện chưa xử lý**: cả 32 phát hiện của ba vòng đều ở trạng thái *đã sửa* hoặc *chuyển bàn giao* (R1-2 một phần, R1-10 chuyển `BL-133`). Verdict vẫn ghi REVISE vì reviewer luôn tìm được điểm mới ở mỗi vòng. **Các chỗ sửa theo vòng 3 chưa được review lại** (không có vòng 4); chúng đều là chi tiết của test và kịch bản thủ công, và sẽ bị phép chạy thật ở Phase 4 kiểm chứng. Không có câu hỏi blocking nào tồn đọng cho G2 từ review.

**Quyết định ở G2 (2026-11-02):** «duyệt G2» theo đề xuất của agent cho cả 6 câu, không đổi gì: (1) thêm `ErrorCode.FORBIDDEN` (403); (2) giữ mặc định "không `@Roles` = chỉ cần token hợp lệ", giảm rủi ro bằng TC-51-27; (3) audit `DENIED` chưa làm, chỉ có log `warn`, phần còn lại là `BL-132`; (4) sửa docs/03 §7.1 thêm ba dòng (`FORBIDDEN`, `UNAUTHENTICATED`, `TOKEN_EXPIRED`), T21 "Đã kiểm một phần", T11 thêm liên kết `BL-132`; (5) board do người dùng chuyển (DBS-50 sang Done, DBS-52 sang In Review hoặc Done); (6) giữ nguyên độ dài doc.

## 7. Kế hoạch triển khai

Thứ tự: hằng và hàm thuần → decorator → lỗi + guard → `@CurrentUser` → export → nối vào `AppModule` + e2e → test Postgres thật → script thủ công → tài liệu. Test viết trước, chạy thấy đỏ đúng lý do, rồi mới viết code tối thiểu. Mọi lệnh chạy từ `backend/` với `DATABASE_URL=postgres://banking:banking_local_only@localhost:5433/banking`. Không migration (không chạm bảng nào). Không có transaction.

| Bước | File | Test viết trước | Kết quả đỏ (1 dòng, điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 0 | `docs/features/DBS-51-roles-guard-current-user.md`, `docs/features/screenshots/DBS-51/domain-review*.md` | không áp dụng (tài liệu) | không áp dụng | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(features): DBS-51 feature doc and domain review` |
| 1 | `src/modules/identity/roles.ts` (`ROLES`, `Role`, `rolesFromGroups`), `roles.spec.ts` | TC-51-01, 02, 03, 04 | đỏ vì thiếu code: `TS2307 Cannot find module './roles'` | `npx jest -c test/jest-unit.js src/modules/identity/roles.spec.ts` | `feat(identity): derive roles from cognito groups` |
| 2 | `src/modules/identity/roles.decorator.ts` (`ROLES_KEY`, `Roles`), `roles.decorator.spec.ts` | TC-51-05 | đỏ vì thiếu code: `TS2307 Cannot find module './roles.decorator'` | `npx jest -c test/jest-unit.js src/modules/identity/roles.decorator.spec.ts` | `feat(identity): add the Roles decorator` |
| 3 | `src/common/errors/error-code.enum.ts` (`FORBIDDEN`), `src/modules/identity/roles.guard.ts`, `roles.guard.spec.ts` | TC-51-06, 07, 08, 09, 10, 30, và ca unit của 31 (`route` undefined) | đỏ vì thiếu code: `TS2307 Cannot find module './roles.guard'` và `TS2339 Property 'FORBIDDEN' does not exist on type 'typeof ErrorCode'` | `npx jest -c test/jest-unit.js src/modules/identity/roles.guard.spec.ts` | `feat(identity): add RolesGuard and ErrorCode.FORBIDDEN` |
| 4 | `src/modules/identity/current-user.decorator.ts` (`CurrentUser`, `CurrentUserInfo`), `current-user.decorator.spec.ts` | TC-51-11, 12 | đỏ vì thiếu code: `TS2307 Cannot find module './current-user.decorator'` | `npx jest -c test/jest-unit.js src/modules/identity/current-user.decorator.spec.ts` | `feat(identity): add the CurrentUser decorator` |
| 5 | `src/modules/identity/index.ts`, `index.spec.ts` (mới) | TC-51-13 | đỏ vì thiếu code: `TS2305 Module '@modules/identity' has no exported member 'Role'` (và `CurrentUserInfo`, `ROLES`, `Roles`, `RolesGuard`) | `npx jest -c test/jest-unit.js src/modules/identity/index.spec.ts` rồi `npm run typecheck` | `feat(identity): export roles and current user` |
| 6 | `test/support/roles-sample.module.ts` (controller mẫu + bộ đếm, chỉ ở test), `test/roles.e2e-spec.ts` (ma trận, nhiều nhóm, không nhóm, kế thừa lớp, `/whoami`, 403 không lộ, `x-roles`) — chưa nối `RolesGuard` vào app | TC-51-15, 16, 17, 18, 21, 24, 25, 26 | đỏ vì thiếu code: `TS2307 Cannot find module './support/roles-app'`. Sau khi có module mẫu và helper, 25 test xanh ngay vì `RolesGuard` (bước 3) đã có; độ sâu được chứng minh bằng đột biến (§8) | `npm run test:e2e -- test/roles.e2e-spec.ts --forceExit` | (gộp vào bước 7) |
| 7 | `src/app.module.ts` (thêm `APP_GUARD` thứ hai `RolesGuard`, trong `httpGuardProviders`), `test/roles.e2e-spec.ts` (ca thứ tự guard, mặc định không `@Roles`, `@Public`+`@Roles`), `test/roles-app.e2e-spec.ts` (`AppModule` thật: TC-51-14, 27) | TC-51-14, 19, 20, 27 | TC-51-14 đỏ đúng lý do: `getGlobalGuards()` thiếu `RolesGuard` (`- "RolesGuard"`) cho tới khi nối vào `app.module.ts`. TC-51-19/20 nằm ở `roles.e2e-spec.ts` trên app thử đã có sẵn hai guard nên xanh ngay; độ sâu chứng minh bằng đột biến đảo thứ tự guard (24 đỏ, trong đó TC-51-19) | `npm run test:e2e -- test/roles.e2e-spec.ts test/roles-app.e2e-spec.ts --forceExit` | `feat(identity): enforce roles with a global RolesGuard` |
| 8 | `test/roles-security.e2e-spec.ts` (giả mạo header/body/query/cookie, payload sửa, khóa lạ, ID token, `cognito:groups` sai kiểu thật, log không chứa query) | TC-51-22, 23, 29, 31 (e2e) | không có đỏ trước khi viết code: hành vi đã có từ bước 3 và 7 (lần chạy đầu có 1 đỏ do lỗi của chính test: hai request supertest tạo cùng lúc nên một cổng đóng sớm, `ECONNREFUSED`). Độ sâu chứng minh bằng ba đột biến (§8) | `npm run test:e2e -- test/roles-security.e2e-spec.ts --forceExit` | `test(identity): prove roles cannot be forged` |
| 9 | `test/db/identity-roles.db-spec.ts` (`IdentityService` thật, Postgres thật) | TC-51-28 | không có đỏ trước khi viết code: `IdentityService` thật từ DBS-52 đã cấp `userId` (lần chạy đầu đỏ do kiểu của helper `.expect` trên `Promise`, lỗi của test). Độ sâu chứng minh bằng đột biến `userId` lấy từ `sub` (5 đỏ) | `npm run test:db -- test/db/identity-roles.db-spec.ts` | `test(identity): cover CurrentUser userId against Postgres` |
| 10 | `src/scripts/manual-smoke.dbs51.ts` (controller mẫu viết trong script, không import `test/`) | M-51-01…14 | không áp dụng | chạy §5 thật, ghi `docs/features/screenshots/DBS-51/manual-test.txt` | `test(identity): add DBS-51 manual smoke script` |
| 11 | `docs/03_HIGH_LEVEL_ARCHITECTURE.md` §7.1, `src/modules/identity/README.md`, `docs/security/threat-model.md` (T11, T21), `docs/BACKLOG.md` (`BL-132`, `BL-133`), `docs/features/README.md`, feature doc §8–§9, ảnh chụp | không áp dụng (tài liệu) | không áp dụng | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(identity): record DBS-51 handover` |

**Bằng chứng test thật sự bắt lỗi (đột biến, phải làm, ghi kết quả vào §8):**

| Đột biến | Test phải đỏ |
|---|---|
| `RolesGuard.canActivate` luôn `return true` | TC-51-15 (ma trận 403), TC-51-22, TC-51-29 |
| `rolesFromGroups` dùng `groups.includes` trực tiếp trên claim sai kiểu (không `Array.isArray`) | TC-51-04, TC-51-29 |
| `RolesGuard` đọc vai trò từ header `x-role` | TC-51-10, TC-51-22 |
| Đảo thứ tự hai `APP_GUARD` | TC-51-19 (`TOKEN_EXPIRED` thành `UNAUTHENTICATED`), TC-51-14 |
| Guard dùng `if (!required?.length) return true` | TC-51-06 |
| Log 403 dùng `request.url` | TC-51-31 |

**Rà soát phạm vi (plan sweep):** mọi gạch đầu dòng DoD và mọi giới hạn nêu trong docs có hàng kế hoạch hoặc dòng ngoài phạm vi.

| Nguồn | Nơi xử lý |
|---|---|
| DoD #1 `@Roles` + `RolesGuard`, 403 `errorCode` đúng, problem+json | bước 2, 3, 6, 7 |
| DoD #2 `@CurrentUser` `{userId, sub, roles}`, export qua `index.ts` | bước 4, 5, 9 |
| DoD #3 vai trò chỉ từ `cognito:groups`, test giả mạo | bước 1, 3, 8 |
| DoD #4 ma trận mỗi vai gọi endpoint vai khác | bước 6 |
| DoD #5 PR merge, CI xanh, Dev review, bảng đối chiếu | quy trình (TC-51-32), sau G4; PR template có bảng |
| ADR-06 không nhóm = `customer` | bước 1, 6 |
| `SESSION_REVOKED`, rate limit, sở hữu tài nguyên 404 | ngoài phạm vi (§1) |
| Audit `DENIED` (FR-AUD-02) | ngoài phạm vi, `BL-132` ở bước 11; log `warn` ở bước 3 |
| `identity/me` còn `@UseGuards(JwtAuthGuard)` thừa, `BL-030` cũ | ngoài phạm vi, `BL-133` ở bước 11 |
| `BL-112` (test `jwks-verifier` chập chờn) | ngoài phạm vi, giữ nguyên |
| docs/03 §7.1, README identity, threat model T11/T21 | bước 11 |

**Bản đồ file (để đối chiếu `git diff --stat` ở G4):** mới 13 (`roles.ts`, `roles.spec.ts`, `roles.decorator.ts`, `roles.decorator.spec.ts`, `roles.guard.ts`, `roles.guard.spec.ts`, `current-user.decorator.ts`, `current-user.decorator.spec.ts`, `index.spec.ts`, `test/support/roles-sample.module.ts`, `test/roles.e2e-spec.ts`, `test/roles-app.e2e-spec.ts`, `test/roles-security.e2e-spec.ts`), cộng `test/db/identity-roles.db-spec.ts` và `src/scripts/manual-smoke.dbs51.ts` (tổng 15 file mới, không kể bằng chứng `screenshots/DBS-51/*` và chính feature doc); sửa 8 file ngoài feature doc (`error-code.enum.ts`, `identity/index.ts`, `app.module.ts`, `docs/03_HIGH_LEVEL_ARCHITECTURE.md`, `identity/README.md`, `threat-model.md`, `BACKLOG.md`, `features/README.md`, feature doc này). File ngoài danh sách là lệch kế hoạch và phải qua gate phụ. `identity.controller.ts` **không** đổi.

**Rủi ro và cách lùi:**

| Rủi ro | Cách giảm hoặc lùi |
|---|---|
| `RolesGuard` đăng ký sai chỗ làm app không khởi động (`worker`, hoặc không resolve được provider) | TC-51-14 chạy `AppModule` thật; `worker` không đăng ký nhờ `runsHttp()`; bước 7 là bước duy nhất đổi hành vi toàn app nên là commit riêng, lùi bằng `git revert` commit đó |
| Thứ tự `APP_GUARD` đảo thì mọi 401 hết hạn đổi mã | TC-51-19 và `getGlobalGuards()` |
| Test e2e cần Postgres (CI có service, máy này cần cổng 5433) | dùng `DATABASE_URL` đã nêu; Docker tắt thì ghi "chưa chạy", không bỏ qua thành xanh |
| `BL-112` làm `npm test` đỏ ngẫu nhiên | chạy riêng suite `jwks-verifier` để phân biệt, ghi trong §8 |
| Sửa docs/03 §7.1 và threat model là tài liệu dùng chung | chỉ thêm dòng, không đổi nội dung đã có; xem lại bằng `git diff` trước G4 |
| Số `BL-132`, `BL-133` bị lấy trước | kiểm lại với `origin/main` ở bước 11 và đánh lại số nếu cần |

**Quyết định ở G3 (2026-11-02):** «duyệt» theo đề xuất của agent cho cả 3 câu: (1) chưa mở Draft PR, nhánh chỉ lên GitHub sau G4; (2) `BL-132` và `BL-133`, kiểm lại với `origin/main` ở bước 11; (3) Postgres cổng 5433, `--forceExit` cho e2e, `BL-112` chạy riêng để phân biệt.

## 8. Kết quả

- **Lệnh kiểm tra** (chạy lúc bàn giao, code ở `1fe0cec`, Postgres cổng 5433):

```text
npm run lint:check            exit 0
npm run typecheck             exit 0
npm test                      48 suites, 655 tests, 0 đỏ        (baseline 43/597, 1 đỏ là BL-112)
npm run test:e2e --forceExit  11 suites, 110 tests, 0 đỏ        (baseline 8/57)
npm run test:db               16 suites, 325 tests, 0 đỏ        (baseline 15/317)
skip / only / todo trong test của task: 0
```

  Thêm 5 suites và 58 test unit, 3 suites và 53 test e2e, 1 suite và 8 test db. `BL-112` (`jwks-verifier`) không đỏ lần này; chưa rõ vì sao, và mình không sửa.

- **Đối chiếu test case** (30 case tự động đạt đủ độ sâu, 1 đơn giản hóa; case quy trình chưa làm):

| ID | Test | Đạt? |
|---|---|---|
| TC-51-01 | `roles.spec.ts` › `ROLES`, không nhóm và `[]` là customer | đạt |
| TC-51-02 | `roles.spec.ts` › một nhóm, nhiều nhóm theo thứ tự cố định, không lặp | đạt |
| TC-51-03 | `roles.spec.ts` › 6 tên lạ (gồm `__proto__`, `constructor`), lẫn nhóm hợp lệ | đạt |
| TC-51-04 | `roles.spec.ts` › 10 kiểu claim sai kiểu, mảng mới mỗi lần | đạt |
| TC-51-05 | `roles.decorator.spec.ts` › metadata, method thay class, khai báo sai, `x-roles` và 403 | đạt |
| TC-51-06 | `roles.guard.spec.ts` › không `@Roles` cho qua; 4 kiểu metadata hỏng đều 403 | đạt |
| TC-51-07 | `roles.guard.spec.ts` › khớp thì qua, sai thì 403, body không nêu vai trò, không phân cấp | đạt |
| TC-51-08 | `roles.guard.spec.ts` › method thay class (`Reflector` thật) | đạt |
| TC-51-09 | `roles.guard.spec.ts` › có `@Roles` mà không có `request.user` thì 401 | đạt |
| TC-51-10 | `roles.guard.spec.ts` › header, body, query, cookie bị bỏ qua; `groups` sai kiểu | đạt |
| TC-51-11 | `current-user.decorator.spec.ts` › đúng ba khóa, không `claims`/`groups`, đối tượng mới | đạt |
| TC-51-12 | `current-user.decorator.spec.ts` › bỏ qua header/body giả; không `request.user` thì 401 | đạt |
| TC-51-13 | `identity/index.spec.ts` › giá trị lúc chạy, kiểu lúc biên dịch | đạt |
| TC-51-14 | `roles-app.e2e-spec.ts` › `getGlobalGuards()` đúng thứ tự, app khởi động, `/identity/me` không token vẫn 401 | đạt |
| TC-51-15 | `roles.e2e-spec.ts` › ma trận 16 ô (4 ô 200, 12 ô 403, handler không chạy) | đạt |
| TC-51-16 | `roles.e2e-spec.ts` › `/staff` cho đúng operator và admin | đạt |
| TC-51-17 | `roles.e2e-spec.ts` › nhiều nhóm | đạt |
| TC-51-18 | `roles.e2e-spec.ts` › không claim, `[]`, chỉ nhóm lạ là customer | đạt |
| TC-51-19 | `roles.e2e-spec.ts` › token hết hạn ra `TOKEN_EXPIRED`; không token và token rác ra `UNAUTHENTICATED` | đạt |
| TC-51-20 | `roles.e2e-spec.ts` › `/any` mọi vai; `/public`; `@Public`+`@Roles` không token và với token admin | đạt |
| TC-51-21 | `roles.e2e-spec.ts` › `@Roles` cấp class, method thay class | đạt |
| TC-51-22 | `roles-security.e2e-spec.ts` › 9 header, cookie, query, body giả; `@CurrentUser` không đổi | đạt |
| TC-51-23 | `roles-security.e2e-spec.ts` › payload sửa, khóa lạ, `alg none`, ID token, `client_id` khác | đạt |
| TC-51-24 | `roles.e2e-spec.ts` › `/whoami` đúng `userId`, `sub`, `roles` | đạt |
| TC-51-25 | `roles.e2e-spec.ts` › 12 body 403 không chứa vai trò, nhóm, claim, token, `sub` | đạt |
| TC-51-26 | `roles.e2e-spec.ts` › `/docs-json` có `x-roles` và 403, `/any` không có | đạt |
| TC-51-27 | `roles-app.e2e-spec.ts` › mọi route có `@Public`/`@Roles`/allowlist, không route nào có cả hai, đột biến trên `HealthController` | đơn giản hóa: đột biến "xóa `identity/me` khỏi allowlist" mình chạy tay (2 test đỏ, đã khôi phục), không nằm trong test; đột biến trên `HealthController` nằm trong test |
| TC-51-28 | `test/db/identity-roles.db-spec.ts` › 5 loại token, gọi lại, hai `sub` khác nhau, route `@Public` không tạo dòng (Postgres thật) | đạt |
| TC-51-29 | `roles-security.e2e-spec.ts` › 7 kiểu `cognito:groups` sai kiểu, token ký thật | đạt |
| TC-51-30 | `roles.guard.spec.ts` › một lời gọi `warn` mỗi 403, không token/`sub`/`groups`/query | đạt |
| TC-51-31 | `roles-security.e2e-spec.ts` › log trên app thử có mẫu route, không query; `roles.guard.spec.ts` › `route` vắng thì `(unknown route)` | đạt (e2e chạy trên app thử, không phải `AppModule`) |
| TC-51-32 | quy trình (PR, CI, review) | chưa làm: PR chưa mở (`BL-134`) |

- **Đột biến** (sửa code cho sai, test phải đỏ, rồi khôi phục và chạy lại xanh; `cmp` xác nhận file giống bản gốc):

| Đột biến | Test đỏ |
|---|---|
| `RolesGuard` luôn `return true` | unit 14 đỏ, e2e ma trận 19 đỏ |
| `admin` ngầm có `operator` | e2e 3 đỏ (admin vào endpoint operator) |
| `RolesGuard` tin header `x-role` | unit 4 đỏ; e2e bảo mật 3 đỏ (TC-51-22, 29) |
| `rolesFromGroups` không `Array.isArray` | unit 1 đỏ; e2e bảo mật 2 đỏ (chuỗi, đối tượng khóa theo vai trò) |
| Bỏ `ROLES.includes` ở `@Roles` | 1 đỏ (TC-51-05) |
| Metadata hỏng cho qua (`!required?.length`) | TC-51-06 (danh sách rỗng) 1 đỏ |
| Log 403 dùng `originalUrl` | unit 3 đỏ; e2e TC-51-31 1 đỏ |
| Đảo thứ tự hai guard ở app thử | 24 đỏ, gồm TC-51-19 |
| Đảo thứ tự hai guard ở `app.module.ts` | TC-51-14 đỏ |
| Bỏ `RolesGuard` khỏi `app.module.ts` | TC-51-14 đỏ |
| `@CurrentUser` lấy `roles` từ body | 1 đỏ; rò `claims` 5 đỏ; trả `undefined` thay vì 401: 1 đỏ |
| `userId` lấy từ `sub` (Postgres thật) | 5 đỏ |
| Xóa `identity/me` khỏi allowlist | TC-51-27 2 đỏ |
| Bỏ export kiểu `Role` | `index.spec` và `typecheck` (exit 2) đỏ |

- **Test thủ công** (SHA đầu `manual-test.txt` = `1fe0cec`, commit cuối đổi code; DB dùng một lần `dbs51_manual`; output thô ở [manual-test.txt](screenshots/DBS-51/manual-test.txt); chạy bằng script tạm ngoài repo để tự dừng và bật Postgres; không dùng seed SQL). Đã quét: không còn token, `Authorization`, `Bearer`, mật khẩu, ARN; còn một dòng `ls -l` có tên người dùng Windows.

| Bước | Việc làm và kết quả (rút gọn) | Kết quả |
|---|---|---|
| M-51-01 | `/docs-json`: `/admin` `x-roles=["admin"]` và có 403; `/operator` tương tự; `/any` không `x-roles`, không 403 | đạt |
| M-51-02 | 4 vai gọi endpoint của mình: 200 ×4; `/whoami` trả đúng `roles` và `userId` | đạt |
| M-51-03 | 12 ô chéo: 403 `FORBIDDEN` `application/problem+json` ×12; handler chạy trong ma trận = 0 | đạt |
| M-51-04 | không nhóm: `/customer` 200, `/operator` 403; operator+auditor: 200, 200, 403; nhóm lạ `ops`: `["customer"]` | đạt |
| M-51-05 | `X-Role`, cookie, `?role=admin`, body `roles`: `GET /admin` 403, `POST /echo-admin` 403, `/whoami` vẫn `["customer"]` | đạt |
| M-51-06 | payload sửa thành admin: 401 `UNAUTHENTICATED`; khóa ký lạ: 401; dòng `users` của kẻ giả: `null` | đạt |
| M-51-07 | không token: 401 `UNAUTHENTICATED`; token hết hạn: 401 `TOKEN_EXPIRED` | đạt |
| M-51-08 | `userId` bằng `users.id` cả 4 vai (`same=true`); `psql` trên `dbs51_manual` ra 9 dòng khớp | đạt |
| M-51-09 | dừng Postgres, đợi 38 giây, gọi bằng `sub` mới: **503** `SERVICE_TEMPORARILY_UNAVAILABLE`, `retry-after=5`; bật lại: 200 và có dòng `users` | đạt |
| M-51-10 | chạy lại `main` ở tiến trình mới: ma trận và mã trạng thái giống hệt (`diff` rỗng, không tính `userId`), `users` giữ 9 dòng | đạt |
| M-51-11 | `groups` là chuỗi `"admin"` và `["admin "]`: `/admin` 403, `/whoami` `["customer"]` | đạt |
| M-51-12 | `/any`: 200 cho 4 vai và token không nhóm, 401 không token; `/public-roles` với token admin: 401 | đạt |
| M-51-13 | 18 lần 403 ứng với 18 khối log `[RolesGuard]` (12 + 2 + 2 + 2); mỗi khối có `userId`, `method`, `route`, `requiredRoles`, `roles`; không `eyJ`, không `sub`/`groups`/`claims` | đạt, kèm lưu ý dưới |
| M-51-14 | `npm run build` ra `dist/main.js`, không có `dist/src/main.js` | đạt |

  **Lưu ý M-51-13:** mỗi lần 403 là **một** lời gọi `logger.warn`, nhưng `ConsoleLogger` của Nest in nó thành **hai** dòng vật lý (khối đối tượng, rồi dòng "Request denied"). §2.2 và §5 viết "một dòng" là nói theo lời gọi. Ở production, pino ghi một dòng JSON.

- **Phạm vi so với §7:** 16 file code và test mới (kế hoạch ghi 15), sửa 3 file code (`app.module.ts`, `error-code.enum.ts`, `identity/index.ts`); `identity.controller.ts` không đổi. Mới ngoài bản đồ: **`test/support/roles-app.ts`** (xem "Lệch" dưới). Docs sửa 5 file: danh sách ở §9.
- **Ảnh chụp** (`docs/features/screenshots/DBS-51/`): **không phải ảnh cửa sổ terminal**, mà dựng từ chính `manual-test.txt` thành trang HTML rồi chụp bằng Chrome headless; ảnh 01 đến 05 bỏ các khối `Object(5) {…}` nhiều dòng của Nest cho gọn, ảnh 06 giữ nguyên một khối thật.

![Ma trận vai trò](screenshots/DBS-51/01-role-matrix.png)
![Giả mạo bị từ chối](screenshots/DBS-51/02-forgery-refused.png)
![userId bằng users.id](screenshots/DBS-51/03-userid-equals-users-id.png)
![Nhóm sai kiểu và mặc định không @Roles](screenshots/DBS-51/04-wrong-type-groups-and-default.png)
![Mất Postgres ra 503 rồi hồi phục](screenshots/DBS-51/05-outage-503-then-recovery.png)
![Log từ chối 403](screenshots/DBS-51/06-denial-log-18-lines.png)

- **Lệch so với kế hoạch** (đã được duyệt ở G4, 2026-11-02, theo đề xuất của agent cho cả ba điểm: giữ `roles-app.ts`, chấp nhận TC-51-27 đơn giản hóa, chấp nhận ảnh dựng từ output thô):
  1. **File ngoài bản đồ §7:** `backend/test/support/roles-app.ts`, helper dựng app thử (JWKS thật, ký token, hai `APP_GUARD`) dùng chung cho `roles.e2e-spec.ts` và `roles-security.e2e-spec.ts`. Mình tạo mà **không dừng hỏi** như luật gate phụ yêu cầu; đúng ra phải ghi vào bản đồ và xin duyệt trước.
  2. `ROLES_KEY` được export thêm ở `index.ts` (§3 không liệt kê); README identity đã ghi.
  3. TC-51-19 và TC-51-20 nằm trong `roles.e2e-spec.ts` ở commit bước 6 (kế hoạch ghi bước 7). Không đổi phạm vi.
  4. TC-51-27: đột biến "xóa khỏi allowlist" chạy tay, xem bảng case.

- **Bàn giao cho vai khác** (đã thêm vào [`docs/BACKLOG.md`](../BACKLOG.md)):

| BL | Việc | Chủ |
|---|---|---|
| `BL-132` | audit `DENIED` ở nhánh 403 của `RolesGuard` (FR-AUD-02) | Dev chủ audit (DBS-56) |
| `BL-133` | `@UseGuards(JwtAuthGuard)` thừa trên `identity/me`; xóa `BL-030` đã cũ | Dev chủ DBS-50 |
| `BL-134` | DoD #5: PR merge, CI xanh, review, bảng đối chiếu | Dev chủ DBS-51 |

  Ngoài backlog: chuyển board DBS-50 (đã merge, vẫn ghi In Review) và DBS-52 do người dùng làm; agent không sửa board. `auth:dev-token` của DBS-53 sẽ thay script JWKS trong RAM khi DBS-53 xong.

## 9. Tài liệu đã cập nhật

- [`docs/03_HIGH_LEVEL_ARCHITECTURE.md`](../03_HIGH_LEVEL_ARCHITECTURE.md) §7.1: thêm `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `FORBIDDEN`.
- [`backend/src/modules/identity/README.md`](../../backend/src/modules/identity/README.md): quy tắc vai trò, `@Roles`, `RolesGuard`, `@CurrentUser`, export mới.
- [`docs/security/threat-model.md`](../security/threat-model.md): T21 "Đã kiểm phần DBS-51", T11 trỏ tới `BL-132`.
- [`docs/BACKLOG.md`](../BACKLOG.md): thêm `BL-132`, `BL-133`, `BL-134`. Không xóa dòng nào (`BL-030` thuộc DBS-50, `BL-112` không đụng).
- [`docs/features/README.md`](README.md): thêm dòng DBS-51.
