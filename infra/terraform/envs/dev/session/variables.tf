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
  description = "Multi-AZ cho RDS. Mặc định false (Single-AZ, rẻ nhất). Đặt true chỉ khi diễn tập failover (`-var db_multi_az=true`, RDS tạo standby ở AZ khác, chi phí instance và storage ≈ gấp đôi, ≈ +0,03 USD/giờ ở db.t4g.micro 20 GB) và đặt lại false ngay sau diễn tập; production true."
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

# RSK-03 (ADR-14): hạ tầng cho API AI của worker. Mặc định tắt; chỉ bật sau khi RSK-05 và gate ADR-14 được duyệt.
variable "risk_ai_egress_approved" {
  description = "Cho phép task worker đọc secret OpenAI API key và bật đường gọi AI (RISK_AI_EGRESS_APPROVED). Mặc định false."
  type        = bool
  default     = false
}

variable "risk_ai_policy_revision" {
  description = "Phiên bản chính sách AI (RISK_AI_POLICY_REVISION). Bắt buộc khác null khi risk_ai_egress_approved = true."
  type        = string
  default     = null

  validation {
    condition     = var.risk_ai_policy_revision == null || can(regex("^[A-Za-z0-9_.:-]{1,128}$", var.risk_ai_policy_revision))
    error_message = "risk_ai_policy_revision must match ^[A-Za-z0-9_.:-]{1,128}$."
  }
}

variable "risk_ai_daily_request_cap" {
  description = "Trần số request AI mỗi ngày (RISK_AI_DAILY_REQUEST_CAP, do AiGate cưỡng chế trên PostgreSQL). Bắt buộc khi bật AI."
  type        = number
  default     = null

  validation {
    condition     = var.risk_ai_daily_request_cap == null || (floor(var.risk_ai_daily_request_cap) == var.risk_ai_daily_request_cap && var.risk_ai_daily_request_cap >= 1 && var.risk_ai_daily_request_cap <= 2147483647)
    error_message = "risk_ai_daily_request_cap must be an integer between 1 and 2147483647."
  }
}

variable "risk_ai_concurrency" {
  description = "Số request AI đồng thời tối đa (RISK_AI_CONCURRENCY). Mỗi slot mở thêm 1 kết nối PostgreSQL ngoài pool TypeORM (docs/03 §13.2)."
  type        = number
  default     = null

  validation {
    condition     = var.risk_ai_concurrency == null || (floor(var.risk_ai_concurrency) == var.risk_ai_concurrency && var.risk_ai_concurrency >= 1 && var.risk_ai_concurrency <= 2147483647)
    error_message = "risk_ai_concurrency must be an integer between 1 and 2147483647."
  }
}

variable "risk_ai_gate_timeout_ms" {
  description = "Deadline (ms) cho mỗi lần AiGate kiểm tra hạn mức PostgreSQL (RISK_AI_GATE_TIMEOUT_MS)."
  type        = number
  default     = null

  validation {
    condition     = var.risk_ai_gate_timeout_ms == null || (floor(var.risk_ai_gate_timeout_ms) == var.risk_ai_gate_timeout_ms && var.risk_ai_gate_timeout_ms >= 1 && var.risk_ai_gate_timeout_ms <= 2147483647)
    error_message = "risk_ai_gate_timeout_ms must be an integer between 1 and 2147483647."
  }
}
