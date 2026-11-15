mock_provider "aws" {}

variables {
  state_bucket    = "dbs-tfstate-123456789012-ap-southeast-1"
  account_id      = "123456789012"
  image_tag       = "0000000000000000000000000000000000000000"
  certificate_arn = "arn:aws:acm:ap-southeast-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
}

override_resource {
  target = aws_lb.main
  values = {
    arn      = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/dbs-prod/0123456789abcdef"
    dns_name = "dbs-prod-123456789.ap-southeast-1.elb.amazonaws.com"
  }
}

override_resource {
  target = aws_lb_target_group.api
  values = {
    arn = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/dbs-prod-api/0123456789abcdef"
  }
}

override_resource {
  target = aws_iam_role.execution
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-prod-api-execution"
  }
}

override_resource {
  target = aws_iam_role.task
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-prod-api-task"
  }
}

override_resource {
  target = aws_iam_role.worker_task
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-prod-worker-task"
  }
}

override_resource {
  target = aws_iam_role.worker_execution
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-prod-worker-execution"
  }
}

override_resource {
  target = aws_iam_role.migrate_execution
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-prod-migrate-execution"
  }
}

override_resource {
  target = aws_iam_policy.worker_sqs
  values = {
    arn = "arn:aws:iam::123456789012:policy/dbs-prod-worker-sqs"
  }
}

override_resource {
  target = aws_db_instance.main
  values = {
    address  = "dbs-prod.abcdef123456.ap-southeast-1.rds.amazonaws.com"
    endpoint = "dbs-prod.abcdef123456.ap-southeast-1.rds.amazonaws.com:5432"
    port     = 5432
    master_user_secret = [{
      secret_arn    = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:rds!db-00000000-0000-0000-0000-000000000000-AbCdEf"
      kms_key_id    = "arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000"
      secret_status = "active"
    }]
  }
}

override_resource {
  target = aws_elasticache_replication_group.main
  values = {
    id                       = "dbs-prod"
    primary_endpoint_address = "master.dbs-prod.abcdef.apse1.cache.amazonaws.com"
  }
}

override_resource {
  target = aws_secretsmanager_secret.redis_auth
  values = {
    id  = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:dbs/prod/redis-auth-AbCdEf"
    arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:dbs/prod/redis-auth-AbCdEf"
  }
}

override_resource {
  target = aws_cloudwatch_log_group.api
  values = {
    arn = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/dbs/prod/api"
  }
}

override_resource {
  target = aws_cloudwatch_log_group.worker
  values = {
    arn = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/dbs/prod/worker"
  }
}

override_resource {
  target = aws_sqs_queue.main["risk"]
  values = {
    id  = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-prod-risk-events"
    url = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-prod-risk-events"
    arn = "arn:aws:sqs:ap-southeast-1:123456789012:dbs-prod-risk-events"
  }
}

override_resource {
  target = aws_sqs_queue.main["notification"]
  values = {
    id  = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-prod-notification-events"
    url = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-prod-notification-events"
    arn = "arn:aws:sqs:ap-southeast-1.amazonaws.com/123456789012:dbs-prod-notification-events"
  }
}

override_resource {
  target = aws_sqs_queue.dlq["risk"]
  values = {
    id  = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-prod-risk-events-dlq"
    url = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-prod-risk-events-dlq"
    arn = "arn:aws:sqs:ap-southeast-1:123456789012:dbs-prod-risk-events-dlq"
  }
}

override_resource {
  target = aws_sqs_queue.dlq["notification"]
  values = {
    id  = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-prod-notification-events-dlq"
    url = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-prod-notification-events-dlq"
    arn = "arn:aws:sqs:ap-southeast-1:123456789012:dbs-prod-notification-events-dlq"
  }
}

override_data {
  target = data.aws_subnet.private[0]
  values = {
    availability_zone = "ap-southeast-1a"
  }
}

override_data {
  target = data.aws_subnet.private[1]
  values = {
    availability_zone = "ap-southeast-1b"
  }
}

