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

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.app.id
}

output "cognito_issuer" {
  description = "Giá trị COGNITO_ISSUER của app."
  value       = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
}

output "kms_key_arn" {
  description = "CMK dùng chung của dev (alias/dbs-dev)."
  value       = aws_kms_key.main.arn
}

output "db_subnet_group_name" {
  value = aws_db_subnet_group.main.name
}

output "db_security_group_id" {
  value = aws_security_group.db.id
}

output "github_deploy_role_arn" {
  description = "Đặt vào biến repo GitHub AWS_DEPLOY_ROLE_ARN (do chủ repo tạo)."
  value       = aws_iam_role.github_deploy.arn
}
