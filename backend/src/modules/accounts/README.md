# accounts 🟡 Supporting

> **Status:** Accepted · **Owner:** Dev · **Verified against code:** public service, ownership và audit denial; các API nghiệp vụ còn chờ task endpoint.

Hồ sơ khách hàng, tài khoản, trạng thái khóa.

| | |
|---|---|
| Use case | UC-1 onboarding · UC-2 mở tài khoản · UC-4 xem số dư · UC-11 khóa / mở khóa |
| Chạy ở | `api` và phần API của `both`; chưa nạp trong `worker` |
| Sở hữu bảng | `customers`, `accounts` (gồm tài khoản SYSTEM `funding`) |
| Thiết kế | `docs/03` §6.2 (khóa và thu hồi phiên), §8 · `docs/02` §3 (AC-11.x) |

## Phải giữ

- **Số dư chỉ đổi qua `ledger`.** Module này export `lockForUpdate(ids, manager)` và `applyBalanceChange(…, manager)` cho `ledger` gọi, và nhận transaction của `ledger` — không tự mở transaction riêng cho việc đó.
- Mỗi khách tối đa 3 tài khoản (`ACCOUNT_LIMIT_REACHED`); kiểm tra trong transaction mở tài khoản, khóa hàng `customers`.
- `CHECK (type = 'SYSTEM' OR balance >= 0)` ở mức database.
- Khóa tài khoản = đổi trạng thái **và** thu hồi phiên của chủ tài khoản trong cùng lệnh (gọi `identity`), không chờ sự kiện.
- Truy cập tài khoản không thuộc mình trả **404**, không phải 403.
- `GET /v1/operator/accounts` (FR-ACC-04): nhân viên tìm tài khoản theo `accountId` hoặc tên khách, tối đa 20 kết quả, **không trả số dư**, mỗi lần tra cứu ghi nhật ký.

## Export công khai (`index.ts`)

Import qua `@modules/accounts`: `AccountsModule`, `AccountsService`, các type `Account`, `LockedAccount`, `AccountOwnershipAction`, `AccountOwnershipContext`, ba lớp lỗi `AccountNotLockedError`, `AccountBalanceNegativeError`, `AccountBalanceOverflowError`. `AccountsModule` import public `AuditModule`; DataSource và TransactionService thật do DatabaseModule global cung cấp.

| Hàm | Contract service hiện có |
|---|---|
| `lockForUpdate(ids: string[], manager: EntityManager): Promise<LockedAccount[]>` | Manager phải có QueryRunner còn hoạt động, ở **cấp transaction ngoài cùng** (không trong `manager.transaction` lồng). SQL lấy khóa account theo id tăng dần; duplicate được bỏ, empty trả `[]`, id thiếu chỉ bị loại khỏi snapshot. Tối đa 16 id khác nhau và 256 phần tử, vượt thì `TypeError` trước SQL. LOCKED/SYSTEM vẫn được trả để caller quyết định guard |
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

Module cung cấp primitive cho ledger và ownership; chưa thêm HTTP controller, onboarding, mở/khóa tài khoản, guard chuyển tiền hoặc bút toán. Test tiền gọi service thật trên DB tạm rồi rollback; không SQL seed tiền/bút toán. [DBS-55](../../../../docs/features/DBS-55-accounts-service.md) giữ bằng chứng primitive tiền; [DBS-86](../../../../docs/features/DBS-86-resource-ownership.md) mô tả contract ownership, kiểm PostgreSQL và các phần bàn giao. Endpoint account của DBS-64, transfer của DBS-61 và history/status của DBS-87 còn phải tích hợp và kiểm từng đường HTTP; kết quả service chưa hoàn tất full AC-5.8.
