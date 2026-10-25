# DBS-38: role cho workflow deploy.yml cập nhật service ECS bằng OIDC. Tách khỏi role đẩy image (oidc.tf)
# để mỗi role chỉ có quyền của việc mình làm. Cùng điều kiện sub (nhánh main của repo) nên trên `main` mỗi job
# assume được cả hai role; thêm `environment:` vào job sau này sẽ đổi sub và làm assume hỏng.
resource "aws_iam_role" "github_deploy" {
  name                 = "dbs-github-deploy"
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

locals {
  ecs_service_arn  = "arn:aws:ecs:${var.region}:${var.account_id}:service/dbs-dev/api"
  ecs_task_def_arn = "arn:aws:ecs:${var.region}:${var.account_id}:task-definition/dbs-api:*"
  task_role_arns = [
    "arn:aws:iam::${var.account_id}:role/dbs-dev-api-execution",
    "arn:aws:iam::${var.account_id}:role/dbs-dev-api-task",
  ]
}

resource "aws_iam_role_policy" "deploy" {
  name = "deploy-dbs-dev-api"
  role = aws_iam_role.github_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # AWS không hỗ trợ giới hạn theo tài nguyên cho ba action này.
        Effect = "Allow"
        Action = [
          "ecs:RegisterTaskDefinition",
          "ecs:DescribeTaskDefinition",
          "elasticloadbalancing:DescribeLoadBalancers",
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:DescribeServices", "ecs:UpdateService"]
        Resource = local.ecs_service_arn
      },
      {
        # Giữ tag chi phí (project/env/owner) của task definition mới.
        Effect   = "Allow"
        Action   = ["ecs:TagResource"]
        Resource = local.ecs_task_def_arn
        Condition = {
          StringEquals = { "ecs:CreateAction" = "RegisterTaskDefinition" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = local.task_role_arns
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
      {
        # Kiểm tag SHA có trên ECR trước khi đăng ký task definition.
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage"]
        Resource = aws_ecr_repository.api.arn
      },
    ]
  })
}
