# ADR-08: Phát hiện gian lận bất đồng bộ — 6 luật giải thích được kết hợp mô hình ML in-process (ONNX)

| | |
|---|---|
| Trạng thái | **Proposed** — chờ nhóm review |
| Ngày | 2026-10-11 |
| Người viết | #4 (Fraud) |
| Người duyệt | #1 (Ledger); cả nhóm |
| Liên quan | Driver D-4 · BR-06, BR-11, BR-13 · UC-9, UC-10, UC-12 · NFR-FRD-01…03, NFR-PERF-01 · ADR-03, ADR-12, [ADR-13](0013-one-app-app-role.md) · [`docs/03` §15](../03_HIGH_LEVEL_ARCHITECTURE.md) |

## Bối cảnh

Hệ thống cần phát hiện giao dịch chuyển tiền đáng ngờ sớm (NFR-FRD-01: từ lúc giao dịch hoàn tất tới lúc có cờ p95 < 5 giây) và đưa tới nhân viên vận hành xem xét kèm lời giải thích rõ ràng (BR-11, UC-10), đồng thời thỏa mãn bốn ràng buộc cứng:

1. **Không làm chậm hoặc làm hỏng giao dịch chuyển tiền** (NFR-PERF-01: chuyển tiền p95 < 300 ms ở 120 RPS; Driver D-4: lỗi ở phần phát hiện gian lận không ảnh hưởng luồng tiền).
2. **Mỗi cảnh báo phải giải thích được** vì sao giao dịch bị gắn cờ bằng tiếng Việt cho nhân viên vận hành, và mọi bài kiểm thử chấp nhận (`AC-9.1`, `AC-9.2`, `AC-10.1`, `AC-10.2`) phải tất định (deterministic).
3. **Đạt chất lượng phát hiện thực chất trên dữ liệu kiểm chuẩn** (NFR-FRD-02, NFR-FRD-03: recall ≥ 70 % trên kịch bản mục tiêu, ≤ 20 cảnh báo / 1.000 giao dịch), kể cả trước các hành vi lách ngưỡng cứng như chia nhỏ giao dịch sát ngưỡng (`STRUCTURING`) hoặc rút rỉ rả (`SLOW_DRIP`).
4. **Giữ nguyên kiến trúc một ứng dụng, một Docker image** ([ADR-13](0013-one-app-app-role.md)) và không phát sinh thêm chi phí hạ tầng cho một cụm máy chủ suy luận (inference server) riêng.

## Các phương án

| Tiêu chí | A. Chặn đồng bộ trong luồng chuyển tiền | B. Bất đồng bộ — chỉ 6 luật ngưỡng cố định (`R1–R6`) | **C. Bất đồng bộ — Hybrid theo phiên bản (`R1–R6` + ML in-process qua ONNX)** | D. Bất đồng bộ — tách Microservice Python (`FastAPI`) riêng |
|---|---|---|---|---|
| Ảnh hưởng độ trễ chuyển tiền (NFR-PERF-01) | Xấu: truy vấn lịch sử 30 ngày giữ khóa `FOR UPDATE` lâu, nghẽn tài khoản nóng | Tốt: chỉ `Sync guard` (≤ 5 ms) chạy đồng bộ; chấm điểm chạy ở worker | **Tốt: chỉ `Sync guard` (≤ 5 ms) chạy đồng bộ; chấm điểm chạy ở worker** | Tốt cho API, nhưng worker tốn thêm 10–30 ms gọi mạng nội bộ |
| Tính giải thích & kiểm thử tất định (`AC-9.1`) | Có nếu dùng luật | Có: mỗi luật trả về `RuleHit` rõ ràng | **Có: giữ nguyên 6 luật `R1–R6` tất định và ánh xạ đóng góp đặc trưng (Feature Attribution) của mô hình về đúng 6 nhóm rủi ro `R1–R6`** | Khó đồng bộ phiên bản luật giữa Node.js và Python |
| Khả năng bắt giao dịch lách ngưỡng (`STRUCTURING`, `SLOW_DRIP`) | Kém nếu chỉ dùng ngưỡng cứng | Kém: câu lệnh `if` theo ngưỡng cố định bỏ sót giao dịch ngay sát dưới ngưỡng | **Tốt: vector đặc trưng liên tục + mô hình GBDT/ONNX bắt được tín hiệu kết hợp phi tuyến** | Tốt |
| Tuân thủ ADR-13 (1 image) & chi phí (NFR-COST-01) | 1 image | 1 image | **1 image: huấn luyện bằng Python offline, đóng gói `.onnx` (~100 KB) chạy in-process bằng `onnxruntime-node` (< 2 ms)** | Vi phạm ADR-13: thêm Dockerfile, thêm ECS service, tốn thêm RAM/CPU trên AWS |

