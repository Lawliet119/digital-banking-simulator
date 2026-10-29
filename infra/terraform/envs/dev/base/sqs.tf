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
