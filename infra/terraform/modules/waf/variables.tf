variable "name" {
  description = "Name of the WAFv2 Web ACL (1-128 characters, alphanumeric and hyphens)."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9-]{1,128}$", var.name))
    error_message = "name must be 1-128 characters containing only letters, digits, and hyphens."
  }
}

variable "resource_arn" {
  description = "ARN of the regional resource (e.g. ALB) to associate with the Web ACL."
  type        = string

  validation {
    condition     = length(trimspace(var.resource_arn)) > 0
    error_message = "resource_arn must not be empty."
  }
}

variable "rate_limit" {
  description = "Maximum requests per 5-minute window per source IP before rate-limit block (429)."
  type        = number
  default     = 1000

  validation {
    condition     = var.rate_limit >= 10 && var.rate_limit <= 2000000000 && floor(var.rate_limit) == var.rate_limit
    error_message = "rate_limit must be an integer between 10 and 2000000000."
  }
}

variable "rate_limit_exempt_cidrs" {
  description = "IPv4 CIDRs (/8 to /32) exempted from the rate-limit rule (e.g. k6 load generator IP). Managed rules still apply."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for c in var.rate_limit_exempt_cidrs :
      can(cidrhost(c, 0)) &&
      !strcontains(c, ":") &&
      can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}/([89]|[12][0-9]|3[0-2])$", c))
    ])
    error_message = "rate_limit_exempt_cidrs must contain valid IPv4 CIDRs with prefix /8 to /32 (0.0.0.0/0 and IPv6 are not allowed)."
  }
}

variable "managed_rules_count_only" {
  description = "When true, overrides AWS managed rule groups to count-only instead of blocking (for false-positive mitigation)."
  type        = bool
  default     = false
}
