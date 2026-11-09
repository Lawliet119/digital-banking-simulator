# DBS-159 · Test bảo mật: Idempotency-Key của người khác, token sai/hết hạn/bị thu hồi, giả mạo vai trò

> **Status:** Implemented · **Vai:** Dev · **Cặp đôi review:** Dev khác · **Nhánh:** `test/DBS-159-auth-attack-tests` · **PR:** — · **Cập nhật:** 2026-11-10

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 6, Demo 4. **Expect:** "Chứng minh không có đường lách quyền hiển nhiên."
- **DoD:**
  1. Dùng Idempotency-Key của người khác không lộ response của họ (PK (user_id, idem_key))
  2. Token không có/sai chữ ký/hết hạn → 401; bị thu hồi → SESSION_REVOKED; vai trò chỉ lấy từ cognito:groups, thử đặt vai trò trong body/header không có tác dụng
  3. Chạy trong CI
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc** (kiểm trên `main` 74ed069, không chỉ theo board):
  - DBS-79: `LedgerPostingService.claimKey` dùng `ON CONFLICT (user_id, idem_key) DO NOTHING`.
  - DBS-114: `SessionRevocationModule` (cache Redis), PR #116. Đường SQL `sessions_revoked_at` có từ DBS-113.
  - DBS-51: `RolesGuard` đọc `cognito:groups`.
  - Cả ba đã merge.
- **Đã có gì:** các test hiện có nằm rải rác, phần lớn chạy trên app mẫu chứ không phải endpoint tiền thật:
  - `test/roles-security.e2e-spec.ts` (TC-51-22/23): giả vai trò qua header, body, query, cookie; payload bị sửa; khóa lạ; `alg none`. Chạy trên `/v1/sample/*` của `roles-app`.
  - `test/identity.e2e-spec.ts` và `test/roles.e2e-spec.ts`: 401 khi thiếu token, token rác, hết hạn, sai `client_id`.
  - `test/db/session-revocation*.db-spec.ts` và DBS-113/115: SESSION_REVOKED trên `GET /v1/accounts/:id` và `/v1/identity/me`.
  - `test/db/ledger-schema.db-spec.ts:950`: hai user có cùng key là hai dòng khác nhau, nhưng chỉ kiểm ở mức SQL.
  - Threat model: T1 "còn DBS-159"; T13 "Thiết kế" (chưa có test); T21 "phần mở rộng chờ DBS-159".
- **Baseline** (nhánh mới từ 74ed069): `lint:check` OK, `typecheck` OK, `npm test` 98 suite / 1.767 test đạt, `test:e2e` 17 suite / 163 test đạt.
- **Ngoài phạm vi:**
  - Cognito thật và Redis trên cloud (DBS-186).
  - Rate limit (DBS-89).
  - IDOR trên tài khoản và lịch sử giao dịch: đã có ở DBS-86 và `resource-ownership`, ở đây chỉ kiểm `GET /v1/transfers/:id` vì nó lộ response của lệnh chuyển.
  - Sửa code sản phẩm: task chỉ thêm test. Nếu test lộ lỗ hổng, task này sửa luôn.
- **Câu hỏi mở và Quyết định ở G1** (agent tự quyết):
  1. **Lớp test.** Chọn `test/db/auth-attacks.db-spec.ts`, chạy trên PostgreSQL thật bằng `startDepositApp` (module thật: Identity, Accounts, Audit, Outbox, Ledger, `JwtAuthGuard` → `RolesGuard`, `ValidationPipe` như `main.ts`). Job `db` trong CI chạy toàn bộ `npm run test:db`, nên đạt DoD #3 mà không phải sửa workflow.
  2. **Không lặp lại mọi ca TC-51.** Chỉ đưa các ca tấn công lên endpoint tiền thật: `POST /v1/transfers`, `POST /v1/operator/deposits`, khóa tài khoản, `GET /v1/audit/entries`. Mỗi ca kiểm thêm điều app mẫu không kiểm được: không ghi dòng nào vào `transfers`, `idempotency_keys`, `ledger_entries`, số dư không đổi, bất biến sổ cái PASS.
  3. **Token có claim lạ nhưng chữ ký hợp lệ.** Cần thêm `signClaims` vào `test/support/dev-tokens.ts`, ký bằng cùng khóa của issuer; không chạm code sản phẩm.
  4. **Board vẫn ghi To Do.** Người dùng cần chuyển task sang In Progress.

