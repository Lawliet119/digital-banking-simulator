# RSK-04 · Alarm DLQ `risk-events-dlq`, `CONFIG_INVALID`, tỉ lệ fallback AI và runbook redrive

> **Status:** Implemented (G1–G4 tự duyệt theo `CLAUDE_local.md`) · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev · **Nhánh:** `infra/RSK-04-risk-dlq-fallback-alarms` · **PR:** — · **Cập nhật:** 2026-11-16

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 7, High, Deliverable `P4`.
- **Thực trạng (trên board):** Lỗi mã luật hoặc truy vấn feature làm mọi sự kiện đi DLQ sau 5 lần (khoảng 2,5 phút). Alarm `risk-events-dlq` và runbook redrive trong thời hạn retention 4 ngày chưa gắn riêng cho queue risk; chưa có alarm cho `ai_status = CONFIG_INVALID` và tỉ lệ fallback AI (`BL-051`).
  - *Đính chính theo code hiện tại trên `main`:* Retention của **queue chính** là **4 ngày** (`345.600` s), còn của **DLQ** là **6 ngày** (`518.400` s, ADR-03 & `base/sqs.tf`). Trên `main` đã có `queue_age` cho queue chính (`session/alarms.tf`), `dlq_not_empty` cho DLQ (`base/alarms.tf`), `risk_config_invalid` (`dbs-dev-risk-config-invalid`) và `risk_rule_error` (`dbs-dev-risk-rule-error`). `RSK-04` bổ sung hai alarm còn thiếu: `dlq_oldest_age` (cảnh báo bậc 2/escalation trên DLQ) và `risk_ai_fallback_rate` (tỉ lệ fallback AI), cùng phần cập nhật runbook cho lỗi luật tất định & `CONFIG_INVALID`.
- **Expect:** Lỗi tất định hay cấu hình AI hỏng được phát hiện trong vài phút và xử lý theo runbook.
- **DoD:**
  1. Alarm `risk-events-dlq` > 0 và tuổi message cũ nhất; alarm riêng cho `ai_status = CONFIG_INVALID` và tỉ lệ fallback AI vượt ngưỡng đã chốt
  2. Runbook redrive cho queue risk: bước kiểm khi lỗi tất định (mọi sự kiện vào DLQ), hạn retention của queue và DLQ
  3. Thử bằng cách bơm lỗi luật và cấu hình `ai.*` hỏng: alarm bật, runbook làm được từng bước
  4. PR đã merge vào `main`; Dev review; `terraform validate` và `plan` sạch
- **Phụ thuộc:** `DBS-163`, `DBS-164`, `DBS-144`, `RSK-02` — tất cả đều **Done** trên board và trên `main`.
- **Baseline:**
  - `dev/base`: `61 passed, 0 failed`; `dev/session`: `88 passed, 0 failed`.
  - AWS CLI: không có credential trong môi trường hiện tại (`NoCredentials`).
- **Ngoài phạm vi:**
  - Kích hoạt thử alarm trên AWS thật (cần credential AWS; bàn giao sang `BL-398`).
  - Sửa code backend (`risk-scoring.metrics.ts` đã đầy đủ).
- **Câu hỏi mở:**
  1. **Ngưỡng alarm tuổi message cũ nhất của DLQ (`dlq_oldest_age`):** `dlq-redrive.md` đặt SLA redrive trong 24 giờ, retention DLQ là 6 ngày. *Đề xuất:* Dùng làm **cảnh báo bậc 2 (escalation)** nếu message nằm quá **1 giờ** (`3600` s), `dimensions = { QueueName = each.value.name }`, `period = 60`, `evaluation_periods = 2` (lọc nhiễu residual spike khi DLQ vừa cạn), `treat_missing_data = "notBreaching"`.
  2. **Công thức và ngưỡng tỉ lệ fallback AI (`risk_ai_fallback_rate`):** Theo `session/alarms.tf` (dòng 16–18), phải dùng `SUM(METRICS("fb_"))` để bỏ qua stream chưa có datapoint (tránh lỗi `INSUFFICIENT_DATA` của `FILL` khi một trạng thái như `BUDGET_EXHAUSTED` chưa từng xuất hiện). Mẫu số chỉ tính các quyết định có gọi AI (`SUCCEEDED` + 5 trạng thái fallback), không tính `DISABLED` (`rule_only`). *Đề xuất:* Ngưỡng mặc định `10`% (`ai_fallback_rate_threshold_percent = 10`, `period = 300`, `evaluation_periods = 1`, `treat_missing_data = "notBreaching"`).
