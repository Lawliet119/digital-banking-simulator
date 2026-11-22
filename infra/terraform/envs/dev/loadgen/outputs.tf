output "instance_id" {
  description = "EC2 chạy k6 (đích của SSM Run Command)."
  value       = aws_instance.loadgen.id
}

output "public_ip" {
  description = "IP công khai của máy tải: truyền cho session qua -var 'waf_rate_limit_exempt_cidrs=[\"<ip>/32\"]' (BL-292)."
  value       = aws_instance.loadgen.public_ip
}

output "cognito_client_id" {
  description = "Client Cognito tạm (token 240 phút): đặt COGNITO_CLIENT_ID của api và của loadgen-tokens.mjs theo giá trị này."
  value       = aws_cognito_user_pool_client.loadgen.id
}

output "bucket" {
  description = "Bucket tạm nhận mã nguồn và kết quả đo."
  value       = aws_s3_bucket.loadgen.bucket
}

output "redis_fault_nacl_id" {
  description = "NACL dbs-dev-private-fault (redis_fault_enabled=true): đặt vào run.env là REDIS_FAULT_NACL_ID. Rỗng khi tắt."
  value       = try(aws_network_acl.redis_fault[0].id, "")
}

output "redis_fault_deny_cidrs" {
  description = "CIDR của các public subnet (nơi api, worker và máy tải chạy): redis-fault.sh deny 6379 từ các CIDR này (REDIS_FAULT_DENY_CIDRS, phân cách bằng dấu phẩy). Rỗng khi tắt."
  value       = join(",", distinct(sort([for s in data.aws_subnet.public : s.cidr_block])))
}

output "redis_auth_secret_arn" {
  description = "Secret AUTH token của Valkey (REDIS_AUTH_SECRET_ID của run.env). Rỗng khi tắt."
  value       = var.redis_fault_enabled ? local.base.redis_auth_secret_arn : ""
}
