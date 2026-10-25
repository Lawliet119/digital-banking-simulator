# Phần dựng/xóa hằng ngày (RDS, ElastiCache, ALB, ECS) thêm vào stack này ở các task sau (DBS-34, DBS-66…).
output "vpc_id" {
  value = data.terraform_remote_state.base.outputs.vpc_id
}

output "public_subnet_ids" {
  value = data.terraform_remote_state.base.outputs.public_subnet_ids
}

output "private_subnet_ids" {
  value = data.terraform_remote_state.base.outputs.private_subnet_ids
}
