# Giao diện web (web.tf). Mock, biến và override chép từ waf.tftest.hcl vì chỉ có hiệu lực trong file khai báo chúng.
mock_provider "aws" {}
mock_provider "tls" {}

variables {
  state_bucket = "dbs-tfstate-123456789012-ap-southeast-1"
  account_id   = "123456789012"
  image_tag    = "0000000000000000000000000000000000000000"
  # Ngày thật làm check "waf_off_date" báo lỗi; run nào kiểm cảnh báo thì tự đặt ngày đã qua.
  waf_off_date = "2099-01-01"
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
      openai_api_key_secret_arn  = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:dbs/dev/openai-api-key-AbCdEf"
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

override_resource {
  target = aws_cloudfront_distribution.web[0]
  values = {
    arn         = "arn:aws:cloudfront::123456789012:distribution/E0000000000000"
    id          = "E0000000000000"
    domain_name = "d111111abcdef8.cloudfront.net"
  }
}

override_resource {
  target = aws_s3_bucket.web[0]
  values = {
    arn                         = "arn:aws:s3:::dbs-dev-web-123456789012"
    bucket_regional_domain_name = "dbs-dev-web-123456789012.s3.ap-southeast-1.amazonaws.com"
  }
}

override_resource {
  target = aws_cloudfront_function.spa[0]
  values = {
    arn = "arn:aws:cloudfront::123456789012:function/dbs-dev-web-spa"
  }
}

override_resource {
  target = aws_cloudfront_response_headers_policy.web[0]
  values = {
    id = "00000000-0000-0000-0000-000000000001"
  }
}

override_resource {
  target = aws_lb_listener.http
  values = {
    arn = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:listener/app/dbs-dev/0123456789abcdef/1111111111111111"
  }
}

run "web_off_by_default" {
  command = apply

  assert {
    condition     = length(aws_s3_bucket.web) == 0 && length(aws_cloudfront_distribution.web) == 0 && length(aws_lb_listener_rule.web_origin) == 0
    error_message = "No web resource may exist while web_enabled is false."
  }

  assert {
    condition     = output.web_url == null && output.web_bucket == null && output.web_distribution_id == null
    error_message = "Web outputs must be null while web_enabled is false."
  }

  assert {
    condition     = one([for e in local.api_environment : e.value if e.name == "TRUST_PROXY_HOPS"]) == "1"
    error_message = "Behind the ALB only, the api trusts one proxy."
  }
}

run "web_on" {
  command = apply

  variables {
    web_enabled = true
    waf_enabled = false
  }

  assert {
    condition     = aws_s3_bucket.web[0].force_destroy && aws_s3_bucket_public_access_block.web[0].block_public_policy && aws_s3_bucket_public_access_block.web[0].restrict_public_buckets
    error_message = "The web bucket is private and can be destroyed with its files."
  }

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.web[0].policy).Statement[0].Condition.StringEquals["AWS:SourceArn"] == "arn:aws:cloudfront::123456789012:distribution/E0000000000000"
    error_message = "Only this distribution may read the bucket."
  }

  assert {
    condition     = toset([for b in aws_cloudfront_distribution.web[0].ordered_cache_behavior : b.path_pattern]) == toset(["/v1/*", "/health/*"])
    error_message = "/v1/* and /health/* go to the ALB."
  }

  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.web[0].ordered_cache_behavior :
      b.target_origin_id == "alb" && b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" && b.origin_request_policy_id == "b689b0a8-53d0-40ab-baf2-68738e2966ac" && contains(b.allowed_methods, "POST") && length(b.function_association) == 0
    ])
    error_message = "API behaviors: no cache, every viewer header and the query forwarded, all methods, no SPA rewrite."
  }

  assert {
    condition     = aws_cloudfront_distribution.web[0].default_cache_behavior[0].target_origin_id == "s3" && length(aws_cloudfront_distribution.web[0].default_cache_behavior[0].function_association) == 1
    error_message = "The default behavior serves S3 and rewrites app routes to index.html."
  }

  assert {
    condition     = nonsensitive(one(one([for c in aws_lb_listener_rule.web_origin[0].condition : one(c.http_header).values])) == one([for o in aws_cloudfront_distribution.web[0].origin : one(o.custom_header).value if o.origin_id == "alb"]))
    error_message = "The ALB forwards on port 80 only with the header CloudFront sends."
  }

  assert {
    condition     = aws_lb_listener_rule.web_origin[0].action[0].type == "forward" && aws_lb_listener.http.default_action[0].type == "redirect"
    error_message = "Port 80 without the header still redirects to HTTPS."
  }

  assert {
    condition     = strcontains(aws_cloudfront_response_headers_policy.web[0].security_headers_config[0].content_security_policy[0].content_security_policy, "connect-src 'self' https://cognito-idp.ap-southeast-1.amazonaws.com")
    error_message = "The CSP allows the page to call only itself and Cognito."
  }

  assert {
    condition     = one([for e in local.api_environment : e.value if e.name == "TRUST_PROXY_HOPS"]) == "2"
    error_message = "Behind CloudFront and the ALB, the api trusts two proxies."
  }

  assert {
    condition     = output.web_url == "https://d111111abcdef8.cloudfront.net" && output.web_bucket == "dbs-dev-web-123456789012"
    error_message = "The outputs name the site and its bucket."
  }
}

run "web_with_waf_warns" {
  command = plan

  variables {
    web_enabled = true
    waf_enabled = true
  }

  expect_failures = [check.web_without_waf]
}
