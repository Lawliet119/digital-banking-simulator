output "vpc_id" {
  value = aws_vpc.main.id
}

output "vpc_cidr" {
  value = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "Theo thứ tự AZ."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Theo thứ tự AZ."
  value       = aws_subnet.private[*].id
}

output "public_route_table_id" {
  value = aws_route_table.public.id
}

output "private_route_table_id" {
  value = aws_route_table.private.id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "ecr_repository_arn" {
  value = aws_ecr_repository.api.arn
}

output "github_ecr_push_role_arn" {
  description = "Đặt vào biến repo GitHub AWS_ROLE_ARN (do chủ repo tạo)."
  value       = aws_iam_role.github_ecr_push.arn
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "api_security_group_id" {
  value = aws_security_group.api.id
}

output "api_log_group_name" {
  value = aws_cloudwatch_log_group.api.name
}

output "api_log_group_arn" {
  description = "Không có hậu tố `:*`; policy của task phải thêm `:*` cho các action trên log stream."
  value       = aws_cloudwatch_log_group.api.arn
}

# DBS-73: URL queue → biến môi trường của task worker (sqs.config.ts), đưa vào ở DBS-121:
# sqs_risk_queue_url → SQS_RISK_QUEUE_URL, sqs_notification_queue_url → SQS_NOTIFICATION_QUEUE_URL.
output "sqs_risk_queue_url" {
  value = aws_sqs_queue.main["risk"].url
}

output "sqs_notification_queue_url" {
  value = aws_sqs_queue.main["notification"].url
}

# Chưa có biến app tương ứng (bàn giao DBS-77/DBS-90: consumer gửi message sai schema vào DLQ).
output "sqs_risk_dlq_url" {
  value = aws_sqs_queue.dlq["risk"].url
}

output "sqs_notification_dlq_url" {
  value = aws_sqs_queue.dlq["notification"].url
}

output "sqs_queue_arns" {
  description = "Queue chính theo consumer (risk, notification)."
  value       = { for k, q in aws_sqs_queue.main : k => q.arn }
}

output "sqs_dlq_arns" {
  description = "DLQ theo consumer (risk, notification)."
  value       = { for k, q in aws_sqs_queue.dlq : k => q.arn }
}

output "sqs_dlq_names" {
  description = "Tên DLQ theo consumer, cho alarm DLQ > 0 (DBS-163)."
  value       = { for k, q in aws_sqs_queue.dlq : k => q.name }
}

output "worker_sqs_policy_arn" {
  description = "DBS-120 gắn vào role task worker."
  value       = aws_iam_policy.worker_sqs.arn
}
