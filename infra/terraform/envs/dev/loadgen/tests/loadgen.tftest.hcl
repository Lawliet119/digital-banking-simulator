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
    }
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
