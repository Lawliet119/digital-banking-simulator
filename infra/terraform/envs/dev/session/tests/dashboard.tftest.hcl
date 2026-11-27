# DBS-145: dashboard CloudWatch. Mock, biến và override chép từ session.tftest.hcl vì chỉ có hiệu lực trong file khai báo chúng.
mock_provider "aws" {}
mock_provider "tls" {}

variables {
  state_bucket = "dbs-tfstate-123456789012-ap-southeast-1"
  account_id   = "123456789012"
  image_tag    = "0000000000000000000000000000000000000000"
  # Ngày thật làm check "waf_off_date" báo lỗi; run nào kiểm cảnh báo thì tự đặt ngày đã qua.
  waf_off_date = "2099-01-01"
}

# mock_provider sinh ARN không hợp lệ; cấp ARN giả hợp lệ (và khác nhau giữa hai role) cho các tham chiếu chéo.
override_resource {
  target          = aws_lb.main
  override_during = plan
  values = {
    arn        = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/dbs-dev/0123456789abcdef"
    arn_suffix = "app/dbs-dev/0123456789abcdef"
  }
}

override_resource {
  target          = aws_lb_target_group.api
  override_during = plan
  values = {
    arn        = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/dbs-dev-api/0123456789abcdef"
    arn_suffix = "targetgroup/dbs-dev-api/0123456789abcdef"
  }
}

override_resource {
  target = aws_acm_certificate.dev
  values = {
    arn = "arn:aws:acm:ap-southeast-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target = aws_iam_role.execution
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-dev-api-execution"
  }
}

override_resource {
  target = aws_iam_role.task
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-dev-api-task"
  }
}

# master_user_secret là list computed: mock để rỗng làm output `[0]` lỗi; cấp giá trị giả hợp lệ.
override_resource {
  target = aws_db_instance.main
  values = {
    master_user_secret = [{
      secret_arn    = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:rds!db-00000000-0000-0000-0000-000000000000-AbCdEf"
      kms_key_id    = "arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000"
      secret_status = "active"
    }]
  }
}
override_data {
  target = data.terraform_remote_state.base
  values = {
    outputs = {
      vpc_id                    = "vpc-0abc"
      public_subnet_ids         = ["subnet-pub-a", "subnet-pub-b"]
      private_subnet_ids        = ["subnet-prv-a", "subnet-prv-b"]
      ecr_repository_url        = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/dbs-api"
      ecr_repository_arn        = "arn:aws:ecr:ap-southeast-1:123456789012:repository/dbs-api"
      alb_security_group_id     = "sg-alb"
      api_security_group_id     = "sg-api"
      api_log_group_name        = "/dbs/dev/api"
      api_log_group_arn         = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/dbs/dev/api"
      cognito_user_pool_id      = "ap-southeast-1_ABCDEFGHI"
      cognito_client_id         = "abcdefghij1234567890"
      cognito_issuer            = "https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ABCDEFGHI"
      kms_key_arn               = "arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000"
      db_subnet_group_name      = "dbs-dev"
      db_security_group_id      = "sg-db"
      redis_subnet_group_name   = "dbs-dev"
      redis_security_group_id   = "sg-redis"
      redis_auth_secret_arn     = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:dbs/dev/redis-auth-AbCdEf"
      openai_api_key_secret_arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:dbs/dev/openai-api-key-AbCdEf"
      # DBS-120/121: output của base mà iam.tf và worker.tf đọc.
      worker_sqs_policy_arn      = "arn:aws:iam::123456789012:policy/dbs-dev-worker-sqs"
      worker_security_group_id   = "sg-worker"
      worker_log_group_name      = "/dbs/dev/worker"
      worker_log_group_arn       = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/dbs/dev/worker"
      sqs_risk_queue_url         = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-risk-events"
      sqs_notification_queue_url = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-notification-events"
      # DBS-145: dashboard đọc tên DLQ từ base.
      # BL-051: alarm của session gửi vào topic SNS của base.
      alarm_topic_arn = "arn:aws:sns:ap-southeast-1:123456789012:dbs-dev-alarms"
      sqs_dlq_names = {
        risk         = "dbs-dev-risk-events-dlq"
        notification = "dbs-dev-notification-events-dlq"
      }
    }
  }
}

