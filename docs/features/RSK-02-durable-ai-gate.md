# RSK-02 · Nối fraud worker và cổng ngân sách OpenAI Decisions

> Trạng thái: code và kiểm tra synthetic cục bộ; chờ CI, Dev review và merge. Không có phê duyệt sử dụng dữ liệu thật hoặc triển khai egress trong task này.

## 1. Phạm vi và quyết định tự review

Giữ worker/queue, `risk_decisions`, rule set và luật R1–R6 trên main. Với `rule_only`, worker không gọi provider. Với `rules_with_external_ai` hợp lệ, mọi TRANSFER mới đều được chấm rule một lần và gửi snapshot 11 trường qua adapter sau admission; không lọc trước theo điểm rule. Loại DEPOSIT như hiện tại. Không đổi logic chuyển tiền/ledger, không trì hoãn kết quả giao dịch đã hoàn tất.

Dedup kiểm tra event/transfer trước trích xuất và gọi AI; hai worker đua vẫn có thể cùng gọi provider và bị tính phí hai lần. Chỉ một `risk_decisions` bất biến thắng `ON CONFLICT DO NOTHING`; flag, hits và audit ghi nguyên tử. Network nằm ngoài transaction được retry; retry transaction dùng lại assessment thay vì gọi lại.

AI thành công bổ sung weight khi xác suất đạt threshold của version; không bao giờ trừ điểm rule. Lỗi, timeout, từ chối, 429 hoặc quota giữ baseline; config AI hỏng/thiếu key ghi `CONFIG_INVALID`. Bảng lưu trạng thái, xác suất hợp lệ, model, SHA-256 input/rubric và request ID an toàn, không lưu phản hồi gốc. Không log key, body hay feature.

## 2. Admission, quyền và an toàn

Migration `1795000001000` tạo `ai_gate_policy`, `ai_gate_days`, `ai_gate_permits` và hai hàm `ai_gate_acquire` / `ai_gate_release`. Hàm SECURITY DEFINER dùng `search_path = pg_catalog, pg_temp`, tham chiếu bảng qua schema `public`; chỉ worker được EXECUTE, PUBLIC/API không có quyền, worker không có quyền đọc/ghi bảng gate. `infra/scripts/db-roles.sql` giữ các grant này khi chạy lại. Owner migration tách khỏi runtime, không cho role không tin cậy CREATE/ghi schema và không cho worker kế thừa quyền owner.

Policy singleton được owner/Ops tạo có revision, giới hạn request/ngày và đồng thời dương, khớp giá trị worker. Không seed, không đặt quota production mặc định. DB khóa policy để cấp permit nguyên tử; ngày UTC lấy từ đồng hồ DB sau khóa. Reservation không hoàn tiền/khoản gọi, kể cả lỗi, timeout hoặc commit không chắc chắn. Đây là **giới hạn số request, không phải trần tiền**; nhiều worker phải dùng chung DB và policy. Hàm nhả idempotent; permit đang dùng không tự hết hạn hoặc được hoàn khi sang ngày. PostgreSQL phải bền vững; restore bản cũ cần tắt AI và đối soát quota trước khi bật.

`RISK_AI_EGRESS_APPROVED=false` mặc định. Cần khai báo `RISK_AI_POLICY_REVISION`, `RISK_AI_DAILY_REQUEST_CAP`, `RISK_AI_CONCURRENCY`, `RISK_AI_GATE_TIMEOUT_MS` và key qua secret manager của worker. Thiếu approval/policy không gọi mạng, giữ baseline và ghi `UNAVAILABLE`; thiếu key ghi `CONFIG_INVALID`. Dữ liệu thật chỉ được gửi khi owner dữ liệu và Ops đã phê duyệt bằng văn bản điều khoản nhà cung cấp/egress; không tự khẳng định ZDR. Quyền dùng code hoặc key không thay thế phê duyệt này.

Gate dùng TLS/CA như databaseConfig và chặn tham số `ssl*`/`uselibpqcompat` trong URL để pg không ghi đè TLS. Connect/query/lock/statement có deadline; lỗi cleanup có thể giữ slot, chủ ý fail-closed. Rollback migration yêu cầu transaction READ COMMITTED, khóa bảng và từ chối nếu có lịch sử quota/permit; không reset ngân sách âm thầm.

## 3. Khôi phục permit và vận hành

1. Tắt egress/admission và dừng mọi worker dùng chung policy, bao gồm deployment cũ và retry.
2. Xác minh client bị bỏ dở không còn có thể gửi hoặc tiếp tục request. Timeout/abort client không chứng minh provider đã dừng hoặc không tính phí; không chứng minh được thì tiếp tục giữ permit.
3. Operator tin cậy chỉ nhả token đã chứng minh hoàn tất và ghi nhận theo quy trình audit vận hành. Không log token.
4. Giữ nguyên count ngày hiện tại và permit còn hoạt động. Thay policy/revision chỉ khi đã quiesce, không xóa/reseed quota. Sau restore DB cũ phải đối soát trước khi mở lại.
5. Chỉ bật lại với policy, secret, egress và dữ liệu đã được cấp quyền.

## 4. Kiểm thử cục bộ

| Kiểm tra | Kết quả |
|---|---|
| Lint, typecheck; unit validation và TLS CA thật | Đạt; 2 suite, 101 test |
| PostgreSQL gate + consumer qua loopback synthetic | 2 suite, 32 test đạt |
| Review độc lập migration | Phát hiện và đã sửa rollback `REPEATABLE READ` dùng snapshot cũ; regression PostgreSQL xác nhận từ chối |
| Kiểm chứng trước đó trên PostgreSQL sạch | 11 test gate và smoke độc lập đạt, không gửi request provider |

Lệnh từ `backend/`: `npm run lint:check`, `npm run typecheck`, `npm test -- --runInBand --runTestsByPath src/config/validation.schema.spec.ts src/modules/risk/ai/ai-gate.tls.spec.ts`, `npm run test:db -- --runInBand --runTestsByPath test/db/risk-scoring-ai-mode.db-spec.ts test/db/ai-gate.db-spec.ts` với PostgreSQL thử nghiệm. Loopback kiểm AI-only/rule+AI, provenance, không gọi trong transaction, duplicate, 429/refusal/timeout, quota/outage và quyền role. TLS test dùng CA đúng/sai/thiếu và chặn URL override.

## 5. Chưa chạy và giới hạn

Chưa gọi OpenAI thật bằng credential mới được cấp an toàn, chưa xác minh cấu hình/chi phí nhà cung cấp trên tài khoản triển khai, chưa có phê duyệt gửi dữ liệu thật/egress, chưa có benchmark 120 TPS, đo chất lượng hay cảnh báo chi phí trên môi trường thật. Synthetic/loopback chứng minh wiring và fallback, không chứng minh accuracy hoặc SLA. Review độc lập không thay thế Dev review của PR; CI và merge chưa xảy ra.
