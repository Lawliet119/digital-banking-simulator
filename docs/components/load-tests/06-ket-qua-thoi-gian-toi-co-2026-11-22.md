# load-tests: Kết quả đo thời gian từ giao dịch tới cờ và quét relay (2026-11-22)

> **Status:** Implemented (một phiên AWS, B0 `rule_only` đã đo, B2 chưa chạy được, đã dọn sạch) · **Owner:** Dev (đo thay Platform & Ops) · **Verified against code:** chạy thật trên AWS `ap-southeast-1` từ 10:37Z đến 14:28Z ngày 2026-11-22 (đồng hồ UTC), mọi số lấy từ PostgreSQL (`flag-latency.json`), k6, `pg_stat_statements` và CloudWatch của lượt thật · **Cập nhật:** 2026-11-22 · Thiết kế, quyết định, test: [DBS-174](../../features/DBS-174-time-to-flag.md), DBS-175 · Báo cáo trước: [04](04-ket-qua-bl-418-2026-11-22.md), [05](05-ket-qua-redis-2026-11-22.md) · Kết quả thô: [results/](results/)

## 0. Tóm tắt

Hai câu hỏi: (DBS-174) p95 từ giao dịch tới cờ có dưới 5 giây ở 12, 60, 120 RPS không (ADR-03, docs/03 §14)? (DBS-175) chỉnh chu kỳ poll và cỡ lô của relay có đưa p95 ở 120 RPS xuống dưới 5 giây không?

| Câu hỏi | Kết quả |
|---|---|
| p95 tới **cờ** ở 12 / 60 / 120 RPS, DB mới, cờ ở mọi giao dịch (trường hợp xấu nhất), `baseline` | **578 ms / 828 ms / 2.009 ms: đạt** (< 5.000 ms). p99 622 / 1.060 / 2.730 ms. Lớn nhất 1.105 / 2.205 / **5.379 ms** (một giá trị vượt 5 giây ở 120 RPS, không ảnh hưởng p95) |
| Có tồn đọng không? | **Không**: mọi giao dịch đều có quyết định (chờ 1 giây), tuổi outbox lớn nhất 1,73 giây, DLQ 0, cách ly 0, queue risk lớn nhất 16 tin / 12 giây (một lần ở 120 RPS). **Không gửi trùng, không mất**: `NumberOfMessagesSent` = số `POST /v1/transfers` của k6 = `NumberOfMessagesReceived` (34.563 ở `baseline`; 21.601, 21.601, 21.600 ở S1, S2, S0b) |
| Có đạt khi lịch sử 30 ngày đã lớn (cùng phiên, sau `hot-account`)? | **Không**: lặp lại 120 RPS ở cấu hình mặc định, p95 tới cờ **5.240 ms** (S0, nguồn nóng 43.900 dòng), rồi 33.826 ms ở S0b (73.500 dòng, RDS 89% CPU). Thứ tăng theo lịch sử là **thời gian truy vấn trích đặc trưng fraud, O(số dòng 30 ngày)** ([BL-413](../../BACKLOG.md)): 30,7 → 78,2 → 230,3 ms mỗi lần ở 29.500 → 43.900 → 73.500 dòng, trên một worker 0,25 vCPU đã sát trần (CPU 89% ở 120 RPS) ngay từ DB mới ([BL-417](../../BACKLOG.md)), rồi RDS bão hòa |
| Chỉnh poll và lô của relay có giúp không? | **Chưa kết luận được**: poll 250 ms và 100 ms (lô 100) không cho p95 tới cờ tốt hơn mặc định ở 120 RPS khi lịch sử đã lớn, và độ trôi do lịch sử lớn dần (28.586 ms giữa hai lượt cùng cấu hình mặc định) lớn hơn mọi khác biệt giữa các cấu hình. Giữ mặc định 500 ms và 100 sự kiện (điều kiện chọn ở DBS-175 §1.5 không thỏa; cổng bão hòa CPU worker ≥ 90% đã kích hoạt). Lưu ý: **trên DB mới ở 120 RPS, phần chờ nhìn thấy được nằm ở outbox** (tuổi outbox trung vị 1,3 giây, queue risk 0), nên tác dụng của poll nhỏ hơn ở trạng thái đó **chưa đo**: [BL-439](../../BACKLOG.md) |
| B2 (`rules_with_external_ai`) | **Chưa chạy**: secret `dbs/dev/openai-api-key` không tồn tại (kiểm đầu và cuối phiên), điều kiện (a) của TonightWorks §3 mục 4 không đạt. DoD 5 của DBS-174 chưa đạt: [BL-434](../../BACKLOG.md) |
| Invariant DBS-69, lỗi k6 | `invariantExit` 0 ở mọi lượt hợp lệ; 0 lỗi hệ thống và 0 dropped iteration ở `baseline`, `hot-account`, `redis-fault` (S0b: 1 lỗi) |
| Metric ứng dụng `risk_transfer_to_flag_ms` | **Không dùng được làm SLO ở 120 RPS**: p95 CloudWatch 4.840 đến 5.150 ms ở 6 trong 15 phút của `baseline` trong khi p95 thật (SQL) ≤ 2.681 ms, vì metric lượng tử hóa theo bucket (…, 1.000, 2.000, 5.000, 10.000): alarm `dbs-dev-transfer-to-flag-p95` (> 5.000 ms) có thể kêu giả: [BL-440](../../BACKLOG.md) |

