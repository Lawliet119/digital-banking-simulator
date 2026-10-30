mock_provider "aws" {
  # Giá trị giả đúng định dạng id của Cognito (provider kiểm định dạng khi apply).
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id = "ap-southeast-1_ABCDEFGHI"
    }
  }
}

variables {
  account_id = "123456789012"
}

# TC-36-01: provider OIDC của GitHub
run "oidc_provider" {
  command = plan

  assert {
    condition     = aws_iam_openid_connect_provider.github.url == "https://token.actions.githubusercontent.com"
    error_message = "unexpected OIDC provider URL"
  }

  assert {
    condition     = aws_iam_openid_connect_provider.github.client_id_list == toset(["sts.amazonaws.com"])
    error_message = "client_id_list must be exactly sts.amazonaws.com"
  }
}

# TC-36-02, TC-36-03: trust policy khóa đúng repo (có id) và nhánh main
run "trust_policy" {
  command = apply

  assert {
    condition     = length(jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement) == 1 && jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Effect == "Allow"
    error_message = "trust policy must have exactly one Allow statement"
  }

  assert {
    condition     = jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity"
    error_message = "only AssumeRoleWithWebIdentity is allowed"
  }

  assert {
    condition     = jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Principal.Federated == aws_iam_openid_connect_provider.github.arn
    error_message = "principal must be the GitHub OIDC provider"
  }

  assert {
    condition     = jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "aud must be sts.amazonaws.com"
  }

  assert {
    condition     = jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:Lawliet119@168917377/digital-banking-simulator@1398975427:ref:refs/heads/main"
    error_message = "sub must be the immutable-subject repo claim on refs/heads/main"
  }

  # TC-36-03: không StringLike, không wildcard
  assert {
    condition     = !contains(keys(jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Condition), "StringLike") && !strcontains(aws_iam_role.github_ecr_push.assume_role_policy, "*")
    error_message = "trust policy must not use StringLike or any wildcard"
  }

  assert {
    condition     = aws_iam_role.github_ecr_push.max_session_duration == 3600
    error_message = "session must be limited to one hour"
  }
}

# TC-36-04: đổi nhánh thì sub đổi theo; prefix sai bị từ chối
run "branch_changes_sub" {
  command = apply

  variables {
    github_branch = "release"
  }

  assert {
    condition     = endswith(jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"], ":ref:refs/heads/release")
    error_message = "sub must follow github_branch"
  }
}

run "rejects_prefix_without_ids" {
  command = plan

  variables {
    github_oidc_sub_prefix = "repo:abc/def"
  }

  expect_failures = [var.github_oidc_sub_prefix]
}

# TC-36-05: quyền tối thiểu
run "ecr_push_policy" {
  command = apply

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.ecr_push.policy).Statement : s if s.Resource == "*"]) == 1 && [for s in jsondecode(aws_iam_role_policy.ecr_push.policy).Statement : s if s.Resource == "*"][0].Action == "ecr:GetAuthorizationToken"
    error_message = "the only action on * must be ecr:GetAuthorizationToken"
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.ecr_push.policy).Statement : s if s.Resource != "*"]) == 1 && [for s in jsondecode(aws_iam_role_policy.ecr_push.policy).Statement : s if s.Resource != "*"][0].Resource == aws_ecr_repository.api.arn
    error_message = "all other actions must be scoped to the dbs-api repository ARN"
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.ecr_push.policy).Statement : s.Action if s.Resource != "*"])) == toset([
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:DescribeImageScanFindings",
    ])
    error_message = "unexpected action set on the repository"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.ecr_push.policy, "Delete") && !strcontains(aws_iam_role_policy.ecr_push.policy, "ecr:*")
    error_message = "no delete actions and no ecr:*"
  }
}

# TC-36-12 (hồi quy) nằm ở base.tftest.hcl: 8 run cũ không truyền biến mới.
