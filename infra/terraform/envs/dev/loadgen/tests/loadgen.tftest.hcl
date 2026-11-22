mock_provider "aws" {}

variables {
  state_bucket = "dbs-tfstate-123456789012-ap-southeast-1"
  account_id   = "123456789012"
}

override_resource {
  target = aws_iam_role.loadgen
  values = {
    arn = "arn:aws:iam::123456789012:role/dbs-dev-loadgen"
  }
}

override_resource {
  target = aws_s3_bucket.loadgen
  values = {
    arn = "arn:aws:s3:::dbs-loadgen-123456789012-ap-southeast-1"
  }
}

override_data {
  target = data.aws_ssm_parameter.al2023
  values = {
    value = "ami-0123456789abcdef0"
  }
}

override_data {
  target = data.terraform_remote_state.base
  values = {
    outputs = {
      vpc_id               = "vpc-0abc"
      public_subnet_ids    = ["subnet-pub-a", "subnet-pub-b"]
      db_security_group_id = "sg-db"
      cognito_user_pool_id = "ap-southeast-1_ABCDEFGHI"
      kms_key_arn          = "arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000"

      private_subnet_ids      = ["subnet-priv-a", "subnet-priv-b"]
      redis_security_group_id = "sg-redis"
      redis_auth_secret_arn   = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:dbs/dev/redis-auth-AbCdEf"
    }
  }
}

override_resource {
  target = aws_network_acl.redis_fault
  values = {
    id = "acl-0fault"
  }
}

override_data {
  target = data.aws_subnet.public
  values = {
    cidr_block = "10.0.0.0/24"
  }
}

# TC-166-01: máy tải ở public subnet, không NAT, IMDSv2 bắt buộc, đĩa mã hóa, có IP công khai để miễn rate rule WAF.
run "loadgen_instance_is_hardened_and_public" {
  command = plan

  assert {
    condition     = aws_instance.loadgen.subnet_id == "subnet-pub-a"
    error_message = "the load generator must sit in a public subnet of the base VPC"
  }

  assert {
    condition     = aws_instance.loadgen.metadata_options[0].http_tokens == "required"
    error_message = "IMDSv2 must be required"
  }

  assert {
    condition     = aws_instance.loadgen.root_block_device[0].encrypted == true
    error_message = "the root volume must be encrypted"
  }

  assert {
    condition     = aws_instance.loadgen.associate_public_ip_address == true
    error_message = "the subnet does not auto-assign public IPs (base/network.tf), so the instance asks for one"
  }
}

# TC-166-02: SG không có ingress; egress chỉ 443 và 5432 tới SG RDS; RDS chỉ nhận thêm đúng SG máy tải.
run "loadgen_security_groups_are_minimal" {
  command = plan

  assert {
    condition     = aws_vpc_security_group_egress_rule.loadgen_https.from_port == 443 && aws_vpc_security_group_egress_rule.loadgen_https.to_port == 443
    error_message = "the only internet egress is HTTPS"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.loadgen_to_db.from_port == 5432 && aws_vpc_security_group_egress_rule.loadgen_to_db.referenced_security_group_id == "sg-db"
    error_message = "PostgreSQL egress goes only to the RDS security group"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.db_from_loadgen.security_group_id == "sg-db" && aws_vpc_security_group_ingress_rule.db_from_loadgen.from_port == 5432
    error_message = "the RDS security group gets exactly one extra ingress rule on 5432"
  }
}

# TC-166-03: bucket kết quả không công khai, mã hóa, chỉ TLS; quyền IAM không đụng secret master.
run "loadgen_bucket_and_iam_are_least_privilege" {
  command = apply

  assert {
    condition     = aws_s3_bucket_public_access_block.loadgen.block_public_acls && aws_s3_bucket_public_access_block.loadgen.restrict_public_buckets
    error_message = "the result bucket must block public access"
  }

  assert {
    condition     = aws_s3_bucket.loadgen.force_destroy == true
    error_message = "the bucket must be destroyable with its objects"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.loadgen.policy, "rds!db") && !strcontains(aws_iam_role_policy.loadgen.policy, "demo-accounts")
    error_message = "the instance role must not read the master secret or the demo accounts secret"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.loadgen.policy, "secret:dbs/dev/db-api-")
    error_message = "the instance role reads only the dbs_api secret"
  }
}

run "rejects_instance_type_outside_allowlist" {
  command = plan

  variables {
    instance_type = "m5.24xlarge"
  }

  expect_failures = [var.instance_type]
}

