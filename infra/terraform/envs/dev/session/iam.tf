locals {
  ecs_tasks_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.account_id }
      }
    }]
  })
}

# Execution role: do ECS agent dùng để kéo image và ghi log, không phải mã ứng dụng.
resource "aws_iam_role" "execution" {
  name               = "dbs-dev-api-execution"
  assume_role_policy = local.ecs_tasks_trust
}

# Policy theo từng tài nguyên thay cho AmazonECSTaskExecutionRolePolicy (cấp trên `*`). DBS-67 thêm
# secretsmanager:GetSecretValue (và kms:Decrypt nếu dùng CMK) khi chuyển bí mật vào `secrets`.
# aws_cloudwatch_log_group.arn của provider 6 không có `:*`, nhưng action trên log stream cần nó.
resource "aws_iam_role_policy" "execution" {
  name = "pull-image-and-write-logs"
  role = aws_iam_role.execution.id

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
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchCheckLayerAvailability",
        ]
        Resource = local.base.ecr_repository_arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${local.base.api_log_group_arn}:*"
      },
    ]
  })
}

# Task role: quyền của mã ứng dụng. Chưa có quyền nào; Cognito do task khác thêm. Không bao giờ có quyền SQS:
# chỉ worker dùng queue (ADR-13), và queue policy ở base chặn role này (DBS-73).
# Không gắn policy hay attachment nào ở task này (kiểm bằng grep ở M-34-02).
resource "aws_iam_role" "task" {
  name               = "dbs-dev-api-task"
  assume_role_policy = local.ecs_tasks_trust
}