# TC-145-01: hình dạng body
run "dashboard_shape" {
  command = plan

  assert {
    condition     = aws_cloudwatch_dashboard.overview.dashboard_name == "dbs-dev-overview"
    error_message = "dashboard name"
  }

  assert {
    condition     = length(jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets) == 33
    error_message = "33 widgets (DBS-178): 7 text (intro, 5 group headings, how to read) + 1 alarm + 25 metric"
  }

  assert {
    condition = (
      length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "metric"]) == 25 &&
      length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "text"]) == 7 &&
      length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "alarm"]) == 1
    )
    error_message = "25 metric widgets, 7 text widgets and 1 alarm widget"
  }

  # DBS-178 TC-178-01: no two widgets overlap (a layout that overlaps is silently moved by the console).
  assert {
    condition = alltrue(flatten([
      for i, a in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : [
        for j, b in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets :
        i >= j || a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height
      ]
    ]))
    error_message = "no two widgets may overlap"
  }

  assert {
    condition     = alltrue([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w.x >= 0 && w.x + w.width <= 24 && w.width > 0 && w.height > 0])
    error_message = "every widget must fit the 24-column grid"
  }

  assert {
    condition     = alltrue([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w.properties.region == "ap-southeast-1" if w.type == "metric"])
    error_message = "every metric widget must pin the region"
  }

  assert {
    condition     = jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).start == "-PT3H" && jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).periodOverride == "inherit"
    error_message = "start -PT3H and periodOverride inherit (otherwise the console recomputes the 5-minute SLO windows)"
  }
}

# TC-145-02: mọi metric DBS-144 và hai metric SQS có mặt
run "dashboard_has_every_metric" {
  command = plan

  assert {
    condition = alltrue([
      for name in [
        "http_request_duration_ms", "http_requests_total", "http_5xx_total", "http_aborted_total",
        "redis_fallback_total", "rate_limited_total",
        "risk_config_redis_fallback_total", "outbox_oldest_unpublished_age_seconds",
        "reconciliation_runs_total", "risk_decision_total", "risk_flag_total", "risk_rule_error_total", "risk_transfer_to_flag_ms",
        "consumer_message_total", "ApproximateNumberOfMessagesNotVisible",
        "ApproximateNumberOfMessagesVisible", "ApproximateAgeOfOldestMessage",
      ] : strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "\"${name}\"") || strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "MetricName=\\\"${name}\\\"")
    ])
    error_message = "every DBS-144 metric and the two SQS metrics must appear"
  }

  # BL-204: OnlineFeatureProvider reads SQL only, so nothing emits this metric; it must not come back as an empty widget.
  assert {
    condition     = !strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "risk_redis_fallback_total")
    error_message = "risk_redis_fallback_total has no source (BL-204) and must not be on the dashboard"
  }
}

# TC-145-03: namespace, dimension, không dữ liệu cá nhân
run "dashboard_labels_are_safe" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : [
        for m in try(w.properties.metrics, []) : contains(["DBS/Backend", "AWS/SQS"], m[0]) if can(tostring(m[0]))
      ]
    ]))
    error_message = "namespace must be DBS/Backend or AWS/SQS"
  }

  assert {
    condition = alltrue(flatten([
      for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : [
        for m in try(w.properties.metrics, []) : [
          for i, v in m : contains(["Route", "Method", "Role", "Rule", "Reason", "Scope", "Status", "AiStatus", "QueueName", "RiskLevel", "Mode", "AiAdded", "Consumer", "Outcome"], tostring(v)) if i >= 2 && i % 2 == 0 && can(tostring(v))
        ]
      ]
    ]))
    error_message = "dimension names must be on the allowlist"
  }

  assert {
    condition = alltrue(flatten([
      for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : [
        for m in try(w.properties.metrics, []) : can(regex("^(SUM\\()?SEARCH\\('\\{\"DBS/Backend\",(Method|Route|Role|Rule|Reason|Scope|Status|AiStatus|RiskLevel|Mode|AiAdded|Consumer|Outcome)(,(Method|Route|Role|Rule|Reason|Scope|Status|AiStatus|RiskLevel|Mode|AiAdded|Consumer|Outcome))*\\} MetricName=\"[a-z0-9_]+\"", m[0].expression)) if try(m[0].expression, null) != null && (startswith(m[0].expression, "SEARCH(") || startswith(m[0].expression, "SUM(SEARCH("))
      ]
    ]))
    error_message = "SEARCH must quote the namespace and use allowlisted dimension names only"
  }

  # BL-208: the config fallback counter now carries Reason; the line also has a Role-only set for alarms.
  assert {
    condition     = strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : try(w.properties.metrics, [])]), "Role,Reason} MetricName=\\\"risk_config_redis_fallback_total\\\"")
    error_message = "risk_config_redis_fallback_total must be searched by {Role,Reason}"
  }

  assert {
    condition     = !strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w.properties.metrics if w.type == "metric"]), "customer") && !strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w.properties.metrics if w.type == "metric"]), "userId")
    error_message = "no personal data in metric definitions"
  }
}