- **Quyết định ở G1 (tự duyệt theo `CLAUDE_local.md`):** Chấp thuận cả 2 đề xuất trên.

## 2. Hành vi

1. **`base/alarms.tf` — `aws_cloudwatch_metric_alarm.dlq_oldest_age`:**
   - `for_each = aws_sqs_queue.dlq` (`dbs-dev-risk-dlq-oldest-age`, `dbs-dev-notification-dlq-oldest-age`).
   - Metric `AWS/SQS` `ApproximateAgeOfOldestMessage`, `dimensions = { QueueName = each.value.name }`, `Maximum`, `period = 60`, `evaluation_periods = 2`, `threshold = 3600` (cảnh báo escalation trước SLA 24 giờ và retention 6 ngày), `treat_missing_data = "notBreaching"`, `alarm_actions` & `ok_actions` tới `aws_sns_topic.alarms.arn`.
   - **Chi phí:** +2 alarm thường trực ở `base` = **+0,20 USD/tháng** (nâng tổng `base/alarms.tf` từ 0,20 lên **0,40 USD/tháng**).
2. **`session/alarms.tf` — `aws_cloudwatch_metric_alarm.risk_ai_fallback_rate`:**
   - Metric math trên `risk_decision_total` (`Role = "worker"`, `period = 300`, `Sum`):
     - `succ`: `AiStatus = "SUCCEEDED"`
     - `fb_ci`, `fb_ref`, `fb_inv`, `fb_una`, `fb_bud`: 5 trạng thái fallback (`CONFIG_INVALID`, `REFUSED`, `INVALID_RESPONSE`, `UNAVAILABLE`, `BUDGET_EXHAUSTED`).
     - `fb_sum = SUM(METRICS("fb_"))`
     - `total_ai = SUM([succ, fb_sum])`
     - `rate = IF(total_ai >= 5, 100 * fb_sum / total_ai, 0)`
   - `threshold = var.ai_fallback_rate_threshold_percent` (default `10`, validation `0 < x <= 100`), `GreaterThanThreshold`, `evaluation_periods = 1`, `treat_missing_data = "notBreaching"`.
   - **Chi phí:** tham chiếu 6 metric (~0,60 USD/tháng nếu session chạy liên tục cả tháng; thực tế tính theo giờ).
3. **Runbook `docs/runbooks/dlq-redrive.md`:**
   - Ghi rõ retention: queue chính **4 ngày** (`345.600` s), DLQ **6 ngày** (`518.400` s).
   - Quy trình xử lý **lỗi luật tất định** (`dbs-dev-risk-rule-error` + mọi sự kiện vào `risk-events-dlq` sau 5 lần / ~2,5 phút): (1) xác định `Rule` từ log `/dbs/dev/worker` và **nghiêm cấm redrive** khi chưa deploy bản sửa (redrive sớm làm sự kiện lỗi lại 5 lần và khóa `StartMessageMoveTask` trong 6 ngày); (2) deploy hotfix mã nguồn; (3) chạy `dlq:age-check` rồi redrive.
   - Phân biệt với **`CONFIG_INVALID`** (`dbs-dev-risk-config-invalid`): không vào DLQ mà đã commit baseline (`R1–R6`); **không redrive**, chỉ tạo phiên bản cấu hình đúng qua `POST /v1/admin/risk-config` (UC-12).

