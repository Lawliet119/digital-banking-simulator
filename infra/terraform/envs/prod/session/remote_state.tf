# Dùng lại VPC, subnet, ECR, KMS, SG và Cognito từ dev/base theo infra/terraform/README.md.
data "terraform_remote_state" "base" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "dev/base.tfstate"
    region = "ap-southeast-1"
  }
}

# Lấy AZ của 2 private subnet để ghim primary và replica Valkey ở 2 AZ khác nhau.
data "aws_subnet" "private" {
  count = 2

  id = local.base.private_subnet_ids[count.index]
}
