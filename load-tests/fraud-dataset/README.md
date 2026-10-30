# DBS-71 · Giao dịch bình thường tổng hợp

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

Chỉ bàn giao CSV cần thiết cho #4 Fraud; không gửi source generator hoặc nhãn holdout. CSV không chứa danh tính thật và không được commit. Bộ này chỉ sinh trường hợp bình thường; kịch bản gian lận thuộc task khác.
