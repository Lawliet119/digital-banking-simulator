mock_provider "aws" {
  # Giá trị giả đúng định dạng id của Cognito (provider kiểm định dạng khi apply).
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id = "ap-southeast-1_ABCDEFGHI"
    }
  }
}

variables {
  account_id = "123456789012"
}

# TC-34-01: SG của task api chỉ nhận 3000 từ SG alb, chỉ đi ra 443
run "api_security_group" {
  command = apply

  assert {
    condition     = aws_vpc_security_group_ingress_rule.api_from_alb.from_port == 3000 && aws_vpc_security_group_ingress_rule.api_from_alb.to_port == 3000 && aws_vpc_security_group_ingress_rule.api_from_alb.ip_protocol == "tcp"
    error_message = "api must accept only tcp 3000"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.api_from_alb.referenced_security_group_id == aws_security_group.alb.id && aws_vpc_security_group_ingress_rule.api_from_alb.cidr_ipv4 == null
    error_message = "api ingress must come from the alb security group, never a CIDR"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.api_https.from_port == 443 && aws_vpc_security_group_egress_rule.api_https.to_port == 443 && aws_vpc_security_group_egress_rule.api_https.cidr_ipv4 == "0.0.0.0/0"
    error_message = "api egress must be tcp 443 only"
  }

  assert {
    condition     = aws_security_group.api.vpc_id == aws_vpc.main.id && aws_security_group.alb.vpc_id == aws_vpc.main.id
    error_message = "security groups must live in the dev VPC"
  }
}

# TC-34-02: SG của ALB nhận 443 và 80 từ internet, chỉ đi tới task ở 3000
run "alb_security_group" {
  command = apply

  assert {
    condition     = aws_vpc_security_group_ingress_rule.alb_https.from_port == 443 && aws_vpc_security_group_ingress_rule.alb_https.cidr_ipv4 == "0.0.0.0/0"
    error_message = "alb must accept 443 from the internet"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.alb_http.from_port == 80 && aws_vpc_security_group_ingress_rule.alb_http.cidr_ipv4 == "0.0.0.0/0"
    error_message = "alb must accept 80 from the internet (redirected to 443)"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.alb_to_api.from_port == 3000 && aws_vpc_security_group_egress_rule.alb_to_api.referenced_security_group_id == aws_security_group.api.id
    error_message = "alb egress must be tcp 3000 to the api security group only"
  }
}

# TC-34-08 (phần base): log group của task api nằm ở base, giữ 7 ngày
run "api_log_group" {
  command = plan

  assert {
    condition     = aws_cloudwatch_log_group.api.name == "/dbs/dev/api" && aws_cloudwatch_log_group.api.retention_in_days == 7
    error_message = "api log group must be /dbs/dev/api with 7 days retention"
  }
}

run "exports_for_session" {
  command = apply

  assert {
    condition     = output.alb_security_group_id == aws_security_group.alb.id && output.api_security_group_id == aws_security_group.api.id
    error_message = "security group ids must be exported"
  }

  assert {
    condition     = output.api_log_group_name == "/dbs/dev/api" && output.api_log_group_arn == aws_cloudwatch_log_group.api.arn
    error_message = "log group name and arn must be exported"
  }
}
