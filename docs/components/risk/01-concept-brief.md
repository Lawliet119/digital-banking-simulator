# risk — Concept Brief

> **Status:** Proposed — phương án API theo ADR-14, chưa triển khai · **Owner:** #4 · **Cặp đôi:** #1 · **Verified against code:** chỉ có README của module risk; chưa có fraud end-to-end · **Cập nhật:** 2026-10-23

## Component

| | |
|---|---|
| **Slug** | `risk` |
| **Loại** | Supporting · module backend (phần AI/Data) |
| **Chạy ở (thiết kế)** | `api` (review, cấu hình) **và** `worker` (chấm điểm); consumer chỉ chạy khi `runsWorkers()` |
| **Use case / NFR** | UC-9, UC-10, UC-12 |
| **Sở hữu bảng (đề xuất)** | `fraud_flags`, `fraud_rule_hits`, `risk_rule_sets`, thêm `risk_decisions` |
| **Task trong roadmap** | Task 6 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Giao dịch đáng ngờ chỉ được phát hiện qua báo cáo hôm sau, lúc tiền đã đi xa (P-5 trong docs/01); báo nhầm lại gây hại thật cho khách. API pretrained có thể bổ sung tín hiệu nhưng chưa có bằng chứng chất lượng, latency hoặc chi phí để bật.

## Ý tưởng đề xuất — chưa phải chức năng đang chạy

- Chỉ chấm `TransferCompleted.type = TRANSFER`, sau khi tiền đã chuyển xong. Giữ sáu luật thuần R1–R6, event-time `occurredAt`, snapshot R3/R6 và ngoại lệ `sameOwner` cho R5/R6. `sameOwner` đã có trong [event contract](../_shared/event-contract.md); event thiếu/sai trường phải qua xử lý schema lỗi, không bỏ ngoại lệ để tiếp tục chấm.
- Hai mode trên cấu hình bất biến: `rule_only` là seed mặc định; `rules_with_external_ai` chỉ opt-in sau gate. Nhánh API không tự train, không ONNX; không giữ alias mode cũ.
- `FeatureProvider` cấp cùng đặc trưng cho luật online/offline. PostgreSQL `v_transfer_facts` là nguồn sự thật; Redis chỉ tăng tốc và phải fallback SQL khi thiếu coverage, lạnh, lỗi hoặc chậm. Parity cần kiểm trong phạm vi in-order/warm-cache, không hứa mọi event trễ có cache đầy đủ.
- Provider đầu tiên được đề xuất là OpenAI Decisions. Adapter nằm nội bộ risk, không có Jev adapter hoặc tự chuyển provider. Chỉ gửi feature allowlist, không ID, tên, email, free text, nhãn, tên kịch bản hoặc raw history.
- `rule_score = sum(ruleHits.weight)`; `ai_applied_weight` là trọng số cấu hình cố định khi p hợp lệ, hữu hạn và đạt threshold, còn lại 0. `score = rule_score + ai_applied_weight`; AI không trừ điểm/xóa cờ baseline và không tạo hit R1–R6 giả. Ngưỡng baseline MEDIUM/HIGH vẫn 40/70.
- Một `risk_decisions` bất biến cho **mọi TRANSFER ở cả hai mode**, gồm LOW và fallback, lưu version, snapshot và provenance AI. Kiểm quyết định theo `transfer_id` trước khi gọi API; claim event và transfer cùng transaction SQL. Quyết định commit đầu thắng cả khi eventId hoặc mode khác; Redis/API luôn ngoài callback transaction có retry.
- Chỉ MEDIUM/HIGH tạo cờ `OPEN`; operator detail giữ `score`, `riskLevel`, `hits`, thêm `aiAssessment` tách riêng (baseline null). Client không được cộng `hits` để suy total khi có AI. Customer không thấy risk; chỉ operator quyết định xử lý, không tự khóa/đảo tiền.
- API lỗi, refusal, budget hoặc response sai vẫn ghi baseline và trạng thái AI; SQL/audit lỗi phải rollback, không ack. Không hứa exactly-once billing hay live model trả p giống nhau.
- Chuyển sang baseline bằng version mới không dừng egress tức thì: cache latest TTL 60 giây, admission deadline và request timeout hữu hạn còn áp dụng cho công việc đã chọn version cũ; client abort không bảo đảm provider hủy hoặc hết tính phí.

## Gate chất lượng và vận hành

Giữ recall ≥70% trên năm kịch bản mục tiêu và ≤20 cờ/1.000 TRANSFER. Tune/validation chia theo khách; so B0 luật, B1 API riêng chỉ để chẩn đoán, B2 luật+API trên cùng input/capture. AI phải tăng recall ≥5 điểm phần trăm trên grouped validation, tại cùng ngân sách cờ và paired customer-cluster 95% CI của chênh recall loại trừ 0. Freeze cấu hình/code/rubric/model trước holdout, chạy holdout một lần. Baseline báo quá ngân sách thì policy chỉ cộng AI không sửa được.

Trước bật phải đo p95 giao dịch→cờ <5 giây tại 120 RPS cho cả API khỏe/fallback, quota/concurrency/cost và admission/timeout; duyệt điều kiện dữ liệu/nhà cung cấp. Chưa có số đo thật nên AI tiếp tục tắt. Dữ liệu tổng hợp không chứng minh hiệu quả ngân hàng thật; cờ không phải chứng cứ gian lận.

## Quyết định liên quan

- [ADR-08](../../adr/0008-fraud-detection-architecture.md) vẫn **Accepted**, chưa bị sửa hoặc supersede.
- [ADR-14](../../adr/0014-fraud-rules-external-ai.md) **Proposed**: đề xuất thay riêng nghĩa vụ học tham số/train/ONNX của ADR-08 bằng luật + hosted AI. Chỉ nhóm chấp nhận ADR mới thì mới cutover implementation.
- ADR-12 (xem [bảng ADR](../../adr/README.md)): Redis là cache và đường SQL dự phòng, không là nguồn dữ liệu thứ hai.
- [FRAUD-API-01 §§2–7](../../features/FRAUD-API-01-external-ai-decision.md): thiết kế và kế hoạch được duyệt của PR docs-only, không xác nhận API đã tích hợp.

## Ngoài phạm vi

Không chặn đồng bộ vì nghi ngờ, giữ tiền (`HELD`), tự khóa, đảo giao dịch hoặc thêm dữ liệu thiết bị/IP/vị trí. Không sửa ledger/event/outbox/queue/ErrorCode để phục vụ API; không thêm code, migration, dependency, env, credential hay hạ tầng trong PR tài liệu này.

## Liên kết

- Thiết kế hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md), §15 risk, §9 Redis, §10 event/outbox.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- [README module](../../../backend/src/modules/risk/README.md) · [Guide](FRAUD_DETECTION_GUIDE.md) · [Kiến trúc chi tiết](02-architecture.md).
