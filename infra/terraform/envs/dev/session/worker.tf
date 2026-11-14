# DBS-121: service worker (APP_ROLE=worker) trên ECS, cùng image và cluster với api (ADR-13). Thuộc nhóm «xóa hằng
# ngày» (stack session). Log group và security group nằm ở `base` (worker.tf của base).
#
# Sức khỏe (ADR-13, docs/03 §13.3, Dockerfile cố ý không có HEALTHCHECK): worker không có cổng HTTP, nên không có
# healthCheck của container và không có load balancer. Container `essential`: tiến trình thoát (lỗi khởi động ra
# exit 1 ở main.ts, hoặc bị kill) thì ECS chạy task mới. Worker treo phát hiện qua alarm tuổi outbox và tuổi
# message (BL-161), không qua ECS.

variable "worker_desired_count" {
  description = "Số task worker. Mặc định 0 (như api: chưa chạy được khi thiếu DB, Valkey, image). Tối đa 2 (docs/03 mục 13.1); tổng với api không quá 6 (74 kết nối dùng được của db.t4g.micro, số task × 10 + 5, docs/03 mục 13.2)."
  type        = number
  default     = 0

  validation {
    condition     = var.worker_desired_count >= 0 && var.worker_desired_count <= 2
    error_message = "worker_desired_count must be between 0 and 2 (docs/03 section 13.1)."
  }

  validation {
    condition     = var.desired_count + var.worker_desired_count <= 6
    error_message = "desired_count + worker_desired_count must not exceed 6 (connection pool limit, docs/03 section 13.2)."
  }
}

# DBS-123: chu kỳ job đối soát sổ cái. Mặc định của ứng dụng là 300 s: lệch xảy ra ngay sau một lần chạy thì lần chạy
# kế tới sau 300 s, cộng ≤ 60 s ghi metric và chu kỳ đánh giá alarm, vượt 5 phút của DoD. 60 s: ≤ 60 + 60 + 60 s. Mỗi lần
# chạy là một truy vấn đọc đọc toàn bộ ledger_entries; dev chỉ vài nghìn dòng nên chấp nhận được, production đặt lại.
variable "reconciliation_interval_ms" {
  description = "Chu kỳ job đối soát sổ cái của worker (RECONCILIATION_INTERVAL_MS). 10 s đến 300 s; 300 s là mặc định của ứng dụng và làm alarm trễ hơn 5 phút."
  type        = number
  default     = 60000

  validation {
    condition     = var.reconciliation_interval_ms >= 10000 && var.reconciliation_interval_ms <= 300000
    error_message = "reconciliation_interval_ms must be between 10000 and 300000 (DBS-123: the alarm must fire within 5 minutes)."
  }
}

# Biến môi trường không bí mật. TRUST_PROXY_HOPS và COGNITO_* chỉ để qua kiểm tra cấu hình (validation.schema.ts bắt
# buộc ở staging/production với mọi role), worker không có HTTP. Không đặt SQS_ENDPOINT (AWS thật) và không có PORT.
# DB_USER, DB_PASSWORD, REDIS_AUTH_TOKEN đi qua `secrets`; ECS đọc bằng execution role worker (iam.tf).
resource "aws_ecs_task_definition" "worker" {
  family                   = "dbs-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.worker_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "worker"
    image     = "${local.base.ecr_repository_url}:${var.image_tag}"
    essential = true

    # Một lô relay có thể tới 25 s (BL-182); mặc định 30 s không chừa chỗ cho consumer đang xử lý.
    stopTimeout = 60

    environment = [
      { name = "NODE_ENV", value = var.node_env },
      { name = "APP_ROLE", value = "worker" },
      { name = "TRUST_PROXY_HOPS", value = "1" },
      { name = "AWS_REGION", value = var.region },
      { name = "LOG_LEVEL", value = "log" },
      { name = "COGNITO_USER_POOL_ID", value = local.base.cognito_user_pool_id },
      { name = "COGNITO_CLIENT_ID", value = local.base.cognito_client_id },
      { name = "COGNITO_ISSUER", value = local.base.cognito_issuer },
      { name = "DB_HOST", value = aws_db_instance.main.address },
      { name = "DB_PORT", value = "5432" },
      { name = "DB_NAME", value = "dbs" },
      { name = "DATABASE_SSL", value = "true" },
      { name = "DATABASE_SSL_CA_PATH", value = "/etc/ssl/rds/global-bundle.pem" },
      { name = "REDIS_HOST", value = aws_elasticache_replication_group.main.primary_endpoint_address },
      { name = "REDIS_PORT", value = "6379" },
      # BL-114: URL hai queue từ output của base (DBS-73).
      { name = "SQS_RISK_QUEUE_URL", value = local.base.sqs_risk_queue_url },
      { name = "SQS_NOTIFICATION_QUEUE_URL", value = local.base.sqs_notification_queue_url },
      # DBS-123: job đối soát mỗi 60 s để MISMATCH tới alarm trong 5 phút.
      { name = "RECONCILIATION_INTERVAL_MS", value = tostring(var.reconciliation_interval_ms) },
    ]

    secrets = [
      { name = "DB_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
      { name = "DB_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      { name = "REDIS_AUTH_TOKEN", valueFrom = local.base.redis_auth_secret_arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = local.base.worker_log_group_name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])
}

# BL-248: deploy.sh đăng ký revision mới của dbs-worker (chỉ đổi image) và đổi task_definition của service này sau khi
# api đã khỏe, như với api (ecs.tf); Terraform không kéo về revision cũ nên có ignore_changes. Lần dựng phiên đầu vẫn
# theo `image_tag`. Lăn 0%/100%: không bao giờ hai worker song song nhân đôi kết nối; khoảng trống xử lý ngắn chấp nhận
# được vì outbox giữ sự kiện (ADR-03).
resource "aws_ecs_service" "worker" {
  name                               = "worker"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = var.worker_desired_count
  launch_type                        = "FARGATE"
  propagate_tags                     = "TASK_DEFINITION"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.base.public_subnet_ids
    security_groups  = [local.base.worker_security_group_id]
    assign_public_ip = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "worker_task_definition_arn" {
  value = aws_ecs_task_definition.worker.arn
}
