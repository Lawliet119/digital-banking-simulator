# Alarm CloudWatch của session (BL-051, BL-117, BL-127, BL-179, BL-181, BL-182, BL-188, BL-235, DBS-163). Mock, biến và override chép từ dashboard.tftest.hcl vì chỉ có hiệu lực trong file khai báo chúng.
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
    arn        = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/dbs-dev/0123456789abcdef"
    arn_suffix = "app/dbs-dev/0123456789abcdef"
  }
}

override_resource {
  target = aws_lb_target_group.api
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


# TC-ALM-01: mọi alarm gửi vào topic SNS của base, cả khi báo và khi hết; alarm chạy trong session
run "all_alarms_notify_the_topic" {
  command = plan

  assert {
    condition = alltrue([
      for a in concat(
        values(aws_cloudwatch_metric_alarm.queue_age),
        [
          aws_cloudwatch_metric_alarm.outbox_age,
          aws_cloudwatch_metric_alarm.outbox_quarantined,
          aws_cloudwatch_metric_alarm.risk_config_invalid,
          aws_cloudwatch_metric_alarm.risk_rule_error,
          aws_cloudwatch_metric_alarm.reconciliation,
          aws_cloudwatch_metric_alarm.redis_node_missing,
          aws_cloudwatch_metric_alarm.redis_fallback,
          aws_cloudwatch_metric_alarm.risk_config_redis_fallback,
          aws_cloudwatch_metric_alarm.rate_limited,
          aws_cloudwatch_metric_alarm.api_5xx_rate,
          aws_cloudwatch_metric_alarm.transfer_latency_p95,
          aws_cloudwatch_metric_alarm.read_latency_p95,
          aws_cloudwatch_metric_alarm.transfer_to_flag_p95,
        ],
      ) : a.alarm_actions == toset(["arn:aws:sns:ap-southeast-1:123456789012:dbs-dev-alarms"]) && a.ok_actions == toset(["arn:aws:sns:ap-southeast-1:123456789012:dbs-dev-alarms"])
    ])
    error_message = "every session alarm must send ALARM and OK to the base SNS topic"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.queue_age) == 2
    error_message = "15 session alarms: 2 queue age + 13 others (17 with the 2 DLQ alarms of base)"
  }
}

# TC-ALM-02: tuổi message cũ nhất của hai queue chính (DBS-163): SLO 60 s, alarm > 120 s
run "queue_age_alarms" {
  command = plan

  assert {
    condition     = toset(keys(aws_cloudwatch_metric_alarm.queue_age)) == toset(["dbs-dev-risk-events", "dbs-dev-notification-events"])
    error_message = "one age alarm per main queue (the DLQ name without -dlq)"
  }

  assert {
    condition = alltrue([for k, a in aws_cloudwatch_metric_alarm.queue_age : (
      a.namespace == "AWS/SQS" &&
      a.metric_name == "ApproximateAgeOfOldestMessage" &&
      jsonencode(a.dimensions) == jsonencode({ QueueName = k }) &&
      a.statistic == "Maximum" &&
      a.period == 60 &&
      a.evaluation_periods == 1 &&
      a.threshold == 120 &&
      a.comparison_operator == "GreaterThanThreshold" &&
      a.treat_missing_data == "notBreaching"
    )])
    error_message = "queue age: AWS/SQS ApproximateAgeOfOldestMessage, Maximum, 60 s x 1, > 120, notBreaching"
  }
}

