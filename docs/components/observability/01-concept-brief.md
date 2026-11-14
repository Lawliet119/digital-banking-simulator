# observability — Concept Brief

> **Status:** Draft · **Owner:** #5 (dashboard, alarm; metric do Dev phát) · **Verified against code:** một phần: log JSON có `correlationId` (DBS-42); metric HTTP, tuổi outbox và counter `redis_fallback_total`, `rate_limited_total` xuất bằng CloudWatch EMF trong `common/metrics` (DBS-144, kiểm bằng test và **kiểm trên CloudWatch thật ngày 2026-11-09**, xem «Kết quả kiểm trên CloudWatch»). Dashboard `dbs-dev-overview` dựng bằng Terraform (DBS-145, kiểm trên CloudWatch thật bằng số mô phỏng, xem «Dashboard»). Alarm CloudWatch dựng bằng Terraform (`base/alarms.tf`, `session/alarms.tf`), kiểm bằng `terraform test` với provider giả, **chưa kích hoạt thử trên AWS thật**; dashboard `dbs-dev-infra` (ECS, ALB, RDS, Valkey) cũng chưa kiểm trên CloudWatch thật. Chưa có: metric của AI (BL-204) · **Cập nhật:** 2026-11-14

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

- Log JSON có `correlationId` ở mọi dòng. Một hàm bind chung (`runInLogContext`, `common/logging/log-context.ts`) gắn `role` và `correlationId` đúng một lần cho HTTP, consumer và tác vụ nền (`role=worker` kể cả trong `APP_ROLE=both`); binding do code khác tạo bị khử trùng khoá và che dữ liệu nhạy cảm; `PinoLogger` và `req.log` bị ESLint chặn ngoài module logging (BL-024). Lỗi nội bộ Nest/TypeORM chỉ ghi nguyên văn các thông điệp cố định trong allowlist theo `context`, và cảnh báo `process.emitWarning` đi qua logger JSON (BL-026). Chi tiết: [DBS-42](../../features/DBS-42-json-logger.md), `backend/README.md` §8.
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
| `risk_redis_fallback_total` | Count | `Role`, `Rule`, `Reason` | `RiskMetrics`; **chưa có chỗ nào gọi `.redisFallback(`**: chờ consumer chấm điểm nối đủ (BL-204) · worker |
| `risk_decision_total` | Count | `Role`, `AiStatus` | `risk-scoring.metrics.ts`: +1 mỗi quyết định ghi bởi lần giao thắng claim (BL-204) · worker |
| `risk_rule_error_total` | Count | `Role`, `Rule` (`R1`..`R6`) | `ScoringService`: +1 mỗi lần một luật ném lỗi hoặc trả kết quả sai, mỗi lần nhận của message (BL-207 f, BL-046) · worker |
| `risk_transfer_to_flag_ms` | Milliseconds (mảng mẫu, biên trên bucket) | `Role` | `MetricsService.recordDistribution`; `fraud_flags.created_at − transfers.created_at` của cờ vừa ghi, SLO p95 < 5 giây (docs/03 §14) · worker |
| `risk_ai_call_duration_ms` | Milliseconds (mảng mẫu) | `Role` | `recordDistribution` quanh `RiskAiService.evaluate` (cổng + gọi provider), kể cả khi `UNAVAILABLE`; không có mẫu khi `rule_only` hoặc `CONFIG_INVALID` · worker |
| `reconciliation_runs_total` | Count | `Role`, `Status` (`OK`/`MISMATCH`/`ERROR`) | `ReconciliationService.reconcileOnce`: +1 mỗi lượt đã ghi `reconciliation_runs` (lượt không giành được khóa thì không tính) (BL-127) · worker |
| `consumer_message_total` | Count | `Role`, `Consumer` (`risk`, `notification`, ...), `Outcome` (`retry`/`dead_letter`) | `ConsumerBase.handle` (`consumer.metrics.ts`): +1 mỗi quyết định retry hoặc dead-letter, cùng lúc với một dòng log có `consumer`, `eventId`, `receiveCount` (BL-209). Chưa có alarm riêng: DLQ không rỗng đã có alarm · worker |
| `outbox_oldest_unpublished_age_seconds` | Seconds | không | gauge `OutboxAgeGauge`, mỗi lượt ghi; **không tính dòng đã bị cách ly** (BL-181) · worker |
| `outbox_quarantined_events` | Count | không | gauge `OutboxQuarantineGauge`: số dòng `quarantined_at IS NOT NULL AND published_at IS NULL`, 0 khi không có (BL-181) · worker |

