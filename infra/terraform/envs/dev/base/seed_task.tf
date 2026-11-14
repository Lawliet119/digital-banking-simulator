# BL-252: seed dữ liệu demo bằng task ECS chạy một lần trong VPC (infra/scripts/seed-cloud.sh), không đi qua ALB.
# ALB dev dùng chứng chỉ tự ký nên Node từ chối TLS; task trong VPC gọi thẳng task api qua HTTP cổng 3000
# (ALB cũng nói HTTP với task, nên không có thêm kênh nào mất mã hóa).
#
# SG riêng thay vì dùng lại SG api: SG api không phải tin chính nó (khi đó task api nào cũng gọi được task api khác
# ở cổng 3000). Chỉ task seed, không có ingress nào, được phép vào cổng 3000 của task api; task seed không cần RDS
# hay Valkey (nó nói chuyện qua API) nên không có luật tới SG db và redis. Task definition `dbs-seed` ở
# envs/dev/session/ecs.tf; log group dùng chung /dbs/dev/api (stream seed/seed/<task-id>).
resource "aws_security_group" "seed" {
  name        = "dbs-dev-seed"
  description = "One-off seed task of the dev api (no ingress at all)"
  vpc_id      = aws_vpc.main.id
}

# Task ở public subnet, không NAT: ECR (kéo image) và CloudWatch Logs qua 443.
resource "aws_vpc_security_group_egress_rule" "seed_https" {
  security_group_id = aws_security_group.seed.id
  description       = "HTTPS to AWS APIs (ECR, logs)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "seed_to_api" {
  security_group_id            = aws_security_group.seed.id
  description                  = "HTTP to the api tasks"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "api_from_seed" {
  security_group_id            = aws_security_group.api.id
  description                  = "App port from the one-off seed task"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.seed.id
}
