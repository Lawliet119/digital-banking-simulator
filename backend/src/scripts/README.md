# scripts

Công cụ chạy một lần, không phải một phần của ứng dụng đang chạy.

| Script (dự kiến) | Việc |
|---|---|
| `seed.ts` | Tạo dữ liệu demo **qua nghiệp vụ nạp tiền**, không `UPDATE balance` trực tiếp, để bất biến `SUM(balance) = 0` luôn đúng |

Chạy: `npx ts-node -r tsconfig-paths/register src/scripts/<tên>.ts` (từ thư mục `backend/`).

Migration database **không** nằm ở đây mà ở `src/database/migrations/` (xem `backend/README.md`).
