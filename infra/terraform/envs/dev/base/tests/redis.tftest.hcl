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

# TC-75-01: SG redis chỉ nhận 6379 từ SG api, không có egress; api chỉ đi ra 6379 tới SG redis
run "redis_security_group" {
  command = apply

  assert {
    condition     = aws_security_group.redis.name == "dbs-dev-redis" && aws_security_group.redis.vpc_id == aws_vpc.main.id
    error_message = "redis security group must be dbs-dev-redis in the dev VPC"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.redis_from_api.from_port == 6379 && aws_vpc_security_group_ingress_rule.redis_from_api.to_port == 6379 && aws_vpc_security_group_ingress_rule.redis_from_api.ip_protocol == "tcp"
    error_message = "redis must accept only tcp 6379"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.redis_from_api.security_group_id == aws_security_group.redis.id && aws_vpc_security_group_ingress_rule.redis_from_api.referenced_security_group_id == aws_security_group.api.id && aws_vpc_security_group_ingress_rule.redis_from_api.cidr_ipv4 == null
    error_message = "redis ingress must come from the api security group, never a CIDR"
  }

  assert {
    condition     = length(coalesce(aws_security_group.redis.egress, [])) == 0
    error_message = "redis security group must have no egress rule"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.api_to_redis.security_group_id == aws_security_group.api.id && aws_vpc_security_group_egress_rule.api_to_redis.from_port == 6379 && aws_vpc_security_group_egress_rule.api_to_redis.to_port == 6379 && aws_vpc_security_group_egress_rule.api_to_redis.referenced_security_group_id == aws_security_group.redis.id && aws_vpc_security_group_egress_rule.api_to_redis.cidr_ipv4 == null
    error_message = "api egress to redis must be tcp 6379 to the redis security group only"
  }
}

# TC-75-02: subnet group trên đúng 2 private subnet
run "redis_subnet_group" {
  command = apply

  assert {
    condition     = aws_elasticache_subnet_group.main.name == "dbs-dev" && length(aws_elasticache_subnet_group.main.subnet_ids) == 2
    error_message = "redis subnet group must be dbs-dev on two subnets"
  }

  assert {
    condition     = alltrue([for id in aws_elasticache_subnet_group.main.subnet_ids : contains(aws_subnet.private[*].id, id)])
    error_message = "redis subnet group must use only private subnets"
  }
}

run "exports_for_session" {
  command = apply

  assert {
    condition     = output.redis_subnet_group_name == aws_elasticache_subnet_group.main.name && output.redis_security_group_id == aws_security_group.redis.id
    error_message = "redis subnet group and security group must be exported"
  }
}
