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

  # DBS-178: 16 alarm đơn của alarms.tf viết tường minh (KHÔNG tham chiếu aws_cloudwatch_metric_alarm: giữ `-target` được). Hai alarm tuổi
  # hàng chính và hai alarm DLQ rỗng dựng từ tên queue của base. Không có `dlq-oldest-age`: chưa apply ở base (BL-409), thêm khi apply.
  # Test `load-tests/test/dashboard-snapshot.test.mjs` (TC-178-20) và `tests/dashboard.tftest.hcl` kiểm danh sách này khớp alarms.tf.
  dash_alarm_names = concat(
    [
      "dbs-dev-outbox-age",
      "dbs-dev-outbox-quarantined",
      "dbs-dev-risk-config-invalid",
      "dbs-dev-risk-rule-error",
      "dbs-dev-risk-ai-fallback-rate",
      "dbs-dev-risk-flag-rate",
      "dbs-dev-reconciliation-failed",
      "dbs-dev-redis-node-missing",
      "dbs-dev-redis-fallback",
      "dbs-dev-risk-config-redis-fallback",
      "dbs-dev-risk-config-freshness",
      "dbs-dev-rate-limited",
      "dbs-dev-api-5xx-rate",
      "dbs-dev-transfer-latency-p95",
      "dbs-dev-read-latency-p95",
      "dbs-dev-transfer-to-flag-p95",
    ],
    [for n in local.queue_names : "${n}-age"],
    [for k in sort(keys(local.base.sqs_dlq_names)) : "dbs-dev-${k}-dlq-not-empty"],
  )

  dash_alarm_arns = [for n in local.dash_alarm_names : "arn:aws:cloudwatch:${local.dash_region}:${var.account_id}:alarm:${n}"]

  dash_intro = join("\n", [
    "## DBS dev: sức khỏe hệ thống",
    "Namespace `${local.dash_ns}` (EMF, DBS-144) và `AWS/SQS`. Đường kẻ ngang là ngưỡng SLO (docs/03 mục 14), không phải alarm. Cách đọc và giới hạn: cuối trang.",
  ])

  dash_text = join("\n", [
    "### Cách đọc",
    "- **Trạng thái:** widget alarm liệt kê 20 alarm theo tên (không gồm `dlq-oldest-age`, chưa apply ở base, BL-409). Probe `/health/ready` đếm request và 5xx của ALB vào task api: 5xx là PostgreSQL không sẵn sàng (503). **Redis chết KHÔNG làm probe lỗi**: `/health/ready` vẫn trả 200 với `redis: degraded`, nên Redis chết hiện ở `redis_fallback_total` (widget `Redis fallback`), không ở probe. Số fallback của api còn gồm cả lượt `ping` của chính probe. Không có điểm dữ liệu ở probe nghĩa là chưa có request tới api, không phải «khỏe». Số task khỏe sau ALB ở dashboard `dbs-dev-infra`.",
    "- **Phân vị** do CloudWatch ước lượng quanh biên bucket (150, 300, 1000 ms): sai khác vài phần trăm. Cửa sổ 5 phút cho độ trễ và 5xx như SLO.",
    "- **Lỗi = 5xx**; 422 và 429 không tính. Tỉ lệ 5xx tính trên bộ dimension tổng, không có probe `/health/*`.",
    "- **Tuổi outbox** dùng `Maximum`. Không có điểm dữ liệu nghĩa là worker không chạy (không phải 0).",
    "- Chỉ vẽ `Role` `api` và `worker`. Widget trống là chưa có nguồn: `risk_decision_total`, `risk_rule_error_total`, `risk_transfer_to_flag_ms` và `reconciliation_runs_total` chỉ có khi worker chạy và đã có dòng sự kiện (metric đếm sự kiện không có điểm khi không có sự kiện).",
    "- **Cờ / 1.000 giao dịch (DBS-187):** hai ô số là tổng trượt thật của 1 giờ và 24 giờ gần nhất (khoảng thời gian riêng của widget); đường xu hướng dùng bucket 3600 s, không trượt từng phút. Có quyết định mà không có cờ thì hiển thị 0 nhờ `FILL`; widget trống là worker chưa chạy. Chưa kiểm trên console AWS.",
    "- ECS, RDS, Valkey và ALB ở dashboard `dbs-dev-infra`. Alarm: xem `alarms.tf`.",
  ])

  # Một dòng metric (namespace, tên, các cặp dimension, tùy chọn).
  w_intro = {
    type   = "text"
    x      = 0
    y      = 0
    width  = 24
    height = 2
    properties = {
      markdown = local.dash_intro
    }
  }

  # Tiêu đề nhóm (DBS-178): cao 1, rộng 24, ngay trên hàng widget của nhóm.
  w_h_status = {
    type       = "text"
    x          = 0
    y          = 2
    width      = 24
    height     = 1
    properties = { markdown = "### 1. Trạng thái: alarm và health" }
  }

  w_h_api = {
    type       = "text"
    x          = 0
    y          = 10
    width      = 24
    height     = 1
    properties = { markdown = "### 2. API: lưu lượng, độ trễ, lỗi (SLO docs/03 §14)" }
  }

  w_h_queue = {
    type       = "text"
    x          = 0
    y          = 29
    width      = 24
    height     = 1
    properties = { markdown = "### 3. Hàng đợi, outbox, DLQ" }
  }

  w_h_redis = {
    type       = "text"
    x          = 0
    y          = 42
    width      = 24
    height     = 1
    properties = { markdown = "### 4. Redis, giới hạn tốc độ, đối soát" }
  }

  w_h_fraud = {
    type       = "text"
    x          = 0
    y          = 49
    width      = 24
    height     = 1
    properties = { markdown = "### 5. Cảnh báo gian lận (fraud)" }
  }

  w_notes = {
    type   = "text"
    x      = 0
    y      = 68
    width  = 24
    height = 7
    properties = {
      markdown = local.dash_text
    }
  }

  # DBS-178: trạng thái health, phần 1. Widget `alarm` không phải metric nên không có `region`; ARN đã mang vùng và tài khoản.
  w_alarms = {
    type   = "alarm"
    x      = 0
    y      = 3
    width  = 14
    height = 7
    properties = {
      title  = "Trạng thái alarm SLO"
      alarms = local.dash_alarm_arns
    }
  }

  # DBS-178: trạng thái health, phần 2. `/health/*` chỉ được app ghi ở bộ `[Route, Method]` (http-stats.ts), không có `Role` và không có bộ
  # tổng: dòng metric khai đúng hai cặp đó. ALB gọi `/health/ready` mỗi 15 giây; 503 là PostgreSQL không sẵn sàng, Redis chết vẫn trả 200.
  w_health = {
    type   = "metric"
    x      = 14
    y      = 3
    width  = 10
    height = 7
    properties = {
      title  = "Health: probe /health/ready (request và 5xx)"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        [local.dash_ns, "http_requests_total", "Route", "/health/ready", "Method", "GET", { stat = "Sum", label = "request" }],
        [local.dash_ns, "http_5xx_total", "Route", "/health/ready", "Method", "GET", { stat = "Sum", label = "5xx (503 = PostgreSQL không sẵn sàng)" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  # DBS-178: `rq` là http_requests_total bộ `[]` (tổng, không gồm probe `/health/*`); chia cho PERIOD() ra request/giây.
  w_rps = {
    type   = "metric"
    x      = 0
    y      = 17
    width  = 8
    height = 6
    properties = {
      title  = "Lưu lượng: request mỗi giây"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        [local.dash_ns, "http_requests_total", { id = "rq", stat = "Sum", visible = false }],
        [{ expression = "rq / PERIOD(rq)", label = "request/giây", id = "rps" }],
      ]
      annotations = {
        horizontal = [{ label = "Mức tải 120 RPS", value = 120 }]
      }
      yAxis = { left = { min = 0 } }
    }
  }

  # DBS-178: độ sâu hàng đợi chính. Hai hàng chính là tên DLQ bỏ hậu tố `-dlq`. docs/03 §14 không có SLO độ sâu (chỉ tuổi và DLQ), nên không đường kẻ.
  w_queue_depth = {
    type   = "metric"
    x      = 0
    y      = 30
    width  = 8
    height = 6
    properties = {
      title  = "Độ sâu hàng đợi chính (chờ xử lý và đang xử lý)"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = concat(
        [
          for n in local.queue_names :
          ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", n, { stat = "Maximum", label = "${n} chờ xử lý" }]
        ],
        [
          for n in local.queue_names :
          ["AWS/SQS", "ApproximateNumberOfMessagesNotVisible", "QueueName", n, { stat = "Maximum", label = "${n} đang xử lý" }]
        ],
      )
      yAxis = { left = { min = 0 } }
    }
  }

  # DBS-178: message mà consumer đã retry hoặc đưa vào DLQ (BL-209). `[Role, Consumer, Outcome]` đúng bộ MetricsService ghi. Báo trước DLQ.
  w_consumer = {
    type   = "metric"
    x      = 12
    y      = 36
    width  = 12
    height = 6
    properties = {
      title  = "Consumer: message retry và dead_letter"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        [{ expression = "SEARCH('{\"${local.dash_ns}\",Role,Consumer,Outcome} MetricName=\"consumer_message_total\"', 'Sum', 60)", id = "s5" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  # DBS-178: khối lượng quyết định chấm điểm theo AiStatus: mẫu số của cờ/1.000 giao dịch, và nơi thấy fallback AI (alarm risk-ai-fallback-rate).
  w_risk_decisions = {
    type   = "metric"
    x      = 16
    y      = 56
    width  = 8
    height = 6
    properties = {
      title  = "Risk: quyết định chấm điểm theo AiStatus"
      region = local.dash_region
      view   = "timeSeries"
      period = 300
      metrics = [
        [{ expression = "SEARCH('{\"${local.dash_ns}\",Role,AiStatus} MetricName=\"risk_decision_total\"', 'Sum', 300)", id = "s6" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  w_overall = {
    type   = "metric"
    x      = 16
    y      = 17
    width  = 8
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
    x      = 0
    y      = 11
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
    x      = 8
    y      = 17
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
    x      = 12
    y      = 11
    width  = 12
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
    x      = 0
    y      = 23
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
    x      = 8
    y      = 23
    width  = 16
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
    x      = 16
    y      = 30
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
    x      = 0
    y      = 36
    width  = 12
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
    x      = 8
    y      = 30
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
    x      = 0
    y      = 43
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
    x      = 8
    y      = 43
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
    x      = 16
    y      = 62
    width  = 8
    height = 6
    properties = {
      title  = "Risk: fallback Redis của cấu hình luật"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        [{ expression = "SEARCH('{\"${local.dash_ns}\",Role,Reason} MetricName=\"risk_config_redis_fallback_total\"', 'Sum', 60)", id = "s2" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  # BL-127: kết quả đối soát (dimension Status của reconciliation_runs_total). Chỉ có điểm khi job vừa chạy.
  w_recon = {
    type   = "metric"
    x      = 16
    y      = 43
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
    y      = 62
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
    x      = 0
    y      = 62
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

  # DBS-187: cờ trên 1.000 giao dịch. f = risk_flag_total, d = risk_decision_total, cả hai bộ `[Role]` (tổng, không nhãn);
  # `FILL(f, 0)` vì app không phát dòng khi không có cờ. Ô số: tổng trượt thật nhờ `setPeriodToTimeRange` và khoảng thời
  # gian riêng của widget; metric math của CloudWatch không có hàm dịch thời gian nên không dựng được trượt bằng đường.
  w_flag_rate_1h = {
    type   = "metric"
    x      = 0
    y      = 50
    width  = 6
    height = 6
    properties = {
      title                = "Cờ / 1.000 giao dịch, 1 giờ gần nhất"
      region               = local.dash_region
      view                 = "singleValue"
      setPeriodToTimeRange = true
      start                = "-PT1H"
      end                  = "P0D"
      metrics = [
        [local.dash_ns, "risk_flag_total", "Role", "worker", { id = "f", stat = "Sum", visible = false }],
        [local.dash_ns, "risk_decision_total", "Role", "worker", { id = "d", stat = "Sum", visible = false }],
        [{ expression = "IF(d > 0, 1000 * FILL(f, 0) / d, 0)", label = "Cờ / 1.000 giao dịch (SLO ≤ 20)", id = "r" }],
      ]
    }
  }

  w_flag_rate_24h = {
    type   = "metric"
    x      = 6
    y      = 50
    width  = 6
    height = 6
    properties = {
      title                = "Cờ / 1.000 giao dịch, 24 giờ gần nhất"
      region               = local.dash_region
      view                 = "singleValue"
      setPeriodToTimeRange = true
      start                = "-PT24H"
      end                  = "P0D"
      metrics = [
        [local.dash_ns, "risk_flag_total", "Role", "worker", { id = "f", stat = "Sum", visible = false }],
        [local.dash_ns, "risk_decision_total", "Role", "worker", { id = "d", stat = "Sum", visible = false }],
        [{ expression = "IF(d > 0, 1000 * FILL(f, 0) / d, 0)", label = "Cờ / 1.000 giao dịch (SLO ≤ 20)", id = "r" }],
      ]
    }
  }

  # Xu hướng và tách theo mode. rule_only: mẫu số là quyết định có AiStatus = DISABLED (bất biến rule_only ⇔ DISABLED);
  # rules_with_external_ai: mẫu số là phần còn lại của tổng.
  w_flag_rate_trend = {
    type   = "metric"
    x      = 12
    y      = 50
    width  = 12
    height = 6
    properties = {
      title  = "Cờ / 1.000 giao dịch: xu hướng và theo mode (period 3600)"
      region = local.dash_region
      view   = "timeSeries"
      period = 3600
      metrics = [
        [local.dash_ns, "risk_flag_total", "Role", "worker", { id = "f", stat = "Sum", visible = false }],
        [local.dash_ns, "risk_decision_total", "Role", "worker", { id = "d", stat = "Sum", visible = false }],
        [local.dash_ns, "risk_decision_total", "Role", "worker", "AiStatus", "DISABLED", { id = "dd", stat = "Sum", visible = false }],
        [{ expression = "SUM(SEARCH('{\"${local.dash_ns}\",Role,RiskLevel,Mode,AiAdded} MetricName=\"risk_flag_total\" Mode=\"rule_only\"', 'Sum', 3600))", id = "fr", visible = false }],
        [{ expression = "SUM(SEARCH('{\"${local.dash_ns}\",Role,RiskLevel,Mode,AiAdded} MetricName=\"risk_flag_total\" Mode=\"rules_with_external_ai\"', 'Sum', 3600))", id = "fe", visible = false }],
        [{ expression = "IF(d > 0, 1000 * FILL(f, 0) / d, 0)", label = "Tổng", id = "r" }],
        [{ expression = "IF(FILL(dd, 0) > 0, 1000 * FILL(fr, 0) / FILL(dd, 0), 0)", label = "rule_only", id = "rr" }],
        [{ expression = "IF(d - FILL(dd, 0) > 0, 1000 * FILL(fe, 0) / (d - FILL(dd, 0)), 0)", label = "rules_with_external_ai", id = "re" }],
      ]
      annotations = {
        horizontal = [{ label = "SLO ≤ 20 / 1.000", value = 20 }]
      }
      yAxis = { left = { min = 0 } }
    }
  }

  w_flag_by_level = {
    type   = "metric"
    x      = 0
    y      = 56
    width  = 8
    height = 6
    properties = {
      title  = "Cờ theo risk_level"
      region = local.dash_region
      view   = "timeSeries"
      period = 300
      metrics = [
        [{ expression = "SUM(SEARCH('{\"${local.dash_ns}\",Role,RiskLevel,Mode,AiAdded} MetricName=\"risk_flag_total\" RiskLevel=\"MEDIUM\"', 'Sum', 300))", label = "MEDIUM", id = "m1" }],
        [{ expression = "SUM(SEARCH('{\"${local.dash_ns}\",Role,RiskLevel,Mode,AiAdded} MetricName=\"risk_flag_total\" RiskLevel=\"HIGH\"', 'Sum', 300))", label = "HIGH", id = "m2" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  # DoD 4: «cờ do AI bổ sung» là `created` (không có AI thì không có cờ); `raised` (AI nâng MEDIUM lên HIGH) vẽ riêng.
  w_flag_ai = {
    type   = "metric"
    x      = 8
    y      = 56
    width  = 8
    height = 6
    properties = {
      title  = "Cờ do AI bổ sung"
      region = local.dash_region
      view   = "timeSeries"
      period = 300
      metrics = [
        [{ expression = "SUM(SEARCH('{\"${local.dash_ns}\",Role,RiskLevel,Mode,AiAdded} MetricName=\"risk_flag_total\" AiAdded=\"created\"', 'Sum', 300))", label = "created (AI tạo cờ)", id = "a1" }],
        [{ expression = "SUM(SEARCH('{\"${local.dash_ns}\",Role,RiskLevel,Mode,AiAdded} MetricName=\"risk_flag_total\" AiAdded=\"raised\"', 'Sum', 300))", label = "raised (AI nâng lên HIGH)", id = "a2" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  dashboard_body = {
    start          = "-PT3H"
    periodOverride = "inherit"
    # Thứ tự đọc từ trên xuống (DBS-178): intro, 1 trạng thái, 2 API, 3 hàng đợi, 4 Redis và đối soát, 5 fraud, cách đọc.
    widgets = [
      local.w_intro,
      local.w_h_status, local.w_alarms, local.w_health,
      local.w_h_api, local.w_transfer, local.w_errors, local.w_rps, local.w_reads, local.w_overall, local.w_volume, local.w_routes,
      local.w_h_queue, local.w_queue_depth, local.w_age, local.w_outbox, local.w_dlq, local.w_consumer,
      local.w_h_redis, local.w_redis, local.w_rate, local.w_recon,
      local.w_h_fraud, local.w_flag_rate_1h, local.w_flag_rate_24h, local.w_flag_rate_trend,
      local.w_flag_by_level, local.w_flag_ai, local.w_risk_decisions,
      local.w_flag, local.w_risk_health, local.w_risk,
      local.w_notes,
    ]
  }
}

resource "aws_cloudwatch_dashboard" "overview" {
  dashboard_name = "dbs-dev-overview"
  dashboard_body = jsonencode(local.dashboard_body)
}