# TC-ALM-03 (BL-182): tuổi outbox. Gauge chỉ có bộ dimension [], thống kê Maximum, thiếu dữ liệu là vi phạm,
# 3 trên 5 điểm 60 giây (một lô relay bình thường tới 25 s, DBS-91)
run "outbox_age_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.outbox_age.alarm_name == "dbs-dev-outbox-age" &&
      aws_cloudwatch_metric_alarm.outbox_age.namespace == "DBS/Backend" &&
      aws_cloudwatch_metric_alarm.outbox_age.metric_name == "outbox_oldest_unpublished_age_seconds" &&
      length(coalesce(aws_cloudwatch_metric_alarm.outbox_age.dimensions, {})) == 0 &&
      aws_cloudwatch_metric_alarm.outbox_age.statistic == "Maximum"
    )
    error_message = "outbox age: DBS/Backend outbox_oldest_unpublished_age_seconds, no dimension (gauge), Maximum"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.outbox_age.threshold == 30 &&
      aws_cloudwatch_metric_alarm.outbox_age.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.outbox_age.period == 60 &&
      aws_cloudwatch_metric_alarm.outbox_age.evaluation_periods == 5 &&
      aws_cloudwatch_metric_alarm.outbox_age.datapoints_to_alarm == 3 &&
      aws_cloudwatch_metric_alarm.outbox_age.treat_missing_data == "breaching"
    )
    error_message = "outbox age: > 30 s, 3 of 5 one-minute points, missing data breaching"
  }

  # Một lô relay 25 s không được làm alarm kêu: cần ít nhất 2 điểm liên tiếp... tức dữ liệu không thể là một điểm duy nhất
  assert {
    condition     = aws_cloudwatch_metric_alarm.outbox_age.datapoints_to_alarm >= 2 && aws_cloudwatch_metric_alarm.outbox_age.threshold > 25
    error_message = "a single 25 s relay batch must not trip the alarm (threshold above 25 s and at least 2 datapoints)"
  }
}

# TC-ALM-03b (BL-181): sự kiện outbox bị cách ly. Gauge không dimension, Maximum, một điểm 300 s > 0 là báo;
# thiếu dữ liệu = `ignore` (giữ nguyên trạng thái: worker chết đã có alarm tuổi outbox, và alarm đang ALARM không được tự về OK vì mất số đo)
run "outbox_quarantined_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.outbox_quarantined.alarm_name == "dbs-dev-outbox-quarantined" &&
      aws_cloudwatch_metric_alarm.outbox_quarantined.namespace == "DBS/Backend" &&
      aws_cloudwatch_metric_alarm.outbox_quarantined.metric_name == "outbox_quarantined_events" &&
      length(coalesce(aws_cloudwatch_metric_alarm.outbox_quarantined.dimensions, {})) == 0 &&
      aws_cloudwatch_metric_alarm.outbox_quarantined.statistic == "Maximum"
    )
    error_message = "outbox quarantined: DBS/Backend outbox_quarantined_events, no dimension (gauge), Maximum"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.outbox_quarantined.threshold == 0 &&
      aws_cloudwatch_metric_alarm.outbox_quarantined.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.outbox_quarantined.period == 300 &&
      aws_cloudwatch_metric_alarm.outbox_quarantined.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.outbox_quarantined.datapoints_to_alarm == 1
    )
    error_message = "outbox quarantined: any value above 0 in one 300 s period"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.outbox_quarantined.treat_missing_data == "ignore"
    error_message = "outbox quarantined: missing data keeps the current state (ignore), neither breaching nor notBreaching"
  }
}

# TC-ALM-04 (BL-051, BL-188): CONFIG_INVALID. Counter có bộ dimension [Role, AiStatus] và không có bộ [].
run "config_invalid_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.risk_config_invalid.namespace == "DBS/Backend" &&
      aws_cloudwatch_metric_alarm.risk_config_invalid.metric_name == "risk_decision_total" &&
      jsonencode(aws_cloudwatch_metric_alarm.risk_config_invalid.dimensions) == jsonencode({ Role = "worker", AiStatus = "CONFIG_INVALID" }) &&
      aws_cloudwatch_metric_alarm.risk_config_invalid.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.risk_config_invalid.threshold == 0 &&
      aws_cloudwatch_metric_alarm.risk_config_invalid.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.risk_config_invalid.period == 300 &&
      aws_cloudwatch_metric_alarm.risk_config_invalid.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.risk_config_invalid.treat_missing_data == "notBreaching"
    )
    error_message = "CONFIG_INVALID: risk_decision_total {Role=worker, AiStatus=CONFIG_INVALID} Sum > 0, 300 s x 1, notBreaching"
  }
}

