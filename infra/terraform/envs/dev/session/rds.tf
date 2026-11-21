# DBS-66: RDS PostgreSQL 17 cho dev (ADR-10, ADR-11). Nhóm xóa hằng ngày: không snapshot cuối, xóa cả backup
# tự động và không bảo vệ xóa, nên `destroy` đưa chi phí về ≈ 0. Dữ liệu dev mất mỗi lần destroy (seed lại: DBS-68).
resource "aws_db_parameter_group" "postgres17" {
  name   = "dbs-dev-postgres17"
  family = "postgres17"

  # PG 15+ đã mặc định force_ssl = 1 và timezone UTC; đặt tường minh để không phụ thuộc mặc định của AWS.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "timezone"
    value        = "UTC"
    apply_method = "pending-reboot"
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

# BL-324: nhắc tắt Multi-AZ. Multi-AZ chỉ bật khi diễn tập failover (DBS-181); quên tắt tốn ≈ +0,72 USD/ngày. Check này cảnh báo (không chặn)
# ở mọi `terraform plan`/`apply` còn `db_multi_az = true`. Giới hạn: check đọc biến, không đọc trạng thái RDS thật; plan không truyền `-var db_multi_az=true` thì check qua và chỉ thấy diff `multi_az: true -> false`. Bước kiểm cuối phiên (đọc state):
# `terraform output db_multi_az` phải in `false` (infra/terraform/README.md, mục RDS).
check "db_multi_az_off" {
  assert {
    condition     = !var.db_multi_az
    error_message = "RDS dev đang bật Multi-AZ (db_multi_az = true, ≈ +0,72 USD/ngày). Diễn tập xong thì chạy lại terraform apply không truyền db_multi_az=true để về Single-AZ."
  }
}