override_data {
  target = data.terraform_remote_state.base
  values = {
    outputs = {
      vpc_id                   = "vpc-0abc"
      public_subnet_ids        = ["subnet-pub-a", "subnet-pub-b"]
      private_subnet_ids       = ["subnet-prv-a", "subnet-prv-b"]
      ecr_repository_url       = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/dbs-api"
      ecr_repository_arn       = "arn:aws:ecr:ap-southeast-1:123456789012:repository/dbs-api"
      alb_security_group_id    = "sg-alb"
      api_security_group_id    = "sg-api"
      worker_security_group_id = "sg-worker"
      cognito_user_pool_id     = "ap-southeast-1_ABCDEFGHI"
      cognito_client_id        = "abcdefghij1234567890"
      cognito_issuer           = "https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ABCDEFGHI"
      kms_key_arn              = "arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000"
      db_subnet_group_name     = "dbs-dev"
      db_security_group_id     = "sg-db"
      redis_subnet_group_name  = "dbs-dev"
      redis_security_group_id  = "sg-redis"
    }
  }
}

# TC-152-01: ALB TLS 1.3/1.2 ở :443 và redirect 301 ở :80
run "tc_152_01_alb_tls_and_redirect" {
  command = plan

  assert {
    condition     = aws_lb.main.internal == false && aws_lb.main.drop_invalid_header_fields == true
    error_message = "ALB must be internet-facing with drop_invalid_header_fields = true"
  }

  assert {
    condition     = aws_lb_listener.https.port == 443 && aws_lb_listener.https.protocol == "HTTPS"
    error_message = "HTTPS listener must listen on 443"
  }

  assert {
    condition     = aws_lb_listener.https.ssl_policy == "ELBSecurityPolicy-TLS13-1-2-2021-06"
    error_message = "HTTPS listener must use ELBSecurityPolicy-TLS13-1-2-2021-06"
  }

  assert {
    condition     = aws_lb_listener.https.certificate_arn == var.certificate_arn
    error_message = "HTTPS listener must use var.certificate_arn"
  }

  assert {
    condition     = aws_lb_listener.https.default_action[0].type == "forward"
    error_message = "HTTPS listener must forward to API target group"
  }

  assert {
    condition     = aws_lb_listener.http.port == 80 && aws_lb_listener.http.protocol == "HTTP"
    error_message = "HTTP listener must listen on 80"
  }

  assert {
    condition = (
      aws_lb_listener.http.default_action[0].type == "redirect" &&
      aws_lb_listener.http.default_action[0].redirect[0].protocol == "HTTPS" &&
      aws_lb_listener.http.default_action[0].redirect[0].port == "443" &&
      aws_lb_listener.http.default_action[0].redirect[0].status_code == "HTTP_301"
    )
    error_message = "HTTP listener must redirect 301 to HTTPS:443, never forward"
  }
}

# TC-152-02: từ chối certificate_arn rỗng, khác tài khoản, khác vùng, hoặc không phải ACM
run "tc_152_02_rejects_empty_certificate_arn" {
  command = plan

  variables {
    certificate_arn = ""
  }

  expect_failures = [var.certificate_arn]
}

run "tc_152_02_rejects_wrong_account_certificate_arn" {
  command = plan

  variables {
    certificate_arn = "arn:aws:acm:ap-southeast-1:111111111111:certificate/00000000-0000-0000-0000-000000000000"
  }

  expect_failures = [var.certificate_arn]
}

run "tc_152_02_rejects_wrong_region_certificate_arn" {
  command = plan

  variables {
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  }

  expect_failures = [var.certificate_arn]
}

run "tc_152_02_rejects_non_acm_certificate_arn" {
  command = plan

  variables {
    certificate_arn = "arn:aws:iam::123456789012:server-certificate/prod"
  }

  expect_failures = [var.certificate_arn]
}

