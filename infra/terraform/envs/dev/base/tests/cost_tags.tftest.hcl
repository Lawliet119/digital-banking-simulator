mock_provider "aws" {
  # BL-051: ARN SNS giả đúng định dạng cho alarm_actions (provider kiểm định dạng khi apply).
  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:ap-southeast-1:123456789012:dbs-dev-alarms"
    }
  }
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id = "ap-southeast-1_ABCDEFGHI"
    }
  }
}

variables {
  account_id = "123456789012"
}

# TC-143-13: ba tag chi phí của ADR-11 được bật trong Cost allocation tags
run "cost_allocation_tags_active" {
  command = apply

  assert {
    condition     = toset(keys(aws_ce_cost_allocation_tag.this)) == toset(["project", "env", "owner"])
    error_message = "exactly the project, env and owner cost allocation tags must be managed"
  }

  assert {
    condition     = alltrue([for t in aws_ce_cost_allocation_tag.this : t.status == "Active"])
    error_message = "every cost allocation tag must be Active"
  }

  assert {
    condition     = toset([for t in aws_ce_cost_allocation_tag.this : t.tag_key]) == toset(keys(local.tags))
    error_message = "cost allocation tags must match the default_tags keys"
  }
}
