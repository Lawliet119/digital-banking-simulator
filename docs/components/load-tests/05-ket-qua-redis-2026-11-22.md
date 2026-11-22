# Báo cáo tải: Redis bật, chậm và tắt ở 120 RPS (DBS-167)

> **Status:** Final · **Ngày đo:** 2026-11-22 (00:04 đến 01:11 UTC) · **Task:** [DBS-167](../../features/DBS-167-redis-fault-load.md) · **Kết quả thô:** [`results/redis-*`](results/) · **Cùng phiên:** DBS-178 (`docs/features/DBS-178-dashboard-complete.md`, PR riêng) (ảnh dashboard), [DBS-186](../../features/DBS-186-redis-revocation-drill.md) (drill thu hồi phiên), BL-420 (lần chạy thật của `pgss.sh`)

## 1. Kết luận

| Câu hỏi | Trả lời (số ở §3 và §4) |
|---|---|
| Redis tắt giữa tải thì chuyển tiền có chết không? | **Không.** 0 lỗi hệ thống trong 5 phút tắt, `/health/ready` luôn 200 (`redis: "degraded"`), p95 chuyển tiền 119 ms (không cao hơn các cửa sổ khác). Breaker mở trong 10 giây đầu. |
| Redis chậm giữa tải thì sao? | **Chậm đi, không hỏng.** 0 lỗi trong cả hai bậc xung. Bậc nhẹ (breaker gần như luôn đóng, mỗi request chịu thêm tới 50 ms mỗi lần gọi Redis) là bậc xấu nhất: p95 chuyển tiền 203 và 289 ms ở hai lượt (SLO 300 ms), p95 đọc 138 và 149 ms (SLO 150 ms), p95 `history` 142 và **154 ms (vượt 4 ms)** ở lượt hai. Bậc nặng (breaker mở) nhanh hơn bậc nhẹ. |
| Bất biến, `/health/ready`? | Checker DBS-69 PASS sau cả bốn lượt (`invariantExit` 0); `/health/ready` 200 ở 2.604 trên 2.604 mẫu (mỗi giây một mẫu) của ba lượt có sự cố, và 872 trên 872 ở lượt đối chứng. |
| Redis không phải điểm chết duy nhất? | Đúng: tắt hẳn không làm hỏng giao dịch; điểm yếu là **Redis chậm vừa phải** (dưới ngưỡng mở breaker), không phải Redis chết. |
| Vấn đề thành BL | BL-221 (cập nhật: số đo, đề xuất), BL-419 (cập nhật: đứng hình 3 lần trong 4 lượt, không do event loop), BL-216 (thu hẹp: còn failover), BL mới ở §6. |

## 2. Cấu hình và cách làm

- **Hệ thống:** image CI của `main` `76b80bdb` (không build tay), 2 task api (0,5 vCPU, 1 GB), 1 worker, RDS PostgreSQL 17 `db.t4g.small` Multi-AZ, Valkey 8 `cache.t4g.micro` 1 primary + 1 replica (TLS + AUTH), WAF bật (miễn rate rule cho IP máy tải), máy tải EC2 `t3.medium` cùng region, k6 v2.3.0. Giới hạn tốc độ của app nâng lên 1.000.000. Stack dựng 06:30 +07, `session` xong 06:48.
- **Tải:** kịch bản mới `redis-fault` (một plateau 120 RPS, 900 s, 80% đọc 20% chuyển, ngưỡng k6 như `baseline`), cùng fixture ba khách; ngưỡng chung `system_errors < 0,1%`, `dropped_iterations = 0`.
- **Sự cố** (tiêm ở +300 s sau khi k6 chạy, 300 s; ghi trong `fault-events.jsonl`): **tắt** = NACL riêng `dbs-dev-private-fault` với luật deny tcp 6379 từ CIDR public (cắt cả kết nối đang mở; `redis-fault.sh down` kiểm bằng kết nối mới từ máy tải phải hết giờ); **chậm** = xung `CLIENT PAUSE <P> ALL` mỗi 200 ms: 150 s với P = 100 ms (**bậc nhẹ**), 150 s với P = 180 ms (**bậc nặng**). Không có failover (`describe-events` của ElastiCache chỉ có sự kiện tạo).
- **Cửa sổ** (`window-stats.cjs`): `pre` = +60 đến +300 s; sự cố; `recovery` = 60 s sau khôi phục; `after` = phần còn lại (≈ 4 phút). Tiêu chí chốt trước khi chạy ([DBS-167](../../features/DBS-167-redis-fault-load.md) G1.8): SLO ở mọi cửa sổ; «chấp nhận được» khi p95 chênh so với `pre` ≤ 150 ms (chuyển tiền) và ≤ 100 ms (đọc) ở lượt chậm, ≤ max(20 ms, 2N) ở lượt tắt (N = 28,6 ms từ lượt đối chứng); hồi phục ≤ 60 s.
- **Thứ tự lượt:** đối chứng, chậm (lượt 1), tắt, chậm (lượt 2, lặp theo G1.9 vì cửa sổ `pre` của lượt 1 vượt SLO). Mọi lượt đều có trong báo cáo.