## 2. Hành vi

Task không thêm API. Các mục dưới là hành vi hiện có mà test phải chứng minh. Mỗi phản hồi lỗi theo dạng Problem Details và có `correlationId`. `errorCode` chỉ có ở các mã trong `ErrorCode`: 401, 403 và 400 thiếu `Idempotency-Key` có mã; 404 và 400 do validation (`forbidNonWhitelisted`) không có mã. "Không ghi DB" nghĩa là không thêm dòng ở `transfers`, `idempotency_keys`, `ledger_entries`, `outbox_events` và số dư không đổi. Bảng `users` có thể có dòng mới vì `JwtAuthGuard.resolveUserId` tạo user cho `sub` lần đầu thấy, trước `RolesGuard`.

**Dữ liệu chung:**
- An (khách) có hai tài khoản: A1 (CHECKING, nạp 5.000.000đ) và A2 (SAVINGS).
- Bình (khách) có B1 (nạp 1.000.000đ).
- An chuyển 200.000đ từ A1 sang A2 (tài khoản của chính An) với key `K`, nhận `201 {"transferId":"T","status":"COMPLETED"}`. Bình không phải người gửi cũng không phải người nhận của `T`.

**H1. Idempotency-Key của người khác (T13, ADR-05).**

| Bình gửi | Kết quả | Ghi DB |
|---|---|---|
| `POST /v1/transfers` key `K`, body y hệt của An (A1 → A2, 200.000đ) | `404`, body (bỏ `correlationId`) giống hệt 404 của một `fromAccountId` ngẫu nhiên; không có `T` hay số tiền | không ghi DB; không có dòng `idempotency_keys(user=Bình,K)`; một dòng `audit_log` `outcome=DENIED`, `action=ledger.transfer`, `actor_user_id=Bình` có `correlation_id` của response này |
| `POST /v1/transfers` key `K`, body của chính Bình (B1 → A1, 100.000đ) | `201` với `transferId` mới ≠ `T` | hai dòng key `K` (An, Bình); An gửi lại `K` với body cũ vẫn nhận `T`, không có lệnh mới |
| `GET /v1/transfers/T` | `404`, body không có số tiền hay tài khoản | một dòng `audit_log` `DENIED`, `action=transfer.read` |

Nạp tiền dùng chung cơ chế: operator Chi nạp 300.000đ vào B1 với key `K2`, nhận `D1`. Operator Dũng gửi cùng `K2` và cùng body, nhận `201` với `D2` ≠ `D1`, nghĩa là một lần nạp mới vì key theo user (ADR-05). Chi gửi lại vẫn nhận `D1`. Hệ quả của thiết kế được ghi rõ: hai operator dùng trùng key thì có hai lần nạp.

**H2. Token không hợp lệ.** Body hợp lệ, key mới. Mọi ca không ghi DB.

| Token | `POST /v1/transfers` | `POST /v1/operator/deposits` (guard JWT chạy trước guard vai trò) |
|---|---|---|
| Không có header `Authorization` | `401 UNAUTHENTICATED` | `401 UNAUTHENTICATED` |
| Chuỗi rác | `401 UNAUTHENTICATED` | |
| RS256 ký bằng khóa khác, cùng `kid` | `401 UNAUTHENTICATED` | |
| Payload sửa thành `cognito:groups: ["operator"]`, giữ chữ ký cũ | `401 UNAUTHENTICATED` | `401 UNAUTHENTICATED` (không phải 403 hay 201) |
| `alg: none`, không có chữ ký | `401 UNAUTHENTICATED` | |
| HS256 ký bằng khóa công khai (nhầm thuật toán) | `401 UNAUTHENTICATED` | |
| ID token (`token_use: "id"`), chữ ký hợp lệ | `401 UNAUTHENTICATED` | |
| `exp` đã qua | `401 TOKEN_EXPIRED` | `401 TOKEN_EXPIRED` (token operator hết hạn) |
| Hợp lệ nhưng `iat` ≤ giây của `sessions_revoked_at` (sau khi operator khóa A2 của An), chuyển từ A1 (ACTIVE) | `401 SESSION_REVOKED` | |
| Token mới, `iat` = giây ngay sau mốc | `201`: thu hồi không chặn phiên mới | |

