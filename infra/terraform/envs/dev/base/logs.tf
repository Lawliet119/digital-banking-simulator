# Log của task api ở `base`: giữ lại khi `destroy session` để còn bằng chứng cho các lần diễn tập (README, ADR-11).
resource "aws_cloudwatch_log_group" "api" {
  name              = "/dbs/dev/api"
  retention_in_days = 7
}
