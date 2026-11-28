# Giao diện web trên AWS (giao diện v2): S3 riêng tư + CloudFront. Tắt mặc định (`web_enabled = false`), nên
# đo tải và mọi test hiện có không đổi. Bật lên thì:
#   - CloudFront phục vụ file tĩnh từ S3 (chỉ CloudFront đọc được, OAC) và chuyển `/v1/*`, `/health/*` tới ALB
#     cổng 80, không cache, giữ mọi header của người xem (có `Authorization`, `Idempotency-Key`) và query.
#   - Route của app (`/accounts`...) trả `index.html` bằng CloudFront Function chỉ gắn ở behavior S3, nên 404 của
#     API giữ nguyên.
#   - Listener 80 của ALB chỉ chuyển tiếp khi có header bí mật CloudFront gửi kèm; còn lại vẫn chuyển hướng HTTPS.
#   - API tin 2 proxy (CloudFront rồi ALB) để giới hạn theo IP tính đúng người dùng (ecs.tf).
#
# Rủi ro chấp nhận cho môi trường test: CloudFront -> ALB đi HTTP (chứng chỉ ALB tự ký, CloudFront không nhận);
# ai gọi thẳng cổng 443 của ALB có thể giả X-Forwarded-For để né giới hạn theo IP; header bí mật nằm trong state
# (cấu hình CloudFront và luật listener phải chứa giá trị thật, nên không dùng ephemeral như db_roles.tf được).

locals {
  web = var.web_enabled ? 1 : 0

  # Chính sách managed của CloudFront (ID cố định do AWS công bố).
  cache_policy_optimized      = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
  cache_policy_disabled       = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  origin_request_all_but_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader
  web_origin_header_name      = "X-Dbs-Origin-Verify"
  web_api_path_patterns       = ["/v1/*", "/health/*"]
  web_content_security_policy = join("; ", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://cognito-idp.${var.region}.amazonaws.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ])
}

resource "random_password" "web_origin" {
  count   = local.web
  length  = 48
  special = false
}

resource "aws_s3_bucket" "web" {
  count         = local.web
  bucket        = "dbs-dev-web-${var.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "web" {
  count                   = local.web
  bucket                  = aws_s3_bucket.web[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  count  = local.web
  bucket = aws_s3_bucket.web[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  count  = local.web
  bucket = aws_s3_bucket.web[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "web" {
  count                             = local.web
  name                              = "dbs-dev-web"
  description                       = "CloudFront reads the dev web bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Chỉ distribution này đọc được bucket; mọi request không TLS bị từ chối.
resource "aws_s3_bucket_policy" "web" {
  count  = local.web
  bucket = aws_s3_bucket.web[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudFrontReadsObjects"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.web[0].arn}/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.web[0].arn } }
      },
      {
        Sid       = "TlsOnly"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.web[0].arn, "${aws_s3_bucket.web[0].arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.web]
}

# Route của app không có đuôi file: trả index.html để router phía trình duyệt xử lý.
resource "aws_cloudfront_function" "spa" {
  count   = local.web
  name    = "dbs-dev-web-spa"
  runtime = "cloudfront-js-2.0"
  comment = "App routes to index.html"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      if (!/\.[A-Za-z0-9]+$/.test(request.uri)) request.uri = '/index.html';
      return request;
    }
  EOT
}

resource "aws_cloudfront_response_headers_policy" "web" {
  count = local.web
  name  = "dbs-dev-web-security"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.web_content_security_policy
      override                = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }
}

resource "aws_cloudfront_distribution" "web" {
  count               = local.web
  enabled             = true
  comment             = "dbs dev web"
  default_root_object = "index.html"
  price_class         = "PriceClass_200"
  http_version        = "http2and3"

  origin {
    origin_id                = "s3"
    domain_name              = aws_s3_bucket.web[0].bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web[0].id
  }

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.main.dns_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = local.web_origin_header_name
      value = random_password.web_origin[0].result
    }
  }

  default_cache_behavior {
    target_origin_id           = "s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_policy_optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web[0].id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa[0].arn
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.web_api_path_patterns
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = "alb"
      viewer_protocol_policy   = "redirect-to-https"
      allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods           = ["GET", "HEAD"]
      compress                 = true
      cache_policy_id          = local.cache_policy_disabled
      origin_request_policy_id = local.origin_request_all_but_host
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# Cổng 80 chuyển tiếp tới API chỉ khi request mang header bí mật của CloudFront.
resource "aws_lb_listener_rule" "web_origin" {
  count        = local.web
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    http_header {
      http_header_name = local.web_origin_header_name
      values           = [random_password.web_origin[0].result]
    }
  }
}

# WAF đếm theo IP nguồn; sau CloudFront mọi request đến từ IP của CloudFront, nên rate rule chặn nhầm.
check "web_without_waf" {
  assert {
    condition     = !(var.web_enabled && var.waf_enabled)
    error_message = "web_enabled = true with waf_enabled = true: the WAF rate rule sees CloudFront addresses, not users. Set waf_enabled = false for the web test."
  }
}
