# fraud-dataset · Kiểm tra tập dữ liệu giao #4 (DBS-146)

> **Status:** Accepted · **Owner:** Dev dataset · **Verified against code:** `load-tests/fraud-dataset/audit-split.mjs` trên commit `5fba13d`, seed mặc định `dbs-split-v1` · **Cập nhật:** 2026-11-15

Báo cáo ngắn theo DoD 3 của [DBS-146](../../features/DBS-146-dataset-audit.md). Tài liệu này #4 đọc được, nên chỉ ghi kết luận, số gộp và loại phát hiện, **không ghi cơ chế sinh dữ liệu** (FRAUD guide [§6.2](../risk/FRAUD_DETECTION_GUIDE.md#62-chia-tập-và-bức-tường-giữa-4-và-6)). Chi tiết theo kịch bản do Dev dataset giữ.

## Kết luận

| DoD 1/2 | Kết quả |
|---|---|
| Không khách nào ở cả tune lẫn holdout | **Đạt.** 0 khách, 0 tài khoản, 0 `tx_id` chung; 0 dòng tune chạm khách hoặc tài khoản holdout; quét nguyên byte `tune.csv` và `manifest.json` không thấy ID holdout nào |
| Tập giao #4 không có cột nhãn của holdout | **Đạt.** Header đúng 12 cột; manifest đúng 5 khóa `version, columns, sha256, customers, transactions`, khớp từng byte với bản sinh lại; `is_fraud`/`scenario` chỉ là nhãn của chính tune |
| Tỉ lệ gian lận, số tiền, giao dịch/khách/ngày hợp lý | **Đạt.** Bảng dưới |
| Không kịch bản nào có dấu hiệu nhận diện tầm thường | **Đạt một phần** (`dod2: "partial"`): 1 phát hiện loại *tell* và một số phát hiện loại *hạn chế mô phỏng* còn lại, ghi ở [BL-391](../../BACKLOG.md); các trùng khít «trong tầm luật» là chủ đích (mục dưới) |

## Số gộp (tune mặc định, sau sửa generator)

| | Tune | Holdout (chỉ gộp) |
|---|---|---|
| Khách (registry) | 2.800 | 1.200 |
| Giao dịch | 101.551 | 44.660 |
| Tỉ lệ fraud | 0,994% | 0,947% |
| Số tiền NORMAL p50 / p90 / p99 | 467.000 / 2.385.000 / 7.704.000 đồng | — |
| Giao dịch/khách/ngày (gồm ngày không giao dịch) | trung bình 0,604 | — |
| SHA-256 `tune.csv` | `c387b43605d8a9be05dd8288490130295c6d8928c66fb2c16d2f9cbae36f1b01` | không công bố |

Mỗi kịch bản fraud có ≥ 30 dòng ở cả tune lẫn holdout. Hard negatives ít (cả tune lẫn holdout có nhóm < 30 dòng), không đủ đo báo nhầm theo từng nhóm: đã ghi ở [BL-173](../../BACKLOG.md).

## Dấu hiệu nhận diện tầm thường

- **Đã sửa trong DBS-146:** một thuộc tính của tài khoản khiến toàn bộ nhãn fraud nhận ra được chỉ bằng một giá trị (độ phủ ≥ 0,87, lift > 40). Sau sửa, không còn bin nào lộ nhãn fraud chung, ở cả mức dòng lẫn mức tài khoản. Bản sửa không đổi số tiền, thời điểm hay người nhận của bất kỳ dòng nào; hash tune mặc định đổi từ `6366f108…` sang `c387b436…`.
- **Còn lại, không sửa trong task này ([BL-391](../../BACKLOG.md)):** 1 cặp (kịch bản, luật) bị một luật **ngoài** cột «Luật nên bắt» tách ra (*tell*); và một số mẫu do cách bộ mô phỏng dựng đồ thị giao dịch (*hạn chế mô phỏng*). #4 không nên dựa vào số đo trên các kịch bản này như năng lực tổng quát.
- **Trùng khít «trong tầm luật» là chủ đích:** guide §6.1 thiết kế mỗi kịch bản trong tầm luật để luật dự kiến bắt được, nhằm đo recall đúng mục tiêu. Các cặp sau bị luật dự kiến tách ra với tỉ lệ báo nhầm ≤ 1% trên dòng không gian lận: ATO_DRAIN với R1, R5, R6; VELOCITY_BURST với R1; BUST_OUT với R3, R6; ROUND_TRIP với R4. Đặc trưng đúng như mô tả một câu (số tiền nhỏ hoặc lớn, tài khoản mới, chuyển gần hết) cũng được liệt kê là *nội tại*. P5 phải trình bày recall trên các cặp này là recall trên dữ liệu được thiết kế cho luật, không phải khả năng phát hiện chung.
- Ba kịch bản ngoài tầm luật (SLOW_DRIP, STRUCTURING, FAN_IN): không luật nào tách được.

## Rủi ro bức tường dữ liệu (ghi nhận, bàn giao [BL-171](../../BACKLOG.md), [BL-392](../../BACKLOG.md))

1. Holdout sinh lại được từ seed mặc định công khai cộng mã nguồn; bức tường hiện chỉ là quy ước «chỉ #6 đọc thư mục generator».
2. Đánh giá cuối nên dùng seed bí mật. Seed khác sinh lại **cả tune**, nên hash ở trên là của tune khác và tune giao #4 phải được sinh lại, giao lại; `split.mjs` cần đọc seed từ tệp như công cụ kiểm.
3. Hợp đồng kịch bản chi tiết của [DBS-126 §2.3](../../features/DBS-126-fraud-scenarios.md) đang nằm trong `docs/`, nơi #4 đọc được.

## Chạy lại

```bash
node load-tests/fraud-dataset/split.mjs --tune-dir <thư-mục-mới>
node load-tests/fraud-dataset/audit-split.mjs --tune-csv <thư-mục-mới>/tune.csv --tune-manifest <thư-mục-mới>/manifest.json
```

Exit 0 khi mọi kiểm bắt buộc đạt (A1–A6, B1–B3, B5); trường `dod2` là `met` hoặc `partial`. Seed khác: đặt `DBS_AUDIT_SEED_FILE` trỏ tới tệp chứa seed. Công cụ in JSON có chi tiết theo kịch bản cho Dev dataset; không chuyển nguyên JSON đó cho #4.
