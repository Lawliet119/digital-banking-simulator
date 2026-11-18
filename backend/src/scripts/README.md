# scripts

Công cụ chạy một lần, không phải một phần của ứng dụng đang chạy.

| Script | Việc |
|---|---|
| `dev-auth.ts`, `dev-auth.keys.ts`, `dev-auth.token.ts` | Khóa và token thử nghiệm cho `AUTH_MODE=local` (xem đoạn dưới) |
| `manual-smoke.dbs50.ts`, `manual-smoke.dbs51.ts`, `manual-smoke.dbs52.ts` | Test thủ công của DBS-50, DBS-51, DBS-52. Dùng chung helper sinh khóa từ `dev-auth.ts` và bị loại khỏi bản build (`tsconfig.build.json`) |
| `dlq-age-check.ts`, `dlq-age-check.main.ts` | `npm run --silent dlq:age-check -- --queue-url <DLQ>` (BL-210): trước mỗi redrive, liệt kê (và với `--delete-stale --quarantine-file` lưu rồi xóa) message DLQ gửi gốc quá 6 ngày, tính theo `OriginalSentTimestamp`. Mã thoát 0/1/2; xem [runbook](../../../docs/runbooks/dlq-redrive.md) mục 3 |
| `fraud-ai-evaluate.ts` | Đánh giá feature synthetic bằng OpenAI Decisions khi chạy `--live`; không phải consumer, không lưu cờ hoặc thay module fraud |
| `evaluate-rules.ts` | `npm run --silent evaluate-rules -- --input <tune.csv> --config <rule-set.json> [--config-version <n>] [--seed <text> [--part train|validation]] [--ai-capture <file.jsonl> [--restrict-to-capture]] [--output <report.json>]` (DBS-132): chấm R1–R6 bằng đúng `ScoringService` của worker trên CSV 12 cột, in ma trận nhầm lẫn, precision, recall, F1, FPR, cảnh báo/1.000 giao dịch, recall theo kịch bản và theo 5 kịch bản trong tầm luật. Cấu hình mẫu v1 ở `src/modules/risk/evaluation/configs/v1.json`. Từ chối chạy khi thiếu cột hoặc không có dòng `is_fraud=1`. Mode `rules_with_external_ai` (B2) chỉ đọc capture JSON-lines `{"txId", "assessment"}` đã lưu, không gọi API, và thiếu capture của giao dịch nào thì từ chối chạy |
| `capture-ai.ts` | `OPENAI_API_KEY=... npm run --silent capture-ai -- --input <tune.csv> --output <capture.jsonl> --seed <text> --max-calls <n> [--normal-sample <n>] [--limit <n>] [--dry-run]` (DBS-212): gọi API AI **một lần** cho mẫu gồm mọi giao dịch fraud, hard negative và `--normal-sample` giao dịch NORMAL (kèm trọng số), lưu từng kết quả ngay (chạy lại thì bỏ qua giao dịch đã có, không trả tiền hai lần). Chỉ gửi 11 đặc trưng số của dữ liệu tổng hợp; khóa chỉ lấy từ môi trường; `--dry-run` chỉ in kế hoạch và chi phí ước tính; dừng khi chạm `--max-calls` hoặc khi 10 câu trả lời đầu đều lỗi |
| `compare-modes.ts` | `npm run --silent compare-modes -- --input <tune.csv> --capture <capture.jsonl> --config <rule-set.json> --seed <text> [--output <report.json>]` (DBS-212): so B0, B1, B2 trên cùng capture, chọn ngưỡng và trọng số AI trên khách train, đo trên khách validation, kèm khoảng tin cậy bootstrap ghép cặp theo khách, chi phí và kết luận cổng ADR-14. Không gọi API. Kết quả: [06-evaluation-ai-gate](../../../docs/components/risk/06-evaluation-ai-gate.md) |

`seed.ts` (cùng `seed-core.ts`, `seed-cloud.ts`) tạo dữ liệu demo qua API: `npm run seed` (xem [backend README mục 12](../../README.md#12-dữ-liệu-demo-scriptsseedts-dbs-70)). Dữ liệu demo phải đi **qua nghiệp vụ nạp tiền**, không `UPDATE balance` trực tiếp, để bất biến `SUM(balance) = 0` luôn đúng.

Chạy: `npx ts-node -r tsconfig-paths/register src/scripts/<tên>.ts` (từ thư mục `backend/`).

Đọc một JSON feature từ stdin. Mặc định không gọi mạng và trả `DISABLED`; `--live` yêu cầu `OPENAI_API_KEY` mới được cấp qua môi trường, không truyền key trong tham số hoặc log. Input, rubric, status, timeout và lệnh thử được mô tả tại [FRAUD-API-02](../../../docs/features/FRAUD-API-02-standalone-risk.md). Chỉ dùng dữ liệu tổng hợp khi chưa có phê duyệt gửi dữ liệu thật; không coi kết quả là bằng chứng phát hiện gian lận hay API tích hợp.

Migration database **không** nằm ở đây mà ở `src/database/migrations/` (xem `backend/README.md`).

Khóa và token thử nghiệm cho `AUTH_MODE=local` (DBS-53): `npm run auth:dev-keys` và `npm run --silent auth:dev-token -- --role <vai>`, mã nguồn ở `dev-auth.ts`, `dev-auth.keys.ts`, `dev-auth.token.ts`. Các file `dev-auth*` bị loại khỏi bản build production (`tsconfig.build.json`). Hướng dẫn: [backend README mục 10](../../README.md#10-token-thử-ở-local).

Công cụ kiểm sổ cái đã có ở [src/scripts/invariants/invariants.ts](invariants/invariants.ts) (BL-128: chuyển từ `test/support` để biên dịch vào `dist`; `test/support/invariants.ts` chỉ còn re-export), nguồn SQL ở [invariants.sql](invariants/invariants.sql). Từ `backend/`, chạy `npm run --silent check:invariants`; CI/load runner giữ mã thoát 0/1/2. Cách dùng hàm, quyền DB, TLS và giới hạn: [backend README](../../README.md#9-kiểm-tra-bất-biến-sổ-cái). Công cụ chỉ đọc; seed qua API vẫn là quy tắc cho dữ liệu demo.
