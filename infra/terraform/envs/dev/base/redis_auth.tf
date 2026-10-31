# DBS-75: vỏ secret AUTH token của Valkey (ADR-12). Giá trị do `session` ghi khi dựng (write-only,
# token sinh mới mỗi phiên), nên state của base không bao giờ có token. Giữ vỏ ở base để tên cố định;
# recovery 0 để xóa base rồi dựng lại không vướng tên trùng (dev).
resource "aws_secretsmanager_secret" "redis_auth" {
  name                    = "dbs/dev/redis-auth"
  description             = "AUTH token of the dev Valkey; written by envs/dev/session on each apply"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 0
}
