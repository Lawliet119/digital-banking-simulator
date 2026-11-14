# Alarm CloudWatch của tài nguyên session (docs/03 §14, BL-051, BL-117, BL-127, BL-179, BL-181, BL-182, BL-188, BL-235, DBS-163, DBS-177).
# Dựng và xóa cùng phiên: tuổi queue, outbox, Redis, fallback, latency, 5xx đều vô nghĩa khi worker, Valkey, api không chạy, và
# alarm "thiếu dữ liệu = vi phạm" sẽ kêu mãi sau destroy. Alarm DLQ > 0 và topic SNS ở base/alarms.tf (sống qua destroy).
# Mọi alarm gửi vào topic SNS của base (`alarm_topic_arn`), cả lúc báo (alarm_actions) và lúc hết (ok_actions).
# Tag lấy từ default_tags của provider (locals.tags), alarm hỗ trợ tag nên không cần khai thêm.
#
# Chi phí: 15 alarm ở đây (+ 2 alarm DLQ ở base = 17). Alarm chuẩn 0,10 USD/alarm/tháng; alarm dùng biểu thức metric
# (SUM(METRICS()) / MAX(METRICS()) / công thức tỉ lệ) bị tính theo số metric được tham chiếu: `risk_rule_error` 6 metric,
# `read_latency_p95` 3 metric, `reconciliation`, `redis_fallback`, `rate_limited`, `api_5xx_rate` mỗi cái 2. Tổng cỡ
# 3,0 USD/tháng nếu chạy cả tháng; tính theo giờ nên phiên ngắn rẻ hơn nhiều.
#
# Dimension: bộ đếm của ứng dụng (MetricsService.writeCounters) chỉ xuất ở bộ `[Role, ...nhãn]`, KHÔNG có bộ `[]`; gauge
# thì ngược lại chỉ có bộ `[]` (outbox_oldest_unpublished_age_seconds, outbox_quarantined_events). Alarm phải khai đúng bộ dimension đó, nếu không
# sẽ không bao giờ có dữ liệu. Metric của worker mang `Role=worker`, của api mang `Role=api`.
#
# Alarm không dùng được SEARCH, nên metric có dimension thay đổi (Rule R1..R6, Status MISMATCH/ERROR, Scope ip/user,
# Role api/worker, các route đọc) được gộp bằng `SUM(METRICS())` hoặc `MAX(METRICS())` trên các metric khai tường minh.
# SUM/MAX bỏ qua chuỗi không có điểm dữ liệu, nên một bộ dimension chưa từng có số không làm alarm "thiếu dữ liệu".
#
# Metric kiểu sự kiện (lỗi luật, CONFIG_INVALID, đối soát, rate limit) chỉ có điểm dữ liệu khi sự kiện xảy ra rồi
# biến mất: cửa sổ 300 giây giữ alarm ở ALARM thêm vài phút để người nhận thư kịp thấy, không nhấp nháy ALARM/OK mỗi
# phút. Thư "OK" của các alarm này nghĩa là "5 phút qua không có sự kiện mới", KHÔNG phải "đã xử lý xong".

locals {
  alarm_actions = [local.base.alarm_topic_arn]

  # Role của tiến trình phát metric (APP_ROLE). Consumer risk, relay outbox và job đối soát chạy ở worker.
  alarm_role_worker = "worker"
  alarm_role_api    = "api"

  # Rule của risk (R1..R6, ADR-14).
  risk_rules = ["R1", "R2", "R3", "R4", "R5", "R6"]

  # Các route đọc (số dư, lịch sử) cho SLO latency đọc p95 < 150 ms (docs/03 §14, DBS-145).
  read_routes = {
    accounts     = "/v1/accounts"
    account      = "/v1/accounts/:id"
    transactions = "/v1/accounts/:id/transactions"
  }

  # Node chính của Valkey: nhóm một node có member `<replication_group_id>-001` (dev chạy 0 replica). Khi bật replica và
  # failover, node chính có thể là -002: cần thêm alarm cho node đó trước khi bật replica ở production.
  redis_node_id = "${aws_elasticache_replication_group.main.replication_group_id}-001"
}