## Quyết định

**Chọn Phương án C.** Tách kiểm soát rủi ro thành hai tầng (Tầng 1: `Sync guard` chặn cứng hạn mức/trạng thái bên trong transaction chuyển tiền; Tầng 2: `Async detection` trong module `risk` ở role `worker` chỉ gắn cờ `OPEN` để nhân viên duyệt), trong đó bộ chấm điểm Tầng 2 được điều khiển bởi bảng cấu hình bất biến `risk_rule_sets` theo **3 mức tiến hóa tương thích ngược 100 % với schema DB**:

1. **Phiên bản cấu hình `v1` (`mode: "rule_only"` — Mặc định khi khởi tạo):** Chạy 6 luật hàm thuần `R1–R6` với ngưỡng và trọng số khởi tạo. Đảm bảo tính tất định tuyệt đối cho mọi bài kiểm thử chấp nhận (`AC-9.1`, `AC-9.2`) và luồng chạy cơ sở.
2. **Phiên bản cấu hình `v2` (`mode: "ml_tuned_rules"`):** Vẫn chạy 6 luật `R1–R6` nhưng bộ ngưỡng và trọng số được học tự động bằng Machine Learning (Logistic Regression / Optuna tối ưu F2-score) trên tập dữ liệu `tune`.
3. **Phiên bản cấu hình `v3` (`mode: "hybrid_onnx"`):** Kết hợp điểm của 6 luật `R1–R6` với xác suất gian lận từ mô hình **LightGBM / XGBoost** (huấn luyện bằng Python, xuất ra file `.onnx` đặt trong `backend/src/modules/risk/models/` và chạy in-process trong Worker NestJS). Khi mô hình phát hiện bất thường, bộ quy kết đặc trưng (Feature Attribution / TreeSHAP) ánh xạ nguyên nhân chính về đúng 6 mã nhóm rủi ro `R1–R6` trong bảng `fraud_rule_hits` kèm lời giải thích tiếng Việt.

## Lý do

- **Bảo vệ tuyệt đối đường găng chuyển tiền (D-4, NFR-PERF-01):** Tầng `Sync guard` chỉ kiểm tra trạng thái `ACTIVE`, hạn mức lần, hạn mức ngày (nhờ index-only scan) và số dư ngay sau `SELECT … FOR UPDATE` trong ≤ 5 ms. Toàn bộ truy vấn lịch sử 30 ngày và suy luận mô hình nằm ở `worker` qua hàng đợi `risk-events`.
- **Con người giữ quyết định cuối cùng (BR-11, BR-13):** Hệ thống chỉ tạo cờ `OPEN`, không tự động khóa tài khoản để tránh khóa nhầm khách hàng hợp lệ (hard negatives); khách hàng không bao giờ thấy cờ.
- **Một bộ mã nguồn, chạy cả Online lẫn Offline:** `RiskRule` và bộ chấm điểm nhận dữ liệu từ `FeatureProvider` (`OnlineFeatureProvider` đọc Redis + view `v_transfer_facts`; `OfflineFeatureProvider` đọc CSV trong bộ nhớ), giúp đánh giá 100.000 giao dịch trong vài giây mà không lệch hành vi so với hệ thống thật.
- **Đúng chuẩn MLOps thực tế mà không phá vỡ ADR-13 hay Database Schema:**
  - Huấn luyện mô hình bằng hệ sinh thái Python (`scikit-learn`, `lightgbm`, `xgboost`, `shap`, `onnxmltools`), nhưng suy luận (inference) chạy trực tiếp trong tiến trình Node.js của `worker` qua artifact `.onnx`. Không cần dựng thêm container Python, không tốn thêm chi phí ECS, độ trễ suy luận < 2 ms.
  - Việc quy kết đóng góp đặc trưng của mô hình về 6 chiều rủi ro `R1–R6` (`R1` tần suất, `R2` quy mô tiền/chia nhỏ, `R3` tài khoản mới, `R4` chuyển vòng, `R5` phân tán người nhận, `R6` rút cạn tích lũy) giúp giữ nguyên ràng buộc `CHECK (rule_id IN ('R1'..'R6'))` của bảng `fraud_rule_hits` và cung cấp lời giải thích nhất quán cho nhân viên vận hành.