## 3. Kết quả theo cửa sổ (p95 và p99 chuyển tiền, p95 đọc, ms; lỗi = status ngoài 200, 201, 422)

| Lượt | Cửa sổ | Request | Lỗi | Chuyển p95 / p99 | Đọc p95 (`balance` / `history`) |
|---|---|---|---|---|---|
| **Đối chứng** (không sự cố) [`d48e6e8a`](results/redis-control-d48e6e8a/) | pre | 28.800 | 0 | 56 / 244 | 28 (26 / 29) |
| | 300–600 s (danh định) | 36.000 | 0 | 85 / 409 | 34 (32 / 37) |
| | recovery | 7.200 | 0 | 63 / 270 | 31 (28 / 32) |
| | after | 28.798 | 0 | 72 / 341 | 35 (33 / 37) |
| **Chậm, lượt 1** [`7bfbb957`](results/redis-slow-1-7bfbb957/) | pre | 28.845 | **6** | 135 / **1.201** | 52 (48 / 55) |
| | bậc nhẹ (P 100) | 18.006 | 0 | 203 / 681 | 138 (134 / 142) |
| | bậc nặng (P 180) | 18.035 | 0 | 160 / 286 | 94 (89 / 97) |
| | recovery | 7.200 | 0 | 131 / 461 | 49 (44 / 54) |
| | after | 28.710 | 0 | 107 / 683 | 47 (43 / 49) |
| **Tắt** [`2066bced`](results/redis-down-2066bced/) | pre | 29.638 | **2** | 185 / 902 | 108 (99 / 113) |
| | tắt 300 s | 36.220 | 0 | 119 / 642 | 57 (53 / 59) |
| | recovery | 7.221 | 0 | 121 / 481 | 52 (48 / 57) |
| | after | 27.712 | 0 | 107 / 381 | 50 (46 / 53) |
| **Chậm, lượt 2** [`c88679a0`](results/redis-slow-2-c88679a0/) | pre | 28.757 | **83** | 211 / **1.654** | 81 (76 / 86) |
| | bậc nhẹ | 18.003 | 0 | **289** / 780 | 149 (142 / **154**) |
| | bậc nặng | 18.036 | 0 | 185 / 389 | 110 (107 / 114) |
| | recovery | 7.199 | 0 | 102 / 239 | 56 (53 / 57) |
| | after | 28.708 | 0 | 123 / 377 | 55 (50 / 58) |

`dropped_iterations`: 0 ở đối chứng, lượt chậm 1 và lượt tắt; **46** ở lượt chậm 2 (hậu quả của lần đứng hình 3 giây ở +265 s, §4.3). RDS CPU lớn nhất 59 đến 64%, api 46 đến 50%, ALB và target 5xx: không có dữ liệu (0), WAF rate rule 0 chặn.

**Độ chênh so với cửa sổ `pre`** (tiêu chí chốt trước): lượt chậm 1: bậc nhẹ chuyển +68, đọc +86; bậc nặng +25, +42. Lượt chậm 2: bậc nhẹ +78, +68; bậc nặng −26, +29. Lượt tắt: −66, −52. Tất cả nằm trong mức cho phép (150 ms chuyển tiền, 100 ms đọc, hoặc max(20, 2N) = 57 ms ở lượt tắt). **Nhưng cửa sổ `pre` của ba lượt có sự cố bị làm bẩn** (đứng hình, dữ liệu tích lũy, §4.3 và §4.4), nên cột «so với `pre`» đánh giá thấp. So với cửa sổ `after` (sạch hơn) bậc nhẹ chậm hơn **+96 và +167 ms** ở chuyển tiền (lượt 2 vượt 150 ms) và **+91 và +94 ms** ở đọc. Báo cáo ghi cả hai.

## 4. Vì sao như vậy

### 4.1 Redis tắt: breaker mở nhanh, giao dịch không đổi

