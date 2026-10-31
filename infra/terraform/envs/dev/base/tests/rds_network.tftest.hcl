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

# TC-66-06: SG của RDS chỉ nhận 5432 từ SG api, không có egress; subnet group trên đúng 2 private subnet
run "db_security_group" {
  command = apply

  assert {
    condition     = aws_vpc_security_group_ingress_rule.db_from_api.from_port == 5432 && aws_vpc_security_group_ingress_rule.db_from_api.to_port == 5432 && aws_vpc_security_group_ingress_rule.db_from_api.ip_protocol == "tcp"
    error_message = "db must accept only tcp 5432"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.db_from_api.referenced_security_group_id == aws_security_group.api.id && aws_vpc_security_group_ingress_rule.db_from_api.cidr_ipv4 == null
    error_message = "db ingress must come from the api security group, never a CIDR"
  }

  assert {
    condition     = aws_security_group.db.vpc_id == aws_vpc.main.id
    error_message = "db security group must live in the dev VPC"
  }

  assert {
    condition     = length(aws_db_subnet_group.main.subnet_ids) == 2
    error_message = "db subnet group must span the two private subnets"
  }

  assert {
    condition     = alltrue([for id in aws_db_subnet_group.main.subnet_ids : contains(aws_subnet.private[*].id, id)])
    error_message = "db subnet group must use only private subnets"
  }
}

# TC-66-07: task api chỉ được đi ra 5432 tới SG db (luật 443 cũ giữ nguyên)
run "api_egress_to_db" {
  command = apply

  assert {
    condition     = aws_vpc_security_group_egress_rule.api_to_db.from_port == 5432 && aws_vpc_security_group_egress_rule.api_to_db.to_port == 5432 && aws_vpc_security_group_egress_rule.api_to_db.referenced_security_group_id == aws_security_group.db.id && aws_vpc_security_group_egress_rule.api_to_db.cidr_ipv4 == null
    error_message = "api egress to the database must be tcp 5432 to the db security group only"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.api_https.from_port == 443
    error_message = "the existing 443 egress must stay"
  }
}

# TC-66-09: CMK dùng chung
run "kms_key" {
  command = apply

  assert {
    condition     = aws_kms_key.main.enable_key_rotation == true && aws_kms_key.main.deletion_window_in_days == 7
    error_message = "CMK must rotate and wait 7 days before deletion"
  }

  assert {
    condition     = aws_kms_alias.main.name == "alias/dbs-dev" && aws_kms_alias.main.target_key_id == aws_kms_key.main.key_id
    error_message = "alias/dbs-dev must point to the CMK"
  }

  assert {
    condition     = output.kms_key_arn == aws_kms_key.main.arn && output.db_subnet_group_name == aws_db_subnet_group.main.name && output.db_security_group_id == aws_security_group.db.id
    error_message = "kms key arn, subnet group name and db security group id must be exported"
  }
}
