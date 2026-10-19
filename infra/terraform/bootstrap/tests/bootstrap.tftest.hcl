mock_provider "aws" {}

variables {
  account_id = "123456789012"
}

# TC-31-11: account_id phải đúng 12 chữ số
run "rejects_malformed_account_id" {
  command = plan

  variables {
    account_id = "12345"
  }

  expect_failures = [var.account_id]
}
