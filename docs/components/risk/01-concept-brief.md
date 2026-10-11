# risk — Concept Brief

> **Status:** Draft · **Owner:** #4 · **Cặp đôi:** #1 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-11

## Component

| | |
|---|---|
| **Slug** | `risk` |
| **Loại** | 🟠 Supporting · module backend (phần AI/Data) |
| **Chạy ở** | `api` (review, cấu hình) **và** `worker` (chấm điểm) |
| **Use case / NFR** | UC-9, UC-10, UC-12 |
| **Sở hữu bảng** | `fraud_flags`, `fraud_rule_hits`, `risk_rule_sets` |
| **Task trong roadmap** | Task 6 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Giao dịch đáng ngờ chỉ được phát hiện qua báo cáo hôm sau, lúc tiền đã đi xa (P-5 trong docs/01); báo nhầm lại gây hại thật cho khách.

## Ý tưởng

- Sau mỗi giao dịch chuyển tiền hoàn tất (`TransferCompleted`), worker chấm điểm bằng 6 luật giải thích được (`R1–R6`: velocity, số tiền bất thường, tài khoản mới chuyển lớn, chuyển vòng, fan-out, rút cạn) và hỗ trợ nâng cấp theo phiên bản cấu hình (`risk_rule_sets`) từ **Rule-based (`v1`)** sang **ML-Tuned Rules (`v2`)** và **In-process ONNX Model (`v3` — LightGBM/XGBoost)** để bắt thêm các kịch bản lách ngưỡng cứng (`STRUCTURING`, `SLOW_DRIP`).
- Luật và bộ chấm điểm là hàm thuần, nhận đặc trưng từ `FeatureProvider` để chạy đồng nhất cả online (Redis + view `v_transfer_facts` trên PostgreSQL) lẫn offline (dữ liệu CSV trong bộ nhớ).
- Hệ thống chỉ gắn cờ (`OPEN`) kèm lời giải thích tiếng Việt theo 6 nhóm rủi ro `R1–R6`; chỉ nhân viên vận hành (`operator`) review và quyết định khóa tài khoản. Khách hàng không bao giờ thấy cờ (BR-13).
- Cấu hình luật và mô hình có phiên bản bất biến (`risk_rule_sets`); mỗi cờ ghi lại `rule_set_version` đã dùng.

## Quyết định đã chốt

- [ADR-08](../../adr/0008-fraud-detection-architecture.md) — Phát hiện gian lận bất đồng bộ: 6 luật giải thích được (`R1–R6`) kết hợp mô hình ML in-process (ONNX) theo phiên bản cấu hình.
- [ADR-12](../../adr/README.md) — Bộ đếm đặc trưng trên Redis (`risk:vel:{accountId}`, `risk:fan:{accountId}`) có đường dự phòng SQL và cache cấu hình bất biến (`cfg:risk:latest`, `cfg:risk:v{n}`).

## Ngoài phạm vi (v1)

- Chặn đồng bộ giao dịch vì "đáng ngờ" hoặc giữ tiền chờ duyệt (`HELD`).
- Tự động khóa tài khoản hoặc tự động đảo giao dịch (`REVERSAL`).
- Dữ liệu thiết bị, IP, vị trí địa lý.
- Tách microservice Python riêng cho inference (đã giải quyết bằng chạy `.onnx` in-process trong worker theo ADR-08, ADR-13).
## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §15 Kiến trúc phát hiện gian lận; §9 Redis (R-3 bộ đếm, R-4 cấu hình); §10 Outbox và event.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Quy tắc code và những điều phải giữ: [`backend/src/modules/risk/README.md`](../../../backend/src/modules/risk/README.md).
- `FRAUD_DETECTION_GUIDE.md` — hướng dẫn chi tiết, sẽ được tách thành 02/03/06 sau khi nộp P2.
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
