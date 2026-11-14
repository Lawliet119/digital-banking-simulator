mock_provider "aws" {
  # BL-051: ARN SNS giả đúng định dạng cho alarm_actions (provider kiểm định dạng khi apply).
  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:ap-southeast-1:123456789012:dbs-dev-alarms"
    }
  }
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

# TC-154-04: xoay khóa tự động 365 ngày, chờ xóa 7 ngày, alias/dbs-dev
run "kms_key_rotation_and_alias" {
  command = apply

  assert {
    condition     = aws_kms_key.main.enable_key_rotation == true && aws_kms_key.main.rotation_period_in_days == 365 && aws_kms_key.main.deletion_window_in_days == 7
    error_message = "CMK must enable 365-day automatic rotation and 7-day deletion window"
  }

  assert {
    condition     = aws_kms_alias.main.name == "alias/dbs-dev" && aws_kms_alias.main.target_key_id == aws_kms_key.main.key_id
    error_message = "alias/dbs-dev must point to the CMK"
  }
}

# TC-154-01, TC-154-02, TC-154-03: key policy tối thiểu, ủy quyền IAM (root), chỉ qua 4 dịch vụ AWS
run "kms_key_policy_minimal" {
  command = apply

  assert {
    condition = (
      length(jsondecode(aws_kms_key.main.policy).Statement) == 3 &&
      toset([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Sid]) == toset([
        "AccountManagesKeyNotData",
        "UseKeyOnlyThroughAwsServices",
        "GrantsForAwsServices",
      ]) &&
      alltrue([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Effect == "Allow" && length(st.Action) > 0])
    )
    error_message = "key policy must have exactly the 3 expected Allow statements with non-empty actions"
  }

  assert {
    condition = alltrue([
      for st in jsondecode(aws_kms_key.main.policy).Statement :
      try(st.Principal.AWS, "") == "arn:aws:iam::123456789012:root" && st.Principal != "*"
    ])
    error_message = "all statements must delegate to account root (no Principal *)"
  }

  assert {
    condition     = !strcontains(aws_kms_key.main.policy, "\"kms:*\"")
    error_message = "key policy must never grant kms:*"
  }

  assert {
    condition = (
      !contains(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Action if st.Sid == "AccountManagesKeyNotData"]), "kms:Encrypt") &&
      !contains(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Action if st.Sid == "AccountManagesKeyNotData"]), "kms:Decrypt") &&
      !contains(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Action if st.Sid == "AccountManagesKeyNotData"]), "kms:ReEncryptFrom") &&
      !contains(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Action if st.Sid == "AccountManagesKeyNotData"]), "kms:ReEncryptTo") &&
      !contains(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Action if st.Sid == "AccountManagesKeyNotData"]), "kms:GenerateDataKey") &&
      !contains(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Action if st.Sid == "AccountManagesKeyNotData"]), "kms:GenerateDataKeyWithoutPlaintext") &&
      !contains(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Action if st.Sid == "AccountManagesKeyNotData"]), "kms:CreateGrant") &&
      contains(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Action if st.Sid == "AccountManagesKeyNotData"]), "kms:PutKeyPolicy") &&
      contains(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Action if st.Sid == "AccountManagesKeyNotData"]), "kms:ScheduleKeyDeletion") &&
      contains(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Action if st.Sid == "AccountManagesKeyNotData"]), "kms:CancelKeyDeletion")
    )
    error_message = "AccountManagesKeyNotData must not allow data/grant actions and must keep PutKeyPolicy/ScheduleKeyDeletion/CancelKeyDeletion"
  }

  assert {
    condition = (
      toset(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Action if st.Sid == "UseKeyOnlyThroughAwsServices"])) == toset([
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncryptFrom",
        "kms:ReEncryptTo",
        "kms:GenerateDataKey",
        "kms:GenerateDataKeyWithoutPlaintext",
      ]) &&
      one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Condition.StringEquals["kms:CallerAccount"] if st.Sid == "UseKeyOnlyThroughAwsServices"]) == "123456789012" &&
      toset(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Condition.StringEquals["kms:ViaService"] if st.Sid == "UseKeyOnlyThroughAwsServices"])) == toset([
        "rds.ap-southeast-1.amazonaws.com",
        "secretsmanager.ap-southeast-1.amazonaws.com",
        "sqs.ap-southeast-1.amazonaws.com",
        "elasticache.ap-southeast-1.amazonaws.com",
        "ec.ap-southeast-1.amazonaws.com",
      ])
    )
    error_message = "UseKeyOnlyThroughAwsServices must restrict data actions to the 4 AWS services in var.region and this account"
  }

  assert {
    condition = (
      one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Action if st.Sid == "GrantsForAwsServices"]) == "kms:CreateGrant" &&
      one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Condition.StringEquals["kms:CallerAccount"] if st.Sid == "GrantsForAwsServices"]) == "123456789012" &&
      one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Condition.Bool["kms:GrantIsForAWSResource"] if st.Sid == "GrantsForAwsServices"]) == "true"
    )
    error_message = "GrantsForAwsServices must allow CreateGrant only for AWS resources in this account"
  }
}

# TC-154-03 (domain review #9): ViaService dựng từ var.region chứ không hardcode
run "kms_policy_uses_region_variable" {
  command = apply

  variables {
    region = "us-west-2"
  }

  assert {
    condition = toset(one([for st in jsondecode(aws_kms_key.main.policy).Statement : st.Condition.StringEquals["kms:ViaService"] if st.Sid == "UseKeyOnlyThroughAwsServices"])) == toset([
      "rds.us-west-2.amazonaws.com",
      "secretsmanager.us-west-2.amazonaws.com",
      "sqs.us-west-2.amazonaws.com",
      "elasticache.us-west-2.amazonaws.com",
      "ec.us-west-2.amazonaws.com",
    ])
    error_message = "ViaService must be built from var.region"
  }
}
