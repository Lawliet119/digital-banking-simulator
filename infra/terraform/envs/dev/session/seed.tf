# BL-252: seed dữ liệu demo bằng task ECS chạy một lần trong VPC (infra/scripts/seed-cloud.sh), không đi qua ALB.
# ALB dev dùng chứng chỉ tự ký nên Node từ chối TLS; task trong VPC gọi thẳng task api qua HTTP cổng 3000. Mạng:
# SG `dbs-dev-seed` ở base/seed_task.tf (không ingress; chỉ ra 443 và tới SG api ở 3000).
#
# Script đăng ký revision mới (chỉ đổi image, như dbs-migrate) rồi `run-task`, ghi đè `command` (có --url của task
# api) và `environment` (DBS_*_TOKEN, token Cognito sống 15 phút). Revision Terraform chỉ là khuôn: lệnh mặc định
# `--help` không làm gì. Không `secrets`, không task role: container không cần credential AWS. Điểm vào
# `seed-cloud.js` chỉ có đường `--auth cloud` và không mang công cụ ký token (backend/src/scripts/seed-cloud.ts).

resource "aws_iam_role" "seed_execution" {
  name               = "dbs-dev-seed-execution"
  assume_role_policy = local.ecs_execution_trust
}

# Execution role tối thiểu: kéo image và ghi log, KHÔNG đọc secret nào (task seed không có `secrets`). Token demo đi
# vào container bằng `containerOverrides.environment` của run-task, không qua IAM. Log về /dbs/dev/api, stream
# seed/seed/<task-id>. CreateLogStream được kiểm theo ARN log group nên cấp trên cả group; PutLogEvents chỉ trên
# stream seed/*.
resource "aws_iam_role_policy" "seed_execution" {
  name = "pull-image-and-write-seed-logs"
  role = aws_iam_role.seed_execution.id

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
        Resource = "${local.base.api_log_group_arn}:log-stream:seed/*"
      },
    ])
  })
}

resource "aws_ecs_task_definition" "seed" {
  family                   = "dbs-seed"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.seed_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "seed"
    image     = "${local.base.ecr_repository_url}:${var.image_tag}"
    essential = true

    command = ["node", "dist/scripts/seed-cloud.js", "--help"]

    environment = [
      { name = "NODE_ENV", value = var.node_env },
    ]

    # Stream thực tế: seed/seed/<task-id>.
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = local.base.api_log_group_name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "seed"
      }
    }
  }])
}
