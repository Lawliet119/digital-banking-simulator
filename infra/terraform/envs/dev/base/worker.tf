# DBS-121 (BL-119, BL-242): phần của service worker (APP_ROLE=worker) nằm ở `base`: log group và security group.
# Service và task definition nằm ở `session` (xóa hằng ngày).

# Log của task worker. Giữ lại như /dbs/dev/api khi `destroy session`; execution role worker ở `session/iam.tf`
# ghi vào group này (ARN lấy từ output, không dựng theo tên).
resource "aws_cloudwatch_log_group" "worker" {
  name              = "/dbs/dev/worker"
  retention_in_days = 7
}

# Security group của task worker (ADR-10, ADR-13). Worker không mở cổng HTTP nên SG không có luật ingress nào;
# ECS thay task khi tiến trình thoát (docs/03 §13.3), không cần ALB. SG db và redis chỉ nhận từ SG api và SG worker.
# `description` của SG db và redis ("ingress only from the api tasks") cố ý không sửa: description là ForceNew,
# sửa sẽ thay SG và RDS/Valkey mất SG.
resource "aws_security_group" "worker" {
  name        = "dbs-dev-worker"
  description = "Fargate tasks of the dev worker (no ingress at all)"
  vpc_id      = aws_vpc.main.id
}

# Task ở public subnet, không NAT: ECR, CloudWatch Logs, SQS, Secrets Manager qua 443.
resource "aws_vpc_security_group_egress_rule" "worker_https" {
  security_group_id = aws_security_group.worker.id
  description       = "HTTPS to AWS APIs (ECR, logs, SQS, Secrets Manager)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "worker_to_db" {
  security_group_id            = aws_security_group.worker.id
  description                  = "PostgreSQL to the database"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.db.id
}

resource "aws_vpc_security_group_egress_rule" "worker_to_redis" {
  security_group_id            = aws_security_group.worker.id
  description                  = "Valkey"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.redis.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_worker" {
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from the worker tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.worker.id
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_worker" {
  security_group_id            = aws_security_group.redis.id
  description                  = "Valkey from the worker tasks"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.worker.id
}

output "worker_security_group_id" {
  value = aws_security_group.worker.id
}

output "worker_log_group_name" {
  value = aws_cloudwatch_log_group.worker.name
}

output "worker_log_group_arn" {
  description = "ARN không có hậu tố :* (execution role worker thêm :* cho action trên stream)."
  value       = aws_cloudwatch_log_group.worker.arn
}
