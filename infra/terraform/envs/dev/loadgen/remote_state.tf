data "terraform_remote_state" "base" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "dev/base.tfstate"
    region = "ap-southeast-1"
  }
}
