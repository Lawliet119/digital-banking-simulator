# Bảng chỉ số đầu của luật R1–R6 (B0, baseline)

> **Status:** Implemented (DBS-133) · **Vai:** #4 Fraud · **Đo ngày:** 2026-11-16 · **Tập đo:** `tune` (chưa đọc holdout) · **Công cụ:** `evaluate-rules` (DBS-132, [scripts README](../../../backend/src/scripts/README.md))

Đây là số đo **trước khi chỉnh**: cấu hình v1 như trong migration, chế độ `rule_only` (B0, chỉ luật, không gọi API AI). Nó là baseline để so với B2 (luật + API AI, DBS-212) và với các bản chỉnh ở DBS-161. Không phải kết quả cuối: kết quả cuối chỉ lấy từ holdout, chạy một lần sau khi đóng băng cấu hình (DBS-168, DBS-169).

## Điều kiện đo

| Mục | Giá trị |
|---|---|
| Phiên bản cấu hình | `v1` (`backend/src/modules/risk/evaluation/configs/v1.json`, bản sao seed của migration `CreateFraudStorage`): `rule_only`, ngưỡng MEDIUM 40, HIGH 70; trọng số R1 30, R2 25, R3 35, R4 20, R5 40, R6 30 |
| Seed | `dbs-split-v1`, 4.000 khách, 60 ngày; tập tune là 70% khách = 2.800 khách |
| CSV | 101.551 giao dịch `TRANSFER`, 1.009 giao dịch fraud (0,99%); sha256 `c387b43605d8a9be05dd8288490130295c6d8928c66fb2c16d2f9cbae36f1b01` |
| Cách đo | Một giao dịch có cờ khi mức rủi ro là MEDIUM hoặc HIGH (điểm ≥ 40), cùng điều kiện tạo `fraud_flags`. Mẫu số cảnh báo/1.000 là số giao dịch `TRANSFER` |
| Tái lập | `node load-tests/fraud-dataset/split.mjs --seed dbs-split-v1 --customers 4000 --days 60 --tune-dir <thư mục mới>` rồi `npm run --silent evaluate-rules -- --input <thư mục>/tune.csv --config src/modules/risk/evaluation/configs/v1.json --config-version 1 --seed dbs-split-v1` (từ `backend/`). Chạy hai lần cho hai báo cáo JSON giống từng byte; mất khoảng 24 giây |

## Kết quả

| | Thực tế: gian lận | Thực tế: bình thường |
|---|---:|---:|
| **Có cờ** | TP 268 | FP 47 |
| **Không cờ** | FN 741 | TN 100.495 |

| Chỉ số | Giá trị |
|---|---:|
| Precision | 85,08% |
| Recall (toàn bộ 8 kịch bản) | 26,56% |
| F1 | 40,48% |
| False positive rate | 0,047% |
| Cảnh báo / 1.000 giao dịch | 3,10 |
| Recall gộp 5 kịch bản trong tầm luật | 268/631 = **42,47%** |

### Recall theo kịch bản

| Kịch bản | Trong tầm luật | Bắt được | Recall |
|---|:---:|---:|---:|
| `BUST_OUT` | có | 127/127 | 100,00% |
| `ROUND_TRIP` | có | 63/126 | 50,00% |
| `ATO_DRAIN` | có | 42/126 | 33,33% |
| `MULE_FANOUT` | có | 36/126 | 28,57% |
| `VELOCITY_BURST` | có | 0/126 | 0,00% |
| `FAN_IN` | không | 0/126 | 0,00% |
| `SLOW_DRIP` | không | 0/126 | 0,00% |
| `STRUCTURING` | không | 0/126 | 0,00% |

### Hard negative (giao dịch hợp lệ giống gian lận) bị gắn cờ

| Hard negative | Bị cờ / tổng |
|---|---:|
| `HN_BORROW_REPAY` | 1/2 |
| `HN_GROUP_MEAL` | 1/5 |
| `HN_NEW_SALARY` | 0/1 |
| `HN_RENT` | 0/3 |
| `HN_SELF_TRANSFER` | 0/1 |

Chỉ có 12 hard negative trong tập tune, quá ít để rút kết luận về tỉ lệ báo nhầm theo loại; chỉ dùng như tín hiệu.

## So với mục tiêu đã chốt (NFR-FRD-02, DBS-29)

| Mục tiêu | Ngưỡng | Đo được | Kết luận |
|---|---|---:|---|
| Khối lượng cảnh báo | ≤ 20 / 1.000 giao dịch | 3,10 | Đạt, còn dư nhiều chỗ để hạ ngưỡng |
| Recall gộp 5 kịch bản trong tầm luật | ≥ 70% | 42,47% | **Chưa đạt** (thiếu 27,5 điểm phần trăm) |

