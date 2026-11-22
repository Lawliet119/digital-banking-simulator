# observability — Concept Brief

> **Status:** Draft · **Owner:** #5 (dashboard, alarm; metric do Dev phát) · **Verified against code:** một phần: log JSON có `correlationId` (DBS-42); metric HTTP, tuổi outbox và counter `redis_fallback_total`, `rate_limited_total` xuất bằng CloudWatch EMF trong `common/metrics` (DBS-144, kiểm bằng test và **kiểm trên CloudWatch thật ngày 2026-11-09**, xem «Kết quả kiểm trên CloudWatch»). Dashboard `dbs-dev-overview` dựng bằng Terraform (DBS-145, kiểm trên CloudWatch thật bằng số mô phỏng, xem «Dashboard»). Từ DBS-178 dashboard có 33 widget (thêm trạng thái alarm và health, độ sâu hàng đợi chính, request/giây, consumer, quyết định risk) và công cụ chụp `infra/scripts/dashboard-snapshot.mjs`; đã `terraform apply` thật và chụp ở 120 RPS hai lượt (Redis bật và tắt, DBS-167): ảnh ở `screenshots/` cạnh tệp này (ảnh console của widget `alarm` và ô số chưa có: BL-262, BL-404). Alarm CloudWatch dựng bằng Terraform (`base/alarms.tf`, `session/alarms.tf`), kiểm bằng `terraform test` với provider giả, **chưa kích hoạt thử trên AWS thật**; dashboard `dbs-dev-infra` (ECS, ALB, RDS, Valkey) cũng chưa kiểm trên CloudWatch thật. Chưa có: metric của AI (BL-204) · **Cập nhật:** 2026-11-22

## Component

| | |
|---|---|
| **Slug** | `observability` |
| **Loại** | Platform · quan sát |
| **Chạy ở** | CloudWatch (hoặc Grafana) |
| **Use case / NFR** | — (NFR-OBS-01, 02) |
| **Sở hữu bảng** | — |
| **Task trong roadmap** | Task 8 của roadmap cũ (đã xóa ngày 2026-11-07); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md) |

## Vấn đề

Cần biết hệ thống khỏe hay không và truy vết một giao dịch xuyên API → outbox → consumer → audit.

## Ý tưởng

- Log JSON có `correlationId` ở mọi dòng. Một hàm bind chung (`runInLogContext`, `common/logging/log-context.ts`) gắn `role` và `correlationId` đúng một lần cho HTTP, consumer và tác vụ nền (`role=worker` kể cả trong `APP_ROLE=both`); binding do code khác tạo bị khử trùng khoá và che dữ liệu nhạy cảm; `PinoLogger`, `req.log` và `logger.setBindings()` bị ESLint chặn ngoài module logging và test, kể cả `MetricsService` (flush chạy trong `runAsWorker`, nên dòng EMF mang `role=worker`) (BL-024). Lỗi nội bộ Nest/TypeORM chỉ ghi nguyên văn các thông điệp cố định trong allowlist theo `context`, và cảnh báo `process.emitWarning` đi qua logger JSON (BL-026). Chi tiết: [DBS-42](../../features/DBS-42-json-logger.md), `backend/README.md` §8.
- SLI: tỉ lệ chuyển tiền thành công, latency p95/p99, thời gian tới cờ, DLQ, kết quả đối soát, Redis fallback.
- Dashboard và alarm cho các SLI trên; SLO chính thức chốt ở P4.

## Xuất metric (DBS-144)

**Cách xuất: CloudWatch Embedded Metric Format (EMF)**, một dòng JSON có object `_aws` ra log; driver `awslogs` và CloudWatch tự tạo metric, không cần quyền IAM, sidecar hay cổng nào (ADR-10). Mã ở `backend/src/common/metrics/`; không dùng thư viện ngoài, mọi giới hạn của đặc tả AWS được `buildEmf` kiểm trước khi ghi (một dòng sai bị CloudWatch bỏ **không báo lỗi**): metric là số hoặc **mảng ≤ 100 số, không lồng object**; ≤ 100 metric mỗi dòng; `Timestamp` trong −14 ngày..+2 giờ; mỗi bộ dimension tạo một metric riêng.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `METRICS_EMF` | không đặt = bật ở `staging`/`production`, tắt ở `development`/`test` | `true`/`false` ép bật/tắt. Tắt thì không timer, không listener, không dòng nào |
| `METRICS_FLUSH_MS` | `60000` | chu kỳ ghi, 1000..600000 |

Namespace `DBS/Backend`. Tên metric giống tên counter prom-client (`snake_case`, tên gọi trong docs/03 §14 và trên board). Dòng EMF đi qua pino của ứng dụng nên có thêm `level`, `time`, `role`, `correlationId: null`, `message` (EMF cho phép trường thừa).

