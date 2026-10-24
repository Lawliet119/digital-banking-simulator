# risk — Supporting · Fraud / AI · #4

> **Trạng thái:** thiết kế Proposed theo ADR-14, chưa triển khai. Thư mục risk hiện chỉ có README, chưa có consumer/service/controller fraud; tài liệu này không xác nhận RiskModule hoặc API AI đang chạy.

Phát hiện giao dịch đáng ngờ sau khi hoàn tất; operator review và quyết định. Không đưa API AI vào transaction chuyển tiền.

| | Thiết kế đích |
|---|---|
| Use case | UC-9 chấm điểm · UC-10 review · UC-12 cấu hình |
| Chạy ở | `api` (review/config) + `worker` (consumer), đăng ký sharedModules; consumer chỉ có lifecycle khi `runsWorkers()` |
| Sở hữu bảng | `risk_rule_sets`, `risk_decisions` (mới đề xuất), `fraud_flags`, `fraud_rule_hits` |
| Thiết kế | [Architecture](../../../../docs/components/risk/02-architecture.md), [guide](../../../../docs/components/risk/FRAUD_DETECTION_GUIDE.md), [FRAUD-API-01 §§2–7](../../../../docs/features/FRAUD-API-01-external-ai-decision.md) |

[ADR-08](../../../../docs/adr/0008-fraud-detection-architecture.md) vẫn **Accepted/unmodified**. [ADR-14](../../../../docs/adr/0014-fraud-rules-external-ai.md) **Proposed** đề xuất thay riêng nghĩa vụ học tham số/train/ONNX bằng hosted AI, chưa được nhóm chấp nhận. Nhánh API đích không train, không model artifact/native runtime hoặc alias mode cũ; không coi docs-only là hoàn thành task runtime.

## Bất biến phải giữ khi triển khai

- Chỉ chấm `TransferCompleted.type = TRANSFER`; DEPOSIT chỉ dedup/ack theo consumer contract, không gọi AI. Giữ ledger/sync guard/event/outbox/queue/ErrorCode hiện hữu, không thay vì đổi provider.
- R1–R6 là hàm thuần `evaluate(event, features, params)`, không gọi Redis/DB/API. `FeatureProvider.extract(event): Promise<Features>` cấp dữ liệu online/offline cho cùng code luật.
- Giữ baseline predicate/trọng số R1=30, R2=25, R3=35, R4=20, R5=40, R6=30 và ngưỡng MEDIUM/HIGH=40/70 ở [guide §4.2–4.3](../../../../docs/components/risk/FRAUD_DETECTION_GUIDE.md). R6 một mình=30 LOW, không tự sửa rule để có cờ.
- Cửa sổ theo `occurredAt = transfers.created_at`, không giờ worker. R3/R6 dùng snapshot `fromAccountCreatedAt`/`fromBalanceBefore`; R5/R6 miễn trừ `sameOwner`. [Event type hiện có](../../common/events/event-types.ts) đã chứa sameOwner: malformed event phải xử lý schema lỗi, không gán false/bỏ miễn trừ hoặc đọc snapshot từ trạng thái hiện tại.
- Tiền wire là chuỗi đồng canonical; nội bộ bigint/numeric theo `@common/money`. Không ép `Number`/floating-point cho so luật; median chẵn giữ chính xác nửa đồng, R6 nhân chéo `amount*10 >= fromBalanceBefore*9`.
- SQL `v_transfer_facts` là truth; worker không SELECT trực tiếp `transfers`. Lặp predicate `status='COMPLETED' AND type='TRANSFER'` trong query. Redis lạnh/miss/lỗi/chậm/không đủ coverage phải SQL, không cold=0; trim theo wall clock/retention, không occurredAt. Redis I/O trước BEGIN. Parity online/offline chỉ được tuyên bố theo phạm vi đã test (in-order/warm-cache); trễ/đảo thứ tự/fallback kiểm riêng.
- Hệ thống chỉ gắn cờ, không tự khóa/đảo tiền. Customer không thấy score/cờ/AI assessment/provenance trong API hoặc notification.

## Policy AI đề xuất — tắt mặc định

- Mode `rule_only` seed mặc định, không API; `rules_with_external_ai` opt-in chỉ sau gate. Provider đầu tiên OpenAI Decisions, adapter nội bộ risk; không Jev adapter/fallback provider.
- `rule_score = sum(ruleHits.weight)`; `ai_applied_weight = ai.weight` cố định nếu p hợp lệ hữu hạn [0,1] và p ≥ threshold, còn lại 0. `score = rule_score + ai_applied_weight`, không p×100/weight×p. AI không trừ/xóa cờ baseline, không giả R1–R6 hit.
- Config bất biến: threshold hữu hạn `(0,1]`, weight nguyên không âm, tổng điểm tối đa vừa PostgreSQL int; model/rubric/threshold/weight phải được duyệt, không có default tự bật.
- Input chỉ allowlist feature tại guide; không UUID/user/account/correlation IDs, thời điểm tuyệt đối, tên/email/free text/scenario/labels/raw history. Không log body/raw response/secret/Authorization; điều kiện retention/quyền gửi/provider phải được nhóm duyệt, không tự nhận ZDR.
- Mỗi TRANSFER mới trong AI mode được gọi tối đa một lần mỗi lần consumer xử lý, không prefilter ruleScore. API ngoài transaction, không retry provider/chuyển provider; quota/budget/concurrency/admission có thể bỏ AI và ghi trạng thái baseline rõ.
- AI mode bắt buộc `ai.maxAdmissionDelayMs`, `ai.requestTimeoutMs` nguyên dương đã đo/duyệt trước enable. Đo monotonic từ lúc chọn config, quá admission không send; request có client timeout, không giữ DB/slot vô hạn.

