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

override_resource {
  target = aws_iam_role.worker_task
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-dev-worker-task"
  }
}

override_resource {
  target = aws_iam_role.worker_execution
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-dev-worker-execution"
  }
}

override_resource {
  target = aws_iam_role.migrate_execution
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-dev-migrate-execution"
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
      vpc_id                     = "vpc-0abc"
      public_subnet_ids          = ["subnet-pub-a", "subnet-pub-b"]
      private_subnet_ids         = ["subnet-prv-a", "subnet-prv-b"]
      ecr_repository_url         = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/dbs-api"
      ecr_repository_arn         = "arn:aws:ecr:ap-southeast-1:123456789012:repository/dbs-api"
      alb_security_group_id      = "sg-alb"
      api_security_group_id      = "sg-api"
      api_log_group_name         = "/dbs/dev/api"
      api_log_group_arn          = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/dbs/dev/api"
      cognito_user_pool_id       = "ap-southeast-1_ABCDEFGHI"
      cognito_client_id          = "abcdefghij1234567890"
      cognito_issuer             = "https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ABCDEFGHI"
      kms_key_arn                = "arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000"
      db_subnet_group_name       = "dbs-dev"
      db_security_group_id       = "sg-db"
      redis_subnet_group_name    = "dbs-dev"
      redis_security_group_id    = "sg-redis"
      redis_auth_secret_arn      = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:dbs/dev/redis-auth-AbCdEf"
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


# TC-121-01..05: task definition của worker (ADR-13: không cổng, không healthCheck; ECS thay task khi tiến trình thoát)
run "worker_task_definition" {
  command = apply

  variables {
    worker_desired_count = 1
  }

  assert {
    condition     = aws_ecs_task_definition.worker.family == "dbs-worker" && aws_ecs_task_definition.worker.cpu == "256" && aws_ecs_task_definition.worker.memory == "512" && aws_ecs_task_definition.worker.network_mode == "awsvpc"
    error_message = "dbs-worker must be a 0.25 vCPU / 0.5 GB awsvpc task (docs/03 section 13.1)"
  }

  # TC-121-01
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].name == "worker"
      && jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].essential == true
      && !contains(keys(jsondecode(aws_ecs_task_definition.worker.container_definitions)[0]), "portMappings")
      && !contains(keys(jsondecode(aws_ecs_task_definition.worker.container_definitions)[0]), "healthCheck")
      && jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].stopTimeout >= 35
      && jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].image == "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/dbs-api:0000000000000000000000000000000000000000"
    )
    error_message = "worker container: essential, no portMappings, no healthCheck (ADR-13), stopTimeout >= 35, same image as the api"
  }

  # TC-121-02
  assert {
    condition = (
      { for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name => e.value }["APP_ROLE"] == "worker"
      && { for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name => e.value }["SQS_RISK_QUEUE_URL"] == "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-risk-events"
      && { for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name => e.value }["SQS_NOTIFICATION_QUEUE_URL"] == "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-notification-events"
      && { for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name => e.value }["DATABASE_SSL"] == "true"
      && { for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name => e.value }["NODE_ENV"] == "staging"
      && { for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name => e.value }["TRUST_PROXY_HOPS"] == "1"
    )
    error_message = "worker env: APP_ROLE=worker, both SQS queue urls from base, TLS to the database, staging, TRUST_PROXY_HOPS"
  }

  assert {
    condition = (
      toset([for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name]) == toset([
        "NODE_ENV", "APP_ROLE", "TRUST_PROXY_HOPS", "AWS_REGION", "LOG_LEVEL", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "COGNITO_ISSUER",
        "DB_HOST", "DB_PORT", "DB_NAME", "DATABASE_SSL", "DATABASE_SSL_CA_PATH", "REDIS_HOST", "REDIS_PORT", "SQS_RISK_QUEUE_URL", "SQS_NOTIFICATION_QUEUE_URL", "RECONCILIATION_INTERVAL_MS",
      ])
    )
    error_message = "worker env must be exactly the documented set: no SQS_ENDPOINT, no PORT, no secrets in plain text"
  }

  # TC-123-05: job đối soát chạy mỗi 60 s để MISMATCH tới alarm trong 5 phút (DoD 2 của DBS-123)
  assert {
    condition     = { for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name => e.value }["RECONCILIATION_INTERVAL_MS"] == "60000"
    error_message = "worker must run the reconciliation job every 60000 ms by default (DBS-123)"
  }

  # TC-121-03
  assert {
    condition     = aws_ecs_task_definition.worker.execution_role_arn == aws_iam_role.worker_execution.arn && aws_ecs_task_definition.worker.task_role_arn == aws_iam_role.worker_task.arn && aws_ecs_task_definition.worker.task_role_arn != aws_iam_role.task.arn && aws_ecs_task_definition.worker.execution_role_arn != aws_iam_role.execution.arn
    error_message = "worker uses its own execution and task roles, never the api ones"
  }

  # TC-121-04: secrets của task def = đúng tập GetSecretValue của execution role worker
  assert {
    condition = (
      toset([for x in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].secrets : replace(x.valueFrom, "/:[a-z_]+::$/", "")])
      == toset(flatten([for st in jsondecode(aws_iam_role_policy.worker_read_secrets.policy).Statement : flatten([st.Resource]) if st.Action == "secretsmanager:GetSecretValue"]))
      && toset([for x in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].secrets : x.name]) == toset(["DB_USER", "DB_PASSWORD", "REDIS_AUTH_TOKEN"])
    )
    error_message = "worker secrets must match exactly what the worker execution role may read"
  }

  # TC-121-05
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].logConfiguration.logDriver == "awslogs"
      && jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].logConfiguration.options["awslogs-group"] == "/dbs/dev/worker"
      && jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].logConfiguration.options["awslogs-region"] == "ap-southeast-1"
      && jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].logConfiguration.options["awslogs-stream-prefix"] == "worker"
      && contains([for st in jsondecode(aws_iam_role_policy.worker_execution.policy).Statement : st.Resource if contains(flatten([st.Action]), "logs:PutLogEvents")], "arn:aws:logs:ap-southeast-1:123456789012:log-group:/dbs/dev/worker:*")
    )
    error_message = "worker logs go to /dbs/dev/worker with prefix worker, and the execution role may write exactly there"
  }
}