# TC-ALM-05 (BL-051): lỗi luật R1..R6, một alarm gộp sáu metric tường minh bằng SUM(METRICS())
run "risk_rule_error_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.risk_rule_error.threshold == 0 &&
      aws_cloudwatch_metric_alarm.risk_rule_error.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.risk_rule_error.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.risk_rule_error.treat_missing_data == "notBreaching"
    )
    error_message = "rule error: > 0, 1 period, notBreaching"
  }

  assert {
    condition = (
      length([for q in aws_cloudwatch_metric_alarm.risk_rule_error.metric_query : q if q.return_data]) == 1 &&
      one([for q in aws_cloudwatch_metric_alarm.risk_rule_error.metric_query : q.expression if q.return_data]) == "SUM(METRICS())"
    )
    error_message = "rule error: exactly one returned series, SUM(METRICS())"
  }

  assert {
    condition = (
      toset([for q in aws_cloudwatch_metric_alarm.risk_rule_error.metric_query : q.metric[0].dimensions["Rule"] if !q.return_data]) == toset(["R1", "R2", "R3", "R4", "R5", "R6"]) &&
      alltrue([for q in aws_cloudwatch_metric_alarm.risk_rule_error.metric_query : (
        q.metric[0].namespace == "DBS/Backend" &&
        q.metric[0].metric_name == "risk_rule_error_total" &&
        q.metric[0].dimensions["Role"] == "worker" &&
        length(q.metric[0].dimensions) == 2 &&
        q.metric[0].stat == "Sum" &&
        q.metric[0].period == 300
      ) if !q.return_data])
    )
    error_message = "rule error: risk_rule_error_total {Role=worker, Rule=R1..R6} Sum, 300 s"
  }
}

# TC-ALM-06 (BL-127, DBS-123): đối soát MISMATCH hoặc ERROR
run "reconciliation_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.reconciliation.alarm_name == "dbs-dev-reconciliation-failed" &&
      aws_cloudwatch_metric_alarm.reconciliation.threshold == 0 &&
      aws_cloudwatch_metric_alarm.reconciliation.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.reconciliation.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.reconciliation.treat_missing_data == "notBreaching" &&
      one([for q in aws_cloudwatch_metric_alarm.reconciliation.metric_query : q.expression if q.return_data]) == "SUM(METRICS())"
    )
    error_message = "reconciliation: SUM(METRICS()) > 0, 1 period, notBreaching"
  }

  assert {
    condition = (
      toset([for q in aws_cloudwatch_metric_alarm.reconciliation.metric_query : q.metric[0].dimensions["Status"] if !q.return_data]) == toset(["MISMATCH", "ERROR"]) &&
      alltrue([for q in aws_cloudwatch_metric_alarm.reconciliation.metric_query : (
        q.metric[0].namespace == "DBS/Backend" &&
        q.metric[0].metric_name == "reconciliation_runs_total" &&
        q.metric[0].dimensions["Role"] == "worker" &&
        length(q.metric[0].dimensions) == 2 &&
        q.metric[0].stat == "Sum" &&
        q.metric[0].period == 300
      ) if !q.return_data])
    )
    error_message = "reconciliation: reconciliation_runs_total {Role=worker, Status=MISMATCH|ERROR} Sum, 300 s (never OK)"
  }

  # Chu kỳ đánh giá không dài hơn 5 phút (DBS-123)
  assert {
    condition     = alltrue([for q in aws_cloudwatch_metric_alarm.reconciliation.metric_query : q.metric[0].period <= 300 if !q.return_data]) && aws_cloudwatch_metric_alarm.reconciliation.evaluation_periods == 1
    error_message = "reconciliation must alarm within 5 minutes"
  }
}

# TC-ALM-07 (BL-117): Redis không truy cập được > 1 phút: heartbeat của node
run "redis_node_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.redis_node_missing.namespace == "AWS/ElastiCache" &&
      aws_cloudwatch_metric_alarm.redis_node_missing.metric_name == "CPUUtilization" &&
      jsonencode(aws_cloudwatch_metric_alarm.redis_node_missing.dimensions) == jsonencode({ CacheClusterId = "dbs-dev-001" }) &&
      aws_cloudwatch_metric_alarm.redis_node_missing.statistic == "Average" &&
      aws_cloudwatch_metric_alarm.redis_node_missing.period == 60 &&
      aws_cloudwatch_metric_alarm.redis_node_missing.evaluation_periods == 2 &&
      aws_cloudwatch_metric_alarm.redis_node_missing.threshold == 100 &&
      aws_cloudwatch_metric_alarm.redis_node_missing.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.redis_node_missing.treat_missing_data == "breaching"
    )
    error_message = "redis node: AWS/ElastiCache CPUUtilization of dbs-dev-001, 60 s x 2, > 100 (never real data), missing data breaching"
  }

  assert {
    condition     = strcontains(aws_cloudwatch_metric_alarm.redis_node_missing.alarm_description, "dbs-dev-001")
    error_message = "description names the node"
  }
}

