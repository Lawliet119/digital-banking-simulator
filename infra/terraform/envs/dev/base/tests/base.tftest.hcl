mock_provider "aws" {}

variables {
  account_id = "123456789012"
}

# TC-33-09: account_id phải đúng 12 chữ số
run "rejects_malformed_account_id" {
  command = plan

  variables {
    account_id = "12345"
  }

  expect_failures = [var.account_id]
}

# TC-33-01: VPC
run "vpc" {
  command = plan

  assert {
    condition     = aws_vpc.main.cidr_block == "10.20.0.0/16"
    error_message = "unexpected VPC CIDR"
  }

  assert {
    condition     = aws_vpc.main.enable_dns_support && aws_vpc.main.enable_dns_hostnames
    error_message = "DNS support and hostnames must be enabled"
  }
}

# TC-33-02, TC-33-05 (map_public_ip), TC-33-08 (Name): 2 public + 2 private subnets in 2 AZs
run "subnets" {
  command = plan

  assert {
    condition = (
      aws_subnet.public[0].cidr_block == "10.20.0.0/24" &&
      aws_subnet.public[1].cidr_block == "10.20.1.0/24" &&
      aws_subnet.private[0].cidr_block == "10.20.10.0/24" &&
      aws_subnet.private[1].cidr_block == "10.20.11.0/24"
    )
    error_message = "unexpected subnet CIDRs"
  }

  assert {
    condition = (
      aws_subnet.public[0].availability_zone == "ap-southeast-1a" &&
      aws_subnet.public[1].availability_zone == "ap-southeast-1b" &&
      aws_subnet.private[0].availability_zone == "ap-southeast-1a" &&
      aws_subnet.private[1].availability_zone == "ap-southeast-1b"
    )
    error_message = "subnets must span two distinct AZs"
  }

  assert {
    condition     = !aws_subnet.public[0].map_public_ip_on_launch && !aws_subnet.public[1].map_public_ip_on_launch
    error_message = "public subnets must not auto-assign public IPs (ECS tasks request one explicitly)"
  }

  assert {
    condition = (
      aws_subnet.public[0].tags["Name"] == "dbs-dev-public-a" &&
      aws_subnet.private[1].tags["Name"] == "dbs-dev-private-b" &&
      aws_vpc.main.tags["Name"] == "dbs-dev-vpc"
    )
    error_message = "unexpected Name tags"
  }
}

# TC-33-03: routing. command = apply because the checks compare resource references.
run "routing" {
  command = apply

  assert {
    condition = (
      aws_route.public_internet.route_table_id == aws_route_table.public.id &&
      aws_route.public_internet.destination_cidr_block == "0.0.0.0/0" &&
      aws_route.public_internet.gateway_id == aws_internet_gateway.main.id
    )
    error_message = "public route table must default-route to the internet gateway"
  }

  assert {
    condition = alltrue([
      for i in [0, 1] :
      aws_route_table_association.public[i].subnet_id == aws_subnet.public[i].id &&
      aws_route_table_association.public[i].route_table_id == aws_route_table.public.id &&
      aws_route_table_association.private[i].subnet_id == aws_subnet.private[i].id &&
      aws_route_table_association.private[i].route_table_id == aws_route_table.private.id
    ])
    error_message = "subnets must be associated with their route tables"
  }

  # config only: the mock returns an empty set for inline routes, real proof is M-33-02
  assert {
    condition     = length(aws_route_table.private.route) == 0
    error_message = "private route table must not define inline routes"
  }
}

# TC-33-04: single gateway endpoint for S3 on both route tables
run "s3_gateway_endpoint" {
  command = apply

  assert {
    condition = (
      aws_vpc_endpoint.s3.vpc_endpoint_type == "Gateway" &&
      aws_vpc_endpoint.s3.service_name == "com.amazonaws.ap-southeast-1.s3" &&
      contains(aws_vpc_endpoint.s3.route_table_ids, aws_route_table.public.id) &&
      contains(aws_vpc_endpoint.s3.route_table_ids, aws_route_table.private.id)
    )
    error_message = "S3 must be a Gateway endpoint attached to both route tables"
  }
}

# TC-33-05: default security group (config only; real proof is M-33-02)
run "default_security_group_locked" {
  command = plan

  assert {
    condition     = length(aws_default_security_group.default.ingress) == 0 && length(aws_default_security_group.default.egress) == 0
    error_message = "default security group must have no rules"
  }
}

# TC-33-06: ECR repo
run "ecr_repository" {
  command = plan

  assert {
    condition = (
      aws_ecr_repository.api.name == "dbs-api" &&
      aws_ecr_repository.api.image_tag_mutability == "IMMUTABLE" &&
      aws_ecr_repository.api.force_delete == false
    )
    error_message = "unexpected ECR repository settings"
  }

  assert {
    condition     = aws_ecr_repository.api.image_scanning_configuration[0].scan_on_push == true
    error_message = "scan on push must be enabled"
  }

  assert {
    condition     = aws_ecr_repository.api.encryption_configuration[0].encryption_type == "AES256"
    error_message = "ECR must be encrypted with AES256"
  }

  assert {
    condition     = aws_ecr_repository.api.tags["Name"] == "dbs-api"
    error_message = "missing Name tag"
  }
}

# TC-33-07: lifecycle policy, priorities and counts
run "ecr_lifecycle" {
  command = plan

  assert {
    condition = (
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[0].rulePriority == 1 &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[0].selection.tagStatus == "untagged" &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[0].selection.countType == "sinceImagePushed" &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[0].selection.countUnit == "days" &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[0].selection.countNumber == 7
    )
    error_message = "rule 1 must expire untagged images after 7 days"
  }

  assert {
    condition = (
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[1].rulePriority == 2 &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[1].selection.tagStatus == "any" &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[1].selection.countType == "imageCountMoreThan" &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[1].selection.countNumber == 20
    )
    error_message = "rule 2 must keep the 20 newest images (tagStatus any needs the highest priority number)"
  }
}
