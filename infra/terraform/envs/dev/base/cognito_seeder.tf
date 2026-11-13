# BL-101: role riêng cho `infra/scripts/seed-cognito.sh`, thay cho việc chạy bằng quyền admin toàn quyền.
# Quyền đúng bằng danh sách ở README Terraform (mục Cognito) và đúng các lệnh `aws` mà script gọi:
# tám hành động `cognito-idp:Admin*` trên user pool `dbs` và năm hành động `secretsmanager` trên secret `dbs/dev/demo-accounts`.
#
# Ai assume được: trust là gốc tài khoản (`:root`), nghĩa là chỉ principal của tài khoản này CÓ quyền
# `sts:AssumeRole` trên role này trong identity policy của chính nó (admin có sẵn) mới assume được; một IAM user
# khác không tự assume được. Không đòi MFA vì dev không bật MFA cho IAM user (đòi thì không ai assume được).
# Secret dùng khóa mặc định `aws/secretsmanager` (script không truyền --kms-key-id) nên không cần quyền KMS.
# Không có quyền xóa secret hay xóa user: teardown secret là việc của admin (README Terraform, mục Cognito).
locals {
  cognito_user_pool_arn     = "arn:aws:cognito-idp:${var.region}:${var.account_id}:userpool/${aws_cognito_user_pool.main.id}"
  demo_accounts_secret_arns = ["arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:dbs/dev/demo-accounts-*"]
}

resource "aws_iam_role" "cognito_seeder" {
  name                 = "dbs-dev-cognito-seeder"
  description          = "Chay infra/scripts/seed-cognito.sh voi quyen toi thieu (BL-101)"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:root" }
    }]
  })
}

resource "aws_iam_role_policy" "cognito_seeder" {
  name = "seed-cognito"
  role = aws_iam_role.cognito_seeder.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SeedCognitoUsers"
        Effect = "Allow"
        Action = [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:AdminUserGlobalSignOut",
        ]
        Resource = local.cognito_user_pool_arn
      },
      {
        Sid    = "DemoAccountsSecret"
        Effect = "Allow"
        Action = [
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:TagResource",
        ]
        Resource = local.demo_accounts_secret_arns
      },
    ]
  })
}
