# Stack này không khai báo provider aws (0 tài nguyên), nên không dùng mock_provider.
variables {
  state_bucket = "dbs-tfstate-123456789012-ap-southeast-1"
}

# TC-33-10: session đọc remote state của base và xuất lại giá trị mạng
run "reexports_base_network" {
  command = plan

  override_data {
    target = data.terraform_remote_state.base
    values = {
      outputs = {
        vpc_id             = "vpc-0abc"
        public_subnet_ids  = ["subnet-pub-a", "subnet-pub-b"]
        private_subnet_ids = ["subnet-prv-a", "subnet-prv-b"]
      }
    }
  }

  assert {
    condition     = output.vpc_id == "vpc-0abc"
    error_message = "vpc_id must come from base"
  }

  assert {
    condition     = output.public_subnet_ids == ["subnet-pub-a", "subnet-pub-b"]
    error_message = "public_subnet_ids must come from base"
  }

  assert {
    condition     = output.private_subnet_ids == ["subnet-prv-a", "subnet-prv-b"]
    error_message = "private_subnet_ids must come from base"
  }
}
