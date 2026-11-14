# BL-103: mỗi thành phần nối RDS bằng role DB riêng (DBS-119), không dùng credential master.
#
#   api -> dbs_api   worker -> dbs_worker   dbs-migrate -> dbs_migrator   dbs-db-roles -> master (chỉ task này)
#
# Mật khẩu của ba role sinh bằng `ephemeral random_password` (không vào state, cùng cách với token Valkey ở
# redis.tf) rồi ghi vào secret Secrets Manager bằng thuộc tính write-only. Mỗi secret là JSON
# {"username":"dbs_api","password":"..."} để ECS đọc từng khóa (`<arn>:username::`, `<arn>:password::`), đúng
# như secret master của RDS: app vẫn chỉ ghép DB_USER và DB_PASSWORD thành DATABASE_URL (env.bootstrap).
#
# Vì sao ephemeral thay `random_password` thường: `random_password` lưu `result` vào state (dù state mã hóa ở
# S3), còn ephemeral + `secret_string_wo` thì mật khẩu không bao giờ nằm trong state hay plan. Provider aws
# >= 6.70 đã hỗ trợ (redis.tf dùng sẵn), nên không phải đánh đổi gì. Hệ quả: Terraform không đọc lại được giá
# trị; đổi mật khẩu = tăng `db_role_password_version`, rồi chạy lại infra/scripts/db-roles.sh để DB nhận mật
# khẩu mới và khởi động lại task api/worker.
#
# Secret nằm ở `session` (không phải `base`): dựng và xóa cùng RDS, và `recovery_window_in_days = 0` để dựng lại
# cùng tên ngay hôm sau. ARN có hậu tố ngẫu nhiên đổi mỗi phiên, nên revision task cũ không dùng lại được sau
# `destroy` (như secret master).
#
# Role trong DB chưa có LOGIN và mật khẩu khi apply xong: một lần mỗi database, trước migration đầu tiên, chạy
# `AWS_PROFILE=dbs-admin bash infra/scripts/db-roles.sh` (task `dbs-db-roles` bên dưới). Chưa chạy thì task api,
# worker, dbs-migrate nối DB bị từ chối "password authentication failed".

locals {
  # Khóa là tên ngắn dùng trong tên secret và trong tài nguyên; giá trị là tên role trong PostgreSQL.
  db_roles = {
    api      = "dbs_api"
    worker   = "dbs_worker"
    migrator = "dbs_migrator"
  }
}

variable "db_role_password_version" {
  description = "Tăng (1, 2, 3, ...) để sinh mật khẩu mới cho cả ba role DB. Sau đó chạy infra/scripts/db-roles.sh và khởi động lại task api, worker (README Terraform)."
  type        = number
  default     = 1

  validation {
    condition     = var.db_role_password_version >= 1 && floor(var.db_role_password_version) == var.db_role_password_version
    error_message = "db_role_password_version must be a positive integer."
  }
}

# Chỉ chữ và số: an toàn trong URL, trong SQL và trong JSON. 32 ký tự ≈ 190 bit.
ephemeral "random_password" "db_role" {
  for_each = local.db_roles

  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "db_role" {
  for_each = local.db_roles

  name                    = "dbs/dev/db-${each.key}"
  description             = "Login of the PostgreSQL role ${each.value} (BL-103); written by envs/dev/session, password applied by infra/scripts/db-roles.sh"
  kms_key_id              = local.base.kms_key_arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db_role" {
  for_each = local.db_roles

  secret_id = aws_secretsmanager_secret.db_role[each.key].id
  secret_string_wo = jsonencode({
    username = each.value
    password = ephemeral.random_password.db_role[each.key].result
  })
  secret_string_wo_version = var.db_role_password_version
}

# ---------- dbs-db-roles: task chạy một lần, duy nhất đọc secret master ----------

resource "aws_iam_role" "db_roles_execution" {
  name               = "dbs-dev-db-roles-execution"
  assume_role_policy = local.ecs_execution_trust
}

# Log về /dbs/dev/api, stream db-roles/db-roles/<task-id>. CreateLogStream được kiểm theo ARN log group nên cấp
# trên cả group; PutLogEvents chỉ trên stream db-roles/*.
resource "aws_iam_role_policy" "db_roles_execution" {
  name = "pull-image-and-write-db-roles-logs"
  role = aws_iam_role.db_roles_execution.id

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
        Resource = "${local.base.api_log_group_arn}:log-stream:db-roles/*"
      },
    ])
  })
}

# Secret master (đăng nhập để tạo role và đặt mật khẩu) và ba secret role (mật khẩu cần đặt). Nơi duy nhất của
# session còn đọc secret master.
resource "aws_iam_role_policy" "db_roles_read_secrets" {
  name = "read-db-master-and-role-secrets"
  role = aws_iam_role.db_roles_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        Resource = concat(
          [aws_db_instance.main.master_user_secret[0].secret_arn],
          [for key in keys(local.db_roles) : aws_secretsmanager_secret.db_role[key].arn],
        )
      },
      local.decrypt_via_secrets_manager,
    ]
  })
}

# Không có task role: script chỉ nói chuyện với PostgreSQL, container không cần credential AWS. Lệnh cố định và
# mật khẩu chỉ đi bằng `secrets` (db-roles.sh không ghi đè `containerOverrides`, nên không mật khẩu nào hiện trong
# `describe-tasks` hay CloudTrail). Mạng của task = mạng của service api (SG này đã được RDS cho vào cổng 5432).
resource "aws_ecs_task_definition" "db_roles" {
  family                   = "dbs-db-roles"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.db_roles_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "db-roles"
    image     = "${local.base.ecr_repository_url}:${var.image_tag}"
    essential = true

    command = ["node", "dist/scripts/provision-db-roles.main.js"]

    environment = [
      { name = "NODE_ENV", value = var.node_env },
      { name = "AWS_REGION", value = var.region },
      { name = "DB_HOST", value = aws_db_instance.main.address },
      { name = "DB_PORT", value = "5432" },
      { name = "DB_NAME", value = "dbs" },
      { name = "DATABASE_SSL", value = "true" },
      { name = "DATABASE_SSL_CA_PATH", value = "/etc/ssl/rds/global-bundle.pem" },
    ]

    secrets = [
      # Master: chỉ để đăng nhập và chạy CREATE/ALTER ROLE.
      { name = "DB_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
      { name = "DB_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      { name = "DBS_API_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db_role["api"].arn}:password::" },
      { name = "DBS_WORKER_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db_role["worker"].arn}:password::" },
      { name = "DBS_MIGRATOR_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db_role["migrator"].arn}:password::" },
    ]

    # Stream thực tế: db-roles/db-roles/<task-id>.
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = local.base.api_log_group_name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "db-roles"
      }
    }
  }])

  depends_on = [aws_secretsmanager_secret_version.db_role]
}

output "db_role_secret_arns" {
  description = "ARN secret login của từng role DB (BL-103): api, worker, migrator."
  value       = { for key in keys(local.db_roles) : key => aws_secretsmanager_secret.db_role[key].arn }
}

output "db_roles_task_definition_arn" {
  description = "Task one-off tạo LOGIN và mật khẩu cho ba role DB (infra/scripts/db-roles.sh)."
  value       = aws_ecs_task_definition.db_roles.arn
}
