# scripts

Công cụ chạy một lần, không phải một phần của ứng dụng đang chạy.

| Script (dự kiến) | Việc |
|---|---|
| `seed.ts` | Tạo dữ liệu demo **qua nghiệp vụ nạp tiền**, không `UPDATE balance` trực tiếp, để bất biến `SUM(balance) = 0` luôn đúng |
| `fraud-ai-evaluate.ts` | Đánh giá feature synthetic bằng OpenAI Decisions khi chạy `--live`; không phải consumer, không lưu cờ hoặc thay module fraud |

Chạy: `npx ts-node -r tsconfig-paths/register src/scripts/<tên>.ts` (từ thư mục `backend/`).

Đọc một JSON feature từ stdin. Mặc định không gọi mạng và trả `DISABLED`; `--live` yêu cầu `OPENAI_API_KEY` mới được cấp qua môi trường, không truyền key trong tham số hoặc log. Input, rubric, status, timeout và lệnh thử được mô tả tại [FRAUD-API-02](../../../docs/features/FRAUD-API-02-standalone-risk.md). Chỉ dùng dữ liệu tổng hợp khi chưa có phê duyệt gửi dữ liệu thật; không coi kết quả là bằng chứng phát hiện gian lận hay API tích hợp.

Migration database **không** nằm ở đây mà ở `src/database/migrations/` (xem `backend/README.md`).
