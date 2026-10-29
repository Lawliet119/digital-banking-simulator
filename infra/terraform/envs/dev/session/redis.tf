# DBS-75, ADR-12: Valkey trên ElastiCache, node cố định, cluster mode tắt, TLS bắt buộc và AUTH token.
# Ở `session` nên dựng và xóa cùng RDS, ALB, ECS. Không snapshot: Redis không giữ dữ liệu gốc (P-1).

# Token sinh mới mỗi lần resource được tạo, chỉ đi qua thuộc tính write-only nên không vào state
# nào. Hai nơi nhận cùng một giá trị trong cùng một lần apply.
ephemeral "random_password" "redis_auth" {
  # Quy tắc AUTH của ElastiCache: 16–128 ký tự in được, không @, ", / hay khoảng trắng.
  length  = 64
  special = false
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "dbs-dev"
  description          = "dbs dev Valkey: rate limit, revocation cache, fraud counters, config cache"

  engine               = "valkey"
  engine_version       = "8.0"
  parameter_group_name = "default.valkey8"
  node_type            = var.redis_node_type
  port                 = 6379

  num_cache_clusters         = 1 + var.redis_replicas
  automatic_failover_enabled = var.redis_replicas > 0
  multi_az_enabled           = var.redis_replicas > 0

  subnet_group_name  = local.base.redis_subnet_group_name
  security_group_ids = [local.base.redis_security_group_id]

  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  at_rest_encryption_enabled = "true"
  kms_key_id                 = local.base.kms_key_arn

  auth_token_wo              = ephemeral.random_password.redis_auth.result
  auth_token_wo_version      = var.redis_auth_version
  auth_token_update_strategy = "ROTATE"

  snapshot_retention_limit = 0
  apply_immediately        = true
}

# Ghi token vào vỏ secret ở base cho task api đọc. Valkey tạo lại (taint, thuộc tính force-new) thì
# version này cũng thay trong cùng lần apply, nên hai bên không lệch nhau. Lệch vì lỗi giữa chừng:
# tăng redis_auth_version (README Terraform).
resource "aws_secretsmanager_secret_version" "redis_auth" {
  secret_id                = local.base.redis_auth_secret_arn
  secret_string_wo         = ephemeral.random_password.redis_auth.result
  secret_string_wo_version = var.redis_auth_version

  lifecycle {
    replace_triggered_by = [aws_elasticache_replication_group.main.id]
  }
}
