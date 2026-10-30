# DBS-54: user pool Cognito theo ADR-06. Ở `base` vì giữ lại giữa các phiên; `prod/session` dùng lại.
# Tài khoản nhân viên demo do infra/scripts/seed-cognito.sh tạo, không phải Terraform (mật khẩu không vào state).
resource "aws_cognito_user_pool" "main" {
  name                     = "dbs"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF"
  user_pool_tier           = "ESSENTIALS"
  deletion_protection      = var.cognito_deletion_protection

  # Không đổi được sau khi tạo: email là tên đăng nhập nên không phân biệt hoa thường.
  username_configuration {
    case_sensitive = false
  }

  # UC-1: khách hàng tự đăng ký.
  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  # Email mới (cũng là tên đăng nhập) chỉ có hiệu lực sau khi xác minh.
  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  password_policy {
    minimum_length    = 12
    require_uppercase = true
    require_lowercase = true
    require_numbers   = true
    require_symbols   = true
  }
}

# Vai trò của ứng dụng lấy từ claim `cognito:groups` của access token. Token không thuộc nhóm nào
# (khách tự đăng ký) được coi là `customer` (ADR-06), nhưng nhóm `customer` vẫn được tạo cho đủ bốn vai.
resource "aws_cognito_user_group" "groups" {
  for_each = toset(["customer", "operator", "auditor", "admin"])

  name         = each.key
  user_pool_id = aws_cognito_user_pool.main.id
}

# App client không secret. USER_PASSWORD_AUTH chỉ cho script seed và k6 với tài khoản demo (ADR-06).
resource "aws_cognito_user_pool_client" "app" {
  name         = "dbs-app"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 15
  id_token_validity      = 15
  refresh_token_validity = 1

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}
