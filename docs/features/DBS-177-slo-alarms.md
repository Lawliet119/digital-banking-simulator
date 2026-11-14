# DBS-177 · Alarm CloudWatch theo từng SLO (Terraform)

> **Status:** Plan approved (phần offline Terraform + test; chờ test kích hoạt trên AWS thật và PR/review) · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev khác (theo team.md) · **Nhánh:** `infra/DBS-177-slo-alarms` · **PR:** — · **Cập nhật:** 2026-11-14

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 6 / Observability, ưu tiên Medium, vai #5 Platform & Ops.
- **DoD:**
  1. Mỗi SLO có alarm và ngưỡng; gửi SNS email; tạo bằng Terraform
  2. Thử kích hoạt từng alarm một lần (ví dụ bằng tải hoặc làm chậm có chủ ý) và ghi kết quả
  3. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:**
  - `envs/dev/base/alarms.tf` (SNS topic `dbs-dev-alarms`, email subscription `alarm_email`, 2 alarm DLQ): **đã có trên `main`**.
  - `envs/dev/session/alarms.tf` (11 alarm vận hành hiện có): **đã có trên `main`**.
  - `backend/src/common/metrics/` ([DBS-144](DBS-144-sli-metrics-emf.md) + BL-204): **đã có trên `main`**, xuất `http_5xx_total`, `http_requests_total`, `http_request_duration_ms` (gồm bộ `[]` loại `/health/*` và bộ `[Route, Method]`) và `risk_transfer_to_flag_ms` (`[Role]`).
  - Phiên `dev/session` trên AWS thật để thử kích hoạt alarm: **chưa dựng** trong phiên offline này (ngoài phạm vi; bị chặn thêm bởi BL-265 nếu dùng `dev1`).
- **Đã có gì:**
  - `base/alarms.tf`: `aws_cloudwatch_metric_alarm.dlq_not_empty` (2 alarm DLQ > 0).
  - `session/alarms.tf`: 11 alarm (`queue_age` ×2, `outbox_age`, `outbox_quarantined`, `risk_config_invalid`, `risk_rule_error`, `reconciliation`, `redis_node_missing`, `redis_fallback`, `risk_config_redis_fallback`, `rate_limited`).
  - **Baseline (2026-11-14, trước khi sửa):** `terraform fmt -check -recursive` sạch; `terraform validate` hợp lệ ở `base` và `session`; `terraform test -parallelism=1` ở `envs/dev/base`: **53 đạt, 0 lỗi**; ở `envs/dev/session`: **66 đạt, 0 lỗi** (`alarms.tftest.hcl`: 12 đạt).
- **Ngoài phạm vi:**
  - SLO «Cảnh báo gian lận trên 1.000 giao dịch > 20 (24 giờ trượt, khi có ≥ 1.000 giao dịch)»: backend chưa có counter riêng cho số cờ gian lận / tổng giao dịch (chỉ có `risk_decision_total{Role,AiStatus}` tách theo 7+ trạng thái AI và `risk_transfer_to_flag_ms` là phân phối độ trễ). Không sửa code backend trong task hạ tầng này; ghi nhận ở **BL-340**.
  - Chạy `terraform apply` / `destroy` và kích hoạt thử từng alarm trên AWS thật: điều phối sau khi dựng `dev/session` (**BL-341**).
  - Mở PR / merge / Dev review (**BL-342**).