# TC-166-13: client Cognito tạm sống 240 phút, chỉ luồng mật khẩu và refresh, không secret; app client của base không bị đụng.
run "loadgen_cognito_client_is_temporary_and_long_lived" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool_client.loadgen.access_token_validity == 240 && aws_cognito_user_pool_client.loadgen.token_validity_units[0].access_token == "minutes"
    error_message = "access token must live 240 minutes so one fixture covers all five scenarios"
  }

  assert {
    condition     = aws_cognito_user_pool_client.loadgen.generate_secret == false && toset(aws_cognito_user_pool_client.loadgen.explicit_auth_flows) == toset(["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"])
    error_message = "no client secret; only password and refresh flows"
  }

  assert {
    condition     = aws_cognito_user_pool_client.loadgen.name == "dbs-loadgen"
    error_message = "the temporary client has its own name, never dbs-app"
  }
}

# TC-167-07: mặc định (redis_fault_enabled=false) stack không có đường mạng, NACL hay quyền nào tới Redis.
run "redis_fault_is_off_by_default" {
  command = apply

  assert {
    condition     = length(aws_network_acl.redis_fault) == 0 && length(aws_network_acl_association.private) == 0 && length(aws_network_acl_rule.allow_ingress) == 0
    error_message = "no NACL and no association unless redis_fault_enabled"
  }

  assert {
    condition     = length(aws_vpc_security_group_egress_rule.loadgen_to_redis) == 0 && length(aws_vpc_security_group_ingress_rule.redis_from_loadgen) == 0
    error_message = "no 6379 rule unless redis_fault_enabled"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.loadgen.policy, "ec2:") && !strcontains(aws_iam_role_policy.loadgen.policy, "redis-auth")
    error_message = "the instance role has no EC2 permission and cannot read the Redis AUTH secret by default"
  }

  assert {
    condition     = output.redis_fault_nacl_id == "" && output.redis_fault_deny_cidrs == "" && output.redis_auth_secret_arn == ""
    error_message = "the fault outputs are empty when disabled"
  }
}

# TC-167-08: bật: 6379 hai phía đúng SG, NACL gắn đúng hai private subnet, Terraform không tạo luật nào số < 100, quyền IAM đúng phạm vi.
run "redis_fault_enabled_is_scoped" {
  command = apply

  variables {
    redis_fault_enabled = true
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.loadgen_to_redis[0].from_port == 6379 && aws_vpc_security_group_egress_rule.loadgen_to_redis[0].to_port == 6379 && aws_vpc_security_group_egress_rule.loadgen_to_redis[0].referenced_security_group_id == "sg-redis"
    error_message = "egress 6379 goes only to the Valkey security group"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.redis_from_loadgen[0].security_group_id == "sg-redis" && aws_vpc_security_group_ingress_rule.redis_from_loadgen[0].from_port == 6379 && aws_vpc_security_group_ingress_rule.redis_from_loadgen[0].to_port == 6379
    error_message = "the Valkey security group gets exactly one extra ingress rule, on 6379"
  }

  assert {
    condition     = toset([for a in aws_network_acl_association.private : a.subnet_id]) == toset(["subnet-priv-a", "subnet-priv-b"])
    error_message = "the fault NACL is associated with the private subnets only"
  }

  assert {
    condition     = aws_network_acl_rule.allow_ingress[0].rule_number == 100 && aws_network_acl_rule.allow_egress[0].rule_number == 100 && aws_network_acl_rule.allow_ingress[0].rule_action == "allow"
    error_message = "Terraform creates only rule 100 (allow); numbers below 100 belong to redis-fault.sh (50, 51)"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.loadgen.policy, "network-acl/acl-0fault") && strcontains(aws_iam_role_policy.loadgen.policy, "secret:dbs/dev/redis-auth-AbCdEf")
    error_message = "NACL entry permission is limited to this NACL and the secret to the Valkey AUTH secret"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.loadgen.policy, "ec2:*") && strcontains(aws_iam_role_policy.loadgen.policy, "ec2:CreateNetworkAclEntry") && strcontains(aws_iam_role_policy.loadgen.policy, "ec2:DeleteNetworkAclEntry")
    error_message = "only the two entry actions plus Describe"
  }

  assert {
    condition     = output.redis_fault_nacl_id == "acl-0fault" && output.redis_fault_deny_cidrs == "10.0.0.0/24"
    error_message = "outputs feed REDIS_FAULT_NACL_ID and REDIS_FAULT_DENY_CIDRS; the deny CIDRs are the public subnets, never the private ones"
  }
}
