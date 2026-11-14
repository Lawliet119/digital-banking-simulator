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

variable "certificate_arn" {
  description = "ARN chứng chỉ ACM công khai cho listener HTTPS của ALB production (cùng tài khoản và vùng; production không dùng chứng chỉ tự ký)."
  type        = string

  validation {
    condition = (
      can(regex("^arn:aws:acm:[a-z0-9-]+:[0-9]{12}:certificate/[A-Za-z0-9-]+$", var.certificate_arn)) &&
      try(split(":", var.certificate_arn)[3], "") == var.region &&
      try(split(":", var.certificate_arn)[4], "") == var.account_id
    )
    error_message = "certificate_arn must be a valid ACM certificate ARN in the configured region and account_id."
  }
}

variable "desired_count" {
  description = "Số task api của production: 0 (chưa bật) hoặc 2..4 (HA trên 2 AZ, docs/03 §13.1)."
  type        = number
  default     = 0

  validation {
    condition     = var.desired_count == 0 || (var.desired_count >= 2 && var.desired_count <= 4)
    error_message = "desired_count must be 0 or between 2 and 4 for production HA."
  }
}

variable "worker_desired_count" {
  description = "Số task worker của production: 0..2; tổng desired_count + worker_desired_count <= 6."
  type        = number
  default     = 0

  validation {
    condition     = var.worker_desired_count >= 0 && var.worker_desired_count <= 2
    error_message = "worker_desired_count must be between 0 and 2 (docs/03 section 13.1)."
  }

  validation {
    condition     = var.desired_count + var.worker_desired_count <= 6
    error_message = "desired_count + worker_desired_count must not exceed 6 (connection pool limit, docs/03 section 13.2)."
  }
}

variable "termination_protection" {
  description = "Bảo vệ xóa cho RDS và ALB production (mặc định true). Đặt false và apply trước khi destroy."
  type        = bool
  default     = true
}

variable "db_instance_class" {
  description = "Cỡ instance RDS production (docs/03 §13.1: db.t4g.small)."
  type        = string
  default     = "db.t4g.small"
}

variable "redis_node_type" {
  description = "Loại node Valkey production (ADR-12: cache.t4g.micro)."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_auth_version" {
  description = "Phiên bản AUTH token của Valkey. Tăng một đơn vị để xoay token hoặc khớp lại secret khi lệch."
  type        = number
  default     = 1
}

variable "sqs_ops_principal_arns" {
  description = "Danh sách ARN principal vận hành được phép thao tác message/redrive SQS prod (mặc định: mọi IAM user trong tài khoản)."
  type        = list(string)
  default     = []
}