# TC-121-06: service worker
run "worker_service" {
  command = apply

  variables {
    worker_desired_count = 1
  }

  assert {
    condition = (
      aws_ecs_service.worker.name == "worker"
      && aws_ecs_service.worker.cluster == aws_ecs_cluster.main.id
      && aws_ecs_service.worker.launch_type == "FARGATE"
      && aws_ecs_service.worker.desired_count == 1
      && aws_ecs_service.worker.task_definition == aws_ecs_task_definition.worker.arn
      && aws_ecs_service.worker.propagate_tags == "TASK_DEFINITION"
    )
    error_message = "worker service: FARGATE in the dbs-dev cluster on the dbs-worker task definition, tags propagated"
  }

  assert {
    condition     = length(aws_ecs_service.worker.load_balancer) == 0 && aws_ecs_service.worker.health_check_grace_period_seconds == null
    error_message = "worker has no load balancer and no health check grace period (ADR-13)"
  }

  assert {
    condition     = one(aws_ecs_service.worker.network_configuration).security_groups == toset(["sg-worker"]) && one(aws_ecs_service.worker.network_configuration).assign_public_ip == true && one(aws_ecs_service.worker.network_configuration).subnets == toset(["subnet-pub-a", "subnet-pub-b"])
    error_message = "worker runs in the public subnets (no NAT, ADR-10) with the worker security group only"
  }

  assert {
    condition     = one(aws_ecs_service.worker.deployment_circuit_breaker).enable == true && one(aws_ecs_service.worker.deployment_circuit_breaker).rollback == true && aws_ecs_service.worker.deployment_minimum_healthy_percent == 0 && aws_ecs_service.worker.deployment_maximum_percent == 100
    error_message = "worker deploys with the circuit breaker and never two workers at once (100% max)"
  }

  assert {
    condition     = output.worker_service_name == "worker" && output.worker_task_definition_arn == aws_ecs_task_definition.worker.arn
    error_message = "outputs worker_service_name and worker_task_definition_arn"
  }
}

# TC-121-07: tắt/bật worker không đụng api
run "worker_off_api_unchanged" {
  command = apply

  variables {
    desired_count        = 1
    worker_desired_count = 0
  }

  assert {
    condition     = aws_ecs_service.worker.desired_count == 0 && aws_ecs_service.api.desired_count == 1
    error_message = "worker off must not change the api desired count"
  }
}

run "worker_on_api_unchanged" {
  command = apply

  variables {
    desired_count        = 1
    worker_desired_count = 1
  }

  assert {
    condition     = aws_ecs_service.worker.desired_count == 1 && aws_ecs_service.api.desired_count == 1 && aws_ecs_service.api.task_definition == aws_ecs_task_definition.api.arn
    error_message = "worker on must not change the api service or its task definition"
  }
}

# TC-121-08: trần số task (74 kết nối dùng được: tổng task × 10 + 5)
run "worker_default_is_zero" {
  command = plan

  assert {
    condition     = var.worker_desired_count == 0
    error_message = "worker_desired_count defaults to 0"
  }
}

run "rejects_three_workers" {
  command = plan

  variables {
    worker_desired_count = 3
  }

  expect_failures = [var.worker_desired_count]
}

run "rejects_total_above_six" {
  command = plan

  variables {
    desired_count        = 6
    worker_desired_count = 1
  }

  expect_failures = [var.worker_desired_count]
}

run "accepts_five_plus_one" {
  command = plan

  variables {
    desired_count        = 5
    worker_desired_count = 1
  }

  assert {
    condition     = aws_ecs_service.worker.desired_count == 1
    error_message = "5 api + 1 worker is within the limit"
  }
}

# TC-123-06: chu kỳ đối soát chỉ nhận 10 s đến 300 s (trần 300 s = mặc định của ứng dụng; dưới 10 s tải DB vô ích)
run "rejects_reconciliation_interval_above_five_minutes" {
  command = plan
  variables {
    reconciliation_interval_ms = 301000
  }
  expect_failures = [var.reconciliation_interval_ms]
}

run "rejects_reconciliation_interval_below_ten_seconds" {
  command = plan
  variables {
    reconciliation_interval_ms = 5000
  }
  expect_failures = [var.reconciliation_interval_ms]
}