Log `rate limit skipped … (lý do)` của api (Logs Insights `/dbs/dev/api`, [`logq-down.txt`](results/redis-evidence/logq-down.txt)): `pre` 9 `TIMEOUT`; 10 giây đầu của sự cố 1.581 `CIRCUIT_OPEN` và chỉ 3 `TIMEOUT` (breaker mở sau khoảng 10 lệnh thất bại mỗi task); 5 phút còn lại 41.359 `CIRCUIT_OPEN`, 113 `TIMEOUT` (lệnh thử half-open mỗi 5 giây). `redis_fallback_total` của api lên khoảng 16.000 mỗi điểm 60 giây và của worker khoảng 2.900 (period 60 của widget) (ảnh `docs/components/observability/screenshots/120rps-redis-off/14-redis-fallback.png`, PR DBS-178). Mất Redis nghĩa là mất rate limit và cache thu hồi phiên (đọc `users.sessions_revoked_at` từ SQL, [DBS-186](../../features/DBS-186-redis-revocation-drill.md)); chuyển tiền không phụ thuộc. Đường đọc vẫn nhanh (p95 57 ms).

**Hồi phục chậm hơn mạng.** Sau khi luật deny gỡ, api chỉ báo `redis: "up"` ổn định sau **42,5 giây** (mẫu không-`up` cuối cùng, `health.jsonl`): cửa sổ `recovery` còn 5.788 `CIRCUIT_OPEN`. Kết nối TCP đang treo chỉ sống lại ở lần truyền lại kế tiếp và breaker giữ mở tới lúc đó. Dưới ngưỡng 60 giây đã chốt, nên không thành BL; số của lượt chậm là 0 và 5,8 giây. Đáng ghi vì sự cố dài hơn (hàng chục phút) giãn thời gian truyền lại của Linux (tối đa ≈ 15 phút), có thể kéo dài hơn: [BL-424](../../BACKLOG.md).

### 4.2 Redis chậm: bậc nhẹ xấu hơn bậc nặng

Bậc nhẹ (P = 100 ms mỗi 200 ms, khoảng một phần tư lệnh vượt timeout 50 ms): breaker **không mở** (5.142 `TIMEOUT`, không `CIRCUIT_OPEN`; [`logq-slow.txt`](results/redis-evidence/logq-slow.txt)) nên mỗi request chịu tới 50 ms mỗi lần gọi Redis. Chuyển tiền gọi Redis **3 lần nối tiếp** (rate limit IP, `revoked_at` ở `JwtAuthGuard`, rate limit khách), đọc **2 lần** (IP, `revoked_at`). Đọc p95 vì thế từ 47 và 55 lên 138 và 149 ms: sát và có lúc vượt SLO 150 ms. Bậc nặng (P = 180 ms, khoảng 65% lệnh hết giờ) làm breaker mở (20.317 `CIRCUIT_OPEN`, 799 `TIMEOUT`) và request chạy nhanh hơn (đọc 94 và 110 ms, chuyển 160 và 185). **Redis hỏng hẳn an toàn hơn Redis hơi chậm.** Hướng sửa (BL-221): giữ cả hai lệnh nhưng giảm số lần gọi nối tiếp (gộp, song song hóa, hoặc bỏ `GET revoked_at` khi breaker đang nghi ngờ), hoặc hạ timeout 50 ms; quyết định cần đo lại, không làm trong task này.

### 4.3 Đứng hình trước sự cố (BL-419)

Ba trong bốn lượt có một lần đứng hình ở cửa sổ `pre`, trước khi tiêm sự cố, khi Redis còn khỏe: 6 request timeout (2 giây) lúc +197 s ở lượt chậm 1; 2 lúc +249 s ở lượt tắt; **83** (kéo theo 46 dropped iteration) lúc +265 đến +267 s ở lượt chậm 2. Lượt đối chứng không có. Không phải event loop hay GC của task: `event_loop_delay_max_ms` lớn nhất của api trong lượt chậm 1 là 188 ms (worker 353 ms), không có phút nào ở mức giây ([`bl419-slow.txt`](results/redis-evidence/bl419-slow.txt)); cũng không phải Redis (breaker đóng, vài `TIMEOUT`). RDS CPU 5 đến 64%, ALB `TargetResponseTime` p95 lớn nhất 0,81 và 0,54 giây. Nghi vấn còn lại: RDS (checkpoint, autovacuum), ALB hoặc mạng; ghi vào BL-419.

### 4.4 Số «trước» tăng dần qua các lượt

