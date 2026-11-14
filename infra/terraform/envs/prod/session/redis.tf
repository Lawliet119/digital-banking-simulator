# Valkey production (ADR-12): 1 primary + 1 replica ghim ở 2 AZ khác nhau, failover tự động, Multi-AZ,
# TLS bắt buộc và AUTH token sinh mỗi phiên (write-only, không vào state).
ephemeral "random_password" "redis_auth" {
  length  = 64
  special = false
}

# recovery_window_in_days = 0 để hủy và dựng lại session không vướng tên đang chờ xóa 30 ngày.
resource "aws_secretsmanager_secret" "redis_auth" {
  name                    = "dbs/prod/redis-auth"
  description             = "AUTH token of the prod Valkey; written by envs/prod/session on each apply"
  kms_key_id              = local.base.kms_key_arn
  recovery_window_in_days = 0
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "dbs-prod"
  description          = "dbs prod Valkey: rate limit, revocation cache, fraud counters, config cache"

  engine               = "valkey"
  engine_version       = "8.0"
  parameter_group_name = "default.valkey8"
  node_type            = var.redis_node_type
  port                 = 6379

  num_cache_clusters          = 2
  preferred_cache_cluster_azs = [for s in data.aws_subnet.private : s.availability_zone]
  automatic_failover_enabled  = true
  multi_az_enabled            = true

  subnet_group_name  = local.base.redis_subnet_group_name
  security_group_ids = [local.base.redis_security_group_id]

  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  at_rest_encryption_enabled = true
  kms_key_id                 = local.base.kms_key_arn

  auth_token_wo              = ephemeral.random_password.redis_auth.result
  auth_token_wo_version      = var.redis_auth_version
  auth_token_update_strategy = "ROTATE"

  snapshot_retention_limit = 0
  apply_immediately        = true

  # Fail-fast nếu certificate_arn không hợp lệ trên AWS trước khi dựng tài nguyên tốn tiền.
  depends_on = [aws_lb_listener.https]
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  secret_id                = aws_secretsmanager_secret.redis_auth.id
  secret_string_wo         = ephemeral.random_password.redis_auth.result
  secret_string_wo_version = var.redis_auth_version

  lifecycle {
    replace_triggered_by = [aws_elasticache_replication_group.main.id]
  }
}