# TC-145-04: đường ngưỡng và period đúng SLI
run "dashboard_slo_lines" {
  command = plan

  assert {
    condition     = [for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Chuyển tiền POST /v1/transfers: p95 và p99 (ms)"][0].properties.annotations.horizontal : a.value] == [300, 1000] && [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Chuyển tiền POST /v1/transfers: p95 và p99 (ms)"][0].properties.period == 300
    error_message = "transfer widget: 300 ms and 1000 ms lines, period 300"
  }

  assert {
    condition     = [for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Đọc: p95 (ms)"][0].properties.annotations.horizontal : a.value] == [150] && [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Đọc: p95 (ms)"][0].properties.period == 300 && strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Đọc: p95 (ms)"][0].properties.metrics), "/v1/accounts/:id/transactions") && strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Đọc: p95 (ms)"][0].properties.metrics), "\"/v1/accounts\"")
    error_message = "read widget: 150 ms line, period 300, the three read routes"
  }

  assert {
    condition     = try([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Độ trễ toàn dịch vụ (ms)"][0].properties.annotations, null) == null
    error_message = "service-wide latency is an overview: no SLO line"
  }

  assert {
    condition     = [for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Tỉ lệ 5xx (%)"][0].properties.annotations.horizontal : a.value] == [1] && [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Tỉ lệ 5xx (%)"][0].properties.period == 300
    error_message = "5xx widget: 1 percent line, period 300"
  }

  assert {
    condition     = [for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Tuổi outbox chưa gửi cũ nhất (giây)"][0].properties.annotations.horizontal : a.value] == [10, 30] && [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Tuổi outbox chưa gửi cũ nhất (giây)"][0].properties.period == 60 && [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Tuổi outbox chưa gửi cũ nhất (giây)"][0].properties.stat == "Maximum"
    error_message = "outbox age: 10 and 30 s lines, period 60, Maximum"
  }

  assert {
    condition     = [for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "DLQ: số message"][0].properties.annotations.horizontal : a.value] == [1] && [for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Tuổi message cũ nhất (giây)"][0].properties.annotations.horizontal : a.value] == [60, 120]
    error_message = "DLQ line 1; queue age lines 60 and 120"
  }
}

# TC-145-04b: SEARCH theo Route loại probe
run "dashboard_route_search_excludes_health" {
  command = plan

  assert {
    condition     = strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "p95 theo Route (ms)"][0].properties.metrics), "NOT Route=\\\"/health/live\\\"") && strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "p95 theo Route (ms)"][0].properties.metrics), "NOT Route=\\\"/health/ready\\\"")
    error_message = "per-route p95 must exclude the ALB probes"
  }
}

# TC-145-05: tên queue từ remote state của base
run "dashboard_queue_names" {
  command = plan

  assert {
    condition     = strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "DLQ: số message"][0].properties.metrics), "dbs-dev-risk-events-dlq") && strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "DLQ: số message"][0].properties.metrics), "dbs-dev-notification-events-dlq")
    error_message = "DLQ widget must name both DLQs from base"
  }

  assert {
    condition     = strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Tuổi message cũ nhất (giây)"][0].properties.metrics), "\"dbs-dev-risk-events\"") && strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Tuổi message cũ nhất (giây)"][0].properties.metrics), "\"dbs-dev-notification-events\"")
    error_message = "queue age widget must name the two main queues (DLQ name without -dlq)"
  }
}

# TC-145-06: biểu thức 5xx %
run "dashboard_error_rate_expression" {
  command = plan

  assert {
    condition     = strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Tỉ lệ 5xx (%)"][0].properties.metrics), "100 * FILL(m5, 0) / mr")
    error_message = "5xx percent = 100 * FILL(m5, 0) / mr"
  }

  assert {
    condition     = strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Tỉ lệ 5xx (%)"][0].properties.metrics), "http_5xx_total") && strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Tỉ lệ 5xx (%)"][0].properties.metrics), "http_requests_total")
    error_message = "the expression uses http_5xx_total and http_requests_total"
  }
}

# TC-145-07: output
run "dashboard_outputs" {
  command = plan

  assert {
    condition     = output.dashboard_name == "dbs-dev-overview" && strcontains(output.dashboard_url, "ap-southeast-1") && strcontains(output.dashboard_url, "dbs-dev-overview")
    error_message = "dashboard outputs"
  }
}

# TC-145-04c: namespace đổi được, SQS thì không
run "dashboard_namespace_variable" {
  command = plan

  variables {
    metrics_namespace = "DBS/Backend-dbs145"
  }

  assert {
    condition     = !strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "\"DBS/Backend\"") && !strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "\\\"DBS/Backend\\\"")
    error_message = "no widget may keep the default namespace"
  }

  assert {
    condition     = strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "\"DBS/Backend-dbs145\"") && strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "\\\"DBS/Backend-dbs145\\\"") && strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "\"AWS/SQS\"")
    error_message = "metric rows and SEARCH follow the variable; AWS/SQS unchanged"
  }
}