# TC-ALM-08 (BL-179): redis_fallback_total, Role api + worker, 2 điểm 60 giây liên tiếp
run "redis_fallback_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.redis_fallback.threshold == 0 &&
      aws_cloudwatch_metric_alarm.redis_fallback.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.redis_fallback.evaluation_periods == 2 &&
      aws_cloudwatch_metric_alarm.redis_fallback.datapoints_to_alarm == 2 &&
      aws_cloudwatch_metric_alarm.redis_fallback.treat_missing_data == "notBreaching" &&
      one([for q in aws_cloudwatch_metric_alarm.redis_fallback.metric_query : q.expression if q.return_data]) == "SUM(METRICS())"
    )
    error_message = "redis fallback: SUM(METRICS()) > 0 in 2 of 2 periods, notBreaching"
  }

  assert {
    condition = (
      toset([for q in aws_cloudwatch_metric_alarm.redis_fallback.metric_query : q.metric[0].dimensions["Role"] if !q.return_data]) == toset(["api", "worker"]) &&
      alltrue([for q in aws_cloudwatch_metric_alarm.redis_fallback.metric_query : (
        q.metric[0].namespace == "DBS/Backend" &&
        q.metric[0].metric_name == "redis_fallback_total" &&
        length(q.metric[0].dimensions) == 1 &&
        q.metric[0].stat == "Sum" &&
        q.metric[0].period == 60
      ) if !q.return_data])
    )
    error_message = "redis fallback: redis_fallback_total {Role=api|worker} (the only dimension set) Sum, 60 s"
  }
}

# TC-ALM-09 (BL-235): risk_config_redis_fallback_total
run "risk_config_fallback_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.risk_config_redis_fallback.namespace == "DBS/Backend" &&
      aws_cloudwatch_metric_alarm.risk_config_redis_fallback.metric_name == "risk_config_redis_fallback_total" &&
      jsonencode(aws_cloudwatch_metric_alarm.risk_config_redis_fallback.dimensions) == jsonencode({ Role = "worker" }) &&
      aws_cloudwatch_metric_alarm.risk_config_redis_fallback.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.risk_config_redis_fallback.period == 60 &&
      aws_cloudwatch_metric_alarm.risk_config_redis_fallback.evaluation_periods == 2 &&
      aws_cloudwatch_metric_alarm.risk_config_redis_fallback.datapoints_to_alarm == 2 &&
      aws_cloudwatch_metric_alarm.risk_config_redis_fallback.threshold == 0 &&
      aws_cloudwatch_metric_alarm.risk_config_redis_fallback.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.risk_config_redis_fallback.treat_missing_data == "notBreaching"
    )
    error_message = "risk config fallback: risk_config_redis_fallback_total {Role=worker} Sum > 0, 60 s, 2 of 2, notBreaching"
  }
}

# TC-ALM-10 (BL-179): rate_limited_total, Role api, hai Scope, 50 mỗi 5 phút
run "rate_limited_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.rate_limited.threshold == 50 &&
      aws_cloudwatch_metric_alarm.rate_limited.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.rate_limited.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.rate_limited.treat_missing_data == "notBreaching" &&
      one([for q in aws_cloudwatch_metric_alarm.rate_limited.metric_query : q.expression if q.return_data]) == "SUM(METRICS())"
    )
    error_message = "rate limited: SUM(METRICS()) > 50, 1 period, notBreaching"
  }

  assert {
    condition = (
      toset([for q in aws_cloudwatch_metric_alarm.rate_limited.metric_query : q.metric[0].dimensions["Scope"] if !q.return_data]) == toset(["ip", "user"]) &&
      alltrue([for q in aws_cloudwatch_metric_alarm.rate_limited.metric_query : (
        q.metric[0].namespace == "DBS/Backend" &&
        q.metric[0].metric_name == "rate_limited_total" &&
        q.metric[0].dimensions["Role"] == "api" &&
        length(q.metric[0].dimensions) == 2 &&
        q.metric[0].stat == "Sum" &&
        q.metric[0].period == 300
      ) if !q.return_data])
    )
    error_message = "rate limited: rate_limited_total {Role=api, Scope=ip|user} Sum, 300 s"
  }
}

