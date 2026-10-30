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