run "rejects_namespace_with_bad_characters" {
  command = plan

  variables {
    metrics_namespace = "DBS Backend!"
  }

  expect_failures = [var.metrics_namespace]
}

run "rejects_namespace_without_dbs_prefix" {
  command = plan

  variables {
    metrics_namespace = "Other/Backend"
  }

  expect_failures = [var.metrics_namespace]
}

# BL-127, BL-051: widget đối soát, CONFIG_INVALID/lỗi luật và thời gian tới cờ nằm ở overview, theo dimension mà app xuất
run "dashboard_reconciliation_and_risk_widgets" {
  command = plan

  assert {
    condition = (
      length([for m in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Đối soát sổ cái: số lần chạy theo kết quả"][0].properties.metrics : m if m[1] == "reconciliation_runs_total"]) == 3 &&
      toset([for m in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Đối soát sổ cái: số lần chạy theo kết quả"][0].properties.metrics : m[5]]) == toset(["OK", "MISMATCH", "ERROR"]) &&
      alltrue([for m in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Đối soát sổ cái: số lần chạy theo kết quả"][0].properties.metrics : m[2] == "Role" && m[3] == "worker" && m[4] == "Status"])
    )
    error_message = "reconciliation widget: reconciliation_runs_total [Role=worker, Status] for OK, MISMATCH, ERROR"
  }

  assert {
    condition = (
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Risk: CONFIG_INVALID và lỗi luật"][0].properties.metrics), "CONFIG_INVALID") &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Risk: CONFIG_INVALID và lỗi luật"][0].properties.metrics), "risk_rule_error_total")
    )
    error_message = "risk health widget: CONFIG_INVALID and risk_rule_error_total"
  }

  assert {
    condition     = [for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Thời gian giao dịch tới cờ: p95 (ms)"][0].properties.annotations.horizontal : a.value] == [5000]
    error_message = "time-to-flag widget: 5 s SLO line"
  }
}

# DBS-187 TC-187-10: cờ / 1.000 giao dịch. Hai ô singleValue cho tổng trượt 1 giờ và 24 giờ (setPeriodToTimeRange + start riêng
# của widget), một đường xu hướng, cờ theo mức, cờ do AI bổ sung. `terraform test` chỉ kiểm JSON dựng ra; console AWS chưa kiểm.
run "dashboard_flag_rate_widgets" {
  command = plan

  assert {
    condition = alltrue([
      for hours in ["1", "24"] : (
        length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ / 1.000 giao dịch, ${hours} giờ gần nhất"]) == 1 &&
        [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ / 1.000 giao dịch, ${hours} giờ gần nhất"][0].properties.view == "singleValue" &&
        [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ / 1.000 giao dịch, ${hours} giờ gần nhất"][0].properties.setPeriodToTimeRange == true &&
        [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ / 1.000 giao dịch, ${hours} giờ gần nhất"][0].properties.start == "-PT${hours}H"
      )
    ])
    error_message = "the 1 h and 24 h flag-rate widgets must be singleValue with setPeriodToTimeRange and their own start (-PT1H, -PT24H)"
  }

  assert {
    condition = alltrue([
      for hours in ["1", "24"] : (
        strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ / 1.000 giao dịch, ${hours} giờ gần nhất"][0].properties.metrics), "IF(d \\u003e 0, 1000 * FILL(f, 0) / d, 0)") &&
        strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ / 1.000 giao dịch, ${hours} giờ gần nhất"][0].properties.metrics), "risk_flag_total") &&
        strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ / 1.000 giao dịch, ${hours} giờ gần nhất"][0].properties.metrics), "risk_decision_total")
      )
    ])
    error_message = "the rate is IF(d > 0, 1000 * FILL(f, 0) / d, 0) over risk_flag_total and risk_decision_total ([Role=worker])"
  }

  assert {
    condition = (
      [for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ / 1.000 giao dịch: xu hướng và theo mode (period 3600)"][0].properties.annotations.horizontal : a.value] == [20] &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ / 1.000 giao dịch: xu hướng và theo mode (period 3600)"][0].properties.metrics), "Mode=\\\"rule_only\\\"") &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ / 1.000 giao dịch: xu hướng và theo mode (period 3600)"][0].properties.metrics), "Mode=\\\"rules_with_external_ai\\\"") &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ / 1.000 giao dịch: xu hướng và theo mode (period 3600)"][0].properties.metrics), "AiStatus") &&
      [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ / 1.000 giao dịch: xu hướng và theo mode (period 3600)"][0].properties.period == 3600
    )
    error_message = "trend widget: SLO line 20, period 3600, split by Mode (denominator by AiStatus DISABLED)"
  }

  assert {
    condition = (
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ theo risk_level"][0].properties.metrics), "RiskLevel=\\\"MEDIUM\\\"") &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ theo risk_level"][0].properties.metrics), "RiskLevel=\\\"HIGH\\\"") &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ do AI bổ sung"][0].properties.metrics), "AiAdded=\\\"created\\\"") &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Cờ do AI bổ sung"][0].properties.metrics), "AiAdded=\\\"raised\\\"")
    )
    error_message = "flags by RiskLevel (MEDIUM, HIGH) and by AiAdded (created, raised)"
  }
}

# BL-261: overview vẫn không tham chiếu tài nguyên session (không nhắc tới ALB, RDS, ECS), nên `-target` được như DBS-145
run "overview_has_no_infra_metrics" {
  command = plan

  assert {
    condition     = !strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "AWS/ECS") && !strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "AWS/RDS") && !strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "AWS/ApplicationELB") && !strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "AWS/ElastiCache")
    error_message = "infra metrics belong to dbs-dev-infra, not overview"
  }
}

