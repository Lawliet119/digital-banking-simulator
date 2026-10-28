# Platform & Ops (#5): domain notes

The five phases and four gates apply to #5's tasks. How test-first, the baseline and the manual test translate to Terraform and to operations runs is in `task-kinds.md` ("Infrastructure and operations"); G3 shows the expected plan summary, and the real `terraform plan` output arrives in 4b. Truth: docs/03 §12–§14, ADR-06, 10, 11, 12, `infra/terraform/README.md`.

## Direction

AWS `ap-southeast-1`, created and destroyed per working session. Kept (almost free): state bucket, ECR, VPC and subnets, Cognito, Secrets Manager, KMS, SQS, budgets. Per session: RDS, ElastiCache, ALB, ECS services, WAF. Tasks run in public subnets with a security group open only to the ALB; RDS and Valkey are private. No NAT gateway, no interface endpoints (ADR-10).

## Session protocol

**Up.** Confirm the account (`aws sts get-caller-identity`) and region; check budget alarms exist; pick the image SHA (latest `main` build). `terraform plan` is **shown to the human**; apply only on their go-ahead in this conversation, and ask then for a **pre-authorization of the end-of-session `down`** so nothing stays running while the human is away. Create the three DB roles with the master credential, run migrations as a one-off ECS task, seed through the deposit API, check `/health/ready`.

**Down.** `terraform destroy` the runtime stack, then check for leftovers service by service: NAT gateways, load balancers, RDS instances, ElastiCache clusters, ECS tasks, Elastic IPs, `available` network interfaces, regional WAF web ACLs. A tag listing is **not** proof: it misses network interfaces and Elastic IPs. Record the day's cost the next day (billing lags).

**Never** run `apply` or `destroy` against a real account without the human's go-ahead in this conversation.

## Traps of create-and-destroy

- Secrets Manager keeps a deleted secret for 7 to 30 days, so recreating the same name fails: keep secrets in the kept stack, or `recovery_window_in_days = 0` for dev.
- RDS in dev needs `skip_final_snapshot = true` and `deletion_protection = false`, or `destroy` stalls. The seed rebuilds the data.
- The ALB address changes every session: output it and point smoke tests, k6 and docs at the output.
- `destroy` can stall on network interfaces left by Fargate or the ALB; rerun after they release.
- Cost tags (`project`, `env`, `owner`) go on everything. Budget alerts only notify; cost control is the habit of `down`.

## CI/CD and runtime

Pipeline: lint, typecheck, unit, e2e (Testcontainers), one image, image and secret scan, push to ECR tagged with the commit SHA, deploy over OIDC (no static keys). The deploy job skips when the runtime stack does not exist. Migration is its own step before deploy. Two ECS services share the image, differing by `APP_ROLE`. An AWS deployment runs `NODE_ENV=staging` or `production`, which require TLS to Postgres (RDS CA bundle in the image) and Redis, `TRUST_PROXY_HOPS=1`. Rollback is the previous task definition. CI test jobs are written by #6; the deploy and scan jobs are yours.

## Operations

Dashboards, alarms (SLO table in docs/03 §14), load-test runs (from a machine in the same region, never a laptop), failure drills (RDS failover, kill a task, stop Redis, stop the worker) and cost reports are yours. #6 writes the k6 scripts; you run them, with the environment recorded next to every result. Run `npm run --silent check:invariants` from backend after every run, with the target DATABASE_URL; require exit 0 and retain the report (exit 1 means violations, 2 means check error). Raw backend/test/support/invariants.sql returns a report without mapping FAIL to a nonzero exit. Each drill becomes a row in the P4 incident table: what was done, how the system reacted, time to recover.
