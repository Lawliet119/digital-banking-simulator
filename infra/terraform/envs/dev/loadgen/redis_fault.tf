# DBS-167, DBS-186: đường mạng và quyền để máy tải làm Redis chậm, mất khóa hoặc không với tới được (redis-fault.sh). TẤT CẢ nằm
# sau `redis_fault_enabled` (mặc định false). Không sửa `base` và `session`: ba thứ chạm vào tài nguyên của `base` đều nằm trong state
# của stack này nên `destroy` gỡ sạch (một luật ingress vào SG Redis, như `db_from_loadgen`; một NACL riêng gắn vào hai private subnet).
#
# «Tắt» = luật NACL «deny tcp 6379 từ CIDR public» (số 50, 51; redis-fault.sh thêm và xóa lúc chạy). NACL không giữ trạng thái nên cắt cả
# kết nối đang mở (SG thì không). Luật deny chỉ nhắm CIDR public (api, worker, máy tải): lưu lượng đồng bộ primary với replica nằm trong
# private subnet nên không bị cắt. Terraform chỉ tạo luật 100 «allow all»; các số < 100 dành cho driver.
#
# Thứ tự: apply stack này TRƯỚC `session` (lúc chưa có RDS) vì đổi NACL của subnet chạm cả subnet RDS; destroy `session` trước, stack này
# sau. `destroy` gỡ association nên hai subnet quay về NACL mặc định của VPC (mất luật deny còn sót).

data "aws_subnet" "public" {
  for_each = var.redis_fault_enabled ? toset(local.base.public_subnet_ids) : toset([])
  id       = each.value
}

resource "aws_vpc_security_group_egress_rule" "loadgen_to_redis" {
  count = var.redis_fault_enabled ? 1 : 0

  security_group_id            = aws_security_group.loadgen.id
  description                  = "Valkey (redis-fault.sh: CLIENT PAUSE, FLUSHALL; DBS-167)"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = local.base.redis_security_group_id
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_loadgen" {
  count = var.redis_fault_enabled ? 1 : 0

  security_group_id            = local.base.redis_security_group_id
  description                  = "Valkey from the load generator (DBS-167, removed by destroy)"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.loadgen.id
}

resource "aws_network_acl" "redis_fault" {
  count = var.redis_fault_enabled ? 1 : 0

  vpc_id = local.base.vpc_id
  tags   = { Name = "dbs-dev-private-fault" }
}

resource "aws_network_acl_rule" "allow_ingress" {
  count = var.redis_fault_enabled ? 1 : 0

  network_acl_id = aws_network_acl.redis_fault[0].id
  rule_number    = 100
  egress         = false
  protocol       = "-1"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
}

resource "aws_network_acl_rule" "allow_egress" {
  count = var.redis_fault_enabled ? 1 : 0

  network_acl_id = aws_network_acl.redis_fault[0].id
  rule_number    = 100
  egress         = true
  protocol       = "-1"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
}

resource "aws_network_acl_association" "private" {
  for_each = var.redis_fault_enabled ? toset(local.base.private_subnet_ids) : toset([])

  network_acl_id = aws_network_acl.redis_fault[0].id
  subnet_id      = each.value

  # Luật allow phải có trước khi subnet đổi sang NACL mới (NACL mới mặc định deny hết).
  depends_on = [aws_network_acl_rule.allow_ingress, aws_network_acl_rule.allow_egress]
}

locals {
  # Quyền cho redis-fault.sh: đọc đúng secret AUTH của Valkey (KMS đã cho qua Secrets Manager ở main.tf), thêm/xóa luật của ĐÚNG NACL này.
  # `DescribeNetworkAcls` không hỗ trợ giới hạn theo tài nguyên nên là "*".
  redis_fault_statements = [
    for st in [
      {
        Sid      = "RedisAuthSecret"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = local.base.redis_auth_secret_arn
      },
      {
        Sid      = "FaultNaclEntries"
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkAclEntry", "ec2:DeleteNetworkAclEntry"]
        Resource = "arn:aws:ec2:${var.region}:${var.account_id}:network-acl/${try(aws_network_acl.redis_fault[0].id, "none")}"
      },
      {
        Sid      = "DescribeNacls"
        Effect   = "Allow"
        Action   = "ec2:DescribeNetworkAcls"
        Resource = "*"
      },
    ] : st if var.redis_fault_enabled
  ]
}
