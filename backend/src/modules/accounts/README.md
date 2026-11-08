# accounts 🟡 Supporting

> **Status:** Accepted · **Owner:** Dev · **Verified against code:** public service, ownership và audit denial; các API nghiệp vụ còn chờ task endpoint.

Hồ sơ khách hàng, tài khoản, trạng thái khóa.

|             |                                                                             |
| ----------- | --------------------------------------------------------------------------- |
| Use case    | UC-1 onboarding · UC-2 mở tài khoản · UC-4 xem số dư · UC-11 khóa / mở khóa |
| Chạy ở      | `api` và phần API của `both`; chưa nạp trong `worker`                       |
| Sở hữu bảng | `customers`, `accounts` (gồm tài khoản SYSTEM `funding`)                    |
| Thiết kế    | `docs/03` §6.2 (khóa và thu hồi phiên), §8 · `docs/BRD.md` Phần 2 §3 (AC-11.x)         |

## Phải giữ

- **Số dư chỉ đổi qua `ledger`.** Module này export `lockForUpdate(ids, manager)` và `applyBalanceChange(…, manager)` cho `ledger` gọi, và nhận transaction của `ledger` — không tự mở transaction riêng cho việc đó.
- Mỗi khách tối đa 3 tài khoản (`ACCOUNT_LIMIT_REACHED`); kiểm tra trong transaction mở tài khoản, khóa hàng `customers`.
- `CHECK (type = 'SYSTEM' OR balance >= 0)` ở mức database.
- Khóa tài khoản = đổi trạng thái **và** thu hồi phiên của chủ tài khoản trong cùng lệnh (gọi `identity`), không chờ sự kiện.
- Truy cập tài khoản không thuộc mình trả **404**, không phải 403.
- `GET /v1/operator/accounts` (FR-ACC-04): nhân viên tìm tài khoản theo `accountId` hoặc tên khách, tối đa 20 kết quả, **không trả số dư**, mỗi lần tra cứu ghi nhật ký.

## Export công khai (`index.ts`)

Import qua `@modules/accounts`: `AccountsModule`, `AccountsService`, các type `Account`, `LockedAccount`, `AccountOwnershipAction`, `AccountOwnershipContext`, ba lớp lỗi `AccountNotLockedError`, `AccountBalanceNegativeError`, `AccountBalanceOverflowError`. `AccountsModule` import public `AuditModule`; DataSource và TransactionService thật do DatabaseModule global cung cấp.

