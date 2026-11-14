output "web_acl_arn" {
  description = "ARN of the WAFv2 Web ACL."
  value       = aws_wafv2_web_acl.main.arn
}

output "web_acl_name" {
  description = "Name of the WAFv2 Web ACL."
  value       = aws_wafv2_web_acl.main.name
}

output "metric_names" {
  description = "Map of rule keys to CloudWatch metric names."
  value = {
    rate_limit       = "${var.name}-rate-limit"
    common           = "${var.name}-common"
    known_bad_inputs = "${var.name}-known-bad-inputs"
  }
}
