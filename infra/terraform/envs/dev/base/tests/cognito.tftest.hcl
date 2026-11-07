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
