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
      vpc_id                = "vpc-0abc"
      public_subnet_ids     = ["subnet-pub-a", "subnet-pub-b"]
      private_subnet_ids    = ["subnet-prv-a", "subnet-prv-b"]
      ecr_repository_url    = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/dbs-api"
      ecr_repository_arn    = "arn:aws:ecr:ap-southeast-1:123456789012:repository/dbs-api"
      alb_security_group_id = "sg-alb"
      api_security_group_id = "sg-api"
      api_log_group_name    = "/dbs/dev/api"
      api_log_group_arn     = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/dbs/dev/api"
      cognito_user_pool_id  = "ap-southeast-1_ABCDEFGHI"
      cognito_client_id     = "abcdefghij1234567890"
      cognito_issuer        = "https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ABCDEFGHI"
      kms_key_arn           = "arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000"
      db_subnet_group_name  = "dbs-dev"
      db_security_group_id  = "sg-db"
    }
  }
}

# TC-33-10 (giữ lại): session đọc remote state của base và xuất lại giá trị mạng
run "reexports_base_network" {
  command = plan

  assert {
    condition     = output.vpc_id == "vpc-0abc"
    error_message = "vpc_id must come from base"
  }

  assert {
    condition     = output.public_subnet_ids == ["subnet-pub-a", "subnet-pub-b"] && output.private_subnet_ids == ["subnet-prv-a", "subnet-prv-b"]
    error_message = "subnet ids must come from base"
  }
}

# TC-34-03: cluster và service api
run "service" {
  command = apply

  assert {
    condition     = aws_ecs_cluster.main.name == "dbs-dev"
    error_message = "cluster name"
  }

  assert {
    condition     = one([for s in aws_ecs_cluster.main.setting : s.value if s.name == "containerInsights"]) == "disabled"
    error_message = "container insights must be explicitly disabled (cost)"
  }

  assert {
    condition     = aws_ecs_service.api.launch_type == "FARGATE" && aws_ecs_service.api.desired_count == 0
    error_message = "service must be Fargate and default to desired_count 0"
  }

  assert {
    condition     = aws_ecs_service.api.health_check_grace_period_seconds == 60
    error_message = "grace period must be 60 s (docs/03 section 13.3)"
  }

  assert {
    condition     = aws_ecs_service.api.deployment_circuit_breaker[0].enable && aws_ecs_service.api.deployment_circuit_breaker[0].rollback
    error_message = "circuit breaker with rollback must be on"
  }

  assert {
    condition     = one(aws_ecs_service.api.network_configuration).assign_public_ip == true && length(one(aws_ecs_service.api.network_configuration).subnets) == 2
    error_message = "tasks run in the two public subnets with a public IP (ADR-10)"
  }

  assert {
    condition     = one(aws_ecs_service.api.network_configuration).security_groups == toset(["sg-api"])
    error_message = "tasks must use the api security group"
  }

  assert {
    condition     = one(aws_ecs_service.api.load_balancer).container_name == "api" && one(aws_ecs_service.api.load_balancer).container_port == 3000
    error_message = "service must register container api:3000 with the target group"
  }
}

run "service_desired_count_variable" {
  command = plan

  variables {
    desired_count = 1
  }

  assert {
    condition     = aws_ecs_service.api.desired_count == 1
    error_message = "desired_count must follow the variable"
  }
}

# TC-34-04: target group
run "target_group" {
  command = plan

  assert {
    condition     = aws_lb_target_group.api.target_type == "ip" && aws_lb_target_group.api.port == 3000 && aws_lb_target_group.api.protocol == "HTTP"
    error_message = "target group must be ip, HTTP 3000"
  }

  assert {
    condition     = aws_lb_target_group.api.deregistration_delay == "30"
    error_message = "deregistration delay must be 30 s"
  }

  assert {
    condition     = aws_lb_target_group.api.health_check[0].path == "/health/ready" && aws_lb_target_group.api.health_check[0].interval == 15 && aws_lb_target_group.api.health_check[0].timeout == 5 && aws_lb_target_group.api.health_check[0].healthy_threshold == 2 && aws_lb_target_group.api.health_check[0].unhealthy_threshold == 3 && aws_lb_target_group.api.health_check[0].matcher == "200"
    error_message = "health check must be /health/ready 15/5/2/3 and 200 (docs/03 section 13.3)"
  }
}