# BL-261: dashboard hạ tầng
run "infra_dashboard_shape" {
  command = plan

  assert {
    condition     = aws_cloudwatch_dashboard.infra.dashboard_name == "dbs-dev-infra" && output.infra_dashboard_name == "dbs-dev-infra" && strcontains(output.infra_dashboard_url, "dbs-dev-infra")
    error_message = "infra dashboard name and outputs"
  }

  assert {
    condition     = length(jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets) == 10 && length([for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if w.type == "metric"]) == 9
    error_message = "infra dashboard: 1 text + 9 metric widgets"
  }

  assert {
    condition     = alltrue([for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w.x >= 0 && w.x + w.width <= 24 && w.width > 0 && w.height > 0])
    error_message = "every infra widget must fit the 24-column grid"
  }

  assert {
    condition     = alltrue([for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w.properties.region == "ap-southeast-1" if w.type == "metric"])
    error_message = "every infra metric widget must pin the region"
  }

  assert {
    condition     = jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).start == "-PT3H" && jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).periodOverride == "inherit"
    error_message = "start -PT3H and periodOverride inherit"
  }
}

run "infra_dashboard_metrics" {
  command = plan

  # ECS: CPU và bộ nhớ của hai service trong cluster dbs-dev
  assert {
    condition = alltrue([
      for title in ["ECS: CPU (%)", "ECS: bộ nhớ (%)"] :
      toset([for m in [for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == title][0].properties.metrics : m[5]]) == toset(["api", "worker"]) &&
      alltrue([for m in [for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == title][0].properties.metrics : m[0] == "AWS/ECS" && m[2] == "ClusterName" && m[3] == "dbs-dev" && m[4] == "ServiceName"])
    ])
    error_message = "ECS widgets: AWS/ECS ClusterName dbs-dev, ServiceName api and worker"
  }

  assert {
    condition = (
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "ECS: CPU (%)"][0].properties.metrics), "CPUUtilization") &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "ECS: bộ nhớ (%)"][0].properties.metrics), "MemoryUtilization")
    )
    error_message = "ECS widgets: CPUUtilization and MemoryUtilization"
  }

  # ALB: số task khỏe, 5xx (ELB và target), tỉ lệ
  assert {
    condition = (
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "Task api sau ALB: khỏe và không khỏe"][0].properties.metrics), "HealthyHostCount") &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "Task api sau ALB: khỏe và không khỏe"][0].properties.metrics), "targetgroup/dbs-dev-api/0123456789abcdef") &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "Task api sau ALB: khỏe và không khỏe"][0].properties.metrics), "app/dbs-dev/0123456789abcdef")
    )
    error_message = "healthy host widget: HealthyHostCount with the target group and load balancer arn_suffix"
  }

  assert {
    condition = (
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "ALB: số 5xx"][0].properties.metrics), "HTTPCode_ELB_5XX_Count") &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "ALB: số 5xx"][0].properties.metrics), "HTTPCode_Target_5XX_Count") &&
      alltrue([for m in [for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "ALB: số 5xx"][0].properties.metrics : m[0] == "AWS/ApplicationELB" && m[2] == "LoadBalancer" && m[3] == "app/dbs-dev/0123456789abcdef"])
    )
    error_message = "ALB 5xx widget: ELB and target 5xx counts on the load balancer arn_suffix"
  }

  assert {
    condition = (
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "ALB: tỉ lệ 5xx (%)"][0].properties.metrics), "100 * (FILL(e5, 0) + FILL(t5, 0)) / rc") &&
      [for a in [for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "ALB: tỉ lệ 5xx (%)"][0].properties.annotations.horizontal : a.value] == [1] &&
      [for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "ALB: tỉ lệ 5xx (%)"][0].properties.period == 300
    )
    error_message = "ALB 5xx rate: (ELB + target) / RequestCount, 1 percent line, period 300"
  }

  # RDS
  assert {
    condition = (
      toset([for m in [for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "RDS: số kết nối"][0].properties.metrics : m[1]]) == toset(["DatabaseConnections"]) &&
      toset([for m in [for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "RDS: CPU (%)"][0].properties.metrics : m[1]]) == toset(["CPUUtilization"]) &&
      alltrue([for t in ["RDS: số kết nối", "RDS: CPU (%)"] : alltrue([for m in [for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == t][0].properties.metrics : m[0] == "AWS/RDS" && m[2] == "DBInstanceIdentifier" && m[3] == "dbs-dev"])])
    )
    error_message = "RDS widgets: DatabaseConnections and CPUUtilization of DBInstanceIdentifier dbs-dev"
  }

  # Valkey: node chính dbs-dev-001
  assert {
    condition = alltrue([
      for t in ["Valkey: CPU (%)", "Valkey: bộ nhớ (%) và kết nối"] :
      alltrue([for m in [for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == t][0].properties.metrics : m[0] == "AWS/ElastiCache" && m[2] == "CacheClusterId" && m[3] == "dbs-dev-001"])
    ])
    error_message = "Valkey widgets: AWS/ElastiCache CacheClusterId dbs-dev-001"
  }

  assert {
    condition = (
      toset([for m in [for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "Valkey: CPU (%)"][0].properties.metrics : m[1]]) == toset(["CPUUtilization", "EngineCPUUtilization"]) &&
      toset([for m in [for w in jsondecode(aws_cloudwatch_dashboard.infra.dashboard_body).widgets : w if try(w.properties.title, "") == "Valkey: bộ nhớ (%) và kết nối"][0].properties.metrics : m[1]]) == toset(["DatabaseMemoryUsagePercentage", "CurrConnections"])
    )
    error_message = "Valkey widgets: CPU, engine CPU, memory percentage, connections"
  }
}

