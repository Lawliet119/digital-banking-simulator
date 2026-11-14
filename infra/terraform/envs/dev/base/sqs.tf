# DBS-73, ADR-03: mỗi consumer một queue standard và một DLQ (docs/03 §10). Nằm ở base (giữ lại):
# SQS không tính tiền khi rảnh, URL ổn định giữa các phiên, DLQ sống qua một lần destroy session.
# Mã hóa SSE-SQS (miễn phí, worker không cần quyền KMS).

locals {
  sqs_consumers = toset(["risk", "notification"])
}

# DLQ giữ 6 ngày. Chỉ việc SQS tự chuyển (redrive_policy, maxReceiveCount) giữ hạn tính từ lúc gửi
# gốc. Consumer của app (ConsumerBase, libs/sqs deadLetter) chuyển bằng SendMessage: bản sao là message
# mới, hạn DLQ tính lại từ lúc chuyển, nên message có thể sống tới 4 + 6 ngày kể từ lúc gửi gốc, dài hơn
# 7 ngày của processed_events (database-design §10, BL-210). Vì vậy bản sao mang thuộc tính
# OriginalSentTimestamp (epoch ms của lần gửi gốc, giữ qua mọi lần chuyển và replay) và Ops chạy
# `npm run --silent dlq:age-check` trước mỗi redrive: message gửi gốc quá 6 ngày không được replay
# (docs/runbooks/dlq-redrive.md). Redrive (start-message-move-task) cũng reset hạn: xem quy tắc ở README
# Terraform.
resource "aws_sqs_queue" "dlq" {
  for_each = local.sqs_consumers

  name                      = "dbs-dev-${each.key}-events-dlq"
  message_retention_seconds = 518400
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "main" {
  for_each = local.sqs_consumers

  name                       = "dbs-dev-${each.key}-events"
  visibility_timeout_seconds = 30
  receive_wait_time_seconds  = 20
  message_retention_seconds  = 345600
  delay_seconds              = 0
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = 5
  })
}

# DLQ chỉ nhận từ đúng queue chính của nó.
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  for_each = local.sqs_consumers

  queue_url = aws_sqs_queue.dlq[each.key].id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.main[each.key].arn]
  })
}

# Quyền của task worker (relay outbox gửi, consumer risk/notification nhận). Chưa gắn vào role nào:
# DBS-120 gắn vào role task worker. Consumer gửi message sai schema thẳng vào DLQ (event-contract),
# nên có SendMessage trên DLQ; đọc và redrive DLQ là việc của Ops, không phải worker.
resource "aws_iam_policy" "worker_sqs" {
  name        = "dbs-dev-worker-sqs"
  description = "dbs dev worker: publish to and consume from its SQS queues"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "PublishAndConsume"
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
        ]
        Resource = [for q in aws_sqs_queue.main : q.arn]
      },
      {
        Sid      = "DeadLetterMalformed"
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = [for q in aws_sqs_queue.dlq : q.arn]
      },
    ]
  })
}

# Queue policy (resource-based) có hai Deny; Deny thắng mọi Allow của identity policy.
#
# 1. DenyApiTaskRole: role task api không bao giờ được dùng SQS (ADR-13: chỉ worker publish và consume).
#    Chặn kể cả khi role api lỡ được gắn sqs:*. So theo tên role (aws:PrincipalArn của phiên assume-role là ARN
#    role), nên role tạo lại mỗi phiên vẫn bị chặn; đổi tên role api (DBS-120) thì phải sửa ở đây.
#
# 2. DenyMessageActionsExceptAllowList (BL-241, threat-model T9 "chỉ IAM role của worker gửi/nhận được SQS"):
#    danh sách cho phép. Mọi principal KHÔNG khớp {role task worker, sqs_ops_principal_arns} bị từ chối các
#    thao tác trên message (gửi, nhận, xóa, đổi visibility, purge, redrive). Nên một role tương lai hoặc một
#    user khác có sqs:* trong identity policy vẫn không gửi được message giả vào queue.
#    - Không chặn thao tác quản trị queue (SetQueueAttributes, GetQueueAttributes, DeleteQueue, tag…):
#      Terraform chạy bằng quyền admin của người apply và phải sửa được chính queue policy này. Vì thế
#      khoảng khóa tối đa chỉ là dữ liệu message, và gỡ bằng cách sửa biến rồi `terraform apply`.
#    - Redrive DLQ -> queue chính của chính SQS (maxReceiveCount, redrive_policy) là nội bộ SQS, không đi qua
#      quyền gọi của principal nào. Ops redrive bằng StartMessageMoveTask (docs/runbooks/dlq-redrive.md) phải
#      nằm trong danh sách.
#    - Worker gửi vào DLQ message sai schema (DeadLetterMalformed) nên cũng nằm trong danh sách ở DLQ.
locals {
  sqs_all_queues = merge(
    { for k, q in aws_sqs_queue.main : k => q },
    { for k, q in aws_sqs_queue.dlq : "${k}-dlq" => q },
  )

  # Mặc định mọi IAM user của tài khoản (người vận hành ở dev dùng IAM user, không dùng role admin): vẫn chặn
  # role (api, role tương lai) và principal ngoài tài khoản, và không khóa người sự cố. Muốn chặt hơn thì đặt
  # `sqs_ops_principal_arns` thành danh sách ARN cụ thể (user hoặc role).
  sqs_ops_principals = length(var.sqs_ops_principal_arns) > 0 ? var.sqs_ops_principal_arns : [
    "arn:aws:iam::${var.account_id}:user/*",
  ]

  sqs_allowed_principals = concat(
    ["arn:aws:iam::${var.account_id}:role/dbs-dev-worker-task"],
    local.sqs_ops_principals,
  )
}

resource "aws_sqs_queue_policy" "deny_api" {
  for_each = local.sqs_all_queues

  queue_url = each.value.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyApiTaskRole"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = each.value.arn
        Condition = {
          ArnLike = { "aws:PrincipalArn" = "arn:aws:iam::${var.account_id}:role/dbs-dev-api-task" }
        }
      },
      {
        Sid       = "DenyMessageActionsExceptAllowList"
        Effect    = "Deny"
        Principal = "*"
        Action = [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:PurgeQueue",
          "sqs:StartMessageMoveTask",
        ]
        Resource = each.value.arn
        Condition = {
          ArnNotLike = { "aws:PrincipalArn" = local.sqs_allowed_principals }
        }
      },
    ]
  })
}
