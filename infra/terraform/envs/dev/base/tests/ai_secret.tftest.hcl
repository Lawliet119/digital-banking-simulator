mock_provider "aws" {
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

# TC-RSK03-01: vỏ secret OpenAI API key ở base, mã hóa CMK DBS-154, recovery_window = 0, export ARN cho session
run "openai_api_key_secret" {
  command = apply

  assert {
    condition     = aws_secretsmanager_secret.openai_api_key.name == "dbs/dev/openai-api-key"
    error_message = "secret name must be dbs/dev/openai-api-key"
  }

  assert {
    condition     = aws_secretsmanager_secret.openai_api_key.kms_key_id == aws_kms_key.main.arn
    error_message = "secret must be encrypted with the shared CMK (DBS-154)"
  }

  assert {
    condition     = aws_secretsmanager_secret.openai_api_key.recovery_window_in_days == 0
    error_message = "dev secret must use recovery_window_in_days = 0 for clean recreate"
  }

  assert {
    condition     = output.openai_api_key_secret_arn == aws_secretsmanager_secret.openai_api_key.arn
    error_message = "openai_api_key_secret_arn must be exported for the session stack"
  }
}
