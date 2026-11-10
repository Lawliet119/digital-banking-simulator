# risk 🟠 Supporting (điểm khác biệt, phần AI) — #4

> **ADR-14 (Accepted):** Giữ rules R1–R6; `rule_only` mặc định. RSK-02 nối Decisions tại worker, trước transaction quyết định, không thay provider online/offline hay API operator.

**Runtime AI:** sau dedup và chọn version, consumer đánh dấu đồng hồ monotonic, trích đúng 11 field và tính R1–R6 một lần trước network; không lọc theo điểm luật. `RiskAiService` chỉ được đăng ký tại `RiskWorkerModule`; `assess` dùng endpoint cố định. Thiếu key/khối AI hỏng → `CONFIG_INVALID`; thiếu approval/policy hoặc gate lỗi → `UNAVAILABLE` với provenance; quota ngày → `BUDGET_EXHAUSTED`; lỗi provider/429/timeout/refusal giữ baseline. Không retry API; SQL retry tái dùng assessment đã chuẩn bị.

### Vận hành RSK-02

- `RISK_AI_EGRESS_APPROVED=false` mặc định. Chỉ owner và Ops phê duyệt dữ liệu/egress; code không tự cấp quyền, không tự seed policy, không bật network khi chỉ có key.
- Khai báo rõ `RISK_AI_POLICY_REVISION`, `RISK_AI_DAILY_REQUEST_CAP`, `RISK_AI_CONCURRENCY`, `RISK_AI_GATE_TIMEOUT_MS` (số nguyên dương ≤ 2147483647, không có mặc định production), `OPENAI_API_KEY` từ secret manager. Revision dùng 1–128 ký tự chữ/số/`_.:-`. Thiếu policy vẫn khởi động và fail closed; giá trị sai bị schema từ chối.
- Ops cấu hình `ai_gate_policy` bằng quyền owner; revision/cap/concurrency phải khớp worker. Không cấp worker/API quyền bảng gate. Sau migration chạy lại `infra/scripts/db-roles.sql`: chỉ worker có EXECUTE hai hàm gate. Gate dùng TLS/CA như databaseConfig, cấm URL override `ssl*`/`uselibpqcompat`.
- Reservation tính một request theo UTC, không hoàn/refund; permit chỉ nhả sau client settle. Lỗi cleanup giữ slot để fail closed, Ops điều tra trước khi giải phóng. Không hứa exactly-once billing: hai delivery đồng thời hoặc crash sau network có thể bị tính phí dù chỉ một immutable decision thắng.
- Decision lưu model yêu cầu/phản hồi, SHA-256 rubric/input, request ID/probability khi hợp lệ; success/fallback cùng claim/flag/hits/audit atomic. Không log body, features, key hay auth. Migration down từ chối khi có lịch sử quota/permit.
- Test chỉ dùng PostgreSQL thật và loopback synthetic qua seam assessor, không có biến endpoint production. Lệnh đề nghị: `npm run test:db -- --runInBand risk-scoring-ai-mode` và unit config/adapter/gate; chưa chạy trong đợt bàn giao này theo yêu cầu.

DBS-59 định nghĩa `RiskRule`/`FeatureProvider`. Sáu luật R1–R6 và `ScoringService` thuần, không gọi DB hay network. `OnlineFeatureProvider({ facts, perTxLimit })` đọc 5 SELECT từ `v_transfer_facts` theo event-time mili giây; R1/R5 aggregate SQL-authoritative, không tin coverage Redis. Lỗi SQL/luật được chuyển tới consumer để retry; R3/R6 dùng snapshot event. `RuleSetRepository` vẫn cache cấu hình bằng Redis. Năm SELECT độc lập không bảo đảm chung snapshot; tải DB tăng, chưa đo 120 TPS hay hot-account SLO. Xem [DBS-109](../../../../docs/features/DBS-109-online-feature-provider.md), [DBS-111](../../../../docs/features/DBS-111-risk-scoring-consumer.md) và [regression thứ tự](../../../../docs/features/BUG-20261110-fraud-feature-order.md).

**DBS-128 offline:** `new OfflineFeatureProvider(facts, perTxLimit)` nhận completed TRANSFER facts bất biến (`id`, `fromAccountId`, `toAccountId`, `createdAt`, `amount`); event phải khớp fact. Cần cấp đầy đủ lịch sử; ID trùng với cùng facts được gộp, khác facts bị từ chối. Provider không đọc nhãn, holdout hay gọi mạng.

Index account/pair, cửa sổ trượt và Fenwick tree cho median bigint: khởi tạo O(n log n), bộ nhớ O(n), extract O(log n). Cửa sổ theo SQL; `extractAiInput` dùng allowlist 11 trường. [Bằng chứng DBS-128](../../../../docs/features/DBS-128-offline-features.md) gồm parity tổng hợp và chạy 100k, không chứng minh chất lượng model hay hiệu năng production.

Phát hiện giao dịch đáng ngờ; nhân viên review và quyết định.

|             |                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------- |
| Use case    | UC-9 chấm điểm · UC-10 review cờ · UC-12 cấu hình luật                                      |
| Chạy ở      | **api** (controller review, cấu hình) **+ worker** (consumer chấm điểm) — module dùng chung |
| Sở hữu bảng | `fraud_flags`, `fraud_rule_hits`, `risk_rule_sets`                                          |

Migration DBS-58 tạo ba bảng trên, seed rule set v1 (`mode=rule_only`) và cặp trigger append-only cho `risk_rule_sets`. Contract JSON seed và bảng test nằm tại [feature doc](../../../../docs/features/DBS-58-fraud-migration.md). Tính năng scoring/consumer và API review là task tiếp theo; migration không khởi động worker.
| Thiết kế | `docs/03` §15 |

## Phải giữ

- **Hệ thống chỉ gắn cờ, không tự khóa tài khoản.** Khách hàng không bao giờ thấy cờ.
- `rule_only` là mặc định; khi được bật qua gate ADR-14, API AI chỉ bổ sung điểm ở worker, lỗi thì dùng kết quả luật và không ảnh hưởng giao dịch đã hoàn tất.
- **Luật là hàm thuần** `evaluate(event, features, params)`: không gọi Redis hay DB. Đặc trưng đến từ `FeatureProvider` (online: Redis + SQL; offline: dữ liệu trong bộ nhớ) để cùng một code luật chạy được cả trên hệ thống thật lẫn script đánh giá.
- Mọi cửa sổ thời gian tính theo `occurredAt` của sự kiện, không theo giờ worker.
- R3, R6 dùng **ảnh chụp** trong sự kiện (`fromBalanceBefore`, `fromAccountCreatedAt`), không đọc trạng thái hiện tại.
- Consumer idempotent: ghi `processed_events` cùng transaction với cờ; khóa chính `fraud_flags(transfer_id)` chặn cờ trùng.
- **Consumer chỉ khởi động khi `runsWorkers()`** — instance `api` không bao giờ poll queue.
- Worker chạy bằng DB role `dbs_worker`: đọc giao dịch qua view `v_transfer_facts` (không đọc thẳng bảng `transfers`); chỉ ghi `fraud_flags`, `fraud_rule_hits`, `processed_events`, `audit_log` (database-design §8).

## Export công khai (`index.ts`)

Hầu như không có: module khác không gọi `risk`. Giao tiếp qua sự kiện (queue `risk-events`).
