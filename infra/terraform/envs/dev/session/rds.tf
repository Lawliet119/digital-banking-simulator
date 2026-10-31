# DBS-66: RDS PostgreSQL 17 cho dev (ADR-10, ADR-11). Nhóm xóa hằng ngày: không snapshot cuối, xóa cả backup
# tự động và không bảo vệ xóa, nên `destroy` đưa chi phí về ≈ 0. Dữ liệu dev mất mỗi lần destroy (seed lại: DBS-68).
resource "aws_db_parameter_group" "postgres17" {
  name   = "dbs-dev-postgres17"
  family = "postgres17"

  # PG 15+ đã mặc định force_ssl = 1 và timezone UTC; đặt tường minh để không phụ thuộc mặc định của AWS.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "timezone"
    value = "UTC"
  }
}

resource "aws_db_instance" "main" {
  identifier     = "dbs-dev"
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.db_instance_class
  multi_az       = var.db_multi_az

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true
  kms_key_id        = local.base.kms_key_arn

  db_name  = "dbs"
  username = "dbs_master"
  port     = 5432

  # Mật khẩu master do RDS tạo và xoay trong Secrets Manager (mã hóa bằng CMK); không vào state hay biến.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = local.base.kms_key_arn

  db_subnet_group_name   = local.base.db_subnet_group_name
  vpc_security_group_ids = [local.base.db_security_group_id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.postgres17.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period  = 1
  skip_final_snapshot      = true
  delete_automated_backups = true
  deletion_protection      = false
  apply_immediately        = true

  auto_minor_version_upgrade   = true
  performance_insights_enabled = false
  monitoring_interval          = 0
}
