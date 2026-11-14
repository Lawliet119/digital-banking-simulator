# observability — Concept Brief

> **Status:** Draft · **Owner:** #5 (dashboard, alarm; metric do Dev phát) · **Verified against code:** một phần: log JSON có `correlationId` (DBS-42); metric HTTP, tuổi outbox và counter `redis_fallback_total`, `rate_limited_total` xuất bằng CloudWatch EMF trong `common/metrics` (DBS-144, kiểm bằng test và **kiểm trên CloudWatch thật ngày 2026-11-09**, xem «Kết quả kiểm trên CloudWatch»). Dashboard `dbs-dev-overview` dựng bằng Terraform (DBS-145, kiểm trên CloudWatch thật bằng số mô phỏng, xem «Dashboard»). Chưa có: alarm, metric của risk/AI (BL-204) · **Cập nhật:** 2026-11-12

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
| `risk_config_redis_fallback_total` | Count | `Role` | `RiskMetrics` qua `RuleSetRepository`; có khi service worker chạy (DBS-121) · worker |
| `risk_redis_fallback_total` | Count | `Role`, `Rule`, `Reason` | `RiskMetrics`; **chưa có chỗ nào gọi `.redisFallback(`**: chờ consumer chấm điểm nối đủ (BL-204) · worker |
| `outbox_oldest_unpublished_age_seconds` | Seconds | không | gauge `OutboxAgeGauge`, mỗi lượt ghi · worker |

**Độ sâu DLQ và tuổi message cũ nhất không có code**: dùng metric gốc của SQS trong namespace `AWS/SQS` (dimension `QueueName`): `ApproximateNumberOfMessagesVisible` trên `dbs-dev-*-events-dlq` và `ApproximateAgeOfOldestMessage` trên `dbs-dev-*-events` (docs/03 §14).

**Quy ước.** Một "request" là một lần Express trả lời hoặc kết nối bị đóng trước đó (`http_aborted_total`, vẫn vào histogram). **Lỗi = 5xx**; 422 và 429 không tính. `Route` là mẫu đường dẫn đã khớp (`/v1/accounts/:id`), request không khớp route nào là `unmatched`, không bao giờ là URL. `Method` thuộc `GET POST PUT PATCH DELETE HEAD OPTIONS`, còn lại `OTHER`. Nhãn chỉ được thuộc `Route Method Role Rule Reason Scope`; giá trị chứa UUID, `@` hoặc dãy ≥ 6 chữ số bị thay bằng `redacted` (**không có id khách hay tài khoản trong tên hay nhãn**). Bộ nhớ là bộ đếm bucket cố định (1, 2, 5, 10, 20, 50, 100, 150, 200, 300, 500, 1000, 2000, 5000, 10000, 60000 ms); mỗi mẫu gửi đi là **biên trên** của bucket (không thấp hơn thực tế), các ngưỡng 150 ms, 300 ms, 1 s nằm đúng trên biên, và CloudWatch còn ước lượng phân vị nên giá trị đọc ra lệch biên vài phần trăm (đã đo ở mục kết quả kiểm bên dưới). Tối đa 10 000 mẫu mỗi `(Route,Method)` mỗi lượt (vượt thì chia tỉ lệ): lấy số request từ `http_requests_total`, không từ SampleCount của độ trễ.

**Thêm một metric.** Counter prom-client: thêm tên và nhãn cho phép vào `COUNTERS` ở `metrics.service.ts` (mỗi nhãn là một dimension, nên phải là nhãn không chứa dữ liệu cá nhân). Giá trị tại một thời điểm: `MetricsService.registerGauge({ name, unit, read })` từ module sở hữu dữ liệu (như `OutboxAgeGauge`); `read` bị giới hạn 3 giây, mỗi gauge tối đa một lần đọc đang chạy, và lượt ghi cuối khi tắt ứng dụng bỏ qua gauge.