**Giá trị `AiStatus`** là đúng giá trị `risk_decisions.ai_status`: `DISABLED` (cũng là giá trị của quyết định `rule_only`, tức "không yêu cầu AI"), `CONFIG_INVALID`, `SUCCEEDED`, `REFUSED`, `INVALID_RESPONSE`, `UNAVAILABLE`, `BUDGET_EXHAUSTED`; giá trị lạ thành `unknown`. **Tỉ lệ fallback baseline không có metric riêng**: là tổng `risk_decision_total` của các `AiStatus` khác `DISABLED` và `SUCCEEDED`, chia tổng mọi `AiStatus` (cùng `Role`). `risk_redis_fallback_total` vẫn **chưa có chỗ nào gọi** (`OnlineFeatureProvider` chưa nhận `RiskMetrics`): còn mở.

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
- **Bộ dimension thật của counter.** `MetricsService.writeCounters` xuất mỗi counter ở **một** bộ `[Role, ...nhãn]` (không có bộ `[]`, không có bộ chỉ `Role` khi counter có thêm nhãn); chỉ HTTP và gauge mới có bộ tổng/`[]`. Alarm phải khai đúng bộ đó (ví dụ `risk_decision_total` là `{Role, AiStatus}`), nếu không không bao giờ có dữ liệu.

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

## Dashboard (DBS-145)

`infra/terraform/envs/dev/session/dashboard.tf` dựng dashboard **`dbs-dev-overview`** cùng phiên (`terraform apply` / `destroy` của `session`, hoặc `-target=aws_cloudwatch_dashboard.overview`: dashboard không tham chiếu tài nguyên nào khác của session). Output `dashboard_url`. 16 widget (1 văn bản, 15 metric; ba widget cuối ở hàng 7 là đối soát, CONFIG_INVALID và lỗi luật, thời gian tới cờ), khoảng thời gian mặc định 3 giờ, `periodOverride = inherit` để cửa sổ 5 phút của widget không bị console tính lại:

| Hàng | Widget | Nguồn · đường kẻ ngang (SLO docs/03 §14) |
|---|---|---|
| 2 | Độ trễ toàn dịch vụ p50/p95/p99 (tổng quan, không đường SLO); chuyển tiền `POST /v1/transfers` p95/p99 | `[]`, `[Route,Method]` · 300 ms, 1 s |
| 3 | Đọc p95 (`GET /v1/accounts`, `/:id`, `/:id/transactions`); tỉ lệ 5xx %; request, 5xx, bị ngắt | 150 ms · `100 * FILL(5xx,0) / request`, 1% |
| 4 | p95 theo Route (`SEARCH`, loại `/health/*`); tuổi outbox (`Maximum`); DLQ | 10 s và 30 s; DLQ > 0 |
| 5 | Tuổi message cũ nhất; `redis_fallback_total` (`Role` api, worker); `rate_limited_total` (`Scope` ip, user) | 60 s và 120 s |
| 6 | Fallback Redis của risk (`SEARCH`) | trống tới khi có nguồn (BL-204) |
| 7 | Đối soát sổ cái theo `Status` (OK, MISMATCH, ERROR); `risk_decision_total{AiStatus=CONFIG_INVALID}` và `risk_rule_error_total` (`SEARCH`); `risk_transfer_to_flag_ms` p95 | MISMATCH/ERROR > 0; > 0; 5 s (chưa có alarm cho p95) |

**Dashboard hạ tầng `dbs-dev-infra` (BL-261)**, `session/dashboard_infra.tf`, tách riêng vì widget ALB cần `arn_suffix` của `aws_lb` và target group (không dựng được từ chuỗi biết trước): nó tham chiếu tài nguyên session nên `-target` nó kéo cả ALB lên, còn `overview` giữ tính chất không tham chiếu. 10 widget (1 văn bản, 9 metric), toàn số đo gốc miễn phí của AWS:

