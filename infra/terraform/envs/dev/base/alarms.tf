# BL-051, BL-117, BL-179, BL-182 (docs/03 §14): kênh nhận alarm và alarm DLQ. Nằm ở base vì hai lý do:
# - Topic SNS và đăng ký email sống qua `destroy` của session: email chỉ phải xác nhận MỘT lần, không phải mỗi phiên.
# - DLQ nằm ở base và giữ message tới 6 ngày kể cả khi session đã xóa; alarm "DLQ > 0" phải còn đó để không ai quên
#   message chưa redrive. Alarm của tài nguyên session (tuổi queue, outbox, Redis...) ở session/alarms.tf.
# Chi phí: 1 topic và 4 alarm chuẩn ≈ 0,40 USD/tháng, tính cả khi session đã xóa.

# Không bật SSE-KMS cho topic: khóa AWS managed `alias/aws/sns` không cho CloudWatch publish, còn CMK của dự án
# (kms.tf) cần thêm quyền cho cloudwatch.amazonaws.com. Nội dung thư chỉ có tên alarm, ngưỡng và số đo, không có
# dữ liệu khách (metric không mang id khách, DBS-144). Policy mặc định của topic cho phép alarm cùng tài khoản publish.
resource "aws_sns_topic" "alarms" {
  name = "dbs-dev-alarms"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count = var.alarm_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# DLQ có message: SLO "DLQ = 0" (docs/03 §14), alarm khi > 0. `Maximum` trong 1 phút; một lần đo là đủ vì message
# vào DLQ không tự biến mất (khác counter): alarm giữ ALARM tới khi redrive hoặc xóa message
# (runbook docs/runbooks/dlq-redrive.md). SQS ngừng phát metric của queue rảnh quá 6 giờ nên thiếu dữ liệu coi là
# `notBreaching`. Mô tả nêu đúng queue nguồn để người nhận thư biết redrive ở đâu.
resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  for_each = aws_sqs_queue.dlq

  alarm_name        = "dbs-dev-${each.key}-dlq-not-empty"
  alarm_description = "DLQ ${each.value.name} có message (SLO DLQ = 0, docs/03 §14). Đọc nguyên nhân rồi sửa trước khi redrive: docs/runbooks/dlq-redrive.md. Redrive trong 24 giờ, mỗi eventId một lần."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions  = { QueueName = each.value.name }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

# RSK-04: cảnh báo bậc 2 (escalation) khi message nằm trong DLQ quá 1 giờ (3600 s), trước SLA redrive 24 giờ
# và hạn retention 6 ngày. evaluation_periods = 2 lọc nhiễu residual spike khi DLQ vừa cạn; notBreaching khi rỗng.
resource "aws_cloudwatch_metric_alarm" "dlq_oldest_age" {
  for_each = aws_sqs_queue.dlq

  alarm_name        = "dbs-dev-${each.key}-dlq-oldest-age"
  alarm_description = "Message trong DLQ ${each.value.name} quá 1 giờ chưa được xử lý (cảnh báo trước SLA 24 giờ và hạn retention 6 ngày). Kiểm tra và redrive theo docs/runbooks/dlq-redrive.md."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateAgeOfOldestMessage"
  dimensions  = { QueueName = each.value.name }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 3600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}
