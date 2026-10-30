resource "aws_ecs_cluster" "main" {
  name = "dbs-dev"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

# Chỉ biến môi trường không bí mật (COGNITO_* là định danh công khai, không phải bí mật).
# DATABASE_URL, REDIS_URL … do DBS-66, 67 và task ElastiCache thêm (bí mật qua `secrets`, không viết
# thẳng). Thiếu chúng thì app staging từ chối khởi động, nên desired_count mặc định 0.
resource "aws_ecs_task_definition" "api" {
  family                   = "dbs-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "api"
    image     = "${local.base.ecr_repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{ containerPort = 3000, protocol = "tcp" }]

    environment = [
      { name = "NODE_ENV", value = var.node_env },
      { name = "APP_ROLE", value = "api" },
      { name = "TRUST_PROXY_HOPS", value = "1" },
      { name = "PORT", value = "3000" },
      { name = "AWS_REGION", value = var.region },
      { name = "LOG_LEVEL", value = "log" },
      { name = "COGNITO_USER_POOL_ID", value = local.base.cognito_user_pool_id },
      { name = "COGNITO_CLIENT_ID", value = local.base.cognito_client_id },
      { name = "COGNITO_ISSUER", value = local.base.cognito_issuer },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = local.base.api_log_group_name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name                              = "api"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60

  # deploy.sh (DBS-38) đăng ký revision mới và đổi task_definition của service; Terraform không kéo về.
  lifecycle {
    ignore_changes = [task_definition]
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.base.public_subnet_ids
    security_groups  = [local.base.api_security_group_id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  # ECS từ chối tạo service khi target group chưa gắn với listener nào.
  depends_on = [aws_lb_listener.https]
}
