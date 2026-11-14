# BL-261: dashboard hạ tầng `dbs-dev-infra` (ECS, ALB, RDS, Valkey), tách khỏi `dbs-dev-overview` (dashboard.tf).
# Lý do tách: widget ALB cần `arn_suffix` của aws_lb và target group (dạng `app/dbs-dev/<mã>`, không dựng được từ chuỗi
# biết trước), nên dashboard này tham chiếu tài nguyên session và `-target` nó sẽ kéo cả ALB lên. Dashboard `overview`
# vẫn chỉ có metric ứng dụng và SQS, nên apply riêng được như DBS-145 đã ghi. Tài khoản có 3 dashboard miễn phí
# (mỗi dashboard thêm 3 USD/tháng từ cái thứ tư); aws_cloudwatch_dashboard không hỗ trợ tag.
#
# Số đo của AWS (miễn phí, không cần bật gì thêm): AWS/ECS CPUUtilization, MemoryUtilization theo ClusterName + ServiceName;
# AWS/RDS theo DBInstanceIdentifier; AWS/ElastiCache theo CacheClusterId (node `<nhóm>-001`); AWS/ApplicationELB theo
# LoadBalancer (+ TargetGroup).
# Số task đang chạy: ECS/ContainerInsights RunningTaskCount cần bật Container Insights (đang `disabled` ở ecs.tf, bật là
# tốn tiền theo task), nên widget dùng HealthyHostCount/UnHealthyHostCount của target group api. Service `worker` không
# sau ALB nên chưa có số task riêng: dùng widget "Tuổi outbox" ở dashboard overview (không có điểm = worker không chạy).