# TC-34-05: ALB và listener
run "alb" {
  command = apply

  assert {
    condition     = aws_lb.main.internal == false && aws_lb.main.load_balancer_type == "application" && aws_lb.main.enable_deletion_protection == false && aws_lb.main.drop_invalid_header_fields == true
    error_message = "ALB must be internet-facing, application, no deletion protection, dropping invalid headers"
  }

  assert {
    condition     = length(aws_lb.main.subnets) == 2 && aws_lb.main.security_groups == toset(["sg-alb"])
    error_message = "ALB must use two public subnets and the alb security group"
  }

  assert {
    condition     = aws_lb_listener.https.port == 443 && aws_lb_listener.https.protocol == "HTTPS" && aws_lb_listener.https.ssl_policy == "ELBSecurityPolicy-TLS13-1-2-2021-06" && aws_lb_listener.https.certificate_arn == aws_acm_certificate.dev.arn
    error_message = "HTTPS listener must use the TLS 1.3 policy and the imported certificate"
  }

  assert {
    condition     = aws_lb_listener.https.default_action[0].type == "forward" && aws_lb_listener.https.default_action[0].target_group_arn == aws_lb_target_group.api.arn
    error_message = "HTTPS listener must forward to the api target group"
  }

  assert {
    condition     = aws_lb_listener.http.port == 80 && aws_lb_listener.http.default_action[0].type == "redirect" && aws_lb_listener.http.default_action[0].redirect[0].port == "443" && aws_lb_listener.http.default_action[0].redirect[0].protocol == "HTTPS" && aws_lb_listener.http.default_action[0].redirect[0].status_code == "HTTP_301"
    error_message = "HTTP listener must redirect to HTTPS with 301"
  }

  assert {
    condition     = tls_private_key.dev.algorithm == "RSA" && tls_private_key.dev.rsa_bits == 2048 && tls_self_signed_cert.dev.validity_period_hours == 720
    error_message = "certificate must be RSA 2048 valid for 720 hours"
  }
}

# TC-34-06, TC-34-07: task definition
run "task_definition" {
  command = apply

  assert {
    condition     = aws_ecs_task_definition.api.family == "dbs-api" && aws_ecs_task_definition.api.cpu == "512" && aws_ecs_task_definition.api.memory == "1024" && aws_ecs_task_definition.api.network_mode == "awsvpc" && aws_ecs_task_definition.api.requires_compatibilities == toset(["FARGATE"])
    error_message = "task must be Fargate awsvpc 0.5 vCPU / 1 GB (docs/03 section 13.1)"
  }

  assert {
    condition     = one(aws_ecs_task_definition.api.runtime_platform).cpu_architecture == "X86_64" && one(aws_ecs_task_definition.api.runtime_platform).operating_system_family == "LINUX"
    error_message = "runtime platform must be LINUX/X86_64 (the CI runner builds x86)"
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.api.container_definitions)[0].name == "api" && jsondecode(aws_ecs_task_definition.api.container_definitions)[0].image == "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/dbs-api:0000000000000000000000000000000000000000"
    error_message = "container must be api running the SHA-tagged image"
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.api.container_definitions)[0].portMappings[0].containerPort == 3000
    error_message = "container must expose 3000"
  }

  assert {
    condition = (
      { for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.name => e.value }["APP_ROLE"] == "api"
      && { for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.name => e.value }["TRUST_PROXY_HOPS"] == "1"
      && { for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.name => e.value }["PORT"] == "3000"
      && { for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.name => e.value }["NODE_ENV"] == "staging"
    )
    error_message = "env must carry APP_ROLE=api, TRUST_PROXY_HOPS=1, PORT=3000, NODE_ENV=staging"
  }

  # TC-54-07: ba biến Cognito lấy nguyên từ base, không bí mật
  assert {
    condition = (
      { for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.name => e.value }["COGNITO_USER_POOL_ID"] == "ap-southeast-1_ABCDEFGHI"
      && { for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.name => e.value }["COGNITO_CLIENT_ID"] == "abcdefghij1234567890"
      && { for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.name => e.value }["COGNITO_ISSUER"] == "https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ABCDEFGHI"
    )
    error_message = "env must carry COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID and COGNITO_ISSUER from base"
  }

  # TC-34-07: không có biến bí mật viết thẳng
  assert {
    condition = length([
      for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.name
      if contains(["DATABASE_URL", "REDIS_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"], e.name) || can(regex("PASSWORD|_SECRET", e.name))
    ]) == 0
    error_message = "no secret may be written into environment"
  }

  # TC-34-08: log về CloudWatch (log group ở base)
  assert {
    condition     = jsondecode(aws_ecs_task_definition.api.container_definitions)[0].logConfiguration.logDriver == "awslogs" && jsondecode(aws_ecs_task_definition.api.container_definitions)[0].logConfiguration.options["awslogs-group"] == "/dbs/dev/api" && jsondecode(aws_ecs_task_definition.api.container_definitions)[0].logConfiguration.options["awslogs-region"] == "ap-southeast-1"
    error_message = "logs must go to /dbs/dev/api via awslogs"
  }
}