# DBS-178 TC-178-02: trạng thái health, phần 1. Widget `alarm` liệt kê alarm theo ARN dựng từ chuỗi (dashboard không tham chiếu
# aws_cloudwatch_metric_alarm để `-target` vẫn đúng); tập tên phải bằng alarm_name của mọi alarm session + hai alarm DLQ của base.
run "dashboard_alarm_status_widget" {
  command = plan

  assert {
    condition     = length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "alarm"]) == 1
    error_message = "exactly one alarm widget"
  }

  assert {
    condition = alltrue([
      for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "alarm"][0].properties.alarms :
      startswith(a, "arn:aws:cloudwatch:ap-southeast-1:123456789012:alarm:dbs-dev-")
    ])
    error_message = "every alarm ARN is arn:aws:cloudwatch:<region>:<account>:alarm:dbs-dev-..."
  }

  assert {
    condition     = length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "alarm"][0].properties.alarms) == 20
    error_message = "20 alarms: 18 of the session + the two dlq-not-empty of base"
  }

  assert {
    condition = (
      toset([for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "alarm"][0].properties.alarms : element(split(":", a), 6)]) ==
      toset(concat(
        [
          aws_cloudwatch_metric_alarm.outbox_age.alarm_name,
          aws_cloudwatch_metric_alarm.outbox_quarantined.alarm_name,
          aws_cloudwatch_metric_alarm.risk_config_invalid.alarm_name,
          aws_cloudwatch_metric_alarm.risk_rule_error.alarm_name,
          aws_cloudwatch_metric_alarm.risk_ai_fallback_rate.alarm_name,
          aws_cloudwatch_metric_alarm.risk_flag_rate.alarm_name,
          aws_cloudwatch_metric_alarm.reconciliation.alarm_name,
          aws_cloudwatch_metric_alarm.redis_node_missing.alarm_name,
          aws_cloudwatch_metric_alarm.redis_fallback.alarm_name,
          aws_cloudwatch_metric_alarm.risk_config_redis_fallback.alarm_name,
          aws_cloudwatch_metric_alarm.risk_config_freshness.alarm_name,
          aws_cloudwatch_metric_alarm.rate_limited.alarm_name,
          aws_cloudwatch_metric_alarm.api_5xx_rate.alarm_name,
          aws_cloudwatch_metric_alarm.transfer_latency_p95.alarm_name,
          aws_cloudwatch_metric_alarm.read_latency_p95.alarm_name,
          aws_cloudwatch_metric_alarm.transfer_to_flag_p95.alarm_name,
        ],
        [for a in aws_cloudwatch_metric_alarm.queue_age : a.alarm_name],
        ["dbs-dev-risk-dlq-not-empty", "dbs-dev-notification-dlq-not-empty"],
      ))
    )
    error_message = "the alarm widget must list exactly the session alarms (by alarm_name) and the two base dlq-not-empty alarms"
  }

  # dlq-oldest-age chưa được apply ở base (BL-409): không đưa vào widget để khỏi trỏ tới alarm không tồn tại.
  assert {
    condition     = length([for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "alarm"][0].properties.alarms : a if strcontains(a, "dlq-oldest-age")]) == 0
    error_message = "dlq-oldest-age alarms are not applied yet (BL-409) and must not be listed"
  }
}

