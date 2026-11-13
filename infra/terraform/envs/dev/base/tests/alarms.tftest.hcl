# BL-051 (phần Terraform): topic SNS alarm, đăng ký email và alarm DLQ > 0. Mock và biến chép từ sqs.tftest.hcl.
mock_provider "aws" {
  # BL-051: ARN SNS giả đúng định dạng cho alarm_actions (provider kiểm định dạng khi apply).
  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:ap-southeast-1:123456789012:dbs-dev-alarms"
    }
  }
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id = "ap-southeast-1_ABCDEFGHI"
    }
  }
}

variables {
  account_id = "123456789012"
}

# TC-ALM-B1: topic SNS và không có đăng ký email khi không đặt biến
run "topic_without_email" {
  command = apply

  assert {
    condition     = aws_sns_topic.alarms.name == "dbs-dev-alarms"
    error_message = "topic must be dbs-dev-alarms"
  }

  assert {
    condition     = length(aws_sns_topic_subscription.alarm_email) == 0
    error_message = "no e-mail subscription when alarm_email is empty"
  }

  assert {
    condition     = output.alarm_topic_arn == aws_sns_topic.alarms.arn
    error_message = "output alarm_topic_arn must be the topic ARN (session alarms read it)"
  }
}

# TC-ALM-B2: đặt email thì có đúng một đăng ký email vào topic
run "topic_with_email" {
  command = apply

  variables {
    alarm_email = "ops@example.com"
  }

  assert {
    condition = (
      length(aws_sns_topic_subscription.alarm_email) == 1 &&
      aws_sns_topic_subscription.alarm_email[0].protocol == "email" &&
      aws_sns_topic_subscription.alarm_email[0].endpoint == "ops@example.com" &&
      aws_sns_topic_subscription.alarm_email[0].topic_arn == aws_sns_topic.alarms.arn
    )
    error_message = "one e-mail subscription to the alarm topic"
  }
}

run "rejects_bad_email" {
  command = plan

  variables {
    alarm_email = "not-an-email"
  }

  expect_failures = [var.alarm_email]
}

# TC-ALM-B3: alarm DLQ > 0 cho cả hai DLQ, tên queue lấy từ chính queue, gửi vào topic cả khi báo và khi hết
run "dlq_alarms" {
  command = apply

  assert {
    condition     = toset(keys(aws_cloudwatch_metric_alarm.dlq_not_empty)) == toset(["risk", "notification"])
    error_message = "one DLQ alarm per consumer: risk and notification"
  }

  assert {
    condition = alltrue([for k, a in aws_cloudwatch_metric_alarm.dlq_not_empty : (
      a.alarm_name == "dbs-dev-${k}-dlq-not-empty" &&
      a.namespace == "AWS/SQS" &&
      a.metric_name == "ApproximateNumberOfMessagesVisible" &&
      length(a.dimensions) == 1 && a.dimensions["QueueName"] == aws_sqs_queue.dlq[k].name &&
      a.statistic == "Maximum" &&
      a.period == 60 &&
      a.evaluation_periods == 1 &&
      a.threshold == 0 &&
      a.comparison_operator == "GreaterThanThreshold" &&
      a.treat_missing_data == "notBreaching"
    )])
    error_message = "DLQ alarm: AWS/SQS ApproximateNumberOfMessagesVisible, QueueName of its DLQ, Maximum, 60 s x 1, > 0, notBreaching"
  }

  assert {
    condition = alltrue([for a in aws_cloudwatch_metric_alarm.dlq_not_empty : (
      a.alarm_actions == toset([aws_sns_topic.alarms.arn]) && a.ok_actions == toset([aws_sns_topic.alarms.arn])
    )])
    error_message = "DLQ alarms must notify the SNS topic on ALARM and on OK"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_not_empty["risk"].dimensions["QueueName"] == "dbs-dev-risk-events-dlq" && aws_cloudwatch_metric_alarm.dlq_not_empty["notification"].dimensions["QueueName"] == "dbs-dev-notification-events-dlq"
    error_message = "alarms must watch dbs-dev-risk-events-dlq and dbs-dev-notification-events-dlq"
  }
}
