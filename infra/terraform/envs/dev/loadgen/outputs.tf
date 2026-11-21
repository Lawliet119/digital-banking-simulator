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