run "dashboard_alarm_arns_follow_account" {
  command = plan

  variables {
    account_id = "210987654321"
  }

  assert {
    condition = alltrue([
      for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "alarm"][0].properties.alarms :
      startswith(a, "arn:aws:cloudwatch:ap-southeast-1:210987654321:alarm:")
    ])
    error_message = "alarm ARNs follow var.account_id and the region"
  }
}

# DBS-178 TC-178-03: trạng thái health, phần 2. /health/* chỉ được ghi ở bộ [Route, Method] (http-stats.ts toEmfSpecs): dòng metric
# phải khai đúng hai cặp dimension đó, không Role; không thì không bao giờ có dữ liệu.
run "dashboard_health_probe_widget" {
  command = plan

  assert {
    condition = (
      length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Health: probe /health/ready (request và 5xx)"]) == 1 &&
      toset([for m in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Health: probe /health/ready (request và 5xx)"][0].properties.metrics : m[1]]) == toset(["http_requests_total", "http_5xx_total"])
    )
    error_message = "health widget: http_requests_total and http_5xx_total"
  }

  assert {
    condition = alltrue([
      for m in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Health: probe /health/ready (request và 5xx)"][0].properties.metrics :
      length(m) == 7 && m[2] == "Route" && m[3] == "/health/ready" && m[4] == "Method" && m[5] == "GET" && m[6].stat == "Sum"
    ])
    error_message = "health widget rows: exactly the dimensions Route=/health/ready and Method=GET (the only set /health/* is written under, no Role), stat Sum"
  }

  assert {
    condition     = [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Health: probe /health/ready (request và 5xx)"][0].properties.period == 60
    error_message = "health widget period 60"
  }
}

# DBS-178 TC-178-04: độ sâu hàng đợi chính (Visible và NotVisible), không lẫn DLQ.
run "dashboard_queue_depth_widget" {
  command = plan

  assert {
    condition = (
      length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Độ sâu hàng đợi chính (chờ xử lý và đang xử lý)"]) == 1 &&
      toset([for m in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Độ sâu hàng đợi chính (chờ xử lý và đang xử lý)"][0].properties.metrics : m[1]]) == toset(["ApproximateNumberOfMessagesVisible", "ApproximateNumberOfMessagesNotVisible"]) &&
      alltrue([for m in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Độ sâu hàng đợi chính (chờ xử lý và đang xử lý)"][0].properties.metrics : m[0] == "AWS/SQS" && m[2] == "QueueName"])
    )
    error_message = "queue depth widget: AWS/SQS Visible and NotVisible by QueueName"
  }

  assert {
    condition = (
      toset([for m in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Độ sâu hàng đợi chính (chờ xử lý và đang xử lý)"][0].properties.metrics : m[3]]) == toset(["dbs-dev-risk-events", "dbs-dev-notification-events"]) &&
      length([for m in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Độ sâu hàng đợi chính (chờ xử lý và đang xử lý)"][0].properties.metrics : m if endswith(m[3], "-dlq")]) == 0
    )
    error_message = "queue depth widget names both main queues and no DLQ"
  }

  assert {
    condition = (
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "DLQ: số message"][0].properties.metrics), "dbs-dev-risk-events-dlq") &&
      [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "DLQ: số message"][0].width == 12
    )
    error_message = "DLQ widget stays (now 12 wide)"
  }
}

# DBS-178 TC-178-05: lưu lượng 120 RPS, và các widget SLO giữ đường ngưỡng.
run "dashboard_rps_and_slo_widgets" {
  command = plan

  assert {
    condition = (
      length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Lưu lượng: request mỗi giây"]) == 1 &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Lưu lượng: request mỗi giây"][0].properties.metrics), "rq / PERIOD(rq)") &&
      [for a in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Lưu lượng: request mỗi giây"][0].properties.annotations.horizontal : a.value] == [120] &&
      [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Lưu lượng: request mỗi giây"][0].properties.period == 60
    )
    error_message = "RPS widget: rq / PERIOD(rq), 120 line, period 60"
  }

  assert {
    condition = (
      [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Chuyển tiền POST /v1/transfers: p95 và p99 (ms)"][0].width == 12 &&
      [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Tỉ lệ 5xx (%)"][0].width == 12
    )
    error_message = "the two SLO widgets people read first (transfer p95, 5xx rate) are 12 wide"
  }
}

# DBS-178 TC-178-06: cảnh báo fraud. Quyết định chấm điểm theo AiStatus (mẫu số của cờ/1.000 giao dịch, thấy fallback AI) và consumer
# retry/dead_letter; năm widget cờ/1.000 giao dịch của DBS-187 vẫn có.
run "dashboard_risk_decisions_and_consumer_widgets" {
  command = plan

  assert {
    condition = (
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Risk: quyết định chấm điểm theo AiStatus"][0].properties.metrics), "Role,AiStatus} MetricName=\\\"risk_decision_total\\\"") &&
      strcontains(jsonencode([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == "Consumer: message retry và dead_letter"][0].properties.metrics), "Role,Consumer,Outcome} MetricName=\\\"consumer_message_total\\\"")
    )
    error_message = "decisions by {Role,AiStatus} and consumer messages by {Role,Consumer,Outcome} (the exact sets MetricsService writes)"
  }

  assert {
    condition = alltrue([
      for t in [
        "Cờ / 1.000 giao dịch, 1 giờ gần nhất", "Cờ / 1.000 giao dịch, 24 giờ gần nhất",
        "Cờ / 1.000 giao dịch: xu hướng và theo mode (period 3600)", "Cờ theo risk_level", "Cờ do AI bổ sung",
        "Thời gian giao dịch tới cờ: p95 (ms)", "Risk: CONFIG_INVALID và lỗi luật",
      ] : length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if try(w.properties.title, "") == t]) == 1
    ])
    error_message = "the fraud widgets of DBS-145 and DBS-187 are kept"
  }
}

# DBS-178 TC-178-07: bảng phủ DoD 1, mỗi mục có ít nhất một widget.
run "dashboard_covers_dod" {
  command = plan

  assert {
    condition = (
      strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "\"stat\":\"p95\"") &&
      strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "100 * FILL(m5, 0) / mr") &&
      strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "\"dbs-dev-risk-events\"") &&
      strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "\"dbs-dev-risk-events-dlq\"") &&
      strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "\"redis_fallback_total\"") &&
      strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "\"type\":\"alarm\"") &&
      strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "/health/ready") &&
      strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "risk_flag_total") &&
      strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "risk_decision_total")
    )
    error_message = "DoD 1: p95, error rate, main queue depth, DLQ depth, redis_fallback_total, health (alarm + probe), fraud flags"
  }
}

