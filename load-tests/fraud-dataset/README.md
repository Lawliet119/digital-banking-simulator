# Bộ dữ liệu giao dịch tổng hợp

> **Status:** Implemented (NORMAL và mixed; chia/giao tune–holdout thuộc DBS-127) · **Owner:** Dev dataset (#6) · **Verified against code:** CLI và Node tests

Chạy bằng Node 24 tại gốc repo. Script chỉ tạo dữ liệu tổng hợp cục bộ, không kết nối backend/DB/AWS. CSV, manifest và thống kê đầu ra nằm trong `load-tests/results/` đã gitignore.

## Bộ mixed có gian lận và hard negatives

```bash
node load-tests/fraud-dataset/generate-fraud.mjs --output load-tests/results/fraud-mixed.csv
node load-tests/fraud-dataset/inspect-fraud.mjs --csv load-tests/results/fraud-mixed.csv --simulation load-tests/results/fraud-mixed.csv.simulation.json
node --test load-tests/fraud-dataset/generate.test.mjs load-tests/fraud-dataset/inspect-fraud.test.mjs load-tests/fraud-dataset/generate-fraud.test.mjs
```

Tùy chọn mixed: `--seed` (1–128 ký tự, mặc định `dbs-fraud-v1`), `--customers` (số nguyên 1.000–100.000, mặc định 2.000), `--days` (30–90, mặc định 60), `--output` (mặc định `load-tests/results/fraud-mixed.csv`). Cùng seed/tham số cho cả ba artifact bằng bytes, không phụ thuộc timezone máy hoặc output path. Tham số sai bị từ chối trước ghi file; CLI exit 1 khi generation/validation/I/O lỗi, chỉ in summary thành công sau khi ghi đủ ba file. Không coi một file ghi dở do lỗi I/O là bộ dữ liệu thành công.

| Artifact | Nội dung |
|---|---|
| `<output>` | CSV 12 cột như bộ NORMAL; `is_fraud=1` cho tám scenario fraud, `0` cho NORMAL và HN |
| `<output>.simulation.json` | Registry customer/account, thời điểm mở, vốn đầu, lương/cấp vốn và số dư cuối; chỉ phục vụ replay, không dùng làm feature scoring |
| `<output>.stats.json` | Hash CSV, số giao dịch/từng scenario, fraud rate, phân phối số tiền, hoạt động/khách/ngày và tổng bảo toàn tiền |

Inspector độc lập kiểm header/ID/owner/nhãn, thứ tự thời gian, mọi snapshot, credit và số dư cuối từ CSV + manifest. Test ngữ nghĩa từng scenario kiểm hành vi và các điều kiện v1; inspector không thay scoring runtime hoặc chứng minh recall. Tiền trên artifact là chuỗi nguyên đồng, so sánh/replay bằng BigInt. Quantile lấy phần tử tại `floor((n-1)*p)` trong dãy đã sắp, không nội suy; số giao dịch/khách/ngày cộng các tài khoản cùng chủ, theo ngày Việt Nam, gồm cả ngày/khách không giao dịch.

| Nhóm | Mô tả dành cho người dùng dữ liệu |
|---|---|
| ATO_DRAIN | Tài khoản bị chiếm đoạt và chuyển gần hết tiền cho người nhận mới |
| MULE_FANOUT | Tài khoản trung gian nhận rồi phân tán tiền |
| VELOCITY_BURST | Nhiều lệnh nhỏ trong thời gian ngắn |
| BUST_OUT | Tài khoản mới chuyển số tiền lớn ngay |
| ROUND_TRIP | Chuyển tiền qua lại để làm rối dòng tiền |
| SLOW_DRIP | Rút nhỏ dần trong nhiều ngày, ngoài tầm chủ đích của luật |
| STRUCTURING | Chia nhỏ khoản tiền dưới mốc minh họa, ngoài tầm chủ đích của luật |
| FAN_IN | Nhiều nguồn tập trung vào một tài khoản, ngoài tầm chấm phía gửi |
| HN_RENT | Tiền thuê nhà lớn, định kỳ, hợp lệ |
| HN_SELF_TRANSFER | Chuyển phần lớn số dư giữa hai tài khoản cùng chủ, hợp lệ |
| HN_NEW_SALARY | Khách mới nhận lương rồi chuyển khoản lớn, hợp lệ |
| HN_GROUP_MEAL | Chia tiền ăn cho nhiều bạn mới quen, hợp lệ |
| HN_BORROW_REPAY | Mượn và trả lại trong cùng ngày, hợp lệ |

Mẫu mặc định `dbs-fraud-v1`: 73.106 giao dịch, 723 fraud (**0,989%**), đủ 8+5 nhóm. Số tiền p50 **507.000đ**, p90 **2.541.000đ**, p99 **8.960.000đ**; trung bình **0,6092 giao dịch/khách/ngày** trên 120.000 customer-days. Các tổng và phân phối đầy đủ nằm trong report, không phải số đo precision/recall/F1. Đây là ví dụ tái lập, seed khác có thống kê khác.

**Giới hạn:** 75% khách sinh background NORMAL, 25% dành cho các kịch bản; hai nhóm không chuyển qua lại. Mặc định khoảng 70–80 nghìn dòng thay vì khoảng 100 nghìn của NORMAL. Các episode và số hard negatives ít không đại diện tỉ lệ hành vi ngoài thực tế; chỉ dùng để kiểm/tune/đánh giá trên dữ liệu tổng hợp. Tỉ lệ fraud được kiểm trong 0,8–1,2%, không cắt episode hay đổi nhãn để khớp. Không phải mọi cấu hình/seed lớn đã được chạy nghiệm thu; số liệu thực tế phải đọc từ report.

**Bức tường dữ liệu:** #4 chỉ nhận mô tả tên/một câu và tập tune được giao đúng quy trình; không gửi source generator, test/oracle, manifest hoặc CSV mixed toàn bộ cho #4. Task này chưa chia 70/30, chưa sinh/giao holdout, chưa xác nhận offline với #4; DBS-127 phụ trách các bước đó. Không dùng `scenario` hoặc `is_fraud` làm feature.

## Bộ NORMAL tương thích DBS-71

Chạy tại gốc repo với Node 24:

```powershell
node load-tests/fraud-dataset/generate.mjs
node --test load-tests/fraud-dataset/generate.test.mjs
```

Mặc định tạo 2.000 khách trong 60 ngày và ghi khoảng 100.000 giao dịch vào `load-tests/results/fraud-normal.csv` (đã gitignore). Có thể dùng `--seed <chuỗi>`, `--customers <số>`, `--days <số>` và `--output <đường-dẫn>`. Cùng seed và tham số cho CSV byte-identical trên mọi máy. Lệnh in SHA-256 và thống kê phân phối, lương, số dư để kiểm nhanh.

CSV có đúng 12 cột theo thứ tự `tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario`. Thời gian là UTC ISO 8601, tiền là số nguyên đồng, `0` nghĩa là `is_fraud=false`, `NORMAL` là giao dịch bình thường. Lương và vốn ban đầu chỉ thay đổi sổ mô phỏng, không tạo dòng CSV. Funding nội bộ đối ứng mọi số dư ban đầu và khoản lương; tổng số dư khách cộng funding luôn bằng 0.

Ví dụ đối chiếu tái lập:

```powershell
node load-tests/fraud-dataset/generate.mjs --output load-tests/results/a.csv
node load-tests/fraud-dataset/generate.mjs --output load-tests/results/b.csv
Get-FileHash load-tests/results/a.csv -Algorithm SHA256
Get-FileHash load-tests/results/b.csv -Algorithm SHA256
```

`generateDataset()` còn trả `simulation` để replay độc lập; CSV và summary CLI NORMAL giữ nguyên. SHA-256 mặc định: `60e10c49abe8a6f9377dab29b729eaaf4a0f1d1a11dadfa759d8813aa7a7476f`. Bộ NORMAL chỉ có `0,NORMAL`; dùng CLI mixed ở trên để sinh kịch bản.

Không commit CSV và không gửi source generator hoặc nhãn holdout. [Thiết kế, test và bằng chứng DBS-126](../../docs/features/DBS-126-fraud-scenarios.md); [FRAUD guide](../../docs/components/risk/FRAUD_DETECTION_GUIDE.md).
