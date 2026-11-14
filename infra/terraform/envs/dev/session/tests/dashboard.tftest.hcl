# DBS-145: dashboard CloudWatch. Mock, biến và override chép từ session.tftest.hcl vì chỉ có hiệu lực trong file khai báo chúng.
mock_provider "aws" {}
mock_provider "tls" {}

variables {
  state_bucket = "dbs-tfstate-123456789012-ap-southeast-1"
  account_id   = "123456789012"
  image_tag    = "0000000000000000000000000000000000000000"
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
      vpc_id                  = "vpc-0abc"
      public_subnet_ids       = ["subnet-pub-a", "subnet-pub-b"]
      private_subnet_ids      = ["subnet-prv-a", "subnet-prv-b"]
      ecr_repository_url      = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/dbs-api"
      ecr_repository_arn      = "arn:aws:ecr:ap-southeast-1:123456789012:repository/dbs-api"
      alb_security_group_id   = "sg-alb"
      api_security_group_id   = "sg-api"
      api_log_group_name      = "/dbs/dev/api"
      api_log_group_arn       = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/dbs/dev/api"
      cognito_user_pool_id    = "ap-southeast-1_ABCDEFGHI"
      cognito_client_id       = "abcdefghij1234567890"
      cognito_issuer          = "https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ABCDEFGHI"
      kms_key_arn             = "arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000"
      db_subnet_group_name    = "dbs-dev"
      db_security_group_id    = "sg-db"
      redis_subnet_group_name = "dbs-dev"
      redis_security_group_id = "sg-redis"
      redis_auth_secret_arn   = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:dbs/dev/redis-auth-AbCdEf"
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
    condition     = length(jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets) == 16
    error_message = "16 widgets: 1 text + 15 metric"
  }

  assert {
    condition     = length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "metric"]) == 15 && length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "text"]) == 1
    error_message = "15 metric widgets and 1 text widget"
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
        "reconciliation_runs_total", "risk_decision_total", "risk_rule_error_total", "risk_transfer_to_flag_ms",
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
          for i, v in m : contains(["Route", "Method", "Role", "Rule", "Reason", "Scope", "Status", "AiStatus", "QueueName"], tostring(v)) if i >= 2 && i % 2 == 0 && can(tostring(v))
        ]
      ]
    ]))
    error_message = "dimension names must be on the allowlist"
  }

  assert {
    condition = alltrue(flatten([
      for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : [
        for m in try(w.properties.metrics, []) : can(regex("^SEARCH\\('\\{\"DBS/Backend\",(Method|Route|Role|Rule|Reason|Scope|Status|AiStatus)(,(Method|Route|Role|Rule|Reason|Scope|Status|AiStatus))*\\} MetricName=\"[a-z0-9_]+\"", m[0].expression)) if try(m[0].expression, null) != null && startswith(m[0].expression, "SEARCH(")
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