| Metric | Đơn vị | Dimension | Nguồn · role |
|---|---|---|---|
| `http_request_duration_ms` | Milliseconds (mảng mẫu; p50/p95/p99 tính ở CloudWatch) | `[Route,Method]`, `[Method]`, `[]`; `/health/*` chỉ `[Route,Method]` | middleware HTTP · api |
| `http_requests_total`, `http_5xx_total`, `http_aborted_total` | Count | như trên | như trên |
| `redis_fallback_total` | Count | `Role` | `RedisMetrics` · api, worker |
| `rate_limited_total` | Count | `Role`, `Scope` (`ip`/`user`) | `RateLimitMetrics` · api |
| `risk_config_redis_fallback_total` | Count | `[Role,Reason]` và `[Role]` (một dòng EMF, hai bộ dimension; `Reason` = `error` hoặc `corrupt`; alarm dùng `[Role]`) | `RiskMetrics` qua `RuleSetRepository`; có khi service worker chạy (DBS-121) · worker |
| `risk_config_freshness_exceeded_total` (BL-188) | Count | `Role` (không nhãn) | `RiskMetrics` qua `RuleSetRepository`: một lần chọn phiên bản luật bị bỏ vì không chứng minh được bound 60 s (SQL ≥ 60 s, đồng hồ lùi/lệch) · worker |
| `risk_decision_total` | Count | `[Role, AiStatus]` và `[Role]` (một dòng EMF, hai bộ dimension; `[Role]` là mẫu số của tỉ lệ cờ, DBS-187) | `risk-scoring.metrics.ts`: +1 mỗi quyết định ghi bởi lần giao thắng claim (BL-204) · worker |
| `risk_flag_total` (DBS-187) | Count | `[Role, RiskLevel, Mode, AiAdded]` và `[Role]` | `risk-scoring.metrics.ts` (`countFlag`), gọi ở `RiskScoringConsumer.onCommitted` sau commit, chỉ khi lần giao thắng claim và mức khác `LOW`: +1 mỗi cờ. `RiskLevel` = `MEDIUM`/`HIGH`; `Mode` = `rule_only`/`rules_with_external_ai`; `AiAdded` = `none`/`created` (luật một mình là LOW, AI làm thành cờ)/`raised` (luật MEDIUM, AI nâng lên HIGH). Giá trị ngoài tập ghi `unknown` · worker |
| `risk_rule_error_total` | Count | `Role`, `Rule` (`R1`..`R6`) | `ScoringService`: +1 mỗi lần một luật ném lỗi hoặc trả kết quả sai, mỗi lần nhận của message (BL-207 f, BL-046) · worker |
| `risk_transfer_to_flag_ms` | Milliseconds (mảng mẫu, biên trên bucket) | `Role` | `MetricsService.recordDistribution`; `fraud_flags.created_at − transfers.created_at` của cờ vừa ghi, SLO p95 < 5 giây (docs/03 §14) · worker |
| `risk_ai_call_duration_ms` | Milliseconds (mảng mẫu) | `Role` | `recordDistribution` quanh `RiskAiService.evaluate` (cổng + gọi provider), kể cả khi `UNAVAILABLE`; không có mẫu khi `rule_only` hoặc `CONFIG_INVALID` · worker |
| `reconciliation_runs_total` | Count | `Role`, `Status` (`OK`/`MISMATCH`/`ERROR`) | `ReconciliationService.reconcileOnce`: +1 mỗi lượt đã ghi `reconciliation_runs` (lượt không giành được khóa thì không tính) (BL-127) · worker |
| `consumer_message_total` | Count | `Role`, `Consumer` (`risk`, `notification`, ...), `Outcome` (`retry`/`dead_letter`) | `ConsumerBase.handle` (`consumer.metrics.ts`): +1 mỗi quyết định retry hoặc dead-letter, cùng lúc với một dòng log có `consumer`, `eventId`, `receiveCount` (BL-209). Chưa có alarm riêng: DLQ không rỗng đã có alarm · worker |
| `outbox_oldest_unpublished_age_seconds` | Seconds | không | gauge `OutboxAgeGauge`, mỗi lượt ghi; **không tính dòng đã bị cách ly** (BL-181) · worker |
| `outbox_quarantined_events` | Count | không | gauge `OutboxQuarantineGauge`: số dòng `quarantined_at IS NOT NULL AND published_at IS NULL`, 0 khi không có (BL-181) · worker |
| `event_loop_delay_p99_ms` (BL-419) | Milliseconds | không | gauge `RuntimeGauges` (`runtime-stats.ts`): p99 độ trễ event loop của **một task** trong khoảng từ lần ghi trước, tính phần vượt khoảng lấy mẫu 10 ms (`monitorEventLoopDelay`); mỗi task ghi vào log stream của nó nên tách theo task bằng Logs Insights; metric trong `DBS/Backend` (Maximum) là task tệ nhất · api và worker |
| `event_loop_delay_max_ms` (BL-419) | Milliseconds | không | như trên: độ trễ event loop lớn nhất của khoảng; một task bị chặn 1 đến 2 giây (nghi vấn «đứng hình» của BL-419) hiện ở đây · api và worker |
| `gc_pause_max_ms` (BL-419) | Milliseconds | không | như trên: lần dừng GC dài nhất của khoảng (`PerformanceObserver` `gc`); không có dòng khi không có lần GC nào · api và worker |

**Đọc ba metric runtime (BL-419).** Trong Logs Insights, log group `/dbs/dev/api` (hoặc `worker`): `filter ispresent(event_loop_delay_max_ms) | stats max(event_loop_delay_max_ms) as loopMax, max(gc_pause_max_ms) as gcMax by @logStream, bin(1m)`. Một phút có timeout mà `loopMax` hoặc `gcMax` của một task gần 1 đến 2 giây thì nguyên nhân là task đó (event loop bị chặn hoặc GC dài); cả hai thấp trong lúc có timeout thì loại hai nghi vấn này và còn Valkey, ALB. **Lệch một phút:** mỗi giá trị mô tả khoảng từ lần ghi trước tới lúc ghi (`flushMs`, mặc định 60 giây) nhưng mang mốc thời gian của lúc ghi và timer không khớp ranh giới phút: một lần đứng hình lúc 17:37:50 hiện ở phút 17:38. Đối chiếu phút M của k6 với phút M và M+1 của metric, hoặc đặt `METRICS_FLUSH_MS=10000` cho api và worker trong phiên đo (tối thiểu 1000). Metric trong `DBS/Backend` không có dimension `Role`, nên api và worker gộp chung: tách bằng log group (`/dbs/dev/api`, `/dbs/dev/worker`). Một lần chặn nằm vắt qua lúc đọc (khoảng 10 ms mỗi lần ghi) có thể bị bỏ sót. Bật cùng `METRICS_EMF`; tắt thì không lấy mẫu.

**Giá trị `AiStatus`** là đúng giá trị `risk_decisions.ai_status`: `DISABLED` (cũng là giá trị của quyết định `rule_only`, tức "không yêu cầu AI"), `CONFIG_INVALID`, `SUCCEEDED`, `REFUSED`, `INVALID_RESPONSE`, `UNAVAILABLE`, `BUDGET_EXHAUSTED`; giá trị lạ thành `unknown`. **Tỉ lệ fallback baseline không có metric riêng**: là tổng `risk_decision_total` của các `AiStatus` khác `DISABLED` và `SUCCEEDED`, chia tổng mọi `AiStatus` (cùng `Role`). Metric `risk_redis_fallback_total` đã **bỏ** (BL-204): `OnlineFeatureProvider` đọc SQL, không còn đường Redis để rơi về; chỉ `risk_config_redis_fallback_total` (cache cấu hình luật) còn.

**Độ sâu DLQ và tuổi message cũ nhất không có code**: dùng metric gốc của SQS trong namespace `AWS/SQS` (dimension `QueueName`): `ApproximateNumberOfMessagesVisible` trên `dbs-dev-*-events-dlq` và `ApproximateAgeOfOldestMessage` trên `dbs-dev-*-events` (docs/03 §14).

