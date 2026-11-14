# DBS-66, DBS-154: CMK dùng chung cho dev (RDS, secret master do RDS quản lý; Secrets, SQS, ElastiCache).
# Key policy tối thiểu: ủy quyền cho IAM (Principal = root) và chỉ cho dùng dữ liệu qua bốn dịch vụ AWS
# (`kms:ViaService` + `kms:CallerAccount`), không có `Principal "*"` và không có `kms:*`.
# Xóa key phải chờ 7 ngày (teardown DBS-208): lên lịch từ trước.
resource "aws_kms_key" "main" {
  description             = "dbs dev: shared CMK for RDS, SQS, Secrets Manager and ElastiCache"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 7

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AccountManagesKeyNotData"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${var.account_id}:root"
        }
        Action = [
          "kms:Describe*",
          "kms:Get*",
          "kms:List*",
          "kms:EnableKey",
          "kms:DisableKey",
          "kms:EnableKeyRotation",
          "kms:DisableKeyRotation",
          "kms:RotateKeyOnDemand",
          "kms:PutKeyPolicy",
          "kms:UpdateKeyDescription",
          "kms:TagResource",
          "kms:UntagResource",
          "kms:ScheduleKeyDeletion",
          "kms:CancelKeyDeletion",
          "kms:CreateAlias",
          "kms:UpdateAlias",
          "kms:DeleteAlias",
          "kms:RevokeGrant",
        ]
        Resource = "*"
      },
      {
        Sid    = "UseKeyOnlyThroughAwsServices"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${var.account_id}:root"
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncryptFrom",
          "kms:ReEncryptTo",
          "kms:GenerateDataKey",
          "kms:GenerateDataKeyWithoutPlaintext",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:CallerAccount" = var.account_id
            "kms:ViaService" = [
              "rds.${var.region}.amazonaws.com",
              "secretsmanager.${var.region}.amazonaws.com",
              "sqs.${var.region}.amazonaws.com",
              "elasticache.${var.region}.amazonaws.com",
              "ec.${var.region}.amazonaws.com",
            ]
          }
        }
      },
      {
        Sid    = "GrantsForAwsServices"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${var.account_id}:root"
        }
        Action   = "kms:CreateGrant"
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:CallerAccount" = var.account_id
          }
          Bool = {
            "kms:GrantIsForAWSResource" = "true"
          }
        }
      },
    ]
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/dbs-dev"
  target_key_id = aws_kms_key.main.key_id
}
