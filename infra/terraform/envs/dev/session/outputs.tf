output "vpc_id" {
  value = local.base.vpc_id
}

output "dashboard_name" {
  description = "Dashboard CloudWatch của dev (DBS-145)."
  value       = aws_cloudwatch_dashboard.overview.dashboard_name
}

output "dashboard_url" {
  description = "Đường dẫn console tới dashboard."
  value       = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.overview.dashboard_name}"
}

output "infra_dashboard_name" {
  description = "Dashboard hạ tầng ECS, ALB, RDS, Valkey (BL-261)."
  value       = aws_cloudwatch_dashboard.infra.dashboard_name
}

output "infra_dashboard_url" {
  description = "Đường dẫn console tới dashboard hạ tầng."
  value       = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.infra.dashboard_name}"
}

output "public_subnet_ids" {
  value = local.base.public_subnet_ids
}

output "private_subnet_ids" {
  value = local.base.private_subnet_ids
}

output "alb_dns_name" {
  description = "Địa chỉ ALB (đổi sau mỗi lần dựng). Chứng chỉ self-signed: dùng curl -k."
  value       = aws_lb.main.dns_name
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "service_name" {
  value = aws_ecs_service.api.name
}

output "target_group_arn" {
  value = aws_lb_target_group.api.arn
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.api.arn
}

output "db_instance_id" {
  value = aws_db_instance.main.identifier
}

output "db_address" {
  description = "Hostname của RDS (không kèm port)."
  value       = aws_db_instance.main.address
}

output "db_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "db_multi_az" {
  description = "RDS đang cấu hình Multi-AZ (true = có standby, chi phí DB ≈ gấp đôi; chỉ bật khi diễn tập HA, README Terraform mục DBS-180)."
  value       = aws_db_instance.main.multi_az
}

output "db_port" {
  value = aws_db_instance.main.port
}

output "db_master_secret_arn" {
  description = "Secret mật khẩu master do RDS quản lý (DBS-67, DBS-68 đọc để tạo DB role và DATABASE_URL)."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "redis_replication_group_id" {
  description = "Cho alarm Redis không truy cập được (docs/03 §14)."
  value       = aws_elasticache_replication_group.main.id
}

# DBS-120 → DBS-121: role của service worker (task role có policy SQS của base; execution role đọc secret DB và
# Redis, ghi log vào /dbs/dev/worker).
output "worker_task_role_arn" {
  value = aws_iam_role.worker_task.arn
}

output "worker_execution_role_arn" {
  value = aws_iam_role.worker_execution.arn
}