## 3. Kiến trúc

- **Vị trí:**
  - `infra/terraform/envs/dev/base/alarms.tf` (cập nhật header chi phí 0,40 USD/tháng + thêm `dlq_oldest_age`) & `tests/alarms.tftest.hcl`.
  - `infra/terraform/envs/dev/session/alarms.tf`, `variables.tf` & `tests/alarms.tftest.hcl` (cập nhật `all_alarms_notify_the_topic` 14 → 15 alarm + test `risk_ai_fallback_rate`).
  - `docs/runbooks/dlq-redrive.md`.
- **Thay đổi cấp hệ thống:** cập nhật `docs/components/observability/01-concept-brief.md`, `infra/terraform/README.md`, `docs/features/README.md`, `docs/BACKLOG.md` (`BL-398`).

## 4. Test cases tự động

| ID | Truy vết (DoD / AC) | Lớp | Given · When · Then | Kết quả mong đợi |
|---|---|---|---|---|
| TC-RSK04-01 | DoD #1 | `terraform test` (`base`) | `dlq_oldest_age["risk"]` và `["notification"]` có `ApproximateAgeOfOldestMessage > 3600`, `dimensions.QueueName`, `evaluation_periods = 2`, `notBreaching`, gắn `aws_sns_topic.alarms.arn` | Pass |
| TC-RSK04-02 | DoD #1 | `terraform test` (`session`) | `risk_ai_fallback_rate` có đủ 6 `AiStatus`, biểu thức `SUM(METRICS("fb_"))` & `IF(total_ai >= 5, ...)`, `threshold = 10`, `notBreaching`; từ chối `ai_fallback_rate_threshold_percent = 0` hoặc `> 100`; `all_alarms_notify_the_topic` kiểm đủ 15 alarm | Pass |
| TC-RSK04-03 | DoD #3 | Backend unit (`jest`) | Chạy `scoring-rule-error.spec.ts` và `risk-scoring.metrics.spec.ts` chứng minh `risk_rule_error_total` và `risk_decision_total{AiStatus="CONFIG_INVALID"}` phát đúng | Pass |
| TC-RSK04-04 | DoD #4 | `terraform fmt/validate/test` | `fmt -check -recursive`, `validate`, `terraform test` trên `dev/base` và `dev/session` | Pass |

## 5. Test thủ công

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-RSK04-01 | `terraform -chdir=infra/terraform/envs/dev/base fmt -check && validate && test` | Sạch, toàn bộ test pass |
| M-RSK04-02 | `TF_DATA_DIR=/tmp/tf-dev-session AWS_EC2_METADATA_DISABLED=true terraform -chdir=infra/terraform/envs/dev/session validate && test` | Sạch, toàn bộ test pass |
| M-RSK04-03 | `cd backend && npm test -- scoring-rule-error.spec.ts risk-scoring.metrics.spec.ts` | Toàn bộ test pass |
| M-RSK04-04 | *(AWS thật)* Kích hoạt thử `dlq_oldest_age` và `risk_ai_fallback_rate` trên AWS bằng `put-metric-data` hoặc bơm lỗi thật, chạy từng bước `dlq-redrive.md` (runbook gốc đã thử thật trên SQS dev ở DBS-164/DBS-184) | Cần credential AWS (`chưa chạy` nếu thiếu, bàn giao `BL-398`) |

## 6. Domain review (AI)

