# modules

Mỗi thư mục là một module nghiệp vụ (một bounded context ở `docs/02` §6). Bảng dưới là nguồn tham chiếu nhanh; chi tiết nằm trong README của từng module.

| Module | Loại | Use case | Role chạy |
|---|---|---|---|
| [`ledger`](ledger/README.md) | 🔴 Core | UC-3, 5, 6, 7 | api |
| [`accounts`](accounts/README.md) | 🟡 Supporting | UC-1, 2, 4, 11 | api |
| [`identity`](identity/README.md) | ⚪ Generic | UC-1, 11 | api |
| [`risk`](risk/README.md) | 🟠 Supporting | UC-9, 10, 12 | api + worker |
| [`audit`](audit/README.md) | 🟡 Supporting | UC-8 | api + worker (thư viện cho mọi module) |
| [`outbox`](outbox/README.md) | Hạ tầng sự kiện | — | writer: api + worker; relay: worker (chưa có) |
| [`notification`](notification/README.md) | ⚪ Generic | — | worker (chưa có code) |
| [`health`](health) | Hạ tầng | — | api |

## Quy tắc (được `eslint` ép, xem `backend/eslint.config.mjs`)

1. **Mỗi module có một `index.ts` — đó là API công khai duy nhất.** Chỉ export những gì module khác được phép dùng (service, type, hằng số), không export entity hay repository.
2. **Module khác chỉ import qua index:** `import { AccountsService } from '@modules/accounts'`.
3. **Cấm với tay vào ruột module khác**, cả qua alias (`@modules/accounts/accounts.service`) lẫn đường dẫn tương đối (`../accounts/accounts.service`).
4. **Code dùng chung import qua alias**: `@common/…`, `@config/…`, `@database/…`, `@libs/…`. `../` chỉ dùng trong phạm vi module của mình.
5. **Không module nào đọc/ghi bảng của module khác.** Cần dữ liệu → gọi hàm module đó export, truyền `EntityManager` của transaction hiện tại vào để cùng một transaction (xem `@database/transaction.helper`).

## Thêm module mới

1. Tạo `src/modules/<tên>/` với `<tên>.module.ts`, `index.ts`, `README.md`.
2. Đăng ký ở `src/modules/index.ts` vào đúng danh sách: `apiModules` (chỉ có controller), `workerModules` (chỉ có consumer/scheduler) hoặc `sharedModules` (cả hai).
3. Module dùng chung mà có consumer phải bọc consumer bằng `runsWorkers()` để instance `api` không bao giờ poll queue.

## Cấu trúc bên trong một module

```
<tên>/
├── <tên>.module.ts
├── <tên>.controller.ts      # chỉ có ở module phục vụ HTTP
├── <tên>.service.ts
├── dto/                     # class-validator, một file mỗi request
├── entities/                # *.entity.ts (TypeORM)
├── *.spec.ts                # unit test đặt cạnh file được test
└── index.ts                 # API công khai
```