**Quy ước.** Một "request" là một lần Express trả lời hoặc kết nối bị đóng trước đó (`http_aborted_total`, vẫn vào histogram). **Lỗi = 5xx**; 422 và 429 không tính. `Route` là mẫu đường dẫn đã khớp (`/v1/accounts/:id`), request không khớp route nào là `unmatched`, không bao giờ là URL. `Method` thuộc `GET POST PUT PATCH DELETE HEAD OPTIONS`, còn lại `OTHER`. Nhãn chỉ được thuộc `Route Method Role Rule Reason Scope AiStatus Status`; giá trị chứa UUID, `@` hoặc dãy ≥ 6 chữ số bị thay bằng `redacted` (**không có id khách hay tài khoản trong tên hay nhãn**). Bộ nhớ là bộ đếm bucket cố định (1, 2, 5, 10, 20, 50, 100, 150, 200, 300, 500, 1000, 2000, 5000, 10000, 60000 ms); mỗi mẫu gửi đi là **biên trên** của bucket (không thấp hơn thực tế), các ngưỡng 150 ms, 300 ms, 1 s nằm đúng trên biên, và CloudWatch còn ước lượng phân vị nên giá trị đọc ra lệch biên vài phần trăm (đã đo ở mục kết quả kiểm bên dưới). Tối đa 10 000 mẫu mỗi `(Route,Method)` mỗi lượt (vượt thì chia tỉ lệ): lấy số request từ `http_requests_total`, không từ SampleCount của độ trễ.

**Phân phối độ trễ.** Module gọi `MetricsService.recordDistribution(name, ms)` với `name` thuộc danh sách `DISTRIBUTION_METRICS` (`risk_transfer_to_flag_ms`, `risk_ai_call_duration_ms`): cùng histogram bucket như HTTP, mỗi lượt ghi một hoặc nhiều dòng ≤ 100 mẫu với dimension `[Role]`; tắt EMF thì không giữ gì. Ngưỡng 5 giây của SLO tx → cờ nằm đúng trên biên bucket.

**Thêm một metric.** Counter prom-client: thêm tên và nhãn cho phép vào `COUNTERS` ở `metrics.service.ts` (mỗi nhãn là một dimension, nên phải là nhãn không chứa dữ liệu cá nhân). Giá trị tại một thời điểm: `MetricsService.registerGauge({ name, unit, read })` từ module sở hữu dữ liệu (như `OutboxAgeGauge`); `read` bị giới hạn 3 giây, mỗi gauge tối đa một lần đọc đang chạy, và lượt ghi cuối khi tắt ứng dụng bỏ qua gauge.

**Bàn giao cho #5 (alarm, dashboard: DBS-145, BL-051, BL-179):**
- Tuổi outbox: thống kê `Maximum` (nhiều task cùng ghi), `TreatMissingData = breaching` (worker chết thì **không có dữ liệu**, không phải 0), ngưỡng > 30 giây (docs/03 §14).
- Phân vị: giá trị trong mảng là biên trên bucket, nhưng **CloudWatch tính phân vị là ước lượng** (đã đo: mẫu ở bucket 20 ms cho p50 = 21,1; mẫu ở bucket 1000 ms cho p95 = 977,5), sai khác vài phần trăm quanh biên. Đặt ngưỡng alarm theo SLO (150 ms, 300 ms, 1 s) với `GreaterThanThreshold` và đừng dựa vào việc giá trị trả về đúng bằng biên bucket; ngưỡng 300 ms cần ít nhất 3 cửa sổ liên tiếp (docs/03 §14) chính vì sai số này.
- Tỉ lệ 5xx của dịch vụ: `http_5xx_total` chia `http_requests_total` ở bộ dimension `[]` (không có probe `/health/*`).
- DLQ: `TreatMissingData = notBreaching` (SQS ngừng phát metric của queue rảnh quá 6 giờ).
- Chi phí: mỗi bộ dimension là một metric tùy chỉnh; khoảng 4 metric × (≈ 20 cặp Route×Method + ≈ 5 `[Method]` + 1 `[]`) ≈ 105, cộng khoảng 10 của counter ≈ 35 USD/tháng nếu để chạy cả tháng; tính theo giờ nên phiên ngắn rẻ hơn nhiều. Log: tối đa một dòng cho mỗi 100 request của mỗi route mỗi phút.
- Alarm và dashboard đã dựng theo các quy tắc trên (DBS-145, mục «Alarm CloudWatch» bên dưới). Còn lại cho #5: kích hoạt thử alarm trên AWS thật và xem metric của worker sau khi service worker chạy (DBS-121).
- **Bộ dimension thật của counter.** `MetricsService.writeCounters` xuất mỗi counter ở **một** bộ `[Role, ...nhãn]` (không có bộ `[]`, không có bộ chỉ `Role` khi counter có thêm nhãn); chỉ HTTP và gauge mới có bộ tổng/`[]`. Alarm phải khai đúng bộ đó (ví dụ `risk_decision_total` là `{Role, AiStatus}`), nếu không không bao giờ có dữ liệu. Counter có `roleTotal` (`risk_config_redis_fallback_total`, `risk_decision_total`, `risk_flag_total`) có thêm bộ `[Role]` (tổng, không nhãn) trong cùng dòng.

**Kết quả kiểm trên CloudWatch (2026-11-09, tài khoản dev, profile `dbs`, ap-southeast-1).** Hai dòng EMF do chính mã của `common/metrics` sinh ra (`HttpStats` → `toEmfSpecs` → `buildEmf`) được gửi bằng `aws logs put-log-events` vào `/dbs/dev/api` (log stream tạm, đã xóa), rồi đọc lại bằng `get-metric-statistics` sau khoảng một phút:

| Đo | Mong đợi (từ 20 mẫu: 10 × 20 ms, 5 × 100 ms, 3 × 300 ms, 2 × 1000 ms, 1 lỗi 503) | CloudWatch trả về |
|---|---|---|
| `http_request_duration_ms` `[Route,Method]`: SampleCount, Sum, Min, Max | 20, 3600, 20, 1000 | 20, 3600, 20, 1000 |
| cùng metric: p50, p95, p99 | 20, 1000, 1000 (biên bucket) | 21,1, 977,5, 995,5 (ước lượng) |
| `http_requests_total`, `http_5xx_total` (Sum) | 20, 1 | 20, 1 |
| cùng metric ở bộ `[Method]` và bộ `[]` | như trên | 5xx = 1 (`Method=POST`), requests = 20, p95 = 977,5 (bộ `[]`) |
| số metric trong `DBS/Backend` | 4 metric × 3 bộ dimension = 12 | 12 |
| metric lỗi EMF trong `AWS/Logs` | không có | không có |

Hình dạng dòng (mảng số ≤ 100, không lồng object, ba bộ dimension, đơn vị) vì thế đã được CloudWatch chấp nhận và trích đúng. Metric thử nằm ở `Route=/v1/check-dbs144` và hết hạn tự động sau 15 ngày.

## Dashboard (DBS-145, DBS-178)

`infra/terraform/envs/dev/session/dashboard.tf` dựng dashboard **`dbs-dev-overview`** cùng phiên (`terraform apply` / `destroy` của `session`, hoặc `-target=aws_cloudwatch_dashboard.overview`: dashboard không tham chiếu tài nguyên nào khác của session; trạng thái alarm dùng ARN dựng từ chuỗi chứ không tham chiếu `aws_cloudwatch_metric_alarm`). Output `dashboard_url`. **33 widget (DBS-178)**: 7 văn bản (intro, năm tiêu đề nhóm, «Cách đọc»), 1 widget `alarm`, 25 metric; khoảng thời gian mặc định 3 giờ, `periodOverride = inherit` để cửa sổ 5 phút của widget không bị console tính lại. Bố cục theo thứ tự các chỉ số của DoD (từ trên xuống), mỗi nhóm có một tiêu đề cao 1 dòng:

