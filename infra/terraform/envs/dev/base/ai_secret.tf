# RSK-03 (ADR-14): vỏ secret khóa API OpenAI cho risk worker. Giá trị thật (raw string `sk-...`,
# không bọc JSON) do người vận hành nạp ngoài băng bằng `aws secretsmanager put-secret-value`,
# nên state Terraform không bao giờ chứa khóa. Giữ vỏ ở base để ARN cố định qua destroy session;
# recovery 0 để xóa base rồi dựng lại không vướng tên trùng (dev).
resource "aws_secretsmanager_secret" "openai_api_key" {
  name                    = "dbs/dev/openai-api-key"
  description             = "OpenAI API key for the dev risk worker (ADR-14, RSK-03); set out-of-band as a raw string"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 0
}