# --- Queue chính: tuổi message cũ nhất (DBS-163, BL-182) -------------------------------------------------------------
# SLO < 60 s, alarm > 120 s (docs/03 §14). Một điểm 60 giây là đủ: metric đã là "tuổi" tích lũy, > 120 s nghĩa là consumer
# không lấy kịp hoặc worker treo/chết. Message độc đi hết 5 lần nhận trong ≈ 80 s rồi vào DLQ nên không tự làm alarm này
# kêu; message nhận từ lần thứ 3 không tính vào metric (queue standard, maxReceiveCount > 3, README). Queue rảnh quá 6 giờ
# ngừng phát metric: thiếu dữ liệu coi là không vi phạm (worker chết thì message nằm lại, queue vẫn phát số đo và tuổi tăng).
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each = toset(local.queue_names)

  alarm_name        = "${each.key}-age"
  alarm_description = "Message cũ nhất của queue ${each.key} chờ quá 120 giây (SLO 60 giây, docs/03 §14): consumer không theo kịp hoặc worker treo/chết. Xem service worker, log /dbs/dev/worker, rồi DLQ."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateAgeOfOldestMessage"
  dimensions  = { QueueName = each.key }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 120
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# --- Tuổi outbox chưa gửi cũ nhất (BL-182) ---------------------------------------------------------------------------
# SLO < 10 s, alarm > 30 s (docs/03 §14). Một lô relay có thể kéo dài tới 25 s (15 s ngân sách + 2 lần gửi 5 s, DBS-91 §2.8)
# và trong lúc đó các dòng của lô vẫn là `published_at IS NULL` (chưa COMMIT), nên gauge đọc được tuổi 25 s ở một worker
# khỏe mạnh khi SQS chậm. Vì thế KHÔNG alarm một điểm > 30 s. Alarm chỉ kêu khi 3 trong 5 phút liên tiếp (60 giây, thống kê
# Maximum) có tuổi > 30 s hoặc không có dữ liệu:
# - relay kẹt (lỗi UPDATE/COMMIT lặp lại, DBS-91 §2.9: cả lô gửi lại mỗi 5 giây) hay mất kết nối DB: tuổi chỉ tăng, vượt 30 s
#   ở mọi điểm sau đó, alarm kêu sau ≈ 3 phút;
# - lô chậm 25 s qua đi trong một phút, không đủ 3 điểm;
# - worker chết: không có dữ liệu (gauge báo 0 khi không có gì chờ, nên thiếu dữ liệu chỉ có nghĩa là worker không chạy) =
#   `breaching`. Cửa sổ 5 phút còn chịu được lúc ECS thay task worker (lăn 0%/100%, stopTimeout 60 s, task mới khởi động):
#   khoảng trống thường 2-3 phút; trống lâu hơn là đáng báo. Gauge ghi mỗi METRICS_FLUSH_MS = 60 s nên thi thoảng một phút
#   trống vì lệch nhịp: một phút trống không đủ để kêu.
# Hệ quả: alarm có độ trễ phát hiện cỡ 3 phút, không phải 30 giây; SLO 10 s xem trên dashboard.
# Khi session dựng với worker_desired_count = 0, alarm này kêu sau ≈ 3 phút (không có worker là không có dữ liệu).
resource "aws_cloudwatch_metric_alarm" "outbox_age" {
  alarm_name        = "dbs-dev-outbox-age"
  alarm_description = "Tuổi outbox chưa gửi cũ nhất > 30 giây trong 3 trên 5 phút, hoặc không có số đo: relay hoặc worker kẹt/chết (SLO 10 giây, docs/03 §14). Một lô relay bình thường chỉ tới 25 giây. Xem service worker, log /dbs/dev/worker và lỗi UPDATE/COMMIT của relay (DBS-91)."

  namespace   = var.metrics_namespace
  metric_name = "outbox_oldest_unpublished_age_seconds"

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 30
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# --- Sự kiện outbox bị cách ly (BL-181) -------------------------------------------------------------------------------
# Relay cách ly một sự kiện sau 5 lần gửi lỗi mà SQS từ chối vì chính nội dung (400/413, DBS-91 §2.4): dòng giữ
# `published_at IS NULL`, có `quarantined_at`, relay không chọn nó nữa và gauge `outbox_quarantined_events` đếm chúng.
# Bình thường bằng 0: mọi giá trị > 0 là có một sự kiện chuyển tiền hoặc đổi trạng thái tài khoản KHÔNG BAO GIỜ tới được
# consumer, nên một điểm là đủ báo, không cần cửa sổ nhiều điểm như alarm tuổi.
# Gauge giữ giá trị > 0 cho tới khi người vận hành xử lý (runbook trong README outbox: xem `last_error_code`, sửa nguyên
# nhân rồi `UPDATE ... SET quarantined_at = NULL, attempts = 0`), nên alarm ở ALARM tới lúc đó; không nhấp nháy.
# treat_missing_data = ignore: giữ nguyên trạng thái khi không có số đo. Không dùng `breaching` vì worker chết đã có
# alarm tuổi outbox (trùng báo), và không dùng `notBreaching` vì nó đưa alarm đang ALARM về OK chỉ vì worker khởi động
# lại hay gauge đọc lỗi một lúc, che mất sự kiện vẫn đang nằm trong cách ly.
resource "aws_cloudwatch_metric_alarm" "outbox_quarantined" {
  alarm_name        = "dbs-dev-outbox-quarantined"
  alarm_description = "Có sự kiện outbox bị relay cách ly vì SQS từ chối nội dung của nó (400/413) và sẽ không được gửi nữa: người dùng thiếu thông báo hoặc risk thiếu giao dịch. Xem log worker `Outbox event quarantined` và cột last_error_code, sửa nguyên nhân rồi đưa lại hàng đợi theo README outbox."

  namespace   = var.metrics_namespace
  metric_name = "outbox_quarantined_events"

  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "ignore"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# --- Risk: cấu hình AI hỏng và lỗi luật (BL-051, BL-188) -------------------------------------------------------------
# `CONFIG_INVALID` (ADR-14): khối `ai.*` của cấu hình hỏng nhưng vẫn lọt tới consumer; risk lưu quyết định `CONFIG_INVALID`
# và chấm tiếp R1-R6, không vào DLQ, nên chỉ metric này báo cho người vận hành. Bình thường bằng 0: mọi giá trị > 0 là báo.
# Đây cũng là cờ `aiConfigInvalid` của BL-188.
resource "aws_cloudwatch_metric_alarm" "risk_config_invalid" {
  alarm_name        = "dbs-dev-risk-config-invalid"
  alarm_description = "Risk lưu quyết định với AiStatus CONFIG_INVALID: khối ai.* của phiên bản cấu hình luật hỏng (ADR-14, BL-188). R1-R6 vẫn chấm nhưng AI không chạy. Tạo phiên bản cấu hình đúng rồi kích hoạt (UC-12)."

  namespace   = var.metrics_namespace
  metric_name = "risk_decision_total"
  dimensions  = { Role = local.alarm_role_worker, AiStatus = "CONFIG_INVALID" }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# Lỗi mã luật hoặc truy vấn feature (ADR-14): rollback, không ack, retry rồi vào DLQ sau ≈ 75-80 giây. Một lỗi tất định đưa
# MỌI event vào DLQ, nên alarm kêu sớm hơn alarm DLQ. Metric có dimension Rule (R1..R6): sáu metric khai tường minh gộp
# bằng SUM(METRICS()) (bộ dimension `[Role, Rule]`, không có bộ tổng).
resource "aws_cloudwatch_metric_alarm" "risk_rule_error" {
  alarm_name        = "dbs-dev-risk-rule-error"
  alarm_description = "Một luật risk (R1-R6) ném lỗi khi chấm điểm (risk_rule_error_total > 0): message bị rollback, retry, rồi vào DLQ risk-events-dlq. Xem log /dbs/dev/worker để biết Rule, sửa rồi redrive (docs/runbooks/dlq-redrive.md)."

  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    label       = "Lỗi luật R1-R6"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = local.risk_rules

    content {
      id          = lower(metric_query.value)
      return_data = false

      metric {
        namespace   = var.metrics_namespace
        metric_name = "risk_rule_error_total"
        dimensions  = { Role = local.alarm_role_worker, Rule = metric_query.value }
        period      = 300
        stat        = "Sum"
      }
    }
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# --- Đối soát sổ cái (BL-127, DBS-123) -------------------------------------------------------------------------------
# SLO: 0 lệch, mỗi lần chạy; alarm khi `MISMATCH` hoặc `ERROR` (docs/03 §14), trong 5 phút (DBS-123). Metric tăng sau khi
# job ghi `reconciliation_runs` và tới lượt ghi kế tiếp (≤ 60 giây), cộng chu kỳ đánh giá của alarm: báo trong vài phút. Lần
# chạy `OK` không gây gì. Đây là sự kiện hiếm nên điểm 300 giây giữ ALARM vài phút; kết quả thật xem bảng reconciliation_runs.
resource "aws_cloudwatch_metric_alarm" "reconciliation" {
  alarm_name        = "dbs-dev-reconciliation-failed"
  alarm_description = "Job đối soát sổ cái kết thúc với MISMATCH hoặc ERROR (reconciliation_runs_total, docs/03 §14, BL-127). Mở dòng mới nhất của reconciliation_runs để biết kiểm tra nào lệch; đây là sự cố tiền, không tự hết."

  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    label       = "Đối soát MISMATCH + ERROR"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = ["MISMATCH", "ERROR"]

    content {
      id          = lower(metric_query.value)
      return_data = false

      metric {
        namespace   = var.metrics_namespace
        metric_name = "reconciliation_runs_total"
        dimensions  = { Role = local.alarm_role_worker, Status = metric_query.value }
        period      = 300
        stat        = "Sum"
      }
    }
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# --- Redis (BL-117, BL-179, BL-235) ----------------------------------------------------------------------------------
# BL-117, "Redis không truy cập được > 1 phút" (docs/03 §14), hai tầng bổ sung nhau:
# 1) Node Valkey còn sống không: AWS/ElastiCache CPUUtilization của node chính, mỗi 60 giây. Node chết, đang failover hoặc
#    bị thay thì ElastiCache ngừng phát số đo: thiếu dữ liệu = `breaching`. Số đo thật không bao giờ > 100 nên alarm chỉ kêu
#    vì thiếu số đo (đây là "heartbeat", không phải cảnh báo CPU). 2 điểm 60 giây liên tiếp = quá 1 phút. Khi session mới
#    dựng alarm có thể kêu một lần cho tới khi Valkey phát điểm đầu tiên (vài phút).
# 2) App có nói chuyện được với Redis không (SG, AUTH, TLS, mạng): alarm `redis_fallback` bên dưới.
resource "aws_cloudwatch_metric_alarm" "redis_node_missing" {
  alarm_name        = "dbs-dev-redis-node-missing"
  alarm_description = "Node Valkey ${local.redis_node_id} không phát số đo trong 2 phút liên tiếp (chết, đang failover hoặc bị thay): Redis không truy cập được > 1 phút (docs/03 §14, BL-117). API fail-open rate limit và rơi về DB cho phần thu hồi phiên; kiểm ElastiCache và log api."

  namespace   = "AWS/ElastiCache"
  metric_name = "CPUUtilization"
  dimensions  = { CacheClusterId = local.redis_node_id }

  statistic           = "Average"
  period              = 60
  evaluation_periods  = 2
  threshold           = 100
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# BL-179: `redis_fallback_total` (api và worker; bộ dimension `[Role]`) đếm số lần một thao tác Redis lỗi và ứng dụng rơi về
# đường dự phòng (rate limit mở, thu hồi phiên đọc DB, ...). Khi Redis khỏe nó bằng 0 và một lần chớp ngắn tạo vài lần đếm,
# nên ngưỡng là "có lần đếm nào ở 2 phút 60 giây liên tiếp" (> 1 phút kéo dài), không phải "có một lần". Gộp api và worker.
resource "aws_cloudwatch_metric_alarm" "redis_fallback" {
  alarm_name        = "dbs-dev-redis-fallback"
  alarm_description = "Ứng dụng rơi về đường dự phòng vì Redis lỗi ở 2 phút liên tiếp (redis_fallback_total > 0, api + worker, BL-179). Redis chậm, quá tải hoặc không với tới được: kiểm Valkey, SG, AUTH token. Dịch vụ vẫn chạy (fail-open) nhưng không có rate limit."

  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    label       = "Redis fallback (api + worker)"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = [local.alarm_role_api, local.alarm_role_worker]

    content {
      id          = metric_query.value
      return_data = false

      metric {
        namespace   = var.metrics_namespace
        metric_name = "redis_fallback_total"
        dimensions  = { Role = metric_query.value }
        period      = 60
        stat        = "Sum"
      }
    }
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# BL-235: `risk_config_redis_fallback_total` (worker): cache cấu hình luật ở Redis lỗi nên risk đọc thẳng DB. Cùng quy tắc với
# alarm trên (2 phút liên tiếp), chỉ worker phát metric này nên khai Role=worker.
resource "aws_cloudwatch_metric_alarm" "risk_config_redis_fallback" {
  alarm_name        = "dbs-dev-risk-config-redis-fallback"
  alarm_description = "Risk đọc cấu hình luật thẳng từ DB vì cache Redis lỗi ở 2 phút liên tiếp (risk_config_redis_fallback_total > 0, BL-235). Chấm điểm vẫn đúng nhưng chậm hơn; kiểm Valkey như alarm redis-fallback."

  namespace   = var.metrics_namespace
  metric_name = "risk_config_redis_fallback_total"
  dimensions  = { Role = local.alarm_role_worker }

  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# BL-179: request bị rate limit (`rate_limited_total`, api, Scope ip và user). Khách bình thường hiếm khi chạm giới hạn; số
# lớn nghĩa là bị tấn công/script lỗi hoặc cấu hình sai: đặc biệt nếu TRUST_PROXY_HOPS sai thì mọi khách có cùng IP (của ALB)
# và bị giới hạn chung. Ngưỡng 50 lần mỗi 5 phút là ước lượng cho dev, chưa đo trên tải thật (BL-179 còn kiểm trên ALB thật):
# điều chỉnh sau lần chạy tải đầu. Test tải (k6, BL-232) sẽ làm alarm này kêu, đó là chủ ý.
resource "aws_cloudwatch_metric_alarm" "rate_limited" {
  alarm_name        = "dbs-dev-rate-limited"
  alarm_description = "Hơn 50 request bị rate limit (429) trong 5 phút (rate_limited_total, scope ip + user, BL-179). Tấn công, script lỗi, hoặc TRUST_PROXY_HOPS sai làm mọi khách chung một IP. Xem log api (không có IP khách trong metric)."

  threshold           = 50
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    label       = "Bị rate limit (ip + user)"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = ["ip", "user"]

    content {
      id          = metric_query.value
      return_data = false

      metric {
        namespace   = var.metrics_namespace
        metric_name = "rate_limited_total"
        dimensions  = { Role = local.alarm_role_api, Scope = metric_query.value }
        period      = 300
        stat        = "Sum"
      }
    }
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# --- SLO API 5xx, latency chuyển tiền, latency đọc, thời gian tới cờ (DBS-177, docs/03 §14) -------------------------
# Tỉ lệ 5xx > 1% trong 5 phút. Dùng bộ dimension tổng `[]` của DBS-144 (không chứa probe `/health/*`, không tính 422/429).
# `IF(mr > 0, ...)` tránh chia 0 nếu có điểm request = 0; khi idle không có điểm, `notBreaching` giữ alarm ở OK.
resource "aws_cloudwatch_metric_alarm" "api_5xx_rate" {
  alarm_name        = "dbs-dev-api-5xx-rate"
  alarm_description = "Tỉ lệ lỗi 5xx của API > 1% trong 5 phút (SLO >= 99,9%, docs/03 §14; không tính 422, 429 và /health/*). Kiểm log /dbs/dev/api, RDS và Valkey."

  threshold           = 1
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "rate"
    expression  = "IF(mr > 0, 100 * FILL(m5, 0) / mr, 0)"
    label       = "Tỉ lệ 5xx (%)"
    return_data = true
  }

  metric_query {
    id          = "m5"
    return_data = false

    metric {
      namespace   = var.metrics_namespace
      metric_name = "http_5xx_total"
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "mr"
    return_data = false

    metric {
      namespace   = var.metrics_namespace
      metric_name = "http_requests_total"
      period      = 300
      stat        = "Sum"
    }
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# Latency chuyển tiền POST /v1/transfers: SLO p95 < 300 ms, alarm khi p95 > 300 ms trong 3 cửa sổ 5 phút liên tiếp.
# Yêu cầu 3 cửa sổ liên tiếp giúp tránh nhiễu do CloudWatch ước lượng phân vị quanh biên bucket 300 ms (observability).
resource "aws_cloudwatch_metric_alarm" "transfer_latency_p95" {
  alarm_name        = "dbs-dev-transfer-latency-p95"
  alarm_description = "Latency chuyển tiền POST /v1/transfers p95 > 300 ms trong 3 cửa sổ 5 phút liên tiếp (SLO p95 < 300 ms, docs/03 §14). Kiểm RDS, khóa hàng và log /dbs/dev/api."

  namespace   = var.metrics_namespace
  metric_name = "http_request_duration_ms"
  dimensions  = { Route = "/v1/transfers", Method = "POST" }

  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# Latency đọc (số dư, lịch sử): SLO p95 < 150 ms, alarm khi p95 > 150 ms trong 3 cửa sổ 5 phút liên tiếp.
# Gộp 3 route đọc bằng MAX(METRICS()) để bất kỳ endpoint đọc nào vượt ngưỡng đều báo mà không nhân 3 số alarm.
resource "aws_cloudwatch_metric_alarm" "read_latency_p95" {
  alarm_name        = "dbs-dev-read-latency-p95"
  alarm_description = "Latency đọc (GET /v1/accounts, /:id, /:id/transactions) p95 > 150 ms trong 3 cửa sổ 5 phút liên tiếp (SLO p95 < 150 ms, docs/03 §14). Kiểm RDS và log /dbs/dev/api."

  threshold           = 150
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "max_p95"
    expression  = "MAX(METRICS())"
    label       = "Đọc p95 lớn nhất (ms)"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = local.read_routes

    content {
      id          = metric_query.key
      return_data = false

      metric {
        namespace   = var.metrics_namespace
        metric_name = "http_request_duration_ms"
        dimensions  = { Route = metric_query.value, Method = "GET" }
        period      = 300
        stat        = "p95"
      }
    }
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# Thời gian từ giao dịch tới khi có cờ gian lận: SLO p95 < 5 giây trong cửa sổ 15 phút (900 s).
# Worker phát `risk_transfer_to_flag_ms` với dimension [Role] (Role=worker).
resource "aws_cloudwatch_metric_alarm" "transfer_to_flag_p95" {
  alarm_name        = "dbs-dev-transfer-to-flag-p95"
  alarm_description = "Thời gian từ giao dịch tới khi có cờ gian lận p95 > 5 giây trong 15 phút (SLO < 5 s, docs/03 §14). Kiểm worker risk, queue risk-events và truy vấn feature trên RDS."

  namespace   = var.metrics_namespace
  metric_name = "risk_transfer_to_flag_ms"
  dimensions  = { Role = local.alarm_role_worker }

  extended_statistic  = "p95"
  period              = 900
  evaluation_periods  = 1
  threshold           = 5000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}
