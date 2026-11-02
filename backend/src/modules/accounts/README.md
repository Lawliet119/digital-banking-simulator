# accounts 🟡 Supporting

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

Import qua `@modules/accounts`: `AccountsModule`, `AccountsService`, type `Account` và `LockedAccount`, ba lớp lỗi `AccountNotLockedError`, `AccountBalanceNegativeError`, `AccountBalanceOverflowError`.

| Hàm | Contract service hiện có |
|---|---|
| `lockForUpdate(ids: string[], manager: EntityManager): Promise<LockedAccount[]>` | Manager phải có QueryRunner còn hoạt động, ở **cấp transaction ngoài cùng** (không trong `manager.transaction` lồng). SQL lấy khóa account theo id tăng dần; duplicate được bỏ, empty trả `[]`, id thiếu chỉ bị loại khỏi snapshot. Tối đa 16 id khác nhau và 256 phần tử, vượt thì `TypeError` trước SQL. LOCKED/SYSTEM vẫn được trả để caller quyết định guard |
| `applyBalanceChange(accountId: string, delta: bigint, manager: EntityManager): Promise<void>` | Cộng số dư bằng SQL trong transaction người gọi, `updated_at = clock_timestamp()`; nhận bigint, không tự mở/commit/retry. Account phải đã có trong kết quả `lockForUpdate` của **cùng QueryRunner, cùng transaction**, nếu không thì `AccountNotLockedError` (kể cả id không tồn tại). Khách xuống âm → `AccountBalanceNegativeError`; tràn signed bigint → `AccountBalanceOverflowError`; lỗi gốc nằm ở `cause`. Lỗi DB khác (deadlock, timeout) ném nguyên |
| `getOwnedAccount(accountId: string, userId: string): Promise<Account>` | `userId` là internal `users.id`, không phải Cognito sub. Đọc committed state từ PostgreSQL. Missing/foreign/SYSTEM/UUID sai cùng trả 404; không tạo audit DENIED thay caller |

Snapshot dùng camelCase, `balance` là chuỗi chính xác, thời gian là Date. Không đổi tiền sang Number hoặc cache Redis. Các truy vấn mutation dùng manager đã truyền vào; `startTransaction()` phải chạy trước, raw SQL BEGIN không đáp ứng trạng thái QueryRunner. Invalid UUID/array (kể cả sparse array) hoặc delta không-bigint bị chặn trước SQL. Không bắt lỗi SQL để tiếp tục transaction đã bị abort.

### Hợp đồng với ledger (BL-122)

- Gọi `lockForUpdate` rồi `applyBalanceChange` trên **cùng `manager`** của một `TransactionService.run`. Không bọc chúng trong `manager.transaction` lồng. Không để `SAVEPOINT` viết tay nào đang mở khi lock, và không `ROLLBACK TO SAVEPOINT` giữa lock và apply: `ROLLBACK TO SAVEPOINT` nhả khóa hàng mà service không phát hiện được với savepoint viết tay.
- So snapshot với các id đã yêu cầu **trước** khi apply. Chuyển tới đích không tồn tại và nạp vào tài khoản không tồn tại là `REJECTED` / 422 `ACCOUNT_NOT_ACTIVE` (`to_account_id` NULL). Nguồn không thuộc caller bị chặn trước transaction (404, audit DENIED trong transaction riêng). Thiếu `funding` là lỗi cài đặt (500).
- Guard quyết định REJECTED (số dư, trạng thái, hạn mức) **trước** UPDATE. Ba lớp lỗi ở trên nghĩa là guard hoặc giao thức của caller có bug: chúng phải ra 500, không map sang 422, vì sau khi PostgreSQL từ chối UPDATE transaction đã hủy, không còn ghi được `transfers` REJECTED, audit hay response idempotency (BR-07).

Primitive cho ledger được chứng minh trong [DBS-55](../../../../docs/features/DBS-55-accounts-service.md). Test tiền gọi service thật trên DB tạm rồi rollback; không SQL seed tiền/bút toán. Mở/khóa tài khoản, guard chuyển tiền và bút toán thuộc task riêng.

## Onboarding (DBS-62)

`POST /v1/customers/me` dành cho customer, nhận `{fullName}` (NFC, trim, 1–200 ký tự, không control character). Trả 200 `{id,fullName,createdAt}` cho cả tạo mới và gọi lại; tên đã lưu không bị cập nhật. UNIQUE `customers.user_id` và INSERT ON CONFLICT DO NOTHING bảo vệ request đồng thời. Caller chỉ lấy từ JWT đã xác minh; không nhận owner từ body/query. `GET /v1/customers/me` trả hồ sơ của caller hoặc 404 nếu chưa tạo.

`CustomerProfileService` nội bộ dùng TransactionService và AuditService thật: `customer.created` khi tạo, `customer.read` khi GET/replay, cùng transaction với dữ liệu; lỗi audit trả 500, không tiết lộ hồ sơ và rollback mutation. Metadata chỉ có id, không có tên/token. Không tạo tài khoản hoặc sửa số dư. Test HTTP với JWT local và PostgreSQL thật, gồm 20 request song song và lỗi audit, nằm trong [DBS-62](../../../../docs/features/DBS-62-customer-onboarding.md).