# TC-34-09: execution role tách khỏi task role, quyền tối thiểu
run "iam" {
  command = apply

  assert {
    condition     = aws_ecs_task_definition.api.execution_role_arn == aws_iam_role.execution.arn && aws_ecs_task_definition.api.task_role_arn == aws_iam_role.task.arn && aws_iam_role.execution.arn != aws_iam_role.task.arn
    error_message = "execution role and task role must be separate roles"
  }

  assert {
    condition = (
      jsondecode(aws_iam_role.execution.assume_role_policy).Statement[0].Principal.Service == "ecs-tasks.amazonaws.com"
      && jsondecode(aws_iam_role.task.assume_role_policy).Statement[0].Principal.Service == "ecs-tasks.amazonaws.com"
      && jsondecode(aws_iam_role.execution.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "123456789012"
      && jsondecode(aws_iam_role.task.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "123456789012"
    )
    error_message = "both roles must trust only ecs-tasks.amazonaws.com from this account"
  }

  assert {
    condition = (
      contains([for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Resource if s.Resource == "*"], "*")
      && length([for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s if s.Resource == "*"]) == 1
      && [for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Action if s.Resource == "*"][0] == "ecr:GetAuthorizationToken"
    )
    error_message = "the only action on * must be ecr:GetAuthorizationToken"
  }

  assert {
    condition = (
      toset([for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Resource if s.Resource != "*"]) == toset([
        "arn:aws:ecr:ap-southeast-1:123456789012:repository/dbs-api",
        "arn:aws:logs:ap-southeast-1:123456789012:log-group:/dbs/dev/api:*",
      ])
    )
    error_message = "ECR actions on the repo ARN and Logs actions on the log group ARN with :* only"
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Action])) == toset([
      "ecr:GetAuthorizationToken",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchCheckLayerAvailability",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ])
    error_message = "unexpected action set on the execution role"
  }
}

# TC-34-10: tag image phải là SHA 40 hex
run "rejects_latest_tag" {
  command = plan

  variables {
    image_tag = "latest"
  }

  expect_failures = [var.image_tag]
}

run "rejects_short_tag" {
  command = plan

  variables {
    image_tag = "abc123"
  }

  expect_failures = [var.image_tag]
}

# TC-66-01, TC-66-04: instance dev
run "rds_instance" {
  command = apply

  assert {
    condition     = aws_db_instance.main.identifier == "dbs-dev" && aws_db_instance.main.engine == "postgres" && startswith(aws_db_instance.main.engine_version, "17")
    error_message = "instance must be dbs-dev on PostgreSQL 17"
  }

  assert {
    condition     = aws_db_instance.main.instance_class == "db.t4g.micro" && aws_db_instance.main.multi_az == false && aws_db_instance.main.allocated_storage == 20 && aws_db_instance.main.storage_type == "gp3"
    error_message = "dev: db.t4g.micro, Single-AZ, 20 GB gp3 (ADR-11)"
  }

  assert {
    condition     = aws_db_instance.main.db_name == "dbs" && aws_db_instance.main.username == "dbs_master" && aws_db_instance.main.port == 5432
    error_message = "database dbs, master user dbs_master, port 5432"
  }

  assert {
    condition     = aws_db_instance.main.ca_cert_identifier == "rds-ca-rsa2048-g1" && aws_db_instance.main.auto_minor_version_upgrade == true
    error_message = "pin the CA and allow minor upgrades"
  }

  assert {
    condition     = aws_db_instance.main.performance_insights_enabled == false && aws_db_instance.main.monitoring_interval == 0 && length(coalesce(aws_db_instance.main.enabled_cloudwatch_logs_exports, [])) == 0
    error_message = "no performance insights, no enhanced monitoring, no log exports (cost)"
  }

  assert {
    condition     = aws_db_instance.main.backup_retention_period == 1 && aws_db_instance.main.skip_final_snapshot == true && aws_db_instance.main.delete_automated_backups == true && aws_db_instance.main.deletion_protection == false && aws_db_instance.main.apply_immediately == true
    error_message = "daily destroy must leave nothing: no final snapshot, automated backups deleted, no deletion protection"
  }
}

# TC-66-02, TC-66-05, TC-66-08: mã hóa, mật khẩu do RDS quản lý, mạng
run "rds_security" {
  command = apply

  assert {
    condition     = aws_db_instance.main.storage_encrypted == true && aws_db_instance.main.kms_key_id == "arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000" && aws_db_instance.main.publicly_accessible == false
    error_message = "storage must be encrypted with the shared CMK and the instance must not be public"
  }

  assert {
    condition     = aws_db_instance.main.manage_master_user_password == true && aws_db_instance.main.master_user_secret_kms_key_id == "arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000" && aws_db_instance.main.password == null
    error_message = "master password must be managed by RDS (never in state or variables)"
  }

  assert {
    condition     = aws_db_instance.main.db_subnet_group_name == "dbs-dev" && aws_db_instance.main.vpc_security_group_ids == toset(["sg-db"])
    error_message = "instance must use the base subnet group and the db security group"
  }

  assert {
    condition     = output.db_master_secret_arn == "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:rds!db-00000000-0000-0000-0000-000000000000-AbCdEf"
    error_message = "master secret arn must be exported"
  }
}

# TC-66-03: parameter group ép TLS và UTC
run "rds_parameter_group" {
  command = apply

  assert {
    condition     = aws_db_parameter_group.postgres17.name == "dbs-dev-postgres17" && aws_db_parameter_group.postgres17.family == "postgres17" && aws_db_instance.main.parameter_group_name == "dbs-dev-postgres17"
    error_message = "instance must use the dbs-dev-postgres17 parameter group"
  }

  assert {
    condition     = anytrue([for p in aws_db_parameter_group.postgres17.parameter : p.name == "rds.force_ssl" && p.value == "1"])
    error_message = "rds.force_ssl must be 1"
  }

  assert {
    condition     = anytrue([for p in aws_db_parameter_group.postgres17.parameter : p.name == "timezone" && p.value == "UTC"])
    error_message = "timezone must be UTC"
  }
}

# TC-66-10: production đổi qua biến
run "rds_variables" {
  command = apply

  variables {
    db_multi_az       = true
    db_instance_class = "db.t4g.small"
  }

  assert {
    condition     = aws_db_instance.main.multi_az == true && aws_db_instance.main.instance_class == "db.t4g.small"
    error_message = "multi_az and instance class must follow the variables"
  }
}
