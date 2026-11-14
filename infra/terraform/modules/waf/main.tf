locals {
  managed_rule_groups = {
    common = {
      name       = "aws-managed-common"
      priority   = 20
      group_name = "AWSManagedRulesCommonRuleSet"
      metric     = "${var.name}-common"
    }
    known_bad_inputs = {
      name       = "aws-managed-known-bad-inputs"
      priority   = 30
      group_name = "AWSManagedRulesKnownBadInputsRuleSet"
      metric     = "${var.name}-known-bad-inputs"
    }
  }
}

resource "aws_wafv2_ip_set" "rate_limit_exempt" {
  count = length(var.rate_limit_exempt_cidrs) > 0 ? 1 : 0

  name               = "${var.name}-rate-limit-exempt"
  description        = "IPv4 CIDRs exempted from WAF rate-limit rule."
  scope              = "REGIONAL"
  ip_address_version = "IPV4"
  addresses          = var.rate_limit_exempt_cidrs
}

resource "aws_wafv2_web_acl" "main" {
  name        = var.name
  description = "Regional WAFv2 Web ACL with rate limiting and AWS managed rules."
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "rate-limit"
    priority = 10

    action {
      block {
        custom_response {
          response_code = 429
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        dynamic "scope_down_statement" {
          for_each = length(var.rate_limit_exempt_cidrs) > 0 ? [1] : []
          content {
            not_statement {
              statement {
                ip_set_reference_statement {
                  arn = aws_wafv2_ip_set.rate_limit_exempt[0].arn
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = local.managed_rule_groups
    content {
      name     = rule.value.name
      priority = rule.value.priority

      override_action {
        dynamic "none" {
          for_each = var.managed_rules_count_only ? [] : [1]
          content {}
        }
        dynamic "count" {
          for_each = var.managed_rules_count_only ? [1] : []
          content {}
        }
      }

      statement {
        managed_rule_group_statement {
          name        = rule.value.group_name
          vendor_name = "AWS"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.value.metric
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "main" {
  resource_arn = var.resource_arn
  web_acl_arn  = aws_wafv2_web_acl.main.arn
}