# TC-152-03 & TC-152-04: biến môi trường production và secrets của api, worker, migrate
run "tc_152_03_04_container_env_and_secrets" {
  command = apply

  assert {
    condition = alltrue([
      for role, envs in output.container_environment :
      contains([for e in envs : "${e.name}=${e.value}"], "NODE_ENV=production") &&
      contains([for e in envs : "${e.name}=${e.value}"], "DATABASE_SSL=true") &&
      contains([for e in envs : "${e.name}=${e.value}"], "DATABASE_SSL_CA_PATH=/etc/ssl/rds/global-bundle.pem")
    ])
    error_message = "api, worker, migrate must set NODE_ENV=production, DATABASE_SSL=true, DATABASE_SSL_CA_PATH"
  }

  assert {
    condition = (
      contains([for e in output.container_environment.api : "${e.name}=${e.value}"], "TRUST_PROXY_HOPS=1") &&
      contains([for e in output.container_environment.worker : "${e.name}=${e.value}"], "TRUST_PROXY_HOPS=1") &&
      contains([for e in output.container_environment.api : "${e.name}=${e.value}"], "REDIS_PORT=6379") &&
      contains([for e in output.container_environment.worker : "${e.name}=${e.value}"], "REDIS_PORT=6379") &&
      contains([for e in output.container_environment.api : "${e.name}=${e.value}"], "REDIS_HOST=${aws_elasticache_replication_group.main.primary_endpoint_address}") &&
      contains([for e in output.container_environment.worker : "${e.name}=${e.value}"], "REDIS_HOST=${aws_elasticache_replication_group.main.primary_endpoint_address}")
    )
    error_message = "api and worker must set TRUST_PROXY_HOPS=1, REDIS_HOST, REDIS_PORT=6379"
  }

  assert {
    condition = alltrue([
      for role, envs in output.container_environment :
      !anytrue([
        for e in envs :
        contains(["AUTH_MODE", "AUTH_LOCAL_JWKS_PATH", "SQS_ENDPOINT", "REDIS_URL", "DATABASE_URL", "OPENAI_API_KEY"], e.name) ||
        can(regex("(PASSWORD|TOKEN|SECRET)", e.name))
      ])
    ])
    error_message = "Forbidden or secret-named env vars must not appear in plain environment"
  }

  assert {
    condition = (
      contains([for s in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : s.name], "DB_USER") &&
      contains([for s in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : s.name], "DB_PASSWORD") &&
      contains([for s in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : s.name], "REDIS_AUTH_TOKEN") &&
      contains([for s in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].secrets : s.name], "DB_USER") &&
      contains([for s in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].secrets : s.name], "DB_PASSWORD") &&
      contains([for s in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].secrets : s.name], "REDIS_AUTH_TOKEN") &&
      contains([for s in jsondecode(aws_ecs_task_definition.migrate.container_definitions)[0].secrets : s.name], "DB_USER") &&
      contains([for s in jsondecode(aws_ecs_task_definition.migrate.container_definitions)[0].secrets : s.name], "DB_PASSWORD")
    )
    error_message = "DB_USER, DB_PASSWORD, REDIS_AUTH_TOKEN must be injected via container secrets"
  }
}

# TC-152-05: Valkey Multi-AZ 2 node ở 2 AZ, TLS required, AUTH write-only, recovery_window = 0
run "tc_152_05_valkey_multi_az_tls_and_secret" {
  command = apply

  assert {
    condition = (
      aws_elasticache_replication_group.main.transit_encryption_enabled == true &&
      aws_elasticache_replication_group.main.transit_encryption_mode == "required" &&
      aws_elasticache_replication_group.main.at_rest_encryption_enabled == "true" &&
      aws_elasticache_replication_group.main.num_cache_clusters == 2 &&
      aws_elasticache_replication_group.main.automatic_failover_enabled == true &&
      aws_elasticache_replication_group.main.multi_az_enabled == true &&
      length(distinct(aws_elasticache_replication_group.main.preferred_cache_cluster_azs)) == 2
    )
    error_message = "Valkey must be 2 nodes across 2 distinct AZs with Multi-AZ, failover, and TLS required"
  }

  assert {
    condition = (
      aws_elasticache_replication_group.main.auth_token_wo_version == 1 &&
      aws_secretsmanager_secret_version.redis_auth.secret_string_wo_version == 1 &&
      aws_secretsmanager_secret_version.redis_auth.secret_string == null &&
      aws_secretsmanager_secret.redis_auth.recovery_window_in_days == 0
    )
    error_message = "Valkey AUTH token must use write-only version 1 and secret recovery_window_in_days = 0"
  }
}