| Hàm                                                                                           | Contract service hiện có                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lockForUpdate(ids: string[], manager: EntityManager): Promise<LockedAccount[]>`              | Manager phải có QueryRunner còn hoạt động, ở **cấp transaction ngoài cùng** (không trong `manager.transaction` lồng). SQL lấy khóa account theo id tăng dần; duplicate được bỏ, empty trả `[]`, id thiếu chỉ bị loại khỏi snapshot. Tối đa 16 id khác nhau và 256 phần tử, vượt thì `TypeError` trước SQL. LOCKED/SYSTEM vẫn được trả để caller quyết định guard                                                                                             |
| `applyBalanceChange(accountId: string, delta: bigint, manager: EntityManager): Promise<void>` | Cộng số dư bằng SQL trong transaction người gọi, `updated_at = clock_timestamp()`; nhận bigint, không tự mở/commit/retry. Account phải đã có trong kết quả `lockForUpdate` của **cùng QueryRunner, cùng transaction**, nếu không thì `AccountNotLockedError` (kể cả id không tồn tại). Khách xuống âm → `AccountBalanceNegativeError`; tràn signed bigint → `AccountBalanceOverflowError`; lỗi gốc nằm ở `cause`. Lỗi DB khác (deadlock, timeout) ném nguyên |
| `getOwnedAccount(accountId: string, context: AccountOwnershipContext): Promise<Account>` | Context bắt buộc lấy từ server sau JWT/customer guard. Owner hợp lệ trả snapshot, kể cả LOCKED, không tự ghi SUCCESS. Missing/foreign/SYSTEM/resource UUID sai đều await một audit DENIED đã commit rồi trả cùng 404. Lỗi lookup hoặc audit lan ra; context sai và lời gọi trong callback transaction bị chặn trước SELECT |

Snapshot dùng camelCase, `balance` là chuỗi chính xác, thời gian là Date. Không đổi tiền sang Number hoặc cache Redis. Các truy vấn mutation dùng manager đã truyền vào; `startTransaction()` phải chạy trước, raw SQL BEGIN không đáp ứng trạng thái QueryRunner. Invalid UUID/array (kể cả sparse array) hoặc delta không-bigint bị chặn trước SQL. Không bắt lỗi SQL để tiếp tục transaction đã bị abort.

### Context kiểm quyền sở hữu

[AccountOwnershipContext](account.types.ts) gồm `userId`, `role`, `action`, `correlationId`. Caller tạo nó sau khi JWT đã được xác minh và endpoint đã chấp nhận vai customer:

```ts
await accounts.getOwnedAccount(accountId, {
  userId: currentUser.userId,
  role: 'customer',
  action: 'account.read',
  correlationId: request.correlationId,
});
```

`userId` là internal `users.id`; `correlationId` do middleware server sinh. Action do endpoint chọn trong `account.read`, `account.transactions`, `ledger.transfer`. Với token nhiều nhóm, caller chọn literal customer theo policy endpoint. Không bind context từ body/query/header hoặc lấy `roles[0]`. Helper này phục vụ tài nguyên của khách; operator search/deposit/lock dùng policy operator riêng.

Service snapshot mỗi scalar đúng một lần trước await, chuẩn hóa UUID thành chữ thường và không serialize context. Context thiếu, chữ ký userId string cũ, actor/correlation sai UUID hoặc role/action ngoài allowlist gây TypeError cố định trước SQL. Actor UUID đúng dạng nhưng không tồn tại trong `users` làm audit FK từ chối (`23503`); lỗi lan ra thay vì trả 404 sạch.

Foreign/missing/SYSTEM dùng cùng `AuditReason.NOT_OWNER`. Resource id sai dạng không SELECT account; audit dùng target `{type:'account',id:'invalid'}`. Resource UUID hợp lệ dùng target UUID đã chuẩn hóa. Mỗi denial ghi actor customer, action đã chọn, server correlation và metadata `{reason:'NOT_OWNER'}` qua `AuditService.recordDenied`; không chép input thô hay dữ liệu hồ sơ. Audit INSERT/commit lỗi phải làm lời gọi thất bại, không bắt lỗi để tiếp tục trả 404.

Gọi ownership **trước** `TransactionService.run` nghiệp vụ. Service kiểm `activeTransactionContext` trước SELECT ở cả đường owned và denied để tránh giữ thêm connection audit trong transaction. ALS chỉ theo dõi transaction helper hiện có; raw BEGIN/savepoint tự viết nằm ngoài khả năng phát hiện này và không được dùng để bọc ownership.

### Hợp đồng với ledger (BL-122)

- Gọi `lockForUpdate` rồi `applyBalanceChange` trên **cùng `manager`** của một `TransactionService.run`. Không bọc chúng trong `manager.transaction` lồng. Không để `SAVEPOINT` viết tay nào đang mở khi lock, và không `ROLLBACK TO SAVEPOINT` giữa lock và apply: `ROLLBACK TO SAVEPOINT` nhả khóa hàng mà service không phát hiện được với savepoint viết tay.
- So snapshot với các id đã yêu cầu **trước** khi apply. Chuyển tới đích không tồn tại và nạp vào tài khoản không tồn tại là `REJECTED` / 422 `ACCOUNT_NOT_ACTIVE` (`to_account_id` NULL). Nguồn không thuộc caller bị chặn trước transaction (404, audit DENIED trong transaction riêng). Thiếu `funding` là lỗi cài đặt (500).
- Guard quyết định REJECTED (số dư, trạng thái, hạn mức) **trước** UPDATE. Ba lớp lỗi ở trên nghĩa là guard hoặc giao thức của caller có bug: chúng phải ra 500, không map sang 422, vì sau khi PostgreSQL từ chối UPDATE transaction đã hủy, không còn ghi được `transfers` REJECTED, audit hay response idempotency (BR-07).

Primitive cho ledger được chứng minh trong [DBS-55](../../../../docs/features/DBS-55-accounts-service.md). Test tiền gọi service thật trên DB tạm rồi rollback; không SQL seed tiền/bút toán. Mở/khóa tài khoản, guard chuyển tiền và bút toán thuộc task riêng.

## Onboarding (DBS-62)

`POST /v1/customers/me` dành cho customer, nhận `{fullName}` (NFC, trim, 1–200 ký tự, không control character). Trả 200 `{id,fullName,createdAt}` cho cả tạo mới và gọi lại; tên đã lưu không bị cập nhật. UNIQUE `customers.user_id` và INSERT ON CONFLICT DO NOTHING bảo vệ request đồng thời. Caller chỉ lấy từ JWT đã xác minh; không nhận owner từ body/query. `GET /v1/customers/me` trả hồ sơ của caller hoặc 404 nếu chưa tạo.

`CustomerProfileService` nội bộ dùng TransactionService và AuditService thật: `customer.created` khi tạo, `customer.read` khi GET/replay, cùng transaction với dữ liệu; lỗi audit trả 500, không tiết lộ hồ sơ và rollback mutation. Metadata chỉ có id, không có tên/token. Không tạo tài khoản hoặc sửa số dư. Test HTTP với JWT local và PostgreSQL thật, gồm 20 request song song và lỗi audit, nằm trong [DBS-62](../../../../docs/features/DBS-62-customer-onboarding.md).

## Mở tài khoản (DBS-63)

`POST /v1/accounts` dành cho customer đã onboarding; body chỉ có `{type: "CHECKING" | "SAVINGS"}`. Trả 201 `{id,type,status,balance,createdAt,updatedAt}`, số dư là chuỗi `"0"`, trạng thái `ACTIVE`. Mỗi lần gọi tạo tài khoản mới cho caller đến tối đa ba tài khoản; tài khoản LOCKED cũng được tính. SYSTEM và các trường owner/balance/status/id do client gửi bị từ chối 400.

`AccountOpeningService` nội bộ khóa hàng `customers` của caller bằng `FOR UPDATE`, rồi COUNT và INSERT trong cùng transaction READ COMMITTED. Audit SUCCESS cùng manager với INSERT. Đủ ba tài khoản: audit REJECTED được commit trước khi trả 409 `ACCOUNT_LIMIT_REACHED`. Chưa onboarding: audit REJECTED (target `user`) cùng transaction, rồi trả 404 sau commit; khác `GET /v1/customers/me` (404, không audit) vì đây là một lệnh ghi bị từ chối. Lỗi audit bất ngờ trả 500 và rollback; lỗi DB tạm thời trả 503 `SERVICE_TEMPORARILY_UNAVAILABLE` với `Retry-After` theo filter hiện có. Không phát sự kiện mới hoặc thay đổi số dư/bút toán. `SELECT … FOR UPDATE` cần quyền `UPDATE` một cột của `customers` cho role ứng dụng; `infra/scripts/db-roles.sql` cấp `UPDATE (full_name)` và `test/db/db-roles.db-spec.ts` chứng minh mở tài khoản chạy được bằng `dbs_api`. Chứng minh request đồng thời, parent lock, timeout/recovery và audit tại [DBS-63](../../../../docs/features/DBS-63-open-accounts.md).

## Đọc tài khoản và số dư (DBS-64)

`GET /v1/accounts` trả mảng tài khoản của caller (cả ACTIVE/LOCKED), thứ tự createdAt rồi id; chưa có tài khoản trả `[]`. `GET /v1/accounts/{id}` trả đúng một tài khoản thuộc caller. Cả hai trả `{id,type,status,balance,createdAt,updatedAt}`; balance là chuỗi thập phân chính xác qua `@common/money`, không có tên, ownerId hoặc dữ liệu fraud. UUID không hợp lệ, thiếu, của người khác hoặc SYSTEM đều trả cùng 404.

`AccountQueryService` dùng PostgreSQL trực tiếp, SQL JOIN customer lọc internal users.id đã xác minh, không cache Redis. SELECT và audit SUCCESS cùng transaction; chỉ trả dữ liệu sau commit. Không có owned row: ghi DENIED riêng bên ngoài transaction rồi mới trả 404; path không hợp lệ không được lưu vào metadata. Audit lỗi trả 500/503 thay vì tiết lộ balance. Số dư phản ánh dữ liệu đã commit tại thời điểm SELECT; có thể có giao dịch khác commit sau đó. Chứng minh đọc số dư sau nạp tiền thật (kể cả >2^53), audit và phép đo p95 HTTP sơ bộ tại [DBS-64](../../../../docs/features/DBS-64-read-accounts.md).

## Operator tra cứu tài khoản của khách (DBS-88)

`GET /v1/operator/accounts?q=` (`@Roles('operator')`, chỉ operator): `q` là một UUID đầy đủ thì tìm `accountId`, còn lại tìm một phần, không phân biệt hoa thường, theo `customers.full_name` (`ILIKE … ESCAPE ''`, `%`/`_` là chữ thường). Tối đa 20 dòng; mỗi dòng chỉ `id`, `type`, `status`, `ownerName` (DTO chép từng trường, SQL không chọn `balance`). `JOIN customers` nên không bao giờ trả tài khoản `funding`. Không có index trên `full_name` (database-design §6.2): với 50.000 khách và từ khóa trùng 10% tên, Seq Scan mất khoảng 25 ms ([DBS-88](../../../../docs/features/DBS-88-operator-account-search.md) M-88-06).

Mỗi lần tra cứu hợp lệ ghi audit `operator.account.search` trong cùng transaction với việc đọc (audit lỗi thì không trả dữ liệu). Audit không lưu tên khách vì bộ khóa metadata là danh sách đóng: `target` là `accountId` (tìm theo id) hoặc `account_search` + 32 ký tự đầu SHA-256 của từ khóa (tìm theo tên), `metadata.count` là số kết quả. Muốn tra ngược, băm từ khóa đã biết và tìm `target_id`.
