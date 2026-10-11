# ADR-08: Phát hiện gian lận bất đồng bộ — 6 luật giải thích được, học tham số theo phiên bản, mô hình ML in-process (ONNX) là mở rộng có điều kiện

| | |
|---|---|
| Trạng thái | **Proposed** — chờ nhóm review |
| Ngày | 2026-10-11 |
| Người viết | #4 (Fraud); chỉnh sửa lần 2 bởi tech lead (2026-10-11) |
| Người duyệt | #1 (Ledger); cả nhóm |
| Liên quan | Driver D-4 · BR-06, BR-11, BR-13 · UC-9, UC-10, UC-12 · NFR-FRD-01…03, NFR-PERF-01 · ADR-03, ADR-12, [ADR-13](0013-one-app-app-role.md) · [`docs/03` §15](../03_HIGH_LEVEL_ARCHITECTURE.md) · [FRAUD guide §4.3.b](../components/risk/FRAUD_DETECTION_GUIDE.md) |

## Bối cảnh

Hệ thống cần phát hiện giao dịch chuyển tiền đáng ngờ sớm (NFR-FRD-01: từ lúc giao dịch hoàn tất tới lúc có cờ p95 < 5 giây) và đưa tới nhân viên vận hành xem xét kèm lời giải thích rõ ràng (BR-11, UC-10), đồng thời thỏa mãn bốn ràng buộc cứng:

1. **Không làm chậm hoặc làm hỏng giao dịch chuyển tiền** (NFR-PERF-01: chuyển tiền p95 < 300 ms ở 120 RPS; Driver D-4: lỗi ở phần phát hiện gian lận không ảnh hưởng luồng tiền).
2. **Mỗi cảnh báo phải giải thích được** vì sao giao dịch bị gắn cờ bằng tiếng Việt cho nhân viên vận hành, và mọi bài kiểm thử chấp nhận (`AC-9.1`, `AC-9.2`, `AC-10.1`, `AC-10.2`) phải tất định (deterministic).
3. **Đạt chất lượng phát hiện thực chất trên dữ liệu kiểm chuẩn** (NFR-FRD-02: recall ≥ 70 % trên kịch bản mục tiêu và ≤ 20 cảnh báo / 1.000 giao dịch; NFR-FRD-03: có báo cáo precision, recall, F1 trên tập giữ lại), kể cả trước các hành vi lách ngưỡng cứng như chia nhỏ giao dịch sát ngưỡng (`STRUCTURING`) hoặc rút rỉ rả (`SLOW_DRIP`).
4. **Giữ nguyên kiến trúc một ứng dụng, một Docker image** ([ADR-13](0013-one-app-app-role.md)) và không phát sinh thêm chi phí hạ tầng cho một cụm máy chủ suy luận (inference server) riêng.

## Các phương án

| Tiêu chí | A. Chặn đồng bộ trong luồng chuyển tiền | B. Bất đồng bộ — chỉ 6 luật ngưỡng cố định (`R1–R6`) | **C. Bất đồng bộ — theo phiên bản: 6 luật (`v1`), luật học tham số (`v2`), thêm ML in-process qua ONNX (`v3`, có điều kiện)** | D. Bất đồng bộ — tách Microservice Python (`FastAPI`) riêng |
|---|---|---|---|---|
| Ảnh hưởng độ trễ chuyển tiền (NFR-PERF-01) | Xấu: truy vấn lịch sử 30 ngày giữ khóa `FOR UPDATE` lâu, nghẽn tài khoản nóng | Tốt: chỉ `Sync guard` (≤ 5 ms) chạy đồng bộ; chấm điểm chạy ở worker | **Tốt: như B** | Tốt cho API, nhưng worker tốn thêm 10–30 ms gọi mạng nội bộ |
| Tính giải thích & kiểm thử tất định (`AC-9.1`) | Có nếu dùng luật | Có: mỗi luật trả về `RuleHit` rõ ràng | **Có ở `v1`, `v2` (vẫn là luật). `v3` giữ nguyên các luật, phần mô hình chỉ cộng điểm và được quy về nhóm `R1–R6` bằng phương pháp ở mục «Quy tắc cho `v3`»** | Khó đồng bộ phiên bản luật giữa Node.js và Python |
| Khả năng bắt giao dịch lách ngưỡng (`STRUCTURING`, `SLOW_DRIP`) | Kém nếu chỉ dùng ngưỡng cứng | Kém: ngưỡng cố định bỏ sót giao dịch ngay sát dưới ngưỡng | **`v1`, `v2` kém; `v3` kỳ vọng tốt hơn nhờ đặc trưng liên tục, nhưng chỉ giữ lại nếu vượt cổng go/no-go (đo, không giả định)** | Tốt |
| Tuân thủ ADR-13 (1 image) & chi phí (NFR-COST-01) | 1 image | 1 image | **`v1`, `v2`: 1 image, không thêm gì. `v3`: 1 image nhưng thêm gói `onnxruntime-node` (bản 1.30.0 nặng khoảng 301 MB sau giải nén, có script cài đặt) và file mô hình; image gốc đang là `node:24-alpine` nên phải kiểm chứng ở cổng go/no-go** | Vi phạm ADR-13: thêm Dockerfile, thêm ECS service, tốn thêm RAM/CPU trên AWS |