# DBS-178 TC-178-08: bố cục. Năm tiêu đề nhóm (text cao 1, bắt đầu "### ") theo thứ tự y, mỗi cái ngay trên một hàng widget; ghi chú
# "Cách đọc" ở dưới cùng và nói rõ giới hạn của probe /health/ready và của redis_fallback_total.
run "dashboard_layout_and_notes" {
  command = plan

  assert {
    condition = (
      [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w.properties.markdown if w.type == "text" && w.height == 1] == [
        "### 1. Trạng thái: alarm và health",
        "### 2. API: lưu lượng, độ trễ, lỗi (SLO docs/03 §14)",
        "### 3. Hàng đợi, outbox, DLQ",
        "### 4. Redis, giới hạn tốc độ, đối soát",
        "### 5. Cảnh báo gian lận (fraud)",
      ] &&
      alltrue([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w.width == 24 && w.x == 0 if w.type == "text" && w.height == 1])
    )
    error_message = "five full-width group headings, 1 high, in the DoD order"
  }

  assert {
    condition = alltrue([
      for h in [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "text" && w.height == 1] :
      length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.y == h.y + 1 && w.type != "text"]) >= 1
    ])
    error_message = "every group heading sits directly above a row of data widgets"
  }

  assert {
    condition = (
      max([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w.y]...) == [for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w.y if w.type == "text" && w.height > 1 && w.y > 0][0] &&
      strcontains([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w.properties.markdown if w.type == "text" && w.height > 1 && w.y > 0][0], "/health/ready") &&
      strcontains([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w.properties.markdown if w.type == "text" && w.height > 1 && w.y > 0][0], "degraded") &&
      strcontains([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w.properties.markdown if w.type == "text" && w.height > 1 && w.y > 0][0], "redis_fallback_total") &&
      strcontains([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w.properties.markdown if w.type == "text" && w.height > 1 && w.y > 0][0], "ping")
    )
    error_message = "the how-to-read note is the last widget and explains /health/ready (200 redis degraded), the probe ping in redis_fallback_total"
  }
}