Ca thu hồi chạy đường SQL: harness không nạp `SessionRevocationModule`, nên không có cache Redis. Đường cache Redis đã có test ở DBS-114 (`session-revocation-cache.db-spec.ts`).

**H3. Vai trò chỉ lấy từ `cognito:groups` (T21).** Mỗi 403 có `errorCode=FORBIDDEN`. Hiện 403 do `RolesGuard` **không** ghi `audit_log` (BL-132), và test khẳng định đúng trạng thái này, để khi BL-132 xong test đổi màu và phải sửa theo.

| Thử | Kết quả | Ghi DB |
|---|---|---|
| Token khách + header `X-Role`, `X-Cognito-Groups`, cookie `role=operator`, query `?role=operator`, body `role` gọi `POST /v1/operator/deposits` | `403` | không ghi DB, không thêm `audit_log` |
| Token khách cùng các giả mạo đó gọi `POST /v1/operator/accounts/:id/lock` | `403` | tài khoản vẫn ACTIVE, `users.sessions_revoked_at` vẫn NULL |
| Token chữ ký hợp lệ, `cognito:groups: ["customer"]`, kèm claim `role`, `custom:role`, `scope` = `operator` | `403` trên nạp tiền | không ghi DB |
| Token `auditor` và `admin` gọi nạp tiền và khóa tài khoản (không có thứ bậc vai trò) | `403` | không ghi DB |
| Token `operator` gọi `POST /v1/transfers` | `403` | không ghi DB |
| Token khách, body chuyển tiền thêm `role: "operator"`, `userId: <Bình>` | `400` validation, không có `errorCode` | không ghi DB |
| Token khách + header vai trò giả, body hợp lệ | `201` | `transfers.initiated_by` là user của token; `audit_log.actor_user_id` là user đó, `actor_role = 'customer'` |

Vai trò trên `GET /v1/audit/entries` (customer, operator, admin bị 403) đã có test ở DBS-103 (`audit-search.http.db-spec.ts`). Harness `startDepositApp` không nạp `AuditHttpModule`, nên task này không lặp lại.

## 3. Kiến trúc

- **Vị trí:** chỉ có test. Thêm `backend/test/db/auth-attacks.db-spec.ts`, và trong `backend/test/support/dev-tokens.ts` thêm `signClaims`. Role `api`.
- **Interface dùng:**
  - `startDepositApp(databaseUrl)` → `{ url, issuer, close }`.
  - `DevTokenIssuer.token(role, { sub, iat, exp })`.
  - Thêm `DevTokenIssuer.signClaims(role, extra: Record<string, unknown>, options?)`: ký claim chuẩn của `buildAccessTokenClaims` cộng `extra` (ghi đè được, ví dụ `token_use`) bằng cùng khóa RS256.
  - Người gọi `createDevTokenIssuer`: `deposit-app.ts`, `local-auth-app.ts` và các test. Chỉ thêm method, không đổi chữ ký cũ.
  - Token HS256 dựng trong test bằng `jose` (`SignJWT` với secret là SPKI PEM của khóa công khai).
- **Dữ liệu:**
  - Đọc `transfers` (`initiated_by`), `idempotency_keys` (`user_id`, `idem_key`), `ledger_entries`, `outbox_events`, `audit_log` (`actor_user_id`, `actor_role`, `action`, `outcome`), `accounts`, `users` (`sessions_revoked_at`).
  - Dữ liệu tạo qua HTTP: `POST /v1/customers/me`, `POST /v1/accounts`, nạp tiền bằng operator. Không seed số dư bằng SQL.
