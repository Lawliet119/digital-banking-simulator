# DBS-166: máy chạy tải k6 CÙNG region với ALB (docs/03 §14, README Terraform «Máy chạy tải»). Dựng cho một đợt đo rồi
# `terraform destroy`; không có gì ở đây tính tiền khi stack rỗng. Không sửa `base`: chỉ đọc output của nó và thêm
# MỘT luật ingress 5432 vào SG của RDS từ SG của máy tải; luật nằm trong state của stack này nên `destroy` gỡ sạch.
#
# Mạng: public subnet (không NAT, ADR-10) với IP công khai gán lúc khởi động (ổn định tới khi máy bị stop hoặc hủy), để
# biết IP cho `waf_rate_limit_exempt_cidrs` của session (BL-292): apply stack này TRƯỚC session và đọc output `public_ip`. SG không có ingress; egress 443 ra internet (npm, tarball Node và k6, ALB, API AWS) và 5432 tới SG RDS.
# Điều khiển bằng SSM Run Command (không SSH, không cổng vào). Mã nguồn và kết quả đi qua bucket S3 của stack.

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_s3_bucket" "loadgen" {
  bucket        = "dbs-loadgen-${var.account_id}-${var.region}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "loadgen" {
  bucket                  = aws_s3_bucket.loadgen.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "loadgen" {
  bucket = aws_s3_bucket.loadgen.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "loadgen" {
  bucket = aws_s3_bucket.loadgen.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.loadgen.arn, "${aws_s3_bucket.loadgen.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.loadgen]
}

resource "aws_security_group" "loadgen" {
  name        = "dbs-dev-loadgen"
  description = "k6 load generator of the dev api (no ingress)"
  vpc_id      = local.base.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "loadgen_https" {
  security_group_id = aws_security_group.loadgen.id
  description       = "HTTPS to the ALB, AWS APIs, npm, Node and k6 downloads"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "loadgen_to_db" {
  security_group_id            = aws_security_group.loadgen.id
  description                  = "PostgreSQL (checker and postflight of the runner)"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = local.base.db_security_group_id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_loadgen" {
  security_group_id            = local.base.db_security_group_id
  description                  = "PostgreSQL from the load generator (DBS-166, removed by destroy)"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.loadgen.id
}

resource "aws_iam_role" "loadgen" {
  name = "dbs-dev-loadgen"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.loadgen.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Quyền tối thiểu: bucket của stack, secret của role dbs_api (checker và postflight chỉ SELECT) và CMK dùng qua
# Secrets Manager. Không đọc secret master, không đọc demo-accounts (token Cognito do người vận hành lấy và đặt vào bucket).
resource "aws_iam_role_policy" "loadgen" {
  name = "dbs-dev-loadgen"
  role = aws_iam_role.loadgen.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Bucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [aws_s3_bucket.loadgen.arn, "${aws_s3_bucket.loadgen.arn}/*"]
      },
      {
        Sid      = "DbApiSecret"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:dbs/dev/db-api-*"
      },
      {
        Sid       = "DecryptViaSecretsManager"
        Effect    = "Allow"
        Action    = "kms:Decrypt"
        Resource  = local.base.kms_key_arn
        Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" } }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "loadgen" {
  name = "dbs-dev-loadgen"
  role = aws_iam_role.loadgen.name
}

resource "aws_instance" "loadgen" {
  ami                         = data.aws_ssm_parameter.al2023.value
  instance_type               = var.instance_type
  subnet_id                   = local.base.public_subnet_ids[0]
  vpc_security_group_ids      = [aws_security_group.loadgen.id]
  iam_instance_profile        = aws_iam_instance_profile.loadgen.name
  associate_public_ip_address = true

  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }

  tags = { Name = "dbs-dev-loadgen" }
}


# Client Cognito tạm cho đợt đo: access token 240 phút để một fixture dùng hết năm bài (baseline 46 phút, hot 15, stress 16,
# README Terraform). Không sửa app client `dbs-app` của base (token 15 phút theo ADR-06 giữ nguyên). Người dùng demo của pool
# đăng nhập được bằng client này; session đặt COGNITO_CLIENT_ID của api theo client này qua `api_extra_environment`.
# `destroy` xóa client, token đã phát hết hiệu lực.
resource "aws_cognito_user_pool_client" "loadgen" {
  name         = "dbs-loadgen"
  user_pool_id = local.base.cognito_user_pool_id

  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 240
  id_token_validity      = 240
  refresh_token_validity = 1

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}
