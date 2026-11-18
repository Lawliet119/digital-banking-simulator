# Chỉnh luật trên tập tune (DBS-161)

Chọn thủ công ngưỡng và trọng số của luật R1–R6 trên tập tune, mỗi lần chỉnh là một phiên bản cấu hình (ADR-14: không train, không học tự động). Tập holdout không được mở.

## Phạm vi và cách đo

| Mục | Giá trị |
|---|---|
| Dữ liệu | Tập tune của [baseline B0](05-evaluation-b0-baseline.md): seed `dbs-split-v1`, 101.551 giao dịch, sha256 CSV `c387b43605d8a9be05dd8288490130295c6d8928c66fb2c16d2f9cbae36f1b01` (sau [DBS-146](../../features/DBS-146-dataset-audit.md); hash cũ `6366f108…` trước khi sửa ngày mở tài khoản của generator). Mọi số đo ở đây đã chạy lại trên tune mới và trùng khít với bản cũ |
| Chia | Theo khách hàng, 70% train / 30% validation, cùng một hàm với `compare-modes` (`evaluation/customer-split.ts`). Train 69.997 giao dịch (733 fraud), validation 31.554 giao dịch (276 fraud). Không khách nào nằm ở cả hai phần |
| Mục tiêu | Recall lớn nhất với ≤ 20 cảnh báo/1.000 giao dịch (không tối ưu F2). Chọn trên **train**; validation chỉ để kiểm, không để chọn |
| Nhãn | `is_fraud` chỉ dùng để tính mục tiêu (recall) và `scenario` chỉ để báo cáo sau khi đã chọn. Không có tham số nào được chọn riêng cho một kịch bản |
| Đo | `evaluate-rules --part train|validation`: cùng `ScoringService` của worker; lịch sử cho luật vẫn lấy từ cả file |

## Các phiên bản

File cấu hình: `backend/src/modules/risk/evaluation/configs/v1.json` … `v4.json`. Mỗi file là một dòng `risk_rule_sets.config`; số phiên bản trong tên file chỉ là thứ tự thử trên tập tune, chưa phải version đã tạo trong DB (xem "Đưa vào hệ thống").

| Ver | Thay đổi so với bản trước | Lý do |
|---|---|---|
| v1 | Seed của migration `CreateFraudStorage` | Mốc B0 ([05](05-evaluation-b0-baseline.md)) |
| v2 | R1 `maxTransfers` 5 → 2 | Với v1, một đợt 3–5 lệnh trong 10 phút không bao giờ chạm R1. Hạ ngưỡng làm R1 trúng thêm các đợt dồn dập ngắn |
| v3 | R1 `weight` 30 → 40 | Ở v2 một lần trúng R1 (30) vẫn dưới ngưỡng MEDIUM 40 nên không thành cờ. Với trọng số 40, một đợt dồn dập tự nó thành cờ |
| v4 | R2 `weight` 25 → 5 | R2 (số tiền bất thường) chủ yếu cộng thêm vào các giao dịch hợp lệ lớn. Hạ về 5 giữ nó như tín hiệu phụ, bỏ ~0,4 cảnh báo/1.000 mà recall không đổi |

Các tham số khác giữ nguyên: MEDIUM 40, HIGH 70, R3 35, R4 20, R5 40, R6 30 và mọi ngưỡng bên trong luật.

## Bảng trước/sau

Train (chọn trên phần này):

| Ver | Precision | Recall | Cảnh báo/1.000 | Recall trong phạm vi |
|---|---:|---:|---:|---:|
| v1 | 86,59% | 29,06% | 3,51 | 44,19% |
| v2 | 88,67% | 37,38% | 4,41 | 56,85% |
| v3 | 72,08% | 52,11% | 7,57 | 79,25% |
| **v4** | **76,40%** | **52,11%** | **7,14** | **79,25%** |

Validation (chỉ để kiểm):

| Ver | Precision | Recall | Cảnh báo/1.000 | Recall trong phạm vi |
|---|---:|---:|---:|---:|
| v1 | 79,71% | 19,93% | 2,19 | 36,91% |
| v2 | 78,57% | 19,93% | 2,22 | 36,91% |
| v3 | 63,01% | 39,49% | 5,48 | 73,15% |
| **v4** | **68,55%** | **39,49%** | **5,04** | **73,15%** |

"Recall trong phạm vi" là recall gộp trên 5 kịch bản luật nhắm tới (ATO_DRAIN, MULE_FANOUT, VELOCITY_BURST, BUST_OUT, ROUND_TRIP; ROUND_TRIP không có trong validation, xem [05](05-evaluation-b0-baseline.md)).

## Đạt mục tiêu chưa

