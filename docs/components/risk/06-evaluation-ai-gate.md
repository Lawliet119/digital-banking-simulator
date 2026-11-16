# Cổng ADR-14: so sánh B0, B1, B2 trên tập tune (phần offline)

> **Status:** Implemented, kết luận **NO-GO tạm thời, chưa đủ bằng chứng để bật AI** (DBS-212) · **Vai:** #4 Fraud · **Đo ngày:** 2026-11-16 · **Tập đo:** `tune` (chưa đọc holdout) · **Giữ `rule_only`.**

Tài liệu này ghi phần **offline** của cổng đánh giá ở [ADR-14](../../adr/0014-fraud-rules-external-ai.md#cách-kiểm-chứng-và-gate-bật-ai): so B0 (chỉ luật), B1 (chỉ câu trả lời của API AI, phân tích offline) và B2 (luật + API AI) trên cùng giao dịch và **cùng một capture**. Quyết định bật hay tắt AI ghi vào ADR-14 bằng PR riêng và do cả nhóm quyết; tài liệu này không sửa ADR.

## Cách làm

| Bước | Nội dung |
|---|---|
| Dữ liệu | Tập tune của [baseline B0](05-evaluation-b0-baseline.md): seed `dbs-split-v1`, 101.551 giao dịch, sha256 CSV `c387b43605d8a9be05dd8288490130295c6d8928c66fb2c16d2f9cbae36f1b01`. Toàn bộ là dữ liệu tổng hợp; chỉ 11 đặc trưng số rời máy (RSK-05) |
| Mẫu gọi API | 2.021 giao dịch: mọi giao dịch fraud (1.009) và hard negative (12), cộng 1.000 giao dịch NORMAL chọn theo thứ tự băm có seed. Mỗi dòng NORMAL mang trọng số 100,53 (số dòng NORMAL mà nó đại diện), nên số cảnh báo/1.000 giao dịch được dựng lại cho cả tập mà không phải gọi API 100.000 lần |
| Capture | Một lần duy nhất bằng `capture-ai`: model `gpt-6-luna`, rubric `REVIEW_RUBRIC` (`rubricSha256` `3d0fd9246b9967727c0bcec8b58677d6246c0c4a9f1f8787df55bd6d503bb6a8`). 2.021 lần gọi, **2.021 SUCCEEDED**, không retry. Bằng chứng: [`evidence/ai-gate-capture-tune.jsonl`](evidence/ai-gate-capture-tune.jsonl) (sha256 `fe3c3157f51f9d2baec0f1d717d341e89c4d112b8950c2f8678c021bc732ef5e`). B1 và B2 chỉ đọc file này, không gọi lại API |
| Tách theo khách | Khách của tập tune chia bằng băm: **771 khách train** (1.443 dòng) và **309 khách validation** (578 dòng). Không khách nào ở cả hai phía |
| Chọn tham số | Ngưỡng AI và trọng số AI chọn **chỉ trên train**: recall lớn nhất mà số cảnh báo còn trong 20/1.000. Lưới **60 cặp thử** (10 ngưỡng 0,5–0,95 × 6 trọng số 10–60); 35 cặp nằm trong ngân sách. Chọn được ngưỡng **0,75**, trọng số **40** |
| Đo | Trên validation, B0/B1/B2 cùng dòng. Khoảng tin cậy 95% của chênh recall B2 − B0 bằng paired bootstrap theo khách (2.000 lần lấy mẫu, seed cố định) |
| Tái lập | `npm run --silent capture-ai -- --input <tune.csv> --output <capture.jsonl> --seed dbs-split-v1 --max-calls 3000` (cần `OPENAI_API_KEY` trong môi trường) rồi `npm run --silent compare-modes -- --input <tune.csv> --capture <capture.jsonl> --config src/modules/risk/evaluation/configs/v1.json --seed dbs-split-v1` (từ `backend/`). Chạy `compare-modes` trên capture đã có thì không gọi API và cho báo cáo giống từng byte ([`evidence/ai-gate-compare.json`](evidence/ai-gate-compare.json)) |

## Kết quả trên validation (đã nhân trọng số cho cả tập)

| | Precision | Recall | F1 | Cảnh báo / 1.000 |
|---|---:|---:|---:|---:|
| **B0** luật v1 | 100,00% | 19,93% | 33,23% | 1,80 |
| **B1** chỉ AI (xác suất ≥ 0,75) | 16,59% | 28,99% | 21,10% | 15,74 |
| **B2** luật + AI (+40 điểm) | 16,59% | 28,99% | 21,10% | 15,74 |

B1 và B2 trùng nhau vì với trọng số 40 bằng đúng ngưỡng MEDIUM, một câu trả lời AI ≥ 0,75 đã đủ tạo cờ một mình.

**Cờ AI bổ sung** (B2 có, B0 không): 25 giao dịch fraud được bắt thêm, 4 giao dịch NORMAL bị báo nhầm (trong mẫu; ước tính cho cả tập: khoảng 402 báo nhầm).

### Recall theo kịch bản (validation)

| Kịch bản | Trong tầm luật | n | B0 | B1 | B2 |
|---|:---:|---:|---:|---:|---:|
| `BUST_OUT` | có | 29 | 100,00% | 100,00% | 100,00% |
| `ATO_DRAIN` | có | 42 | 33,33% | 66,67% | 66,67% |
| `MULE_FANOUT` | có | 36 | 33,33% | 63,89% | 63,89% |
| `VELOCITY_BURST` | có | 42 | 0,00% | 0,00% | 0,00% |
| `FAN_IN` | không | 38 | 0,00% | 0,00% | 0,00% |
| `SLOW_DRIP` | không | 35 | 0,00% | 0,00% | 0,00% |
| `STRUCTURING` | không | 54 | 0,00% | 0,00% | 0,00% |

`ROUND_TRIP` (trong tầm luật) **không xuất hiện**: tập tune chỉ có 2 khách gây ra 126 giao dịch ROUND_TRIP, và cả hai khách rơi vào nhóm train. Vì vậy «recall gộp 5 kịch bản» bên dưới chỉ gồm 4 kịch bản và không so trực tiếp được với 42,47% của baseline (đo trên cả 5 kịch bản trong toàn tune).

## Đối chiếu ngưỡng cổng ADR-14

| Điều kiện | Đo được | Kết luận |
|---|---|---|
| Recall B2 hơn B0 ít nhất 5 điểm, khoảng tin cậy 95% paired bootstrap theo khách loại trừ 0 | +9,06 điểm, khoảng [4,91; 13,44] | **Đạt** về số, nhưng cận dưới 4,91 gần ngưỡng 5 (xem lưu ý 1 và 2) |
| Recall gộp 5 kịch bản trong tầm luật ≥ 70% | B2 53,69% (B0 36,91%) | **Không đạt** |
| ≤ 20 cờ / 1.000 giao dịch `TRANSFER` | 15,74 (ước lượng có trọng số) | **Đạt** về số, nhưng ước lượng rất lỏng (lưu ý 3) |
| p95 giao dịch → cờ < 5 giây ở 120 RPS cho B0 và B2 | **Chưa đo** | Cần chạy tải trên hệ thống thật, ngoài tầm công cụ offline |

**Kết luận:** thiếu điều kiện recall trong tầm luật và chưa đo độ trễ, nên cổng **chưa mở**. Theo ADR-14, thiếu bằng chứng thì giữ `rule_only` (kết quả hợp lệ). Con số duy nhất cho thấy AI có ích là recall tăng ở `ATO_DRAIN` và `MULE_FANOUT`; AI không bắt được `VELOCITY_BURST`, `FAN_IN`, `SLOW_DRIP`, `STRUCTURING`.

## Lưu ý trước khi tin con số

1. **Kết quả nhạy với cách chọn tham số.** Lần chạy đầu với lưới thô (ngưỡng 0,5/0,7/0,9 và trọng số 20–60) chọn được ngưỡng 0,9 và cho **chênh recall bằng 0**: ở các ngưỡng thấp hơn AI thêm recall nhưng số cảnh báo vọt lên 24–157/1.000 và bị loại khỏi ngân sách. Lưới mịn (60 cặp) tìm ra vùng ở giữa (ngưỡng 0,75) và chênh +9 điểm. Cả hai đều chọn trên train; nhưng việc phải mịn lưới mới thấy lợi ích cho thấy lợi ích nằm ở một dải hẹp. Báo cáo cuối phải ghi số lần thử (60 ở đây, và 2 lưới).
2. **Baseline B0 chưa được chỉnh.** B0 là luật v1 chưa tune (R1 nặng 30 thấp hơn ngưỡng MEDIUM 40, nên `VELOCITY_BURST` bằng 0). Phần lớn recall B2 thêm ở `ATO_DRAIN` và `MULE_FANOUT` có thể đạt được bằng cách chỉnh luật ở DBS-161 (rẻ hơn, giải thích được). **Phải chạy lại `compare-modes` với B0 đã chỉnh trước khi kết luận AI đáng giá.**
3. **Ước lượng cảnh báo/1.000 của B2 dựa trên 4 giao dịch NORMAL bị báo nhầm trong mẫu.** Với số đếm nhỏ như vậy, khoảng tin cậy rộng (cỡ vài lần), nên «15,74 ≤ 20» không chắc. Mẫu NORMAL lớn hơn (hoặc cả tune: ~100.000 lần gọi, khoảng $2,8 theo giá thật bên dưới) sẽ thu hẹp khoảng này.
4. **Độ nhiễu của AI trên giao dịch bình thường:** trong 1.000 giao dịch NORMAL, 148 có xác suất ≥ 0,5 (p90 = 0,59). Mọi hard negative (12/12) có xác suất ≥ 0,5. Ngưỡng cao làm AI bỏ gần hết giá trị; ngưỡng thấp làm cờ tăng gấp hàng chục lần.
5. **Dữ liệu tổng hợp tách rất sạch** (xem phần kiểm ở baseline). Kết quả trên validation là trong tune; kết quả cuối chỉ lấy từ holdout chạy một lần (DBS-168, DBS-169).
6. **Fraud tập trung ở ít khách.** Số khách nguồn của 126 giao dịch mỗi kịch bản: `BUST_OUT` 127, `FAN_IN` 126, nhưng `ATO_DRAIN` 21, `STRUCTURING` 21, `VELOCITY_BURST` 21, `MULE_FANOUT` 19, `SLOW_DRIP` 18 và `ROUND_TRIP` chỉ 2. Chia theo khách (đúng quy tắc) nên validation chỉ có khoảng 6 khách mỗi kịch bản, recall theo kịch bản biến động mạnh, và khoảng bootstrap theo khách dựa nhiều vào `BUST_OUT` và `FAN_IN`. Cần nhiều khách hơn cho mỗi kịch bản (sinh lại tập lớn hơn) trước khi tin các con số theo kịch bản.
7. **Một rubric, một model, một lần capture.** Đổi rubric hoặc ngưỡng gửi đi cần capture mới (ADR-14 yêu cầu ghi số lần thử rubric).

## Chi phí và độ trễ

Số **thực đo** từ capture (không còn là ước tính của baseline): 2.021 lần gọi, 550.436 token input, **khoảng 272 token mỗi lần gọi** (baseline giả định 1.200), tức khoảng **$0,055** cho cả mẫu và khoảng **$0,027 cho 1.000 giao dịch `TRANSFER`** (mỗi giao dịch một lần gọi, không retry). Giả định: $0,10/1M token input và output không tính phí theo guide đã ghi ở [FRAUD-API-01](../../features/FRAUD-API-01-external-ai-decision.md), chưa kiểm lại với trang giá; là ước tính, không phải hóa đơn. Chi phí cho toàn bộ tune (101.551 giao dịch) khoảng $2,8, holdout (khoảng 43.000) khoảng $1,2.

Độ trễ một lần gọi API (concurrency 6, không phải 120 RPS): p50 321 ms, p95 364 ms. Đây **không** phải p95 giao dịch → cờ của cổng.

## Việc còn lại để đóng cổng

| Việc | Task |
|---|---|
| Chỉnh luật B0 và rubric rồi chạy lại `compare-modes` | DBS-161, xem [07](07-tuning-rules.md) |
| Đóng băng cấu hình (luật, ngưỡng, trọng số, rubric) | DBS-168 |
| Chạy holdout đúng một lần | DBS-169 |
| Đo p95 giao dịch → cờ ở 120 RPS cho B0 và B2, kèm cả độ trễ API | tải trên hệ thống thật |
| Ghi quyết định go/no-go vào ADR-14 (PR riêng, cả nhóm quyết) | sau các bước trên |