- **Ranh giới transaction:** không đổi.
- **Thay đổi cấp hệ thống:** `docs/security/threat-model.md`, cột trạng thái của T1, T13, T21 cập nhật kèm link. ADR-05 không đổi.

## 4. Test cases tự động

File: `backend/test/db/auth-attacks.db-spec.ts`, lớp security trên PostgreSQL thật. Sau mỗi case `checkLedgerInvariants` phải PASS.

| ID | Truy vết | Given · When · Then | `errorCode` |
|---|---|---|---|
| TC-159-01 | DoD #1, T13 | `T` = A1 → A2 của An với key `K`. Bình gửi `K` với body của An → 404. Body (bỏ `correlationId`) giống hệt 404 của `fromAccountId` ngẫu nhiên, không chứa `T`. Không có dòng key của Bình; dòng `DENIED` `ledger.transfer` của Bình tìm theo `correlation_id` của chính response (lệnh đối chứng ghi dòng riêng của nó); không ghi DB | 404, không có mã |
| TC-159-02 | DoD #1, T13 | Bình gửi `K` với body của mình → 201, `transferId` ≠ `T`; có hai dòng key `K`. An gửi lại `K` → `T`, số dòng `transfers` không tăng | — |
| TC-159-03 | DoD #1, T12/T13 | Bình gọi `GET /v1/transfers/T` → 404, body không có `amount` hay id tài khoản; có dòng `DENIED` `transfer.read`. An gọi → 200 | 404, không có mã |
| TC-159-04 | DoD #1, ADR-05 | Operator Chi nạp với `K2` → `D1`. Dũng gửi `K2` cùng body → 201, `D2` ≠ `D1`. Chi gửi lại → `D1` | — |
| TC-159-05 | DoD #2, T1 | `POST /v1/transfers` với: không token, rác, khóa khác cùng `kid`, payload sửa, `alg none`, HS256 bằng khóa công khai, ID token → 401. Payload sửa và không token trên nạp tiền → 401. Không ghi DB | `UNAUTHENTICATED` |
| TC-159-06 | DoD #2, T1 | Token khách hết hạn trên chuyển tiền, token operator hết hạn trên nạp tiền → 401. Không ghi DB | `TOKEN_EXPIRED` |
| TC-159-07 | DoD #2, T2, AC-11.1 | Operator khóa A2 của An; token cũ chuyển A1 → B1 → 401, không ghi DB. Token mới `iat` = giây ngay sau mốc → 201 (đường SQL) | `SESSION_REVOKED` |
| TC-159-08 | DoD #2, T21 | Token khách + giả vai trò qua header, cookie, query, body → 403 trên nạp tiền và khóa tài khoản. Không ghi DB, không thêm `audit_log` (BL-132), tài khoản vẫn ACTIVE, `sessions_revoked_at` vẫn NULL | `FORBIDDEN` |
| TC-159-09 | DoD #2, T21 | Token ký đúng, `cognito:groups=["customer"]`, kèm `role`/`custom:role`/`scope` = `operator` → 403 trên nạp tiền | `FORBIDDEN` |
| TC-159-10 | DoD #2, T21 | `auditor` và `admin` trên nạp tiền và khóa; `operator` trên chuyển tiền → 403, không ghi DB | `FORBIDDEN` |
| TC-159-11 | DoD #2, T21 | Body chuyển tiền thêm `role`, `userId` → 400, không ghi DB. Header giả + body hợp lệ → 201, `transfers.initiated_by` và `audit_log.actor_user_id` là user của token, `actor_role='customer'` | 400, không có mã |
| quy trình | DoD #3 | File nằm trong `test/db`, nên job `db` của CI (`npm run test:db`) tự chạy; kiểm trên run CI của PR | — |
| quy trình | DoD #4 | PR merge, CI xanh, bảng đối chiếu | — |

## 5. Test thủ công

Chạy app thật (`npm run start:dev`, `APP_ROLE=both`, `AUTH_MODE=local`) trên một database riêng, gửi lệnh bằng `curl` trong Git Bash, ghi output vào `screenshots/DBS-159/manual-test.txt`.

