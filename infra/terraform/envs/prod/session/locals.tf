locals {
  tags = {
    project = "dbs"
    env     = "prod"
    owner   = "platform"
  }

  base = data.terraform_remote_state.base.outputs

  # Tách biến môi trường không bí mật ra locals để dùng chung cho container_definitions
  # và output có cấu trúc `container_environment` (check-prod-config.mjs đọc ở plan JSON).
  # NODE_ENV cố định "production" (staging vẫn bật Swagger ở main.ts).
  api_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "APP_ROLE", value = "api" },
    { name = "TRUST_PROXY_HOPS", value = "1" },
    { name = "PORT", value = "3000" },
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
  ]

  worker_environment = [
    { name = "NODE_ENV", value = "production" },
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
    { name = "SQS_RISK_QUEUE_URL", value = aws_sqs_queue.main["risk"].url },
    { name = "SQS_NOTIFICATION_QUEUE_URL", value = aws_sqs_queue.main["notification"].url },
  ]

  migrate_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "AWS_REGION", value = var.region },
    { name = "DB_HOST", value = aws_db_instance.main.address },
    { name = "DB_PORT", value = "5432" },
    { name = "DB_NAME", value = "dbs" },
    { name = "DATABASE_SSL", value = "true" },
    { name = "DATABASE_SSL_CA_PATH", value = "/etc/ssl/rds/global-bundle.pem" },
  ]
}