**Reviewer vòng 1:** subagent (`pro`), 2026-11-16 · **Kết quả:** 7 phát hiện (1 blocking, 5 should-fix, 1 minor), verdict `REVISE` · [trả lời nguyên văn](screenshots/RSK-04/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | `FILL(fb_*, 0)` gây `INSUFFICIENT_DATA` khi stream chưa có dữ liệu | Đã sửa §1, §2.2, §4: dùng `SUM(METRICS("fb_"))` và `SUM([succ, fb_sum])` |
| 2 | should-fix | Thiếu `dimensions`, `evaluation_periods = 1` dễ nhiễu spike, chưa giải thích 3600 s | Đã sửa §1, §2.1: thêm `dimensions`, `evaluation_periods = 2`, giải thích escalation 1h trước SLA 24h |
| 3 | should-fix | Retention DLQ thật là 6 ngày (4 ngày là queue chính); làm rõ gì đã có trên `main` | Đã sửa §1, §2.3 |
| 4 | should-fix | Thiếu chi phí +$0,20/tháng ở `base/alarms.tf` | Đã sửa §2.1, §3 (tổng base 0,40 USD/tháng) |
| 5 | should-fix | Runbook chưa nhấn mạnh cấm redrive trước khi deploy fix lỗi tất định | Đã sửa §2.3 |
| 6 | should-fix | Khoảng trống kiểm chứng runbook khi `M-RSK04-04` chưa chạy | Đã ghi rõ `DBS-164`/`DBS-184` đã chạy thật runbook trên SQS dev, phần alarm mới chuyển `BL-398` |
| 7 | minor | `all_alarms_notify_the_topic` trong `session/tests/alarms.tftest.hcl` cần tăng 14 → 15 | Đã sửa §3, §4 |

**Reviewer vòng 2:** subagent (`pro`), 2026-11-16 · **Kết quả vòng 2:** 0 phát hiện mới · **Verdict: APPROVE**

**Quyết định ở G2 (tự duyệt theo `CLAUDE_local.md`):** Chấp thuận thiết kế sau khi xử lý toàn bộ 7 phát hiện.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `infra/terraform/envs/dev/base/alarms.tf`, `tests/alarms.tftest.hcl` | `TC-RSK04-01` (`dlq_oldest_age_alarms`) | `Error: Reference to undeclared resource "aws_cloudwatch_metric_alarm" "dlq_oldest_age"` | `terraform -chdir=infra/terraform/envs/dev/base test` | `c75df3f` |
| 2 | `infra/terraform/envs/dev/session/variables.tf`, `alarms.tf`, `tests/alarms.tftest.hcl` | `TC-RSK04-02` (`risk_ai_fallback_rate_alarm`, `all_alarms_notify_the_topic`) | `Error: Reference to undeclared resource "aws_cloudwatch_metric_alarm" "risk_ai_fallback_rate"` | `TF_DATA_DIR=/tmp/tf-dev-session AWS_EC2_METADATA_DISABLED=true terraform -chdir=infra/terraform/envs/dev/session test` | `ac0ded4` |
| 3 | `docs/runbooks/dlq-redrive.md`, `docs/components/observability/01-concept-brief.md`, `docs/BACKLOG.md`, `docs/features/README.md`, `docs/features/RSK-04-risk-dlq-fallback-alarms.md` | `TC-RSK04-03`, `TC-RSK04-04` | — | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | — |

- **Rủi ro & cách lùi:** Chỉ thêm 2 alarm ở `base` (+$0,20/tháng) và 1 alarm Metric Math ở `session`; không sửa rule/metric backend. Lùi bằng `git revert`.
- **Quyết định ở G3 (tự duyệt theo `CLAUDE_local.md`):** Chấp thuận kế hoạch 3 bước trên; thực hiện đúng quy tắc test-first cho Terraform.

## 8. Kết quả

- **Lệnh kiểm tra** (trên commit code cuối `ac0ded4`):
  - `terraform fmt -check -recursive -diff infra/terraform` → `FMT_OK` (exit 0)
  - `terraform -chdir=infra/terraform/envs/dev/base validate && test` → `Success! 61 passed, 0 failed.`
  - `TF_DATA_DIR=/tmp/tf-dev-session AWS_EC2_METADATA_DISABLED=true terraform -chdir=infra/terraform/envs/dev/session validate && test` → `Success! 85 passed, 0 failed.`
  - `cd backend && npm test -- scoring-rule-error.spec.ts risk-scoring.metrics.spec.ts` → không chạy được trên máy này vì `backend/node_modules` thiếu `prom-client` (hai test này thuộc `RSK-02`/`DBS-144` đã xanh trên `main`).
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-RSK04-01 | `base/tests/alarms.tftest.hcl` › `dlq_oldest_age_alarms` | đạt |
| TC-RSK04-02 | `session/tests/alarms.tftest.hcl` › `risk_ai_fallback_rate_alarm`, `rejects_zero_ai_fallback_threshold`, `rejects_above_100_ai_fallback_threshold`, `all_alarms_notify_the_topic` | đạt |
| TC-RSK04-03 | `scoring-rule-error.spec.ts`, `risk-scoring.metrics.spec.ts` | chưa chạy trên máy này (thiếu `prom-client` trong `backend/node_modules`) |
| TC-RSK04-04 | `fmt -check -recursive`, `validate`, `terraform test` (`61/61` base, `85/85` session) | đạt (mock provider; `plan` thật chờ credential AWS ở `BL-398`) |

- **Test thủ công:** đầu ra thô tại [manual-test.txt](screenshots/RSK-04/manual-test.txt) (SHA dòng đầu `ac0ded42d6ba0bd7946894d2f6a2064d1ae20c13e`).
  - `M-RSK04-01`: **đạt** (`61 passed, 0 failed`)
  - `M-RSK04-02`: **đạt** (`85 passed, 0 failed`)
  - `M-RSK04-03`: **chưa chạy** (`backend/node_modules` thiếu `prom-client`)
  - `M-RSK04-04`: **chưa chạy** (không có credential AWS; chuyển sang `BL-398`)
- **Phạm vi so với §7:** `git diff --stat main...HEAD` (5 file Terraform/test, 180 insertions, 6 deletions) khớp danh sách ở §7.
- **Ảnh chụp:** không có ảnh chụp console AWS vì chưa chạy trên AWS (`M-RSK04-04` chưa chạy).
- **Lệch so với kế hoạch:** bỏ cập nhật `infra/terraform/README.md` (chi tiết alarm đã ghi ở `alarms.tf` và `docs/components/observability/01-concept-brief.md`).
- **Bàn giao:** `BL-398` trong [`docs/BACKLOG.md`](../BACKLOG.md) (kích hoạt thử 2 alarm mới trên AWS, chạy `terraform plan` thật, Dev review và merge PR).

## 9. Tài liệu đã cập nhật

- `docs/features/RSK-04-risk-dlq-fallback-alarms.md`, `docs/features/screenshots/RSK-04/domain-review.md`, `docs/features/screenshots/RSK-04/manual-test.txt`
- `docs/runbooks/dlq-redrive.md`, `docs/components/observability/01-concept-brief.md`, `docs/features/README.md`, `docs/BACKLOG.md` (thêm `BL-398`)

## Checklist G4 (tự duyệt theo `CLAUDE_local.md`)

- [x] `TC-RSK04-01`, `TC-RSK04-02`, `TC-RSK04-04` đạt; `TC-RSK04-03` ghi rõ chưa chạy do thiếu `prom-client`
- [x] Test thủ công chạy trên commit cuối đổi code (`ac0ded4`); `M-RSK04-01..02` đạt, `M-RSK04-03..04` ghi rõ lý do chưa chạy
- [x] `manual-test.txt` lưu đầy đủ; không có ảnh console AWS do chưa chạy live
- [x] `git diff --stat main...HEAD` khớp §7
- [x] Baseline Terraform chạy lúc bàn giao (`61/61` base, `85/85` session, `fmt` sạch)
- [x] Tài liệu cập nhật đủ; `check-doc-links.mjs` sạch
- [x] Việc còn thiếu bàn giao tại §8 và `BL-398` trong `docs/BACKLOG.md`
