# Bucket được truyền bằng: terraform init -backend-config=backend.hcl
# (backend.hcl không commit; copy từ backend.hcl.example).
terraform {
  backend "s3" {
    key          = "dev/base.tfstate"
    region       = "ap-southeast-1"
    encrypt      = true
    use_lockfile = true
  }
}
