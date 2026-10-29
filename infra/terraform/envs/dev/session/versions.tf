terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.70, < 7.0"
    }
    # Chứng chỉ self-signed cho listener HTTPS của dev (chưa có tên miền; xem docs/features/DBS-34).
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    # DBS-75: AUTH token của Valkey sinh bằng ephemeral random_password (không vào state).
    # Ephemeral của provider aws không chạy được dưới mock_provider của `terraform test`.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = local.tags
  }
}