| Hàng | Widget | Nguồn |
|---|---|---|
| 1 | CPU ECS (`api`, `worker`); bộ nhớ ECS; số task api khỏe và không khỏe | `AWS/ECS` (ClusterName `dbs-dev`, ServiceName); `AWS/ApplicationELB` `HealthyHostCount`, `UnHealthyHostCount` |
| 2 | Số 5xx ở ALB (do ALB, do app); tỉ lệ 5xx % = (hai loại) / `RequestCount`, đường 1%; kết nối RDS | `AWS/ApplicationELB`; `AWS/RDS` `DatabaseConnections` |
| 3 | CPU RDS; CPU Valkey (máy và engine); bộ nhớ % và kết nối Valkey | `AWS/RDS`; `AWS/ElastiCache` `CacheClusterId` = `dbs-dev-001` |

Giới hạn: **không có số task đang chạy của ECS** (`RunningTaskCount` thuộc `ECS/ContainerInsights`, Container Insights đang `disabled` ở `ecs.tf` và bật là tốn tiền theo task), nên task api đếm bằng `HealthyHostCount` và worker chỉ nhìn được qua tuổi outbox (không có điểm = không chạy). Tỉ lệ 5xx ở ALB tính cả probe `/health/*` và 5xx do ALB sinh, nên không bằng tỉ lệ ở `overview` (chỉ request ứng dụng).

