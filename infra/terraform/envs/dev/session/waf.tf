module "waf" {
  count = var.waf_enabled ? 1 : 0

  source = "../../../modules/waf"

  name                     = "dbs-dev-waf"
  resource_arn             = aws_lb.main.arn
  rate_limit               = var.waf_rate_limit
  rate_limit_exempt_cidrs  = var.waf_rate_limit_exempt_cidrs
  managed_rules_count_only = var.waf_managed_rules_count_only
}

check "waf_off_date" {
  assert {
    condition     = !var.waf_enabled || timecmp(plantimestamp(), "${var.waf_off_date}T00:00:00Z") < 0
    error_message = "WAF is still enabled on/after waf_off_date (${var.waf_off_date}). Set waf_enabled = false to avoid ongoing charges."
  }
}
