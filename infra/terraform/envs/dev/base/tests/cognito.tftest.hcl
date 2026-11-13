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

# TC-54-01: user pool theo ADR-06
run "user_pool" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool.main.name == "dbs" && aws_cognito_user_pool.main.username_attributes == toset(["email"]) && aws_cognito_user_pool.main.auto_verified_attributes == toset(["email"])
    error_message = "pool must sign in with email and verify it automatically"
  }

  assert {
    condition     = one(aws_cognito_user_pool.main.username_configuration).case_sensitive == false
    error_message = "usernames must be case-insensitive (cannot be changed after creation)"
  }

  assert {
    condition     = aws_cognito_user_pool.main.mfa_configuration == "OFF" && aws_cognito_user_pool.main.user_pool_tier == "ESSENTIALS"
    error_message = "MFA off (ADR-06) and ESSENTIALS tier"
  }

  assert {
    condition     = one(aws_cognito_user_pool.main.admin_create_user_config).allow_admin_create_user_only == false
    error_message = "self sign-up must be enabled (UC-1)"
  }

  assert {
    condition     = aws_cognito_user_pool.main.deletion_protection == "INACTIVE"
    error_message = "deletion protection defaults to INACTIVE for dev (teardown)"
  }

  assert {
    condition     = one(aws_cognito_user_pool.main.user_attribute_update_settings).attributes_require_verification_before_update == toset(["email"])
    error_message = "a changed email must be verified before it takes effect"
  }

  assert {
    condition     = one(one(aws_cognito_user_pool.main.account_recovery_setting).recovery_mechanism).name == "verified_email"
    error_message = "recovery only through verified email"
  }
}

run "deletion_protection_follows_variable" {
  command = plan

  variables {
    cognito_deletion_protection = "ACTIVE"
  }

  assert {
    condition     = aws_cognito_user_pool.main.deletion_protection == "ACTIVE"
    error_message = "deletion_protection must follow the variable"
  }
}

# TC-54-02: chính sách mật khẩu
run "password_policy" {
  command = plan

  assert {
    condition = (
      one(aws_cognito_user_pool.main.password_policy).minimum_length == 12
      && one(aws_cognito_user_pool.main.password_policy).require_uppercase
      && one(aws_cognito_user_pool.main.password_policy).require_lowercase
      && one(aws_cognito_user_pool.main.password_policy).require_numbers
      && one(aws_cognito_user_pool.main.password_policy).require_symbols
    )
    error_message = "password policy: at least 12 characters with all four classes"
  }
}

# TC-54-03: bốn nhóm gắn đúng pool
run "groups" {
  command = apply

  assert {
    condition     = toset(keys(aws_cognito_user_group.groups)) == toset(["customer", "operator", "auditor", "admin"])
    error_message = "exactly the four ADR-06 groups"
  }

  assert {
    condition     = alltrue([for g in aws_cognito_user_group.groups : g.user_pool_id == aws_cognito_user_pool.main.id])
    error_message = "groups must belong to the pool"
  }
}

# TC-54-04, TC-54-05: app client
run "app_client" {
  command = apply

  assert {
    condition     = aws_cognito_user_pool_client.app.generate_secret == false
    error_message = "the app client must have no secret"
  }

  assert {
    condition     = aws_cognito_user_pool_client.app.explicit_auth_flows == toset(["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_PASSWORD_AUTH"])
    error_message = "only SRP, refresh and USER_PASSWORD auth flows (ADR-06)"
  }

  assert {
    condition     = aws_cognito_user_pool_client.app.prevent_user_existence_errors == "ENABLED" && aws_cognito_user_pool_client.app.enable_token_revocation == true
    error_message = "hide user existence and enable token revocation"
  }

  assert {
    condition = (
      aws_cognito_user_pool_client.app.access_token_validity == 15
      && aws_cognito_user_pool_client.app.id_token_validity == 15
      && aws_cognito_user_pool_client.app.refresh_token_validity == 1
      && one(aws_cognito_user_pool_client.app.token_validity_units).access_token == "minutes"
      && one(aws_cognito_user_pool_client.app.token_validity_units).id_token == "minutes"
      && one(aws_cognito_user_pool_client.app.token_validity_units).refresh_token == "days"
    )
    error_message = "access and id tokens 15 minutes, refresh token 1 day (ADR-06)"
  }

  assert {
    condition     = aws_cognito_user_pool_client.app.user_pool_id == aws_cognito_user_pool.main.id
    error_message = "client must belong to the pool"
  }
}

