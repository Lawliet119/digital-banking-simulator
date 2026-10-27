# DBS-36: GitHub Actions đẩy image lên ECR bằng OIDC, không có access key nào trong GitHub Secrets.
# Provider OIDC là duy nhất trong cả tài khoản (URL không trùng được); nơi khác cần thì dùng data source.
# Từ 2023 AWS xác thực chứng chỉ GitHub bằng CA tin cậy nên không cần thumbprint.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  github_sub = "${var.github_oidc_sub_prefix}:ref:refs/heads/${var.github_branch}"
}

# Trust policy chỉ nhận đúng một sub (repo có id + nhánh), so khớp StringEquals, không wildcard.
# Mọi workflow chạy trên nhánh này có `id-token: write` đều assume được: chỉ image.yml được xin quyền đó.
resource "aws_iam_role" "github_ecr_push" {
  name                 = "dbs-github-ecr-push"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = local.github_sub
        }
      }
    }]
  })
}

# Chỉ đẩy và đọc trên repo dbs-api. GetAuthorizationToken không thu hẹp được theo repo (yêu cầu của AWS).
resource "aws_iam_role_policy" "ecr_push" {
  name = "ecr-push-dbs-api"
  role = aws_iam_role.github_ecr_push.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:BatchGetImage",
          "ecr:DescribeImageScanFindings",
        ]
        Resource = aws_ecr_repository.api.arn
      },
    ]
  })
}