# TC-ALM-11: namespace đổi được (thử bằng số mô phỏng), SQS và ElastiCache thì không
run "alarms_follow_metrics_namespace" {
  command = plan

  variables {
    metrics_namespace = "DBS/Backend-alm"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.outbox_age.namespace == "DBS/Backend-alm" &&
      aws_cloudwatch_metric_alarm.outbox_quarantined.namespace == "DBS/Backend-alm" &&
      aws_cloudwatch_metric_alarm.risk_config_invalid.namespace == "DBS/Backend-alm" &&
      aws_cloudwatch_metric_alarm.risk_config_redis_fallback.namespace == "DBS/Backend-alm" &&
      alltrue([for q in aws_cloudwatch_metric_alarm.redis_fallback.metric_query : q.metric[0].namespace == "DBS/Backend-alm" if !q.return_data]) &&
      alltrue([for q in aws_cloudwatch_metric_alarm.reconciliation.metric_query : q.metric[0].namespace == "DBS/Backend-alm" if !q.return_data]) &&
      alltrue([for q in aws_cloudwatch_metric_alarm.risk_rule_error.metric_query : q.metric[0].namespace == "DBS/Backend-alm" if !q.return_data]) &&
      alltrue([for q in aws_cloudwatch_metric_alarm.rate_limited.metric_query : q.metric[0].namespace == "DBS/Backend-alm" if !q.return_data]) &&
      alltrue([for q in aws_cloudwatch_metric_alarm.api_5xx_rate.metric_query : q.metric[0].namespace == "DBS/Backend-alm" if !q.return_data]) &&
      aws_cloudwatch_metric_alarm.transfer_latency_p95.namespace == "DBS/Backend-alm" &&
      alltrue([for q in aws_cloudwatch_metric_alarm.read_latency_p95.metric_query : q.metric[0].namespace == "DBS/Backend-alm" if !q.return_data]) &&
      aws_cloudwatch_metric_alarm.transfer_to_flag_p95.namespace == "DBS/Backend-alm" &&
      alltrue([for a in aws_cloudwatch_metric_alarm.queue_age : a.namespace == "AWS/SQS"]) &&
      aws_cloudwatch_metric_alarm.redis_node_missing.namespace == "AWS/ElastiCache"
    )
    error_message = "application alarms follow metrics_namespace; AWS/SQS and AWS/ElastiCache stay"
  }
}

# TC-177-01 (DBS-177): tỉ lệ 5xx > 1% trong 5 phút, bộ dimension [] (không gồm /health/*)
run "api_5xx_rate_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.api_5xx_rate.alarm_name == "dbs-dev-api-5xx-rate" &&
      aws_cloudwatch_metric_alarm.api_5xx_rate.threshold == 1 &&
      aws_cloudwatch_metric_alarm.api_5xx_rate.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.api_5xx_rate.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.api_5xx_rate.treat_missing_data == "notBreaching" &&
      one([for q in aws_cloudwatch_metric_alarm.api_5xx_rate.metric_query : q.expression if q.return_data]) == "IF(mr > 0, 100 * FILL(m5, 0) / mr, 0)"
    )
    error_message = "5xx rate: IF(mr > 0, 100 * FILL(m5, 0) / mr, 0) > 1%, 1 period, notBreaching"
  }

  assert {
    condition = (
      toset([for q in aws_cloudwatch_metric_alarm.api_5xx_rate.metric_query : q.metric[0].metric_name if !q.return_data]) == toset(["http_5xx_total", "http_requests_total"]) &&
      alltrue([for q in aws_cloudwatch_metric_alarm.api_5xx_rate.metric_query : (
        q.metric[0].namespace == "DBS/Backend" &&
        length(coalesce(q.metric[0].dimensions, {})) == 0 &&
        q.metric[0].stat == "Sum" &&
        q.metric[0].period == 300
      ) if !q.return_data])
    )
    error_message = "5xx rate: http_5xx_total & http_requests_total with no dimensions ([]), Sum, 300 s"
  }
}

