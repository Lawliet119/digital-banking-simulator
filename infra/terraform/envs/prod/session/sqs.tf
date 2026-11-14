# SQS và DLQ riêng cho prod (queue policy ở dev/base chỉ cho phép role dbs-dev-worker-task và
# giữ message tách biệt khỏi môi trường dev).
locals {
  sqs_consumers = toset(["risk", "notification"])

  sqs_all_queues = merge(
    { for k, q in aws_sqs_queue.main : k => q },
    { for k, q in aws_sqs_queue.dlq : "${k}-dlq" => q },
  )

  sqs_ops_principals = length(var.sqs_ops_principal_arns) > 0 ? var.sqs_ops_principal_arns : [
    "arn:aws:iam::${var.account_id}:user/*",
  ]

  sqs_allowed_principals = concat(
    ["arn:aws:iam::${var.account_id}:role/dbs-prod-worker-task"],
    local.sqs_ops_principals,
  )
}

resource "aws_sqs_queue" "dlq" {
  for_each = local.sqs_consumers

  name                      = "dbs-prod-${each.key}-events-dlq"
  message_retention_seconds = 518400
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "main" {
  for_each = local.sqs_consumers

  name                       = "dbs-prod-${each.key}-events"
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

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  for_each = local.sqs_consumers

  queue_url = aws_sqs_queue.dlq[each.key].id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.main[each.key].arn]
  })
}

resource "aws_iam_policy" "worker_sqs" {
  name        = "dbs-prod-worker-sqs"
  description = "dbs prod worker: publish to and consume from its SQS queues"

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
          ArnLike = { "aws:PrincipalArn" = "arn:aws:iam::${var.account_id}:role/dbs-prod-api-task" }
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