## Quyết định

**Chọn Phương án C, triển khai theo giai đoạn.** Tách kiểm soát rủi ro thành hai tầng (Tầng 1: `Sync guard` chặn cứng hạn mức/trạng thái bên trong transaction chuyển tiền; Tầng 2: `Async detection` trong module `risk` ở role `worker` chỉ gắn cờ `OPEN` để nhân viên duyệt), trong đó bộ chấm điểm Tầng 2 được điều khiển bởi bảng cấu hình bất biến `risk_rule_sets` theo 3 chế độ, **không đổi schema** (cột `config` là `jsonb`):

1. **`v1` (`mode: "rule_only"`) — bắt buộc, mặc định khi khởi tạo:** chạy 6 luật hàm thuần `R1–R6` với ngưỡng và trọng số khởi tạo. Là baseline và là cơ sở cho mọi bài kiểm thử chấp nhận (`AC-9.1`, `AC-9.2`).
2. **`v2` (`mode: "ml_tuned_rules"`) — phạm vi chính:** vẫn chạy đúng 6 luật `R1–R6`, nhưng ngưỡng và trọng số được **học từ dữ liệu** trên tập `tune` (Logistic Regression hoặc tìm kiếm tham số). Mục tiêu tối ưu: **recall lớn nhất với ràng buộc ≤ 20 cảnh báo / 1.000 giao dịch** (không tối ưu F2, vì F2 ưu tiên recall và dễ đẩy số cảnh báo vượt NFR-FRD-02).
3. **`v3` (`mode: "hybrid_onnx"`) — mở rộng có điều kiện:** cộng thêm điểm từ mô hình LightGBM / XGBoost (huấn luyện bằng Python, xuất `.onnx`, chạy in-process trong worker). **Chỉ được đưa vào hệ thống nếu qua cổng go/no-go ở cuối tuần 5** (bên dưới). Không qua thì dừng ở `v2` và báo cáo P5 ghi rõ lý do, đây vẫn là kết quả hợp lệ.

### Cổng go/no-go cho `v3` (cuối tuần 5, #4 làm, #1 review, tech lead quyết)

`v3` chỉ được hiện thực khi cả năm điều kiện sau đúng *(GĐ, chốt số khi làm spike)*:

1. `onnxruntime-node` cài được trên **image production hiện tại** và ứng dụng khởi động, nạp được mô hình. Nếu chỉ chạy được khi đổi base image khỏi `node:24-alpine` thì đây là thay đổi của ADR-13 và phải được nhóm duyệt riêng.
2. Mức tăng kích thước image được đo, ghi lại và chấp nhận (đề xuất ≤ 150 MB).
3. Suy luận **cộng** bước quy kết nhóm (mục dưới) p95 ≤ 15 ms cho một sự kiện trên cấu hình task thật.
4. Xác suất do Python dự đoán và do `onnxruntime-node` dự đoán lệch ≤ 1e-4 trên ít nhất 1.000 mẫu (kiểm tra float32).
5. Trên cross-validation theo khách trong tập `tune`, `v3` có recall cao hơn `v2` ở cùng mức ≤ 20 cảnh báo / 1.000, đặc biệt ở `STRUCTURING` và `SLOW_DRIP`. Nếu không hơn thì không đáng thêm phụ thuộc.

### Quy tắc cho `v3` (nếu qua cổng)

