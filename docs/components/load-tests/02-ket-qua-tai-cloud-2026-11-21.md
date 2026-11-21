# load-tests: Kết quả tải trên AWS (DBS-166, 2026-11-21)

> **Status:** Đã đo (một phiên, một lượt cho mỗi bài) · **Owner:** #5 Platform & Ops · **Verified against code:** chạy thật trên AWS `ap-southeast-1` ngày 2026-11-21, mọi số lấy từ k6 và CloudWatch của lượt thật · **Cập nhật:** 2026-11-21 · Thiết kế, nhật ký, quyết định: [DBS-166](../../features/DBS-166-load-report.md) · Kịch bản: [load-tests/README](../../../load-tests/README.md) · Kết quả thô: [results/](results/)

## 0. Tóm tắt

| DoD | Kết quả |
|---|---|
| p95, p99, lỗi ở 12, 60, 120 RPS | **Đo được, đạt ngưỡng NFR ở cả ba plateau** trên DB mới (`baseline`): chuyển p95 42 / 60 / 218 ms, p99 106 / 153 / 703 ms; đọc p95 ≤ 61 ms. Một request 502 do ALB sinh ra ở plateau 60 làm k6 báo đỏ (`checks`). |
| Tài khoản nóng 20 lệnh/giây | **Không đạt** (worker bật): p95 824 ms (< 1 s, đạt) nhưng 299 timeout 2 giây (1,66% > 0,1%), độ trễ tăng dần suốt 15 phút. **Đạt** khi tắt worker (p95 52 ms, 0 lỗi): nút thắt là truy vấn đặc trưng fraud của worker. |
| Stress, điểm gãy | Worker bật: gãy ở 120 → 180 RPS (plateau 120 đã 0,119% lỗi và p95 784 ms trên DB đã có 25.000 giao dịch; plateau 180 sập 97% timeout). Worker tắt: đạt tới 180 RPS, gãy ở 240 RPS. |
| Lỗi < 0,1% liên tục 15 phút ở 120 RPS | **Đạt** ở `baseline` (0 lỗi trên 108.002 request, 0 dropped iteration) với giới hạn ghi ở mục 6. Không giữ được khi DB đã tích lũy lịch sử (stress: 0,119%). |
| DBS-69 sau MỖI lần chạy | 8 lượt trên AWS (kể cả smoke, ba lượt đỏ và hai lượt chẩn đoán), `invariantExit=0` đều có báo cáo `PASS`, tổng nợ = tổng có, số dư toàn hệ thống 0. |

## 1. Cấu hình đo

| Hạng mục | Giá trị |
|---|---|
| Ngày, vùng | 2026-11-21, AWS `ap-southeast-1`, tài khoản dev |
| Hệ thống được đo | image `dbs-api` tag `0d5874b64491ae9cee0e041d6a201870668e9979` (`main`; mã backend không đổi trong PR này) |
| Mã harness (k6, runner, checker) | commit `169668a582dd79217a9291a49101ab0c02e31a60` của nhánh `test/DBS-166-load-report` (đưa lên máy tải bằng `git archive`, tệp `COMMIT`) |
| API | 2 task Fargate (0,5 vCPU / 1 GB), `NODE_ENV=staging`, `TRUST_PROXY_HOPS=1`, sau ALB và WAF; `DATABASE_POOL_MAX` mặc định 10 mỗi task |
| Worker | 1 task Fargate (0,25 vCPU / 0,5 GB); 0 task ở hai lượt «worker 0» |
| RDS | PostgreSQL 17, `db.t4g.small`, **Multi-AZ**, gp3 20 GB, TLS xác minh |
| Valkey | `cache.t4g.micro`, 1 primary + 1 replica, TLS và AUTH |
| WAF | bật; rate rule 1.000 yêu cầu/5 phút/IP **miễn trừ IP máy tải** (`/32`); hai nhóm managed rule vẫn chạy |
| Giới hạn tốc độ của app | mặc định (10 chuyển/phút/khách, 100 yêu cầu/phút/IP) cho bài `rate-limit`; 1.000.000 cho cả hai ở các bài còn lại (docs/03 §12) |
| Máy tải | EC2 `t3.medium` on-demand, cùng VPC và region; Node 24.22.2, k6 v2.3.0 |
| Xác thực | token Cognito thật từ client tạm `dbs-loadgen` (240 phút); ALB dev dùng chứng chỉ tự ký nên k6 chạy `K6_INSECURE_SKIP_TLS_VERIFY=true` (kết nối DB luôn xác minh TLS) |
| Dữ liệu | một DB mới, một fixture 3 khách seed qua API (DBS-70), CHECKING nạp bù lên 50 triệu bằng deposit API; các bài chạy tuần tự trên cùng DB (DB lớn dần: 120.699 giao dịch ở cuối) |