# TC-177-02 (DBS-177): latency chuyển tiền p95 > 300 ms trong 3 cửa sổ 5 phút liên tiếp
run "transfer_latency_p95_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.transfer_latency_p95.alarm_name == "dbs-dev-transfer-latency-p95" &&
      aws_cloudwatch_metric_alarm.transfer_latency_p95.namespace == "DBS/Backend" &&
      aws_cloudwatch_metric_alarm.transfer_latency_p95.metric_name == "http_request_duration_ms" &&
      jsonencode(aws_cloudwatch_metric_alarm.transfer_latency_p95.dimensions) == jsonencode({ Method = "POST", Route = "/v1/transfers" }) &&
      aws_cloudwatch_metric_alarm.transfer_latency_p95.extended_statistic == "p95" &&
      aws_cloudwatch_metric_alarm.transfer_latency_p95.period == 300 &&
      aws_cloudwatch_metric_alarm.transfer_latency_p95.evaluation_periods == 3 &&
      aws_cloudwatch_metric_alarm.transfer_latency_p95.datapoints_to_alarm == 3 &&
      aws_cloudwatch_metric_alarm.transfer_latency_p95.threshold == 300 &&
      aws_cloudwatch_metric_alarm.transfer_latency_p95.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.transfer_latency_p95.treat_missing_data == "notBreaching"
    )
    error_message = "transfer latency: POST /v1/transfers p95 > 300 ms in 3 of 3 300 s periods, notBreaching"
  }
}

# TC-177-03 (DBS-177): latency đọc p95 > 150 ms trong 3 cửa sổ 5 phút liên tiếp (MAX trên 3 route đọc)
run "read_latency_p95_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.read_latency_p95.alarm_name == "dbs-dev-read-latency-p95" &&
      aws_cloudwatch_metric_alarm.read_latency_p95.threshold == 150 &&
      aws_cloudwatch_metric_alarm.read_latency_p95.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.read_latency_p95.evaluation_periods == 3 &&
      aws_cloudwatch_metric_alarm.read_latency_p95.datapoints_to_alarm == 3 &&
      aws_cloudwatch_metric_alarm.read_latency_p95.treat_missing_data == "notBreaching" &&
      one([for q in aws_cloudwatch_metric_alarm.read_latency_p95.metric_query : q.expression if q.return_data]) == "MAX(METRICS())"
    )
    error_message = "read latency: MAX(METRICS()) > 150 ms in 3 of 3 periods, notBreaching"
  }

  assert {
    condition = (
      toset([for q in aws_cloudwatch_metric_alarm.read_latency_p95.metric_query : q.metric[0].dimensions["Route"] if !q.return_data]) == toset(["/v1/accounts", "/v1/accounts/:id", "/v1/accounts/:id/transactions"]) &&
      alltrue([for q in aws_cloudwatch_metric_alarm.read_latency_p95.metric_query : (
        q.metric[0].namespace == "DBS/Backend" &&
        q.metric[0].metric_name == "http_request_duration_ms" &&
        q.metric[0].dimensions["Method"] == "GET" &&
        length(q.metric[0].dimensions) == 2 &&
        q.metric[0].stat == "p95" &&
        q.metric[0].period == 300
      ) if !q.return_data])
    )
    error_message = "read latency: GET /v1/accounts, /:id, /:id/transactions p95, 300 s"
  }
}

# TC-177-04 (DBS-177): thời gian từ giao dịch tới cờ p95 > 5 giây trong 15 phút (900 s)
run "transfer_to_flag_p95_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.transfer_to_flag_p95.alarm_name == "dbs-dev-transfer-to-flag-p95" &&
      aws_cloudwatch_metric_alarm.transfer_to_flag_p95.namespace == "DBS/Backend" &&
      aws_cloudwatch_metric_alarm.transfer_to_flag_p95.metric_name == "risk_transfer_to_flag_ms" &&
      jsonencode(aws_cloudwatch_metric_alarm.transfer_to_flag_p95.dimensions) == jsonencode({ Role = "worker" }) &&
      aws_cloudwatch_metric_alarm.transfer_to_flag_p95.extended_statistic == "p95" &&
      aws_cloudwatch_metric_alarm.transfer_to_flag_p95.period == 900 &&
      aws_cloudwatch_metric_alarm.transfer_to_flag_p95.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.transfer_to_flag_p95.threshold == 5000 &&
      aws_cloudwatch_metric_alarm.transfer_to_flag_p95.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.transfer_to_flag_p95.treat_missing_data == "notBreaching"
    )
    error_message = "transfer to flag: risk_transfer_to_flag_ms {Role=worker} p95 > 5000 ms, 900 s x 1, notBreaching"
  }
}