`after` của lượt đối chứng là 72 ms; của ba lượt sau 107 đến 123 ms. Cùng một DB dùng chung cho cả phiên nên bảng `transfers` và lịch sử của ba khách lớn dần (≈ 86.000 chuyển tiền sau bốn lượt), đúng nhận định của BL-413 (chi phí truy vấn tăng theo cửa sổ 30 ngày). Vì vậy **so sánh giữa hai lượt vô nghĩa; chỉ so giữa các cửa sổ trong cùng một lượt**, và cửa sổ `after` mới là mốc sạch.

### 4.5 `pg_stat_statements` (BL-420, lần chạy thật đầu tiên)

`pgss.sh enable`, `reset`, `snapshot` x2 và `pgss_delta.py` chạy thật trên RDS của phiên (lỗi tìm thấy và sửa: Python của Windows không mở đường dẫn `/c/...`, thêm `pwd -W`). Delta của lượt đối chứng ([`pgss-control-delta.txt`](results/redis-evidence/pgss-control-delta.txt)): truy vấn tốn nhất là `SELECT … FROM accounts … FOR UPDATE` của api, 22.344 lần, tổng 163,8 s, trung bình 7,33 ms (chờ khóa tài khoản); tiếp theo là truy vấn `v_transfer_features` của worker (138,2 s, 6,19 ms trung bình, 213 buffer mỗi lần), rồi `count(*)` của người nhận mới (29,8 s). Phần còn lại dưới 15 s.

## 5. Đối chiếu DoD

| DoD | Kết quả |
|---|---|
| 1. Cùng kịch bản 120 RPS khi Redis bật, tắt và chậm giữa tải; so p95, lỗi | **Đạt**: §3 (đối chứng, tắt, hai lượt chậm). |
| 2. Bất biến đúng; `/health/ready` 200; p95 trong ngưỡng | Bất biến **đạt** (4/4). `/health/ready` 200 **đạt** (2.604/2.604 ở ba lượt có sự cố, 872/872 ở lượt đối chứng). p95: **tắt đạt** ở mọi cửa sổ của sự cố; **chậm đạt có điều kiện**: chuyển tiền 289 ms < 300 và đọc 149 ms < 150 ở bậc nhẹ, nhưng `history` 154 ms vượt SLO đọc ở lượt 2 (đọc gộp `balance` và `history` là 149). Cửa sổ `pre` của ba lượt vượt SLO vì đứng hình (không do Redis). Theo tiêu chí chốt trước đó là «phải thành BL», đã thành BL. |
| 3. Ghi vào báo cáo tải; vấn đề thấy được thành issue | **Đạt**: báo cáo này; BL ở §6. |
| 4. PR merge, CI xanh, Dev review | Quy trình: Dev review chưa đạt về hình thức (`Techlead waiver`). |

## 6. Việc để lại (BL)

- **BL-221** (cập nhật): số đo p95 đọc ở §3 và §4.2; quyết định về cache âm / số lần gọi Redis cần một task riêng và đo lại; phần `TC-114-12` giữ lại.
- **BL-216** (thu hẹp): chậm và tắt đã đo; còn failover ElastiCache dưới tải.
- **BL-419** (cập nhật): thêm số §4.3.
- **BL-420**: đóng (đã chạy thật, lỗi đường dẫn đã sửa).
- **BL-424** (mới): breaker và kết nối TCP sau khi mạng thông lại: hồi phục 42,5 giây ở sự cố 5 phút; đo ở sự cố dài hơn, cân nhắc ngắt và nối lại kết nối khi breaker mở hoặc `TCP_USER_TIMEOUT`.
- **BL-425** (mới): không có metric nào chứng minh breaker mở (`redis_fallback_total` tăng ở mọi lần thất bại, không nhãn lý do, không đo trạng thái breaker); hiện chỉ đếm được bằng Logs Insights; thêm nhãn `Reason` hoặc gauge trạng thái. Cùng BL: alarm `dbs-dev-redis-fallback` (Sum > 0, hai điểm liên tiếp) kêu lúc thử tắt Redis (OK → ALARM 06:59:53 +07) và **không về OK** tới hết phiên, vì ở 120 RPS luôn có vài `TIMEOUT` mỗi vài phút ngay cả khi Redis khỏe (lượt đối chứng: 4 đến 6 mỗi 4 phút; [`alarm-history.txt`](results/redis-evidence/alarm-history.txt)): ngưỡng `> 0` không phân biệt Redis khỏe với Redis lỗi khi có tải.

## 7. Chi phí và thời gian

Stack sống từ 06:30 +07 tới lúc hủy (xem feature doc §8); ≈ 0,5 USD/giờ. Cost Explorer chốt chậm: số thật ghi vào báo cáo chi phí.