## 2. Cách đo và đọc số

- Mỗi bài chạy `node load-tests/run.cjs <bài>`: k6 `constant-arrival-rate` (tải phát theo lịch, không phụ thuộc độ trễ; client timeout 2 giây), rồi checker bất biến DBS-69 (`backend/src/scripts/invariants/invariants.ts`), thoát 0 chỉ khi có báo cáo `PASS`. Trong lúc làm task này đã sửa lỗi `run.cjs` gọi nhầm tệp re-export nên checker không chạy mà vẫn báo 0 (xem [DBS-166 §1](../../features/DBS-166-load-report.md)).
- Độ trễ là độ trễ HTTP phía k6 từ máy tải trong VPC tới ALB (gồm TLS, WAF, ALB, app, RDS). Số phía server và hạ tầng lấy từ CloudWatch cùng cửa sổ (`cloudwatch.json` mỗi lượt).
- p95, p99 nội suy tuyến tính trên từng request (`requests.csv.gz`, mỗi request một dòng), tính lại được cho cửa sổ bất kỳ.
- **Phán quyết DoD 3 theo plateau** (`aggregate.json` › `plateaus`): lỗi hệ thống < 0,1% **và** không có dropped iteration, tính trên đúng cửa sổ của plateau (`read_N` + `write_N`). Lỗi hệ thống = status ngoài 200/201/422/429, status 0 (timeout), và mọi 429 ngoài bài `rate-limit`.
- Mọi lượt đã chạy đều có ở đây, kể cả lượt smoke và hai lượt chẩn đoán (worker 0); không bài nào bị chạy lại để chọn lượt đẹp.

## 3. Tính đại diện (đọc trước khi trích số)

- Fixture chỉ có 3 khách: 24 lệnh chuyển/giây tranh khóa trên 3 dòng tài khoản (ở `hot-account` là một nguồn và một đích cố định). Bi quan về khóa so với tải thật phân tán nhiều khách, nhưng **bi quan nặng về truy vấn đặc trưng fraud**: mọi giao dịch của tải đều từ ba tài khoản nên lịch sử mỗi tài khoản lớn rất nhanh (64.289 giao dịch trên tài khoản nóng), trong khi khách thật có lịch sử ngắn.
- Các bài nối tiếp trên một DB: bài sau đo trên bảng lớn hơn bài trước. Số của `baseline` (đầu phiên, DB nhỏ) tốt hơn số của `stress` (sau 25.000+ giao dịch) cùng ở 120 RPS; hai số đều là thật và đều được báo.
- Một IP nguồn, keep-alive: ít bắt tay TLS hơn tải thật; WAF và giới hạn theo IP thấy một khóa. Đo trong VPC nên không có độ trễ Internet.
- RDS và máy tải đều burstable; RDS ở chế độ unlimited: `CPUSurplusCreditBalance` lên tới 37 (`stress` worker 1) và 41 (worker 0), nghĩa là CPU RDS đã vượt mức cơ sở và được tính phí thêm.
- Một phiên, một lượt cho mỗi bài: không có khoảng tin cậy giữa các lần chạy.

## 4. Kết quả `baseline` (12 → 60 → 120 RPS, 80% đọc, mỗi plateau 15 phút)

Lượt `baseline-efb059bd`, 2026-11-21 02:04:35Z đến 02:50:21Z, `runExit=99` (k6 `checks` 99,99%, vì đúng một phản hồi 502), `invariantExit=0`.

| Plateau | Yêu cầu | RPS đạt được | Lỗi hệ thống | Dropped | Chuyển p95 / p99 (ms) | Đọc số dư p95 (ms) | Đọc lịch sử p95 (ms) | DoD 3 |
|---|---|---|---|---|---|---|---|---|
| 12 | 10.802 | 12,005 | 0 | 0 | 42,0 / 105,6 | 23,3 | 24,5 | đạt |
| 60 | 54.001 | 60,000 | 1 (0,0019%) | 0 | 59,6 / 153,1 | 29,9 | 34,4 | đạt |
| 120 | 108.002 | 119,998 | **0** | 0 | **218,2 / 703,2** | 52,9 | 61,1 | **đạt** |