- **Quyết định ở G1 (tự quyết):**
  1. **Đặt cả 4 alarm SLO mới ở `envs/dev/session/alarms.tf`:** đều gắn với API và worker chỉ tồn tại trong phiên; xóa theo `session` tránh báo động giả và tiết kiệm chi phí. `base/alarms.tf` giữ nguyên SNS topic và 2 alarm DLQ bền vững.
  2. **Tỉ lệ 5xx (`dbs-dev-api-5xx-rate`):** dùng bộ dimension tổng `[]` của `http_5xx_total` và `http_requests_total` (loại `/health/*`, không tính 422/429), biểu thức `IF(mr > 0, 100 * FILL(m5, 0) / mr, 0) > 1`, `period = 300`, `evaluation_periods = 1`, `treat_missing_data = "notBreaching"`. Tránh chia 0 và giữ `OK` khi hệ thống rảnh.
  3. **Latency chuyển tiền (`dbs-dev-transfer-latency-p95`):** `http_request_duration_ms` với `{ Route = "/v1/transfers", Method = "POST" }`, `extended_statistic = "p95"`, `period = 300`, `evaluation_periods = 3`, `datapoints_to_alarm = 3`, `threshold = 300`, `notBreaching` (khớp docs/03 §14 «3 cửa sổ liên tiếp» và tránh sai số ước lượng quanh biên bucket 300 ms).
  4. **Latency đọc (`dbs-dev-read-latency-p95`):** gộp 3 route đọc (`GET /v1/accounts`, `GET /v1/accounts/:id`, `GET /v1/accounts/:id/transactions`, khớp [DBS-145](DBS-145-cloudwatch-dashboard.md) QĐ 8) bằng `MAX(METRICS())` trên `stat = "p95"`, `period = 300`, `evaluation_periods = 3`, `datapoints_to_alarm = 3`, `threshold = 150`, `notBreaching`. Một alarm đại diện cho toàn SLO đọc, không nhân 3 số alarm.
  5. **Thời gian tới cờ (`dbs-dev-transfer-to-flag-p95`):** `risk_transfer_to_flag_ms` với `{ Role = "worker" }`, `extended_statistic = "p95"`, `period = 900` (15 phút), `evaluation_periods = 1`, `threshold = 5000` (5 s), `notBreaching`.
  6. **Theo `var.metrics_namespace`:** cả 4 alarm mới đều dùng `var.metrics_namespace` (mặc định `DBS/Backend`) để test thử bằng namespace cô lập không trộn metric thật.

## 2. Hành vi

| Alarm | Tài nguyên Terraform | Metric & Dimension | Công thức / Thống kê | Ngưỡng & Cửa sổ | Thiếu dữ liệu |
|---|---|---|---|---|---|
| `dbs-dev-api-5xx-rate` | `aws_cloudwatch_metric_alarm.api_5xx_rate` | `http_5xx_total`, `http_requests_total` (`[]`) | `IF(mr > 0, 100 * FILL(m5, 0) / mr, 0)` (`Sum`) | `> 1` %, `300 s × 1` | `notBreaching` |
| `dbs-dev-transfer-latency-p95` | `aws_cloudwatch_metric_alarm.transfer_latency_p95` | `http_request_duration_ms` (`{Route="/v1/transfers", Method="POST"}`) | `extended_statistic = "p95"` | `> 300` ms, `300 s`, **3/3** | `notBreaching` |
| `dbs-dev-read-latency-p95` | `aws_cloudwatch_metric_alarm.read_latency_p95` | `http_request_duration_ms` (`GET` 3 route đọc) | `MAX(METRICS())` (`p95`) | `> 150` ms, `300 s`, **3/3** | `notBreaching` |
| `dbs-dev-transfer-to-flag-p95` | `aws_cloudwatch_metric_alarm.transfer_to_flag_p95` | `risk_transfer_to_flag_ms` (`{Role="worker"}`) | `extended_statistic = "p95"` | `> 5000` ms, `900 s × 1` | `notBreaching` |

Mọi alarm gửi `alarm_actions` và `ok_actions` tới `local.base.alarm_topic_arn` (`dbs-dev-alarms`).

## 3. Kiến trúc

- **Vị trí:** `infra/terraform/envs/dev/session/alarms.tf` (thêm 4 `aws_cloudwatch_metric_alarm` và `local.read_routes`), `infra/terraform/envs/dev/session/tests/alarms.tftest.hcl`.
- **Interface / hợp đồng metric:** khớp `backend/src/common/metrics/metrics.service.ts` (`http_5xx_total`, `http_requests_total`, `http_request_duration_ms`, `risk_transfer_to_flag_ms`). Không thêm biến Terraform hay output mới.
- **Chi phí:** thêm 4 alarm (7 metric tham chiếu: 2 + 1 + 3 + 1 = +0,70 USD/tháng nếu chạy cả tháng). Tổng cộng 17 alarm (2 ở `base` ≈ 0,20 USD/tháng, 15 ở `session` ≈ 2,80 USD/tháng, tính theo giờ khi bật phiên).
- **Thay đổi cấp hệ thống:** `docs/03_HIGH_LEVEL_ARCHITECTURE.md` §14, `docs/components/observability/01-concept-brief.md`, `infra/terraform/README.md`, `docs/features/README.md`, `docs/BACKLOG.md` (`BL-340`, `BL-341`, `BL-342`).

