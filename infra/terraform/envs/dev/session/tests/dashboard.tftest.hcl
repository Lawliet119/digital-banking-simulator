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
  target = aws_lb.main
  values = {
    arn = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/dbs-dev/0123456789abcdef"
  }
}

override_resource {
  target = aws_lb_target_group.api
  values = {
    arn = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/dbs-dev-api/0123456789abcdef"
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
      # DBS-145: dashboard đọc tên DLQ từ base.
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
    condition     = length(jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets) == 13
    error_message = "13 widgets: 1 text + 12 metric"
  }

  assert {
    condition     = length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "metric"]) == 12 && length([for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : w if w.type == "text"]) == 1
    error_message = "12 metric widgets and 1 text widget"
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
        "redis_fallback_total", "rate_limited_total", "risk_redis_fallback_total",
        "risk_config_redis_fallback_total", "outbox_oldest_unpublished_age_seconds",
        "ApproximateNumberOfMessagesVisible", "ApproximateAgeOfOldestMessage",
      ] : strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "\"${name}\"") || strcontains(aws_cloudwatch_dashboard.overview.dashboard_body, "MetricName=\\\"${name}\\\"")
    ])
    error_message = "every DBS-144 metric and the two SQS metrics must appear"
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
          for i, v in m : contains(["Route", "Method", "Role", "Rule", "Reason", "Scope", "QueueName"], tostring(v)) if i >= 2 && i % 2 == 0 && can(tostring(v))
        ]
      ]
    ]))
    error_message = "dimension names must be on the allowlist"
  }

  assert {
    condition = alltrue(flatten([
      for w in jsondecode(aws_cloudwatch_dashboard.overview.dashboard_body).widgets : [
        for m in try(w.properties.metrics, []) : can(regex("^SEARCH\\('\\{\"DBS/Backend\",(Method|Route|Role|Rule|Reason|Scope)(,(Method|Route|Role|Rule|Reason|Scope))*\\} MetricName=\"[a-z0-9_]+\"", m[0].expression)) if try(m[0].expression, null) != null && startswith(m[0].expression, "SEARCH(")
      ]
    ]))
    error_message = "SEARCH must quote the namespace and use allowlisted dimension names only"
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
