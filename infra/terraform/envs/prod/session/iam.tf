locals {
  ecs_execution_trust = jsonencode({
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

  ecs_task_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:${var.region}:${var.account_id}:*" }
      }
    }]
  })

  pull_image_statements = [
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
  ]

  decrypt_via_secrets_manager = {
    Effect    = "Allow"
    Action    = "kms:Decrypt"
    Resource  = local.base.kms_key_arn
    Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" } }
  }
}

# ---------- api ----------

resource "aws_iam_role" "execution" {
  name               = "dbs-prod-api-execution"
  assume_role_policy = local.ecs_execution_trust
}

resource "aws_iam_role_policy" "execution" {
  name = "pull-image-and-write-logs"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.pull_image_statements, [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.api.arn}:*"
      },
    ])
  })
}

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
      local.decrypt_via_secrets_manager,
    ]
  })
}

resource "aws_iam_role_policy" "read_redis_auth_secret" {
  name = "read-redis-auth-secret"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = aws_secretsmanager_secret.redis_auth.arn
    }]
  })
}

# Không bao giờ có quyền nào, nhất là SQS.
resource "aws_iam_role" "task" {
  name               = "dbs-prod-api-task"
  assume_role_policy = local.ecs_task_trust
}

# ---------- worker ----------

resource "aws_iam_role" "worker_execution" {
  name               = "dbs-prod-worker-execution"
  assume_role_policy = local.ecs_execution_trust
}

resource "aws_iam_role_policy" "worker_execution" {
  name = "pull-image-and-write-logs"
  role = aws_iam_role.worker_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.pull_image_statements, [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.worker.arn}:*"
      },
    ])
  })
}

resource "aws_iam_role_policy" "worker_read_secrets" {
  name = "read-db-master-and-redis-auth-secrets"
  role = aws_iam_role.worker_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        Resource = [
          aws_db_instance.main.master_user_secret[0].secret_arn,
          aws_secretsmanager_secret.redis_auth.arn,
        ]
      },
      local.decrypt_via_secrets_manager,
    ]
  })
}

resource "aws_iam_role" "worker_task" {
  name               = "dbs-prod-worker-task"
  assume_role_policy = local.ecs_task_trust
}

resource "aws_iam_role_policy_attachment" "worker_sqs" {
  role       = aws_iam_role.worker_task.name
  policy_arn = aws_iam_policy.worker_sqs.arn
}

# ---------- migrate ----------

resource "aws_iam_role" "migrate_execution" {
  name               = "dbs-prod-migrate-execution"
  assume_role_policy = local.ecs_execution_trust
}

resource "aws_iam_role_policy" "migrate_execution" {
  name = "pull-image-and-write-migrate-logs"
  role = aws_iam_role.migrate_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.pull_image_statements, [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream"]
        Resource = "${aws_cloudwatch_log_group.api.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.api.arn}:log-stream:migrate/*"
      },
    ])
  })
}

resource "aws_iam_role_policy" "migrate_read_db_master_secret" {
  name = "read-db-master-secret"
  role = aws_iam_role.migrate_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_db_instance.main.master_user_secret[0].secret_arn
      },
      local.decrypt_via_secrets_manager,
    ]
  })
}
