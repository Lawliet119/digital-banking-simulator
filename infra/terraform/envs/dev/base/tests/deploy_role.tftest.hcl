mock_provider "aws" {
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id = "ap-southeast-1_ABCDEFGHI"
    }
  }
}

variables {
  account_id = "123456789012"
}

# TC-38-14: trust policy của role deploy khóa đúng repo và nhánh main (cùng biến với role đẩy image)
run "deploy_trust_policy" {
  command = apply

  assert {
    condition     = length(jsondecode(aws_iam_role.github_deploy.assume_role_policy).Statement) == 1 && jsondecode(aws_iam_role.github_deploy.assume_role_policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity"
    error_message = "one statement, AssumeRoleWithWebIdentity only"
  }

  assert {
    condition     = jsondecode(aws_iam_role.github_deploy.assume_role_policy).Statement[0].Principal.Federated == aws_iam_openid_connect_provider.github.arn
    error_message = "principal must be the GitHub OIDC provider"
  }

  assert {
    condition     = jsondecode(aws_iam_role.github_deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:Lawliet119@168917377/digital-banking-simulator@1398975427:ref:refs/heads/main" && jsondecode(aws_iam_role.github_deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "sub must be the main branch of this repo (immutable subject) and aud sts.amazonaws.com"
  }

  assert {
    condition     = !strcontains(aws_iam_role.github_deploy.assume_role_policy, "*") && !strcontains(aws_iam_role.github_deploy.assume_role_policy, "StringLike")
    error_message = "no wildcard and no StringLike in the trust policy"
  }

  assert {
    condition     = aws_iam_role.github_deploy.name == "dbs-github-deploy" && aws_iam_role.github_deploy.max_session_duration == 3600
    error_message = "role dbs-github-deploy, one hour sessions"
  }
}

# TC-38-15: quyền tối thiểu
run "deploy_policy" {
  command = apply

  assert {
    condition     = toset(flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s.Action if s.Resource == "*"])) == toset(["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "elasticloadbalancing:DescribeLoadBalancers"])
    error_message = "only RegisterTaskDefinition, DescribeTaskDefinition and DescribeLoadBalancers may use * (AWS has no resource-level support)"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : toset(flatten([s.Action])) == toset(["ecs:DescribeServices", "ecs:UpdateService"]) && s.Resource == "arn:aws:ecs:ap-southeast-1:123456789012:service/dbs-dev/api"])
    error_message = "DescribeServices and UpdateService only on the dbs-dev/api service"
  }

  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      flatten([s.Action]) == ["ecs:TagResource"]
      && s.Resource == "arn:aws:ecs:ap-southeast-1:123456789012:task-definition/dbs-api:*"
      && s.Condition.StringEquals["ecs:CreateAction"] == "RegisterTaskDefinition"
    ])
    error_message = "TagResource only on dbs-api task definitions and only at RegisterTaskDefinition"
  }

  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      flatten([s.Action]) == ["iam:PassRole"]
      && toset(s.Resource) == toset(["arn:aws:iam::123456789012:role/dbs-dev-api-execution", "arn:aws:iam::123456789012:role/dbs-dev-api-task"])
      && s.Condition.StringEquals["iam:PassedToService"] == "ecs-tasks.amazonaws.com"
    ])
    error_message = "PassRole only for the two task roles and only to ecs-tasks"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : flatten([s.Action]) == ["ecr:BatchGetImage"] && s.Resource == aws_ecr_repository.api.arn])
    error_message = "ecr:BatchGetImage only on the dbs-api repository"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.deploy.policy, "ecs:*") && !strcontains(aws_iam_role_policy.deploy.policy, "iam:*") && !strcontains(aws_iam_role_policy.deploy.policy, "Delete") && !strcontains(aws_iam_role_policy.deploy.policy, "ecr:Put")
    error_message = "no wildcard actions, no delete, no image push"
  }

  assert {
    condition     = output.github_deploy_role_arn == aws_iam_role.github_deploy.arn
    error_message = "deploy role arn must be exported"
  }
}
