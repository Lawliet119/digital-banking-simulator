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

# TC-31-06: tên bucket, tag cấu hình
run "bucket_name_and_tags" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "dbs-tfstate-123456789012-ap-southeast-1"
    error_message = "unexpected bucket name"
  }

  assert {
    condition = (
      aws_s3_bucket.state.tags["project"] == "dbs" &&
      aws_s3_bucket.state.tags["env"] == "dev" &&
      aws_s3_bucket.state.tags["owner"] == "platform"
    )
    error_message = "required tags missing"
  }

  assert {
    condition     = aws_s3_bucket.state.force_destroy == false
    error_message = "force_destroy must be false"
  }
}

# TC-31-01
run "versioning_enabled" {
  command = plan

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "versioning must be Enabled"
  }
}

# TC-31-02
run "encryption_aes256_with_bucket_key" {
  command = plan

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "SSE must be AES256"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.state.rule).bucket_key_enabled == true
    error_message = "bucket key must be enabled"
  }
}

# TC-31-03
run "public_access_fully_blocked" {
  command = plan

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.state.block_public_acls,
      aws_s3_bucket_public_access_block.state.block_public_policy,
      aws_s3_bucket_public_access_block.state.ignore_public_acls,
      aws_s3_bucket_public_access_block.state.restrict_public_buckets,
    ])
    error_message = "all four public access flags must be true"
  }
}

# TC-31-05
run "bucket_owner_enforced" {
  command = plan

  assert {
    condition     = aws_s3_bucket_ownership_controls.state.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "ownership must be BucketOwnerEnforced"
  }
}

# TC-31-08
run "outputs" {
  command = plan

  assert {
    condition     = output.state_bucket_name == "dbs-tfstate-123456789012-ap-southeast-1"
    error_message = "state_bucket_name output wrong"
  }

  assert {
    condition     = output.region == "ap-southeast-1"
    error_message = "region output wrong"
  }
}

# TC-31-04: chặn truy cập không TLS
run "denies_insecure_transport" {
  command = apply

  assert {
    condition = anytrue([
      for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement :
      s.Effect == "Deny" &&
      s.Action == "s3:*" &&
      s.Condition.Bool["aws:SecureTransport"] == "false" &&
      contains(s.Resource, aws_s3_bucket.state.arn) &&
      contains(s.Resource, "${aws_s3_bucket.state.arn}/*")
    ])
    error_message = "policy must deny s3:* over non-TLS on bucket and objects"
  }
}

# TC-31-07: lifecycle
run "lifecycle_rules" {
  command = apply

  assert {
    condition     = one(aws_s3_bucket_lifecycle_configuration.state.rule).noncurrent_version_expiration[0].noncurrent_days == 90
    error_message = "noncurrent versions must expire after 90 days"
  }

  assert {
    condition     = one(aws_s3_bucket_lifecycle_configuration.state.rule).abort_incomplete_multipart_upload[0].days_after_initiation == 7
    error_message = "incomplete multipart uploads must abort after 7 days"
  }

  assert {
    condition     = one(aws_s3_bucket_lifecycle_configuration.state.rule).expiration[0].expired_object_delete_marker == true
    error_message = "expired delete markers must be removed"
  }
}
