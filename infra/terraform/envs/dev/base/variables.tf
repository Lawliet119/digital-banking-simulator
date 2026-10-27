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

variable "azs" {
  description = "Two availability zones, in order."
  type        = list(string)
  default     = ["ap-southeast-1a", "ap-southeast-1b"]

  validation {
    condition     = length(var.azs) == 2
    error_message = "Exactly two availability zones are required (ADR-10)."
  }
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "github_oidc_sub_prefix" {
  description = "Tiền tố claim `sub` GitHub gửi cho repo này. Repo bật immutable subject nên có id owner và id repo; lấy bằng `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (trường sub_claim_prefix) và so lại trước khi apply."
  type        = string
  default     = "repo:Lawliet119@168917377/digital-banking-simulator@1398975427"

  validation {
    condition     = can(regex("^repo:[A-Za-z0-9_.-]+@[0-9]+/[A-Za-z0-9_.-]+@[0-9]+$", var.github_oidc_sub_prefix))
    error_message = "github_oidc_sub_prefix must look like repo:<owner>@<owner_id>/<repo>@<repo_id> (immutable subject)."
  }
}

variable "github_branch" {
  description = "Nhánh duy nhất được assume role đẩy image."
  type        = string
  default     = "main"
}
