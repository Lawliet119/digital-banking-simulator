# DBS-75: mạng của ElastiCache Valkey (ADR-10, ADR-12): private subnet, chỉ nhận 6379 từ task api.
# Ở `base` vì miễn phí; replication group nằm ở `session` (xóa hằng ngày).
resource "aws_elasticache_subnet_group" "main" {
  name       = "dbs-dev"
  subnet_ids = aws_subnet.private[*].id
}

# Không có luật egress nào: Valkey không cần chủ động đi ra.
resource "aws_security_group" "redis" {
  name        = "dbs-dev-redis"
  description = "ElastiCache Valkey of the dev api (ingress only from the api tasks)"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_api" {
  security_group_id            = aws_security_group.redis.id
  description                  = "Valkey from the api tasks only"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_egress_rule" "api_to_redis" {
  security_group_id            = aws_security_group.api.id
  description                  = "Valkey"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.redis.id
}
