resource "aws_cloudwatch_log_group" "api" {
  name              = "/dbs/prod/api"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/dbs/prod/worker"
  retention_in_days = 7
}
