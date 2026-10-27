# DBS-34: security group của ALB và của task api (ADR-10). Ở `base` vì miễn phí và để các stack sau
# (RDS, ElastiCache) tham chiếu SG task mà không phụ thuộc phần xóa hằng ngày (BL-031).
# Luật tách thành tài nguyên riêng để hai SG tham chiếu nhau mà không tạo vòng phụ thuộc.
resource "aws_security_group" "alb" {
  name        = "dbs-dev-alb"
  description = "ALB of the dev api"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "api" {
  name        = "dbs-dev-api"
  description = "Fargate tasks of the dev api (ingress only from the ALB)"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from the internet, only to redirect to HTTPS"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the api tasks"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "App port from the ALB only"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.alb.id
}

# Task ở public subnet, không NAT: ECR, CloudWatch Logs, SQS, Secrets Manager, JWKS đều qua 443.
# Egress tới RDS (5432) và ElastiCache (6379) do DBS-66 và task ElastiCache thêm theo SG-to-SG.
resource "aws_vpc_security_group_egress_rule" "api_https" {
  security_group_id = aws_security_group.api.id
  description       = "HTTPS to AWS APIs and the identity provider"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}
