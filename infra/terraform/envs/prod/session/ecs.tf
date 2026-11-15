resource "aws_ecs_cluster" "main" {
  name = "dbs-prod"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "dbs-prod-api"
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

    environment = local.api_environment

    secrets = [
      { name = "DB_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
      { name = "DB_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      { name = "REDIS_AUTH_TOKEN", valueFrom = aws_secretsmanager_secret.redis_auth.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "dbs-prod-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.migrate_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = "${local.base.ecr_repository_url}:${var.image_tag}"
    essential = true

    command = ["node", "./node_modules/typeorm/cli.js", "-d", "dist/database/data-source.js", "migration:run"]

    environment = local.migrate_environment

    secrets = [
      { name = "DB_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
      { name = "DB_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "migrate"
      }
    }
  }])
}

# Lăn api:
# - desired_count <= 2: tối thiểu khỏe 100%, tối đa 200% (luôn còn 2 task phục vụ trên 2 AZ;
#   đỉnh 4 api + 2 worker = 6 task = 65 kết nối).
# - desired_count > 2 (3..4): 50% / 100% như dev (BL-234) để không vượt ngưỡng kết nối DB.
resource "aws_ecs_service" "api" {
  name                               = "api"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  propagate_tags                     = "TASK_DEFINITION"
  health_check_grace_period_seconds  = 60
  deployment_maximum_percent         = var.desired_count <= 2 ? 200 : 100
  deployment_minimum_healthy_percent = var.desired_count <= 2 ? 100 : 50

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

  depends_on = [aws_lb_listener.https]
}
