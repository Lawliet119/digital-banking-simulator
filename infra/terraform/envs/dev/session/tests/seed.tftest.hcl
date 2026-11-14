mock_provider "aws" {}
mock_provider "tls" {}

variables {
  state_bucket = "dbs-tfstate-123456789012-ap-southeast-1"
  account_id   = "123456789012"
  image_tag    = "0000000000000000000000000000000000000000"
}

# mock_provider sinh ARN không hợp lệ; cấp ARN giả hợp lệ cho các tham chiếu chéo (như session.tftest.hcl).
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

override_resource {
  target = aws_iam_role.db_roles_execution
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-dev-db-roles-execution"
  }
}

override_resource {
  target = aws_iam_role.seed_execution
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-dev-seed-execution"
  }
}

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
      alarm_topic_arn            = "arn:aws:sns:ap-southeast-1:123456789012:dbs-dev-alarms"
      sqs_dlq_names = {
        risk         = "dbs-dev-risk-events-dlq"
        notification = "dbs-dev-notification-events-dlq"
      }
    }
  }
}

# BL-252: task definition dbs-seed (khuôn cho infra/scripts/seed-cloud.sh)
run "seed_task_definition" {
  command = apply

  assert {
    condition = (
      aws_ecs_task_definition.seed.family == "dbs-seed"
      && length(jsondecode(aws_ecs_task_definition.seed.container_definitions)) == 1
      && jsondecode(aws_ecs_task_definition.seed.container_definitions)[0].name == "seed"
      && jsondecode(aws_ecs_task_definition.seed.container_definitions)[0].essential == true
      && jsondecode(aws_ecs_task_definition.seed.container_definitions)[0].image == jsondecode(aws_ecs_task_definition.api.container_definitions)[0].image
      && aws_ecs_task_definition.seed.network_mode == "awsvpc"
      && contains(aws_ecs_task_definition.seed.requires_compatibilities, "FARGATE")
    )
    error_message = "family dbs-seed, one essential container named seed, same image as api, Fargate awsvpc"
  }

  # Lệnh mặc định không làm gì; seed-cloud.sh ghi đè bằng --url của task api. Chạy từ dist, không qua npm hay ts-node.
  assert {
    condition     = jsondecode(aws_ecs_task_definition.seed.container_definitions)[0].command == ["node", "dist/scripts/seed-cloud.js", "--help"]
    error_message = "the default command is the compiled seed-cloud entry with --help (harmless)"
  }

  # Không secret, không task role, không cổng: token demo chỉ vào qua containerOverrides lúc run-task.
  assert {
    condition = (
      !can(jsondecode(aws_ecs_task_definition.seed.container_definitions)[0].secrets)
      && !can(jsondecode(aws_ecs_task_definition.seed.container_definitions)[0].portMappings)
      && aws_ecs_task_definition.seed.task_role_arn == null
      && alltrue([for e in jsondecode(aws_ecs_task_definition.seed.container_definitions)[0].environment : !strcontains(e.name, "TOKEN")])
    )
    error_message = "dbs-seed has no secrets, no task role, no port mapping and no token in its definition"
  }

  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.seed.container_definitions)[0].logConfiguration.options["awslogs-stream-prefix"] == "seed"
      && jsondecode(aws_ecs_task_definition.seed.container_definitions)[0].logConfiguration.options["awslogs-group"] == jsondecode(aws_ecs_task_definition.api.container_definitions)[0].logConfiguration.options["awslogs-group"]
    )
    error_message = "logs go to the api log group under the seed prefix (seed/seed/<task-id>)"
  }

  assert {
    condition     = aws_ecs_task_definition.seed.execution_role_arn == aws_iam_role.seed_execution.arn
    error_message = "dbs-seed uses its own execution role"
  }
}

# BL-252: execution role của seed chỉ kéo image và ghi log seed/*, không đọc secret nào
run "seed_execution_role" {
  command = apply

  assert {
    condition = (
      aws_iam_role.seed_execution.name == "dbs-dev-seed-execution"
      && length(jsondecode(aws_iam_role.seed_execution.assume_role_policy).Statement) == 1
      && jsondecode(aws_iam_role.seed_execution.assume_role_policy).Statement[0].Principal.Service == "ecs-tasks.amazonaws.com"
      && jsondecode(aws_iam_role.seed_execution.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "123456789012"
    )
    error_message = "seed execution role trusts only ecs-tasks of this account"
  }

  assert {
    condition = (
      aws_iam_role_policy.seed_execution.role == aws_iam_role.seed_execution.id
      && !strcontains(aws_iam_role_policy.seed_execution.policy, "secretsmanager")
      && !strcontains(aws_iam_role_policy.seed_execution.policy, "kms:")
    )
    error_message = "the seed execution role reads no secret and uses no KMS"
  }

  assert {
    condition = (
      toset([for st in jsondecode(aws_iam_role_policy.seed_execution.policy).Statement : st.Resource if st.Action == ["logs:PutLogEvents"]]) == toset(["arn:aws:logs:ap-southeast-1:123456789012:log-group:/dbs/dev/api:log-stream:seed/*"])
    )
    error_message = "PutLogEvents only on the seed/* streams of the api log group"
  }

  assert {
    condition     = length([for st in jsondecode(aws_iam_role_policy.seed_execution.policy).Statement : st if st.Resource == "*" && st.Action != "ecr:GetAuthorizationToken"]) == 0
    error_message = "the only action on * is ecr:GetAuthorizationToken"
  }
}
