# Task kinds: what changes from the default

The five phases and four gates never change. What changes is the baseline, what the manual test is, and a few naming rules. Pick the row that fits; a task can match two (a migration that is also a bug fix): do both.

| Kind | Baseline (Phase 1) | Manual test (Phase 4c) | Screenshots |
|---|---|---|---|
| **Endpoint or service** | `docker compose up -d`, then the four commands | Swagger or `curl` as the right role, the wrong role, bad input; then `psql` on the rows it wrote (balance, ledger, audit, outbox) | Swagger response, `psql` result |
| **Migration** | same | `migration:run`, `migration:revert`, `migration:run` on an empty database; `\d` the tables; insert the bad rows by hand and read the refusal | terminal, `\d` |
| **Consumer, relay or scheduled job** | same | run `APP_ROLE=worker`, produce the event, watch log and rows; kill and restart; send the same message twice | log, rows |
| **Pure logic with no runtime yet** (a fraud rule, a parser) | same | a small driver script that feeds boundary values through the function and prints the result; if even that is pointless, say "unit only" at G1 and let the human agree to it | script output |
| **CI workflow** (`.github/workflows/`) | same, plus `actionlint` if installed | a Draft PR after G3 (the human asks for it at G3) that turns CI red on purpose and then green; the run URLs are the evidence | run page |
| **Library with no caller yet** (`libs/redis`, `libs/sqs`) | same | a small driver script (kept in the PR or the feature doc) that calls it; for Redis: `docker compose pause valkey` for slow, `docker compose stop valkey` for down, then unpause or start and watch it recover | script output |
| **Bug fix** | same, **and reproduce the bug** | reproduce by hand **before** the fix and keep the output; repeat after the fix | before and after |
| **Test or harness** | same | run the suite from a clean clone, then with Docker stopped (it must fail loudly, not pass) | terminal |
| **Infrastructure code** (#5) | `terraform init -backend=false && terraform fmt -check && terraform validate` (if Terraform is not installed, say so at G1) | the DoD check against the real thing in an "Up" session the human authorized, or `aws iam simulate-principal-policy` for an IAM claim; the `terraform plan` output is 4b evidence; `apply` only with the human's go-ahead | plan output, console |
| **Operations run** (#5: load test, failure drill, cost report) | environment confirmed and recorded | the run itself, from the §5 run plan | dashboard, k6 summary, report |
| **Docs only** | link check | not applicable: say so; paste the link-check output | not applicable: say so |

## Bug fixes and board keys

- **Cannot reproduce** (the endpoint does not exist yet, or the report is wrong): stop at G1 with the evidence you gathered and say what is missing; do not "fix" a guess.
- **No board key:** ask for one; if none exists, the key is `BUG-YYYYMMDD-<slug>`. Use that whole key where the skill writes `DBS-<n>`: branch `fix/BUG-YYYYMMDD-<slug>`, doc `docs/features/BUG-YYYYMMDD-<slug>.md`, screenshots folder of the same name, gate headers. Case ids are `TC-BUG-NN` and `M-BUG-NN`.
- The doc stays short: cause, the reproducing test, the fix, the manual before and after.

## Infrastructure and operations (#5)

- **Phase 4a, test first, for Terraform:** write down the expected `terraform plan` summary first (resources to add or change, none to destroy unless intended) and the checks that must hold (tags present, tasks accept inbound only from the ALB security group and the data tier only from the task security group, no NAT gateway, encryption on). Write the checks as `terraform test` files with `mock_provider` (Terraform 1.7 or later), which need no AWS credentials or state bucket, kept in the PR; the red run is that test failing before the resource exists. G3 shows the expected plan summary; the real `terraform plan` output arrives in 4b once credentials exist.
- **Operations run:** §2 is the scenario (what load, what failure, what window), §3 the environment (sizes, task count, Redis on or off), §4 the thresholds that decide pass or fail (from docs/03 §14), §5 the run plan, §8 the numbers, the raw output and the invariant check. Never skip the invariant script after a load run.
- Domain notes and the session protocol: `platform.md`.

## When a manual step needs something not built yet

Report it at G1 and give the human a choice: (a) do the missing task first (recommended), (b) mark the steps **chưa chạy (chờ DBS-x)**, which the human must accept by name at G4. A hand-written SQL seed is allowed for the **input row of the thing under test** (a bad row to prove a constraint, an `outbox_events` row for the relay), labelled "seed SQL" in §8. Never use SQL to create balances or ledger entries: those only come from the deposit and transfer flow.