Mục tiêu cuối tính trên holdout, không phải số này.

## Đọc kết quả

- **Vì sao `VELOCITY_BURST` bằng 0:** R1 (vượt 5 lệnh trong 10 phút) nặng 30, thấp hơn ngưỡng MEDIUM 40, nên R1 đứng một mình không bao giờ tạo cờ; kịch bản này chỉ có cờ khi trùng với luật khác. Trọng số R1 hoặc ngưỡng là chỗ chỉnh đầu tiên ở DBS-161. Có thể hạ ngưỡng MEDIUM hoặc tăng trọng số, vì ngân sách cảnh báo còn dư (3,10 so với 20).
- **Ba kịch bản ngoài tầm** (`FAN_IN`, `SLOW_DRIP`, `STRUCTURING`) bằng 0 đúng như thiết kế; chúng là chỗ B2 (API AI) có thể thêm giá trị, và là câu hỏi của DBS-212.
- Precision cao (85%) cùng recall thấp cho thấy luật hiện chặt: bắt ít nhưng ít sai.

## Kiểm tra số đẹp bất thường và rò rỉ nhãn

Số duy nhất ≈ 100% là `BUST_OUT` (127/127). Đã kiểm trước khi tin:

1. **Điểm chỉ dùng đặc trưng quan sát được.** `ScoringService` nhận sự kiện và `Features` do `OfflineFeatureProvider` tính từ các giao dịch, không có tham số nào cho `is_fraud` hay `scenario`. `evaluate-rules` chỉ đọc hai cột đó để đếm TP/FP/FN/TN và nhóm theo kịch bản sau khi đã chấm xong.
2. **Cơ chế tìm được từ chính dữ liệu tune** (không đọc code generator, đúng bức tường #4/#6): mọi 127 dòng `BUST_OUT` có số tiền trên 10.000.000đ, số tiền từ 90% số dư trước đó trở lên, và tài khoản nguồn mở 1 giờ trước giao dịch. Đó là R3 (35, tài khoản mới chuyển lớn) cộng R6 (30, rút cạn) = 65 điểm, vượt ngưỡng MEDIUM 40, nên 100% là hệ quả của luật chứ không phải nhãn lọt vào.
3. **Giới hạn cần nói rõ:** kịch bản tổng hợp này tách biệt rất sạch với luật (ba đặc điểm cùng lúc), nên 100% phản ánh dữ liệu tổng hợp dễ, không phản ánh gian lận thật. Không dùng con số này để suy ra chất lượng ngoài đời.
4. **Tập tune và holdout không chia sẻ khách:** sinh từ hai seed độc lập qua `split.mjs` (kiểm va chạm customerId trong code) và đang được kiểm riêng ở DBS-146. Lần đo này không đọc holdout; holdout cũng chưa được lưu.

## Ngân sách API ước tính cho các lần chạy capture sau

Đây là **ước tính theo giả định**, không phải hóa đơn thực. Số thật lấy từ `usage` của từng lần gọi trong capture (DBS-212).

| Giả định | Giá trị | Nguồn |
|---|---|---|
| Giá input | $0,10 / 1 triệu token; output không tính phí | Guide OpenAI Decisions, ghi lại ở [FRAUD-API-01](../../features/FRAUD-API-01-external-ai-decision.md); chưa được kiểm lại lúc đo |
| Token mỗi lần gọi | khoảng 1.200 input (rubric tối đa 4.000 ký tự khoảng 1.000 token cộng 11 đặc trưng) | Ước lượng, chưa đo |
| Số lần gọi mỗi giao dịch | 1 (B1 và B2 dùng chung một capture, ADR-14) | ADR-14 |
| Cache prompt | không tính (đã tính cao nhất) | |

| Lần chạy | Số giao dịch | Chi phí ước tính |
|---|---:|---:|
| Thử khói | 20 | dưới $0,01 |
| Mẫu phân tầng (mọi giao dịch fraud trong mẫu + mẫu NORMAL) | khoảng 2.000 | khoảng $0,24 |
| Toàn bộ tune | 101.551 | khoảng $12,2 |
| Holdout (khoảng 30% khách, một lần) | khoảng 43.000 | khoảng $5,2 |

Mỗi lần chạy lại rubric hoặc ngưỡng cần capture mới nếu thay đổi nội dung gửi đi; báo cáo phải nêu số lần thử (ADR-14). Trần theo ngày đặt bằng `RISK_AI_DAILY_REQUEST_CAP`.
