# fraud-dataset — Concept Brief

> **Status:** Draft · **Owner:** Dev (task dataset), #4 dùng dữ liệu · **Verified against code:** một phần: generator dữ liệu bình thường và test `node --test` chạy trong CI (DBS-71). kịch bản gian lận và hard negative (DBS-126, generator mixed và inspector). Chưa có: chia tune/holdout (DBS-127) · **Cập nhật:** 2026-11-07

## Component

| | |
|---|---|
| **Slug** | `fraud-dataset` |
| **Loại** | Quality · bộ dữ liệu đánh giá |
| **Chạy ở** | Script cục bộ |
| **Use case / NFR** | — (NFR-FRD-03) |
| **Sở hữu bảng** | — |
| **Task trong roadmap** | Task 7 của roadmap cũ (đã xóa ngày 2026-11-07); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md) |

## Vấn đề

Không có dữ liệu thật; cần dữ liệu có nhãn để đo precision, recall mà người viết luật không tự chấm bài mình.

## Ý tưởng

- Generator do #6 viết; #4 chỉ biết tên và mô tả một câu của từng kịch bản, **không xem code**.
- Chia tập theo khách hàng: ~70% tune, ~30% holdout; nhãn holdout giữ tới tuần 7.
- Mã generator và nhãn holdout nằm trong `load-tests/fraud-dataset/` (chỉ #6 đọc). CSV tune giao cho #4 ở `backend/data/fraud/` (gitignore, chia sẻ qua link).
- Có hard negatives (giao dịch hợp lệ trông đáng ngờ) và kịch bản ngoài tầm luật để đo recall trung thực.
- Generator NORMAL và mixed đã có trong [README vận hành](../../../load-tests/fraud-dataset/README.md). Mixed giữ 12 cột, sinh đủ 8 scenario/5 nhóm hard negatives, có manifest replay và thống kê từ CSV; chưa có split/giao dữ liệu hoặc số đo chất lượng scoring. Bằng chứng: [DBS-126](../../features/DBS-126-fraud-scenarios.md).
- Giới hạn implementation mixed: 75% khách cho background, 25% cho cohort kịch bản, không có giao dịch nối hai nhóm; mặc định khoảng 70–80 nghìn dòng. Cần ghi giới hạn và quy mô thực tế này trong P5, không suy rộng kết quả tổng hợp thành độ chính xác trên dữ liệu thật.
- **Đề xuất ADR-14 (Proposed):** nếu nhóm chấp nhận phương án gọi API AI, tập tune cần một cột khóa khách hàng để #4 chia nhóm chọn cấu hình và validation, và mỗi giao dịch tune sẽ tạo một lời gọi API trả phí cho B1/B2. Cần #6 xác nhận cột khóa khách có trong CSV tune. Xem [FRAUD-API-01](../../features/FRAUD-API-01-external-ai-decision.md).

## Ngoài phạm vi (v1)

- Dữ liệu thật hoặc dữ liệu công khai (có thể bổ sung sau, cần kiểm tra giấy phép).

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §15.4 Đánh giá.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- `FRAUD_DETECTION_GUIDE.md` §6 (thiết kế bộ dữ liệu và bức tường #4/#6).
- Giao diện và mốc: Task 7 của roadmap cũ (đã xóa); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md). Thiết kế chi tiết nằm ở các mục docs/03 nêu trên (không có file 02 riêng).
