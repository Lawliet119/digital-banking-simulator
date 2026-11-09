# load-tests

## Demo 2 — request trùng song song

Từ checkout sạch, Node 24 và Docker Desktop đang chạy, cài dependency bằng `npm --prefix backend ci`. Trong Git Bash, từ `backend/` chạy:

```bash
env -u DATABASE_URL npm run test:db -- --runInBand customer-transfers
```

TC-79-07/TC-97-01…03 nạp 1.000.000 đồng cho A qua deposit API, B bắt đầu 0. Mỗi trong 10 round gửi 10 request cùng key/cùng amount `1000` bằng Promise.all thật. Mong đợi 10×201 body giống nhau, chỉ một giao dịch và hai bút toán/round, một audit/outbox/key; replay không ghi thêm, đổi amount thành `2000` trả 422 IDEMPOTENCY_KEY_REUSED. Sau 10 round A còn 990.000, B có 10.000 đồng. Mỗi round in report checker PASS, tổng balance 0 và không violation. Không retry để làm xanh; dừng và điều tra mọi lỗi bất thường.

Suite dùng DB tạm PostgreSQL 17, giữ seed qua deposit API. Lệnh bỏ DATABASE_URL chỉ trong process con để ép Testcontainers. Đây là demo correctness local/CI, không thay báo cáo hiệu năng k6 hoặc nghiệm thu AWS. CI job db hiện hữu chạy file này, nên một CI run chạy đủ 10 round. Ghi link CI thật khi có PR được phép tạo.

Kịch bản [k6](https://k6.io/). Phụ trách: #5 Platform & Ops chạy, Dev viết script. Năm kịch bản k6 dưới đây đều **(dự kiến)**: chưa có file script nào trong thư mục này.

| Kịch bản | Mục đích | Liên quan |
|---|---|---|
| `baseline` | 12 → 60 → 120 RPS (1×, 5×, 10× cao điểm), 80% đọc / 20% ghi | NFR-PERF-01, 02, SCAL-01 |
| `hot-account` | Nhiều lệnh chuyển vào cùng một tài khoản | NFR-SCAL-02 |
| `duplicate` | Cùng `Idempotency-Key` gửi song song | AC-5.4 |
| `stress` | Tăng dần vượt 120 RPS để tìm điểm gãy | Câu bảo vệ #6 |
| `rate-limit` | Vượt ngưỡng với 2 task API, có và không có Redis | NFR-SEC-05 |

Sau mỗi lần chạy phải kiểm tra bất biến: tổng Nợ = tổng Có, tổng số dư = 0, không tài khoản khách nào âm.

Từ checkout có devDependencies, chạy `npm run --silent check:invariants` trong `backend/` với `DATABASE_URL` của môi trường vừa chạy tải. Phải nhận exit **0**; exit **1** kèm IDs vi phạm, exit **2** là lỗi chưa kiểm được. Giữ report và mã thoát cùng bằng chứng load run, không bỏ qua lỗi. Công cụ kiểm thêm từng balance khớp sổ và mỗi COMPLETED đủ cặp/đúng tiền/nguồn/đích; funding được âm nhưng vẫn tính vào tổng. [Cách dùng, quyền DB và giới hạn full scan](../backend/README.md#9-kiểm-tra-bất-biến-sổ-cái). Câu SQL riêng trả report, CLI mới ánh xạ kết quả thành exit code.

Kết quả chạy lưu ở `load-tests/results/` (không commit); số liệu tổng hợp đưa vào báo cáo P4.

Bộ dữ liệu tổng hợp [fraud-dataset/README.md](fraud-dataset/README.md) có CLI NORMAL tương thích DBS-71 và CLI mixed (8 kịch bản gian lận, 5 hard negatives), cùng inspector replay/summary. Dữ liệu này phục vụ đánh giá offline; chưa là bằng chứng load test, scoring runtime hoặc tập tune/holdout đã chia và giao cho #4 (DBS-127).
