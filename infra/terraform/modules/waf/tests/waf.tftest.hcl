mock_provider "aws" {}

variables {
  name         = "dbs-dev-waf"
  resource_arn = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/dbs-dev/0123456789abcdef"
}

override_resource {
  target = aws_wafv2_web_acl.main
  values = {
    arn = "arn:aws:wafv2:ap-southeast-1:123456789012:regional/webacl/dbs-dev-waf/00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target = aws_wafv2_ip_set.rate_limit_exempt[0]
  values = {
    arn = "arn:aws:wafv2:ap-southeast-1:123456789012:regional/ipset/dbs-dev-waf-rate-limit-exempt/11111111-1111-1111-1111-111111111111"
  }
}

# TC-153-01, TC-153-02, TC-153-03, TC-153-04, TC-153-11
run "default_acl_and_rules" {
  command = apply

  assert {
    condition     = aws_wafv2_web_acl.main.scope == "REGIONAL"
    error_message = "Web ACL scope must be REGIONAL."
  }

  assert {
    condition     = length(aws_wafv2_web_acl.main.default_action) == 1 && length(aws_wafv2_web_acl.main.default_action[0].allow) == 1
    error_message = "Web ACL default action must be allow."
  }

  assert {
    condition     = length(aws_wafv2_web_acl.main.rule) == 3
    error_message = "Web ACL must have exactly 3 rules."
  }

  assert {
    condition     = length(distinct([for r in aws_wafv2_web_acl.main.rule : r.priority])) == 3
    error_message = "All 3 rules must have distinct priorities."
  }

  # Rate rule (TC-153-02)
  assert {
    condition = anytrue([
      for r in aws_wafv2_web_acl.main.rule :
      r.name == "rate-limit" &&
      r.priority == min([for all_r in aws_wafv2_web_acl.main.rule : all_r.priority]...) &&
      length(r.statement[0].rate_based_statement) == 1 &&
      r.statement[0].rate_based_statement[0].limit == 1000 &&
      r.statement[0].rate_based_statement[0].evaluation_window_sec == 300 &&
      r.statement[0].rate_based_statement[0].aggregate_key_type == "IP" &&
      length(r.action[0].block) == 1 &&
      length(r.action[0].block[0].custom_response) == 1 &&
      r.action[0].block[0].custom_response[0].response_code == 429 &&
      length(r.statement[0].rate_based_statement[0].scope_down_statement) == 0
    ])
    error_message = "Rate rule must run first, limit 1000 per 300s by IP, block with HTTP 429, and have no scope_down_statement when exempt list is empty."
  }

  # Managed rules (TC-153-01)
  assert {
    condition = anytrue([
      for r in aws_wafv2_web_acl.main.rule :
      length(r.statement[0].managed_rule_group_statement) == 1 &&
      r.statement[0].managed_rule_group_statement[0].vendor_name == "AWS" &&
      r.statement[0].managed_rule_group_statement[0].name == "AWSManagedRulesCommonRuleSet" &&
      length(r.override_action[0].none) == 1 &&
      length(r.override_action[0].count) == 0
    ])
    error_message = "AWSManagedRulesCommonRuleSet must be present with vendor AWS and override_action none."
  }

  assert {
    condition = anytrue([
      for r in aws_wafv2_web_acl.main.rule :
      length(r.statement[0].managed_rule_group_statement) == 1 &&
      r.statement[0].managed_rule_group_statement[0].vendor_name == "AWS" &&
      r.statement[0].managed_rule_group_statement[0].name == "AWSManagedRulesKnownBadInputsRuleSet" &&
      length(r.override_action[0].none) == 1 &&
      length(r.override_action[0].count) == 0
    ])
    error_message = "AWSManagedRulesKnownBadInputsRuleSet must be present with vendor AWS and override_action none."
  }

  # Metrics and sampled requests (TC-153-03)
  assert {
    condition = (
      aws_wafv2_web_acl.main.visibility_config[0].cloudwatch_metrics_enabled &&
      aws_wafv2_web_acl.main.visibility_config[0].sampled_requests_enabled &&
      alltrue([
        for r in aws_wafv2_web_acl.main.rule :
        r.visibility_config[0].cloudwatch_metrics_enabled &&
        r.visibility_config[0].sampled_requests_enabled
      ]) &&
      length(distinct(concat(
        [aws_wafv2_web_acl.main.visibility_config[0].metric_name],
        [for r in aws_wafv2_web_acl.main.rule : r.visibility_config[0].metric_name]
      ))) == 4
    )
    error_message = "ACL and all rules must enable CloudWatch metrics and sampled requests with distinct metric names."
  }

  # Association (TC-153-04)
  assert {
    condition     = aws_wafv2_web_acl_association.main.resource_arn == var.resource_arn
    error_message = "Web ACL association must attach to var.resource_arn."
  }

  # Empty exempt CIDRs -> no IP set (TC-153-05)
  assert {
    condition     = length(aws_wafv2_ip_set.rate_limit_exempt) == 0
    error_message = "No IP set should be created when rate_limit_exempt_cidrs is empty."
  }

  # No explicit tags override (TC-153-11)
  assert {
    condition     = aws_wafv2_web_acl.main.tags == null
    error_message = "Module must not override provider default_tags by setting tags."
  }
}

# TC-153-05: exempt CIDRs
run "exempt_cidrs_creates_ip_set_and_scope_down" {
  command = apply

  variables {
    rate_limit_exempt_cidrs = ["203.0.113.10/32", "198.51.100.0/24"]
  }

  assert {
    condition     = length(aws_wafv2_ip_set.rate_limit_exempt) == 1
    error_message = "One IP set must be created when rate_limit_exempt_cidrs is non-empty."
  }

  assert {
    condition     = aws_wafv2_ip_set.rate_limit_exempt[0].ip_address_version == "IPV4" && aws_wafv2_ip_set.rate_limit_exempt[0].scope == "REGIONAL"
    error_message = "IP set must be REGIONAL IPV4."
  }

  assert {
    condition     = toset(aws_wafv2_ip_set.rate_limit_exempt[0].addresses) == toset(["203.0.113.10/32", "198.51.100.0/24"])
    error_message = "IP set addresses must match rate_limit_exempt_cidrs."
  }

  assert {
    condition = anytrue([
      for r in aws_wafv2_web_acl.main.rule :
      r.name == "rate-limit" &&
      length(r.statement[0].rate_based_statement[0].scope_down_statement) == 1 &&
      length(r.statement[0].rate_based_statement[0].scope_down_statement[0].not_statement) == 1 &&
      length(r.statement[0].rate_based_statement[0].scope_down_statement[0].not_statement[0].statement[0].ip_set_reference_statement) == 1
    ])
    error_message = "Rate rule must have scope_down_statement with not + ip_set_reference_statement."
  }
}

# TC-153-06: managed_rules_count_only
run "managed_rules_count_only" {
  command = apply

  variables {
    managed_rules_count_only = true
  }

  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.main.rule :
      r.name == "rate-limit"
      ? length(r.action[0].block) == 1
      : (length(r.override_action[0].count) == 1 && length(r.override_action[0].none) == 0)
    ])
    error_message = "Managed rules must use override_action count while rate rule still blocks."
  }
}

