# DBS-53 · Xác thực local/test: khóa ký thử nghiệm và token mẫu từng vai trò

<!-- Tài liệu làm việc, không phải báo cáo: ưu tiên bảng hơn văn xuôi. -->

> **Status:** Implemented (sau G4, 2026-11-02) · **Vai:** Dev · **Cặp đôi review:** Dev khác (chưa chỉ định) · **Nhánh:** `feat/DBS-53-local-auth-keys` (từ `main` = `f123c9d`) · **PR:** — · **Cập nhật:** 2026-11-02

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 2, ưu tiên High, Deliverable/Demo P2, Status "In Progress". Vai board `Dev` khớp loại việc (backend code, cộng validation schema). 
- **Expect** (nguyên văn): "#6 và mọi người có token cho từng vai trò trong vài giây."
- **Thực trạng (board, nguyên văn):** "Chưa có cách tạo token để chạy local hay viết test mà không cần Cognito. Quy tắc đã chốt: khóa thử nghiệm phải bị tắt ở staging/production. [Cập nhật 11/10] ADR-06: biến AUTH_MODE=cognito|local và AUTH_LOCAL_JWKS_PATH; lệnh npm run auth:dev-keys và auth:dev-token; staging/production từ chối AUTH_MODE=local."
- **DoD** (nguyên văn):
  1. Khóa ký thử nghiệm + JWKS cục bộ chỉ bật khi môi trường là local/test; staging/production có khóa này thì app không khởi động (có test trong validation.schema.spec)
  2. Helper tạo token cho customer, operator, auditor, admin (iat, exp, sub tùy chỉnh) dùng trong test e2e
  3. backend/README hướng dẫn lấy token để thử Swagger ở local
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Thực trạng (đã kiểm bằng code):** `grep AUTH_MODE|AUTH_LOCAL_JWKS_PATH|auth:dev` trong code (`src`, `test`, `package.json`, `env/.env.example`) **không có kết quả**: chưa có gì. Chỉ có tài liệu nhắc: ADR-06 dòng "Local và test" và "Cách kiểm chứng", threat model T3, `docs/components/identity/01-concept-brief.md:28`, và hai file hướng dẫn của skill (`manual-testing.md`, `testing.md`) ghi "once merged".
- **Phụ thuộc:**

| Task | Board | Thực tế trong repo |
|---|---|---|
| DBS-50 JwtAuthGuard + JWKS | Done | **Đã có trên `main`**: `JwksVerifierService` chỉ biết `createRemoteJWKSet(cognito.jwksUri)`; `JwtAuthGuard` là `APP_GUARD` toàn cục và sau khi verify còn gọi `IdentityService.resolveUserId(sub)` (DBS-52) nên mọi endpoint có JWT đều chạm bảng `users`. |

- **Đã có gì:**
  - [`jwks-verifier.service.ts`](../../backend/src/modules/identity/jwks-verifier.service.ts): kiểm `iss` (từ `COGNITO_ISSUER`), `RS256`, `client_id` (từ `COGNITO_CLIENT_ID`), `token_use = access`, `exp`. Không có `COGNITO_ISSUER` thì mọi lần verify ném lỗi.
  - [`auth.config.ts`](../../backend/src/config/auth.config.ts), [`validation.schema.ts`](../../backend/src/config/validation.schema.ts) (đã có `isDeployed`, `COGNITO_*` bắt buộc ở staging/production), [`validation.schema.spec.ts`](../../backend/src/config/validation.schema.spec.ts).
  - [`test/support/jwks-fixture.ts`](../../backend/test/support/jwks-fixture.ts): JWKS HTTP trong RAM, dùng cho test DBS-50/51/52. `jose` ^5.10.0 đã là dependency, **không cần thêm dependency**.
  - Ba script thủ công `src/scripts/manual-smoke.dbs50|51|52.ts` tự dựng JWKS trong RAM vì chưa có `auth:dev-token`.
  - [`.gitignore`](../../.gitignore) đã chặn `*.pem` và `*.key` nhưng **chưa có thư mục khóa dev**; một file JWKS `.json` sẽ không bị chặn.
  - Người gọi (grep) của symbol sẽ đổi: `authConfig` (đọc bởi `JwksVerifierService`, `config.module.ts`, `index.ts`), `Env` / `validationSchema`. `JwksVerifierService` được dùng bởi `JwtAuthGuard`, `IdentityModule` và các spec identity.
- **Baseline** (2026-11-02, `main` = `f123c9d`, `npm ci` mới trong worktree):

| Lệnh | Kết quả |
|---|---|
| `npm run lint:check` | sạch |
| `npm run typecheck` | sạch |
| `npm test` | 48 suites, **655 test**: 654 đạt, **1 đỏ** (`jwks-verifier.service.spec.ts` › `refetches on key rotation once the cooldown has elapsed, but not before`, `fetchCount` 2 thay vì 1). Chạy riêng suite đó: 13/13 xanh. Đây là `BL-112`, đã gặp ở baseline DBS-51 |
| `npm run test:e2e` | 11 suites, **110 test** đạt (chạy lại sau khi bật Docker, xem ghi chú dưới) |
| `npm run test:db` | 16 suites, **325 test** đạt |

  Docker Desktop tắt lúc G1; agent tự bật theo cho phép ở G2. Lần chạy e2e đầu trên compose mặc định đỏ 2 suite (`app-guard`, `roles-app`) vì `password authentication failed for user "banking"`: volume `pgdata` cũ của project `dbs` có mật khẩu khác `banking_local_only`. Không phải lỗi code. Cách xử lý theo `manual-testing.md`: file compose đặt **ngoài repo** (`~/dbs-53-postgres.yml`, project `dbs53`) chạy PostgreSQL 17 riêng ở cổng 55433, `DATABASE_URL=postgres://banking:…@localhost:55433/banking`, `npm run migration:run` rồi chạy lại. Không đụng volume cũ.

