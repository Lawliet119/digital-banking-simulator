# load-tests

Kịch bản [k6](https://k6.io/). Phụ trách: #6.

| Kịch bản | Mục đích | Liên quan |
|---|---|---|
| `baseline` | 12 → 60 → 120 RPS (1×, 5×, 10× cao điểm), 80% đọc / 20% ghi | NFR-PERF-01, 02, SCAL-01 |
| `hot-account` | Nhiều lệnh chuyển vào cùng một tài khoản | NFR-SCAL-02 |
| `duplicate` | Cùng `Idempotency-Key` gửi song song | AC-5.4 |
| `stress` | Tăng dần vượt 120 RPS để tìm điểm gãy | Câu bảo vệ #6 |
| `rate-limit` | Vượt ngưỡng với 2 task API, có và không có Redis | NFR-SEC-05 |

Sau mỗi lần chạy phải kiểm tra bất biến: tổng Nợ = tổng Có, tổng số dư = 0, không tài khoản khách nào âm.

Kết quả chạy lưu ở `load-tests/results/` (không commit); số liệu tổng hợp đưa vào báo cáo P4.
