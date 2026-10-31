# DBS-66: mạng của RDS (ADR-10): private subnet không route ra internet, chỉ nhận 5432 từ task api.
# Ở `base` vì miễn phí và để DBS-67/68 tham chiếu; instance nằm ở `session` (xóa hằng ngày).
resource "aws_db_subnet_group" "main" {
  name       = "dbs-dev"
  subnet_ids = aws_subnet.private[*].id
}

# Không có luật egress nào: RDS không cần chủ động đi ra.
resource "aws_security_group" "db" {
  name        = "dbs-dev-db"
  description = "RDS PostgreSQL of the dev api (ingress only from the api tasks)"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_api" {
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from the api tasks only"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_egress_rule" "api_to_db" {
  security_group_id            = aws_security_group.api.id
  description                  = "PostgreSQL to the database"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.db.id
}