**Bàn giao cho #5 (alarm, dashboard: DBS-145, BL-051, BL-179):**
- Tuổi outbox: thống kê `Maximum` (nhiều task cùng ghi), `TreatMissingData = breaching` (worker chết thì **không có dữ liệu**, không phải 0), ngưỡng > 30 giây (docs/03 §14).
- Phân vị: giá trị trong mảng là biên trên bucket, nhưng **CloudWatch tính phân vị là ước lượng** (đã đo: mẫu ở bucket 20 ms cho p50 = 21,1; mẫu ở bucket 1000 ms cho p95 = 977,5), sai khác vài phần trăm quanh biên. Đặt ngưỡng alarm theo SLO (150 ms, 300 ms, 1 s) với `GreaterThanThreshold` và đừng dựa vào việc giá trị trả về đúng bằng biên bucket; ngưỡng 300 ms cần ít nhất 3 cửa sổ liên tiếp (docs/03 §14) chính vì sai số này.
- Tỉ lệ 5xx của dịch vụ: `http_5xx_total` chia `http_requests_total` ở bộ dimension `[]` (không có probe `/health/*`).
- DLQ: `TreatMissingData = notBreaching` (SQS ngừng phát metric của queue rảnh quá 6 giờ).
- Chi phí: mỗi bộ dimension là một metric tùy chỉnh; khoảng 4 metric × (≈ 20 cặp Route×Method + ≈ 5 `[Method]` + 1 `[]`) ≈ 105, cộng khoảng 10 của counter ≈ 35 USD/tháng nếu để chạy cả tháng; tính theo giờ nên phiên ngắn rẻ hơn nhiều. Log: tối đa một dòng cho mỗi 100 request của mỗi route mỗi phút.
- Còn lại cho #5: dựng alarm và dashboard theo các quy tắc trên (DBS-145), và xem metric của worker sau khi có service worker trên ECS (DBS-121).

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

`infra/terraform/envs/dev/session/dashboard.tf` dựng dashboard **`dbs-dev-overview`** cùng phiên (`terraform apply` / `destroy` của `session`, hoặc `-target=aws_cloudwatch_dashboard.overview`: dashboard không tham chiếu tài nguyên nào khác của session). Output `dashboard_url`. 13 widget (1 văn bản, 12 metric), khoảng thời gian mặc định 3 giờ, `periodOverride = inherit` để cửa sổ 5 phút của widget không bị console tính lại:

| Hàng | Widget | Nguồn · đường kẻ ngang (SLO docs/03 §14) |
|---|---|---|
| 2 | Độ trễ toàn dịch vụ p50/p95/p99 (tổng quan, không đường SLO); chuyển tiền `POST /v1/transfers` p95/p99 | `[]`, `[Route,Method]` · 300 ms, 1 s |
| 3 | Đọc p95 (`GET /v1/accounts`, `/:id`, `/:id/transactions`); tỉ lệ 5xx %; request, 5xx, bị ngắt | 150 ms · `100 * FILL(5xx,0) / request`, 1% |
| 4 | p95 theo Route (`SEARCH`, loại `/health/*`); tuổi outbox (`Maximum`); DLQ | 10 s và 30 s; DLQ > 0 |
| 5 | Tuổi message cũ nhất; `redis_fallback_total` (`Role` api, worker); `rate_limited_total` (`Scope` ip, user) | 60 s và 120 s |
| 6 | Fallback Redis của risk (`SEARCH`) | trống tới khi có nguồn (BL-204) |

Đường kẻ chỉ để nhìn, không phải alarm (BL-051, BL-179, BL-182). Biến `metrics_namespace` (mặc định `DBS/Backend`) chỉ đổi khi thử dashboard bằng số mô phỏng. Ảnh chụp lúc có tải nhẹ: [tổng hợp 12 widget](../../features/screenshots/DBS-145/00-dashboard-overview.png) và từng widget ở [`screenshots/DBS-145/`](../../features/screenshots/DBS-145/). **Đó là số mô phỏng** (30 phút EMF do chính mã `common/metrics` sinh, namespace `DBS/Backend-dbs145`, không phải app chạy trên ECS), ảnh render bằng `GetMetricWidgetImage`, không phải màn hình console; chi tiết và số đối chiếu ở [DBS-145](../../features/DBS-145-cloudwatch-dashboard.md) §8. Đọc ảnh: p95 chuyển tiền nằm sát đường 300 ms vì CloudWatch ước lượng phân vị quanh biên bucket (xem «Bàn giao cho #5»), không phải vi phạm SLO.

## Ngoài phạm vi (v1)

- Tracing phân tán đầy đủ.
- APM thương mại.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §14 Quan sát và SLI/SLO.
- Nghiệp vụ, yêu cầu và mô hình miền: [docs/BRD.md](../../BRD.md).
- Giao diện và mốc: Task 8 của roadmap cũ (đã xóa); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md). Thiết kế chi tiết nằm ở các mục docs/03 nêu trên (không có file 02 riêng).