# TC-153-07: input validations
run "rejects_rate_limit_below_min" {
  command = plan
  variables {
    rate_limit = 9
  }
  expect_failures = [var.rate_limit]
}

run "rejects_rate_limit_above_max" {
  command = plan
  variables {
    rate_limit = 2000000001
  }
  expect_failures = [var.rate_limit]
}

run "rejects_ipv6_exempt_cidr" {
  command = plan
  variables {
    rate_limit_exempt_cidrs = ["::/0"]
  }
  expect_failures = [var.rate_limit_exempt_cidrs]
}

run "rejects_zero_prefix_exempt_cidr" {
  command = plan
  variables {
    rate_limit_exempt_cidrs = ["0.0.0.0/0"]
  }
  expect_failures = [var.rate_limit_exempt_cidrs]
}

run "rejects_prefix_below_8_exempt_cidr" {
  command = plan
  variables {
    rate_limit_exempt_cidrs = ["10.0.0.0/7"]
  }
  expect_failures = [var.rate_limit_exempt_cidrs]
}

run "rejects_cidr_missing_slash" {
  command = plan
  variables {
    rate_limit_exempt_cidrs = ["10.0.0.1"]
  }
  expect_failures = [var.rate_limit_exempt_cidrs]
}

run "rejects_name_with_spaces" {
  command = plan
  variables {
    name = "bad name"
  }
  expect_failures = [var.name]
}