- **Đặc trưng:** vector 12 đặc trưng liên tục chia thành 6 nhóm tương ứng `R1–R6`, định nghĩa ở [FRAUD guide §4.3.b](../components/risk/FRAUD_DETECTION_GUIDE.md). Mọi đặc trưng chỉ dùng dữ liệu **trước** `occurredAt` (point-in-time) và **không** dùng cột `scenario` hay `is_fraud` của bộ dữ liệu.
- **Một nguồn tính đặc trưng:** `OfflineFeatureProvider` (TypeScript) xuất CSV đặc trưng; Python chỉ huấn luyện từ CSV đó, không tự tính đặc trưng. Nhờ vậy hai môi trường huấn luyện và chạy thật không lệch nhau.
- **Công thức điểm:** `score = Σ trọng số luật kích hoạt + round(ml.weight × p)` nếu `p ≥ ml.threshold`, ngược lại phần mô hình bằng 0 (`p` là xác suất gian lận, mặc định `ml.weight = 40`, `ml.threshold = 0,5` *(GĐ)*). Mức rủi ro dùng cùng ngưỡng với `v1` (LOW < 40, MEDIUM 40–69, HIGH ≥ 70).
- **Quy kết về nhóm `R1–R6`:** với mỗi nhóm đặc trưng, tính đóng góp = `p − p'`, trong đó `p'` là xác suất khi đặt các đặc trưng của nhóm đó về giá trị cơ sở (trung vị trên tập `tune`, lưu trong cấu hình). Nhóm có đóng góp dương lớn nhất nhận điểm của mô hình. Cách này chỉ cần thêm 6 lần suy luận nhẹ và không cần TreeSHAP trong worker; TreeSHAP vẫn dùng ngoại tuyến để vẽ biểu đồ trong báo cáo P5.
- **Ghi `fraud_rule_hits` (không đổi schema, khóa chính `(transfer_id, rule_id)`):** mỗi nhóm một dòng. Nếu luật của nhóm đó đã kích hoạt thì giữ dòng luật, cộng điểm mô hình vào `weight` và nối thêm « · [AI] …» vào `explanation`. Nếu chưa, tạo dòng mới với `weight` = điểm mô hình và `explanation` bắt đầu bằng «[AI-Rn]». Nhờ đó tổng `weight` của các dòng luôn bằng `score` của cờ.
- **An toàn khi lỗi:** file mô hình có `sha256` ghi trong cấu hình (`ml.modelSha256`) và được kiểm khi nạp. Sai mã băm, không nạp được hoặc suy luận lỗi thì sự kiện đó chấm bằng 6 luật, tăng `risk_rule_error_total{rule="ML"}`. Công tắc khẩn cấp: tạo phiên bản cấu hình mới với `ml.enabled = false`.
- **Đóng gói:** mô hình nằm ở `backend/models/` (ngoài `src`, vì `nest build` không sao chép file không phải mã nguồn) và được `COPY` rõ ràng vào image. Công cụ Python (`lightgbm`, `scikit-learn`, `shap`, `onnxmltools`) nằm ở `backend/ml/` kèm `requirements.txt`, **không** vào image production.

## Lý do

- **Bảo vệ tuyệt đối đường găng chuyển tiền (D-4, NFR-PERF-01):** `Sync guard` chỉ kiểm tra trạng thái `ACTIVE`, hạn mức lần, hạn mức ngày (nhờ index-only scan) và số dư ngay sau `SELECT … FOR UPDATE` trong ≤ 5 ms. Mọi truy vấn lịch sử 30 ngày và suy luận mô hình nằm ở `worker` qua hàng đợi `risk-events`.
- **Con người giữ quyết định cuối cùng (BR-11, BR-13):** hệ thống chỉ tạo cờ `OPEN`, không tự động khóa tài khoản để tránh khóa nhầm khách hàng hợp lệ (hard negatives); khách hàng không bao giờ thấy cờ.
- **Làm từng bước, rủi ro tăng dần:** `v1` đủ để hoàn thành mọi yêu cầu và bài kiểm thử. `v2` thêm giá trị học từ dữ liệu mà không thêm phụ thuộc. `v3` là phần tham vọng nhưng chỉ vào hệ thống khi đã đo được lợi ích và chi phí.
- **Một bộ mã nguồn, chạy cả Online lẫn Offline:** `RiskRule` và bộ chấm điểm nhận dữ liệu từ `FeatureProvider` (`OnlineFeatureProvider` đọc Redis + view `v_transfer_facts`; `OfflineFeatureProvider` đọc CSV trong bộ nhớ), giúp đánh giá 100.000 giao dịch trong vài giây mà không lệch hành vi so với hệ thống thật.
- **Giữ nguyên ràng buộc DB:** `CHECK (rule_id IN ('R1'..'R6'))` của `fraud_rule_hits` và quy tắc «một dòng mỗi nhóm» ở trên không cần đổi schema.