## 4. Test cases tự động (`terraform test`, `mock_provider`)

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-177-01 | DoD 1 (SLO 5xx) | tftest `api_5xx_rate_alarm` | `dbs-dev-api-5xx-rate` dùng `IF(mr > 0, 100 * FILL(m5, 0) / mr, 0)` > 1, `http_5xx_total` và `http_requests_total` bộ `[]`, `Sum`, `300 s × 1`, `notBreaching`, gửi SNS |
| TC-177-02 | DoD 1 (SLO chuyển tiền) | tftest `transfer_latency_p95_alarm` | `dbs-dev-transfer-latency-p95` dùng `http_request_duration_ms` `{Route="/v1/transfers", Method="POST"}`, `p95`, `300 s`, `3/3`, `> 300`, `notBreaching` |
| TC-177-03 | DoD 1 (SLO đọc) | tftest `read_latency_p95_alarm` | `dbs-dev-read-latency-p95` dùng `MAX(METRICS())` trên 3 route `GET /v1/accounts`, `/:id`, `/:id/transactions`, `p95`, `300 s`, `3/3`, `> 150`, `notBreaching` |
| TC-177-04 | DoD 1 (SLO giao dịch → cờ) | tftest `transfer_to_flag_p95_alarm` | `dbs-dev-transfer-to-flag-p95` dùng `risk_transfer_to_flag_ms` `{Role="worker"}`, `p95`, `900 s × 1`, `> 5000`, `notBreaching` |
| TC-177-05 | QĐ 6 & không hồi quy | tftest `all_alarms_notify_the_topic`, `alarms_follow_metrics_namespace` | 15 alarm session gửi `ALARM` và `OK` về `alarm_topic_arn`; 4 alarm mới đổi theo `var.metrics_namespace`; các test cũ đạt |
| TC-177-06 | DoD 2 | thủ công (AWS thật) | Kích hoạt thử từng alarm trên AWS thật khi `dev/session` Up (BL-341) |
| TC-177-07 | DoD 3 | quy trình | PR, CI, Dev review (BL-342) |

## 5. Test thủ công (chờ `dev/session` Up — BL-341)

Điều kiện: `dev/base` đã apply với `alarm_email` đã xác nhận SNS subscription; `dev/session` đã Up với API và worker chạy trên ECS.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-177-01 | Kiểm tra danh sách 17 alarm trên CloudWatch (`aws cloudwatch describe-alarms --alarm-name-prefix dbs-dev-`) và trạng thái `OK` / `INSUFFICIENT_DATA` | Đủ 17 alarm, `AlarmActions` và `OKActions` trỏ `dbs-dev-alarms` |
| M-177-02 | Kích hoạt `dbs-dev-api-5xx-rate` (gửi request gây 5xx > 1% trong 5 phút hoặc `set-alarm-state` để kiểm chứng SNS) rồi khôi phục | Alarm chuyển `ALARM` → nhận email SNS → về `OK` → nhận email `OK` |
| M-177-03 | Kích hoạt `dbs-dev-transfer-latency-p95` và `dbs-dev-read-latency-p95` (tải k6 / làm chậm DB trong 15 phút = 3 cửa sổ 5 phút) | Chuyển `ALARM`, nhận email SNS, về `OK` sau khi hết tải |
| M-177-04 | Kích hoạt `dbs-dev-transfer-to-flag-p95` (làm chậm worker / queue để `flagLagMs > 5000` trong 15 phút) | Chuyển `ALARM`, nhận email SNS, về `OK` |
| M-177-05 | Kích hoạt các alarm vận hành còn lại (DLQ > 0, `outbox_age`, `risk_rule_error`, `redis_fallback`, `rate_limited`, `reconciliation`) | Mỗi alarm kêu ít nhất 1 lần và về `OK` |

## 6. Domain review (AI self-check)