# TC-152-06 & TC-152-07: RDS Multi-AZ, db.t4g.small, force_ssl, và termination_protection
run "tc_152_06_07_rds_defaults_and_protection" {
  command = plan

  assert {
    condition = (
      aws_db_instance.main.multi_az == true &&
      aws_db_instance.main.instance_class == "db.t4g.small" &&
      aws_db_instance.main.storage_encrypted == true &&
      aws_db_instance.main.publicly_accessible == false &&
      aws_db_instance.main.backup_retention_period >= 7 &&
      aws_db_instance.main.deletion_protection == true &&
      aws_db_instance.main.skip_final_snapshot == false &&
      aws_db_instance.main.final_snapshot_identifier == "dbs-prod-final" &&
      aws_db_instance.main.delete_automated_backups == false &&
      aws_lb.main.enable_deletion_protection == true
    )
    error_message = "RDS and ALB must enforce production HA, encryption, 7-day backup, and deletion protection by default"
  }

  assert {
    condition = anytrue([
      for p in aws_db_parameter_group.postgres17.parameter :
      p.name == "rds.force_ssl" && p.value == "1"
    ])
    error_message = "DB parameter group must set rds.force_ssl = 1"
  }
}

run "tc_152_07_termination_protection_false" {
  command = plan

  variables {
    termination_protection = false
  }

  assert {
    condition = (
      aws_db_instance.main.deletion_protection == false &&
      aws_db_instance.main.skip_final_snapshot == true &&
      aws_db_instance.main.final_snapshot_identifier == null &&
      aws_db_instance.main.delete_automated_backups == true &&
      aws_lb.main.enable_deletion_protection == false
    )
    error_message = "termination_protection = false must disable deletion protection and final snapshot"
  }
}

# TC-152-08: giới hạn số task và cấu hình rolling deploy
run "tc_152_08_rejects_desired_count_1" {
  command = plan
  variables {
    desired_count = 1
  }
  expect_failures = [var.desired_count]
}

run "tc_152_08_rejects_desired_count_5" {
  command = plan
  variables {
    desired_count = 5
  }
  expect_failures = [var.desired_count]
}

run "tc_152_08_rejects_worker_desired_count_3" {
  command = plan
  variables {
    worker_desired_count = 3
  }
  expect_failures = [var.worker_desired_count]
}

run "tc_152_08_rejects_total_tasks_7" {
  command = plan
  variables {
    desired_count        = 4
    worker_desired_count = 3
  }
  expect_failures = [var.worker_desired_count]
}

run "tc_152_08_ecs_2_tasks_rolling_100_200" {
  command = plan

  variables {
    desired_count        = 2
    worker_desired_count = 2
  }

  assert {
    condition = (
      aws_ecs_service.api.deployment_minimum_healthy_percent == 100 &&
      aws_ecs_service.api.deployment_maximum_percent == 200 &&
      aws_ecs_service.api.deployment_circuit_breaker[0].enable == true &&
      aws_ecs_service.api.deployment_circuit_breaker[0].rollback == true &&
      toset(aws_ecs_service.api.network_configuration[0].subnets) == toset(["subnet-pub-a", "subnet-pub-b"]) &&
      toset(aws_ecs_service.api.network_configuration[0].security_groups) == toset(["sg-api"]) &&
      toset(aws_ecs_service.worker.network_configuration[0].subnets) == toset(["subnet-pub-a", "subnet-pub-b"])
    )
    error_message = "desired_count = 2 must roll 100%/200% with circuit breaker across both public subnets"
  }
}

run "tc_152_08_ecs_3_tasks_rolling_50_100" {
  command = plan

  variables {
    desired_count        = 3
    worker_desired_count = 1
  }

  assert {
    condition = (
      aws_ecs_service.api.deployment_minimum_healthy_percent == 50 &&
      aws_ecs_service.api.deployment_maximum_percent == 100
    )
    error_message = "desired_count = 3..4 must roll 50%/100% to respect DB connection budget"
  }
}