Đường kẻ chỉ để nhìn, không phải alarm (alarm ở mục dưới). Biến `metrics_namespace` (mặc định `DBS/Backend`) chỉ đổi khi thử dashboard bằng số mô phỏng. Ảnh chụp lúc có tải nhẹ: [tổng hợp 12 widget](../../features/screenshots/DBS-145/00-dashboard-overview.png) và từng widget ở [`screenshots/DBS-145/`](../../features/screenshots/DBS-145/). **Đó là số mô phỏng** (30 phút EMF do chính mã `common/metrics` sinh, namespace `DBS/Backend-dbs145`, không phải app chạy trên ECS), ảnh render bằng `GetMetricWidgetImage`, không phải màn hình console; chi tiết và số đối chiếu ở [DBS-145](../../features/DBS-145-cloudwatch-dashboard.md) §8. Đọc ảnh: p95 chuyển tiền nằm sát đường 300 ms vì CloudWatch ước lượng phân vị quanh biên bucket (xem «Bàn giao cho #5»), không phải vi phạm SLO.

## Alarm CloudWatch (BL-051, BL-117, BL-127, BL-179, BL-181, BL-182)

14 alarm, dựng bằng Terraform, mọi alarm gửi vào topic SNS `dbs-dev-alarms` (ở `base`, email xác nhận một lần, biến `alarm_email`) cả khi báo và khi hết. Hai alarm DLQ ở `envs/dev/base/alarms.tf` (sống qua `destroy` session, như chính DLQ), mười hai alarm còn lại ở `envs/dev/session/alarms.tf` (dựng và xóa cùng phiên). **Chưa kích hoạt thử trên AWS thật**: Terraform đã được kiểm bằng `terraform test` với provider giả (đúng namespace, dimension, ngưỡng, cửa sổ, hành động), còn việc đẩy một message vào DLQ, ép lỗi luật, dừng worker, chặn Redis để xem alarm kêu thật vẫn mở (BL-051, BL-161).

| Alarm | Metric (namespace, dimension) | Điều kiện | Cửa sổ · missing data | Vì sao |
|---|---|---|---|---|
| `dbs-dev-risk-dlq-not-empty`, `dbs-dev-notification-dlq-not-empty` (base) | `AWS/SQS` `ApproximateNumberOfMessagesVisible`, `QueueName` = DLQ | Maximum > 0 | 60 s × 1 · `notBreaching` | SLO DLQ = 0. Message trong DLQ không tự mất nên một điểm đủ; alarm giữ ALARM tới khi redrive/xóa. SQS ngừng phát số đo queue rảnh > 6 giờ |
| `dbs-dev-risk-events-age`, `dbs-dev-notification-events-age` | `AWS/SQS` `ApproximateAgeOfOldestMessage`, `QueueName` = queue chính | Maximum > 120 | 60 s × 1 · `notBreaching` | SLO < 60 s, alarm 120 s (docs/03 §14, DBS-163): consumer không theo kịp hoặc worker treo. Message độc vào DLQ sau ≈ 80 s nên không tự kích alarm này |
| `dbs-dev-outbox-age` (BL-182) | `DBS/Backend` `outbox_oldest_unpublished_age_seconds`, không dimension (gauge) | Maximum > 30 | 60 s, **3 trong 5 điểm** · `breaching` | SLO < 10 s, alarm 30 s. Một lô relay bình thường kéo dài tới 25 s (15 s ngân sách + 2 lần gửi 5 s, DBS-91 §2.8) và các dòng của lô còn `published_at IS NULL` tới COMMIT, nên một điểm > 30 s ở worker khỏe là có thể; relay kẹt (lỗi UPDATE/COMMIT lặp, gửi lại cả lô mỗi 5 s, §2.9) thì tuổi chỉ tăng nên ở mọi điểm sau đều > 30 s. Thiếu dữ liệu = worker chết (gauge báo 0 khi không có gì chờ). 3/5 chịu được lúc ECS thay task worker (0%/100%, `stopTimeout` 60 s) và một phút trống do lệch nhịp flush 60 s. **Độ trễ phát hiện cỡ 3 phút**, không phải 30 s |
| `dbs-dev-outbox-quarantined` (BL-181) | `DBS/Backend` `outbox_quarantined_events`, không dimension (gauge) | Maximum > 0 | 300 s × 1 · **`ignore`** | Một sự kiện bị cách ly là một giao dịch hoặc đổi trạng thái tài khoản không bao giờ tới consumer, nên một điểm là đủ. Gauge giữ > 0 tới khi người vận hành đưa lại hàng đợi (runbook README outbox), nên alarm không nhấp nháy. `ignore` giữ nguyên trạng thái khi mất số đo: `breaching` trùng alarm tuổi outbox khi worker chết, `notBreaching` đưa alarm đang kêu về OK chỉ vì worker khởi động lại |
| `dbs-dev-risk-config-invalid` (BL-051, BL-188 `aiConfigInvalid`) | `DBS/Backend` `risk_decision_total`, `{Role=worker, AiStatus=CONFIG_INVALID}` | Sum > 0 | 300 s × 1 · `notBreaching` | Khối `ai.*` hỏng lọt tới consumer: risk lưu `CONFIG_INVALID` và vẫn chấm R1-R6, không vào DLQ, nên không có tín hiệu nào khác |
| `dbs-dev-risk-rule-error` (BL-051) | `DBS/Backend` `risk_rule_error_total`, `{Role=worker, Rule=R1..R6}`: 6 metric khai tường minh, `SUM(METRICS())` | > 0 | 300 s × 1 · `notBreaching` | Lỗi luật rollback, retry, vào DLQ sau ≈ 80 s; một lỗi tất định đưa mọi event vào DLQ nên alarm này báo sớm hơn và cho biết Rule. Alarm không dùng được `SEARCH`, và counter chỉ có bộ `[Role, Rule]` (không có bộ tổng) nên phải gộp bằng metric math |
| `dbs-dev-reconciliation-failed` (BL-127, DBS-123) | `DBS/Backend` `reconciliation_runs_total`, `{Role=worker, Status=MISMATCH}` và `{…, Status=ERROR}`, `SUM(METRICS())` | > 0 | 300 s × 1 · `notBreaching` | SLO 0 lệch, báo `MISMATCH` hoặc `ERROR` trong 5 phút (metric ghi tối đa 60 s sau lần chạy, alarm đánh giá mỗi phút). `OK` không tham gia |
| `dbs-dev-redis-node-missing` (BL-117) | `AWS/ElastiCache` `CPUUtilization`, `CacheClusterId` = `dbs-dev-001` | Average > 100 (không bao giờ xảy ra với số đo thật) | 60 s × 2 · **`breaching`** | "Redis không truy cập được > 1 phút" (docs/03 §14): node chết, failover hoặc bị thay thì ElastiCache ngừng phát số đo, hai phút liền không có điểm là alarm. Heartbeat, không phải cảnh báo CPU. Lúc dựng phiên có thể kêu một lần tới khi Valkey phát điểm đầu tiên |
| `dbs-dev-redis-fallback` (BL-117, BL-179) | `DBS/Backend` `redis_fallback_total`, `{Role=api}` và `{Role=worker}`, `SUM(METRICS())` | Sum > 0 | 60 s, **2 trên 2** · `notBreaching` | Phát hiện ứng dụng không với tới Redis dù node còn sống (SG, AUTH, TLS, mạng). Bình thường bằng 0 và một lần chớp chỉ tạo vài lần đếm, nên đòi hai phút liên tiếp (> 1 phút), không phải một lần |
| `dbs-dev-risk-config-redis-fallback` (BL-235) | `DBS/Backend` `risk_config_redis_fallback_total`, `{Role=worker}` | Sum > 0 | 60 s, 2 trên 2 · `notBreaching` | Cache cấu hình luật lỗi nên risk đọc DB: vẫn đúng, chậm hơn. Cùng quy tắc với alarm trên |
| `dbs-dev-risk-config-freshness` (BL-188) | `DBS/Backend` `risk_config_freshness_exceeded_total`, `{Role=worker}` | Sum > 0 | 300 s × 1 · `notBreaching` | Giả định của bound 60 s chọn phiên bản luật ([bugfix](../../features/BUG-20261109-risk-config-freshness.md) §2) không còn đứng: SQL đọc phiên bản ≥ 60 s hoặc đồng hồ local/Redis lùi hay lệch. **Không có metric lệch giờ trực tiếp** (Fargate và ElastiCache dùng Amazon Time Sync Service), nên đồng hồ chỉ bị bắt khi nó làm hỏng một lần chọn. Redis sống/lỗi đã có ba alarm ở trên; CPU/bộ nhớ Valkey không alarm vì key `latest:v2` mất chỉ làm worker đọc DB. Runbook [risk-config-rollout](../../runbooks/risk-config-rollout.md) |
| `dbs-dev-rate-limited` (BL-179) | `DBS/Backend` `rate_limited_total`, `{Role=api, Scope=ip}` và `{…, Scope=user}`, `SUM(METRICS())` | Sum > **50** | 300 s × 1 · `notBreaching` | Khách thật hiếm khi chạm giới hạn; số lớn là tấn công, script lỗi hoặc `TRUST_PROXY_HOPS` sai (mọi khách chung một IP của ALB). **Ngưỡng 50 mỗi 5 phút là ước lượng cho dev, chưa đo**; đổi sau lần chạy tải đầu. Test tải (BL-232) sẽ làm nó kêu |

**Quy ước chung.**
- Metric đếm sự kiện (lỗi luật, `CONFIG_INVALID`, đối soát, rate limit) chỉ có điểm khi sự kiện xảy ra: cửa sổ 300 s giữ alarm ở ALARM thêm vài phút. Thư **OK nghĩa là "5 phút qua không có sự kiện mới", không phải "đã xử lý xong"**; trạng thái thật nằm ở DLQ, `reconciliation_runs`, log.
- `treat_missing_data = breaching` chỉ ở hai alarm có nghĩa "không có số đo = hệ thống không chạy" (outbox, node Valkey). Hệ quả: dựng session với `worker_desired_count = 0` làm `dbs-dev-outbox-age` kêu sau ≈ 3 phút.
- Chi phí: alarm chuẩn 0,10 USD/alarm/tháng; alarm biểu thức metric tính theo số metric tham chiếu (lỗi luật 6, đối soát, Redis fallback, rate limit mỗi cái 2). Ước ≈ 2,3 USD/tháng nếu chạy cả tháng (0,2 USD của hai alarm DLQ chạy luôn ở base); alarm session tính theo giờ.
- Chưa có alarm cho các hàng còn lại của bảng docs/03 §14: tỉ lệ 5xx > 1%, p95 chuyển tiền/đọc 3 cửa sổ, thời gian tới cờ p95 > 5 s, > 20 cảnh báo gian lận trên 1.000 giao dịch (chưa có task). `risk_redis_fallback_total{Role,Rule,Reason}` cũng chưa có alarm (chưa có chỗ nào phát metric này).
- Tên metric mới của risk (`risk_decision_total`, `risk_rule_error_total`, `reconciliation_runs_total`, `risk_transfer_to_flag_ms`) là hợp đồng với phía ứng dụng: alarm khai dimension `Role` + nhãn như trên; nếu ứng dụng đổi bộ dimension thì alarm phải đổi theo (test `alarms.tftest.hcl` ghi lại bộ dimension mong đợi).

## Ngoài phạm vi (v1)

- Tracing phân tán đầy đủ.
- APM thương mại.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §14 Quan sát và SLI/SLO.
- Nghiệp vụ, yêu cầu và mô hình miền: [docs/BRD.md](../../BRD.md).
- Giao diện và mốc: Task 8 của roadmap cũ (đã xóa); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md). Thiết kế chi tiết nằm ở các mục docs/03 nêu trên (không có file 02 riêng).