- **Backlog cùng module** (`docs/BACKLOG.md`):
  - `BL-112` (test cooldown của `jwks-verifier.service.spec.ts` đỏ khi máy bận): task này sửa đúng `jwks-verifier.service.ts` và có thể thêm test vào spec đó. Đề xuất **ngoài phạm vi, giữ dòng**; test mới của DBS-53 không dùng `setTimeout` thật (câu hỏi 6).
  - `BL-133` (`@UseGuards(JwtAuthGuard)` thừa ở `identity.controller.ts`): không liên quan, ngoài phạm vi.
  - `BL-030`: đã cũ (PR #29 đã merge), thuộc chủ DBS-50, không đụng.
- **Ngoài phạm vi:**
  - Tạo user, nhóm, mật khẩu Cognito và seed nhân viên demo (#5, DBS-54, đã xong).
  - Thu hồi phiên, rate limit, audit `DENIED`.
  - Thay JWKS trong RAM của các script `manual-smoke.dbs50|51|52.ts` bằng `auth:dev-token` (câu hỏi 7).
  - Chạy được trên cloud: `AUTH_MODE=local` bị từ chối ở staging/production, không có đường nào khác.
- **Câu hỏi mở:** đã trình ở tin nhắn G1 (7 câu, mỗi câu có đề xuất).
- **Quyết định ở G1 (2026-11-02):** duyệt G1, cả 7 câu theo đề xuất: (1) đổi tên nhánh thành `feat/DBS-53-local-auth-keys` (đã đổi); (2) bật Docker Desktop rồi chạy lại baseline e2e và db (**Docker vẫn chưa chạy lúc viết G2**, xem câu hỏi 1 ở G2); (3) duyệt hai env var `AUTH_MODE`, `AUTH_LOCAL_JWKS_PATH`; (4) chế độ local giữ nguyên mọi kiểm tra, issuer và client id là hằng số; (5) khóa ở `backend/.auth-local/`; (6) helper e2e ở `test/support/dev-tokens.ts`; (7) không sửa ba script `manual-smoke`, ghi `BL-NNN` ở Phase 5.

## 2. Hành vi

Task không thêm endpoint. Nó thêm một chế độ xác minh token cho môi trường local/test, hai lệnh CLI và một helper test.

### 2.1 Cấu hình: khi nào `AUTH_MODE=local` hợp lệ

| `NODE_ENV` | `AUTH_MODE` | `AUTH_LOCAL_JWKS_PATH` | `COGNITO_*` | Kết quả |
|---|---|---|---|---|
| development, test | vắng hoặc `cognito` | vắng | như hiện tại | hợp lệ, **hành vi hiện tại không đổi** |
| development, test | `local` | có (chuỗi không rỗng) | vắng | hợp lệ |
| development, test | `local` | vắng | – | lỗi, `invalidKeys` có `AUTH_LOCAL_JWKS_PATH` |
| development, test | `local` | – | có bất kỳ biến nào | lỗi, `invalidKeys` có biến `COGNITO_*` đó |
| development, test | vắng hoặc `cognito` | **có** | – | lỗi, `invalidKeys = [AUTH_LOCAL_JWKS_PATH]` |
| **staging, production** | `local` | bất kỳ | – | **app không khởi động**, `invalidKeys` có `AUTH_MODE` |
| **staging, production** | vắng hoặc `cognito` | **có** | đủ | **app không khởi động**, `invalidKeys = [AUTH_LOCAL_JWKS_PATH]` |
| staging, production | vắng hoặc `cognito` | vắng | đủ | hợp lệ (như hiện tại) |
| bất kỳ | giá trị khác (`LOCAL`, `none`, rỗng) | – | – | lỗi, `invalidKeys` có `AUTH_MODE` (so khớp phân biệt hoa thường) |

**Quy tắc Joi (viết chính xác, vì cách viết hiển nhiên sai):** `valid('cognito')` trong nhánh `then` của `when` *thêm* `cognito` vào danh sách cho phép chứ không thay thế, nên `production + AUTH_MODE=local` vẫn qua (đã chạy thử với joi 18). Dùng:

```ts
AUTH_MODE: Joi.string().valid('cognito', 'local').default('cognito')
  .when('NODE_ENV', { is: isDeployed, then: Joi.invalid('local') }),
AUTH_LOCAL_JWKS_PATH: Joi.string()
  .when('NODE_ENV', { is: isDeployed, then: Joi.forbidden(),
    otherwise: Joi.when('AUTH_MODE', { is: 'local', then: Joi.required(), otherwise: Joi.forbidden() }) }),
// COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_ISSUER: một quy tắc LỒNG, cả ba biến cùng dạng
Joi.string()/*.uri() cho ISSUER*/.when('NODE_ENV', {
  is: isDeployed,
  then: Joi.required(),
  otherwise: Joi.when('AUTH_MODE', { is: 'local', then: Joi.forbidden() }),
}),
```

Không viết hai `.when` nối tiếp cho `COGNITO_*`: đã chạy thử, ở production + `local` mà ba `COGNITO_*` đều được đặt đúng thì kiểu nối tiếp báo chính ba biến đó là lỗi (`any.unknown`), còn quy tắc lồng chỉ báo `AUTH_MODE` và `AUTH_LOCAL_JWKS_PATH`. Cả hai đều từ chối khởi động; khác nhau ở tập `invalidKeys` nên test ghim tập chính xác (TC-53-08b, TC-53-11).

Lỗi khởi động chỉ nêu **tên** biến, không in giá trị (đã có từ DBS-42: `ConfigValidationError.invalidKeys`). Ở production với `AUTH_MODE=local`, đủ ba `COGNITO_*` và có `AUTH_LOCAL_JWKS_PATH`, `invalidKeys` bằng đúng `['AUTH_MODE', 'AUTH_LOCAL_JWKS_PATH']`; nếu không đặt `COGNITO_*` thì là `AUTH_MODE` và ba `COGNITO_*` (thiếu bắt buộc). Tiến trình thoát mã khác 0 và không mở cổng.

Dockerfile đặt `NODE_ENV=production` (dòng 18); stage runtime chỉ `COPY` `node_modules`, `dist`, `package.json` (stage build thêm `src` và các `tsconfig*`, `nest-cli.json`), nên không có đường nào đưa `.auth-local/` vào image; thêm `.auth-local` vào `.dockerignore` là lớp thứ hai. ECS truyền `NODE_ENV = var.node_env`, chỉ nhận `staging` hoặc `production` (`infra/.../session/variables.tf`).

### 2.2 `JwksVerifierService` ở chế độ local

- Có `auth.local` (tức `AUTH_MODE=local`): lúc khởi tạo, đọc **một lần** file `AUTH_LOCAL_JWKS_PATH` (đường dẫn tương đối tính từ `process.cwd()`, như `loadEnv`; cwd mong đợi là `backend/`), kiểm tra, tạo `createLocalJWKSet`. **Không gọi mạng.** Đổi file cần khởi động lại app (`nest start --watch` chỉ theo dõi `src`, không khởi động lại khi `.auth-local/` đổi).
- Mọi kiểm tra sau đó **giữ nguyên** (`RS256`, `iss`, `client_id`, `token_use = access`, `exp`, `clockTolerance` 5 giây). `iss` = `LOCAL_ISSUER`, `client_id` = `LOCAL_CLIENT_ID` (hằng số trong `src/config/auth-local.ts`). Token ký bằng khóa nào khác file thì bị từ chối như bất kỳ token sai chữ ký.
- Ở chế độ local **chỉ** khóa trong file được chấp nhận: token Cognito thật bị từ chối (và ngược lại ở chế độ cognito).
- File bị từ chối khi khởi động: loader ném `ConfigValidationError(<thông báo cố định>, ['AUTH_LOCAL_JWKS_PATH'])`, vì `main.ts` chỉ ghi `invalidKeys` cho loại lỗi này (một `Error` thường chỉ ra `{"errorType":"Error"}`, không cho biết nguyên nhân). Thông báo không kèm đường dẫn hay nội dung file. Các ca bị từ chối: không tồn tại hoặc không đọc được; không phải JSON; không có mảng `keys` hoặc mảng rỗng; có khóa không phải RSA; **có thành phần khóa riêng** (`d`, `p`, `q`, `dp`, `dq`, `qi`), tránh trỏ nhầm vào JWK riêng.
- Khởi động ở chế độ local ghi một dòng `warn`: `AUTH_MODE=local: tokens signed by the local development key are accepted`.
- Không có `auth.local` và không có `jwksUri`: hành vi cũ (cảnh báo, mọi lần verify lỗi).

### 2.3 `npm run auth:dev-keys`

| Việc | Kết quả |
|---|---|
| Chạy lần đầu | Tạo `backend/.auth-local/` với `private.pem` (RSA 2048, PKCS8, quyền 0600 nếu hệ điều hành hỗ trợ) và `jwks.json` (`{"keys":[{"kty":"RSA","n":"…","e":"AQAB","kid":"<thumbprint>","alg":"RS256","use":"sig"}]}`, chỉ khóa công khai). In ra đường dẫn hai file và hai dòng cần thêm vào `env/.env.development`, **kèm nhắc phải chú thích (comment) mọi `COGNITO_*` đang có trong file đó**, vì `AUTH_MODE=local` cấm chúng. Thoát 0 |
| Chạy khi file đã có | Từ chối, **không ghi đè**, thoát 1, nêu `--force` |
| `--force` | Thay cả hai file bằng cặp khóa mới (`kid` đổi). Token cũ hết hiệu lực sau khi khởi động lại app |
| `--dir <thư mục>` | Đổi thư mục (mặc định `.auth-local`), cho test |
| `NODE_ENV` không phải `development`, `test` hay vắng (staging, production, và cả giá trị lạ như `prod`) | Từ chối (danh sách cho phép, không phải danh sách cấm), thoát 1, không ghi gì |

`kid` = JWK thumbprint (RFC 7638) của khóa công khai; tính lại được từ `private.pem` nên `auth:dev-token` không cần đọc `jwks.json`.

### 2.4 `npm run --silent auth:dev-token -- --role <vai> [--sub <s>] [--iat <epoch>] [--exp <epoch>] [--dir <thư mục>]`

- `--role` bắt buộc, một trong `customer`, `operator`, `auditor`, `admin`. Claim `cognito:groups` luôn là mảng một phần tử đúng vai đó (kể cả `customer`, tường minh).
- Mặc định: `sub = dev-<vai>` (ổn định để cùng một dòng `users` giữa các lần chạy), `iat` = giờ hiện tại, `exp = iat + 900` (bằng `ACCESS_TOKEN_TTL_SECONDS` mặc định). `iat` và `exp` là số nguyên giây epoch, tuyệt đối; token hết hạn hoặc phát hành ở quá khứ chỉ cần đặt cả hai (`iat` cũ cho các test mốc thu hồi phiên DBS-114/115).
- Hợp lệ khi: `sub` không rỗng, tối đa 128 ký tự, không ký tự điều khiển; `iat`, `exp` là số nguyên không âm; `exp > iat`. Vi phạm hoặc cờ lạ hoặc thiếu `--role`: in lỗi ra stderr, **stdout rỗng**, thoát 1.
- stdout chỉ chứa **đúng một dòng**: token. Payload:

```json
{
  "sub": "dev-operator",
  "iss": "https://dbs.local/auth",
  "client_id": "dbs-local-client",
  "token_use": "access",
  "cognito:groups": ["operator"],
  "jti": "<uuid>",
  "iat": 1793000000,
  "exp": 1793000900
}
```

  Header: `{"alg":"RS256","typ":"JWT","kid":"<thumbprint>"}`.
- Thiếu `private.pem`: thoát 1 với thông báo nêu `npm run auth:dev-keys`. `NODE_ENV` không phải `development`, `test` hay vắng: từ chối (cùng danh sách cho phép như §2.3).

### 2.5 Helper cho test e2e: `test/support/dev-tokens.ts`

`createDevTokenIssuer()` sinh cặp khóa **trong bộ nhớ** (ADR-06), trả `jwks` (để ghi file hay đưa vào `JwksFixture`) và `token(role, { sub?, iat?, exp? })` cùng quy tắc §2.4, dùng chung hàm ký với CLI (`src/scripts/dev-auth.ts`). Không có đường nào để helper tạo token cho vai ngoài bốn vai; test cần claim lạ thì tự ký như `roles-app.ts` đang làm.

### 2.6 Hướng dẫn trong `backend/README.md`

Mục mới «Token thử ở local»: `auth:dev-keys` → hai dòng env, **chú thích mọi `COGNITO_*` trong `env/.env.development`** → chạy app → `auth:dev-token` → dán vào Authorize của Swagger (`/docs`) hoặc `curl -H "Authorization: Bearer …"`; lưu ý khởi động lại app sau `--force`; cảnh báo không bao giờ đặt hai biến này ở staging/production.

### 2.7 Giới hạn đã biết

- Một token local hợp lệ vẫn đi qua `IdentityService.resolveUserId`, nên tạo dòng `users` với `cognito_sub = sub` (DBS-52); `sub` tùy chỉnh tạo thêm dòng.
- Khóa riêng nằm trên đĩa máy dev (thư mục bị gitignore). Bảo vệ ở biên là validation lúc khởi động, không phải tính bí mật của khóa: khóa đó vô dụng ở cloud vì cloud không bao giờ nạp file.

## 3. Kiến trúc

- **Vị trí:** `api` (và `both`). Worker không xác minh token. Đổi: `src/config/{validation.schema,auth.config}.ts`, `src/modules/identity/jwks-verifier.service.ts`. Mới: `src/config/auth-local.ts`, `src/scripts/dev-auth.ts` (logic), `src/scripts/dev-auth.keys.ts` và `src/scripts/dev-auth.token.ts` (hai điểm vào CLI; mọi file dưới `src/scripts/` của task này đều mang tiền tố `dev-auth`), `test/support/dev-tokens.ts`.
- **Interface mới/đổi:**
  - `Env` thêm `AUTH_MODE: 'cognito' | 'local'` và `AUTH_LOCAL_JWKS_PATH?: string`.
  - `authConfig` thêm `local?: { jwksPath: string }`. **Tùy chọn** để các giả lập `authConfig` có sẵn trong test (`roles-app.ts`, `jwks-verifier.service.spec.ts`, `identity.e2e-spec.ts`) vẫn biên dịch; sự hiện diện của `local` chính là `AUTH_MODE=local`. `cognito.issuer/clientId` = hằng số local, `cognito.jwksUri` = `undefined` ở chế độ local.
  - `src/config/auth-local.ts`: `LOCAL_ISSUER = 'https://dbs.local/auth'`, `LOCAL_CLIENT_ID = 'dbs-local-client'`.
  - `src/scripts/dev-auth.ts`: `generateDevKeys({ dir, force })`, `mintDevToken({ role, sub?, iat?, exp?, privateKeyPem })`, `parseTokenArgs(argv)`; ký bằng `jose` `SignJWT`, sinh khóa bằng `node:crypto` (`generateKeyPairSync('rsa', { modulusLength: 2048 })`), kid bằng `calculateJwkThumbprint`.
  - `package.json`: `auth:dev-keys`, `auth:dev-token` (chạy bằng `ts-node -r tsconfig-paths/register`, như `check:invariants`).
- **Người gọi (grep):** `authConfig` đọc bởi `JwksVerifierService`, `config.module.ts`, `config/index.ts` và test; thêm trường tùy chọn nên không ai phải đổi. `validateEnv` gọi bởi `ConfigModule`, `authConfig` và `test/support/invariants.ts`; `Env` thêm trường có giá trị mặc định nên không đổi chữ ký.
- **Build:** `src/scripts/dev-auth.ts` nằm trong `src/**/*` nên sẽ vào `dist/` của image production; không có khóa thì vô hại, nhưng thêm một công cụ ký token vào image không cần thiết. Thêm `src/scripts/dev-auth*.ts` vào `exclude` của `tsconfig.build.json`. CLI chạy bằng `ts-node` từ `src/`, test chạy bằng ts-jest, nên không bị ảnh hưởng. (Các `manual-smoke.dbs5x.ts` đã có trong `dist/` từ trước, không đụng.)
- **Dữ liệu:** không chạm bảng nào, không có migration. Không có ErrorCode mới.
- **Transaction:** không áp dụng (không ghi DB trong code mới).
- **Sơ đồ:**

```mermaid
flowchart LR
  subgraph dev[Máy dev - NODE_ENV development/test]
    K[auth:dev-keys] -->|private.pem + jwks.json| D[(backend/.auth-local/ gitignore)]
    D -->|private.pem| T[auth:dev-token]
    T -->|JWT RS256| C[curl / Swagger]
  end
  C -->|Bearer| G[JwtAuthGuard]
  G --> V[JwksVerifierService]
  D -->|jwks.json đọc 1 lần lúc khởi động| V
  V -->|claims| G
  E[validation.schema] -.->|staging/production + AUTH_MODE=local hoặc AUTH_LOCAL_JWKS_PATH: dừng| M[main.ts khởi động]
```

- **Thay đổi cấp hệ thống:** `docs/security/threat-model.md` T3 → *Đã kiểm* kèm link; hai bảng "chưa có" trong `references/testing.md` và `references/manual-testing.md` của skill (cả `.claude` và `.agents`); `backend/README.md`; `env/.env.example`; `docs/components/identity/01-concept-brief.md` không đổi (đã đúng). ADR-06 không đổi (đúng nguyên văn).

## 4. Test cases tự động

Không cần Docker hay PostgreSQL (không chạm DB; `IdentityService` được thay như ở `roles-app.ts`). Không có ca tiền.

| ID | Truy vết | Lớp | Given · When · Then | Kết quả mong đợi |
|---|---|---|---|---|
| TC-53-01 | DoD 1 | unit (`validation.schema.spec`) | development và test, `AUTH_MODE=local` + path, không `COGNITO_*` | hợp lệ; `AUTH_MODE='local'` |
| TC-53-02 | DoD 1 | unit | staging, `AUTH_MODE=local` + path | ném `ConfigValidationError`, `invalidKeys` chứa `AUTH_MODE` |
| TC-53-03 | DoD 1 | unit | production, `AUTH_MODE=local` + path | như TC-53-02 |
| TC-53-04 | DoD 1 | unit | staging và production hợp lệ + chỉ thêm `AUTH_LOCAL_JWKS_PATH` | `invalidKeys` đúng bằng `['AUTH_LOCAL_JWKS_PATH']` |
| TC-53-05 | DoD 1 | unit | development, `AUTH_MODE=local`, thiếu path | `invalidKeys = ['AUTH_LOCAL_JWKS_PATH']` |
| TC-53-06 | DoD 1 | unit | development, mặc định `cognito` + path | `invalidKeys = ['AUTH_LOCAL_JWKS_PATH']` |
| TC-53-07 | DoD 1 | unit | `AUTH_MODE` là `LOCAL`, `none`, rỗng | `invalidKeys` chứa `AUTH_MODE` |
| TC-53-08 | DoD 1 | unit | development, `AUTH_MODE=local` + path + `COGNITO_ISSUER` | `invalidKeys = ['COGNITO_ISSUER']` |
| TC-53-08b | DoD 1 | unit | production, `AUTH_MODE=local`, **không** đặt `COGNITO_*`, không đặt path | `invalidKeys` gồm đúng bốn khóa `AUTH_MODE`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_ISSUER` (so bằng `expect.arrayContaining` cộng kiểm độ dài 4, không phụ thuộc thứ tự); **không** có `AUTH_LOCAL_JWKS_PATH` vì chưa đặt và đang bị cấm ở deployed |
| TC-53-09 | DoD 1 | unit | không đặt `AUTH_MODE` | giá trị `cognito`; development vẫn hợp lệ không có `COGNITO_*`; production vẫn đòi `COGNITO_*`; `env/.env.example` hợp lệ **và** không bật local |
| TC-53-10 | DoD 1 | unit (`config.factories.spec`) | `authConfig` ở chế độ local và cognito | local: `local.jwksPath`, issuer/clientId là hằng số, `jwksUri` undefined; cognito: `local` undefined |
| TC-53-11 | DoD 1 (app không khởi động) | e2e, tiến trình thật (`main.ts`, theo mẫu `runMain` của `logging-bootstrap.e2e-spec.ts`) | môi trường deployed **hợp lệ đầy đủ** (từ `env/.env.example` cộng `NODE_ENV=production`, `DATABASE_SSL=true`, `REDIS_URL=rediss://…`, `TRUST_PROXY_HOPS=1`, ba `COGNITO_*`), chỉ thêm `AUTH_MODE=local`; kèm `AUTH_LOCAL_JWKS_PATH` là chuỗi dễ nhận ra | thoát khác 0; mọi dòng là JSON; `rows.find(r => r.message === 'Application startup failed')` có `invalidKeys` bằng đúng `['AUTH_MODE', 'AUTH_LOCAL_JWKS_PATH']` (quy tắc `COGNITO_*` lồng, §2.1; ba biến `COGNITO_*` được đặt đúng nên không bị báo); không khẳng định số dòng lỗi (Nest ghi thêm một dòng `ExceptionHandler`); đầu ra **không chứa** giá trị đường dẫn; không dòng nào báo đã lắng nghe |
| TC-53-12 | DoD 1 | e2e, tiến trình thật | cùng môi trường hợp lệ ở `NODE_ENV=staging`, chỉ thêm `AUTH_LOCAL_JWKS_PATH` | như TC-53-11 với `invalidKeys` bằng đúng `['AUTH_LOCAL_JWKS_PATH']`: chứng minh quy tắc mới là nguyên nhân duy nhất |
| TC-53-12b | DoD 1 | e2e, tiến trình thật | `NODE_ENV=development`, `AUTH_MODE=local`, `AUTH_LOCAL_JWKS_PATH` trỏ file không tồn tại, `APP_ROLE=api`, `DATABASE_URL` trỏ cổng từ chối kết nối (để thời gian chạy không phụ thuộc Postgres của CI; TypeORM thử lại 5 lần × 2 giây, tổng khoảng 12 giây, nằm trong timeout 25 giây của `runMain`) | thoát khác 0; dòng `Application startup failed` có `invalidKeys` bằng đúng `['AUTH_LOCAL_JWKS_PATH']`; đầu ra không chứa đường dẫn |
| TC-53-13 | DoD 2 | unit (`dev-auth.spec`) | `generateDevKeys` thư mục trống | hai file; `jwks.json` có đúng 1 khóa RSA, `kid` = thumbprint, **không** có `d/p/q/dp/dq/qi`; `private.pem` bắt đầu `-----BEGIN PRIVATE KEY-----` |
| TC-53-14 | DoD 2 | unit | chạy lần hai; rồi `force` | lần hai ném lỗi và nội dung file không đổi; với `force` `kid` đổi |
| TC-53-15 | DoD 2 | unit | `mintDevToken` cho từng vai | header `RS256` + `kid`; `cognito:groups = [vai]`; `iss`, `client_id`, `token_use` đúng; `sub = dev-<vai>`; `exp - iat = 900`; `jti` khác nhau giữa hai lần |
| TC-53-16 | DoD 2 | unit | `sub`, `iat`, `exp` tùy chỉnh | payload khớp từng giá trị (kể cả `iat` quá khứ) |
| TC-53-17 | DoD 2 | unit | vai lạ (`superadmin`, `Admin`), `exp <= iat`, `iat` thập phân hoặc âm, `sub` rỗng, `sub` 129 ký tự, `sub` có ký tự điều khiển | từng ca bị từ chối, không có token |
| TC-53-18 | DoD 2 | unit | `parseTokenArgs`: đủ cờ; thiếu `--role`; cờ lạ; giá trị thiếu | đúng với ca đủ; còn lại ném lỗi có thông điệp |
| TC-53-19 | DoD 1, 2 | unit | điểm vào CLI với `NODE_ENV` là `staging`, `production`, `prod` (giá trị lạ); và với `development`, `test`, vắng | ba giá trị đầu từ chối, không ghi file, không in token; ba giá trị sau chạy được |
| TC-53-20 | DoD 2 | unit | `mintDevToken` khi không có `private.pem` | lỗi nêu `auth:dev-keys` |
| TC-53-21 | DoD 1 | unit (`jwks-verifier.local.spec`) | verifier local với file do `generateDevKeys` tạo; token cho từng trong bốn vai | `verifyAccessToken` trả claims đúng `sub`, `cognito:groups` |
| TC-53-22 | DoD 1 | unit | token ký bằng khóa khác (issuer thứ hai) | `TokenVerificationError` |
| TC-53-23 | DoD 1 | unit | token đã hết hạn (`iat`, `exp` ở quá khứ xa) | `TokenExpiredError` |
| TC-53-24 | DoD 1 | unit | `iss` sai, `client_id` sai, `token_use = id` (ký đúng khóa) | `TokenVerificationError` cho từng ca |
| TC-53-25 | DoD 1 | unit | token `alg: none` và token HS256 ký bằng chuỗi `n` của khóa công khai | `TokenVerificationError` |
| TC-53-26 | DoD 1 | unit | file thiếu; JSON hỏng; `{}`; `{"keys":[]}`; khóa `kty: oct`; JWKS có `d` | constructor ném `ConfigValidationError` có `invalidKeys = ['AUTH_LOCAL_JWKS_PATH']` cho từng ca; thông điệp không chứa đường dẫn hay nội dung file |
| TC-53-27 | DoD 1 | unit | `local` và `jwksUri` cùng có, `JwksFixture` đếm request | `verifyAccessToken` thành công, `fetchCount = 0` |
| TC-53-28 | DoD 1 | unit | tạo verifier ở chế độ local | một dòng `warn` chứa `AUTH_MODE=local` |
| TC-53-29 | DoD 2 | e2e (`dev-auth.e2e-spec`), HTTP thật, `IdentityService` thay | bốn token từ `createDevTokenIssuer`, ghi vào file, app ở chế độ local; mỗi vai gọi 4 route mẫu | route của vai mình 200 và handler chạy; route của vai khác 403 `FORBIDDEN` và handler **không** chạy |
| TC-53-30 | DoD 2 | e2e | token với `sub`, `iat`, `exp` tùy chỉnh gọi `GET /v1/identity/me` | 200; `sub`, `claims.iat`, `claims.exp` khớp giá trị đã đặt |
| TC-53-31 | DoD 2 | e2e | token hết hạn; token ký bằng issuer thứ hai; không token | 401 `TOKEN_EXPIRED`; 401 `UNAUTHENTICATED`; 401 `UNAUTHENTICATED` |
| TC-53-32 | DoD 1 | unit (`dev-auth.spec`, đọc file) | `.gitignore` có `.auth-local/`; `.dockerignore` có `.auth-local`; `Dockerfile` không `COPY` thư mục đó và đặt `NODE_ENV=production`; `tsconfig.build.json` loại `src/scripts/dev-auth*.ts`; sau `nest build` (chạy thật trong test hoặc ở M-53-13) thư mục `dist/scripts/` không có file nào mang tiền tố `dev-auth` | đúng |
| TC-53-33 | DoD 3 | unit | `package.json` có `auth:dev-keys`, `auth:dev-token`; `backend/README.md` nhắc đủ hai lệnh, `AUTH_MODE=local`, `AUTH_LOCAL_JWKS_PATH` và `Authorize` | đúng (**đơn giản hóa**: chỉ kiểm sự hiện diện; hướng dẫn chạy được là M-53-01…06) |
| TC-53-34 | DoD 4 | quy trình | PR merge, CI xanh, Dev review, bảng đối chiếu trong PR | không kiểm được trong task; ghi `BL-NNN` |

**Bảng bảo mật** (`references/testing.md`):

| Yêu cầu | Trạng thái |
|---|---|
| Khóa local không dùng được ở cloud | TC-53-02, 03, 04, 11, 12, 32 |
| Cognito token không qua được ở chế độ local và ngược lại | TC-53-22, 27 (chỉ khóa trong file được nhận); chế độ cognito giữ nguyên test DBS-50 |
| Tấn công thuật toán (`none`, HS256 bằng khóa công khai) | TC-53-25 |
| Không lộ giá trị cấu hình/khóa trong log | TC-53-11, 26 |
| Role guard, ownership, idempotency, audit, PII, SQL | không áp dụng: task không thêm endpoint hay truy vấn |

## 5. Test thủ công

Chạy bằng Git Bash từ `backend/`, ứng dụng thật (`APP_ROLE=api`) trên PostgreSQL của docker compose, đúng `manual-testing.md`. Điều kiện: **Docker Desktop bật**, `docker compose up -d`, `npm run migration:run`; nếu cổng 5432 bị Postgres khác chiếm thì file override compose đặt ngoài repo (ghi ở §8). Token không ghi vào `manual-test.txt`: script chỉ in claim đã giải mã.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-53-01 | `npm run auth:dev-keys`; `git status --short`; `git check-ignore -v .auth-local/private.pem .auth-local/jwks.json` | tạo hai file, in hai dòng env; `git status` không hiện file mới; cả hai đường dẫn bị gitignore |
| M-53-02 | chạy lại `auth:dev-keys`; rồi `auth:dev-keys -- --force`; so `kid` trong `jwks.json` | lần hai thoát 1, file giữ nguyên; `--force` đổi `kid` |
| M-53-03 | trong `env/.env.development`: chú thích mọi `COGNITO_*` đang có, thêm `AUTH_MODE=local`, `AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json`; `npm run start:dev:api`. Trước đó thử giữ nguyên một `COGNITO_ISSUER` chưa chú thích | giữ `COGNITO_ISSUER`: app từ chối, `invalidKeys = ["COGNITO_ISSUER"]`. Sau khi chú thích: app lên; log có `warn` `AUTH_MODE=local…`; `/health/ready` 200 |
| M-53-04 | `auth:dev-token -- --role operator` giải mã header và payload (không in token) | `alg RS256`, `kid` = `kid` trong `jwks.json`, `iss`, `client_id`, `cognito:groups = ["operator"]`, `exp - iat = 900` |
| M-53-05 | `curl /v1/identity/me` với token operator; rồi `docker compose exec postgres psql -U banking -d banking -c "SELECT count(*) FROM users WHERE cognito_sub = 'dev-operator'"` (máy không có `psql` trên PATH) | 200, `sub = dev-operator`, `groups = ["operator"]`, có `userId`; đúng một dòng `users`; chạy lại token mới: vẫn một dòng |
| M-53-06 | lặp M-53-05 cho `customer`, `auditor`, `admin` | mỗi vai 200 với `groups` đúng vai |
| M-53-07 | token `--sub "nguyen-van-an"`; token `--iat <now-3600> --exp <now-1800>`; token đã đổi **ký tự đầu tiên của đoạn chữ ký** (đoạn thứ ba; ký tự cuối chỉ mang 4 bit thừa nên đổi nó có thể giải mã ra cùng chữ ký); không `Authorization` | 200 với `sub` đã đặt (dòng `users` thứ hai); 401 `TOKEN_EXPIRED`; 401 `UNAUTHENTICATED`; 401 `UNAUTHENTICATED` |
| M-53-08 | **để app tiếp tục chạy**; `auth:dev-keys -- --force`; cấp token mới; gọi `me`; rồi khởi động lại app (Ctrl+C, `npm run start:dev:api`) và gọi lại | lần đầu 401 `UNAUTHENTICATED` (app còn giữ khóa cũ trong bộ nhớ; `--watch` không theo dõi `.auth-local/`); sau khởi động lại 200 |
| M-53-09 | mở `/docs`, Authorize bằng token admin, Try it out `GET /v1/identity/me` | 200, chụp màn hình (**cần người mở trình duyệt**, nếu không có thì ghi chưa chạy) |
| M-53-10 | môi trường deployed hợp lệ đầy đủ, nạp bằng một file tạm **ngoài repo** (`export` các biến từ `env/.env.example` + `NODE_ENV`, `DATABASE_SSL=true`, `REDIS_URL=rediss://…`, `TRUST_PROXY_HOPS=1`, ba `COGNITO_*` giả): (a) control: không thêm gì; (b) `NODE_ENV=production AUTH_MODE=local`; (c) `NODE_ENV=staging AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json`; mỗi lần `node -r ts-node/register -r tsconfig-paths/register src/main.ts` | (a) qua bước validate (sau đó dừng ở kết nối DB, không liên quan); (b) thoát khác 0, `invalidKeys` có `AUTH_MODE`; (c) thoát khác 0, `invalidKeys = ["AUTH_LOCAL_JWKS_PATH"]`; không lần nào mở cổng 3000 |
| M-53-11 | xóa `jwks.json`; khởi động app; chạy `auth:dev-token` | app dừng, log JSON `invalidKeys = ["AUTH_LOCAL_JWKS_PATH"]`, không in đường dẫn hay nội dung; CLI vẫn cấp được token (chỉ cần `private.pem`); khôi phục bằng `--force` |
| M-53-12 | làm theo **đúng** mục README mới trên một thư mục `--dir` trống | các lệnh trong README chạy được nguyên văn, kể cả bước chú thích `COGNITO_*` |
| M-53-13 | `npm run build`; `ls dist/scripts` | build xanh; không có file `dev-auth*` trong `dist/` (image production không mang công cụ ký token) |

## 6. Domain review (AI)

**Vòng 1 · Reviewer:** subagent `general-purpose`, model `fable` (mạnh nhất có sẵn), 2026-11-02 · **Kết quả:** 12 phát hiện (blocking 0, should-fix 7, minor 5), verdict **REVISE** · [trả lời nguyên văn](screenshots/DBS-53/domain-review.md). Reviewer cũng xác nhận ba khẳng định nền tảng: image không thể mang `.auth-local/`; ECS chỉ truyền `NODE_ENV` là `staging` hoặc `production`; mặc định `AUTH_MODE=cognito` không làm hỏng test hay code nào đang đặt `COGNITO_*`.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | Cách viết Joi hiển nhiên (`valid('cognito')` trong `then`) cho `production + local` qua mà không lỗi | đã sửa §2.1: ghi quy tắc chính xác `Joi.invalid('local')` và quy tắc `AUTH_LOCAL_JWKS_PATH`. **Tự chạy lại**: cách sai không lỗi, cách đúng ra `"AUTH_MODE" must be [cognito]`, development vẫn nhận `local` |
| 2 | should-fix | `Error` thường từ constructor chỉ ra `{"errorType":"Error"}`, không có "thông báo cố định" | đã sửa §2.2, TC-53-26, TC-53-12b, M-53-11: ném `ConfigValidationError(…, ['AUTH_LOCAL_JWKS_PATH'])`. Đã đọc `main.ts:58-65` xác nhận |
| 3 | should-fix | M-53-08 dừng app rồi mong 401 | đã sửa: để app chạy, `--force`, 401, khởi động lại, 200 |
| 4 | should-fix | Đổi ký tự cuối chữ ký có thể không đổi chữ ký | đã sửa M-53-07: đổi ký tự đầu của đoạn chữ ký |
| 5 | should-fix | `psql` không có trên PATH | đã sửa M-53-05: `docker compose exec postgres psql …` |
| 6 | should-fix | M-53-10 và TC-53-11/12 chưa định nghĩa "phần còn lại hợp lệ", không chứng minh được quy tắc mới là nguyên nhân | đã sửa: môi trường hợp lệ đầy đủ, có bước control (a), TC-53-12 kỳ vọng đúng `['AUTH_LOCAL_JWKS_PATH']` |
| 7 | should-fix | Người đã điền `COGNITO_*` thật sẽ bị app từ chối khi thêm hai dòng | đã sửa §2.3 (CLI nhắc), §2.6 (README), M-53-03 (có bước thử giữ nguyên), M-53-12 |
| 8 | minor | Ví dụ `invalidKeys` ở §2.1 sai (mỗi biến `COGNITO_*` báo riêng) | đã sửa: bỏ ví dụ sai; TC-53-11 chỉ khẳng định phần chắc chắn, tập chính xác chốt ở bước đỏ |
| 9 | minor | Liệt kê file `COPY` của Dockerfile chưa đúng | đã sửa §2.1; TC-53-32 kiểm `NODE_ENV=production` |
| 10 | minor | Đường dẫn tính từ `process.cwd()`, không phải `backend/` | đã sửa §2.2 |
| 11 | minor | `dev-auth.ts` vào `dist/` của image | đã sửa §3: loại khỏi `tsconfig.build.json`, TC-53-32 kiểm |
| 12 | minor | CLI chỉ cấm `staging`/`production`, để lọt `prod` | đã sửa §2.3, §2.4: danh sách cho phép (`development`, `test`, vắng); TC-53-19 thêm ca `prod` |

**Vòng 2 · Reviewer:** subagent mới, cùng model, 2026-11-02 · **Kết quả:** 3 phát hiện (blocking 0, should-fix 1, minor 2), **Verdict: APPROVE** · [nguyên văn](screenshots/DBS-53/domain-review.md) (nối sau vòng 1). Reviewer tự chạy joi 18 để kiểm từng dòng bảng §2.1 và chạy thật `main.ts` để kiểm đường `ConfigValidationError` ném từ constructor; các dòng khác đều khớp.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 13 | should-fix | Quy tắc `COGNITO_*` chưa được viết; hai `.when` nối tiếp báo sai tập `invalidKeys` (báo chính các biến được đặt đúng), tập kỳ vọng "chốt ở bước đỏ" nên test nhận được cả hai | đã sửa §2.1: viết quy tắc lồng, giải thích vì sao không nối tiếp; TC-53-11 ghim `['AUTH_MODE','AUTH_LOCAL_JWKS_PATH']`; thêm TC-53-08b cho ca không đặt `COGNITO_*` |
| 14 | minor | Hai điểm vào CLI chưa đặt tên, tiền tố khác `dev-auth` thì lọt vào `dist/` | đã sửa §3: `dev-auth.keys.ts`, `dev-auth.token.ts`; TC-53-32 và M-53-13 kiểm `dist/scripts` |
| 15 | minor | Nest ghi thêm một dòng lỗi và TypeORM thử lại ~12 giây; TC-53-12b chưa đặt `DATABASE_URL` | đã sửa TC-53-11, TC-53-12b: tìm dòng `Application startup failed`, `DATABASE_URL` trỏ cổng từ chối kết nối |

Sau vòng 2 chỉ có các sửa nhỏ ở trên (không đổi phạm vi hay hành vi); không cần vòng 3. Số liệu cho G2: 15 phát hiện qua hai vòng (blocking 0, should-fix 8, minor 7), tất cả **đã sửa**, không có mục "không sửa".

**Quyết định ở G2 (2026-11-02):** duyệt G2, 5 câu theo đề xuất: (1) bật Docker Desktop trước Phase 4c, **người dùng cho phép agent tự bật Docker khi cần**; (2) giữ TC-53-33 là "đơn giản hóa"; (3) thêm `BL-NNN` cho DoD 4 ở Phase 5; (4) M-53-09 do người dùng chạy và chụp ảnh, nếu không thì "chưa chạy" để chấp nhận đích danh ở G4; (5) cập nhật các doc ngoài task, ghi vào §9.

## 7. Kế hoạch triển khai

Thứ tự: cấu hình (chặn trước) → khóa/token (thư viện) → CLI → verifier → helper và e2e → tài liệu. Không có migration, không có audit hay outbox (task không ghi DB). Mọi lệnh chạy từ `backend/`; commit kèm dòng `Co-Authored-By` theo môi trường, không `--no-verify`. Cột "Kết quả đỏ" điền khi chạy.

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `src/config/validation.schema.ts` (`Env`, `AUTH_MODE`, `AUTH_LOCAL_JWKS_PATH`, `COGNITO_*` lồng), `env/.env.example` (3 dòng chú thích, không bật local) | `src/config/validation.schema.spec.ts`: TC-53-01…09, 08b | 16 test đỏ trên 63 (TC-53-02…09: `production + local` vẫn qua); trước đó cả suite không biên dịch (`TS2339 AUTH_MODE`) | `npm test -- validation.schema` | `feat(config): AUTH_MODE and AUTH_LOCAL_JWKS_PATH, refuse local auth in staging and production (DBS-53)` (`4d10f24`) |
| 2 | `src/config/auth-local.ts` (hằng `LOCAL_ISSUER`, `LOCAL_CLIENT_ID`), `src/config/auth.config.ts` (`local?`, issuer/clientId hằng số, `jwksUri` undefined) | `src/config/config.factories.spec.ts`: TC-53-10 | không biên dịch: `TS2339 Property 'local' does not exist` trên `authConfig` (TC-53-10) | `npm test -- config.factories` | `feat(config): authConfig exposes the local auth mode (DBS-53)` (`0b72f0a`) |
| 3 | `src/scripts/dev-auth.ts` (`generateDevKeys`, `mintDevToken`, `parseTokenArgs`, danh sách cho phép `NODE_ENV`) | `src/scripts/dev-auth.spec.ts`: TC-53-13…20 | 0 test chạy: `Cannot find module './dev-auth'` (TS2307) | `npm test -- dev-auth` | `feat(auth): dev key generation and role token minting (DBS-53)` (`c62b023`) |
| 4 | `src/scripts/dev-auth.keys.ts`, `dev-auth.token.ts`, `package.json` (`auth:dev-keys`, `auth:dev-token`), `tsconfig.build.json` (exclude `src/scripts/dev-auth*.ts`), `.gitignore` (`backend/.auth-local/`), `backend/.dockerignore` (`.auth-local`) | `dev-auth.spec.ts`: TC-53-19 (điểm vào CLI), TC-53-32 | 5 đỏ trên 52: hai CLI thật, `.gitignore`, `.dockerignore`, `tsconfig.build.json`, `package.json` chưa có dòng | `npm test -- dev-auth`; `npm run build && ls dist/scripts` | `feat(auth): auth:dev-keys and auth:dev-token commands, keep keys out of git and the image (DBS-53)` (`8c6256c`) |
| 5 | `src/modules/identity/local-jwks.ts` (đọc và kiểm file, ném `ConfigValidationError`), `jwks-verifier.service.ts` (nhánh local, `warn`) | `src/modules/identity/jwks-verifier.local.spec.ts`: TC-53-21…28 | 20 đỏ (TC-53-21, 23, 26, 27, 28): verifier chưa có chế độ local nên token hợp lệ bị từ chối và file lỗi không ném gì | `npm test -- jwks-verifier` | `feat(identity): verify tokens against a local JWKS file when AUTH_MODE=local (DBS-53)` (`f8c990b`) |
| 6 | `test/support/dev-tokens.ts` (`createDevTokenIssuer`), `test/support/local-auth-app.ts` (app HTTP chế độ local, `IdentityService` thay như `roles-app.ts`; file mới để không sửa `roles-app.ts` của DBS-51) | `test/dev-auth.e2e-spec.ts`: TC-53-29…31 | 0 test chạy: `TS2307 Cannot find module './support/dev-tokens'` và `'./support/local-auth-app'` | `npm run test:e2e -- dev-auth.e2e` | `test(auth): dev token helper and role e2e on the local JWKS path (DBS-53)` (`ad13310`) |
| 7 | `test/dev-auth-bootstrap.e2e-spec.ts` (tiến trình `main.ts` thật, theo mẫu `logging-bootstrap`) | TC-53-11, 12, 12b | **không có đỏ trước** (cài đặt đã có từ bước 1 và 5). Thay bằng kiểm đột biến: đổi `Joi.invalid('local')` thành `Joi.any()` thì TC-53-11 đỏ (`Expected - 1`), đã khôi phục | `npm run test:e2e -- dev-auth-bootstrap` | `test(config): the app refuses to start with local auth outside development and test (DBS-53)` (`54a82ca`) |
| 8 | `backend/README.md` (mục «Token thử ở local», bảng lệnh, bước chú thích `COGNITO_*`), `env/.env.example` (giải thích), `src/scripts/README.md` | `dev-auth.spec.ts`: TC-53-33 | 12 đỏ (TC-53-33): chưa có mục «10. Token thử ở local» trong README | `npm test -- dev-auth` | `docs(auth): how to get a role token for Swagger at local (DBS-53)` (`7c84c94`) |
| 9 | Phase 4b/4c (không code mới): bốn lệnh kiểm tra, §5 M-53-01…13 trên commit cuối, `screenshots/DBS-53/manual-test.txt` và ảnh | tất cả TC | — | `npm run lint:check && npm run typecheck && npm test && npm run test:e2e && npm run test:db` | — |
| 10 | Phase 5: `docs/security/threat-model.md` (T3 → Đã kiểm), `.claude/` và `.agents/skills/dbs-delivering-task/references/{testing,manual-testing}.md` (đổi dòng "chưa merge"), `docs/BACKLOG.md` (dòng cho DoD 4 và cho ba script `manual-smoke`), `docs/features/README.md`, feature doc §8–§9 | `check-doc-links.mjs` | — | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(auth): record DBS-53 evidence and update dependent docs` |

**Rà soát phạm vi (plan sweep).** Mỗi file hay quy tắc nêu trong DoD, §2 và giới hạn của tài liệu có hàng hoặc dòng ngoài phạm vi:

| Nguồn | Nơi xử lý |
|---|---|
| DoD 1: khóa chỉ bật ở local/test, staging/production dừng, test trong `validation.schema.spec` | bước 1 (TC-53-01…09), 7 (tiến trình thật), 4 và 5 (khóa không vào git/image, chỉ file local) |
| DoD 2: helper bốn vai, `iat`/`exp`/`sub` tùy chỉnh, dùng trong e2e | bước 3 (`mintDevToken`), 6 (`createDevTokenIssuer`, e2e) |
| DoD 3: `backend/README` hướng dẫn Swagger | bước 8; chạy thật ở M-53-09 (người dùng) và M-53-12 |
| DoD 4: PR, CI, review | quy trình: dòng `BL-NNN` ở bước 10 |
| ADR-06 «Cách kiểm chứng», threat model T3 | bước 7 và 10 |
| §2.7 giới hạn: token local tạo dòng `users` | chấp nhận, ghi §8; M-53-05 chứng minh một dòng cho mỗi `sub` |
| §2.2 file JWKS có thành phần khóa riêng, khóa không phải RSA | bước 5 (TC-53-26) |
| `BL-112` (test cooldown thật) | ngoài phạm vi; test mới không dùng `setTimeout` thật |
| Ba script `manual-smoke.dbs50|51|52.ts` | ngoài phạm vi (G1 câu 7); dòng `BL-NNN` ở bước 10 |
| `references/testing.md`, `manual-testing.md` (cả `.claude`, `.agents`) | bước 10; hai bản đã khác nhau sẵn, chỉ sửa đúng dòng DBS-53 |
| `docs/components/identity/01-concept-brief.md`, ADR-06 | không đổi (đã đúng nguyên văn), kiểm lại ở bước 10 |

**Rủi ro và cách lùi.**

| Rủi ro | Giảm thiểu |
|---|---|
| Quy tắc Joi cho `COGNITO_*` đổi hành vi hiện có ở staging/production | bước 1 giữ nguyên toàn bộ test hiện có của `validation.schema.spec` và `env.bootstrap.spec`; TC-53-09 chặn hồi quy |
| Chế độ local lọt lên cloud | hai lớp độc lập: schema từ chối (bước 1, 7) và image không mang file (bước 4); ECS chỉ truyền `staging`/`production` |
| `ts-node` chậm hoặc in thêm ra stdout làm hỏng token | dùng `npm run --silent`; TC-53-15 và M-53-04 kiểm stdout đúng một dòng |
| Quyền 0600 không có nghĩa trên Windows | ghi là best-effort ở README; bảo vệ thật là thư mục bị gitignore |
| Test tiến trình thật chậm (~12 giây vì TypeORM thử lại) | `DATABASE_URL` trỏ cổng từ chối (TC-53-12b), timeout 25 giây |
| Đổi `authConfig` làm hỏng giả lập `authConfig` có sẵn | `local?` là trường tùy chọn; chạy lại toàn bộ `npm test` và `test:e2e` ở bước 3 và 9 |
| Chạy test chạm DB dùng chung | e2e/db dùng Postgres riêng cổng 55433 (file compose ngoài repo, §1); không đụng volume cũ |

**Lùi:** mỗi bước một commit nên `git revert` từng bước được; không có migration, dữ liệu hay hạ tầng cần hoàn tác. Dòng `users` do test thủ công tạo nằm trong Postgres riêng cổng 55433, dọn bằng `docker compose -f ~/dbs-53-postgres.yml down -v`.

**Quyết định ở G3 (2026-11-02):** duyệt G3 (trả lời «duyêht», hiểu là «duyệt»), 4 câu theo đề xuất: (1) chấp nhận file mới `test/support/local-auth-app.ts` trùng khung với `roles-app.ts`, không ghi BL; (2) **không** mở Draft PR, không push gì tới G4; (3) M-53-09 do người dùng chạy; (4) Docker chạy suốt Phase 4, hỏi trước khi tắt.

## 8. Kết quả

- **Lệnh kiểm tra** (HEAD `374e9c0`, 2026-11-02, PostgreSQL 17 riêng ở cổng 55433; output thô: [verification.txt](screenshots/DBS-53/verification.txt)):

```
npm run lint:check   exit=0
npm run typecheck    exit=0
npm test             50 suites, 770 tests passed (baseline 48 suites, 655 tests)
npm run test:e2e     13 suites, 135 tests passed (baseline 11 suites, 110 tests)
npm run test:db      16 suites, 325 tests passed (baseline: 325)
.skip/.only/.todo/xit/fit trong test của task: 0. Test bị bỏ qua: 0
```

  Một lần chạy `test:db` ở Phase 4 đỏ 1 test trong `ledger-schema.db-spec.ts` (file task không đụng). Chạy lại riêng suite đó 31/31, chạy cả `test:db` thêm hai lần 325/325 xanh. Không tái hiện lại và **chưa có nguyên nhân**, nên không coi là đã sửa. Cùng dạng với `BL-015` (lệch ~1 giây khi máy bận) nhưng mình không đọc được tên test lúc đó, nên không khẳng định là cùng một test. `BL-112` (test cooldown của verifier) không đỏ lần nào trong Phase 4.

- **Đối chiếu test case** (36 case: **34 đạt**, **1 đơn giản hóa**, **1 quy trình chưa kiểm được**):

| ID | Test | Đạt? |
|---|---|---|
| TC-53-01…07, 08, 08b, 09 | `src/config/validation.schema.spec.ts` › «AUTH_MODE=local is for development and test only» (TC-53-07 có 6 giá trị; TC-53-09 có thêm test `env/.env.example`) | đạt |
| TC-53-10 | `src/config/config.factories.spec.ts` › «authConfig (DBS-53, TC-53-10)» (2 test) | đạt |
| TC-53-11, 12, 12b | `test/dev-auth-bootstrap.e2e-spec.ts` (tiến trình `main.ts` thật; thêm ca control và kiểm đột biến, xem §7 bước 7) | đạt |
| TC-53-13, 14 | `src/scripts/dev-auth.spec.ts` › «generateDevKeys» | đạt |
| TC-53-15, 16, 17, 20 | `dev-auth.spec.ts` › «mintDevToken» (TC-53-17: 6 vai sai và 9 đầu vào sai) | đạt |
| TC-53-18 | `dev-auth.spec.ts` › «argument parsing» | đạt |
| TC-53-19 | `dev-auth.spec.ts` › «command line entry points» và «the two npm commands as real processes» (`staging`, `production`, `prod`, `Production`, `preview` bị từ chối; `development`, `test`, vắng chạy được) | đạt |
| TC-53-21 | `src/modules/identity/jwks-verifier.local.spec.ts` (4 vai) và `dev-auth.spec.ts` › «what auth:dev-keys writes is what the verifier reads» (khóa thật do `generateDevKeys` ghi) | đạt |
| TC-53-22…28 | `jwks-verifier.local.spec.ts` (TC-53-26: 7 file hỏng và 6 thành phần khóa riêng; TC-53-27 dùng một máy chủ HTTP thật, đếm request = 0) | đạt |
| TC-53-29, 30, 31 | `test/dev-auth.e2e-spec.ts` (ma trận 4×4 vai, `sub`/`iat`/`exp` tùy chỉnh, hết hạn, khóa lạ cùng `kid`, không token) | đạt |
| TC-53-32 | `dev-auth.spec.ts` › «the keys stay out of git, the image and the production build»: `.gitignore`, `.dockerignore`, `Dockerfile` (`NODE_ENV=production`, không có `auth-local`), `tsconfig.build.json`. Phần "`dist/scripts` không có `dev-auth*`" được chứng minh bằng M-53-13, không bằng test tự động (§4 đã ghi "trong test hoặc ở M-53-13") | đạt |
| TC-53-33 | `dev-auth.spec.ts` › «the README tells a developer how to get a token for Swagger» (mục 10 có đủ lệnh, biến, bước chú thích `COGNITO_*`, `Authorize`, `/docs`, bốn vai, cảnh báo staging/production) | **đơn giản hóa**: chỉ kiểm nội dung có mặt; hướng dẫn chạy được do M-53-12 |
| TC-53-34 | quy trình (merge PR, CI xanh, Dev review, bảng đối chiếu trong PR) | **chưa kiểm được**: PR chưa mở; `BL-135` |

- **Test thủ công** (§5; Git Bash, `APP_ROLE=api` thật, PostgreSQL 17 cổng 55433; output thô và SHA ở [manual-test.txt](screenshots/DBS-53/manual-test.txt), dòng đầu `7c84c94`). Token và khóa không ghi vào file, chỉ ghi claim đã giải mã. Lần chạy đầu của M-53-04 hỏng vì **script giải mã của mình** tách token sai, không phải token (M-53-05/06 chứng minh app nhận token); đã chạy lại, cả hai lần đều nằm trong file.

| Bước | Kết quả thật | |
|---|---|---|
| M-53-01 | `auth:dev-keys` tạo `private.pem` và `jwks.json` (1 khóa RSA, 0 thành phần riêng); `git status` không hiện file; `git check-ignore` báo `.gitignore:19:backend/.auth-local/` cho cả hai | đạt |
| M-53-02 | lần hai: thoát 1, file giữ nguyên; `--force`: thoát 0, `kid` đổi | đạt |
| M-53-03 | giữ `COGNITO_ISSUER`: app dừng, `invalidKeys":["COGNITO_ISSUER"]`; chú thích rồi chạy: log `warn AUTH_MODE=local…`, `/health/ready` 200 | đạt |
| M-53-04 | stdout 1 dòng; `alg RS256`, `typ JWT`, `kid` bằng `kid` trong `jwks.json`, `cognito:groups ["operator"]`, `exp - iat = 900` | đạt |
| M-53-05, 06 | `GET /v1/identity/me` cho cả bốn vai: 200, `groups` đúng vai; trước đó 0 dòng `dev-%` trong `users`, sau đó mỗi `sub` đúng **một** dòng dù `dev-operator` được gọi hai lần (psql qua `docker compose exec`) | đạt |
| M-53-07 | `--sub nguyen-van-an`: 200, có dòng `users` mới; hết hạn 30 phút: 401 `TOKEN_EXPIRED`; đổi ký tự đầu chữ ký: 401 `UNAUTHENTICATED`; không header: 401 `UNAUTHENTICATED` | đạt |
| M-53-08 | app vẫn chạy, `--force`, token mới: 401 `UNAUTHENTICATED`; khởi động lại: 200 | đạt |
| **M-53-09** | Swagger Authorize trên trình duyệt: agent không điều khiển được trình duyệt (G2 đã chốt bạn chạy). Chứng cứ gần nhất: M-53-12 cho thấy `/docs` trả 200 và token trong `Authorization: Bearer` được nhận | **chưa chạy** (cần người) |
| M-53-10 | deployed hợp lệ: (a) control qua validate rồi dừng ở `ECONNREFUSED` (DB giả); (b) `production + AUTH_MODE=local`: `invalidKeys:["AUTH_MODE"]`, thoát 1; (c) `staging + AUTH_LOCAL_JWKS_PATH`: `invalidKeys:["AUTH_LOCAL_JWKS_PATH"]`, thoát 1; cổng 3054 không mở | đạt |
| M-53-11 | xóa `jwks.json`: app dừng, `invalidKeys:["AUTH_LOCAL_JWKS_PATH"]`, output không chứa `auth-local`; `auth:dev-token` vẫn cấp được token; khôi phục bằng `--force` | đạt |
| M-53-12 | làm đúng mục README mới từ trạng thái không có `.auth-local/`, bằng `npm run start:dev:api` ở cổng 3000: `/v1/identity/me` 200; `/docs` 200 | đạt |
| M-53-13 | `npm run build` xanh; `dist/scripts` chỉ có ba `manual-smoke`, 0 file `dev-auth*` | đạt |

- **Phạm vi so với §7** (`git diff --stat main...HEAD`: 23 file trước commit doc): mọi file nằm trong §7, không có file ngoài danh sách. `src/scripts/dev-auth.ts` export thêm `newDevKeyPair`, `signDevToken`, `buildAccessTokenClaims`, `DevAuthError` (§3 chỉ kể ba hàm chính; hai điểm vào CLI và helper test cần chúng).
- **Ảnh chụp** (ảnh transcript dựng từ chính `manual-test.txt`, không phải ảnh màn hình trình duyệt):

![M-53-01 sinh khóa và gitignore](screenshots/DBS-53/01-keys-and-gitignore.png)
![M-53-05/06 token từng vai](screenshots/DBS-53/02-token-per-role.png)
![M-53-07 từ chối và hết hạn](screenshots/DBS-53/03-reject-and-expire.png)
![M-53-10 môi trường deployed bị từ chối](screenshots/DBS-53/04-deployed-env-refused.png)
![M-53-12 làm theo README](screenshots/DBS-53/05-readme-verbatim.png)

  **Thiếu:** ảnh Swagger Authorize (M-53-09).

- **Lệch so với kế hoạch** (chưa được duyệt, chờ G4):
  1. **SHA test thủ công.** `manual-test.txt` ghi `7c84c94`, HEAD là `374e9c0`. Commit `374e9c0` chỉ thêm test tự động (`dev-auth.spec.ts`, `jwks-verifier.local.spec.ts`); `git diff --name-only 7c84c94..HEAD -- backend ':!*.spec.ts'` rỗng, nên mã ứng dụng và CLI không đổi. Mình **không** chạy lại §5 vì không file chạy được nào đổi. Người duyệt quyết định chấp nhận hay yêu cầu chạy lại.
  2. **Thêm một test không có trong §7:** vòng đi–về `generateDevKeys` → file → `JwksVerifierService` (mở rộng TC-53-21, commit `374e9c0`). Lý do: spec của verifier không được import `src/scripts` (luật ranh giới module), nên chưa test nào ghép khóa do CLI thật ghi với verifier thật. Nằm trong hai file đã có ở §7.
  3. **Bước 7 không có đỏ trước** (xem §7), thay bằng kiểm đột biến.
  4. **Thêm ca control** (môi trường deployed hợp lệ, không thêm biến local) vào `dev-auth-bootstrap.e2e-spec.ts` để chứng minh quy tắc mới là nguyên nhân duy nhất.
- **Môi trường đã tạo ở máy dev** (ngoài repo hoặc bị gitignore): `~/dbs-53-postgres.yml` và container `dbs53-postgres-1` (cổng 55433), `backend/env/.env.development` (có `AUTH_MODE=local` và `DATABASE_URL` cổng 55433), `backend/.auth-local/`. Hỏi bạn ở G4 có dọn không.
- **Giới hạn đã chấp nhận:** (a) token local vẫn tạo dòng `users` (`cognito_sub = sub`), mỗi `sub` tùy chỉnh thêm một dòng; (b) khóa riêng nằm trên đĩa máy dev, quyền 0600 không có ý nghĩa trên Windows, bảo vệ thật là gitignore/dockerignore và việc schema từ chối ở deployed; (c) chưa kiểm trên một task ECS thật (T3 ghi rõ); (d) lần `test:db` đỏ một lần ở trên.
- **Bàn giao cho vai khác:** `BL-135` (DoD 4: PR, CI, review; cả M-53-09 nếu người duyệt không chạy) và `BL-136` (thay JWKS trong RAM của ba script `manual-smoke.dbs50|51|52.ts` bằng `auth:dev-token`, đã loại khỏi phạm vi ở G1 câu 7). `BL-112`, `BL-133` giữ nguyên.

## 9. Tài liệu đã cập nhật

- `backend/README.md` (mục 10 «Token thử ở local», hai dòng bảng lệnh), `backend/src/scripts/README.md`, `backend/env/.env.example` (ba dòng chú thích).
- `docs/security/threat-model.md` T3: *Thiết kế* → *Đã kiểm* (ghi rõ chưa kiểm trên ECS thật).
- `.claude/skills/dbs-delivering-task/references/{testing,manual-testing}.md` và bản `.agents/` tương ứng: đổi đúng dòng "DBS-53, once merged" thành "đã có"; hai bản vốn đã khác nhau, không đồng bộ lại.
- `docs/features/README.md` (hàng DBS-53; trạng thái *Implemented* sau G4), `docs/BACKLOG.md` (thêm `BL-135`, `BL-136`; không xóa dòng nào).
- Không đổi: ADR-06 và `docs/components/identity/01-concept-brief.md` (đã đúng nguyên văn), `docs/03` dòng 782 (đã nêu `AUTH_MODE=local`).

## 10. Quyết định ở G4 (2026-11-02)

Duyệt G4, 7 câu theo đề xuất: (1) chấp nhận lệch SHA `7c84c94` so với HEAD (chỉ thêm test), không chạy lại §5; (2) M-53-09 do người dùng tự chạy và chụp, ghi `BL-135`; (3) chấp nhận 5 ảnh transcript thay ảnh màn hình; (4) ghi nhận lần `test:db` đỏ một lần, theo dõi khi CI chạy; (5) giữ T3 là *Đã kiểm* với phạm vi đã ghi; (6) dọn stack dev (container `dbs53-postgres-1`, `~/dbs-53-postgres.yml`, `.auth-local/`, `env/.env.development`, và cả container compose mặc định) **sau khi người dùng báo PR đã merge**; (7) push nhánh và mở PR.
