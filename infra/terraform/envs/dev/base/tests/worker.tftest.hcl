mock_provider "aws" {
  # BL-051: ARN SNS giả đúng định dạng cho alarm_actions (provider kiểm định dạng khi apply).
  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:ap-southeast-1:123456789012:dbs-dev-alarms"
    }
  }
  # Giá trị giả đúng định dạng id của Cognito (provider kiểm định dạng khi apply).
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id = "ap-southeast-1_ABCDEFGHI"
    }
  }
}

variables {
  account_id = "123456789012"
}

# TC-121-09: log group của worker ở base (sống qua destroy session), tên khớp quy ước của execution role
run "worker_log_group" {
  command = apply

  assert {
    condition     = aws_cloudwatch_log_group.worker.name == "/dbs/dev/worker" && aws_cloudwatch_log_group.worker.retention_in_days == 7
    error_message = "worker log group must be /dbs/dev/worker with 7 days retention"
  }

  assert {
    condition     = output.worker_log_group_name == aws_cloudwatch_log_group.worker.name && output.worker_log_group_arn == aws_cloudwatch_log_group.worker.arn
    error_message = "worker log group name and arn must be exported for the session stack"
  }
}

# TC-121-10: SG của task worker (BL-119): không ingress, egress 443/5432/6379, db và redis chỉ nhận api và worker
run "worker_security_group" {
  command = apply

  assert {
    condition     = aws_security_group.worker.name == "dbs-dev-worker" && output.worker_security_group_id == aws_security_group.worker.id
    error_message = "worker security group dbs-dev-worker must be exported"
  }

  # Worker không mở cổng nào: không có luật ingress nào thuộc SG worker.
  assert {
    condition = length([for r in [
      aws_vpc_security_group_ingress_rule.alb_https, aws_vpc_security_group_ingress_rule.alb_http,
      aws_vpc_security_group_ingress_rule.api_from_alb, aws_vpc_security_group_ingress_rule.db_from_api,
      aws_vpc_security_group_ingress_rule.db_from_worker, aws_vpc_security_group_ingress_rule.redis_from_api,
      aws_vpc_security_group_ingress_rule.redis_from_worker,
    ] : r if r.security_group_id == aws_security_group.worker.id]) == 0
    error_message = "the worker security group must have no ingress rule at all"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.worker_https.from_port == 443 && aws_vpc_security_group_egress_rule.worker_https.to_port == 443 && aws_vpc_security_group_egress_rule.worker_https.ip_protocol == "tcp" && aws_vpc_security_group_egress_rule.worker_https.cidr_ipv4 == "0.0.0.0/0" && aws_vpc_security_group_egress_rule.worker_https.security_group_id == aws_security_group.worker.id
    error_message = "worker egress to AWS APIs must be tcp 443"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.worker_to_db.from_port == 5432 && aws_vpc_security_group_egress_rule.worker_to_db.to_port == 5432 && aws_vpc_security_group_egress_rule.worker_to_db.referenced_security_group_id == aws_security_group.db.id && aws_vpc_security_group_egress_rule.worker_to_db.cidr_ipv4 == null && aws_vpc_security_group_egress_rule.worker_to_db.security_group_id == aws_security_group.worker.id
    error_message = "worker egress to the database must be tcp 5432 to the db security group only"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.worker_to_redis.from_port == 6379 && aws_vpc_security_group_egress_rule.worker_to_redis.to_port == 6379 && aws_vpc_security_group_egress_rule.worker_to_redis.referenced_security_group_id == aws_security_group.redis.id && aws_vpc_security_group_egress_rule.worker_to_redis.cidr_ipv4 == null && aws_vpc_security_group_egress_rule.worker_to_redis.security_group_id == aws_security_group.worker.id
    error_message = "worker egress to valkey must be tcp 6379 to the redis security group only"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.db_from_worker.from_port == 5432 && aws_vpc_security_group_ingress_rule.db_from_worker.to_port == 5432 && aws_vpc_security_group_ingress_rule.db_from_worker.ip_protocol == "tcp" && aws_vpc_security_group_ingress_rule.db_from_worker.security_group_id == aws_security_group.db.id && aws_vpc_security_group_ingress_rule.db_from_worker.referenced_security_group_id == aws_security_group.worker.id && aws_vpc_security_group_ingress_rule.db_from_worker.cidr_ipv4 == null
    error_message = "db must accept tcp 5432 from the worker security group, never a CIDR"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.redis_from_worker.from_port == 6379 && aws_vpc_security_group_ingress_rule.redis_from_worker.to_port == 6379 && aws_vpc_security_group_ingress_rule.redis_from_worker.ip_protocol == "tcp" && aws_vpc_security_group_ingress_rule.redis_from_worker.security_group_id == aws_security_group.redis.id && aws_vpc_security_group_ingress_rule.redis_from_worker.referenced_security_group_id == aws_security_group.worker.id && aws_vpc_security_group_ingress_rule.redis_from_worker.cidr_ipv4 == null
    error_message = "redis must accept tcp 6379 from the worker security group, never a CIDR"
  }

  # Nguồn vào db và redis đúng {api, worker}, không ai khác.
  assert {
    condition = (
      toset([for r in [aws_vpc_security_group_ingress_rule.db_from_api, aws_vpc_security_group_ingress_rule.db_from_worker] : r.referenced_security_group_id]) == toset([aws_security_group.api.id, aws_security_group.worker.id])
      && toset([for r in [aws_vpc_security_group_ingress_rule.redis_from_api, aws_vpc_security_group_ingress_rule.redis_from_worker] : r.referenced_security_group_id]) == toset([aws_security_group.api.id, aws_security_group.worker.id])
    )
    error_message = "db and redis sources must be exactly the api and worker security groups"
  }

  # description là ForceNew: sửa sẽ thay SG và RDS/Valkey mất SG. Giữ nguyên chuỗi cũ.
  assert {
    condition     = aws_security_group.db.description == "RDS PostgreSQL of the dev api (ingress only from the api tasks)" && aws_security_group.redis.description == "ElastiCache Valkey of the dev api (ingress only from the api tasks)"
    error_message = "do not edit the description of the db and redis security groups (ForceNew replaces them)"
  }
}
