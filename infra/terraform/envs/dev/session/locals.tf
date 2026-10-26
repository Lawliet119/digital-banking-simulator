locals {
  tags = {
    project = "dbs"
    env     = "dev"
    owner   = "platform"
  }

  base = data.terraform_remote_state.base.outputs
}
