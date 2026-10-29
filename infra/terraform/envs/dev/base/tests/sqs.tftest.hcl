mock_provider "aws" {}

variables {
  account_id = "123456789012"
}

# TC-73-01: hai queue chính theo ADR-03 (visibility 30 s, long polling 20 s, giữ 4 ngày), SSE-SQS
run "main_queues" {
  command = apply

  assert {
    condition     = aws_sqs_queue.main["risk"].name == "dbs-dev-risk-events" && aws_sqs_queue.main["notification"].name == "dbs-dev-notification-events"
    error_message = "main queues must be dbs-dev-risk-events and dbs-dev-notification-events"
  }

  assert {
    condition = alltrue([for q in aws_sqs_queue.main : (
      q.visibility_timeout_seconds == 30 &&
      q.receive_wait_time_seconds == 20 &&
      q.message_retention_seconds == 345600 &&
      q.delay_seconds == 0 &&
      q.sqs_managed_sse_enabled
    )])
    error_message = "main queues: visibility 30, wait 20, retention 4 days, no delay, SSE-SQS"
  }
}

# TC-73-02: DLQ giữ 6 ngày: lâu hơn queue chính, ngắn hơn 7 ngày processed_events
run "dead_letter_queues" {
  command = apply

  assert {
    condition     = aws_sqs_queue.dlq["risk"].name == "dbs-dev-risk-events-dlq" && aws_sqs_queue.dlq["notification"].name == "dbs-dev-notification-events-dlq"
    error_message = "DLQs must be named <main>-dlq"
  }

  assert {
    condition = alltrue([for k, q in aws_sqs_queue.dlq : (
      q.message_retention_seconds == 518400 &&
      q.message_retention_seconds > aws_sqs_queue.main[k].message_retention_seconds &&
      q.message_retention_seconds < 604800 &&
      q.sqs_managed_sse_enabled
    )])
    error_message = "DLQs: retention 6 days (> main, < 7 days of processed_events), SSE-SQS"
  }
}

# TC-73-03: mỗi queue chính chuyển sang DLQ của chính nó sau 5 lần nhận
run "redrive_policy" {
  command = apply

  assert {
    condition = alltrue([for k, q in aws_sqs_queue.main : (
      jsondecode(q.redrive_policy).maxReceiveCount == 5 &&
      jsondecode(q.redrive_policy).deadLetterTargetArn == aws_sqs_queue.dlq[k].arn
    )])
    error_message = "each main queue must redrive to its own DLQ after 5 receives"
  }

  assert {
    condition     = aws_sqs_queue.dlq["risk"].arn != aws_sqs_queue.dlq["notification"].arn
    error_message = "the two DLQs must be distinct"
  }
}

# TC-73-04: DLQ chỉ nhận từ đúng queue chính của nó
run "redrive_allow_policy" {
  command = apply

  assert {
    condition = alltrue([for k, p in aws_sqs_queue_redrive_allow_policy.dlq : (
      p.queue_url == aws_sqs_queue.dlq[k].id &&
      jsondecode(p.redrive_allow_policy).redrivePermission == "byQueue" &&
      jsondecode(p.redrive_allow_policy).sourceQueueArns == [aws_sqs_queue.main[k].arn]
    )])
    error_message = "each DLQ must accept only its own main queue (byQueue)"
  }
}

# TC-73-09: queue standard, SSE-SQS không lẫn SSE-KMS
run "standard_queues_sse_sqs" {
  command = apply

  assert {
    condition = alltrue([for q in concat(values(aws_sqs_queue.main), values(aws_sqs_queue.dlq)) : (
      q.fifo_queue != true && q.kms_master_key_id == null
    )])
    error_message = "queues must be standard with SSE-SQS only"
  }
}