| Nhóm | Widget (cột × hàng) | Nguồn · đường kẻ ngang (SLO docs/03 §14) |
|---|---|---|
| **1. Trạng thái** | **Trạng thái alarm SLO** (`type = "alarm"`, 20 alarm: 18 ở `session`, hai `dlq-not-empty` ở `base`); **Health: probe `/health/ready`** request và 5xx | ARN dựng từ chuỗi; `http_requests_total`, `http_5xx_total` bộ `[Route=/health/ready, Method=GET]` (probe chỉ được ghi ở bộ này) |
| **2. API** | Chuyển tiền `POST /v1/transfers` p95/p99 (12); tỉ lệ 5xx % (12); **request/giây** (8); đọc p95 (8); độ trễ toàn dịch vụ p50/p95/p99 (8); request, 5xx, bị ngắt (8); p95 theo Route (`SEARCH`, loại `/health/*`, 16) | `[Route,Method]`, `[]` · 300 ms, 1 s; 150 ms; `100 * FILL(5xx,0) / request`, 1%; `rq / PERIOD(rq)`, 120 |
| **3. Hàng đợi** | **Độ sâu hàng đợi chính** (`ApproximateNumberOfMessagesVisible` và `NotVisible`); tuổi message cũ nhất; tuổi outbox; DLQ (12); **consumer retry và dead_letter** (`SEARCH`, 12) | `AWS/SQS` `QueueName` = hai hàng chính (không có SLO độ sâu); 60 s và 120 s; 10 s và 30 s; DLQ > 0; `consumer_message_total{Role,Consumer,Outcome}` |
| **4. Redis, giới hạn, đối soát** | `redis_fallback_total` (`Role` api, worker); `rate_limited_total` (`Scope` ip, user); đối soát sổ cái theo `Status` | MISMATCH/ERROR > 0 |
| **5. Fraud** | Cờ / 1.000 giao dịch: ô 1 giờ, ô 24 giờ, xu hướng và theo mode (period 3600); cờ theo `RiskLevel`; cờ do AI bổ sung (`AiAdded`); **quyết định theo `AiStatus`** (`SEARCH`); thời gian giao dịch → cờ p95; CONFIG_INVALID và lỗi luật; fallback Redis của cấu hình luật (`SEARCH`) | `[Role]` của `risk_flag_total` và `risk_decision_total`, `[Role,AiStatus]` · 20 / 1.000; 5 s (chưa có alarm cho p95) |
| cuối | **Cách đọc** | giới hạn của từng widget, gồm health và Redis |

**Trạng thái health (DBS-178).** Hai widget bổ sung nhau: widget `alarm` cho biết hệ thống có đang vi phạm SLO nào không; widget probe cho biết ALB (mỗi 15 giây) có thấy `/health/ready` trả 5xx không (503 = PostgreSQL không sẵn sàng; không có điểm dữ liệu = chưa có request tới api, không phải «khỏe»). **Redis chết KHÔNG làm probe lỗi:** `HealthController.ready()` vẫn trả 200 với `redis: "degraded"` (chỉ PostgreSQL làm nó 503, DBS-78), nên Redis chết hiện ở `redis_fallback_total`, không ở probe; số fallback của api còn gồm cả lượt `ping` của chính probe (`ready()` gọi `redis.ping()` qua `RedisClient.run`, mà `run` tăng bộ đếm ở mỗi lần lỗi). Số task khỏe sau ALB ở `dbs-dev-infra`. Widget `alarm` **không** liệt kê hai alarm `dlq-oldest-age` vì chúng chưa được apply ở `base` (BL-409): thêm tên vào `dash_alarm_names` khi apply. Test chống trôi: `terraform test` so danh sách với `alarm_name` của alarm session, và `load-tests/test/dashboard-snapshot.test.mjs` (`alarmContract`) đọc `alarms.tf` của `session` và `base` rồi báo đỏ khi thêm alarm mà dashboard chưa có tên.

Chi phí: dashboard không tính theo widget; vượt 50 metric mỗi dashboard thì không còn trong 3 dashboard miễn phí (≈ 3 USD/tháng tính theo giờ tồn tại).

**Cách tính cờ / 1.000 giao dịch.** `IF(d > 0, 1000 * FILL(f, 0) / d, 0)` với `f` = `risk_flag_total{Role=worker}`, `d` = `risk_decision_total{Role=worker}`. Phải có `FILL` vì app chỉ phát dòng khi delta > 0: một cửa sổ chỉ có lệnh LOW có `d` mà không có `f`. Hai ô số dùng `setPeriodToTimeRange` và `start` riêng của widget (`-PT1H`, `-PT24H`) để lấy tổng thật của cả khoảng; metric math của CloudWatch không có hàm dịch thời gian nên đường xu hướng chỉ theo bucket 3600 s, không trượt từng phút. Mẫu số theo mode: `rule_only` dùng quyết định `AiStatus=DISABLED` (bất biến `rule_only` ⇔ `DISABLED`), `rules_with_external_ai` là phần còn lại. Trong chế độ `APP_ROLE=both` (chạy local) `Role` là `both`, nên widget trống; trên ECS worker mang `Role=worker`. Biểu thức, `FILL`, `IF` và `SUM(SEARCH)` đã chạy trên CloudWatch thật (DBS-187 M-187-09); **giao diện ô `singleValue` trên console chưa xem**, xem BL-404.

**Dashboard hạ tầng `dbs-dev-infra` (BL-261)**, `session/dashboard_infra.tf`, tách riêng vì widget ALB cần `arn_suffix` của `aws_lb` và target group (không dựng được từ chuỗi biết trước): nó tham chiếu tài nguyên session nên `-target` nó kéo cả ALB lên, còn `overview` giữ tính chất không tham chiếu. 10 widget (1 văn bản, 9 metric), toàn số đo gốc miễn phí của AWS:

| Hàng | Widget | Nguồn |
|---|---|---|
| 1 | CPU ECS (`api`, `worker`); bộ nhớ ECS; số task api khỏe và không khỏe | `AWS/ECS` (ClusterName `dbs-dev`, ServiceName); `AWS/ApplicationELB` `HealthyHostCount`, `UnHealthyHostCount` |
| 2 | Số 5xx ở ALB (do ALB, do app); tỉ lệ 5xx % = (hai loại) / `RequestCount`, đường 1%; kết nối RDS | `AWS/ApplicationELB`; `AWS/RDS` `DatabaseConnections` |
| 3 | CPU RDS; CPU Valkey (máy và engine); bộ nhớ % và kết nối Valkey | `AWS/RDS`; `AWS/ElastiCache` `CacheClusterId` = `dbs-dev-001` |

