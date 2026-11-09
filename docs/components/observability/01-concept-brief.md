# observability — Concept Brief

> **Status:** Draft · **Owner:** #5 (dashboard, alarm; metric do Dev phát) · **Verified against code:** một phần: log JSON có `correlationId` (DBS-42); metric HTTP, tuổi outbox và counter `redis_fallback_total`, `rate_limited_total` xuất bằng CloudWatch EMF trong `common/metrics` (DBS-144, kiểm bằng test; **chưa kiểm trên CloudWatch thật**, BL-203). Chưa có: dashboard, alarm, metric của risk/AI (BL-204) · **Cập nhật:** 2026-11-09

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

- Log JSON có `correlationId` ở mọi dòng.
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
| `risk_redis_fallback_total`, `risk_config_redis_fallback_total` | Count | `Role`, `Rule`, `Reason` | `RiskMetrics`; **chỉ có khi consumer chấm điểm được nối vào app** (BL-204) · worker |
| `outbox_oldest_unpublished_age_seconds` | Seconds | không | gauge `OutboxAgeGauge`, mỗi lượt ghi · worker |

**Độ sâu DLQ và tuổi message cũ nhất không có code**: dùng metric gốc của SQS trong namespace `AWS/SQS` (dimension `QueueName`): `ApproximateNumberOfMessagesVisible` trên `dbs-dev-*-events-dlq` và `ApproximateAgeOfOldestMessage` trên `dbs-dev-*-events` (docs/03 §14).

**Quy ước.** Một "request" là một lần Express trả lời hoặc kết nối bị đóng trước đó (`http_aborted_total`, vẫn vào histogram). **Lỗi = 5xx**; 422 và 429 không tính. `Route` là mẫu đường dẫn đã khớp (`/v1/accounts/:id`), request không khớp route nào là `unmatched`, không bao giờ là URL. `Method` thuộc `GET POST PUT PATCH DELETE HEAD OPTIONS`, còn lại `OTHER`. Nhãn chỉ được thuộc `Route Method Role Rule Reason Scope`; giá trị chứa UUID, `@` hoặc dãy ≥ 6 chữ số bị thay bằng `redacted` (**không có id khách hay tài khoản trong tên hay nhãn**). Bộ nhớ là bộ đếm bucket cố định (1, 2, 5, 10, 20, 50, 100, 150, 200, 300, 500, 1000, 2000, 5000, 10000, 60000 ms); phân vị là **biên trên** của bucket nên không thấp hơn thực tế, và các ngưỡng 150 ms, 300 ms, 1 s nằm đúng trên biên. Tối đa 10 000 mẫu mỗi `(Route,Method)` mỗi lượt (vượt thì chia tỉ lệ): lấy số request từ `http_requests_total`, không từ SampleCount của độ trễ.

**Thêm một metric.** Counter prom-client: thêm tên và nhãn cho phép vào `COUNTERS` ở `metrics.service.ts` (mỗi nhãn là một dimension, nên phải là nhãn không chứa dữ liệu cá nhân). Giá trị tại một thời điểm: `MetricsService.registerGauge({ name, unit, read })` từ module sở hữu dữ liệu (như `OutboxAgeGauge`); `read` bị giới hạn 3 giây, mỗi gauge tối đa một lần đọc đang chạy, và lượt ghi cuối khi tắt ứng dụng bỏ qua gauge.

**Bàn giao cho #5 (alarm, dashboard; BL-203):**
- Tuổi outbox: thống kê `Maximum` (nhiều task cùng ghi), `TreatMissingData = breaching` (worker chết thì **không có dữ liệu**, không phải 0), ngưỡng > 30 giây (docs/03 §14).
- Phân vị: so bằng `GreaterThanThreshold` (giá trị là biên trên bucket, một p95 thật đúng 300 ms được báo là 300).
- Tỉ lệ 5xx của dịch vụ: `http_5xx_total` chia `http_requests_total` ở bộ dimension `[]` (không có probe `/health/*`).
- DLQ: `TreatMissingData = notBreaching` (SQS ngừng phát metric của queue rảnh quá 6 giờ).
- Chi phí: mỗi bộ dimension là một metric tùy chỉnh; khoảng 4 metric × (≈ 20 cặp Route×Method + ≈ 5 `[Method]` + 1 `[]`) ≈ 105, cộng khoảng 10 của counter ≈ 35 USD/tháng nếu để chạy cả tháng; tính theo giờ nên phiên ngắn rẻ hơn nhiều. Log: tối đa một dòng cho mỗi 100 request của mỗi route mỗi phút.
- Việc chưa làm, cần một phiên có AWS: gửi một dòng EMF thật (`aws logs put-log-events`) rồi đọc `get-metric-statistics` với `ExtendedStatistics = p95` và xem metric lỗi EMF của `AWS/Logs`.

## Ngoài phạm vi (v1)

- Tracing phân tán đầy đủ.
- APM thương mại.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §14 Quan sát và SLI/SLO.
- Nghiệp vụ, yêu cầu và mô hình miền: [docs/BRD.md](../../BRD.md).
- Giao diện và mốc: Task 8 của roadmap cũ (đã xóa); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md). Thiết kế chi tiết nằm ở các mục docs/03 nêu trên (không có file 02 riêng).