locals {
  infra_cluster = aws_ecs_cluster.main.name
  infra_api     = aws_ecs_service.api.name
  infra_worker  = aws_ecs_service.worker.name
  infra_alb     = aws_lb.main.arn_suffix
  infra_tg      = aws_lb_target_group.api.arn_suffix
  infra_db      = aws_db_instance.main.identifier
  infra_redis   = "${aws_elasticache_replication_group.main.replication_group_id}-001"

  infra_text = join("\n", [
    "## DBS dev: hạ tầng (ECS, ALB, RDS, Valkey)",
    "Số đo gốc của AWS trong `AWS/ECS`, `AWS/ApplicationELB`, `AWS/RDS`, `AWS/ElastiCache`; metric ứng dụng và SLO ở dashboard `dbs-dev-overview`.",
    "- **Số task**: Container Insights đang tắt nên không có `RunningTaskCount`; widget ALB cho số task api khỏe (`HealthyHostCount`). Worker không sau ALB: xem tuổi outbox (không có điểm = không chạy).",
    "- **5xx ở ALB**: `HTTPCode_ELB_5XX_Count` do chính ALB sinh (không có target khỏe, quá tải), `HTTPCode_Target_5XX_Count` do app trả. Tỉ lệ = (hai loại) / `RequestCount`; probe `/health/*` có tính vào ALB nên số có thể cao hơn tỉ lệ trên dashboard overview.",
    "- **Valkey** là một node (`<nhóm>-001`); node chết thì mọi đường biến mất (alarm `dbs-dev-redis-node-missing`).",
  ])

  wi_text = {
    type   = "text"
    x      = 0
    y      = 0
    width  = 24
    height = 4
    properties = {
      markdown = local.infra_text
    }
  }

  wi_ecs_cpu = {
    type   = "metric"
    x      = 0
    y      = 4
    width  = 8
    height = 6
    properties = {
      title  = "ECS: CPU (%)"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        ["AWS/ECS", "CPUUtilization", "ClusterName", local.infra_cluster, "ServiceName", local.infra_api, { stat = "Average", label = "api" }],
        ["AWS/ECS", "CPUUtilization", "ClusterName", local.infra_cluster, "ServiceName", local.infra_worker, { stat = "Average", label = "worker" }],
      ]
      yAxis = { left = { min = 0, max = 100 } }
    }
  }

  wi_ecs_mem = {
    type   = "metric"
    x      = 8
    y      = 4
    width  = 8
    height = 6
    properties = {
      title  = "ECS: bộ nhớ (%)"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        ["AWS/ECS", "MemoryUtilization", "ClusterName", local.infra_cluster, "ServiceName", local.infra_api, { stat = "Average", label = "api" }],
        ["AWS/ECS", "MemoryUtilization", "ClusterName", local.infra_cluster, "ServiceName", local.infra_worker, { stat = "Average", label = "worker" }],
      ]
      yAxis = { left = { min = 0, max = 100 } }
    }
  }

  wi_tasks = {
    type   = "metric"
    x      = 16
    y      = 4
    width  = 8
    height = 6
    properties = {
      title  = "Task api sau ALB: khỏe và không khỏe"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        ["AWS/ApplicationELB", "HealthyHostCount", "TargetGroup", local.infra_tg, "LoadBalancer", local.infra_alb, { stat = "Minimum", label = "khỏe" }],
        ["AWS/ApplicationELB", "UnHealthyHostCount", "TargetGroup", local.infra_tg, "LoadBalancer", local.infra_alb, { stat = "Maximum", label = "không khỏe" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  wi_alb_5xx = {
    type   = "metric"
    x      = 0
    y      = 10
    width  = 8
    height = 6
    properties = {
      title  = "ALB: số 5xx"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", local.infra_alb, { stat = "Sum", label = "do ALB" }],
        ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", local.infra_alb, { stat = "Sum", label = "do app" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  wi_alb_rate = {
    type   = "metric"
    x      = 8
    y      = 10
    width  = 8
    height = 6
    properties = {
      title  = "ALB: tỉ lệ 5xx (%)"
      region = local.dash_region
      view   = "timeSeries"
      period = 300
      metrics = [
        ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", local.infra_alb, { id = "e5", stat = "Sum", visible = false }],
        ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", local.infra_alb, { id = "t5", stat = "Sum", visible = false }],
        ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", local.infra_alb, { id = "rc", stat = "Sum", visible = false }],
        [{ expression = "100 * (FILL(e5, 0) + FILL(t5, 0)) / rc", label = "5xx %", id = "e1" }],
      ]
      annotations = {
        horizontal = [{ label = "SLO 5xx 1%", value = 1 }]
      }
      yAxis = { left = { min = 0 } }
    }
  }

  wi_rds_conn = {
    type   = "metric"
    x      = 16
    y      = 10
    width  = 8
    height = 6
    properties = {
      title  = "RDS: số kết nối"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", local.infra_db, { stat = "Maximum", label = "kết nối" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }

  wi_rds_cpu = {
    type   = "metric"
    x      = 0
    y      = 16
    width  = 8
    height = 6
    properties = {
      title  = "RDS: CPU (%)"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", local.infra_db, { stat = "Average", label = "CPU" }],
      ]
      yAxis = { left = { min = 0, max = 100 } }
    }
  }

  wi_redis_cpu = {
    type   = "metric"
    x      = 8
    y      = 16
    width  = 8
    height = 6
    properties = {
      title  = "Valkey: CPU (%)"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        ["AWS/ElastiCache", "CPUUtilization", "CacheClusterId", local.infra_redis, { stat = "Average", label = "CPU máy" }],
        ["AWS/ElastiCache", "EngineCPUUtilization", "CacheClusterId", local.infra_redis, { stat = "Average", label = "CPU engine" }],
      ]
      yAxis = { left = { min = 0, max = 100 } }
    }
  }

  wi_redis_mem = {
    type   = "metric"
    x      = 16
    y      = 16
    width  = 8
    height = 6
    properties = {
      title  = "Valkey: bộ nhớ (%) và kết nối"
      region = local.dash_region
      view   = "timeSeries"
      period = 60
      metrics = [
        ["AWS/ElastiCache", "DatabaseMemoryUsagePercentage", "CacheClusterId", local.infra_redis, { stat = "Maximum", label = "bộ nhớ %" }],
        ["AWS/ElastiCache", "CurrConnections", "CacheClusterId", local.infra_redis, { stat = "Maximum", label = "kết nối", yAxis = "right" }],
      ]
      yAxis = { left = { min = 0, max = 100 }, right = { min = 0 } }
    }
  }

  infra_dashboard_body = {
    start          = "-PT3H"
    periodOverride = "inherit"
    widgets = [
      local.wi_text, local.wi_ecs_cpu, local.wi_ecs_mem, local.wi_tasks,
      local.wi_alb_5xx, local.wi_alb_rate, local.wi_rds_conn,
      local.wi_rds_cpu, local.wi_redis_cpu, local.wi_redis_mem,
    ]
  }
}

resource "aws_cloudwatch_dashboard" "infra" {
  dashboard_name = "dbs-dev-infra"
  dashboard_body = jsonencode(local.infra_dashboard_body)
}
