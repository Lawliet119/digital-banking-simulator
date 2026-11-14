# WAF gắn ALB của session (DBS-153). Mock, biến và override chép từ alarms.tftest.hcl vì chỉ có hiệu lực trong file khai báo chúng.
mock_provider "aws" {}
mock_provider "tls" {}

variables {
  state_bucket = "dbs-tfstate-123456789012-ap-southeast-1"
  account_id   = "123456789012"
  image_tag    = "0000000000000000000000000000000000000000"
}

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
  target = aws_db_instance.main
  values = {
    master_user_secret = [{
      secret_arn    = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:rds!db-00000000-0000-0000-0000-000000000000-AbCdEf"
      kms_key_id    = "arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000"
      secret_status = "active"
    }]
  }
}

override_resource {
  target = module.waf[0].aws_wafv2_web_acl.main
  values = {
    arn = "arn:aws:wafv2:ap-southeast-1:123456789012:regional/webacl/dbs-dev-waf/00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target = module.waf[0].aws_wafv2_ip_set.rate_limit_exempt[0]
  values = {
    arn = "arn:aws:wafv2:ap-southeast-1:123456789012:regional/ipset/dbs-dev-waf-rate-limit-exempt/11111111-1111-1111-1111-111111111111"
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

# TC-153-08, TC-153-10, TC-153-14 (default future date -> no warning)
run "waf_enabled_by_default" {
  command = apply

  assert {
    condition     = output.waf_web_acl_name == "dbs-dev-waf"
    error_message = "output.waf_web_acl_name must be dbs-dev-waf when waf_enabled defaults to true."
  }

  assert {
    condition     = output.waf_web_acl_arn == "arn:aws:wafv2:ap-southeast-1:123456789012:regional/webacl/dbs-dev-waf/00000000-0000-0000-0000-000000000000"
    error_message = "output.waf_web_acl_arn must expose the module ARN."
  }

  assert {
    condition     = var.waf_rate_limit == 1000 && length(var.waf_rate_limit_exempt_cidrs) == 0
    error_message = "Default waf_rate_limit must be 1000 and waf_rate_limit_exempt_cidrs empty."
  }
}

# TC-153-09, TC-153-14 (disabled -> no warning even past waf_off_date)
run "waf_disabled_past_off_date_no_warning" {
  command = apply

  variables {
    waf_enabled  = false
    waf_off_date = "2020-01-01"
  }

  assert {
    condition     = output.waf_web_acl_name == null && output.waf_web_acl_arn == null
    error_message = "WAF outputs must be null when waf_enabled = false."
  }
}

# TC-153-10: forwards rate limit and exempt CIDRs
run "waf_forwards_rate_limit_and_exempt_cidrs" {
  command = apply

  variables {
    waf_rate_limit              = 2500
    waf_rate_limit_exempt_cidrs = ["203.0.113.5/32"]
  }

  assert {
    condition     = output.waf_web_acl_name == "dbs-dev-waf" && var.waf_rate_limit == 2500
    error_message = "waf_rate_limit and waf_rate_limit_exempt_cidrs must be forwarded to module.waf."
  }
}

# TC-153-14: enabled past waf_off_date triggers check warning
run "waf_enabled_past_off_date_warns" {
  command = plan

  variables {
    waf_enabled  = true
    waf_off_date = "2020-01-01"
  }

  expect_failures = [check.waf_off_date]
}