Mọi ngưỡng latency của docs/03 §14 (chuyển p95 < 300 ms và p99 < 1 s; đọc p95 < 150 ms) đạt ở cả ba plateau. Chi tiết:

- **Một request 502** (`GET /v1/accounts/:id/transactions`, 02:29:50Z, plateau 60, trả sau 2 ms) do ALB tự sinh: CloudWatch ghi `HTTPCode_ELB_5XX_Count = 1`, `HTTPCode_Target_5XX_Count` không có, `http_5xx_total` của app bằng 0. Giả thuyết (chưa kiểm chứng): Node đóng kết nối keep-alive không hoạt động sau 5 giây (mặc định `keepAliveTimeout`, mã không đặt lại) trong khi ALB giữ 60 giây, nên thỉnh thoảng ALB dùng lại kết nối đã đóng. Lượt `stress` worker 0 cũng có 5 lỗi 502 loại này (k6 thấy 5, CloudWatch ELB 5xx = 5, app 5xx = 0). Kiểm chứng: đặt `server.keepAliveTimeout` > 60 giây ở API rồi đo lại (việc của Dev api, [BL mới](../../BACKLOG.md)).
- **Đuôi độ trễ ở 120 RPS không đều theo phút:** trong 15 phút của plateau, 3 phút có p95 chuyển > 300 ms (448, 303 và 641 ms) và 5 phút có p99 > 1 s (đỉnh theo phút 1,54 giây, request chậm nhất 1,87 giây), dù cả cửa sổ 15 phút đạt. Cùng thời điểm RDS CPU 53 đến 77% và tăng dần, worker CPU 85 đến 90% (0,25 vCPU), kết nối RDS luôn 30 (đúng 3 task × pool 10), tuổi outbox tối đa 2 giây. Xem mục 7.
- Cửa sổ 15 phút không có 429 nào từ WAF hay ALB (`BlockedRequests` của rule `rate-limit` bằng 0); WAF ghi 1 request bị chặn bởi managed rule (không phải rule `rate-limit`) trong cửa sổ `baseline` và 1 trong `hot-account`; k6 không thấy lỗi tương ứng nên không rõ nguồn.

## 5. Các bài còn lại

| Bài | Kết quả | Chi tiết |
|---|---|---|
| `rate-limit` (giới hạn mặc định, 2 task qua ALB) | **Đạt** (`runExit=0`, `invariantExit=0`) | 10 lần 201 rồi 429 ở lệnh thứ 11; 100 lần 200 rồi 429 ở yêu cầu thứ 101; `RATE_LIMITED` và `Retry-After` đúng. Log CloudWatch cho thấy **cả hai task** nhận request trong cửa sổ (66 và 65 dòng 200, mỗi task một 429): giới hạn dùng chung qua Valkey và `request.ip` đúng sau ALB (BL-179). Xem [bằng chứng](results/rate-limit-two-tasks-evidence.txt). |
| `duplicate` (61 burst × 10 request cùng khóa + 1 đổi amount) | **Đạt** (`runExit=0`, `invariantExit=0`) | 610 × 201 cùng body, 61 × 422 `IDEMPOTENCY_KEY_REUSED`; đúng +61 transfer, +122 bút toán, +61 khóa; chuyển p95 60 ms (< 300). |
| `hot-account` (20 chuyển/giây, 900 giây), **worker 1** | **Không đạt** (`runExit=99`, `invariantExit=0`) | p95 823,6 ms (< 1 s đạt) nhưng p99 2.000 ms, 299 timeout (0) = 1,66% lỗi, `checks` 98,33%. p50 tăng từ 36 ms (phút 1) lên 244 ms (phút 14) rồi sập ở phút cuối (295 timeout). RDS CPU trung bình 67%, đỉnh 89%; worker CPU 68 đến 86%. Sổ cái vẫn đúng (checker PASS). |
| `hot-account`, **worker 0** (chẩn đoán) | Đạt (`runExit=0`, `invariantExit=0`) | 18.001 lệnh đều 201, p95 52,3 ms, p99 144,9 ms; p50 phẳng 37 ms suốt 15 phút; RDS CPU trung bình 19%, kết nối 4 đến 8. Chạy sau `stress` nên DB lớn hơn lượt trên, nên chênh lệch càng chứng minh nguyên nhân là worker. |
| `stress`, **worker 1** | Không đạt (`runExit=99`) | Plateau 120: p95 chuyển 784 ms, p99 1,77 s, 43 timeout (0,119%), đọc lịch sử p95 183 ms. Plateau 180: 97,3% timeout, 199 dropped. Plateau 240: 99,4% timeout, 12.687 dropped (hệ thống sập hẳn). RDS CPU 81 đến 90%, kết nối 30/30, một task api chạm 100% CPU ở 240. |
| `stress`, **worker 0** (BL-385) | Đạt tới 180 RPS | Plateau 120: p95 97,6 ms, p99 437,8 ms, 0 lỗi. Plateau 180: p95 240,1 ms, p99 740,2 ms, 1 lỗi (502 của ALB), 0 dropped: các ngưỡng NFR đều đạt. Plateau 240: p95 1,37 s, 422 lỗi (0,59%), 205 dropped: gãy. RDS CPU trung bình 36% (đỉnh 56%), CPU task api đỉnh 82%. |

