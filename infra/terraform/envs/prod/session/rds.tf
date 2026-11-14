# RDS PostgreSQL 17 production: db.t4g.small Multi-AZ, backup 7 ngày, mã hóa CMK, force_ssl = 1.
# Teardown hai bước khi termination_protection = true:
#   1) terraform apply -var termination_protection=false
#   2) terraform destroy
resource "aws_db_parameter_group" "postgres17" {
  name   = "dbs-prod-postgres17"
  family = "postgres17"

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
  identifier     = "dbs-prod"
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.db_instance_class
  multi_az       = true

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true
  kms_key_id        = local.base.kms_key_arn

  db_name  = "dbs"
  username = "dbs_master"
  port     = 5432

  manage_master_user_password   = true
  master_user_secret_kms_key_id = local.base.kms_key_arn

  db_subnet_group_name   = local.base.db_subnet_group_name
  vpc_security_group_ids = [local.base.db_security_group_id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.postgres17.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period   = 7
  deletion_protection       = var.termination_protection
  skip_final_snapshot       = !var.termination_protection
  final_snapshot_identifier = var.termination_protection ? "dbs-prod-final" : null
  delete_automated_backups  = !var.termination_protection
  apply_immediately         = true

  auto_minor_version_upgrade   = true
  performance_insights_enabled = false
  monitoring_interval          = 0

  # Fail-fast nếu certificate_arn không hợp lệ trên AWS trước khi dựng tài nguyên tốn tiền.
  depends_on = [aws_lb_listener.https]
}
