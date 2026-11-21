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
  description = "AWS region. Máy tải phải cùng region với ALB (docs/03 §14, DBS-166)."
  type        = string
  default     = "ap-southeast-1"
}

variable "instance_type" {
  description = "Cỡ EC2 chạy k6 và runner Node (ts-node, pg). t3.medium (2 vCPU, 4 GiB) đủ cho 240 RPS."
  type        = string
  default     = "t3.medium"

  validation {
    condition     = contains(["t3.small", "t3.medium", "t3.large", "c7i.large"], var.instance_type)
    error_message = "instance_type must be one of t3.small, t3.medium, t3.large, c7i.large."
  }
}