**Chuẩn bị** (từ `backend/`):
- `docker compose up -d` ở thư mục gốc. Máy này dùng container `dbs63-fix-pg` ở cổng 55433, user `test`.
- `psql postgres://test:test@localhost:55433/postgres -c "CREATE DATABASE banking_manual159"`.
- `export DATABASE_URL=postgres://test:test@localhost:55433/banking_manual159`, rồi `npm run migration:run`.
- Chạy `npm run start:dev` với cùng `DATABASE_URL`: biến môi trường thắng giá trị trong `.env.development`. `check:invariants` cũng dùng biến này.
- `npm run auth:dev-keys` nếu chưa có khóa.
- Token: `npm run --silent auth:dev-token -- --role customer --sub tran-an`, rồi tương tự `--sub nguyen-binh`, `--role operator --sub operator-chi`, `--role operator --sub operator-dung`.
- Token hết hạn: `--iat <now-1000> --exp <now-100>`.
- Token sửa payload: tách token theo `.`, đổi phần giữa bằng `printf '%s' '<json>' | base64 -w0 | tr '+/' '-_' | tr -d '='`, ghép lại với header và chữ ký cũ.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-159-01 | An (`tran-an`) tạo hồ sơ "Trần Văn An" và hai tài khoản A1 (CHECKING), A2 (SAVINGS). Bình (`nguyen-binh`) tạo "Nguyễn Thị Bình" và B1. Chi nạp 5.000.000đ vào A1, 1.000.000đ vào B1. An chuyển 200.000đ A1 → A2 với key `K` | 201 mọi bước; A1 = 4.800.000đ, A2 = 200.000đ |
| M-159-02 | Bình gửi `K` với body của An; rồi `GET /v1/transfers/T`; xem `idempotency_keys` và `audit_log` bằng psql | 404 cả hai, body không có `T`; key `K` chỉ có dòng của An; hai dòng `DENIED` của Bình (`ledger.transfer`, `transfer.read`) |
| M-159-03 | Bình gửi `K` với body của mình (B1 → A1, 100.000đ); An gửi lại `K` | Bình 201, `transferId` ≠ `T`; An nhận lại `T` |
| M-159-04 | Chi nạp 300.000đ vào B1 với `K2`; Dũng gửi `K2` cùng body; Chi gửi lại | Chi `D1`, Dũng `D2` ≠ `D1` (B1 tăng hai lần, đúng ADR-05), Chi gửi lại vẫn `D1` |
| M-159-05 | `POST /v1/transfers`: không token; token sửa payload thành operator; token hết hạn | 401 `UNAUTHENTICATED`, 401 `UNAUTHENTICATED`, 401 `TOKEN_EXPIRED`; số dòng `transfers` không đổi |
| M-159-06 | Token khách gửi header `X-Role: operator`, cookie `role=operator`, body `role` lên `POST /v1/operator/deposits` và `.../lock` | 403 `FORBIDDEN` cả hai; số dư và trạng thái không đổi |
| M-159-07 (phục hồi) | Chi khóa A2 (`{"reason":"CONFIRMED_FRAUD"}`); token cũ của An chuyển A1 → B1; lấy token mới (`--iat` = giây sau mốc) rồi chuyển lại | 401 `SESSION_REVOKED`; token mới 201 |
| M-159-08 | `npm run --silent check:invariants` | exit 0, PASS |

## 6. Domain review (AI)