- **Cảnh báo ≤ 20/1.000: đạt.** v4 ở mức 7,14 (train) và 5,04 (validation).
- **Recall trong phạm vi ≥ 70% (NFR): đạt trên validation** (73,15%) và trên train (79,25%). Ở v1 là 36,91%, chưa đạt.
- **Recall tổng 39,49% trên validation: chưa đạt "lớn nhất có thể" theo nghĩa còn dư ngân sách**: vẫn còn ~15 cảnh báo/1.000 chưa dùng. Lý do là phần còn lại nằm ngoài tầm luật: `STRUCTURING`, `SLOW_DRIP`, `FAN_IN` (127 trong 276 fraud validation) có recall 0% với mọi cấu hình đã thử. Hạ ngưỡng để "dùng hết ngân sách" chỉ thêm cảnh báo sai (cấu hình thử có 15 cảnh báo/1.000 cho cùng recall 39,49%, precision 24,6%), nên không chọn.
- Chênh train–validation (52,11% so với 39,49%) đến từ cơ cấu kịch bản của hai nhóm khách khác nhau, không phải từ tham số riêng cho train: mỗi bước v2→v4 đổi cùng chiều ở cả hai phần.

## Số lần thử (trung thực về việc chọn)

- Quét từng tham số một (18 tham số, mỗi tham số 3–9 giá trị, 2 vòng): khoảng 180 lần đo trên train. Dừng ở recall 52,25%, 15,24 cảnh báo/1.000.
- Quét có khởi động lại ngẫu nhiên trên bảng trúng của từng luật (12 lần, cả trọng số 5–70, MEDIUM 20–65, mọi biến thể tham số luật hợp lệ): 8.592 cấu hình đã chấm trên train. 10/12 lần dừng ở cùng recall 52,25% (train) và 39,49% (validation), nên không có cấu hình nào tốt hơn v3/v4 về recall; v4 được chọn vì ít thay đổi nhất so với v1 trong số các cấu hình ngang recall, và có số cảnh báo thấp.
- Rubric: không đổi trong phần này (chỉ một rubric, xem [06](06-evaluation-ai-gate.md)). Tham số AI chưa được chọn ở đây ngoài lưới 60 cặp của `compare-modes`.
- Hai script quét là script nháp ngoài repo; mọi con số trong các bảng trên được tính lại bằng CLI có trong repo (lệnh bên dưới), không lấy từ script nháp.
- Cột `scenario` và `is_fraud` không là đầu vào của bất kỳ luật nào; chỉ dùng để chấm điểm.

## Chạy lại cổng ADR-14 với B0 đã chỉnh

`compare-modes` trên capture AI sẵn có (không gọi API) với v4: [`evidence/ai-gate-compare-v4.json`](evidence/ai-gate-compare-v4.json).

| Mục cổng | v1 (trước) | v4 (sau) |
|---|---|---|
| Recall tăng của B2 so với B0 ≥ 5 điểm, khoảng 95% loại trừ 0 | không đạt | **không đạt**: 0,00 điểm, khoảng [0,00; 0,00] (AI không thêm cờ nào ở tham số đã chọn trên train: ngưỡng 0,7, trọng số 20) |
| Recall trong phạm vi ≥ 70% | không đạt | đạt (73,15%, B0 và B2 như nhau) |
| ≤ 20 cờ/1.000 TRANSFER | đạt | đạt (3,56 theo ước tính có trọng số của mẫu) |
| p95 giao dịch → cờ < 5 s ở 120 RPS | chưa đo | chưa đo |

Kết luận: sau khi chỉnh B0, luật một mình đã đạt ngưỡng recall trong phạm vi, và AI không cho thêm giá trị đo được trên tập tune. Phán quyết cổng vẫn là **NO-GO tạm thời, giữ `rule_only`**; quyết định go/no-go ghi vào ADR-14 là PR riêng của cả nhóm, sau DBS-168/169 và đo p95.

## Tái lập

Từ `backend/`, với `tune.csv` sinh bởi `split.mjs --seed dbs-split-v1 ...` (xem [05](05-evaluation-b0-baseline.md)):

```bash
for v in 1 2 3 4; do for p in train validation; do
  npm run --silent evaluate-rules -- --input <tune.csv> \
    --config src/modules/risk/evaluation/configs/v$v.json --config-version $v \
    --seed dbs-split-v1 --part $p
done; done

npm run --silent compare-modes -- --input <tune.csv> \
  --capture ../docs/components/risk/evidence/ai-gate-capture-tune.jsonl \
  --config src/modules/risk/evaluation/configs/v4.json --config-version 4 --seed dbs-split-v1
```

## Đưa vào hệ thống

Các file `v2`–`v4` mới chỉ nằm ở repo để đo. Tạo version thật trong `risk_rule_sets` và kích hoạt nó đổi hành vi chấm điểm của hệ thống đang chạy, nên làm qua API cấu hình luật (UC-12, DBS-160) theo quyết định của nhóm, sau khi cấu hình được đóng băng (DBS-168).

## Còn lại sau DBS-161

| Việc | Task |
|---|---|
| Đóng băng cấu hình (luật, ngưỡng, trọng số, rubric) | DBS-168 |
| Chạy holdout đúng một lần | DBS-169 |
| Đo p95 giao dịch → cờ ở 120 RPS cho B0 và B2 | tải trên hệ thống thật |
| Ghi quyết định go/no-go vào ADR-14 | sau các bước trên |
