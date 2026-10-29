# DBS-73, ADR-03: mỗi consumer một queue standard và một DLQ (docs/03 §10). Nằm ở base (giữ lại):
# SQS không tính tiền khi rảnh, URL ổn định giữa các phiên, DLQ sống qua một lần destroy session.
# Mã hóa SSE-SQS (miễn phí, worker không cần quyền KMS).

locals {
  sqs_consumers = toset(["risk", "notification"])
}

# DLQ giữ 6 ngày. Queue standard tính hạn trong DLQ từ lúc gửi gốc, nên message không sống quá
# 6 ngày < 7 ngày của processed_events (database-design §10). Redrive reset hạn: xem quy tắc redrive
# ở README Terraform.
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
