resource "aws_lb" "main" {
  name                       = "dbs-prod"
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = local.base.public_subnet_ids
  security_groups            = [local.base.alb_security_group_id]
  enable_deletion_protection = var.termination_protection
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "api" {
  name                 = "dbs-prod-api"
  target_type          = "ip"
  port                 = 3000
  protocol             = "HTTP"
  vpc_id               = local.base.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/health/ready"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