## Decision, dedup và transaction đề xuất

`risk_decisions` có PK/FK `transfer_id`, một hàng append-only cho **mọi TRANSFER/mode/LOW/fallback**, không có bảng assessment riêng. Trường: `event_id` đầu tiên, `rule_set_version` FK, `mode`, `rule_score`, `feature_snapshot`, `ai_status`, `ai_applied_weight`, `probability`, `provider`, `requested_model`, `response_model`, `rubric_sha256`, `input_sha256`, `provider_request_id`, `decided_at`. Snapshot đủ replay rule/policy; không lưu raw response. Schema/quyền đích tại [database-design §4.8](../../../../docs/components/_shared/database-design.md#48-nhóm-fraud), không phải migration đã áp dụng.

- Rule-only: DISABLED, p null, weight 0, AI metadata null. AI mode: provider/requested model/hashes bắt buộc, status không DISABLED; response model/request id chỉ ghi khi provider trả, không bịa snapshot guarantee.
- SUCCEEDED có p hữu hạn [0,1], weight theo policy. UNAVAILABLE/REFUSED/INVALID_RESPONSE/BUDGET_EXHAUSTED có p null và weight 0, vẫn commit decision baseline. AI lỗi không tự DLQ.
- Early lookup decision theo transfer **trước config/chấm lại/API**. Decision đã commit ở mọi mode, kể cả LOW, phải reuse khi eventId khác sau đổi mode/model; không tạo flag/assessment mới.
- Trong `TransactionService.run`: claim `processed_events`, rồi `INSERT risk_decisions ... ON CONFLICT (transfer_id) DO NOTHING RETURNING transfer_id`. Event thua không ghi phụ; transfer thua chỉ commit dedup event mới, dùng decision cũ. Winner ghi optional flag/hits và audit decision cùng tx; ack sau commit.
- Không Redis/HTTP/SQS trong callback retry. SQL/audit lỗi rollback, không ack. Race có thể gọi API hai lần trước commit; không hứa exactly-once billing. Claim transfer dùng chung mọi worker/mode, phải test PostgreSQL thật cả rollback winner.
- Cờ tham chiếu decision cùng transfer/version; `sum(hits.weight)=decision.rule_score`, `flag.score=rule_score+ai_applied_weight`. LOW không cờ/hits nhưng có decision. dbs_api/dbs_worker không UPDATE/DELETE decision.

## API operator và vận hành

Detail giữ `score`, `riskLevel`, `hits`, thêm `aiAssessment` riêng từ decision (baseline null). Client dùng total score hoặc cộng thêm `appliedWeight`, không chỉ sum(hits). Giải thích AI là câu của policy, không model chain-of-thought/bằng chứng gian lận. Review OPEN một lần và audit cùng transaction, lần sau HTTP 409 `FLAG_ALREADY_REVIEWED`; customer không có risk.

Chuyển baseline là version `rule_only` mới, không sửa decision cũ, **không immediate kill**: latest TTL60s + maxAdmissionDelayMs giới hạn lời gọi mới theo config cũ nếu store/TTL đúng contract; request đang gửi có thể thêm requestTimeoutMs phía client. Abort không bảo đảm provider hủy/hết tính phí. Egress/secret tức thì thuộc quy trình Ops riêng.

Giữ mục tiêu recall ≥70% trên năm kịch bản mục tiêu, ≤20 cờ/1.000 TRANSFER; B0 luật/B1 API riêng chẩn đoán/B2 tổng hợp dùng cùng capture. Tune chọn cấu hình và validation tách theo khách; AI cần tăng recall ≥5 điểm phần trăm ở cùng ngân sách và paired customer-cluster 95% CI chênh recall loại trừ 0. Freeze code/config/rubric/model identifier trước holdout một lần, không chọn default theo holdout. Đo p95 giao dịch→cờ <5s tại 120 RPS cả khỏe/fallback, quota/concurrency/cost và deadline/pool/visibility trước enable. Chưa có số đo/credential/gate thì AI tắt; replay/mock không chứng minh live quality/latency/cost.

## Export công khai dự kiến

Chỉ `RiskModule`; module khác không gọi scoring. Giao tiếp qua event `risk-events`. Hiện chưa có symbol runtime risk để migrate hoặc endpoint fraud để thử; implementation/test và gate bật AI là các task riêng.
