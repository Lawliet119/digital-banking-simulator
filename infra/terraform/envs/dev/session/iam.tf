# DBS-120: mỗi service một execution role (ECS agent dùng để kéo image, ghi log, đọc secret của chính service đó)
# và một task role (quyền của mã ứng dụng). App không gọi Secrets Manager hay KMS: secret đi vào container qua
# `secrets` của task definition, nên "đọc secret của mình" nằm ở execution role, task role không có quyền đó.
#
# | Role                      | Loại      | Dùng bởi                      |
# |---------------------------|-----------|-------------------------------|
# | dbs-dev-api-execution     | execution | dbs-api                       |
# | dbs-dev-api-task          | task      | dbs-api (không quyền nào)     |
# | dbs-dev-worker-execution  | execution | service worker (DBS-121)      |
# | dbs-dev-worker-task       | task      | service worker (DBS-121)      |
# | dbs-dev-migrate-execution | execution | dbs-migrate (không task role) |

locals {
  # Execution role: chỉ aws:SourceAccount (trang task execution role của ECS không nêu aws:SourceArn).
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

  # Task role: thêm aws:SourceArn theo khuyến nghị chống confused deputy của ECS (chỉ nhận dạng wildcard).
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

  # Kéo image dbs-api: GetAuthorizationToken không giới hạn được theo tài nguyên.
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

  # kms:Decrypt đúng CMK, chỉ khi Secrets Manager gọi thay (secret mã hóa bằng CMK alias/dbs-dev).
  decrypt_via_secrets_manager = {
    Effect    = "Allow"
    Action    = "kms:Decrypt"
    Resource  = local.base.kms_key_arn
    Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" } }
  }

  # Log group của worker do DBS-121 tạo ở base (cạnh /dbs/dev/api); lấy ARN từ output của base.
  worker_log_group_arn = local.base.worker_log_group_arn
}

# ---------- api ----------

resource "aws_iam_role" "execution" {
  name               = "dbs-dev-api-execution"
  assume_role_policy = local.ecs_execution_trust
}

# Policy theo từng tài nguyên thay cho AmazonECSTaskExecutionRolePolicy (cấp trên `*`).
# aws_cloudwatch_log_group.arn của provider 6 không có `:*`, nhưng action trên log stream cần nó.
resource "aws_iam_role_policy" "execution" {
  name = "pull-image-and-write-logs"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.pull_image_statements, [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${local.base.api_log_group_arn}:*"
      },
    ])
  })
}

# DBS-67: đọc đúng secret master do RDS quản lý. ARN secret đổi mỗi lần dựng lại RDS nên revision ECS của phiên
# cũ không dùng lại được.
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

# DBS-75: AUTH token của Valkey (cùng CMK, kms:Decrypt ở read-db-master-secret đã đủ).
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

# Không bao giờ có quyền nào, nhất là SQS (ADR-13: chỉ worker publish và consume). Queue policy ở base/sqs.tf
# chặn thêm theo tên role: đổi tên ở đây thì phải sửa ở đó. Không gắn policy hay attachment nào (TC-120-02).
resource "aws_iam_role" "task" {
  name               = "dbs-dev-api-task"
  assume_role_policy = local.ecs_task_trust
}

# ---------- worker (service do DBS-121 dựng) ----------

resource "aws_iam_role" "worker_execution" {
  name               = "dbs-dev-worker-execution"
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
        Resource = "${local.worker_log_group_arn}:*"
      },
    ])
  })
}

# Worker cần cùng hai secret với api (DATABASE_URL và REDIS_URL bắt buộc ở mọi APP_ROLE). Secret DB riêng của
# dbs_worker thay secret master ở BL-103.
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
          local.base.redis_auth_secret_arn,
        ]
      },
      local.decrypt_via_secrets_manager,
    ]
  })
}

# Quyền SQS: managed policy dbs-dev-worker-sqs ở base (DBS-73), đúng 2 queue và SendMessage vào 2 DLQ.
resource "aws_iam_role" "worker_task" {
  name               = "dbs-dev-worker-task"
  assume_role_policy = local.ecs_task_trust
}

resource "aws_iam_role_policy_attachment" "worker_sqs" {
  role       = aws_iam_role.worker_task.name
  policy_arn = local.base.worker_sqs_policy_arn
}

# ---------- migrate (dbs-migrate, không task role: migration không gọi API AWS) ----------

resource "aws_iam_role" "migrate_execution" {
  name               = "dbs-dev-migrate-execution"
  assume_role_policy = local.ecs_execution_trust
}

# Log về /dbs/dev/api, stream migrate/migrate/<task-id> (role deploy đọc migrate/*). CreateLogStream được kiểm
# theo ARN log group nên cấp trên cả group; PutLogEvents chỉ trên stream migrate/*.
resource "aws_iam_role_policy" "migrate_execution" {
  name = "pull-image-and-write-migrate-logs"
  role = aws_iam_role.migrate_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.pull_image_statements, [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream"]
        Resource = "${local.base.api_log_group_arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:PutLogEvents"]
        Resource = "${local.base.api_log_group_arn}:log-stream:migrate/*"
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
