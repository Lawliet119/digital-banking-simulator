output "vpc_id" {
  value = local.base.vpc_id
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

output "db_port" {
  value = aws_db_instance.main.port
}

output "db_master_secret_arn" {
  description = "Secret mật khẩu master do RDS quản lý (DBS-67, DBS-68 đọc để tạo DB role và DATABASE_URL)."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}