Giới hạn: **không có số task đang chạy của ECS** (`RunningTaskCount` thuộc `ECS/ContainerInsights`, Container Insights đang `disabled` ở `ecs.tf` và bật là tốn tiền theo task), nên task api đếm bằng `HealthyHostCount` và worker chỉ nhìn được qua tuổi outbox (không có điểm = không chạy). Tỉ lệ 5xx ở ALB tính cả probe `/health/*` và 5xx do ALB sinh, nên không bằng tỉ lệ ở `overview` (chỉ request ứng dụng).

Đường kẻ chỉ để nhìn, không phải alarm (alarm ở mục dưới). Biến `metrics_namespace` (mặc định `DBS/Backend`) chỉ đổi khi thử dashboard bằng số mô phỏng. Ảnh chụp lúc có tải nhẹ: [tổng hợp 12 widget](../../features/screenshots/DBS-145/00-dashboard-overview.png) và từng widget ở [`screenshots/DBS-145/`](../../features/screenshots/DBS-145/). **Đó là số mô phỏng** (30 phút EMF do chính mã `common/metrics` sinh, namespace `DBS/Backend-dbs145`, không phải app chạy trên ECS), ảnh render bằng `GetMetricWidgetImage`, không phải màn hình console; chi tiết và số đối chiếu ở [DBS-145](../../features/DBS-145-cloudwatch-dashboard.md) §8. Đọc ảnh: p95 chuyển tiền nằm sát đường 300 ms vì CloudWatch ước lượng phân vị quanh biên bucket (xem «Bàn giao cho #5»), không phải vi phạm SLO.

### Chụp ảnh lúc chạy tải (DBS-178)

`infra/scripts/dashboard-snapshot.mjs` (Node, không phụ thuộc ngoài) chụp một PNG cho mỗi widget metric trong một khung thời gian **tuyệt đối** (ví dụ plateau 120 RPS), bằng `aws cloudwatch get-dashboard` rồi `get-metric-widget-image`; chỉ ĐỌC, cần `cloudwatch:GetDashboard` và `cloudwatch:GetMetricWidgetImage`, ≈ 0,02 USD cho 1.000 metric vẽ:

```
node infra/scripts/dashboard-snapshot.mjs --profile dbs \
  --start 2026-11-22T10:00:00Z --end 2026-11-22T10:15:00Z \
  --out docs/components/observability/screenshots/120rps-redis-on
```

Chạy **≈ 5 phút sau** khi plateau kết thúc (EMF và SQS nhập số chậm). Tên tệp `NN-<tiêu đề không dấu>.png` theo thứ tự đọc (y rồi x); thoát 0 mọi widget vẽ được, 1 có widget lỗi hoặc không đọc được dashboard, 2 dùng sai. Giới hạn, đều in ở đầu tệp script:
- **`singleValue` bị vẽ thành đường** (API chỉ vẽ `timeSeries`, bar, pie): hai ô cờ / 1.000 giao dịch ra đồ thị theo khung chụp, tiêu đề thêm « (đồ thị trong khung chụp)». Ô số thật chỉ xem trên console (BL-404).
- **`period` lớn hơn khung chụp bị hạ** về `floor(khung / 60) * 60` (cả ở thuộc tính `period` lẫn ở đối số chu kỳ của `SEARCH`), tiêu đề thêm « (period X → Y giây theo khung chụp)»; ví dụ xu hướng 3600 s trong khung 15 phút.
- **`text` và `alarm` không vẽ được** bằng API: in `SKIP`; ảnh của chúng chụp từ console (BL-262).
- Ảnh CloudWatch vẽ chữ báo lỗi hoặc không có dữ liệu vẫn là PNG hợp lệ: **mở ảnh xem**. Cảnh báo `invalid input` trên stderr không làm thất bại khi ảnh đúng chữ ký PNG.
- Mọi chữ in ra được che ARN và ID tài khoản. Trên Windows `aws.exe` cần đường dẫn dạng `C:/...`; AWS CLI v2 đọc `file://` bằng cp1252 nên công cụ ghi tệp MetricWidget **thuần ASCII** (`\uXXXX`), nếu không tiêu đề tiếng Việt báo «Unable to load paramfile» (gặp khi thử thật).

**Ảnh lúc chạy tải 120 RPS (DBS-178, chụp ngày 2026-11-22 trên stack thật của phiên DBS-167).** Hai thư mục, mỗi thư mục 25 PNG (một PNG cho mỗi widget metric, đúng `NN-<tiêu đề>.png` của công cụ; 8 widget `text` và `alarm` bị `SKIP` theo thiết kế, 0 lỗi), vẽ bằng `get-metric-widget-image` (không phải ảnh console):

| Thư mục | Khung chụp (UTC) | Lượt tải (k6, kịch bản `redis-fault`, 120 RPS) | Số liệu k6 và báo cáo |
|---|---|---|---|
| [`screenshots/120rps-redis-on/`](screenshots/120rps-redis-on/) | 2026-11-22 00:05:00 đến 00:21:00 | Redis bật (đối chứng), 00:04:52 đến 00:20:11 | `docs/components/load-tests/05-ket-qua-redis-2026-11-22.md` §3 (PR DBS-167, chưa có trên nhánh này) |
| [`screenshots/120rps-redis-off/`](screenshots/120rps-redis-off/) | 2026-11-22 00:38:00 đến 00:56:00 | Redis tắt: NACL chặn 6379 từ 00:44:00 đến 00:49:02, 00:38:52 đến 00:54:12 | cùng báo cáo, §3 và §4.1 |

Ảnh tiêu biểu (đọc từ đồ thị, số gần đúng):

- Lưu lượng: `04-luu-luong-request-moi-giay.png` ở [Redis bật](screenshots/120rps-redis-on/04-luu-luong-request-moi-giay.png) phẳng 120 request/giây từ 00:05 đến 00:18 (đường 120); điểm cuối giảm (bucket cuối), chưa giải thích được.
- Health: `01-health-probe-health-ready-request-va-5xx.png`, [Redis bật](screenshots/120rps-redis-on/01-health-probe-health-ready-request-va-5xx.png) và [Redis tắt](screenshots/120rps-redis-off/01-health-probe-health-ready-request-va-5xx.png): 70 đến 75 request mỗi phút, 5xx = 0 ở cả hai lượt, **kể cả lúc Redis chết**.
- Redis: [`14-redis-fallback.png` lượt tắt](screenshots/120rps-redis-off/14-redis-fallback.png): api lên khoảng 16.000 mỗi điểm 60 giây (widget `period 60`) và worker khoảng 2.900 đúng cửa sổ sự cố 00:44 đến 00:49, về 0 từ 00:50; [lượt bật](screenshots/120rps-redis-on/14-redis-fallback.png) ≈ 0 (api 1 đến 3 mỗi điểm, worker tới 33 ở điểm đầu): không tuyệt đối 0 vì `/health/ready` ping Redis và có vài `TIMEOUT` lẻ. **Redis chết chỉ thấy ở `redis_fallback_total`, không ở probe**, đúng ghi chú «Cách đọc».
- Hàng đợi: [`09-do-sau-hang-doi-chinh-...png` lượt bật](screenshots/120rps-redis-on/09-do-sau-hang-doi-chinh-cho-xu-ly-va-dang-xu-ly.png) và [lượt tắt](screenshots/120rps-redis-off/09-do-sau-hang-doi-chinh-cho-xu-ly-va-dang-xu-ly.png): 0 đến 15 message, tăng giảm rồi về 0 (consumer theo kịp); DLQ (`12-dlq-so-message.png`) luôn 0 ở cả hai lượt.
- Độ trễ chuyển tiền: [`02-chuyen-tien-...png` lượt bật](screenshots/120rps-redis-on/02-chuyen-tien-post-v1-transfers-p95-va-p99-ms.png) p95 ≈ 95 đến 105 ms, p99 ≈ 300 đến 520 ms; [lượt tắt](screenshots/120rps-redis-off/02-chuyen-tien-post-v1-transfers-p95-va-p99-ms.png) p95 ≈ 145 đến 275 ms, p99 chạm đường 1 s (≈ 1.020 ms ở điểm 00:40 phần lớn là trước sự cố; phân vị CloudWatch là ước lượng quanh biên bucket 1000 ms). Đây là số **phía máy chủ** theo bucket 5 phút, khác số k6 phía máy khách ở báo cáo tải.
- Fraud: `22-risk-quyet-dinh-...png` (`DISABLED` ≈ 6.600 đến 7.300 mỗi 5 phút), cờ / 1.000 giao dịch bằng 0 và thời gian giao dịch → cờ không có điểm (tải tổng hợp không sinh cờ). `19-...xu-huong...png` có tiêu đề « (period 3600 → 960 giây theo khung chụp)» vì khung 16 phút ngắn hơn 3600 s.

Các lần kêu alarm thật nằm ở `docs/components/load-tests/results/redis-evidence/alarm-history.txt` (nhánh DBS-167): `dbs-dev-risk-config-redis-fallback` kêu và hết vài lần, `dbs-dev-outbox-age` kêu lúc worker chưa chạy rồi hết, các alarm latency, 5xx và rate-limited giữ OK. `dbs-dev-redis-fallback` chuyển OK → ALARM lúc 06:59:53 +07 (= 23:59:53 UTC ngày 21), **trước** lượt đối chứng và trước lúc tiêm sự cố (00:44:00 UTC), và không có dòng ALARM → OK sau đó: nên lần kêu này **không** phải do lượt Redis tắt đã chụp, nguyên nhân chưa xác định; đừng dùng làm bằng chứng «alarm kêu đúng lúc Redis tắt».

Đã thử riêng trên CloudWatch thật (chỉ đọc, DBS-178 M-178-03, khung không có tải): 25/25 widget metric của body Terraform được `get-metric-widget-image` chấp nhận (cú pháp `PERIOD`, `SEARCH`, dimension); ba ảnh mẫu không dữ liệu ở [`docs/features/screenshots/DBS-178/`](../../features/screenshots/DBS-178/). **Chưa có:** ảnh console AWS của widget `alarm`, của hai ô `singleValue` và của bố cục (phiên tự động không có màn hình): BL-262, BL-404.

## Alarm CloudWatch (BL-051, BL-117, BL-127, BL-179, BL-181, BL-182)

22 alarm (bổ sung 4 alarm SLO ở [DBS-177](../../features/DBS-177-slo-alarms.md) và alarm cờ/1.000 giao dịch ở [DBS-188](../../features/DBS-188-flag-rate-alarm.md)), dựng bằng Terraform, mọi alarm gửi vào topic SNS `dbs-dev-alarms` (ở `base`, email xác nhận một lần, biến `alarm_email`) cả khi báo và khi hết. Bốn alarm DLQ (`dlq-not-empty` và `dlq-oldest-age` cho `risk` và `notification`) ở `envs/dev/base/alarms.tf` (sống qua `destroy` session, như chính DLQ; hai alarm `dlq-oldest-age` có trong code nhưng chưa apply ở base), mười tám alarm còn lại ở `envs/dev/session/alarms.tf` (dựng và xóa cùng phiên). **Mới `dbs-dev-risk-flag-rate` đã kích hoạt thử trên AWS thật** (DBS-188 §8); các alarm khác chưa: Terraform đã được kiểm bằng `terraform test` với provider giả (đúng namespace, dimension, ngưỡng, cửa sổ, hành động), còn việc kích hoạt từng alarm trên AWS thật vẫn mở (BL-051, BL-161, BL-341).

| Alarm | Metric (namespace, dimension) | Điều kiện | Cửa sổ · missing data | Vì sao |
|---|---|---|---|---|
| `dbs-dev-risk-dlq-not-empty`, `dbs-dev-notification-dlq-not-empty` (base) | `AWS/SQS` `ApproximateNumberOfMessagesVisible`, `QueueName` = DLQ | Maximum > 0 | 60 s × 1 · `notBreaching` | SLO DLQ = 0. Message trong DLQ không tự mất nên một điểm đủ; alarm giữ ALARM tới khi redrive/xóa. SQS ngừng phát số đo queue rảnh > 6 giờ |
| `dbs-dev-risk-events-age`, `dbs-dev-notification-events-age` | `AWS/SQS` `ApproximateAgeOfOldestMessage`, `QueueName` = queue chính | Maximum > 120 | 60 s × 1 · `notBreaching` | SLO < 60 s, alarm 120 s (docs/03 §14, DBS-163): consumer không theo kịp hoặc worker treo. Message độc vào DLQ sau ≈ 80 s nên không tự kích alarm này |
| `dbs-dev-outbox-age` (BL-182) | `DBS/Backend` `outbox_oldest_unpublished_age_seconds`, không dimension (gauge) | Maximum > 30 | 60 s, **3 trong 5 điểm** · `breaching` | SLO < 10 s, alarm 30 s. Một lô relay bình thường kéo dài tới 25 s (15 s ngân sách + 2 lần gửi 5 s, DBS-91 §2.8) và các dòng của lô còn `published_at IS NULL` tới COMMIT, nên một điểm > 30 s ở worker khỏe là có thể; relay kẹt (lỗi UPDATE/COMMIT lặp, gửi lại cả lô mỗi 5 s, §2.9) thì tuổi chỉ tăng nên ở mọi điểm sau đều > 30 s. Thiếu dữ liệu = worker chết (gauge báo 0 khi không có gì chờ). 3/5 chịu được lúc ECS thay task worker (0%/100%, `stopTimeout` 60 s) và một phút trống do lệch nhịp flush 60 s. **Độ trễ phát hiện cỡ 3 phút**, không phải 30 s |
| `dbs-dev-outbox-quarantined` (BL-181) | `DBS/Backend` `outbox_quarantined_events`, không dimension (gauge) | Maximum > 0 | 300 s × 1 · **`ignore`** | Một sự kiện bị cách ly là một giao dịch hoặc đổi trạng thái tài khoản không bao giờ tới consumer, nên một điểm là đủ. Gauge giữ > 0 tới khi người vận hành đưa lại hàng đợi (runbook README outbox), nên alarm không nhấp nháy. `ignore` giữ nguyên trạng thái khi mất số đo: `breaching` trùng alarm tuổi outbox khi worker chết, `notBreaching` đưa alarm đang kêu về OK chỉ vì worker khởi động lại |
| `dbs-dev-risk-config-invalid` (BL-051, BL-188 `aiConfigInvalid`) | `DBS/Backend` `risk_decision_total`, `{Role=worker, AiStatus=CONFIG_INVALID}` | Sum > 0 | 300 s × 1 · `notBreaching` | Khối `ai.*` hỏng lọt tới consumer: risk lưu `CONFIG_INVALID` và vẫn chấm R1-R6, không vào DLQ, nên không có tín hiệu nào khác |
| `dbs-dev-risk-rule-error` (BL-051) | `DBS/Backend` `risk_rule_error_total`, `{Role=worker, Rule=R1..R6}`: 6 metric khai tường minh, `SUM(METRICS())` | > 0 | 300 s × 1 · `notBreaching` | Lỗi luật rollback, retry, vào DLQ sau ≈ 80 s; một lỗi tất định đưa mọi event vào DLQ nên alarm này báo sớm hơn và cho biết Rule. Alarm không dùng được `SEARCH`, và counter chỉ có bộ `[Role, Rule]` (không có bộ tổng) nên phải gộp bằng metric math |
| `dbs-dev-risk-flag-rate` (DBS-188, BL-340) | `DBS/Backend` `risk_flag_total` (`f`) và `risk_decision_total` (`d`), cùng `{Role=worker}` (bộ `[Role]`, DBS-187) | `IF(d >= 1000, 1000 * FILL(f, 0) / d, 0)` > 20 | **86400 s × 1** · `notBreaching` | SLO ≤ 20 cờ / 1.000 giao dịch, 24 giờ trượt, chỉ khi có ≥ 1.000 giao dịch (docs/03 §14, NFR-FRD-02). Một chu kỳ 86400 s là một bucket bắt đầu tại «bây giờ − 24 giờ» nên mỗi lần đánh giá là tổng 24 giờ gần nhất. Giới hạn nói thẳng: đo **tỉ lệ 24 giờ**, không phải bùng phát ngắn (mẫu số lớn pha loãng); giữ ALARM tới khi đợt cờ ra khỏi 24 giờ; dưới 1.000 giao dịch trong 24 giờ không bao giờ báo; chỉ `Role=worker`; không có alarm theo mức hay mode (cần bộ dimension mới) |
| `dbs-dev-reconciliation-failed` (BL-127, DBS-123) | `DBS/Backend` `reconciliation_runs_total`, `{Role=worker, Status=MISMATCH}` và `{…, Status=ERROR}`, `SUM(METRICS())` | > 0 | 300 s × 1 · `notBreaching` | SLO 0 lệch, báo `MISMATCH` hoặc `ERROR` trong 5 phút (metric ghi tối đa 60 s sau lần chạy, alarm đánh giá mỗi phút). Điều kiện: job chạy mỗi 60 s (`reconciliation_interval_ms` ở `session/worker.tf`; mặc định ứng dụng 300 s quá chậm). Mỗi lượt còn có một dòng log `info` `reconciliation_run` (status, `durationMs`, `mismatchedAccounts`). Không bắt: lỗi trước khi giữ khóa advisory (DB không nối được) và job ngừng chạy (BL-275) `OK` không tham gia |
| `dbs-dev-redis-node-missing` (BL-117) | `AWS/ElastiCache` `CPUUtilization`, `CacheClusterId` = `dbs-dev-001` | Average > 100 (không bao giờ xảy ra với số đo thật) | 60 s × 2 · **`breaching`** | "Redis không truy cập được > 1 phút" (docs/03 §14): node chết, failover hoặc bị thay thì ElastiCache ngừng phát số đo, hai phút liền không có điểm là alarm. Heartbeat, không phải cảnh báo CPU. Lúc dựng phiên có thể kêu một lần tới khi Valkey phát điểm đầu tiên |
| `dbs-dev-redis-fallback` (BL-117, BL-179) | `DBS/Backend` `redis_fallback_total`, `{Role=api}` và `{Role=worker}`, `SUM(METRICS())` | Sum > 0 | 60 s, **2 trên 2** · `notBreaching` | Phát hiện ứng dụng không với tới Redis dù node còn sống (SG, AUTH, TLS, mạng). Bình thường bằng 0 và một lần chớp chỉ tạo vài lần đếm, nên đòi hai phút liên tiếp (> 1 phút), không phải một lần |
| `dbs-dev-risk-config-redis-fallback` (BL-235) | `DBS/Backend` `risk_config_redis_fallback_total`, `{Role=worker}` | Sum > 0 | 60 s, 2 trên 2 · `notBreaching` | Cache cấu hình luật lỗi nên risk đọc DB: vẫn đúng, chậm hơn. Cùng quy tắc với alarm trên |
| `dbs-dev-risk-config-freshness` (BL-188) | `DBS/Backend` `risk_config_freshness_exceeded_total`, `{Role=worker}` | Sum > 0 | 300 s × 1 · `notBreaching` | Giả định của bound 60 s chọn phiên bản luật ([bugfix](../../features/BUG-20261109-risk-config-freshness.md) §2) không còn đứng: SQL đọc phiên bản ≥ 60 s hoặc đồng hồ local/Redis lùi hay lệch. **Không có metric lệch giờ trực tiếp** (Fargate và ElastiCache dùng Amazon Time Sync Service), nên đồng hồ chỉ bị bắt khi nó làm hỏng một lần chọn. Redis sống/lỗi đã có ba alarm ở trên; CPU/bộ nhớ Valkey không alarm vì key `latest:v2` mất chỉ làm worker đọc DB. Runbook [risk-config-rollout](../../runbooks/risk-config-rollout.md) |
| `dbs-dev-rate-limited` (BL-179) | `DBS/Backend` `rate_limited_total`, `{Role=api, Scope=ip}` và `{…, Scope=user}`, `SUM(METRICS())` | Sum > **50** | 300 s × 1 · `notBreaching` | Khách thật hiếm khi chạm giới hạn; số lớn là tấn công, script lỗi hoặc `TRUST_PROXY_HOPS` sai (mọi khách chung một IP của ALB). **Ngưỡng 50 mỗi 5 phút là ước lượng cho dev, chưa đo**; đổi sau lần chạy tải đầu. Test tải (BL-232) sẽ làm nó kêu |
| `dbs-dev-api-5xx-rate` (DBS-177) | `DBS/Backend` `http_5xx_total`, `http_requests_total` (bộ `[]`, loại `/health/*`) | `IF(mr > 0, 100 * FILL(m5, 0) / mr, 0)` > 1% | 300 s × 1 · `notBreaching` | SLO ≥ 99,9% (docs/03 §14), không tính 422/429. `IF(mr > 0, ...)` tránh chia 0 |
| `dbs-dev-transfer-latency-p95` (DBS-177) | `DBS/Backend` `http_request_duration_ms`, `{Route="/v1/transfers", Method="POST"}` | p95 > 300 ms | 300 s, **3 trên 3** · `notBreaching` | SLO p95 < 300 ms (docs/03 §14); 3 cửa sổ liên tiếp tránh sai số ước lượng quanh biên bucket 300 ms |
| `dbs-dev-read-latency-p95` (DBS-177) | `DBS/Backend` `http_request_duration_ms`, `GET` 3 route đọc (`/v1/accounts`, `/:id`, `/:id/transactions`) | `MAX(METRICS())` (p95) > 150 ms | 300 s, **3 trên 3** · `notBreaching` | SLO đọc p95 < 150 ms (docs/03 §14); gộp 3 route đọc bằng `MAX(METRICS())` |
| `dbs-dev-transfer-to-flag-p95` (DBS-177) | `DBS/Backend` `risk_transfer_to_flag_ms`, `{Role=worker}` | p95 > 5000 ms | 900 s × 1 · `notBreaching` | SLO thời gian giao dịch → cờ < 5 giây trong 15 phút (docs/03 §14) |

**Quy ước chung.**
- Metric đếm sự kiện (lỗi luật, `CONFIG_INVALID`, đối soát, rate limit) chỉ có điểm khi sự kiện xảy ra: cửa sổ 300 s giữ alarm ở ALARM thêm vài phút. Thư **OK nghĩa là "5 phút qua không có sự kiện mới", không phải "đã xử lý xong"**; trạng thái thật nằm ở DLQ, `reconciliation_runs`, log.
- `treat_missing_data = breaching` chỉ ở hai alarm có nghĩa "không có số đo = hệ thống không chạy" (outbox, node Valkey). Hệ quả: dựng session với `worker_desired_count = 0` làm `dbs-dev-outbox-age` kêu sau ≈ 3 phút.
- Chi phí: alarm chuẩn 0,10 USD/alarm/tháng; alarm biểu thức metric tính theo số metric tham chiếu (lỗi luật và tỉ lệ fallback AI mỗi cái 6, latency đọc 3, đối soát, Redis fallback, rate limit, tỉ lệ 5xx, cờ/1.000 giao dịch mỗi cái 2). Ước ≈ 3,9 USD/tháng nếu chạy cả tháng (0,40 USD của bốn alarm DLQ chạy luôn ở base: `dlq-not-empty` và `dlq-oldest-age` cho `risk` và `notification`); alarm session tính theo giờ.
- Alarm `dbs-dev-risk-ai-fallback-rate` (RSK-04): tính `100 * fb_sum / (SUCCEEDED + fb_sum)` trên `risk_decision_total{Role="worker"}` bằng `SUM(METRICS("fb_"))` (5 trạng thái fallback, bỏ qua `DISABLED`), ngưỡng mặc định `> 10%` trong 5 phút, chỉ tính khi có từ 5 quyết định gọi AI trở lên (tránh 1/1 = 100%).
- Hàng cuối của bảng docs/03 §14 (> 20 cảnh báo gian lận trên 1.000 giao dịch) có alarm `dbs-dev-risk-flag-rate` (DBS-188), đọc `risk_flag_total` và mẫu số `risk_decision_total` ở bộ `[Role]` của DBS-187; dashboard `dbs-dev-overview` vẽ cùng tỉ lệ (ô số 1 giờ và 24 giờ, xu hướng, theo mức và phần AI). `risk_redis_fallback_total{Role,Rule,Reason}` chưa có alarm (chưa có chỗ nào phát metric này).
- Bốn alarm risk của DoD DBS-188 nằm ở ba chỗ: cờ/1.000 giao dịch (mới, `dbs-dev-risk-flag-rate`), `ai_status = CONFIG_INVALID` (`dbs-dev-risk-config-invalid`), tỉ lệ fallback AI (`dbs-dev-risk-ai-fallback-rate`), DLQ `risk-events-dlq` (`dbs-dev-risk-dlq-not-empty`, base).
- **Số tổng hợp trong `DBS/Backend` (BL-410, đã đóng 2026-11-22):** các lần thử của DBS-187 để lại số tổng hợp `Role=worker` (940 quyết định và 249 cờ ngày 21/11/2026). Kiểm lúc 02:24 giờ +07 ngày 22/11: số mô phỏng đã ra khỏi cửa sổ 24 giờ; trong cửa sổ có `risk_decision_total{Role=worker}` thật từ các lượt đo tải (≈ 300.000) và `risk_flag_total{Role=worker}` **không có điểm dữ liệu nào** (tỉ lệ cờ 0%), nên `dbs-dev-risk-flag-rate` dựng thật không kêu giả. Quy tắc còn hiệu lực: không đẩy số mô phỏng vào `DBS/Backend`, dùng namespace tạm như DBS-188; dữ liệu của lượt tải thật là dữ liệu thật và có thể làm alarm kêu đúng.
- Tên metric mới của risk (`risk_decision_total`, `risk_rule_error_total`, `reconciliation_runs_total`, `risk_transfer_to_flag_ms`) là hợp đồng với phía ứng dụng: alarm khai dimension `Role` + nhãn như trên; nếu ứng dụng đổi bộ dimension thì alarm phải đổi theo (test `alarms.tftest.hcl` ghi lại bộ dimension mong đợi).

## Ngoài phạm vi (v1)

- Tracing phân tán đầy đủ.
- APM thương mại.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §14 Quan sát và SLI/SLO.
- Nghiệp vụ, yêu cầu và mô hình miền: [docs/BRD.md](../../BRD.md).
- Giao diện và mốc: Task 8 của roadmap cũ (đã xóa); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md). Thiết kế chi tiết nằm ở các mục docs/03 nêu trên (không có file 02 riêng).
