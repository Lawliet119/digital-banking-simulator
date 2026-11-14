# scripts

Công cụ chạy một lần, không phải một phần của ứng dụng đang chạy.

| Script | Việc |
|---|---|
| `dev-auth.ts`, `dev-auth.keys.ts`, `dev-auth.token.ts` | Khóa và token thử nghiệm cho `AUTH_MODE=local` (xem đoạn dưới) |
| `manual-smoke.dbs50.ts`, `manual-smoke.dbs51.ts`, `manual-smoke.dbs52.ts` | Test thủ công của DBS-50, DBS-51, DBS-52. Dùng chung helper sinh khóa từ `dev-auth.ts` và bị loại khỏi bản build (`tsconfig.build.json`) |
| `dlq-age-check.ts`, `dlq-age-check.main.ts` | `npm run --silent dlq:age-check -- --queue-url <DLQ>` (BL-210): trước mỗi redrive, liệt kê (và với `--delete-stale --quarantine-file` lưu rồi xóa) message DLQ gửi gốc quá 6 ngày, tính theo `OriginalSentTimestamp`. Mã thoát 0/1/2; xem [runbook](../../../docs/runbooks/dlq-redrive.md) mục 3 |
| `fraud-ai-evaluate.ts` | Đánh giá feature synthetic bằng OpenAI Decisions khi chạy `--live`; không phải consumer, không lưu cờ hoặc thay module fraud |

Chưa có script seed. Khi có, dữ liệu demo phải đi **qua nghiệp vụ nạp tiền**, không `UPDATE balance` trực tiếp, để bất biến `SUM(balance) = 0` luôn đúng.

Chạy: `npx ts-node -r tsconfig-paths/register src/scripts/<tên>.ts` (từ thư mục `backend/`).

Đọc một JSON feature từ stdin. Mặc định không gọi mạng và trả `DISABLED`; `--live` yêu cầu `OPENAI_API_KEY` mới được cấp qua môi trường, không truyền key trong tham số hoặc log. Input, rubric, status, timeout và lệnh thử được mô tả tại [FRAUD-API-02](../../../docs/features/FRAUD-API-02-standalone-risk.md). Chỉ dùng dữ liệu tổng hợp khi chưa có phê duyệt gửi dữ liệu thật; không coi kết quả là bằng chứng phát hiện gian lận hay API tích hợp.

Migration database **không** nằm ở đây mà ở `src/database/migrations/` (xem `backend/README.md`).

Khóa và token thử nghiệm cho `AUTH_MODE=local` (DBS-53): `npm run auth:dev-keys` và `npm run --silent auth:dev-token -- --role <vai>`, mã nguồn ở `dev-auth.ts`, `dev-auth.keys.ts`, `dev-auth.token.ts`. Các file `dev-auth*` bị loại khỏi bản build production (`tsconfig.build.json`). Hướng dẫn: [backend README mục 10](../../README.md#10-token-thử-ở-local).

Công cụ kiểm sổ cái đã có ở [src/scripts/invariants/invariants.ts](invariants/invariants.ts) (BL-128: chuyển từ `test/support` để biên dịch vào `dist`; `test/support/invariants.ts` chỉ còn re-export), nguồn SQL ở [invariants.sql](invariants/invariants.sql). Từ `backend/`, chạy `npm run --silent check:invariants`; CI/load runner giữ mã thoát 0/1/2. Cách dùng hàm, quyền DB, TLS và giới hạn: [backend README](../../README.md#9-kiểm-tra-bất-biến-sổ-cái). Công cụ chỉ đọc; seed qua API vẫn là quy tắc cho dữ liệu demo.
