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
    condition     = toset(flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s.Action if s.Resource == "*"])) == toset(["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "elasticloadbalancing:DescribeLoadBalancers", "ecs:ListTasks"])
    error_message = "only RegisterTaskDefinition, DescribeTaskDefinition, DescribeLoadBalancers and ListTasks may use * (AWS has no resource-level support)"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : toset(flatten([s.Action])) == toset(["ecs:DescribeServices", "ecs:UpdateService"]) && s.Resource == "arn:aws:ecs:ap-southeast-1:123456789012:service/dbs-dev/api"])
    error_message = "DescribeServices and UpdateService only on the dbs-dev/api service"
  }

  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      flatten([s.Action]) == ["ecs:TagResource"]
      && toset(flatten([s.Resource])) == toset(["arn:aws:ecs:ap-southeast-1:123456789012:task-definition/dbs-api:*", "arn:aws:ecs:ap-southeast-1:123456789012:task-definition/dbs-migrate:*"])
      && s.Condition.StringEquals["ecs:CreateAction"] == "RegisterTaskDefinition"
    ])
    error_message = "TagResource on dbs-api and dbs-migrate task definitions, only at RegisterTaskDefinition"
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

# TC-68-12: quyền của bước migration (DBS-68)
run "deploy_policy_migration" {
  command = apply

  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      flatten([s.Action]) == ["ecs:RunTask"]
      && s.Resource == "arn:aws:ecs:ap-southeast-1:123456789012:task-definition/dbs-migrate:*"
      && s.Condition == { ArnEquals = { "ecs:cluster" = "arn:aws:ecs:ap-southeast-1:123456789012:cluster/dbs-dev" } }
    ])
    error_message = "RunTask only on dbs-migrate revisions, with ArnEquals ecs:cluster = the dbs-dev cluster ARN"
  }

  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      flatten([s.Action]) == ["ecs:StopTask"]
      && s.Resource == "arn:aws:ecs:ap-southeast-1:123456789012:task/dbs-dev/*"
      && s.Condition == { ArnEquals = { "ecs:cluster" = "arn:aws:ecs:ap-southeast-1:123456789012:cluster/dbs-dev" } }
    ])
    error_message = "StopTask only on tasks of dbs-dev, with the cluster ARN condition"
  }

  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      flatten([s.Action]) == ["ecs:DescribeTasks"]
      && s.Resource == "arn:aws:ecs:ap-southeast-1:123456789012:task/dbs-dev/*"
    ])
    error_message = "DescribeTasks only on tasks of dbs-dev"
  }

  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      flatten([s.Action]) == ["ecs:ListTasks"]
      && s.Resource == "*"
      && s.Condition == { ArnEquals = { "ecs:cluster" = "arn:aws:ecs:ap-southeast-1:123456789012:cluster/dbs-dev" } }
    ])
    error_message = "ListTasks (no resource-level support) restricted by the cluster ARN condition"
  }

  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      flatten([s.Action]) == ["ecs:TagResource"]
      && s.Resource == "arn:aws:ecs:ap-southeast-1:123456789012:task/dbs-dev/*"
      && s.Condition.StringEquals["ecs:CreateAction"] == "RunTask"
    ])
    error_message = "TagResource on tasks only at RunTask (--propagate-tags keeps the cost tags)"
  }

  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      flatten([s.Action]) == ["logs:GetLogEvents"]
      && toset(s.Resource) == toset(["${aws_cloudwatch_log_group.api.arn}:log-stream:migrate/*", "${aws_cloudwatch_log_group.api.arn}:log-stream:migrate/*:*"])
    ])
    error_message = "GetLogEvents only on the migrate/* streams of the api log group (with and without the trailing :*, the IAM simulator only matches the form ending in :*), never api/*"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.deploy.policy, "ecs:*") && !strcontains(aws_iam_role_policy.deploy.policy, "secretsmanager") && !strcontains(aws_iam_role_policy.deploy.policy, "kms:")
    error_message = "no ecs wildcard, and the deploy role can read neither secrets nor KMS"
  }
}
