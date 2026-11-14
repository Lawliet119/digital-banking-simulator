variable "state_bucket" {
  description = "Name of the Terraform state bucket (output state_bucket_name of the bootstrap stack)."
  type        = string
}

variable "account_id" {
  description = "AWS account id (12 digits). Also guards against applying to the wrong account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be exactly 12 digits."
  }
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "ap-southeast-1"
}

variable "image_tag" {
  description = "Tag của image trong ECR: SHA đầy đủ của commit (40 ký tự hex). Không dùng latest (repo IMMUTABLE)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.image_tag))
    error_message = "image_tag must be a full 40-character commit SHA, never latest."
  }
}

variable "desired_count" {
  description = "Số task api. Mặc định 0: task chưa chạy được khi thiếu DB, Redis, Cognito (DBS-66, 67, 54); đặt 1 khi các thứ đó đã có."
  type        = number
  default     = 0

  validation {
    condition     = var.desired_count >= 0 && var.desired_count <= 6
    error_message = "desired_count must be between 0 and 6 (connection pool limit, docs/03 section 13.2)."
  }
}

variable "node_env" {
  description = "NODE_ENV của task. Dev trên AWS chạy staging: bắt buộc TLS tới DB và Redis và TRUST_PROXY_HOPS."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "production"], var.node_env)
    error_message = "node_env must be staging or production on AWS."
  }
}

variable "db_instance_class" {
  description = "Cỡ instance RDS. Dev dùng db.t4g.micro; production đổi qua biến (db.t4g.small, docs/03 mục 13.1)."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_multi_az" {
  description = "Multi-AZ cho RDS. Dev Single-AZ (false); production true."
  type        = bool
  default     = false
}

variable "redis_node_type" {
  description = "Loại node Valkey (ADR-12: dev cache.t4g.micro)."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_replicas" {
  description = "Số replica của Valkey. Dev 0; production 1 ở AZ khác, bật failover và Multi-AZ (ADR-12)."
  type        = number
  default     = 0

  validation {
    condition     = var.redis_replicas >= 0 && var.redis_replicas <= 2
    error_message = "redis_replicas must be between 0 and 2."
  }
}

variable "redis_auth_version" {
  description = "Phiên bản AUTH token của Valkey. Tăng một đơn vị để xoay token, hoặc để khớp lại secret và Valkey khi lệch (README Terraform)."
  type        = number
  default     = 1
}

variable "metrics_namespace" {
  description = "Namespace CloudWatch của metric ứng dụng (DBS-144 ghi vào DBS/Backend). Chỉ đổi khi thử dashboard bằng dữ liệu mô phỏng, để số giả không lẫn vào metric thật."
  type        = string
  default     = "DBS/Backend"

  validation {
    condition     = can(regex("^DBS/[A-Za-z0-9_./#:-]+$", var.metrics_namespace)) && length(var.metrics_namespace) <= 255
    error_message = "metrics_namespace must start with DBS/ and use only A-Z a-z 0-9 _ . / # : -."
  }
}

variable "waf_enabled" {
  description = "Bật AWS WAF gắn vào ALB (DBS-153, chỉ tuần 6-8). Đặt false sau waf_off_date để tắt hẳn (0 USD)."
  type        = bool
  default     = true
}

variable "waf_rate_limit" {
  description = "Ngưỡng rate rule của WAF (request / 5 phút / IP, mặc định 1000 theo docs/03 §12)."
  type        = number
  default     = 1000
}

variable "waf_rate_limit_exempt_cidrs" {
  description = "Danh sách IPv4 CIDR (/8-/32) miễn rate rule của WAF (vd IP máy k6 khi load test). Managed rules vẫn chạy."
  type        = list(string)
  default     = []
}

variable "waf_managed_rules_count_only" {
  description = "Khi true, chuyển AWS managed rule groups sang chế độ count để xử lý false positive mà không gỡ WAF."
  type        = bool
  default     = false
}

variable "waf_off_date" {
  description = "Ngày dự kiến tắt WAF (YYYY-MM-DD, đầu tuần 9). Nếu waf_enabled = true từ ngày này trở đi, check waf_off_date sẽ cảnh báo."
  type        = string
  default     = "2026-11-26"

  validation {
    condition     = can(regex("^\\d{4}-\\d{2}-\\d{2}$", var.waf_off_date))
    error_message = "waf_off_date must be in YYYY-MM-DD format."
  }
}