**Reviewer:** tự kiểm theo checklist domain observability & Terraform của repo (2026-11-14) · **Kết quả:** 5 phát hiện (0 blocking, 3 should-fix, 2 minor), đã xử lý hết.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | `api_5xx_rate` chia cho `http_requests_total` có thể lỗi chia 0 nếu điểm request = 0 | Đã dùng `IF(mr > 0, 100 * FILL(m5, 0) / mr, 0)` và `notBreaching` |
| 2 | should-fix | `extended_statistic = "p95"` vs `metric_query.metric.stat = "p95"` trong Terraform AWS provider | Đã kiểm bằng `terraform validate` và `terraform test` (hợp lệ trên `hashicorp/aws v6.70.0`) |
| 3 | should-fix | SLO «> 20 cảnh báo gian lận / 1.000 giao dịch» không có metric riêng ở backend | Không bịa metric giả; tách thành `BL-340` cho backend + Terraform sau |
| 4 | minor | Tổng số alarm và ước tính chi phí ở `session/alarms.tf`, `README.md`, `01-concept-brief.md` | Đã cập nhật đồng bộ 11 → 15 (tổng 17), chi phí 2,3 → 3,0 USD/tháng |
| 5 | minor | `read_latency_p95` nếu 3 route vượt ở 3 cửa sổ khác nhau sẽ kích `MAX(METRICS())` | Chấp nhận (nhất quán với `w_reads` trên dashboard, tránh nhân 3 alarm và chi phí) |

**Quyết định ở G2:** chấp nhận thiết kế; không có blocking.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `infra/terraform/envs/dev/session/alarms.tf`, `tests/alarms.tftest.hcl` | TC-177-01..05 | — (viết song song với test và chạy verify) | `terraform fmt -check -recursive`, `terraform validate`, `terraform test -parallelism=1` | `feat(infra): add CloudWatch SLO alarms for 5xx, latency and flag lag (DBS-177)` |
| 2 | `docs/features/DBS-177-slo-alarms.md`, `docs/03_HIGH_LEVEL_ARCHITECTURE.md`, `docs/components/observability/01-concept-brief.md`, `infra/terraform/README.md`, `docs/features/README.md`, `docs/BACKLOG.md` | kiểm liên kết doc | — | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(observability): document DBS-177 SLO alarms and backlog handoffs` |

Rủi ro và cách lùi: alarm là tài nguyên độc lập trong `session`, lùi bằng `terraform destroy -target=...` hoặc `git revert`.

## 8. Kết quả

- **Lệnh kiểm tra (2026-11-14, offline trong worktree `dbs-177`):**
  - `terraform fmt -check -recursive`: đạt (0 file lệch)
  - `envs/dev/base`: `terraform init -backend=false`, `terraform validate` (hợp lệ), `terraform test -parallelism=1`: **53 passed, 0 failed**
  - `envs/dev/session`: `terraform init -backend=false`, `terraform validate` (hợp lệ), `terraform test -parallelism=1`: **70 passed, 0 failed** (`tests/alarms.tftest.hcl`: 16 passed, 0 failed)
  - `check-doc-links.mjs`: xem kết quả chạy sau bước cập nhật docs.
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-177-01 | `alarms.tftest.hcl` › `api_5xx_rate_alarm` | đạt |
| TC-177-02 | `alarms.tftest.hcl` › `transfer_latency_p95_alarm` | đạt |
| TC-177-03 | `alarms.tftest.hcl` › `read_latency_p95_alarm` | đạt |
| TC-177-04 | `alarms.tftest.hcl` › `transfer_to_flag_p95_alarm` | đạt |
| TC-177-05 | `alarms.tftest.hcl` › `all_alarms_notify_the_topic`, `alarms_follow_metrics_namespace` | đạt |
| TC-177-06 | M-177-01..05 (AWS thật) | chưa làm (chờ dựng `dev/session` Up, **BL-341**) |
| TC-177-07 | PR, CI, Dev review | chưa làm (**BL-342**) |

- **Bàn giao cho vai khác:**
  - **BL-340** (Dev / Fraud + #5): thêm metric đếm số cờ gian lận và tổng giao dịch để dựng alarm SLO «> 20 cảnh báo gian lận / 1.000 giao dịch (24 giờ trượt, ≥ 1.000 giao dịch)».
  - **BL-341** (#5 Platform & Ops): chạy thử kích hoạt từng alarm trên AWS thật khi `dev/session` Up và xác nhận email SNS.
  - **BL-342** (#5 + Dev review): mở PR, CI xanh, Dev review và điền bảng «Đối chiếu test case» trong PR.

## 9. Tài liệu đã cập nhật

- `docs/features/DBS-177-slo-alarms.md` (mới)
- `docs/03_HIGH_LEVEL_ARCHITECTURE.md` (§14)
- `docs/components/observability/01-concept-brief.md` (mục Alarm CloudWatch)
- `infra/terraform/README.md` (mục Alarm CloudWatch và thông báo)
- `docs/features/README.md` (thêm hàng DBS-177)
- `docs/BACKLOG.md` (thêm `BL-340`, `BL-341`, `BL-342`)
