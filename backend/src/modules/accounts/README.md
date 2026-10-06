# accounts 🟡 Supporting — #2

Hồ sơ khách hàng, tài khoản, trạng thái khóa.

| | |
|---|---|
| Use case | UC-1 onboarding · UC-2 mở tài khoản · UC-4 xem số dư · UC-11 khóa / mở khóa |
| Chạy ở | `api` |
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

`AccountsService` với `lockForUpdate`, `applyBalanceChange`, `getOwnedAccount`.
