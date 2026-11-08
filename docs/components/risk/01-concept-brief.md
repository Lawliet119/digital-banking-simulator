# risk — Concept Brief

> **Status:** Accepted · **Owner:** #4 · **Verified against code:** một phần: bảng fraud (DBS-58), khung module `risk` với interface luật và feature provider (DBS-59), bộ dữ liệu (DBS-71, DBS-126), adapter AI độc lập (FRAUD-API-02). Chưa có: luật R1–R6, chấm điểm ở worker, API review cờ, cấu hình luật · **Cập nhật:** 2026-11-08

> **Cập nhật ADR-14 (Accepted, 2026-11-08):** Nhóm đã duyệt [ADR-14](../../adr/0014-fraud-rules-external-ai.md) (mô tả tại [FRAUD-API-01](../../features/FRAUD-API-01-external-ai-decision.md) và [FRAUD-API-02](../../features/FRAUD-API-02-standalone-risk.md)): giữ nguyên 6 luật `R1–R6` (`rule_only` là mặc định), bỏ hướng tự train model / ONNX `v3` của ADR-08, dùng adapter API AI bổ sung (`rules_with_external_ai`) khi bật qua gate.

## Component

| | |
|---|---|
| **Slug** | `risk` |
| **Loại** | 🟠 Supporting · module backend (phần AI/Data) |
| **Chạy ở** | `api` (review, cấu hình) **và** `worker` (chấm điểm) |
| **Use case / NFR** | UC-9, UC-10, UC-12 |
| **Sở hữu bảng** | `fraud_flags`, `fraud_rule_hits`, `risk_rule_sets` |
| **Task trong roadmap** | Task 6 của roadmap cũ (đã xóa ngày 2026-11-07); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md) |

## Vấn đề

Giao dịch đáng ngờ chỉ được phát hiện qua báo cáo hôm sau, lúc tiền đã đi xa (P-5 trong docs/BRD.md); báo nhầm lại gây hại thật cho khách.

## Ý tưởng

- Sau mỗi giao dịch chuyển tiền hoàn tất (`TransferCompleted`), worker chấm điểm bằng 6 luật giải thích được (`R1–R6`: velocity, số tiền bất thường, tài khoản mới chuyển lớn, chuyển vòng, fan-out, rút cạn) và gắn cờ nếu từ mức Trung bình.
- Cấu hình luật có phiên bản bất biến (`risk_rule_sets`) với 3 chế độ ([ADR-08](../../adr/0008-fraud-detection-architecture.md)): **`v1`** 6 luật như thiết kế (bắt buộc, mặc định), **`v2`** vẫn 6 luật nhưng ngưỡng và trọng số học từ dữ liệu, **`v3`** thêm mô hình ML chạy in-process qua ONNX. `v3` chỉ là mở rộng có điều kiện: được đưa vào nếu qua cổng go/no-go cuối tuần 5.
- Luật và bộ chấm điểm nhận đặc trưng từ `FeatureProvider` để chạy đồng nhất cả online (Redis + view `v_transfer_facts`) lẫn offline (dữ liệu CSV trong bộ nhớ), nhờ đó đánh giá được precision/recall.
- Hệ thống chỉ gắn cờ (`OPEN`) kèm lời giải thích tiếng Việt theo 6 nhóm rủi ro `R1–R6`; chỉ nhân viên vận hành (`operator`) review và quyết định khóa tài khoản. Khách hàng không bao giờ thấy cờ (BR-13).
- Mỗi cờ ghi `rule_set_version` đã dùng.

## Quyết định liên quan (Accepted)

- [ADR-08](../../adr/0008-fraud-detection-architecture.md) & [ADR-14](../../adr/0014-fraud-rules-external-ai.md) — **Accepted**. Chốt `v1` (`rule_only`, 6 luật `R1–R6`) làm mặc định bắt buộc; bỏ hướng tự train ONNX `v3` để thay bằng tín hiệu API AI bổ sung (`rules_with_external_ai`) có gate kiểm soát.
- [ADR-12](../../adr/0012-redis-valkey-node.md) — **Accepted** (xem [bảng ADR](../../adr/README.md)). Bộ đếm đặc trưng trên Redis (`risk:vel:{accountId}`, `risk:fan:{accountId}`) có đường dự phòng SQL và cache cấu hình bất biến (`cfg:risk:latest`, `cfg:risk:v{n}`).

## Ngoài phạm vi (v1)

- Chặn đồng bộ giao dịch vì "đáng ngờ" hoặc giữ tiền chờ duyệt (`HELD`).
- Tự động khóa tài khoản hoặc tự động đảo giao dịch (`REVERSAL`).
- Dữ liệu thiết bị, IP, vị trí địa lý.
- Tách microservice Python riêng cho inference (trái ADR-13). Nếu `v3` được bật, mô hình chạy in-process trong worker.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §15 Kiến trúc phát hiện gian lận; §9 Redis (R-3 bộ đếm, R-4 cấu hình); §10 Outbox và event.
- Nghiệp vụ, yêu cầu và mô hình miền: [docs/BRD.md](../../BRD.md).
- Quy tắc code và những điều phải giữ: [`backend/src/modules/risk/README.md`](../../../backend/src/modules/risk/README.md).
- [`FRAUD_DETECTION_GUIDE.md`](FRAUD_DETECTION_GUIDE.md) — hướng dẫn làm việc chi tiết (luật, đánh giá, bộ dữ liệu).
- Thiết kế chi tiết của module: [`02-architecture.md`](02-architecture.md).