# TC-152-09 & TC-152-10: cách ly SQS dev/prod và least privilege IAM
run "tc_152_09_10_sqs_isolation_and_iam" {
  command = apply

  assert {
    condition = (
      aws_sqs_queue.main["risk"].name == "dbs-prod-risk-events" &&
      aws_sqs_queue.main["notification"].name == "dbs-prod-notification-events" &&
      aws_sqs_queue.dlq["risk"].name == "dbs-prod-risk-events-dlq" &&
      aws_sqs_queue.dlq["notification"].name == "dbs-prod-notification-events-dlq"
    )
    error_message = "SQS queues and DLQs must be named dbs-prod-*"
  }

  assert {
    condition = (
      strcontains(aws_sqs_queue_policy.deny_api["risk"].policy, "role/dbs-prod-api-task") &&
      strcontains(aws_sqs_queue_policy.deny_api["risk"].policy, "role/dbs-prod-worker-task") &&
      !strcontains(aws_sqs_queue_policy.deny_api["risk"].policy, "dbs-dev") &&
      strcontains(aws_iam_policy.worker_sqs.policy, "dbs-prod-risk-events") &&
      !strcontains(aws_iam_policy.worker_sqs.policy, "dbs-dev")
    )
    error_message = "SQS policies must reference prod roles/queues only, never dbs-dev"
  }

  assert {
    condition = (
      aws_ecs_task_definition.migrate.task_role_arn == null &&
      strcontains(aws_iam_role_policy.read_redis_auth_secret.policy, aws_secretsmanager_secret.redis_auth.arn) &&
      !strcontains(aws_iam_role_policy.read_redis_auth_secret.policy, "dbs/dev")
    )
    error_message = "migrate must have no task role and execution roles must read prod redis secret"
  }
}

# TC-152-11 & TC-152-13: quy ước tên, tag mặc định và output
run "tc_152_11_13_naming_tags_and_outputs" {
  command = apply

  assert {
    condition = (
      length(aws_lb_target_group.api.name) <= 32 &&
      alltrue([
        for name in [
          aws_ecs_cluster.main.name,
          aws_lb.main.name,
          aws_lb_target_group.api.name,
          aws_db_parameter_group.postgres17.name,
          aws_db_instance.main.identifier,
          aws_elasticache_replication_group.main.replication_group_id,
          aws_ecs_task_definition.api.family,
          aws_ecs_task_definition.worker.family,
          aws_ecs_task_definition.migrate.family,
          aws_iam_role.execution.name,
          aws_iam_role.task.name,
          aws_iam_role.worker_execution.name,
          aws_iam_role.worker_task.name,
          aws_iam_role.migrate_execution.name,
          aws_iam_policy.worker_sqs.name,
          aws_sqs_queue.main["risk"].name,
          aws_sqs_queue.main["notification"].name,
          aws_sqs_queue.dlq["risk"].name,
          aws_sqs_queue.dlq["notification"].name,
        ] : startswith(name, "dbs-prod") && !strcontains(name, "dev")
      ]) &&
      startswith(aws_cloudwatch_log_group.api.name, "/dbs/prod") &&
      startswith(aws_cloudwatch_log_group.worker.name, "/dbs/prod") &&
      startswith(aws_secretsmanager_secret.redis_auth.name, "dbs/prod")
    )
    error_message = "Every named resource must start with dbs-prod, /dbs/prod, or dbs/prod and not contain dev"
  }

  assert {
    condition = (
      output.alb_dns_name != "" &&
      output.cluster_name == "dbs-prod" &&
      output.service_name == "api" &&
      output.db_address != "" &&
      output.redis_primary_endpoint != "" &&
      output.certificate_arn == var.certificate_arn &&
      length(output.container_environment.api) > 0 &&
      length(output.container_environment.worker) > 0 &&
      length(output.container_environment.migrate) > 0
    )
    error_message = "Required outputs must be populated"
  }
}