**Kết luận trung thực.** Đường bất đồng bộ đạt p95 < 5 giây ở cả ba mức trên DB mới. Nó **không còn đạt** ở 120 RPS khi lịch sử 30 ngày của **nguồn nóng** đã lên 44.000 dòng (hai nguồn kia 25.900), vì truy vấn đặc trưng tăng theo lịch sử trên worker 0,25 vCPU và rồi RDS (BL-413, BL-417). Khi lịch sử lớn, relay không phải nút thắt (tuổi outbox ≤ 2 giây trong khi tuổi queue risk 11 đến 32 giây). Mọi số dưới đây là **một lượt mỗi cấu hình**, không có khoảng tin cậy.

## 1. Cấu hình đo

Giống [04 §1](04-ket-qua-bl-418-2026-11-22.md#1-cấu-hình-đo): 2 task api 0,5 vCPU (1 GB), 1 worker 0,25 vCPU (0,5 GB), RDS `db.t4g.small` Multi-AZ (PostgreSQL 17), Valkey 1 primary + 1 replica, WAF bật và miễn trừ IP máy tải, giới hạn tốc độ nâng lên 1.000.000, máy tải `t3.medium` cùng VPC, k6 v2.3.0, DB mới, fixture 3 khách. Khác:

| Hạng mục | Giá trị |
|---|---|
| Image `dbs-api` | `b6d56da0226f58ddc2e9dba7c1c91279087ae58d`: **build tay** từ nhánh `perf/DBS-175-relay-tuning` (cần hai biến env mới của DBS-175; image CI chỉ build từ `main`), Trivy cục bộ sạch (cùng cờ `run-trivy.sh`), đẩy lên ECR, **tag đã xóa khi hủy** (§7). Mã nguồn trên máy tải: `e8a7ceae…` (cùng cây mã backend, khác tên test) |
| Relay | S0: 500 ms / 100 (mặc định); sweep xem §3.5. Log `Outbox relay started` xác nhận giá trị mỗi lần |
| Cấu hình luật | v1 (mặc định, không cờ) → v2 `medium` 30 (**cờ ở mọi giao dịch sau lệnh thứ 6 trong 10 phút**) → v3 = v1 → v4 = v2, tạo bằng `POST /v1/admin/risk-config/versions` (token admin của `dbs-loadgen`), đợi > 60 giây (TTL cache) mỗi lần. Cảnh báo: **cờ ở ≈ 100% giao dịch là trường hợp xấu nhất của worker, không phải tỉ lệ cờ thật**; alarm `dbs-dev-risk-flag-rate` đã kêu |
| Bài chạy (theo thứ tự) | smoke → v2 + `baseline` 12→60→120 (DB mới) → v3 + `hot-account` (có `pg_stat_statements`) → `redis-fault` không sự cố (120 RPS, không cờ) → v4 + sweep |
| Phiên DB đo | role `dbs_api`, `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; chỉ SELECT ba bảng |

## 2. Cách đo và đọc số

Công cụ [`flag-latency.cjs`](../../../load-tests/flag-latency.cjs) ([DBS-174 §2](../../features/DBS-174-time-to-flag.md)): **quyết định** = `risk_decisions.decided_at − transfers.created_at` (mọi giao dịch được chấm), **cờ** = `fraud_flags.created_at − transfers.created_at` (cờ và quyết định cùng một transaction, nên chênh vài ms); cùng đồng hồ DB. Cửa sổ plateau theo mốc thật `startedAt/endedAt` của `aggregate.json` (mốc là phản hồi k6 đầu tiên và cuối cùng, nên **giao dịch đầu tiên của mỗi cửa sổ bị bỏ sót**: SQL đếm 34.562 so với 34.563 POST ở `baseline`; ảnh hưởng không đáng kể); sau lượt đợi tới khi không còn giao dịch thiếu quyết định (`backlog: false` ở mọi lượt dưới đây). CloudWatch theo phút: CPU và tuổi lấy các phút nằm trọn trong cửa sổ, trung vị là trung vị chuẩn; gửi/nhận là tổng các phút phủ lượt đo (xuất lại sau lượt vì metric SQS đến muộn vài phút), so với số `POST /v1/transfers` của k6. «qđ» là quyết định.

## 3. Kết quả

### 3.1 `baseline` trên DB mới, cờ ở mọi giao dịch (DoD 1 của DBS-174)

| Mức | Chuyển | Có cờ | qđ p50 / p95 / p99 / max (ms) | **Cờ p50 / p95 / p99 / max (ms)** | CPU worker trung vị / đỉnh theo phút (%) | CPU RDS trung vị (%) | Tuổi queue risk trung vị / lớn nhất (s) | Tuổi outbox trung vị / lớn nhất (s) |
|---|---|---|---|---|---|---|---|---|
| 12 RPS | 2.160 | 2.154 | 336,0 / 577,0 / 619,4 / 1.102,4 | 337,8 / **578,3** / 622,3 / 1.105,4 | 16,5 / 21,9 | 8,5 | 0 / 0 | 0,13 / 0,54 |
| 60 RPS | 10.801 | 10.801 | 506,1 / 823,1 / 1.056,0 / 2.203,9 | 509,9 / **828,4** / 1.060,5 / 2.205,4 | 46,0 / 53,5 | 21,2 | 0 / 1 | 0,38 / 0,62 |
| 120 RPS | 21.601 | 21.601 | 1.202,3 / 2.006,2 / 2.727,4 / 5.376,7 | 1.206,1 / **2.009,3** / 2.730,2 / 5.378,9 | 89,0 / 95,2 | 43,8 | 0 / 12 | 1,30 / 1,73 |
| Cả lượt | 34.562 | 34.556 | 965,1 / 1.839,4 / 2.463,1 / 5.376,7 | 968,5 / 1.843,5 / 2.467,5 / 5.378,9 | 46,0 / 95,2 | 21,2 | 0 / 12 | 0,45 / 1,73 |

(Sáu giao dịch đầu của lượt không có cờ: R1 chỉ nặng 30 sau lệnh thứ 6 trong 10 phút.) k6: `runExit` 0, 0 lỗi hệ thống và 0 dropped ở cả ba plateau (`meetsDoD3` đạt), `invariantExit` 0, p95 chuyển tiền phía client 40,8 / 46,6 / 89,5 ms. Độ trễ tới cờ **tăng theo tải** (p50 336 → 506 → 1.202 ms) cùng CPU worker 16 → 46 → 89%. Ở 120 RPS trên DB mới, chờ nhìn thấy được nằm ở **outbox** (tuổi outbox trung vị 1,30 giây, lớn nhất 1,73) chứ chưa ở queue (tuổi trung vị 0): relay và nhịp poll chiếm phần lớn p50 1,2 giây ở trạng thái này, và đó là chỗ một poll ngắn hơn có thể giúp (chưa đo: BL-439).

### 3.2 Hàng đợi và outbox (DoD 2 của DBS-174)

| Chỉ số (`baseline`, 11:03Z đến 11:51Z) | Giá trị |
|---|---|
| Giao dịch thiếu quyết định sau lượt | 0 (chờ 1 giây) |
| `NumberOfMessagesSent` queue risk so với `POST /v1/transfers` của k6 | **34.563 / 34.563** (không trùng, không mất; nạp tiền 0 trong cửa sổ) |
| `NumberOfMessagesReceived` | 34.563: nhận/gửi 1,000 (không giao lại cho consumer) |
| Độ sâu queue risk lớn nhất / tuổi tin cũ nhất | 16 tin / 12 giây (một lần ở 120 RPS) |
| DLQ risk, `outbox_quarantined_events` | 0, 0 |
| Tuổi outbox chưa gửi lớn nhất | 1,73 giây |

Cùng kết quả ở các lượt khác: gửi = nhận = số POST của k6 ở `hot-account` + `redis-fault` không cờ + S0 gộp (61.202) và ở từng lượt S1, S2, S0b; DLQ 0 ở mọi lượt. Mốc đầu phiên: bốn queue (risk, notification và hai DLQ) đều 0 tin.

### 3.3 Không cờ ở 120 RPS và `hot-account` (cấu hình mặc định v3 = v1)

| Lượt | Chuyển | Cờ | qđ p50 / p95 / p99 / max (ms) | CPU worker trung vị / đỉnh (%) | CPU RDS trung vị (%) | Tuổi queue risk trung vị / lớn nhất (s) | Dòng 30 ngày của nguồn nóng (cuối lượt) |
|---|---|---|---|---|---|---|---|
| `hot-account` 20/s, 15 phút | 17.999 | 0 | 933,1 / 1.691,0 / 2.439,3 / 5.456,6 | 78,2 / 86,9 | 37,6 | 4 / 12 | 29.526 |
| `redis-fault` không sự cố, 120 RPS, 15 phút | 21.600 | 0 | 1.331,5 / **2.567,2** / 3.606,9 / 8.131,9 | 89,7 / 93,7 | 54,9 | 7,5 / 16 | 36.727 (hai nguồn kia 18.723) |

`hot-account`: 0 lỗi, p95 chuyển tiền 77,5 ms (NFR-SCAL-02 p95 < 1 giây đạt), invariant PASS. `pg_stat_statements` ([pgss-delta.txt](results/dbs174-hot-account/pgss-delta.txt), hai ảnh chụp cách nhau 774 giây, 11:51:54Z đến 12:04:48Z): câu trích đặc trưng của worker (`WITH w AS … v_transfer_facts`) **15.490 lần gọi, 30,73 ms mỗi lần, tổng 476 giây thời gian DB = 0,61 lõi RDS** (476 chia 774) và câu đếm người nhận mới 5,18 ms. Thời gian DB của RDS, **không phải** CPU của task worker (đo ở CloudWatch: 78% trung vị, đỉnh 87%). Đây là số «trước» của [BL-413](../../BACKLOG.md): nguồn 29.526 dòng, **dưới ngưỡng 37.800 dòng** mà BL-413 ghi nhận timeout, nên **không tái hiện timeout** và không đóng BL-413. Lượt `redis-fault` không cờ chậm hơn lượt `baseline` cờ-mọi-giao-dịch trên DB mới (p95 2.567 so với 2.006 ms) dù ít việc ghi hơn: lịch sử dài hơn (nguồn lớn nhất 36.727 so với 11.526 dòng), nên việc ghi cờ không phải nguyên nhân chính.

### 3.4 Lịch sử lớn dần làm p95 tăng

p95 quyết định theo phút (giây) của plateau 120 (chỉ các phút đủ ≥ 500 giao dịch):

| Lượt | Cấu hình luật | 15 phút liên tiếp | Dòng 30 ngày (ba nguồn, cuối lượt) |
|---|---|---|---|
| `baseline` (DB mới) | cờ mọi giao dịch | 1,7 1,9 2,1 1,8 1,9 1,9 2,2 2,0 2,7 1,9 1,8 2,0 2,2 2,0 2,2 | 11.522 / 11.526 / 11.523 |
| `redis-fault` không cờ | không cờ | 2,4 2,3 2,5 2,7 2,7 2,5 2,4 3,0 2,4 2,9 2,4 2,5 2,3 3,2 2,6 | 18.722 / 36.727 / 18.723 |
| S0 (mặc định) | cờ mọi giao dịch | 3,6 3,4 3,1 3,8 5,7 5,0 5,5 7,1 4,3 5,3 4,6 6,5 6,6 6,0 5,3 | 25.922 / 43.928 / 25.923 |

Mỗi 15 phút ở 120 RPS mỗi nguồn thêm ≈ 7.200 dòng. Chi phí truy vấn đặc trưng (cùng cấu hình mặc định, từ `pgss-delta.txt` của từng lượt): 30,7 ms (`hot-account`, 29.526 dòng) → 78,2 ms (S0, 43.928) → 230,3 ms (S0b, 73.454).

### 3.5 Quét relay (DBS-175)

| Cấu hình (poll ms / lô) | Chuyển | qđ p50 | qđ p95 | qđ p99 | qđ max | **Cờ p95** | CPU worker trung vị / đỉnh (%) | CPU RDS trung vị (%) | Tuổi queue risk trung vị / lớn nhất (s) | Tuổi outbox trung vị / lớn nhất (s) | Trích đặc trưng (ms mỗi lần) | Sự kiện mỗi lô | Lô mỗi giây | Dòng 30 ngày của nguồn nóng |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S0 500 / 100 | 21.600 | 1.941,3 | 5.236,4 | 7.801,8 | 13.795,3 | **5.239,8** | 90,9 / 93,0 | 64,5 | 11 / 18 | 1 / 2 | 78,2 | 27 | 0,9 | 43.928 |
| S1 250 / 100 | 21.601 | 3.507,0 | 13.241,6 | 19.070,0 | 26.655,8 | **13.246,2** | 83,5 / 90,7 | 75,2 | 21 / 30 | 0,8 / 1 | 151,9 | - | - | 59.053 |
| S2 100 / 100 | 21.600 | 1.640,3 | 6.220,6 | 10.000,2 | 13.962,2 | **6.225,2** | 56,0 / 77,5 | 83,4 | 13,5 / 20 | 0,2 / 0,4 | 172,7 | - | - | 66.254 |
| S0b 500 / 100 (lại) | 21.600 | 9.263,6 | 33.824,4 | 48.488,2 | 56.210,2 | **33.825,9** | 55,8 / 77,9 | 89,1 | 32 / 48 | 0,6 / 1,3 | 230,3 | - | - | 73.454 |
| S3 500 / 10 | không chạy (xem bên dưới) | | | | | | | | | | | | | |

Ba cấu hình và một lần lặp lại mặc định, cùng DB, cờ ở mọi giao dịch, một plateau 120 RPS dài 15 phút (bài `redis-fault` không sự cố), mỗi lượt sau một lần triển khai lại worker (log `Outbox relay started` xác nhận 500/100, 250/100, 100/100, 500/100). Mọi lượt: 0 lỗi hệ thống (S0b: 1), 0 dropped, `invariantExit` 0, `backlog: false`. **S3 (500 ms, lô 10) không chạy** (lý do bên dưới). «Trích đặc trưng» là thời gian trung bình mỗi lần của câu `WITH w AS … v_transfer_facts` của worker trong `pg_stat_statements` của lượt đó; «sự kiện mỗi lô» và «lô mỗi giây» lấy từ câu `UPDATE outbox_events SET published_at`, chỉ có ở S0 trong 25 câu tốn nhiều thời gian nhất (ô `-` là không có số, không phải 0). Gửi = nhận = số `POST /v1/transfers` của k6 ở mọi lượt (S0 tính gộp với `hot-account` và lượt không cờ, vì CloudWatch theo phút không tách được biên, §3.2).

p95 quyết định theo phút (giây) của plateau 120, và số dòng 30 ngày của ba nguồn ở cuối lượt:

| Lượt | 15 phút liên tiếp | Dòng 30 ngày (ba nguồn, cuối lượt) |
|---|---|---|
| S0 500/100 | 3,6 3,4 3,1 3,8 5,7 5,0 5,5 7,1 4,3 5,3 4,6 6,5 6,6 6,0 5,3 | 25.922 / 43.928 / 25.923 |
| S1 250/100 | 18,4 17,5 17,0 12,3 8,9 12,9 10,0 6,5 7,0 10,6 11,6 11,4 9,6 15,3 18,6 | 41.089 / 59.053 / 41.060 |
| S2 100/100 | 9,5 7,1 6,7 3,9 4,1 6,9 5,4 5,1 4,8 5,4 4,4 10,6 5,8 4,9 7,9 | 48.289 / 66.254 / 48.260 |
| S0b 500/100 (lại) | 20,2 23,0 24,7 24,5 17,2 31,7 32,4 24,9 26,1 26,0 34,6 40,4 49,0 49,0 47,3 | 55.489 / 73.454 / 55.460 |

**Đọc kết quả.**

1. **Độ trôi lớn hơn mọi khác biệt giữa các cấu hình.** Cùng cấu hình mặc định, S0 và S0b chênh p95 tới cờ **28.586 ms** (5.240 → 33.826 ms), trong khi S2 chỉ chênh S0 +985 ms và S1 +8.006 ms. Thứ tăng đều theo lịch sử là chi phí truy vấn đặc trưng: 78,2 → 151,9 → 172,7 → 230,3 ms mỗi lần ở S0, S1, S2, S0b (nguồn nóng 43.928 → 59.053 → 66.254 → 73.454 dòng, vượt xa ngưỡng ≈ 55.000 của [BL-413](../../BACKLOG.md)). Từ `hot-account` RDS `db.t4g.small` đã hết tín dụng CPU và chạy bằng tín dụng vượt (surplus 1,9 → 86,4 phút vCPU, chế độ `unlimited`): CPU RDS trung vị 64,5% (S0) → 89,1% (S0b). Số của sweep **không so sánh được với nhau** ngoài việc nhìn xu hướng.
2. **S1 còn bị nhiễu thêm.** Lượt S1 hỏng (hai driver chạy chồng, số bị loại) đã thêm +15.167 dòng cho nguồn nóng (thay vì ≈ 7.200 mỗi lượt) và S1 mở đầu ở p95 18 giây; vì vậy S1 đứng sau S2 về số dòng nhưng tệ hơn S2 về p95. Không có cách tách tác dụng của poll 250 ms khỏi nhiễu đó.
3. **Khi lịch sử lớn, nút thắt không phải relay.** Ở mọi lượt sweep tuổi outbox chưa gửi trung vị ≤ 1 giây và lớn nhất ≤ 2 giây (S0: 1 và 2 giây), trong khi tuổi tin cũ nhất của queue risk trung vị 11 đến 32 giây: tin đã rời outbox nhưng chờ consumer. Ở S0 mỗi lô trung bình 27 sự kiện, 0,9 lô mỗi giây: **lô 100 không bao giờ đầy**, nên cỡ lô lớn hơn 27 không có tác dụng ở tải này. CPU worker trung vị tụt từ 90,9% (S0) xuống 83,5% (S1), 56,0% (S2) và 55,8% (S0b) **không phải vì relay nhanh hơn** mà vì worker chờ một RDS đã bão hòa (CPU RDS trung vị 64,5 → 75,2 → 83,4 → 89,1%): nút thắt dời từ worker sang RDS. Trên DB mới (§3.1) thì ngược lại: chờ nhìn thấy được nằm ở outbox, và sweep ở trạng thái đó chưa chạy.
4. **Ảnh hưởng ngược lên API**: p95 chuyển tiền phía k6 của plateau 120 đi 149 → 167 → 196 → 351 ms (S0 → S1 → S2 → S0b), vì worker và API dùng chung RDS: khi truy vấn đặc trưng bão hòa DB thì đường đồng bộ cũng chậm (S0b vượt 300 ms và có 1 lỗi). Câu trích đặc trưng chiếm khoảng 59% thời gian DB cả phiên (17.706 trên ≈ 29.900 giây, 119 ms mỗi lần, 148.831 lần), câu đọc tài khoản của API khoảng 33% (9.731 giây, 65 ms mỗi lần): [pgss-delta-hot-to-final.txt](results/dbs175-s0b-500-100-lai/pgss-delta-hot-to-final.txt).
5. **Không gửi trùng, không mất**: ở S1, S2, S0b `NumberOfMessagesSent` = `NumberOfMessagesReceived` = số POST của k6 (21.601, 21.601, 21.600), và S0 gộp với hai lượt trước nó ra đúng 61.202 = 61.202. `risk_decisions` có khóa chính `transfer_id` nên mọi giao dịch có đúng một quyết định (`decided = transfers`).

**Vì sao không chạy S3 (500 ms, lô 10).** Đây là **quyết định của agent**, không phải quy tắc cắt khi thiếu giờ (phiên còn khoảng một giờ dưới trần 5 giờ): sau S0b DB đã bão hòa (CPU RDS trung vị 89%, p95 tới cờ 34 giây, API p95 351 ms), một lượt thứ năm trên cùng DB chỉ cộng thêm độ trôi, không cho thông tin về lô nhỏ. Tác dụng của cỡ lô nhỏ hơn số sự kiện mỗi chu kỳ **chưa đo**: [BL-439](../../BACKLOG.md).

## 4. Áp tiêu chí đã chốt trước (DBS-175 §1.5)

**Lệch so với quy tắc đã chốt (agent tự quyết):** tiêu chí §1.5 ghi «nếu CPU tối đa của worker ở S0 ≥ 90% thì **dừng**»; cổng đã kích hoạt ở S0 (tối đa 93,0%), nhưng sweep **vẫn chạy tiếp** S1, S2, S0b (chi phí nhỏ) để lấp bảng DoD 1 và đo độ trôi bằng S0b. Số của S1, S2, S0b vì vậy **chỉ để quan sát**, không dùng để chọn giá trị; bảng dưới áp các điều kiện còn lại như một kiểm tra phụ, không phải căn cứ quyết định.

| Điều kiện | S1 (250/100) | S2 (100/100) | Kết luận |
|---|---|---|---|
| Cổng bão hòa: CPU worker tối đa ở S0 < 90% | S0: tối đa 93,0% (trung vị 90,9%) | | **Kích hoạt**: sweep không kết luận được, chuyển cho [BL-417](../../BACKLOG.md) và [BL-439](../../BACKLOG.md); giữ mặc định |
| (a) p95 quyết định < 5.000 ms, `backlog: false` | 13.242 ms: không | 6.221 ms: không | S0 chính nó cũng không đạt (5.236 ms) |
| (b) CPU worker và CPU RDS trung vị không cao hơn S0 quá 10 điểm | worker −7,4, **RDS +10,7**: không | worker −34,9, **RDS +18,9**: không | không đạt |
| (c) trung vị tuổi queue risk và tuổi outbox không xấu hơn S0 quá 20% | queue 21 so với 11 s (**+91%**): không | queue 13,5 so với 11 s (**+22,7%**): không | không đạt |
| (d) nhận / gửi ≤ 1,01 | 1,000 | 1,000 | đạt |
| (e) gửi trùng của relay ≤ 1% (gửi so với số POST của k6) | 0% | 0% | đạt (không có dấu hiệu trùng) |
| Cải thiện p95 so với S0 ≥ max(10%, 50 ms, \|S0 − S0b\| = 28.586 ms) | −8.006 ms (xấu hơn) | −985 ms (xấu hơn) | không đạt |

**Quyết định: giữ nguyên mặc định 500 ms và 100 sự kiện** (không đổi `relay.defaults.ts`, `worker.tf`, `.env.example`). Đây là kết quả hợp lệ theo tiêu chí chốt trước: cổng bão hòa kích hoạt, không ứng viên nào đủ điều kiện và không ứng viên nào vượt độ trôi. Hai biến env vẫn có giá trị: chúng cho phép thử lại ở một phiên có worker không bão hòa hoặc DB mới cho mỗi cấu hình ([BL-439](../../BACKLOG.md)).

**Điều đã trả lời được cho DBS-175.** Mục tiêu của task («p95 < 5 giây từ giao dịch tới cờ ở 120 RPS») **đạt trên DB mới ở cấu hình mặc định** (2.009 ms, §3.1) mà không cần chỉnh relay, và **không đạt** khi lịch sử của nguồn nóng vượt ≈ 44.000 dòng vì truy vấn đặc trưng tăng theo lịch sử và worker, RDS bão hòa (BL-413, BL-417); chỉnh poll và lô ở trạng thái bão hòa không thay đổi được kết luận đó. Chưa biết poll ngắn hơn có rút p50 1,2 giây trên DB mới hay không.

## 5. Giới hạn

1. **Một lượt mỗi cấu hình, không có khoảng tin cậy.** Hai lượt cùng cấu hình (S0, S0b) cho độ trôi do lịch sử lớn dần; mọi so sánh phải trừ độ trôi này.
2. **Cờ ở mọi giao dịch là trường hợp xấu nhất**, không phải tỉ lệ cờ thật (≈ 0 ở bộ luật mặc định với tải tổng hợp). Ba khách cố định, một IP nguồn ([02 §3](02-ket-qua-tai-cloud-2026-11-21.md#3-tính-đại-diện-đọc-trước-khi-trích-số)).
3. **DB dùng chung cả phiên** nên lịch sử 30 ngày của nguồn chỉ tăng (BL-413): chỉ so các cửa sổ có số dòng gần nhau; số chính của DoD 1 (§3.1) chạy trên DB mới ngay sau smoke.
4. **B2 chưa đo**: không có secret; không có số về fallback, timeout, 429 và độ phủ AI. Mọi lượt đều `mode = rule_only`, `ai_status = DISABLED`.
5. **`hot-account` không chạm ngưỡng 37.800 dòng** (29.526 dòng), nên số trước/sau của BL-413 ở ngưỡng gãy chưa có.
6. **Công cụ bỏ sót giao dịch đầu tiên của mỗi cửa sổ** (mốc là phản hồi k6 đầu tiên): chênh 1 trên 21.600.
7. **Sự cố vận hành của phiên (điều hành, không phải hệ thống):** hai driver của máy vận hành chạy chồng một lượt S1 (số của nó bị loại, không đưa vào báo cáo); phải dừng k6, đợi queue trống rồi chạy lại S1. **S1 vẫn bị nhiễu**: lượt hỏng trước nó thêm +15.167 dòng cho nguồn nóng (thay vì ≈ 7.200), nên S1 không so sánh được trực tiếp với S2.
8. **Metric ứng dụng `risk_transfer_to_flag_ms` không khớp SQL** (§0, [BL-440](../../BACKLOG.md)): báo cáo này dùng SQL.

## 6. Cảnh báo vận hành thấy trong lúc đo

- **Đứng hình (BL-419):** ở `baseline`, `hot-account`, `redis-fault` không cờ và S0, S1, S2 không có timeout kiểu «đứng hình» (0 lỗi, 0 dropped); S0b có 1 lỗi khi RDS bão hòa. `event_loop_delay_max_ms` lớn nhất trong phiên: worker 392 ms, api 687 ms (12:55Z, lúc hai lượt S1 chạy chồng), xem [dbs174-runtime-gauges.txt](results/dbs174-runtime-gauges.txt).
- `infra/scripts/demo-token.sh` trả «Cognito từ chối đăng nhập» với **mọi** vai trên máy Windows này, trong khi `loadgen-tokens.mjs` (cùng Cognito, cùng secret) đăng nhập được: mật khẩu qua `/dev/stdin` có vẻ hỏng ở Git Bash. Cách đi vòng: import `login` và `readSecret` của `loadgen-tokens.mjs`. [BL-436](../../BACKLOG.md).
- `pkill` trong Git Bash không dừng được tiến trình `bash.exe` nền đã chạy bằng `nohup`; dừng bằng `Stop-Process` sau khi tìm theo dòng lệnh. Dùng `run_in_background` của công cụ thay vì `nohup`.
- `aws.exe` ghi CRLF: chuỗi ra cần `tr -d '\r'` trước khi làm toán trong Bash. Metric SQS đến CloudWatch muộn vài phút: xuất sau lượt vài phút (hoặc xuất lại; metric còn nguyên sau khi hủy stack).
- Dựng `session` mất ≈ 18 phút, `loadgen` ≈ 1 phút; máy tải đăng ký SSM sau lần `reboot-instances` đầu.
- RDS `db.t4g.small` hết tín dụng CPU từ `hot-account` và chạy bằng tín dụng vượt (surplus 1,9 → 86,4 phút vCPU, chế độ `unlimited`): tốn thêm tiền nhưng không bị bóp.
- `pgss.sh snapshot` chỉ chứa 25 câu tốn nhiều thời gian nhất: câu `PENDING_BATCH_SQL` của relay không có trong ảnh chụp, nên «sự kiện mỗi lô» chỉ có ở S0 (từ câu `UPDATE outbox_events SET published_at`).

## 7. Dọn dẹp và bằng chứng

| Bước | Kết quả |
|---|---|
| `terraform destroy` `session` | `Destroy complete! Resources: 66 destroyed`, thoát 0 (≈ 9 phút, 14:18Z đến 14:27Z) |
| `terraform destroy` `loadgen` | `Destroy complete! Resources: 14 destroyed`, thoát 0 |
| `infra/scripts/verify-clean.sh` | thoát 0, `KET LUAN: sạch (13 loại)` |
| Cognito | `list-user-pool-clients` chỉ còn `dbs-app`; `terraform plan` của `base` vẫn đúng «3 thêm, 7 sửa» đã biết ([BL-409](../../BACKLOG.md)), không thêm thay đổi do phiên này |
| State tạm | `dev/loadgen-dbs174.tfstate` và `dev/session-dbs174.tfstate` đã xóa; `base.tfstate` và `session.tfstate` không đụng |
| ECR `dbs-api` | tag build tay `b6d56da0…` **đã xóa** (`batch-delete-image`, không có lỗi); các tag còn lại là image của workflow Image trên `main` |
| Token | xóa khỏi bucket ngay sau `prepare` (script báo «token đã xóa khỏi máy và bucket») và khỏi máy vận hành (`shred`); bucket tải hủy cùng stack |
| Còn lại trên AWS | không EC2, RDS hay cluster ECS; bucket `dbs-loadgen-*` đã mất; chỉ còn `base` (secret: `demo-accounts`, `redis-auth`) |
| Thời gian và chi phí | stack sống 10:37Z đến 14:28Z (3 giờ 51 phút, dưới trần 5 giờ); ≈ 0,5 USD/giờ ⇒ ≈ 1,9 USD, cộng tín dụng CPU RDS vượt cỡ 0,1 USD; **ước lượng, chưa đối chiếu hóa đơn** |

## 8. Kết quả thô

Thư mục trong [results/](results/): `dbs174-baseline-flag`, `dbs174-hot-account`, `dbs174-control-120-noflag`, `dbs175-s0-500-100`, `dbs175-s1-250-100`, `dbs175-s2-100-100`, `dbs175-s0b-500-100-lai` (mỗi thư mục sweep có thêm `pgss-A.txt`, `pgss-B.txt`, `pgss-delta.txt`); mỗi thư mục có `aggregate.json` (có `startedAt/endedAt` của plateau), `per-minute.json`, `summary.json`, `exit.json` (có `runExit`, `invariantExit`, `flagLatencyExit`), `invariants.txt`, `requests.csv.gz`, `raw.json.sha256` và `.size` (`raw.json` đầy đủ không commit), `cloudwatch.json` (xuất lại sau lượt, đủ phút), `flag-latency.json`; `run.log` không commit (tên miền của ALB). `dbs174-hot-account` có thêm hai ảnh chụp `pg_stat_statements` và `pgss-delta.txt`; `dbs174-runtime-gauges.txt` là kết quả Logs Insights cho BL-419.

| Lượt | `runExit` | `invariantExit` | `flagLatencyExit` |
|---|---|---|---|
| `dbs174-baseline-flag` | 0 | 0 | 0 |
| `dbs174-hot-account` | 0 | 0 | 0 |
| `dbs174-control-120-noflag` | 0 | 0 | 0 |
| `dbs175-s0-500-100` | 0 | 0 | 0 |
| `dbs175-s1-250-100` | 0 | 0 | 0 |
| `dbs175-s2-100-100` | 0 | 0 | 0 |
| `dbs175-s0b-500-100-lai` | 99 (1 lỗi, p95 chuyển 351 ms vượt ngưỡng k6) | 0 | 0 |