# TC-54-06: output issuer và biến deletion protection
run "issuer_output" {
  command = apply

  assert {
    condition     = output.cognito_issuer == "https://cognito-idp.ap-southeast-1.amazonaws.com/${aws_cognito_user_pool.main.id}"
    error_message = "issuer must be https://cognito-idp.<region>.amazonaws.com/<pool id>"
  }

  assert {
    condition     = output.cognito_user_pool_id == aws_cognito_user_pool.main.id && output.cognito_client_id == aws_cognito_user_pool_client.app.id
    error_message = "pool id and client id must be exported"
  }
}

run "rejects_bad_deletion_protection" {
  command = plan

  variables {
    cognito_deletion_protection = "MAYBE"
  }

  expect_failures = [var.cognito_deletion_protection]
}

# TC-101-01: role riêng để seed (BL-101): quyền đúng danh sách ở README, không wildcard, không quyền xóa
run "cognito_seeder_role" {
  command = apply

  assert {
    condition     = aws_iam_role.cognito_seeder.name == "dbs-dev-cognito-seeder"
    error_message = "seeder role must be dbs-dev-cognito-seeder"
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_role.cognito_seeder.assume_role_policy).Statement) == 1 &&
      jsondecode(aws_iam_role.cognito_seeder.assume_role_policy).Statement[0].Action == "sts:AssumeRole" &&
      jsondecode(aws_iam_role.cognito_seeder.assume_role_policy).Statement[0].Principal.AWS == "arn:aws:iam::123456789012:root"
    )
    error_message = "only principals of this account (with sts:AssumeRole in their own policy) may assume the seeder role"
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_role_policy.cognito_seeder.policy).Statement) == 2 &&
      alltrue([for st in jsondecode(aws_iam_role_policy.cognito_seeder.policy).Statement : st.Effect == "Allow"])
    )
    error_message = "seeder policy must have exactly two Allow statements"
  }

  assert {
    condition = (
      toset(one([for st in jsondecode(aws_iam_role_policy.cognito_seeder.policy).Statement : st.Action if st.Sid == "SeedCognitoUsers"])) == toset([
        "cognito-idp:AdminGetUser", "cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminRemoveUserFromGroup", "cognito-idp:AdminUpdateUserAttributes", "cognito-idp:AdminListGroupsForUser", "cognito-idp:AdminUserGlobalSignOut",
      ]) &&
      one([for st in jsondecode(aws_iam_role_policy.cognito_seeder.policy).Statement : st.Resource if st.Sid == "SeedCognitoUsers"]) == "arn:aws:cognito-idp:ap-southeast-1:123456789012:userpool/${aws_cognito_user_pool.main.id}"
    )
    error_message = "the eight Cognito admin actions on the dbs user pool only"
  }

  assert {
    condition = (
      toset(one([for st in jsondecode(aws_iam_role_policy.cognito_seeder.policy).Statement : st.Action if st.Sid == "DemoAccountsSecret"])) == toset([
        "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:TagResource",
      ]) &&
      one([for st in jsondecode(aws_iam_role_policy.cognito_seeder.policy).Statement : st.Resource if st.Sid == "DemoAccountsSecret"]) == ["arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:dbs/dev/demo-accounts-*"]
    )
    error_message = "the five Secrets Manager actions on dbs/dev/demo-accounts-* only"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.cognito_seeder.policy, "\"*\"") && !strcontains(aws_iam_role_policy.cognito_seeder.policy, ":*\"") && !strcontains(aws_iam_role_policy.cognito_seeder.policy, "Delete") && !strcontains(aws_iam_role_policy.cognito_seeder.policy, "kms:")
    error_message = "no wildcard action or resource, no delete, no KMS"
  }

  assert {
    condition     = output.cognito_seeder_role_arn == aws_iam_role.cognito_seeder.arn
    error_message = "seeder role arn must be exported"
  }
}
