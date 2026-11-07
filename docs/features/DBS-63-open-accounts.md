# DBS-63 · UC-2 mở tài khoản, tối đa 3 tài khoản mỗi khách

> **Status:** Draft (đang bù; G1 đã duyệt, đến G2) · **Vai:** Dev (Accounts) · **Nhánh:** `feat/DBS-63-open-accounts` · **PR:** [#58 · Draft](https://github.com/Lawliet119/digital-banking-simulator/pull/58) · **Cập nhật:** 2026-11-07

> **Ghi chú quy trình:** phần implement, test và manual test của task này đã làm trước khi có G1, G2 và G3, vì yêu cầu ban đầu bỏ qua gate. Skill không cho phép việc đó. Từ đây các gate được bù lần lượt, mỗi gate một tin nhắn, người duyệt trả lời rồi mới sang gate sau. Các mục §2–§9 bên dưới là bản cũ, sẽ được viết lại ở G2 (§2–§6), G3 (§7) và G4 (§8–§9).

## 1. Bối cảnh

- **Task trên board:** Story · Tuần 2 · vai `Dev` · ưu tiên Highest · Status `In Progress` · Deliverable/Demo `P2`.
  - **Thực trạng:** Giới hạn 3 tài khoản/khách (BR-14) không biểu diễn được bằng CHECK nên phải giữ bằng transaction có SELECT … FOR UPDATE hàng customers (database-design §4.2).
  - **Expect:** Khách mở được tối đa 3 tài khoản kể cả khi bấm song song.
- **DoD** (chép nguyên văn):
  1. Endpoint mở tài khoản CHECKING/SAVINGS; kiểm số tài khoản trong transaction có khóa hàng customers
  2. Test: ≥ 5 request mở tài khoản cùng lúc → đúng 3 tài khoản, phần còn lại ACCOUNT_LIMIT_REACHED
  3. Ghi audit; số dư ban đầu 0; không thể chọn type SYSTEM từ API
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:**

  | Task | Board | Thực trạng trong repo |
  |---|---|---|
  | DBS-62 onboarding | Done | Đã vào main (`689a8e8`, [PR #56](https://github.com/Lawliet119/digital-banking-simulator/pull/56)); `customers` và `POST /v1/customers/me` có thật |
  | DBS-55 AccountsService | Done | Đã vào main ([PR #33](https://github.com/Lawliet119/digital-banking-simulator/pull/33)); không đổi chữ ký nào của `AccountsService` |

  Lúc bắt đầu implement, DBS-62 chưa merge. Người dùng đã duyệt bằng văn bản (2026-11-04) việc dựng tạm trên nhánh DBS-62 thật, không stub guard hay service, không seed customer bằng SQL. Khoảng đó đã hết: nhánh nay chứa main mới nhất.
- **Đã có gì (trên PR #58):**
  - Code: `account-opening.service.ts`, `accounts.controller.ts`, `open-account.dto.ts`, đăng ký trong `accounts.module.ts`. Test `backend/test/db/account-opening.db-spec.ts` (10 case, HTTP + PostgreSQL thật). Script manual `backend/scripts/manual-dbs63.cjs`.
  - Tài liệu: README module accounts, docs/03 (bảng API), `docs/features/README.md`, `docs/BACKLOG.md`, bằng chứng trong `screenshots/DBS-63/`.
  - Người gọi của symbol đã có: `AccountsService` giữ nguyên, không đổi export. `AccountsModule` chỉ thêm `AccountsController` và `AccountOpeningService`.
  - CI: 6/6 job xanh trên head `ec2f995` của PR (run `42169084841`), trước khi merge main mới.
- **Baseline** (cây đã merge main `aeee9c9`, commit `e06dbb1`; Node **v24.22.2** bản portable đặt ngoài repo, SHA256 đã kiểm; Postgres riêng cho e2e vì container `dbs-postgres-1` trên máy thuộc worktree khác và có mật khẩu khác, không đụng vào):

  | Lệnh | Kết quả |
  |---|---|
  | `npm run lint:check` | đạt |
  | `npm run typecheck` | đạt |
  | `npm run build` | đạt |
  | `npm test -- --runInBand` | 838/839 đạt, 56/57 suite; **1 đỏ**: `jwks-verifier.service.spec.ts` › "honours the refetch cooldown…" (đúng BL-112, đã biết, không do task này) |
  | `npm run test:e2e -- --runInBand` | 135/135 đạt, 13/13 suite (`DATABASE_URL` trỏ Postgres 17 riêng) |

  Lần chạy đầu trên Node 18.20.8 cho kết quả đỏ giả (`crypto is not defined`); không dùng. Chạy song song (không `--runInBand`) trên Node 24 cũng đỏ vì timeout khi máy quá tải, chạy riêng từng suite thì đạt. Baseline chốt là hai dòng `--runInBand`. Test DB (`test:db`) sẽ chạy ở Phase 4b.
- **Backlog liên quan (module accounts / DoD này):** BL-112 và BL-121 (test thời gian đã có, không do task này), BL-130 và BL-132 (audit từ chối vai ở tầng identity), BL-017 (test DB chạy bằng superuser nên chưa chứng minh quyền role ứng dụng), BL-122 và BL-008 (nằm ngoài). Không dòng nào được đưa vào phạm vi; task này không đóng dòng nào.
- **Ngoài phạm vi:** thay đổi schema, env, dependency hay `ErrorCode`; sự kiện mới / outbox; API khóa, mở khóa, liệt kê hay xem số dư tài khoản (các task khác); idempotency của việc mở tài khoản (FR-LED-05 chỉ nói nạp và chuyển tiền); ràng buộc DB cho giới hạn 3 (BR-14 giữ bằng khóa hàng customers, SQL của admin ngoài API không được bảo vệ).
- **Câu hỏi mở:**
  1. **Bù gate.** Code đã xong trước khi có G1–G3. Đề xuất: đi bù G1 → G2 → G3 → G4, mỗi gate một tin nhắn, dùng code hiện có làm đối tượng để duyệt, chỉ sửa code nếu review hoặc test mới phát hiện lỗi. Nếu bạn muốn làm lại từ đầu, nói rõ.
  2. **Baseline đỏ vì Node 18.** Đề xuất: chạy baseline và các test DB trong container `node:24` bằng Docker (không cài gì lên máy bạn). Hoặc bạn tự cài Node 24 rồi mình chạy lại. Chưa có kết quả này thì G4 không thể nói "đạt".
  3. **Reviewer ở G2.** Lần trước domain review dùng "Codex, cùng model", trong khi skill yêu cầu model mạnh nhất. Đề xuất: chạy lại domain review bằng một subagent mới, lưu nguyên văn đè lên `domain-review.md` (bản cũ vẫn trong git).
  4. **Nhánh và push.** Mình đã merge main vào nhánh (không rebase) để không phải force-push; conflict chỉ ở `docs/BACKLOG.md`, dòng của task đổi thành `BL-158` vì main đã dùng đến `BL-157`. Mọi thay đổi hiện chỉ nằm trên máy. Đề xuất: không push gì cho đến sau G3, và khi push thì push thường (nhánh này là của PR #58 đang mở, tác giả commit khác, nên cần bạn đồng ý).
  5. **Fixture trạng thái.** TC-63-05 dùng `UPDATE accounts SET status='LOCKED'` bằng SQL vì API khóa tài khoản chưa có. `module-notes.md` chỉ cấm seed số dư bằng SQL, không cấm trạng thái. Đề xuất: giữ, ghi rõ ở §4, không stub API khóa.

**Quyết định ở G1** (người dùng trả lời «duyệt», 2026-11-07, chấp nhận mọi đề xuất): (1) đi bù G1 → G4 từng gate trên code hiện có; (2) baseline chạy trên Node 24, thực hiện bằng bản portable thay vì container vì Testcontainers cần Docker socket; (3) chạy lại domain review bằng subagent mới ở G2; (4) không push trước G3, khi push là push thường và hỏi lại; (5) giữ fixture `UPDATE accounts SET status='LOCKED'`, ghi ở §4.

## 2. Hành vi

`POST /v1/accounts` · vai `customer` · guard JWT và vai là guard toàn cục có sẵn · không có `Idempotency-Key` (mỗi lần gọi là một tài khoản mới, đến tối đa 3; FR-LED-05 chỉ áp dụng cho nạp và chuyển tiền).

**Request:** đúng một trường `{"type": "CHECKING"}` hoặc `{"type": "SAVINGS"}`. Hai loại hành xử giống nhau, chỉ là nhãn (database-design §4.2). Owner, số dư, trạng thái và id không bao giờ lấy từ client.

| # | Điều kiện | Kết quả | `errorCode` / ghi chú |
|---|---|---|---|
| 2.1 | Customer đã onboarding, đang có 0–2 tài khoản | 201, tạo tài khoản mới của chính caller | — |
| 2.2 | Customer đang có đủ 3 tài khoản (tính cả `LOCKED`) | 409, không tạo gì | `ACCOUNT_LIMIT_REACHED` |
| 2.3 | `type` là `SYSTEM`, chữ thường, rỗng, `null`, số, chuỗi SQL, hoặc thiếu | 400 | lỗi validate, không tới service |
| 2.4 | Body có thêm `customerId`, `userId`, `balance`, `status`, `id` | 400 | `forbidNonWhitelisted` toàn cục |
| 2.5 | Không có token, token sai chữ ký / rác, hoặc hết hạn | 401 | `UNAUTHENTICATED` / `TOKEN_EXPIRED` |
| 2.6 | Vai `operator`, `auditor`, `admin` | 403 | `FORBIDDEN` |
| 2.7 | Customer có token hợp lệ nhưng chưa gọi `POST /v1/customers/me` | 404, không tạo gì, có audit `REJECTED` | không có `errorCode` mới (không thêm `ErrorCode`); khác `GET /v1/customers/me` (404, không audit) vì đây là một lệnh ghi bị từ chối còn GET chỉ đọc |
| 2.8 | Lỗi DB tạm thời (kể cả hết thời gian chờ khóa hàng `customers`) | 503 | `SERVICE_TEMPORARILY_UNAVAILABLE` + `Retry-After`, không tạo tài khoản, không ghi audit SUCCESS |
| 2.9 | Ghi audit thất bại | 500, rollback, không tạo tài khoản | thông điệp chung, không lộ SQL hay PII |

**201 (ví dụ):**

```json
{
  "id": "2c0f9e9b-638b-4b69-aa26-aa767bd7ee38",
  "type": "CHECKING",
  "status": "ACTIVE",
  "balance": "0",
  "createdAt": "2026-11-06T05:28:48.632Z",
  "updatedAt": "2026-11-06T05:28:48.632Z"
}
```

**409 (ví dụ):**

```json
{
  "errorCode": "ACCOUNT_LIMIT_REACHED",
  "type": "about:blank",
  "title": "Conflict",
  "status": 409,
  "detail": "Customer account limit reached",
  "correlationId": "18b6d366-e244-4aa2-a008-fe7691b26521"
}
```

**Quy tắc:**
- Số dư ban đầu là `0` lấy từ DEFAULT của cột, trả về dạng chuỗi (`balance::text`), ứng dụng không chuyển sang `Number`. Trạng thái `ACTIVE` cũng từ DEFAULT. Không có bút toán sổ cái nào được tạo.
- Giới hạn 3 tính theo `customer_id`, mọi `type` và mọi `status`. Hai customer khác nhau không ảnh hưởng nhau.
- Giới hạn chỉ được bảo đảm cho mọi đường mở tài khoản đi qua service này. SQL của admin ngoài API không được bảo vệ (BR-14 không biểu diễn được bằng `CHECK`).
- Mọi truy vấn có tham số. Không có sự kiện outbox: không có `AccountOpened` trong `event-contract.md`.

**Audit** (action `account.open`, actor là `users.id` đã xác minh, vai `customer`, `correlationId` do server sinh):

| Tình huống | `outcome` | `target` | `metadata` | Giao dịch |
|---|---|---|---|---|
| 2.1 thành công | `SUCCESS` | `account` / id tài khoản mới | `{id}` | cùng transaction với INSERT |
| 2.2 đủ 3 | `REJECTED` | `customer` / id customer | `{reason: "ACCOUNT_LIMIT_REACHED", count}` | cùng transaction, **commit trước khi trả 409** |
| 2.7 chưa onboarding | `REJECTED` | `user` / id người gọi | `{id}` (không có `reason`: `reason` chỉ nhận giá trị của `ErrorCode` hoặc `AuditReason`, và không thêm mã mới) | cùng transaction (không ghi dữ liệu nào khác), 404 ném sau commit |

Lỗi audit lan ra ngoài và làm rollback (FR-AUD-01: không ghi được audit thì hủy thao tác). Nếu ghi audit của 2.2 hoặc 2.7 lỗi thì trả 500 thay vì 409 / 404.

**Vì sao 2.7 là `REJECTED` chứ không phải `DENIED`:** database-design định nghĩa `DENIED` là lần bị từ chối quyền (A đụng vào tài nguyên của B). Thiếu hồ sơ customer là điều kiện nghiệp vụ chưa đủ, không phải vi phạm quyền; ghi `DENIED` sẽ làm bẩn truy vấn truy vết vi phạm truy cập của auditor. Quy tắc trong `references/testing.md`: từ chối nghiệp vụ → `REJECTED` cùng transaction. Không có nhánh `DENIED` nào trong endpoint này vì request không mang id tài nguyên của người khác. *(Thay đổi so với code hiện có, đang chờ duyệt ở G2: code đang ghi `DENIED` bằng transaction riêng.)*

## 3. Kiến trúc

- **Vị trí:** module `accounts`, role `api` (cũng có khi `APP_ROLE=both`; worker không mở HTTP). File: `account-opening.service.ts` (`AccountOpeningService`, chỉ dùng trong module), `accounts.controller.ts` (`AccountsController`), `open-account.dto.ts` (`CreateAccountDto`, `OpenedAccountDto`), đăng ký trong `accounts.module.ts`.
- **Interface dùng:** `TransactionService.run<T>(cb)` (READ COMMITTED, có retry `40P01`/`40001` ba lần rồi 503), `AuditService.record(manager, entry)`, `@CurrentUser()`, `@Roles('customer')`, `request.correlationId` từ middleware.
- **Interface cung cấp:** `AccountOpeningService.open(userId: string, type: CustomerAccountType, correlationId: string): Promise<OpenedAccountDto>`. `AccountsService` (export) và mọi người gọi nó **không đổi**: module chỉ thêm controller và provider.
- **Dữ liệu:** `customers` (khóa hàng `FOR UPDATE`), `accounts` (COUNT, INSERT; `accounts_customer_idx` phục vụ COUNT), `audit_log`. Không migration, không đổi schema.
- **Ranh giới transaction:** một `TransactionService.run` gồm: khóa hàng `customers` theo `user_id` → COUNT → (INSERT hoặc audit REJECTED) → audit SUCCESS. Không gọi Redis, HTTP, SQS bên trong. Callback trả một kết quả (`created` / `limit` / `missing`); 409 và 404 chỉ được ném **sau khi** transaction trả về, để audit REJECTED (cả hai nhánh) không bị rollback. Không bắt lỗi DB trong callback.
- **Khóa:** khóa hàng cha `customers` làm hàng đợi cho cùng một customer, kể cả khi chưa có tài khoản nào để khóa. COUNT là câu lệnh riêng sau khi giữ khóa nên thấy tài khoản mà người giữ khóa trước vừa commit (READ COMMITTED). Chỉ có **một khóa độc quyền** (hàng `customers`), nên không có thứ tự khóa và không có chu trình. Ngoài ra có hai khóa `FOR KEY SHARE` do khóa ngoại: INSERT `accounts` lên chính hàng `customers` đó (cùng transaction, không xung đột), và INSERT `audit_log` lên hàng `users` của actor qua `audit_log_actor_user_id_fkey`; hiện chưa có đường ghi nào trong code vào `users` ngoài `INSERT … ON CONFLICT DO NOTHING` của identity; đường thu hồi phiên sau này chỉ đổi `sessions_revoked_at` (không phải cột khóa) nên lấy `NO KEY UPDATE`, không xung đột với `KEY SHARE`. Vì vậy không có chu trình khóa.

```mermaid
sequenceDiagram
    participant C as Customer
    participant G as JWT / Roles / ValidationPipe
    participant S as AccountOpeningService
    participant DB as PostgreSQL
    participant A as AuditService
    C->>G: POST /v1/accounts {type}
    G->>S: userId, type, correlationId
    S->>DB: BEGIN; SELECT id FROM customers WHERE user_id=$1 FOR UPDATE
    alt không có hàng customers
      S->>A: record REJECTED (cùng manager)
      S->>DB: COMMIT
      S-->>C: 404
    else có
      S->>DB: SELECT count(*) FROM accounts WHERE customer_id=$1
      alt count >= 3
        S->>A: record REJECTED (cùng manager)
        S->>DB: COMMIT
        S-->>C: 409 ACCOUNT_LIMIT_REACHED
      else count < 3
        S->>DB: INSERT INTO accounts (customer_id, type)
        S->>A: record SUCCESS (cùng manager)
        S->>DB: COMMIT
        S-->>C: 201
      end
    end
```

- **Thay đổi cấp hệ thống:** docs/03 bảng API (dòng `POST /v1/accounts`: thêm audit `REJECTED` cho 409 và 404, và 503 + `Retry-After` khi hết thời gian chờ khóa) và README module accounts. Không đổi ADR, `_shared`, env, `ErrorCode`, event.
- **Hạn chế chấp nhận:** (a) giới hạn 3 chỉ do quy ước khóa của ứng dụng giữ, admin SQL ngoài API không được bảo vệ; (b) 404 "chưa onboarding" không mang `errorCode` riêng (nhất quán với `GET /v1/customers/me` và docs/03 §7.1: chỉ thêm mã khi client cần rẽ nhánh).
- **Bàn giao cho vai khác (phát hiện ở domain review):** PostgreSQL đòi quyền `UPDATE` trên ít nhất một cột của `customers` cho mọi câu `SELECT … FOR UPDATE`, nhưng ma trận quyền ở database-design §8 chỉ cho role `dbs_api` `S I` trên `customers`. Khi các quyền theo role được áp dụng (DBS-40/41, BL-017), `POST /v1/accounts` sẽ lỗi `42501` → 500. Hiện chưa có `GRANT` nào trong repo và test DB chạy bằng superuser nên không phát hiện được. Đề xuất: người làm phần role cấp `GRANT UPDATE (full_name) ON customers TO dbs_api` (hoặc sửa ma trận) và task đó phụ thuộc vào kết quả này. Không đổi chiến lược khóa. Thêm một dòng `BL-NNN` ở G4.

## 4. Test cases tự động

File `backend/test/db/account-opening.db-spec.ts` (`npm run test:db`), HTTP thật với JWT cục bộ, PostgreSQL thật qua Testcontainers, hồ sơ customer tạo bằng onboarding thật, tài khoản chỉ tạo qua API mới. Sau mỗi case có `checkLedgerInvariants` phải PASS. Không seed số dư hay bút toán bằng SQL; ngoại lệ duy nhất là TC-63-05 dùng `UPDATE accounts SET status='LOCKED'` làm fixture trạng thái vì API khóa chưa có (không stub API khóa).

| ID | Truy vết | Lớp | Given · When · Then | `errorCode` |
|---|---|---|---|---|
| TC-63-01 | DoD #1, #3; FR-ACC-01 | e2e Postgres | Customer đã onboarding mở CHECKING rồi SAVINGS → 201, body đúng từng trường, `balance` là chuỗi `"0"`, `ACTIVE`; dòng DB đúng `customer_id`; audit SUCCESS đúng actor, vai, target, `correlationId`, metadata chỉ có `id` | — |
| TC-63-02 | DoD #1; BR-14 | e2e Postgres | Mở tuần tự 3 lần → 201; lần 4 → 409; DB vẫn đúng 3 dòng; audit REJECTED còn sau 409 với `count: 3` | `ACCOUNT_LIMIT_REACHED` |
| TC-63-03 | DoD #2 | e2e Postgres, đồng thời | 10 request mở cùng lúc (`Promise.all`, loại xen kẽ) cho một customer mới → đúng 3×201 và 7×409; 3 id khác nhau; DB đúng 3 dòng số dư 0; mỗi `correlationId` có đúng 1 dòng audit, SUCCESS (3) hoặc REJECTED (7) với actor, target, metadata đúng | `ACCOUNT_LIMIT_REACHED` |
| TC-63-04 | Expect; ownership | e2e Postgres, đồng thời | Hai customer, mỗi người 5 request cùng lúc → 6×201 + 4×409 (**mọi** 409 mang `errorCode`), mỗi người đúng 3 tài khoản, 3 audit SUCCESS + 2 REJECTED; body có `customerId` của người khác → 400 | `ACCOUNT_LIMIT_REACHED` |
| TC-63-05 | DoD #1 (khóa hàng customers) | e2e Postgres, khóa thật | Một kết nối giữ `FOR UPDATE` hàng customer A; request mở của A bắt đầu; thăm dò `pg_stat_activity` đến khi thấy truy vấn thật sự chờ `Lock`; trong lúc đó chưa có tài khoản, và customer B mở được; nhả khóa → request của A xong 201. Sau đó đặt một tài khoản `LOCKED` (fixture) → vẫn bị tính vào giới hạn | `ACCOUNT_LIMIT_REACHED` |
| TC-63-06 | DoD #3 | e2e Postgres, bảo mật | `SYSTEM`, `checking`, chuỗi SQL, rỗng, `null`, `42`, thiếu `type`, và từng trường thừa `customerId/userId/balance/status/id` → 400; không tạo tài khoản nào | 400 |
| TC-63-07 | Bảo mật; FR-AUD-01/02 | e2e Postgres, bảo mật | Không token → 401; token rác / sai chữ ký → 401; token hết hạn → 401; `operator`/`auditor`/`admin` → 403; customer chưa onboarding → 404 và có đúng 1 audit `REJECTED` (actor, vai `customer`, target `user`, metadata `{id}`) | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `FORBIDDEN` |
| TC-63-08 | DoD #3; FR-AUD-01, NFR-AUD-01 | e2e Postgres, lỗi thật | Trigger làm INSERT `audit_log` luôn lỗi: mở thành công / đủ 3 / chưa onboarding đều 500, thông điệp chung (không lộ SQL, không có "audit unavailable"), tài khoản được rollback, không có dòng audit; bỏ trigger → mở lại 201, đủ 3 vẫn 409, chưa onboarding vẫn 404 | `ACCOUNT_LIMIT_REACHED` |
| TC-63-09 | docs/03 §7 (OpenAPI) | e2e (tài liệu) | OpenAPI có bearer, enum `type` đúng 2 giá trị, ví dụ, và các phản hồi 201/400/401/403/404/409/500/503, ví dụ 409 chứa `ACCOUNT_LIMIT_REACHED` | — |
| TC-63-10 | ADR-04 | e2e Postgres, khóa thật | Một kết nối giữ khóa hàng customer đến quá thời gian chờ khóa → 503 + `Retry-After`; không tài khoản, không audit; nhả khóa → mở lại 201 | `SERVICE_TEMPORARILY_UNAVAILABLE` |
| TC-63-11 | DoD #2 (biên) | e2e Postgres, đồng thời | Customer đã có 2 tài khoản; 5 request mở cùng lúc → đúng 1×201 và 4×409 (`errorCode`), DB đúng 3 tài khoản, audit 1 SUCCESS (mới) + 4 REJECTED | `ACCOUNT_LIMIT_REACHED` |
| Quy trình | DoD #4 | — | PR vào main, CI xanh, Dev khác review, bảng đối chiếu điền đủ | `BL-158` |

**Checklist bảo mật** (`references/testing.md`):

| Yêu cầu | Chỗ thực thi | Case | Ghi chú |
|---|---|---|---|
| Guard vai đúng | controller `@Roles('customer')` | TC-63-07 | |
| Ownership, 404 cho tài nguyên người khác | service | TC-63-04, 06 | Không có id tài nguyên trong request; owner luôn lấy từ JWT, mọi trường owner gửi lên bị 400. Không áp dụng "404 + DENIED cho người khác". |
| Idempotency key theo user | — | không áp dụng | Mỗi lần gọi tạo tài nguyên mới đến tối đa 3 |
| REJECTED cùng transaction, DENIED transaction riêng | service | TC-63-02, 03, 07, 08, 11 | Mọi từ chối nghiệp vụ (đủ 3, chưa onboarding) là `REJECTED` cùng transaction. Không có nhánh `DENIED`: request không mang id tài nguyên của người khác |
| Không có trường fraud trong response | DTO | TC-63-01 | `toEqual` đúng 6 trường |
| Lỗi không lộ nội bộ; có `correlationId` | `ProblemDetailsFilter` | TC-63-08 | |
| SQL có tham số; đầu vào độc hại | service | TC-63-06 | |
| TLS Postgres/Redis; không secret | config | không áp dụng | Không đổi cấu hình |

**Thay đổi test so với file hiện có (làm ở Phase 4, sau G3):** TC-63-04 thêm khẳng định `errorCode` và audit; TC-63-07 thêm token rác, đổi kỳ vọng `DENIED` → `REJECTED` kèm `actor_role` và `metadata`; thêm TC-63-11. TC-63-03 và TC-63-05 giữ nguyên: TC-63-03 chứng minh kết quả đúng dưới 10 request đồng thời, còn việc các request thực sự chờ nhau được chứng minh riêng ở TC-63-05.

**Chưa có test, ghi để reviewer thấy:** không có test cho việc admin SQL chèn thẳng tài khoản thứ 4 (ngoài phạm vi, đã nêu ở §3); không có test thu hồi phiên (do guard Identity, task khác).

## 5. Test thủ công

Chạy trên **ứng dụng thật** (`npm run start:dev`, `APP_ROLE=both`) với PostgreSQL, Valkey và ElasticMQ thật, token thật từ `auth:dev-token` (DBS-53), bằng `curl` và `psql`. Output thô ghi vào `docs/features/screenshots/DBS-63/manual-test.txt` (đường dẫn tính từ gốc repo; Git Bash, `tee -a`), dòng đầu là SHA commit cuối cùng đổi code.

**Điều kiện chạy:** từ gốc repo `docker compose up -d` (nếu cổng 5432 đã bị Postgres khác dùng: chạy Postgres riêng `dbs63-pg` ở cổng 55432 với `banking/banking_local_only` và đặt `DATABASE_URL` tương ứng, ghi ở §1 và §8). Từ `backend/`: `cp env/.env.example env/.env.development`, `npm run auth:dev-keys`, chú thích mọi dòng `COGNITO_*` và thêm `AUTH_MODE=local`, `AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json`; `npm run migration:run`; `npm run start:dev`. Token: `TOKEN=$(npm run --silent auth:dev-token -- --role customer --sub nguyen-minh-anh)`.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-63-01 | `POST /v1/customers/me {"fullName":"Nguyễn Minh Anh"}`, rồi `POST /v1/accounts` với `CHECKING` và `SAVINGS`. `psql`: các tài khoản và audit | 200, rồi 201 hai lần, `balance:"0"`, `ACTIVE`; 2 dòng `accounts`, 2 audit `SUCCESS` `account.open` |
| M-63-02 | Mở thêm lần 3 (201) và lần 4 | lần 3 → 201; lần 4 → 409 `ACCOUNT_LIMIT_REACHED` kèm `correlationId`; `psql`: 3 tài khoản, 1 audit `REJECTED` `count:3` |
| M-63-03 | Customer mới `--sub tran-thu-ha`, onboarding, rồi 10 `curl` chạy song song (`xargs -P 10`) | đúng 3×201 và 7×409; `psql`: 3 tài khoản, 3 audit SUCCESS + 7 REJECTED |
| M-63-04 | `"type":"SYSTEM"`; body có `"customerId"`; không token; token `--role operator`; customer chưa onboarding (`--sub pham-ngoc-lan`) | 400; 400; 401; 403; 404 và 1 audit `REJECTED` (target `user`, metadata `{id}`); không tài khoản nào được tạo |
| M-63-05 | Customer mới `--sub le-hoang-nam`: onboarding (`"fullName":"Lê Hoàng Nam"`) → 200. `psql`: tạo trigger làm `audit_log` luôn lỗi. Mở tài khoản. Bỏ trigger, mở lại | onboarding 200 trước khi có trigger; mở khi có trigger → 500 chung chung, `accounts` của người đó = 0 và không có audit `account.open` cho `correlationId` đó; sau khi bỏ trigger → 201, `balance:"0"` |
| M-63-06 | Chạy `npm run --silent check:invariants` | thoát mã 0, `PASS`, không vi phạm |
| M-63-07 | Dừng app, dọn container riêng và dữ liệu thử | không còn tiến trình hay container của task |

Bước ép khóa quá thời gian (503) được chứng minh bằng TC-63-10 chứ không có bước tay riêng. `backend/scripts/manual-dbs63.cjs` chạy một app dựng trong test-support với JWKS giả, nên **không thay** cho các bước trên.

## 6. Domain review (AI)

**Reviewer:** subagent mới, model Opus ở mức effort medium (**người dùng chọn rõ ràng**, thay cho "model mạnh nhất" mà skill yêu cầu), 2026-11-07 · **Kết quả:** 9 phát hiện (blocking 0, should-fix 2, minor 7), verdict **REVISE** · [trả lời nguyên văn](screenshots/DBS-63/domain-review.md). Lần review trước (Codex, cùng model với tác giả code) đã bị thay thế; bản đó còn trong lịch sử git.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix (bàn giao) | `SELECT … FOR UPDATE` trên `customers` cần quyền `UPDATE` một cột, mà ma trận quyền chỉ cho `dbs_api` `S I`; lỗi `42501` → 500 khi quyền role được áp dụng. Test chạy bằng superuser nên không bắt được | Đã xác minh với nguồn. Không sửa trong task này; ghi vào §3 là bàn giao, thêm dòng `BL-NNN` ở G4, liên quan BL-017 |
| 2 | should-fix | M-63-05 không onboarding trước khi tạo trigger, nên onboarding lỗi và kết quả "0 tài khoản" đúng một cách tầm thường | Đã sửa §5 (onboarding → trigger → mở → bỏ trigger → mở lại). Đã xác minh: `createOrGet` ghi audit trong cùng transaction |
| 3 | minor | `DENIED` cho "chưa onboarding" sai định nghĩa (`DENIED` là từ chối quyền), không nhất quán với `GET /me` | Đã sửa §2/§3/§4: chuyển sang `REJECTED` cùng transaction, giải thích lý do, nêu khác biệt với GET. **Đổi hành vi so với code hiện có, là câu hỏi 1 của G2** |
| 4 | minor | TC-63-04 không khẳng định `errorCode` của 4 lần 409 và không kiểm audit | Đã sửa §4; sửa test ở Phase 4 |
| 5 | minor | §2.5 hứa 401 cho token sai nhưng test chỉ có thiếu và hết hạn; DENIED không kiểm `actor_role`/`metadata` | Đã sửa §4 (thêm token rác, kiểm `actor_role` và `metadata`); sửa test ở Phase 4 |
| 6 | minor | Thiếu ca biên 2 tài khoản + N request song song; TC-63-03 không chứng minh các request thật sự chồng nhau | Đã thêm TC-63-11. Không thêm kiểm chồng nhau vào TC-63-03: TC-63-05 đã chứng minh chờ khóa thật, ghi rõ ở §4 |
| 7 | minor | "Không có hai khóa" không chính xác (có `FOR KEY SHARE` qua khóa ngoại) | Đã sửa §3, liệt kê khóa và lý do không có chu trình |
| 8 | minor | §5: đường dẫn `manual-test.txt` sai nếu chạy từ `backend/`; ghi chú đổi cổng phải ở §1 | Đã sửa §5 (đường dẫn từ gốc repo, ghi ở §1 và §8) |
| 9 | minor | Dòng API ở docs/03 thiếu audit và 503 | Ghi ở §3 "Thay đổi cấp hệ thống"; sửa file ở Phase 5 |

**Vòng 2** (cùng reviewer, chạy lại trên §2–§5): 2 phát hiện, verdict **REVISE**. Cả 9 phát hiện vòng 1 được xác nhận đã xử lý.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| R2-1 | blocking | `metadata.reason = CUSTOMER_PROFILE_MISSING` không hợp lệ: `serializeMetadata` chỉ nhận `ErrorCode` hoặc `AuditReason` (`audit-metadata.guard.ts`), nên `record()` ném lỗi và đường chưa onboarding luôn trả 500 | Đã xác minh với code. Đã sửa §2, §4 (TC-63-07), §5 (M-63-04): bỏ `reason`, dùng `metadata {id}` như code hiện tại đang ghi; không đổi module audit hay `ErrorCode` |
| R2-2 | minor | §3 ngụ ý đã có đường ghi `users.sessions_revoked_at`; hiện chưa có trong code | Đã sửa §3 thành quy tắc cho tương lai |

**Vòng 3 chưa chạy.** Bản sửa R2-1 chính là phương án thay thế mà reviewer đề xuất, và `{id}` đã được code hiện tại ghi thành công (TC-63-07 đang đạt với `metadata {id}`), nên mình không chạy thêm vòng. Nếu bạn muốn đúng quy tắc "review lại mọi mục đã đổi" thì nói, mình chạy vòng 3.

**Quyết định ở G2:** (chờ người duyệt)

## 7. Implementation plan

1. Resolve dependency choice; actual DBS-62 base only if explicitly approved. Retain separate DBS-63 commits.
2. Write HTTP/PostgreSQL cases first; run and record red404 for missing POST /v1/accounts.
3. Add DTO, module-private opening service with parent lock/count/insert/audit, controller and module registration. No public primitive signature changes.
4. Prove concurrency, actual lock blocking/isolation, audit commit/rollback/denial, auth/validation/OpenAPI; lint/typecheck/build/unit/e2e and relevant real DB suites. Reuse exact preceding dependency baseline checks for identical source where applicable; disclose known BL-112 local unit timing failure rather than claim green baseline.
5. Manual driver on final code commit, all six steps and actual screenshot/transcript; invariant checker after business cases.
6. Update Accounts README, docs03 POST contract, feature index/backlog and test mapping; doc link check. Commit/push per user's existing workflow. Main-based Draft PR after DBS-62 merge, then actual final CI; no stacked PR silently created.

Rollback: remove DBS-63-only commits; no schema/data teardown or shared DB revert. No migration needed. Parent locking assumes all customer-account creation follows this service; count is not a schema invariant and administrator SQL is not covered.

## 8. Results / handoff

Implemented AccountOpeningService, AccountsController and DTOs; registered in the real AccountsModule. New HTTP/PostgreSQL suite has10 cases, all passed. Four related DB suites75/75 passed (42.017s), including actual onboarding/AccountsService/AuditService. Full unit55 suites826/826 passed (190.029s); full E2E13 suites135/135 passed (158.212s). Lint/typecheck/build passed. Manual6/6 passed on code commit. No skipped task tests. Full DB suite not rerun; the four related PostgreSQL suites cover affected modules. Doc links202 files/0 broken.

Test-first evidence: after fixing a TypeScript test-helper signature (unknown body vs Supertest object), all10 tests failed as expected because POST /v1/accounts was absent (404, no OpenAPI route). Production code was written after that red run; all10 passed, then strengthened concurrent audit actor/target assertions and reran related suites75/75.

User's existing request skips gate pauses, not design review/tests/evidence. No human gate approval claimed. Existing known handoffs BL-112/121/130/132/017/122/008 remain; process dependency/PR handoff gets next free BL id at delivery if still pending.

Initial checks on main a9e607b: docker compose up -d succeeded (all3 local services running); local lint:check/typecheck passed; main CI [41840640181](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/41840640181) has6 required jobs green. Main branch deliberately has no onboarding; User explicitly approved temporary DBS-62 source via the dependency question on2026-11-04; branch fast-forwarded to7d41a51 before implementation. Separate DBS-63 branch published at handover; no PR before dependency merge, shared status edit, or test stub.

Implementation commit `eb645902758d0f6d885fa3d494aa797d33bf321d`. Manual driver executed on that commit; [raw transcript](screenshots/DBS-63/manual-test.txt), [verification summary](screenshots/DBS-63/verification.txt), [prepared PR mapping](screenshots/DBS-63/pr-description.md).

| Case / DoD | Evidence in account-opening.db-spec.ts | Result |
|---|---|---|
| TC-63-01 / DoD1/3 | Both labels, own FK, zero string/ACTIVE, exact SUCCESS audit | Matched |
| TC-63-02 / BR-14 | Third201/fourth409 and committed REJECTED audit | Matched |
| TC-63-03 / DoD2 | 10 simultaneous first requests; exactly3 distinct accounts/7 correct409; every audit actor,target,metadata,correlation verified | Matched |
| TC-63-04 / ownership | Independent limits for two customers; forged owner400 | Matched |
| TC-63-05 / locking | Observe actual pg_stat_activity Lock; other customer proceeds; LOCKED account counted (status-only SQL input fixture, no balance seed) | Matched |
| TC-63-06 / DoD3 | SYSTEM/bad types and privileged extra fields400, no accounts | Matched |
| TC-63-07 / security | Real JWT/roles,401 codes, staff403; missing profile404 and DENIED survives | Matched |
| TC-63-08 / atomic audit | DB trigger fails audit INSERT; success/rejection/denial500, account rollback and subsequent recovery | Matched |
| TC-63-09 / OpenAPI | Allowed enum, DTO/example, bearer role, success and errors incl503 | Matched |
| TC-63-10 / recovery | Real parent-lock timeout503 stable code/Retry-After, no account/audit, release/retry201 | Matched |
| DoD4 / process | BL-145 | Main-based PR/CI/Dev review/merge pending, not claimed complete |

All business cases end with actual ledger-invariant checker PASS, zero violations. Only account initialization at default zero; no funds moved, deposits/transfers synthesized or balance UPDATE.

| Manual step | Actual result on code commit |
|---|---|
| M-63-01 | CHECKING and SAVINGS201, zero string/ACTIVE; rows2/audit SUCCESS2, invariants PASS |
| M-63-02 | Third201/fourth409; count3, REJECTED audit committed, invariants PASS |
| M-63-03 | 10 real parallel POSTs ->3 success7 rejection; actual audit counts3+7, invariants PASS |
| M-63-04 | SYSTEM/forged owner400;401/403; missing onboarding404 with stored DENIED; invariants PASS |
| M-63-05 | Audit trigger fault500 rolls back account; remove trigger/retry201, zero, invariants PASS |
| M-63-06 | App/public JWKS/temp DB/owned PostgreSQL container cleaned up |

![Actual HTTP output excerpt](screenshots/DBS-63/01-http-results.png)

Historical BL-145 dependency handoff is now resolved by rebase after PR56 merge; current PR/CI/review state is recorded in the final handover below. No PR against dependency branch, board edit or auto-merge. BL-145 remains open only for final CI/Dev review/merge.

Historical pre-merge fetch2026-11-04: PR56 was still open/unmerged and origin/main a9e607b. [Published DBS-63 branch](https://github.com/Lawliet119/digital-banking-simulator/tree/feat/DBS-63-open-accounts). At that historical handoff no GitHub CI/Dev review/merge was claimed for DBS-63; see current handover below. Delivery checklist: design/re-review APPROVE, all ten planned cases matched, local automated checks and six manual steps complete; raw output inspected for credential markers and screenshot visually checked; source SHA recorded; no schema/env/dependency/ErrorCode/ADR/event change. Current final CI and Dev review/merge tracked in BL-145; main PR is now authorized by the follow-up request.

## 9. Sources and changed docs

Exact sheet DBS-63; docs02 UC-2, FR-ACC-01, BR-14, FR-AUD-01/02; docs03 API/error table; shared database-design4.2, event-contract; Accounts/Audit README, actual schema/TransactionService/AuditService, CONTRIBUTING5/5b. Updated Accounts README and docs03 POST API contract, this feature doc, feature index, BACKLOG BL-145 and raw review/test/manual evidence. Public primitive exports and schema unchanged.

## Rebase and final handover ? 2026-11-06

User requested completion after DBS-62 merge. Independently verified PR56 merged into main689a8e8 (GitHub API), then replayed ONLY commits after7d41a51 onto main2df7d0a. Rebasing application code/tests/manual driver caused no conflicts and byte-for-byte task source is unchanged. Resolved BACKLOG/feature-index conflicts by retaining main rows plus DBS63 own row; no duplicate DBS62 row or inherited commits in PR. Rebased source commit a69bfcf; tested tree/manual HEAD b9e68eb includes only later documentation. Manual re-executed6/6 on that exact tree, raw firstline SHA records it. Automated check results, new PR and final CI appended below once observed. No human Dev review/merge claimed; board changes remain with user.

Rebased-tree checks2026-11-06: lint/typecheck/build PASS; full unit56 suites832/832 PASS(50.551s), full e2e13 suites135/135 PASS(83.168s), manual6/6 PASS at b9e68eb. Initial related-DB command had a filename typo(audit-service instead of actual audit.service),62 actual cases passed but command failed ENOENT; corrected command rerun and final result recorded below. Never treated ENOENT as suite success. No task test skips.

Final corrected related-DB command: four suites75/75 PASS(10.185s), including all10 account-opening cases and real parent-lock503/recovery. Full DB suite remains for PR CI; selected75 not claimed fullDB.

Opened [Draft PR58](https://github.com/Lawliet119/digital-banking-simulator/pull/58), base **main**. Final required jobs lint/typecheck/build/unit/e2e/db tracked in [Checks](https://github.com/Lawliet119/digital-banking-simulator/pull/58/checks); actual result verified before handover. Local checks above do not replace CI. Another Dev review and merge pending BL-145. User can move board to In Review after this main-based handover; agent does not edit sheet or merge. Final docs link check209 files0broken.