**Reviewer:** subagent general-purpose, model Opus (effort medium), 2026-11-10 · **Vòng 1:** 10 phát hiện (blocking 1, should-fix 5, minor 4), verdict REVISE · [nguyên văn](screenshots/DBS-159/domain-review.md). **Vòng 2:** 10/10 đã xử lý, 1 minor mới, verdict **APPROVE** · [nguyên văn](screenshots/DBS-159/domain-review-r2.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | Bình là người nhận của `T` nên `GET /v1/transfers/T` trả 200 | đã sửa §2/§4/§5: `T` là A1 → A2 của chính An |
| 2 | should-fix | Tên cột sai (`actor`) | đã sửa: `transfers.initiated_by`, `audit_log.actor_user_id`/`actor_role` |
| 3 | should-fix | 403 của `RolesGuard` không ghi `audit_log` (BL-132) mà doc không nói | đã sửa: TC-159-08 khẳng định không có dòng mới; thêm DBS-159 làm nguồn của BL-132 (§8 Bàn giao) |
| 4 | should-fix | M-159-07 cần hai tài khoản của An | đã sửa M-159-01 (A1, A2) và body khóa có `reason` |
| 5 | should-fix | Chuẩn bị test thủ công thiếu lệnh tạo DB, migrate, `--sub` | đã sửa §5 "Chuẩn bị" |
| 6 | should-fix | Harness không nạp cache Redis | đã sửa: TC-159-07 ghi rõ chỉ đường SQL, đường cache dẫn sang test DBS-114 |
| 7 | minor | 400 thiếu key có `errorCode` | đã sửa câu mở đầu §2 |
| 8 | minor | Thiếu ca thứ tự guard, nhầm vai trò nhân viên, ID token, HS256 | đã thêm vào TC-159-05/06/10; audit endpoint dẫn sang DBS-103 |
| 9 | minor | "Không ghi DB" quá rộng; 404 không thể giống từng byte | đã sửa: liệt kê bảng; so 404 sau khi bỏ `correlationId` |
| 10 | minor | Không có công thức sửa payload; operator thứ hai không dùng | đã thêm công thức và M-159-04 |
| N1 (vòng 2) | minor | Lệnh 404 đối chứng cũng ghi DENIED của Bình | đã sửa: tìm dòng DENIED theo `correlation_id` |

**Quyết định ở G2** (agent tự quyết): không dựng Valkey trong suite này (phát hiện 6), vì đường cache đã có test riêng của DBS-114 và cache chỉ có thể từ chối, nên đường SQL là đường quyết định. Vòng 2 review lại §2–§5 đã sửa và APPROVE.

## 7. Kế hoạch triển khai

Task chỉ thêm test cho hành vi đã có, nên "đỏ" nghĩa là: chạy test trước khi có helper hoặc với một mệnh đề sai có chủ đích, để chắc test thật sự kiểm được. Đỏ thật xuất hiện nếu test lộ lỗ hổng; khi đó sửa code và ghi vào §8.

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `backend/test/support/dev-tokens.ts` | TC-159-09 gọi `issuer.signClaims` | | `npm run typecheck` | `test(identity): sign tokens with extra claims in the dev issuer (DBS-159)` |
| 2 | `backend/test/db/auth-attacks.db-spec.ts` | TC-159-01..04 (Idempotency-Key người khác) | | `env -u DATABASE_URL npm run test:db -- --runInBand --runTestsByPath test/db/auth-attacks.db-spec.ts` | `test(security): foreign Idempotency-Key never leaks a response (DBS-159)` |
| 3 | cùng file | TC-159-05..07 (token) | | như trên | `test(security): bad, expired and revoked tokens on money endpoints (DBS-159)` |
| 4 | cùng file | TC-159-08..11 (vai trò) | | như trên | `test(security): role forgery on money endpoints (DBS-159)` |
| 5 | `docs/security/threat-model.md`, `docs/BACKLOG.md` (BL-132 thêm nguồn), `docs/features/README.md`, doc này, `screenshots/DBS-159/` | — | — | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(security): DBS-159 evidence for T1, T13, T21` |

Quét giới hạn và DoD: T1, T13, T21 của threat model có dòng bước 5; BL-132 (403 không ghi audit) chỉ thêm nguồn, không làm; cache Redis của thu hồi (DBS-114) và Cognito thật (DBS-186) ngoài phạm vi, đã ghi §1/§2. DoD #3 không cần sửa CI vì job `db` chạy toàn bộ `test:db`.

**Rủi ro:** test chậm (mỗi request đi qua app thật) → dùng một app và một database cho cả file, dữ liệu theo từng `describe`. Một ca đỏ do lỗ hổng thật → dừng, sửa code sản phẩm kèm test tái hiện, ghi gate phụ ở §8. **Cách lùi:** chỉ có file test và một method helper; revert commit là đủ.

**Quyết định ở G3** (agent tự quyết): gộp bốn bước code vào một file spec vì chúng chia sẻ dữ liệu An/Bình/Chi/Dũng; mỗi bước vẫn một commit.

## 8. Kết quả

- **Lệnh kiểm tra** (từ `backend/`, trên `9d90d51`):
  - `npm run lint:check`: sạch.
  - `npm run typecheck`: sạch.
  - `npm test`: 98 suite / 1.767 test đạt.
  - `npm run test:e2e` (`DATABASE_URL` ở cổng 55433): 17 suite / 163 test đạt.
  - `env -u DATABASE_URL npm run test:db -- --runTestsByPath test/db/auth-attacks.db-spec.ts`: 1 suite / 11 test đạt, 40,7 s.
  - `npm run test:db` toàn bộ (Testcontainers PostgreSQL 17): 60 suite / 863 test đạt, 574 s.
  - Không có `.skip`, `.only` hay `.todo`.
- **Chứng minh test bắt được lỗi.** Task chỉ thêm test cho hành vi đã có, nên 11 ca xanh ngay lần đầu. Để chắc các ca không xanh vô điều kiện, tôi lần lượt làm hỏng bốn chỗ trong code sản phẩm, chạy lại file, rồi `git checkout` khôi phục. Mỗi lần hỏng đều làm đỏ đúng ca nó nhắm tới:

| Chỗ làm hỏng | Ca đỏ |
|---|---|
| M1: `transfer-query.service.ts`, ai cũng được đọc lệnh COMPLETED | TC-159-03 |
| M2: `jwks-verifier.service.ts`, bỏ kiểm `token_use` | TC-159-05 (ID token) |
| M3: `transfer.service.ts`, bỏ kiểm chủ tài khoản nguồn (cả kiểm trước và kiểm dưới khóa) | TC-159-01, TC-159-02 |
| M4: `roles.guard.ts`, tin thêm header `X-Role` | TC-159-08 |

- **Đối chiếu test case** (`backend/test/db/auth-attacks.db-spec.ts`):

| ID | Test | Đạt? |
|---|---|---|
| TC-159-01 | › DoD #1 › TC-159-01 Bình replaying An's key with An's exact body gets the plain 404… | đạt |
| TC-159-02 | › DoD #1 › TC-159-02 Bình using the same key for his own transfer gets a new transfer… | đạt |
| TC-159-03 | › DoD #1 › TC-159-03 Bình cannot read An's transfer by id… | đạt |
| TC-159-04 | › DoD #1 › TC-159-04 a deposit key is per operator… | đạt |
| TC-159-05 | › DoD #2 tokens › TC-159-05 no token, garbage, another key… are all 401 UNAUTHENTICATED | đạt |
| TC-159-06 | › DoD #2 tokens › TC-159-06 an expired customer token… 401 TOKEN_EXPIRED | đạt |
| TC-159-07 | › DoD #2 a revoked session › TC-159-07 after a lock, the old token is 401 SESSION_REVOKED… | đạt (đường SQL; cache Redis có test của DBS-114) |
| TC-159-08 | › DoD #2 roles › TC-159-08 a customer token dressed up as operator… | đạt |
| TC-159-09 | › DoD #2 roles › TC-159-09 a correctly signed customer token with role… claims | đạt |
| TC-159-10 | › DoD #2 roles › TC-159-10 no role hierarchy… | đạt |
| TC-159-11 | › DoD #2 roles › TC-159-11 role or user fields in a transfer body are refused… | đạt |
| DoD #3 | Job `db` của CI chạy `npm run test:db`, gồm mọi file `test/db/*.db-spec.ts` | kiểm trên run CI của PR |

- **Test thủ công.** App thật chạy bằng `npm run start:dev` (`APP_ROLE=both`, `AUTH_MODE=local`, Valkey bật) trên database `banking_manual159`, gửi lệnh bằng `curl` trong Git Bash. Output thô ở [manual-test.txt](screenshots/DBS-159/manual-test.txt); dòng đầu là SHA `9d90d51`; không ghi token.

| Bước | Phản hồi thật (rút gọn) | Kết quả |
|---|---|---|
| M-159-01 | Mọi bước 201; `T=00404339…`; CHECKING = 4.800.000, SAVINGS = 200.000 | đạt |
| M-159-02 | Gửi lại key `K` và đọc `T` đều 404, body không chứa `T`. Số dòng transfers/keys/ledger/outbox giữ nguyên (3/3/6/3); audit 8 → 10. Key `K` chỉ thuộc `tran-an`. Hai dòng audit `ledger.transfer:DENIED` và `transfer.read:DENIED` của Bình | đạt |
| M-159-03 | Bình 201, `ff804a39…` ≠ `T`; An gửi lại nhận đúng `T` | đạt |
| M-159-04 | Chi `8772c902…`, Dũng `8198577a…`, Chi gửi lại nhận `8772c902…`; B1 = 1.500.000 (1.000.000 − 100.000 + 2 × 300.000) | đạt |
| M-159-05 | Không token: 401 `UNAUTHENTICATED`. Token sửa payload: 401 `UNAUTHENTICATED`. Token hết hạn: 401 `TOKEN_EXPIRED`. Số dòng không đổi (6/6/12/6, audit 13) | đạt |
| M-159-06 | Nạp tiền: 403 `FORBIDDEN`; khóa tài khoản: 403 `FORBIDDEN`. Số dòng và audit không đổi; A1 vẫn ACTIVE; `sessions_revoked_at` vẫn NULL | đạt |
| M-159-07 | Khóa A2: 200. Token cũ: 401 `SESSION_REVOKED`, số dòng không đổi. Token mới (`iat` = mốc + 1): 201 COMPLETED | đạt |
| M-159-08 | `{"status":"PASS","totals":{"debit":"6950000","credit":"6950000","balance":"0"}}`, exit 0 | đạt |

- **Phạm vi so với §7:** xem kết quả `git diff --stat` ở tin nhắn G4.
  - Có thêm `docs/features/README.md`: ngoài dòng DBS-159, tôi xóa một dòng trống nằm giữa bảng (sót lại từ lần merge #113/#114), vì nó làm vỡ bảng markdown.
  - Mọi file khác nằm trong §7.
- **Ảnh chụp** (dựng từ chính `manual-test.txt` bằng Chromium headless):

![Idempotency-Key của người khác](screenshots/DBS-159/01-foreign-idempotency-key.png)

![Token sai và giả vai trò](screenshots/DBS-159/02-bad-tokens-and-forged-roles.png)

![Phiên bị thu hồi và bất biến](screenshots/DBS-159/03-revoked-session-and-invariants.png)

- **Lệch so với kế hoạch:**
  1. Kế hoạch §7 tách bước 2–4 thành ba commit. Thực tế file spec được viết một lần trong một commit, vì 11 ca dùng chung dữ liệu và `beforeAll`. Không ảnh hưởng nội dung; agent tự quyết.
  2. Không có ca nào đỏ thật trên code gốc, nên thay "đỏ trước" bằng bốn lần làm hỏng code sản phẩm ở trên. Agent tự quyết, ghi trước khi viết §8.
- **Bàn giao cho vai khác:**
  - BL-132 (403 của `RolesGuard` chưa ghi `audit_log`, Dev chủ audit DBS-56): thêm DBS-159 làm nguồn. Khi BL-132 xong, TC-159-08 sẽ đỏ, và người làm BL-132 sửa ca này để khẳng định có dòng `DENIED`.
  - Cognito và Redis thật trên cloud vẫn thuộc DBS-186.
  - Không có dòng `BL-NNN` mới.

## 9. Tài liệu đã cập nhật

- `docs/security/threat-model.md`:
  - T1: "Đã kiểm" (local), kèm link.
  - T13: từ "Thiết kế" sang "Đã kiểm".
  - T21: phần mở rộng đã kiểm, kèm link.
- `docs/BACKLOG.md`: BL-132 có thêm nguồn DBS-159; không thêm và không xóa dòng nào.
- `docs/features/README.md`: thêm dòng DBS-159; bỏ dòng trống làm vỡ bảng.
- Không đổi ADR. ADR-05 đã nhắc DBS-159 ở mục test bảo mật.