## 6. Phán quyết DoD 3 và lý do

**«Lỗi < 0,1% liên tục 15 phút ở 120 RPS»: đạt ở `baseline`, không đạt ở những lượt sau trên cùng DB khi worker bật.**

- Đạt: plateau 120 của `baseline` có 0 lỗi hệ thống trên 108.002 request trong 900 giây, 0 dropped, `achievedRps` 119,998.
- Không giữ được: cùng 120 RPS ở `stress` (DB đã thêm ≈ 25.000 giao dịch, worker bật) có 0,119% lỗi và p95 784 ms; và ở `hot-account` (worker bật) 1,66% lỗi.
- Điều kiện của kết luận «đạt»: DB mới, 3 khách, 2 task api, worker 1, một lượt duy nhất; chỉ một cửa sổ 15 phút, không có lần lặp. Nên đọc là «đạt ở đầu phiên, giảm dần theo lịch sử tích lũy», không phải «luôn đạt».

## 7. Điểm gãy và nút thắt

1. **Truy vấn đặc trưng fraud của worker (nút thắt chính, đã đo).** `EXPLAIN (ANALYZE, BUFFERS)` của truy vấn `history` ([transfer-facts.ts](../../../backend/src/modules/risk/features/transfer-facts.ts), cửa sổ 30 ngày) trên tài khoản nóng (64.289 giao dịch) chạy Seq Scan + Sort + hai WindowAgg, **86 ms mỗi lần gọi** ([kết quả](results/explain-history-hot-account.txt)). Với 20 đến 24 giao dịch/giây, riêng truy vấn này tốn ước tính ≈ 2 CPU-giây mỗi giây (24 × 86 ms, giả định thời gian chủ yếu là CPU), bằng cả hai vCPU của `db.t4g.small`; chi phí tăng tuyến tính theo lịch sử của tài khoản. Bằng chứng gián tiếp khớp: bật worker thì RDS CPU 62 đến 90% và `hot-account` suy giảm dần; tắt worker thì RDS CPU 19% và `hot-account` phẳng, `stress` đạt tới 180 RPS. Đây là số đo cho BL-187 (mới đo ở 24 lệnh/giây, chưa tới 120 extract/giây).
2. **Pool kết nối:** `rds_conn` chạm 30 = 3 task × 10 ở mọi lượt có tải; với worker bật các request chờ kết nối khi truy vấn nặng giữ chúng.
3. **Worker 0,25 vCPU** ở 85 đến 90% CPU với 24 sự kiện/giây: không còn dư địa.
4. **API:** ở 240 RPS (worker 0) CPU task api đỉnh 82%, một task chạm 100% ở `stress` worker 1: nút thắt kế tiếp khi hai nút trên được gỡ.
5. **RDS burstable:** CPU vượt mức cơ sở dùng tín dụng; ở unlimited mode không bị bóp nhưng tính phí; production cùng loại instance.