## Đánh đổi và hệ quả

| Mất gì / rủi ro | Cách giảm thiểu |
|---|---|
| Giao dịch đáng ngờ chỉ bị gắn cờ sau khi tiền đã chuyển xong (`COMPLETED`) | Chấp nhận ở v1 theo BR-11 (nhân viên review và khóa tài khoản ở UC-11, thu hồi phiên tức thì). Hướng mở rộng v2 của hệ thống là giữ tiền chờ duyệt (`HELD`) với giao dịch điểm cực cao và hỗ trợ bút toán đảo (`REVERSAL`). |
| Sự kiện từ SQS có thể đến trễ hoặc giao lại nhiều lần | Mọi cửa sổ thời gian tính theo `occurredAt` của sự kiện; dùng ảnh chụp `fromBalanceBefore` và `fromAccountCreatedAt` trong payload; chống xử lý trùng bằng `processed_events(consumer, event_id)` và member `transferId` trong Redis sorted set. |
| `v3` kéo theo gói native nặng, có thể không chạy trên base image hiện tại | Cổng go/no-go (điều kiện 1 và 2) chặn trước khi viết code; không qua thì dừng ở `v2`. |
| Lỗi khi nạp hoặc chạy file `.onnx`, hoặc file bị thay | Kiểm `sha256`, bọc `try/catch`, rơi về 6 luật, có metric và công tắc `ml.enabled = false`. |
| Quá khớp (overfitting) khi học tham số hoặc huấn luyện mô hình; chọn phiên bản tốt nhất trên holdout là rò rỉ | Thực thi bức tường giữa #6 (giữ generator và nhãn `holdout`) và #4 (chỉ train/tune trên tập `tune`, dùng cross-validation **theo khách**). **Đóng băng cả ba phiên bản (`v1`, `v2`, `v3`) trước khi chạy holdout, chạy holdout đúng một lần, báo cáo cả ba, không chọn phiên bản dựa trên holdout.** |
| Mô hình học đúng mẫu do chính generator của #6 sinh ra, không phản ánh gian lận thật | Nêu rõ trong P5 đây là dữ liệu tổng hợp; giữ 3 kịch bản ngoài tầm luật để đo trung thực; báo cáo recall theo từng kịch bản. |
| Khối lượng công việc của #4 ở tuần 5–6 tăng | Spike ở tuần 5 chạy song song với API review; nếu `v3` không qua cổng thì phần việc tuần 6 chỉ còn `v2`. |

## Cách kiểm chứng

- **Kiểm thử tự động trong CI:**
  - `AC-5.6`, `AC-5.7`: kiểm thử `Sync guard` dưới tải đồng thời trên PostgreSQL thật (Testcontainers).
  - `AC-9.1`, `AC-9.2`, `AC-10.1`, `AC-10.2`: kiểm thử tạo cờ, chống cờ trùng khi phát lại sự kiện, từ chối review lần hai (`409 FLAG_ALREADY_REVIEWED`), và ẩn cờ với khách hàng.
  - Kiểm thử tương đương: `OnlineFeatureProvider` (có và không có Redis) và `OfflineFeatureProvider` cho ra cùng vector đặc trưng và cùng điểm số trên một tập giao dịch mẫu.
  - Chỉ khi có `v3`: kiểm thử sai/đổi `sha256` thì rơi về luật; kiểm thử tổng `weight` của `fraud_rule_hits` bằng `score`; kiểm thử khớp xác suất Python và ONNX.
- **Thực nghiệm định lượng trong Báo cáo P5:**
  - Bảng đối sánh các phiên bản đã đóng băng (`v1`, `v2` và `v3` nếu có) trên tập `holdout` (~30.000 giao dịch) theo Precision, Recall, F1, số cảnh báo / 1.000 giao dịch, Recall theo từng kịch bản (kể cả `STRUCTURING`, `SLOW_DRIP`), Ablation study và đường cong Precision–Recall.
  - Đo độ trễ p95 từ giao dịch tới khi có cờ (< 5 giây) và tải RDS khi bật/tắt bộ đếm Redis dưới tải 120 RPS; với `v3`, đo thêm độ trễ suy luận và mức tăng kích thước image.
