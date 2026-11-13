# DBS-145: dashboard CloudWatch bản đầu cho các metric của DBS-144 (docs/03 §14, observability).
# Nằm ở session: dựng và xóa cùng phiên. Không tham chiếu tài nguyên nào của session, nên
# `terraform apply -target=aws_cloudwatch_dashboard.overview` chỉ tạo đúng dashboard này.
# Đường kẻ ngang là ngưỡng SLO để nhìn; alarm nằm ở alarms.tf (và base/alarms.tf cho DLQ).
# Widget hạ tầng (ECS, RDS, Valkey, ALB, BL-261) CỐ Ý nằm ở dashboard riêng `dbs-dev-infra` (dashboard_infra.tf): chúng
# phải tham chiếu aws_lb, aws_db_instance... (ALB cần arn_suffix, không dựng được từ chuỗi biết trước), còn dashboard này
# giữ tính chất không tham chiếu tài nguyên session để `-target` được. Tài khoản có 3 dashboard miễn phí.
# aws_cloudwatch_dashboard không hỗ trợ tag; chi phí được kiểm soát bằng việc xóa cùng phiên.

locals {
  dash_ns     = var.metrics_namespace
  dash_region = var.region

  # Tên DLQ lấy từ base; queue chính là tên DLQ bỏ hậu tố -dlq (base/sqs.tf).
  dlq_names   = sort(values(local.base.sqs_dlq_names))
  queue_names = [for n in local.dlq_names : trimsuffix(n, "-dlq")]

  dash_text = join("\n", [
    "## DBS dev: sức khỏe hệ thống",
    "Metric từ ứng dụng nằm trong namespace `${local.dash_ns}` (CloudWatch EMF, DBS-144); DLQ và tuổi message lấy từ `AWS/SQS`. Đường kẻ ngang là ngưỡng SLO ở docs/03 mục 14, không phải alarm.",
    "- **Phân vị** do CloudWatch ước lượng quanh biên bucket (150, 300, 1000 ms): sai khác vài phần trăm. Cửa sổ 5 phút cho độ trễ và 5xx như SLO.",
    "- **Lỗi = 5xx**; 422 và 429 không tính. Tỉ lệ 5xx tính trên bộ dimension tổng, không có probe `/health/*`.",
    "- **Tuổi outbox** dùng `Maximum`. Không có điểm dữ liệu nghĩa là worker không chạy (không phải 0).",
    "- Chỉ vẽ `Role` `api` và `worker`. Widget trống là chưa có nguồn: `risk_redis_fallback_total` chờ consumer risk nối đủ (BL-204); `risk_decision_total`, `risk_rule_error_total`, `risk_transfer_to_flag_ms` và `reconciliation_runs_total` chỉ có khi worker chạy và đã có dòng sự kiện (metric đếm sự kiện không có điểm khi không có sự kiện).",
    "- ECS, RDS, Valkey và ALB ở dashboard `dbs-dev-infra`. Alarm: xem `alarms.tf`.",
  ])

  # Một dòng metric (namespace, tên, các cặp dimension, tùy chọn).
  w_text = {
    type   = "text"
    x      = 0
    y      = 0
    width  = 24
    height = 4
    properties = {
      markdown = local.dash_text
    }
  }

  w_overall = {
    type   = "metric"
    x      = 0
    y      = 4
    width  = 12
    height = 6
    properties = {
      title  = "Độ trễ toàn dịch vụ (ms)"
      region = local.dash_region
      view   = "timeSeries"
      period = 300
      metrics = [
        [local.dash_ns, "http_request_duration_ms", { stat = "p50", label = "p50" }],
        [local.dash_ns, "http_request_duration_ms", { stat = "p95", label = "p95" }],
        [local.dash_ns, "http_request_duration_ms", { stat = "p99", label = "p99" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  w_transfer = {
    type   = "metric"
    x      = 12
    y      = 4
    width  = 12
    height = 6
    properties = {
      title  = "Chuyển tiền POST /v1/transfers: p95 và p99 (ms)"
      region = local.dash_region
      view   = "timeSeries"
      period = 300
      metrics = [
        [local.dash_ns, "http_request_duration_ms", "Route", "/v1/transfers", "Method", "POST", { stat = "p95", label = "p95" }],
        [local.dash_ns, "http_request_duration_ms", "Route", "/v1/transfers", "Method", "POST", { stat = "p99", label = "p99" }],
      ]
      annotations = {
        horizontal = [
          { label = "SLO p95 300 ms", value = 300 },
          { label = "SLO p99 1 s", value = 1000 },
        ]
      }
      yAxis = { left = { min = 0 } }
    }
  }

  w_reads = {
    type   = "metric"
    x      = 0
    y      = 10
    width  = 8
    height = 6
    properties = {
      title  = "Đọc: p95 (ms)"
      region = local.dash_region
      view   = "timeSeries"
      period = 300
      metrics = [
        [local.dash_ns, "http_request_duration_ms", "Route", "/v1/accounts", "Method", "GET", { stat = "p95", label = "GET /v1/accounts" }],
        [local.dash_ns, "http_request_duration_ms", "Route", "/v1/accounts/:id", "Method", "GET", { stat = "p95", label = "GET /v1/accounts/:id" }],
        [local.dash_ns, "http_request_duration_ms", "Route", "/v1/accounts/:id/transactions", "Method", "GET", { stat = "p95", label = "GET .../transactions" }],
      ]
      annotations = {
        horizontal = [{ label = "SLO đọc p95 150 ms", value = 150 }]
      }
      yAxis = { left = { min = 0 } }
    }
  }

  w_errors = {
    type   = "metric"
    x      = 8
    y      = 10
    width  = 8
    height = 6
    properties = {
      title  = "Tỉ lệ 5xx (%)"
      region = local.dash_region
      view   = "timeSeries"
      period = 300
      metrics = [
        [local.dash_ns, "http_5xx_total", { id = "m5", stat = "Sum", visible = false }],
        [local.dash_ns, "http_requests_total", { id = "mr", stat = "Sum", visible = false }],
        [{ expression = "100 * FILL(m5, 0) / mr", label = "5xx %", id = "e1" }],
      ]
      annotations = {
        horizontal = [{ label = "Báo động 5xx > 1%", value = 1 }]
      }
      yAxis = { left = { min = 0 } }
    }
  }

  w_volume = {
    type   = "metric"
    x      = 16
    y      = 10
    width  = 8
    height = 6
    properties = {
      title  = "Request, 5xx, bị ngắt"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        [local.dash_ns, "http_requests_total", { stat = "Sum", label = "request" }],
        [local.dash_ns, "http_5xx_total", { stat = "Sum", label = "5xx" }],
        [local.dash_ns, "http_aborted_total", { stat = "Sum", label = "bị ngắt" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  w_routes = {
    type   = "metric"
    x      = 0
    y      = 16
    width  = 8
    height = 6
    properties = {
      title  = "p95 theo Route (ms)"
      region = local.dash_region
      view   = "timeSeries"
      period = 300
      metrics = [
        [{ expression = "SEARCH('{\"${local.dash_ns}\",Method,Route} MetricName=\"http_request_duration_ms\" NOT Route=\"/health/live\" NOT Route=\"/health/ready\"', 'p95', 300)", id = "s1" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  w_outbox = {
    type   = "metric"
    x      = 8
    y      = 16
    width  = 8
    height = 6
    properties = {
      title  = "Tuổi outbox chưa gửi cũ nhất (giây)"
      region = local.dash_region
      view   = "timeSeries"
      stat   = "Maximum"
      period = 60
      metrics = [
        [local.dash_ns, "outbox_oldest_unpublished_age_seconds", { stat = "Maximum", label = "tuổi" }],
      ]
      annotations = {
        horizontal = [
          { label = "SLO 10 s", value = 10 },
          { label = "Báo động 30 s", value = 30 },
        ]
      }
      yAxis = { left = { min = 0 } }
    }
  }

  w_dlq = {
    type   = "metric"
    x      = 16
    y      = 16
    width  = 8
    height = 6
    properties = {
      title  = "DLQ: số message"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        for n in local.dlq_names :
        ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", n, { stat = "Maximum", label = n }]
      ]
      annotations = {
        horizontal = [{ label = "DLQ > 0", value = 1 }]
      }
      yAxis = { left = { min = 0 } }
    }
  }

  w_age = {
    type   = "metric"
    x      = 0
    y      = 22
    width  = 8
    height = 6
    properties = {
      title  = "Tuổi message cũ nhất (giây)"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        for n in local.queue_names :
        ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", n, { stat = "Maximum", label = n }]
      ]
      annotations = {
        horizontal = [
          { label = "SLO 60 s", value = 60 },
          { label = "Báo động 120 s", value = 120 },
        ]
      }
      yAxis = { left = { min = 0 } }
    }
  }

  w_redis = {
    type   = "metric"
    x      = 8
    y      = 22
    width  = 8
    height = 6
    properties = {
      title  = "Redis fallback"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        [local.dash_ns, "redis_fallback_total", "Role", "api", { stat = "Sum", label = "api" }],
        [local.dash_ns, "redis_fallback_total", "Role", "worker", { stat = "Sum", label = "worker" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  w_rate = {
    type   = "metric"
    x      = 16
    y      = 22
    width  = 8
    height = 6
    properties = {
      title  = "Request bị rate limit"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        [local.dash_ns, "rate_limited_total", "Role", "api", "Scope", "ip", { stat = "Sum", label = "theo IP" }],
        [local.dash_ns, "rate_limited_total", "Role", "api", "Scope", "user", { stat = "Sum", label = "theo user" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  w_risk = {
    type   = "metric"
    x      = 0
    y      = 28
    width  = 24
    height = 6
    properties = {
      title  = "Risk: fallback Redis"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        [{ expression = "SEARCH('{\"${local.dash_ns}\",Role} MetricName=\"risk_config_redis_fallback_total\"', 'Sum', 60)", id = "s2" }],
        [{ expression = "SEARCH('{\"${local.dash_ns}\",Role,Rule,Reason} MetricName=\"risk_redis_fallback_total\"', 'Sum', 60)", id = "s3" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  # BL-127: kết quả đối soát (dimension Status của reconciliation_runs_total). Chỉ có điểm khi job vừa chạy.
  w_recon = {
    type   = "metric"
    x      = 0
    y      = 34
    width  = 8
    height = 6
    properties = {
      title  = "Đối soát sổ cái: số lần chạy theo kết quả"
      region = local.dash_region
      view   = "timeSeries"
      period = 300
      metrics = [
        [local.dash_ns, "reconciliation_runs_total", "Role", "worker", "Status", "OK", { stat = "Sum", label = "OK" }],
        [local.dash_ns, "reconciliation_runs_total", "Role", "worker", "Status", "MISMATCH", { stat = "Sum", label = "MISMATCH" }],
        [local.dash_ns, "reconciliation_runs_total", "Role", "worker", "Status", "ERROR", { stat = "Sum", label = "ERROR" }],
      ]
      annotations = {
        horizontal = [{ label = "Báo động: MISMATCH/ERROR > 0", value = 0 }]
      }
      yAxis = { left = { min = 0 } }
    }
  }

  # BL-051, BL-188: quyết định CONFIG_INVALID và lỗi luật R1..R6 (alarm cùng tên trong alarms.tf).
  w_risk_health = {
    type   = "metric"
    x      = 8
    y      = 34
    width  = 8
    height = 6
    properties = {
      title  = "Risk: CONFIG_INVALID và lỗi luật"
      region = local.dash_region
      view   = "timeSeries"
      period = 300
      metrics = [
        [local.dash_ns, "risk_decision_total", "Role", "worker", "AiStatus", "CONFIG_INVALID", { stat = "Sum", label = "CONFIG_INVALID" }],
        [{ expression = "SEARCH('{\"${local.dash_ns}\",Role,Rule} MetricName=\"risk_rule_error_total\"', 'Sum', 300)", id = "s4" }],
      ]
      annotations = {
        horizontal = [{ label = "Báo động > 0", value = 0 }]
      }
      yAxis = { left = { min = 0 } }
    }
  }

  # docs/03 §14: thời gian từ giao dịch tới khi có cờ, p95 < 5 giây trong 15 phút (chưa có alarm).
  w_flag = {
    type   = "metric"
    x      = 16
    y      = 34
    width  = 8
    height = 6
    properties = {
      title  = "Thời gian giao dịch tới cờ: p95 (ms)"
      region = local.dash_region
      view   = "timeSeries"
      period = 900
      metrics = [
        [local.dash_ns, "risk_transfer_to_flag_ms", "Role", "worker", { stat = "p95", label = "p95" }],
      ]
      annotations = {
        horizontal = [{ label = "SLO p95 5 s", value = 5000 }]
      }
      yAxis = { left = { min = 0 } }
    }
  }

  dashboard_body = {
    start          = "-PT3H"
    periodOverride = "inherit"
    widgets = [
      local.w_text, local.w_overall, local.w_transfer, local.w_reads, local.w_errors, local.w_volume,
      local.w_routes, local.w_outbox, local.w_dlq, local.w_age, local.w_redis, local.w_rate, local.w_risk,
      local.w_recon, local.w_risk_health, local.w_flag,
    ]
  }
}

resource "aws_cloudwatch_dashboard" "overview" {
  dashboard_name = "dbs-dev-overview"
  dashboard_body = jsonencode(local.dashboard_body)
}