**Hướng xử lý (theo thứ tự hiệu quả; việc của Dev/#4, đã ghi ở [BACKLOG](../../BACKLOG.md)):**

1. Bỏ truy vấn O(lịch sử) khỏi đường nóng: giới hạn số dòng (ví dụ N gần nhất), hoặc duy trì thống kê gia tăng theo tài khoản (đếm, trung vị xấp xỉ), hoặc đẩy cửa sổ 30 ngày sang bảng tổng hợp theo ngày; thêm chỉ mục phủ `(from_account_id, created_at) INCLUDE (amount)`. Đo lại `hot-account` với worker bật; ngưỡng đạt: 0 lỗi, p95 < 1 s.
2. Tách tải đọc của worker khỏi RDS chính (replica đọc) hoặc nâng `db.t4g.medium` nếu vẫn cần, và đo lại plateau 120 sau khi có bản sửa truy vấn.
3. Tăng CPU worker (0,5 vCPU) khi tăng số sự kiện; tăng `DATABASE_POOL_MAX` chỉ sau khi truy vấn nặng được gỡ (pool lớn hơn trên RDS đang cạn CPU làm xấu thêm).
4. Đặt `keepAliveTimeout` của API lớn hơn thời gian idle của ALB (60 giây) để loại các 502 ngẫu nhiên.

## 8. Cảnh báo vận hành thấy trong lúc đo

- Alarm và dashboard của `session` chạy bình thường; không cấu hình email nên không có thư (BL-276 chưa đổi).
- ALB 5xx: 1 (baseline), 1 và 4 (hai lượt stress); WAF `rate-limit` = 0.
- Rollout api sang task definition mới (đổi giới hạn tốc độ) mất ≈ 6 phút (08:58 đến 09:04 giờ địa phương); CloudWatch ghi 3 lỗi ALB 5xx trong cửa sổ có rollout (`desired_count = 2`, `deployment_minimum_healthy_percent = 50`); nên không cập nhật service khi bài đang chạy (BL-381).
- Dựng `session` (RDS Multi-AZ, Valkey replica, ALB, WAF, ECS, dashboard, alarm, 66 tài nguyên) mất 16 phút 9 giây (RDS Multi-AZ 15 phút 48 giây, Valkey 9 phút 29 giây, ALB 2 phút 12 giây, chạy song song); `db-roles.sh` 55 giây; `migrate.sh` 55 giây; `apply` nâng service 10 giây và `/health/ready` 200 sau khoảng 1 phút. Hủy: xem [DBS-166 §8](../../features/DBS-166-load-report.md).

## 9. Kết quả thô

Mỗi thư mục trong [results/](results/) là một lượt: `summary.json` (k6), `exit.json` (`runExit`, `invariantExit`, `aggregateExit`), `invariants.txt` (báo cáo checker), `run.log` (log đã lược tiến độ và cảnh báo lặp), `aggregate.json` và `per-minute.json` (rút gọn từ raw bằng [`load-tests/aggregate-raw.cjs`](../../../load-tests/aggregate-raw.cjs)), `requests.csv.gz` (mỗi request một dòng: `epoch_ms,scenario,name,status,duration_ms`), `cloudwatch.json` (chuỗi theo phút, [`cw-export.mjs`](results/cw-export.mjs)), `raw.json.sha256` và `raw.json.size` của tệp k6 gốc.

| Thư mục | Bài | `runExit` | `invariantExit` |
|---|---|---|---|
| `baseline-smoke-0274f66d` | baseline `--smoke` (5 RPS, kiểm đường ống) | 0 | 0 |
| `rate-limit-37f67878` | rate-limit | 0 | 0 |
| `baseline-efb059bd` | baseline đủ tải | 99 | 0 |
| `hot-account-a65c01e3` | hot-account, worker 1 | 99 | 0 |
| `duplicate-089e4e66` | duplicate | 0 | 0 |
| `stress-479d5897` | stress, worker 1 | 99 | 0 |
| `stress-worker0-f5d12a5a` | stress, worker 0 | 99 | 0 |
| `hot-account-worker0-8e2d7341` | hot-account, worker 0 (chẩn đoán) | 0 | 0 |

`raw.json` đầy đủ của k6 (≈ 0,6 GB cho `baseline`, nén ≈ 25 MB) **không commit**: kích thước và sha256 ghi cạnh mỗi lượt; `requests.csv.gz` đủ để tính lại mọi phân vị. Tệp `summarize.mjs` tạo bảng của báo cáo này từ `aggregate.json` và `run.log` (không có test riêng; số trong báo cáo kiểm lại bằng `aggregate.json`).