## Đánh đổi và hệ quả

| Mất gì / rủi ro | Cách giảm thiểu |
|---|---|
| Giao dịch đáng ngờ chỉ bị gắn cờ sau khi tiền đã chuyển xong (`COMPLETED`) | Chấp nhận ở v1 theo BR-11 (nhân viên review và khóa tài khoản ở UC-11, thu hồi phiên tức thì). Hướng mở rộng v2 là giữ tiền chờ duyệt (`HELD`) với giao dịch điểm cực cao và hỗ trợ bút toán đảo (`REVERSAL`). |
| Sự kiện từ SQS có thể đến trễ hoặc giao lại nhiều lần | Mọi cửa sổ thời gian tính theo `occurredAt` của sự kiện; dùng ảnh chụp `fromBalanceBefore` và `fromAccountCreatedAt` trong payload; chống xử lý trùng bằng `processed_events(consumer, event_id)` và member `transferId` trong Redis sorted set. |
| Lỗi khi nạp hoặc chạy file `.onnx` có thể làm gián đoạn bộ chấm điểm | Bọc tầng suy luận ONNX trong cơ chế fail-safe (`try/catch`): nếu mô hình lỗi hoặc bị tắt qua `risk_rule_sets` (`mlEnabled = false`), hệ thống tự động rơi về điểm của 6 luật `R1–R6` và tăng metric `risk_rule_error_total{rule="ML"}`. |
| Quá khớp (overfitting) khi chỉnh tham số và huấn luyện mô hình | Thực thi bức tường độc lập giữa #6 (giữ generator và nhãn `holdout`) và #4 (chỉ chỉnh/train trên tập `tune` 70 % khách hàng, đóng băng cấu hình và chỉ chạy `holdout` đúng một lần ở Tuần 7). |

## Cách kiểm chứng

- **Kiểm thử tự động trong CI:**
  - `AC-5.6`, `AC-5.7`: kiểm thử `Sync guard` dưới tải đồng thời trên PostgreSQL thật (Testcontainers).
  - `AC-9.1`, `AC-9.2`, `AC-10.1`, `AC-10.2`: kiểm thử tạo cờ, chống cờ trùng khi phát lại sự kiện, từ chối review lần hai (`409 FLAG_ALREADY_REVIEWED`), và ẩn cờ với khách hàng.
  - Kiểm thử tương đương: `OnlineFeatureProvider` (có và không có Redis) và `OfflineFeatureProvider` cho ra cùng vector đặc trưng và cùng điểm số trên một tập giao dịch mẫu.
- **Thực nghiệm định lượng trong Báo cáo P5:**
  - Bảng đối sánh trực tiếp 3 phiên bản cấu hình (`v1 Hand-crafted Rules` vs. `v2 ML-Tuned Rules` vs. `v3 Hybrid GBDT/ONNX`) trên tập `holdout` (~30.000 giao dịch) theo Precision, Recall, F1, số cảnh báo / 1.000 giao dịch, Recall theo từng kịch bản (bao gồm `STRUCTURING`, `SLOW_DRIP`), Ablation study và đường cong Precision–Recall.
  - Đo độ trễ p95 từ giao dịch tới khi có cờ (< 5 giây) và tải RDS khi bật/tắt bộ đếm Redis dưới tải 120 RPS.
