# Bucket được truyền bằng: terraform init -backend-config=backend.hcl
# (backend.hcl không commit; copy từ backend.hcl.example). Phiên đo tải dùng key riêng để không đụng state thật:
#   terraform init -backend-config=backend.hcl -backend-config=key=dev/loadgen-dbs166.tfstate
terraform {
  backend "s3" {
    key          = "dev/loadgen.tfstate"
    region       = "ap-southeast-1"
    encrypt      = true
    use_lockfile = true
  }
}
