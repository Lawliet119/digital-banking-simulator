# scripts

Công cụ chạy một lần, không phải một phần của ứng dụng đang chạy.

| Script (dự kiến) | Việc |
|---|---|
| `seed.ts` | Tạo dữ liệu demo **qua nghiệp vụ nạp tiền**, không `UPDATE balance` trực tiếp, để bất biến `SUM(balance) = 0` luôn đúng |

Chạy: `npx ts-node -r tsconfig-paths/register src/scripts/<tên>.ts` (từ thư mục `backend/`).

Migration database **không** nằm ở đây mà ở `src/database/migrations/` (xem `backend/README.md`).

Công cụ kiểm sổ cái đã có ở [test/support/invariants.ts](../../test/support/invariants.ts), nguồn SQL ở [invariants.sql](../../test/support/invariants.sql). Từ `backend/`, chạy `npm run --silent check:invariants`; CI/load runner giữ mã thoát 0/1/2. Cách dùng hàm, quyền DB, TLS và giới hạn: [backend README](../../README.md#9-kiểm-tra-bất-biến-sổ-cái). Công cụ chỉ đọc; seed qua API vẫn là quy tắc cho dữ liệu demo.
