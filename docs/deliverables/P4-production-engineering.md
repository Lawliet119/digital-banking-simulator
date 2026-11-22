# P4 — Production Engineering: Digital Banking Simulator

> **Status:** Bản ghép, **chưa nộp** (việc của người) · **Dẫn dắt:** #6 (ghép và nộp) · **Cập nhật:** 2026-11-22 (DBS-189)
> Bản này **trỏ về nguồn và chép số nguyên văn**, không viết lại báo cáo gốc: mỗi con số có link tới tài liệu sinh ra nó; khi nguồn đổi thì sửa nguồn trước rồi sửa ở đây. Số trong bản này được kiểm với nguồn bằng [`verify-numbers.py`](../features/screenshots/DBS-189/verify-numbers.py) (từng cặp «chuỗi trong bản ghép ↔ chuỗi trong nguồn»). Thực tế đo, giới hạn và việc chưa làm nằm ở [§7](#7-giới-hạn-nói-thẳng-và-việc-còn-lại).

## 1. Tóm tắt

| Mục thầy yêu cầu | Kết quả ngắn | Nguồn |
|---|---|---|
| Load test | Ở 120 RPS trên AWS (RDS Multi-AZ, 2 task api, WAF bật): p95 chuyển tiền **91,9 ms** ở lượt mới nhất, lỗi 0,0083 %; p95 **từng phút** < 300 ms **chưa đạt trọn** (2/15 khung vượt); tài khoản nóng ≥ 40.000 dòng chưa đạt | [§2](#2-báo-cáo-tải) |
| Reliability (sự cố) | Redis tắt không làm hỏng giao dịch; Redis chậm vừa phải là ca xấu nhất; kill task, worker chết, DLQ, deploy lỗi, thu hồi phiên, failover RDS có bảng làm gì → phản ứng → phục hồi | [§3](#3-bảng-sự-cố-làm-gì--phản-ứng--thời-gian-phục-hồi) |
| SLO chính thức | 9 SLI/SLO, alarm theo từng SLI | [§4](#4-slislo-chính-thức) |
| Dashboard | `dbs-dev-overview` 33 widget, 25 ảnh chụp lúc 120 RPS mỗi lượt Redis bật và tắt | [§5](#5-dashboard) |
| Capacity & cost | 8,2642 USD đã tiêu, credit còn ≈ 191,29 USD; 24/7 dev ≈ 113,23, production ≈ 203,55 USD/tháng; HA thêm 80,14 USD/tháng | [§6](#6-capacity-và-chi-phí) |

## 2. Báo cáo tải

Cấu hình đo chung ([02 §1](../components/load-tests/02-ket-qua-tai-cloud-2026-11-21.md#1-cấu-hình-đo)): AWS `ap-southeast-1`; 2 task api (0,5 vCPU/1 GB), 1 worker (0,25 vCPU/0,5 GB); RDS PostgreSQL 17 `db.t4g.small` Multi-AZ; Valkey `cache.t4g.micro` 1 primary + 1 replica; WAF bật; máy tải `t3.medium` cùng VPC, k6 v2.3.0; xác thực Cognito thật; một DB mới, ba khách. Mỗi lượt có checker bất biến DBS-69 sau chạy.

### 2.1 Bốn lần đo `baseline`, plateau 120 RPS (80 % đọc, 15 phút)

Không lượt nào bị chạy lại để chọn lượt đẹp ([02 §2](../components/load-tests/02-ket-qua-tai-cloud-2026-11-21.md#2-cách-đo-và-đọc-số)); hai lượt «trước» cùng cấu hình cho hai kết quả khác nhau.

| | DBS-166 (lượt 1 «trước») | S1 (lượt 2 «trước») | Sau DBS-173 | Sau BL-418 |
|---|---:|---:|---:|---:|
| Chuyển p95 / p99 (ms) | 218,2 / 703,2 | 344,0 / 1.406,0 | 262,4 / 850,9 | **91,9 / 585,5** |
| Lỗi hệ thống / dropped | 0 / 0 | 171 (0,158 %) / 54 | 1 (0,0009 %) / 0 | 9 (0,0083 %) / 1 |
| `meetsDoD3` (lỗi < 0,1 % và 0 dropped) | đạt | **không đạt** | đạt | **không đạt** (chỉ do 1 dropped; tỉ lệ lỗi vẫn < 0,1 %) |
| p95 theo phút > 300 ms | 3/15 khung (đỉnh 641 ms) | 7/16 khung (đỉnh 1.985 ms) | 5/16 khung (đỉnh 678 ms) | **2/15 khung** (442 và 377 ms) |
| Nguồn | [03 §5.1](../components/load-tests/03-ket-qua-toi-uu-p95-2026-11-21.md#51-baseline-plateau-120-rps-80-đọc-15-phút) | [03 §5.1](../components/load-tests/03-ket-qua-toi-uu-p95-2026-11-21.md#51-baseline-plateau-120-rps-80-đọc-15-phút) | [03 §5.1](../components/load-tests/03-ket-qua-toi-uu-p95-2026-11-21.md#51-baseline-plateau-120-rps-80-đọc-15-phút) | [04 §0](../components/load-tests/04-ket-qua-bl-418-2026-11-22.md) |

p95 12 và 60 RPS ở lượt đầu: chuyển **42 / 60 ms** (p99 106 / 153 ms), đọc p95 ≤ 61 ms ([02 §0](../components/load-tests/02-ket-qua-tai-cloud-2026-11-21.md)). Chờ khóa dòng tài khoản của api giảm 22,4 → **9,8 ms** nhờ BL-418 ([04 §0](../components/load-tests/04-ket-qua-bl-418-2026-11-22.md)).

### 2.2 Tài khoản nóng, stress, trùng lặp

| Bài | Kết quả | Nguồn |
|---|---|---|
| `hot-account` 20 lệnh/giây, 15 phút | DBS-166 (worker bật): p95 824 ms, 299 timeout (1,66 %); worker tắt: p95 52 ms, 0 lỗi. Sau DBS-173 lượt 1: p95 **121 ms**, 4 timeout (0,022 %); lượt 2 (tài khoản nóng ≥ 40.000 dòng): p95 **2.000 ms**, 1.881 timeout (10,4 %) **chưa đạt** | [02 §0](../components/load-tests/02-ket-qua-tai-cloud-2026-11-21.md), [03 §5.3](../components/load-tests/03-ket-qua-toi-uu-p95-2026-11-21.md#53-hot-account-worker-bật-20-lệnhgiây-15-phút) |
| `stress` plateau 120 | DBS-166: p95 784 ms, 43 lỗi (0,119 %); sau DBS-173: 304,1 ms (hụt 4 ms), 0 lỗi; sau BL-418: **119,9 ms**, 7 lỗi (0,019 %), 0 dropped | [03 §5.2](../components/load-tests/03-ket-qua-toi-uu-p95-2026-11-21.md), [04 §0](../components/load-tests/04-ket-qua-bl-418-2026-11-22.md) |
| Điểm gãy của `stress` | DBS-166: worker bật gãy 120 → 180 RPS, worker tắt gãy ở 240; sau BL-418: plateau 180 còn 71 lỗi (0,13 %) **nhưng 105 dropped, p95 493 ms** (p95 theo phút tới 1.275 ms), plateau 240 vẫn gãy (68,9 %, CPU api và worker 100 %) | [02 §0](../components/load-tests/02-ket-qua-tai-cloud-2026-11-21.md), [04 §0](../components/load-tests/04-ket-qua-bl-418-2026-11-22.md) |
| `duplicate` (AC-5.3, 5.4, 5.5) | đúng 600 × 201 và 60 × 422 `IDEMPOTENCY_KEY_REUSED`, p95 81 ms | [03 §5.4](../components/load-tests/03-ket-qua-toi-uu-p95-2026-11-21.md) |
| Bất biến (DBS-69) | `PASS` sau mọi lượt trên AWS (8 lượt ở DBS-166, 8 ở DBS-173, 2 ở BL-418, 4 ở DBS-167) | [02](../components/load-tests/02-ket-qua-tai-cloud-2026-11-21.md), [03](../components/load-tests/03-ket-qua-toi-uu-p95-2026-11-21.md), [04](../components/load-tests/04-ket-qua-bl-418-2026-11-22.md), [05](../components/load-tests/05-ket-qua-redis-2026-11-22.md) |

Phân tích nút thắt và thay đổi (một câu SQL gộp thay 3 lượt quét, autovacuum, `keepAliveTimeout`, bộ đếm hạn mức ngày): [DBS-173](../features/DBS-173-p95-120rps.md), [BL-418](../features/BL-418-daily-limit-counter.md).

## 3. Bảng sự cố: làm gì → phản ứng → thời gian phục hồi

Bảng đầy đủ và phân biệt local với AWS: **[P4-incident-table.md](P4-incident-table.md)** (mỗi dòng ghi môi trường, image và bằng chứng; PR này thêm hàng Redis dưới tải 120 RPS và failover RDS). Tóm tắt, chỉ các số có trong nguồn:

| Sự cố | Phản ứng | Phục hồi | Nguồn |
|---|---|---|---|
| **Redis tắt giữa tải 120 RPS** (NACL chặn 6379, 5 phút) | 0 lỗi hệ thống, `/health/ready` luôn 200 (`redis: "degraded"`), p95 chuyển tiền 119 ms, breaker mở trong 10 giây đầu; bất biến PASS | mạng thông, `redis: "up"` ổn định sau **42,5 giây** ([BL-424](../BACKLOG.md): chậm hơn mạng) | [05 §1](../components/load-tests/05-ket-qua-redis-2026-11-22.md) |
| **Redis chậm** (`CLIENT PAUSE` 100 ms, bậc nhẹ) | 0 lỗi; p95 chuyển tiền 203 và 289 ms (SLO 300), đọc 138 và 149 ms (SLO 150), `history` 142 và **154 ms (vượt 4 ms)** | hết xung thì về bình thường; ở 3/4 lượt có một lần đứng hình (timeout 2 giây, tới 3 giây) ở cửa sổ `pre`, trước khi tiêm sự cố, nguyên nhân chưa rõ ([BL-419](../BACKLOG.md)) | [05 §1](../components/load-tests/05-ket-qua-redis-2026-11-22.md) |
| **Task api bị dừng giữa lệnh chuyển tiền** (ECS `stop-task`) | ECS gỡ target sau 25 s, client lần đầu nhận 502 của ALB; transaction không commit, không còn dòng sổ | gửi lại cùng `Idempotency-Key` → đúng một giao dịch, hai bút toán; task mới RUNNING sau **131 s**, service ổn định sau **137 s** (1 task: mất dịch vụ ≈ 2 phút, [BL-382](../BACKLOG.md); đo với `deregistration_delay` 0 và `stopTimeout` 2 tạm, mặc định thì dài hơn khoảng 30 s); đối soát `OK`, bất biến PASS | [DBS-185](../features/DBS-185-ac-5-10-kill-task-cloud.md), [bảng sự cố](P4-incident-table.md) |
| **Worker chết** (`desired-count 0`) | chuyển tiền và nạp vẫn 201; sự kiện nằm trong outbox; alarm `dbs-dev-outbox-age` `ALARM` sau **9 phút 5 giây** | bật lại: worker chạy sau 29 s, cờ gian lận sau **43 s**, alarm `OK` sau 4 phút 39 giây; bất biến PASS | [DBS-184 (d)](../features/DBS-184-cloud-incident-scenarios.md), [bảng sự cố](P4-incident-table.md) |
| **Message hỏng** | vào DLQ sau **2 s**, alarm `dbs-dev-risk-dlq-not-empty` sau **190 s** | bỏ qua có ghi nhận | [DBS-184 (b)](../features/DBS-184-cloud-incident-scenarios.md) |
| **Deploy bản lỗi** (`DB_HOST` sai) | `/health/ready` 503 sau 40 s; sau 197 s mỗi service một task thoát mã 1, circuit breaker chưa tự rollback | `update-service` về revision cũ: `/health/ready` 200 sau 127 s, tổng 267 s; mất phục vụ khoảng 290 s vì api 1 task; số dư nguyên, bất biến PASS ([runbook](../runbooks/rollback.md)) | [DBS-156](../features/DBS-156-rollback-drill.md), [bảng sự cố](P4-incident-table.md) |
| **Thu hồi phiên khi Redis bị flush hoặc tắt** (Cognito, ECS, RDS, ElastiCache thật) | request kế tiếp **401 `SESSION_REVOKED`** (đường SQL fallback, 312 ms ở lượt tắt); mốc SQL còn nguyên; bất biến PASS | `redis: up` ổn định sau **84,3 s** kể từ lúc gọi gỡ chặn (một lần chạy, không phải SLO); failover ElastiCache chưa chạy ([BL-220](../BACKLOG.md)) | [DBS-186](../features/DBS-186-redis-revocation-drill.md), [bảng sự cố](P4-incident-table.md) |
| **Failover RDS** (`reboot --force-failover`, Multi-AZ, `db.t4g.micro`) | khoảng 503 trên health probe **14,7 s và 12,7 s**, tự phục hồi, không restart task | **failover chưa được xác nhận** (AZ không đổi trong raw; chưa có sự kiện RDS; chưa chuyển tiền trong lúc failover: [BL-386](../BACKLOG.md)) | [DBS-181](../features/DBS-181-rds-failover-drill.md), [§6.3](#63-ha-có-đáng-tiền-không) |

Ghi chú bảo vệ (HA và hồi phục, vì sao tiền không sai, giới hạn): [defense-q7-ha-recovery.md](defense-q7-ha-recovery.md).

## 4. SLI/SLO chính thức

Chốt 2026-10-11, đo trong các đợt bật cấu hình production và trong load test; dev không cam kết ([docs/03 §14](../03_HIGH_LEVEL_ARCHITECTURE.md)). Bảng chép nguyên văn từ nguồn:

| SLI | Đo ở đâu | SLO | Cửa sổ | Alarm khi |
|---|---|---|---|---|
| Tỉ lệ request API không lỗi 5xx (422 và 429 không tính là lỗi) | ALB, API | ≥ 99,9% | 30 ngày (ngân sách lỗi ≈ 43 phút) | Tỉ lệ 5xx > 1% trong 5 phút |
| Latency chuyển tiền p95 / p99 | API | p95 < 300 ms, p99 < 1 s ở ≤ 120 RPS | 5 phút | p95 > 300 ms trong 3 cửa sổ liên tiếp |
| Latency đọc (số dư, lịch sử) p95 | API | < 150 ms | 5 phút | p95 > 150 ms trong 3 cửa sổ liên tiếp |
| Thời gian từ giao dịch tới khi có cờ p95 | Worker (`fraud_flags.created_at − transfers.created_at`) | < 5 giây | 15 phút | p95 > 5 giây |
| Tuổi outbox chưa gửi cũ nhất | Worker | < 10 giây | 1 phút | > 30 giây (relay hoặc worker treo) |
| Số message trong DLQ; tuổi message cũ nhất của queue chính | SQS | DLQ = 0; tuổi < 60 giây | 1 phút | DLQ > 0; tuổi > 120 giây |
| Kết quả đối soát sổ cái | Job đối soát | 0 lệch | Mỗi lần chạy | `MISMATCH` hoặc `ERROR` |
| Cảnh báo gian lận trên 1.000 giao dịch | Worker | ≤ 20 | 24 giờ trượt, khi có ≥ 1.000 giao dịch | > 20 |
| Latency Redis, số lần rơi về đường dự phòng (`redis_fallback_total`), số request bị rate limit | API, Worker | Theo dõi | — | Redis không truy cập được > 1 phút |

Alarm tạo bằng Terraform: [DBS-177](../features/DBS-177-slo-alarms.md) (bốn alarm SLO), [DBS-123](../features/DBS-123-reconciliation-alarms.md), [DBS-188](../features/DBS-188-flag-rate-alarm.md). **Giới hạn:** chưa có email thật nào được nhận vì `alarm_email` chưa đặt ([BL-276](../BACKLOG.md)); phần lớn alarm mới thử bằng `set-alarm-state` hoặc mock, chưa kêu bằng tải thật ([BL-341](../BACKLOG.md)). Redis: alarm `dbs-dev-redis-fallback` kêu thật khi tắt Redis nhưng **không về OK suốt lượt đo có tải** (ngưỡng `> 0` không phân biệt Redis khỏe với lỗi): [BL-425](../BACKLOG.md).

## 5. Dashboard

CloudWatch `dbs-dev-overview` dựng bằng Terraform (`envs/dev/session`): **33 widget** (7 văn bản, 1 trạng thái alarm, 25 metric) theo các SLI trên, đường kẻ ngang là ngưỡng SLO ([DBS-178](../features/DBS-178-dashboard-complete.md), [DBS-145](../features/DBS-145-cloudwatch-dashboard.md)). Ảnh chụp lúc chạy **120 RPS**, mỗi lượt 25 ảnh, bằng [`dashboard-snapshot.mjs`](../../infra/scripts/dashboard-snapshot.mjs):

- Redis **bật**: [`components/observability/screenshots/120rps-redis-on/`](../components/observability/screenshots/120rps-redis-on/) (ví dụ [p95 chuyển tiền](../components/observability/screenshots/120rps-redis-on/02-chuyen-tien-post-v1-transfers-p95-va-p99-ms.png), [tỉ lệ 5xx](../components/observability/screenshots/120rps-redis-on/03-ti-le-5xx.png), [redis_fallback](../components/observability/screenshots/120rps-redis-on/14-redis-fallback.png)).
- Redis **tắt**: [`components/observability/screenshots/120rps-redis-off/`](../components/observability/screenshots/120rps-redis-off/) (cùng bộ, [redis_fallback](../components/observability/screenshots/120rps-redis-off/14-redis-fallback.png) tăng khi tắt).

**Giới hạn:** các ảnh là PNG do API CloudWatch vẽ (`get-metric-widget-image`), **không phải ảnh chụp console**: widget trạng thái alarm và 7 widget văn bản không có ảnh, hai ô `singleValue` bị vẽ thành đường theo thời gian; ảnh console còn thiếu ([BL-262](../BACKLOG.md), [BL-404](../BACKLOG.md)). Tổng quan thành phần: [observability](../components/observability/01-concept-brief.md).

## 6. Capacity và chi phí

Nguồn chính: [02-capacity-cost.md](../components/platform-infra/02-capacity-cost.md) và [báo cáo chi phí 2026-11-22](../components/platform-infra/cost-reports/2026-11-22.md). **Ước lượng, chưa đối chiếu hóa đơn** ([BL-426](../BACKLOG.md)).

### 6.1 Đã tiêu và dự báo

| | Giá trị |
|---|---|
| Chi phí gộp 01/10 → hết 21/11 UTC | **8,2642 USD** (RDS 1,4266 · WAF 1,0131 · ECS 0,9558 · ALB 0,9283 · KMS 0,8933 · ElastiCache 0,7488 · Secrets 0,7072 · máy tải 0,5155 · VPC 0,4700 · Cost Explorer 0,3500 · SQS 0,1434) |
| Credit đã dùng / còn lại | 8,7053 / ≈ **191,2947** trên 200 USD (ước tính) |
| Budget tháng 11 | 7,766 trên 150 USD; dự báo cả tháng 8,567 |
| Dự báo tới 13/12 | ≈ **6–7 USD** theo kế hoạch phiên (6,15–7,30); script dự báo 16,8232 USD là cận trên |

### 6.2 Theo giờ, theo phiên, 24/7

| | Dev (Single-AZ) | Production (Multi-AZ) | Cấu hình đo (cỡ production, có WAF) + máy tải |
|---|---:|---:|---:|
| Tài nguyên, USD/giờ | 0,1394 | 0,2752 | 0,3330 (cộng WAF cố định 0,0110) |
| 24/7, USD/tháng (gồm secret, giữ lại; WAF chỉ ở dev) | **113,23** | **203,55** | — |
| Phiên 3 giờ, USD (chưa kể phí theo tải) | 0,45 | — | 1,03 |

Phí theo tải thêm vào (≈ 29 % ngày đo 21/11): WAF request 0,60 USD/triệu (≈ 0,26 USD mỗi giờ 120 RPS). Dev 24/7 vừa trong Budget 150 USD, production 24/7 vượt cả Budget và trần 200 USD của NFR-COST-01; vì vậy dựng rồi xóa theo phiên.

### 6.3 HA có đáng tiền không

HA (RDS Multi-AZ 39,99 + Valkey replica 14,02 + task `api` thứ hai 26,13) thêm **0,1098 USD/giờ, 80,14 USD/tháng**. Một sự cố RDS Single-AZ ăn 23–69 % ngân sách lỗi 43,2 phút của tháng tùy RTO khôi phục (chưa đo; mục tiêu thiết kế 30 phút = 69,44 %); khoảng 503 đo được 12,7–14,7 s dùng 0,49–0,57 %, nhưng failover chưa xác nhận và đo ở `db.t4g.micro` bằng health probe. Kết luận theo mức bằng chứng: **không** bật HA liên tục ở dev; bật theo phiên diễn tập (+0,25–0,42 USD cho 3–5 giờ ở cỡ micro); production 24/7 với SLO 99,9 % cần RDS Multi-AZ và 2 task `api` (66,12 USD/tháng), **nếu có ngân sách riêng và nếu số đo giữ được dưới tải thật**, và chỉ cho một production giả định (dự án này chỉ bật production theo đợt); replica Valkey chưa có bằng chứng giúp SLO. Chi tiết: [02-capacity-cost.md §8](../components/platform-infra/02-capacity-cost.md#8-dev-single-az-so-với-production-multi-az-ha-có-đáng-tiền-không-dbs-182).

## 7. Giới hạn nói thẳng và việc còn lại

| Giới hạn | Nguồn / BL |
|---|---|
| p95 theo phút ở 120 RPS **chưa dưới 300 ms trọn 15 phút** (2/15 khung vượt); đuôi 1–2 giây chưa tìm ra nguyên nhân (không do event loop, `SUM`, GC) | [BL-419](../BACKLOG.md), [04 §0](../components/load-tests/04-ket-qua-bl-418-2026-11-22.md) |
| Tài khoản nóng ≥ 40.000 dòng **không đạt** (10,4 % timeout): chi phí fraud O(cửa sổ 30 ngày) | [BL-413](../BACKLOG.md), [03 §5.3](../components/load-tests/03-ket-qua-toi-uu-p95-2026-11-21.md) |
| Điểm gãy: plateau 240 gãy với CPU api và worker 100 % (cỡ task api và worker là quyết định của #5) | [BL-417](../BACKLOG.md), [04 §0](../components/load-tests/04-ket-qua-bl-418-2026-11-22.md) |
| Một lượt mỗi bài, ba khách, một IP nguồn, không có khoảng tin cậy; hai lượt «trước» khác nhau chứng minh phương sai lớn | [02 §3](../components/load-tests/02-ket-qua-tai-cloud-2026-11-21.md#3-tính-đại-diện-đọc-trước-khi-trích-số) |
| Thời gian tới cờ (p95 < 5 giây) ở 12/60/120 RPS và B0/B2: **chưa đo** (DBS-174, DBS-175 thuộc phiên AWS sau) | task board |
| Failover RDS chưa xác nhận; RTO Single-AZ và RPO của cả hai chưa đo; PITR chưa diễn tập | [BL-386](../BACKLOG.md), [BL-388](../BACKLOG.md) |
| Failover ElastiCache dưới tải chưa diễn tập; hồi phục Redis sau sự cố dài chưa đo; alarm `dbs-dev-redis-fallback` không về OK khi có tải | [BL-220](../BACKLOG.md), [BL-424](../BACKLOG.md), [BL-425](../BACKLOG.md) |
| Alarm chưa gửi email thật, chưa kêu bằng tải thật; ảnh dashboard không phải ảnh console | [BL-276](../BACKLOG.md), [BL-341](../BACKLOG.md), [BL-262](../BACKLOG.md), [BL-404](../BACKLOG.md) |
| Chi phí là ước lượng, chưa đối chiếu hóa đơn; phiên AWS-A ngày 22/11 chưa có trong Cost Explorer | [BL-426](../BACKLOG.md) |
| Sự cố bất đồng bộ và kill task đo ở dev 1 task; chưa có video | [defense-q7](defense-q7-ha-recovery.md), [BL-380](../BACKLOG.md), [BL-383](../BACKLOG.md), [BL-386](../BACKLOG.md) |

**Việc của người trước khi nộp** (agent không làm): kiểm lại số với báo cáo gốc nếu nguồn vừa đổi (chạy lại `verify-numbers.py`); nộp P4 theo hạn của giảng viên (chưa xác nhận trong repo, xem [README](README.md)); cập nhật board (trong repo: DBS-167, 178, 181, 184, 186 đã xong; DBS-173 làm một phần, p95 từng phút chưa đạt; DBS-179, 182, 189 chờ merge); gửi tóm tắt chi phí cho nhóm mỗi thứ Hai ([BL-426](../BACKLOG.md)); chạy phiên AWS còn lại (DBS-174, 175) nếu muốn bổ sung số thời gian tới cờ trước khi nộp.

## 8. Danh mục nguồn

| Phần | Nguồn |
|---|---|
| Tải | [01 concept](../components/load-tests/01-concept-brief.md), [02 (DBS-166)](../components/load-tests/02-ket-qua-tai-cloud-2026-11-21.md), [03 (DBS-173)](../components/load-tests/03-ket-qua-toi-uu-p95-2026-11-21.md), [04 (BL-418)](../components/load-tests/04-ket-qua-bl-418-2026-11-22.md), [05 (Redis, DBS-167)](../components/load-tests/05-ket-qua-redis-2026-11-22.md), kết quả thô [results/](../components/load-tests/results/) |
| Sự cố | [P4-incident-table](P4-incident-table.md), [defense-q7](defense-q7-ha-recovery.md), [DBS-181](../features/DBS-181-rds-failover-drill.md), [DBS-184](../features/DBS-184-cloud-incident-scenarios.md), [DBS-185](../features/DBS-185-ac-5-10-kill-task-cloud.md), [DBS-186](../features/DBS-186-redis-revocation-drill.md), [DBS-167](../features/DBS-167-redis-fault-load.md) |
| SLO và dashboard | [docs/03 §14](../03_HIGH_LEVEL_ARCHITECTURE.md), [DBS-177](../features/DBS-177-slo-alarms.md), [DBS-178](../features/DBS-178-dashboard-complete.md), [observability](../components/observability/01-concept-brief.md) |
| Capacity và chi phí | [02-capacity-cost](../components/platform-infra/02-capacity-cost.md), [cost-reports](../components/platform-infra/cost-reports/2026-11-22.md), [DBS-179](../features/DBS-179-cost-actual.md), [DBS-182](../features/DBS-182-ha-cost-table.md) |
