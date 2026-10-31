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

# Policy theo từng tài nguyên thay cho AmazonECSTaskExecutionRolePolicy (cấp trên `*`). Quyền đọc
# secret DB nằm ở policy riêng `read-db-master-secret` bên dưới (DBS-67).
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

# DBS-67: execution role đọc đúng một secret (mật khẩu master do RDS quản lý) và giải mã bằng đúng CMK,
# chỉ qua Secrets Manager. ARN secret đổi mỗi lần dựng lại RDS nên revision ECS của phiên cũ không dùng lại được.
resource "aws_iam_role_policy" "read_db_master_secret" {
  name = "read-db-master-secret"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_db_instance.main.master_user_secret[0].secret_arn
      },
      {
        Effect    = "Allow"
        Action    = "kms:Decrypt"
        Resource  = local.base.kms_key_arn
        Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" } }
      },
    ]
  })
}

# DBS-75: execution role đọc AUTH token của Valkey. Secret mã hóa bằng cùng CMK, nên kms:Decrypt qua
# Secrets Manager ở read-db-master-secret đã đủ.
resource "aws_iam_role_policy" "read_redis_auth_secret" {
  name = "read-redis-auth-secret"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = local.base.redis_auth_secret_arn
    }]
  })
}

# Task role: quyền của mã ứng dụng. Chưa có quyền nào; SQS, Cognito do task khác thêm.
# Không gắn policy hay attachment nào ở task này (kiểm bằng grep ở M-34-02).
resource "aws_iam_role" "task" {
  name               = "dbs-dev-api-task"
  assume_role_policy = local.ecs_tasks_trust
}
