mock_provider "aws" {
  # Giá trị giả đúng định dạng id của Cognito: khi nhánh này nằm cùng stack có Cognito (DBS-54),
  # provider kiểm định dạng khi apply. Không ảnh hưởng gì khi stack chưa có Cognito.
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id = "ap-southeast-1_ABCDEFGHI"
    }
  }
}

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

# TC-73-05: policy worker: gửi/nhận/xóa ở queue chính, chỉ gửi vào DLQ (message sai schema), không quản trị
run "worker_policy" {
  command = apply

  assert {
    condition     = aws_iam_policy.worker_sqs.name == "dbs-dev-worker-sqs"
    error_message = "worker policy must be dbs-dev-worker-sqs"
  }

  assert {
    condition = length(jsondecode(aws_iam_policy.worker_sqs.policy).Statement) == 2 && alltrue([
      for st in jsondecode(aws_iam_policy.worker_sqs.policy).Statement : st.Effect == "Allow"
    ])
    error_message = "worker policy must have exactly two Allow statements"
  }

  assert {
    condition = (
      toset(one([for st in jsondecode(aws_iam_policy.worker_sqs.policy).Statement : st.Action if st.Sid == "PublishAndConsume"])) == toset(["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]) &&
      toset(one([for st in jsondecode(aws_iam_policy.worker_sqs.policy).Statement : st.Resource if st.Sid == "PublishAndConsume"])) == toset([for q in aws_sqs_queue.main : q.arn])
    )
    error_message = "PublishAndConsume must grant the five consumer actions on the two main queues only"
  }

  assert {
    condition = (
      one([for st in jsondecode(aws_iam_policy.worker_sqs.policy).Statement : st.Action if st.Sid == "DeadLetterMalformed"]) == "sqs:SendMessage" &&
      toset(one([for st in jsondecode(aws_iam_policy.worker_sqs.policy).Statement : st.Resource if st.Sid == "DeadLetterMalformed"])) == toset([for q in aws_sqs_queue.dlq : q.arn])
    )
    error_message = "DeadLetterMalformed must grant only sqs:SendMessage on the two DLQs"
  }

  assert {
    condition     = !strcontains(aws_iam_policy.worker_sqs.policy, "\"*\"") && !strcontains(aws_iam_policy.worker_sqs.policy, "sqs:*") && !strcontains(aws_iam_policy.worker_sqs.policy, "Purge") && !strcontains(aws_iam_policy.worker_sqs.policy, "sqs:DeleteQueue") && !strcontains(aws_iam_policy.worker_sqs.policy, "sqs:Set")
    error_message = "worker policy must not use wildcards or admin actions"
  }
}

# TC-73-06: queue policy của cả 4 queue chặn role task api (kể cả khi role đó lỡ có sqs:*)
run "queue_policy_denies_api" {
  command = apply

  assert {
    condition     = length(aws_sqs_queue_policy.deny_api) == 4
    error_message = "every queue, main and DLQ, must carry the deny policy"
  }

  assert {
    condition = alltrue([for k, p in aws_sqs_queue_policy.deny_api : (
      length(jsondecode(p.policy).Statement) == 1 &&
      jsondecode(p.policy).Statement[0].Effect == "Deny" &&
      jsondecode(p.policy).Statement[0].Principal == "*" &&
      jsondecode(p.policy).Statement[0].Action == "sqs:*" &&
      jsondecode(p.policy).Statement[0].Resource == local.sqs_all_queues[k].arn &&
      jsondecode(p.policy).Statement[0].Condition.ArnLike["aws:PrincipalArn"] == "arn:aws:iam::123456789012:role/dbs-dev-api-task" &&
      p.queue_url == local.sqs_all_queues[k].id
    )])
    error_message = "each queue policy must deny sqs:* to the dbs-dev-api-task role of this account"
  }
}

# TC-73-08: output cho DBS-121 (biến môi trường của sqs.config.ts), DBS-120 (policy) và DBS-163 (alarm)
run "exports_for_worker" {
  command = apply

  assert {
    condition = (
      output.sqs_risk_queue_url == aws_sqs_queue.main["risk"].url &&
      output.sqs_notification_queue_url == aws_sqs_queue.main["notification"].url &&
      output.sqs_risk_dlq_url == aws_sqs_queue.dlq["risk"].url &&
      output.sqs_notification_dlq_url == aws_sqs_queue.dlq["notification"].url
    )
    error_message = "queue and DLQ urls must be exported"
  }

  assert {
    condition = (
      output.sqs_queue_arns == { risk = aws_sqs_queue.main["risk"].arn, notification = aws_sqs_queue.main["notification"].arn } &&
      output.sqs_dlq_arns == { risk = aws_sqs_queue.dlq["risk"].arn, notification = aws_sqs_queue.dlq["notification"].arn } &&
      output.sqs_dlq_names == { risk = "dbs-dev-risk-events-dlq", notification = "dbs-dev-notification-events-dlq" }
    )
    error_message = "queue and DLQ arn/name maps must have exactly the keys risk and notification"
  }

  assert {
    condition     = output.worker_sqs_policy_arn == aws_iam_policy.worker_sqs.arn
    error_message = "worker policy arn must be exported"
  }
}
