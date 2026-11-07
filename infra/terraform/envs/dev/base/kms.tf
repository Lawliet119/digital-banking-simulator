# DBS-66: CMK dùng chung cho dev (RDS, secret master do RDS quản lý; Secrets, SQS, ElastiCache dùng lại).
# Key policy mặc định có statement cho root nên IAM grant (ví dụ kms:Decrypt cho execution role ở DBS-67) hoạt động.
# Xóa key phải chờ 7 ngày (teardown DBS-208): lên lịch từ trước.
resource "aws_kms_key" "main" {
  description             = "dbs dev: RDS storage and managed master secret"
  enable_key_rotation     = true
  deletion_window_in_days = 7
}

resource "aws_kms_alias" "main" {
  name          = "alias/dbs-dev"
  target_key_id = aws_kms_key.main.key_id
}
