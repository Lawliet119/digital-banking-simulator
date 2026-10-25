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
