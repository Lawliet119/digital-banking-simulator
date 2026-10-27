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
