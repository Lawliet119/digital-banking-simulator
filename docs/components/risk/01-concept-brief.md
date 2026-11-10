# risk — Concept Brief

> **Status:** Accepted · **Owner:** #4 · Nhánh này có R1–R6, consumer, provider online/offline, AI gate và API review; đang chờ CI và Dev review. Chưa có đánh giá chất lượng hay egress dữ liệu thật.

> **Cập nhật ADR-14 (Accepted, 2026-11-08):** Nhóm đã duyệt [ADR-14](../../adr/0014-fraud-rules-external-ai.md) (mô tả tại [FRAUD-API-01](../../features/FRAUD-API-01-external-ai-decision.md) và [FRAUD-API-02](../../features/FRAUD-API-02-standalone-risk.md)): giữ nguyên 6 luật `R1–R6` (`rule_only` là mặc định), bỏ hướng tự train model / ONNX `v3` của ADR-08, dùng adapter API AI bổ sung (`rules_with_external_ai`) khi bật qua gate.

## Component

| | |
|---|---|
| **Slug** | `risk` |
| **Loại** | 🟠 Supporting · module backend (phần AI/Data) |
| **Chạy ở** | `api` (review, cấu hình) **và** `worker` (chấm điểm) |
| **Use case / NFR** | UC-9, UC-10, UC-12 |
| **Sở hữu bảng** | `risk_rule_sets`, `risk_decisions`, `fraud_flags`, `fraud_rule_hits` và gate quota AI |
| **Task trong roadmap** | Task 6 của roadmap cũ (đã xóa ngày 2026-11-07); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md) |

## Vấn đề

Giao dịch đáng ngờ chỉ được phát hiện qua báo cáo hôm sau, lúc tiền đã đi xa (P-5 trong docs/BRD.md); báo nhầm lại gây hại thật cho khách.

## Ý tưởng

- Sau mỗi giao dịch chuyển tiền hoàn tất (`TransferCompleted`), worker chấm điểm bằng 6 luật giải thích được (`R1–R6`: velocity, số tiền bất thường, tài khoản mới chuyển lớn, chuyển vòng, fan-out, rút cạn) và gắn cờ nếu từ mức Trung bình.
- Cấu hình bất biến có `rule_only` mặc định và `rules_with_external_ai` bổ sung điểm theo ADR-14; không tự train model.
- `FeatureProvider` đọc online từ view `v_transfer_facts` hoặc offline từ snapshot fact trong bộ nhớ. Đánh giá precision/recall cần tập dữ liệu có nhãn, chưa suy ra từ smoke tổng hợp.
- Hệ thống chỉ gắn cờ (`OPEN`) kèm lời giải thích tiếng Việt theo 6 nhóm rủi ro `R1–R6`; chỉ nhân viên vận hành (`operator`) review và quyết định khóa tài khoản. Khách hàng không bao giờ thấy cờ (BR-13).
- Mỗi cờ ghi `rule_set_version` đã dùng.

## Quyết định liên quan (Accepted)

- [ADR-08](../../adr/0008-fraud-detection-architecture.md) & [ADR-14](../../adr/0014-fraud-rules-external-ai.md) — **Accepted**. Chốt `v1` (`rule_only`, 6 luật `R1–R6`) làm mặc định bắt buộc; bỏ hướng tự train ONNX `v3` để thay bằng tín hiệu API AI bổ sung (`rules_with_external_ai`) có gate kiểm soát.
- [ADR-12](../../adr/0012-redis-valkey-node.md) — Redis cache phiên bản cấu hình; R1/R5 đọc SQL authoritative vì thứ tự delivery không bảo đảm đủ dữ kiện đã commit.

## Ngoài phạm vi (v1)

- Chặn đồng bộ giao dịch vì "đáng ngờ" hoặc giữ tiền chờ duyệt (`HELD`).
- Tự động khóa tài khoản hoặc tự động đảo giao dịch (`REVERSAL`).
- Dữ liệu thiết bị, IP, vị trí địa lý.
- Tách microservice Python riêng cho inference hoặc tự train ONNX.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §15 Kiến trúc phát hiện gian lận; §9 Redis (R-3 bộ đếm, R-4 cấu hình); §10 Outbox và event.
- Nghiệp vụ, yêu cầu và mô hình miền: [docs/BRD.md](../../BRD.md).
- Quy tắc code và những điều phải giữ: [`backend/src/modules/risk/README.md`](../../../backend/src/modules/risk/README.md).
- [`FRAUD_DETECTION_GUIDE.md`](FRAUD_DETECTION_GUIDE.md) — hướng dẫn làm việc chi tiết (luật, đánh giá, bộ dữ liệu).
- Thiết kế chi tiết của module: [`02-architecture.md`](02-architecture.md).
