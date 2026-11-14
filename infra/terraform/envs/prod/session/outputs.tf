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
  description = "Địa chỉ ALB production."
  value       = aws_lb.main.dns_name
}

output "certificate_arn" {
  description = "ARN chứng chỉ ACM gắn trên listener HTTPS."
  value       = var.certificate_arn
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

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "worker_task_definition_arn" {
  value = aws_ecs_task_definition.worker.arn
}

output "worker_task_role_arn" {
  value = aws_iam_role.worker_task.arn
}

output "worker_execution_role_arn" {
  value = aws_iam_role.worker_execution.arn
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
  value = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "redis_replication_group_id" {
  value = aws_elasticache_replication_group.main.id
}

output "redis_auth_secret_arn" {
  value = aws_secretsmanager_secret.redis_auth.arn
}

output "sqs_risk_queue_url" {
  value = aws_sqs_queue.main["risk"].url
}

output "sqs_notification_queue_url" {
  value = aws_sqs_queue.main["notification"].url
}

output "sqs_risk_dlq_url" {
  value = aws_sqs_queue.dlq["risk"].url
}

output "sqs_notification_dlq_url" {
  value = aws_sqs_queue.dlq["notification"].url
}

output "container_environment" {
  description = "Biến môi trường không bí mật của api, worker, migrate (dùng cho check-prod-config.mjs)."
  value = {
    api     = local.api_environment
    worker  = local.worker_environment
    migrate = local.migrate_environment
  }
}
