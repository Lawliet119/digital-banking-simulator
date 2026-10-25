# Domain review DBS-33 (trả lời nguyên văn của reviewer)

Reviewer: subagent general-purpose, model opus, 2026-10-25.

| # | Severity | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §4 TC-33-04, TC-33-10 | You can't write these as `terraform test` assertions. TC-33-04 wants to count `aws_nat_gateway` and `aws_eip`. TC-33-10 wants to prove "no resource created". But a run block can't reference a resource type that isn't declared in the config: Terraform fails with "Reference to undeclared resource". Even if it could, an absence check would pass by default and prove nothing. ADR-10 says to verify this with `terraform plan`. | ADR-10 "Cách kiểm chứng"; doc §4 TC-33-04/10 | In `terraform test`, only assert that the one declared endpoint has `vpc_endpoint_type == "Gateway"`. Move the absence checks to a static TC: (a) grep `aws_nat_gateway\|aws_eip\|"Interface"` in `base` and grep for zero `resource "` blocks in `session`; (b) in M-33-01, run `terraform show -json tfplan \| jq '[.resource_changes[].type]\|unique'` and record the list. |
| 2 | should-fix | §5 M-33-05, §2 B10 | The expected result is wrong. On its first run, a `session` stack that only re-exports outputs does not say "No changes". It prints "Changes to Outputs" and offers to save the output values. `terraform output` stays empty until `apply` runs, so "output khớp output của base" can't be observed after just `plan`. | doc §2 B10, §5 M-33-05 | Expect "Changes to Outputs" (no resource changes) and compare the values shown in the plan. Or run a zero-resource `apply` (go-ahead needed), then `terraform output -json` and diff it against `base`. A second plan after that should say "No changes". |
| 3 | should-fix | §5 M-33-02/03, §4 TC-33-05 | B4 (the default security group has no rules) is never checked on real AWS. Under `mock_provider`, the computed `ingress`/`egress` come back as empty collections, so TC-33-05 passes whatever the config says. The default SG is also not in M-33-02's command list. | doc §2 B4, §4 TC-33-05, §5 M-33-02 | Add `aws ec2 describe-security-groups --filters Name=vpc-id,Values=<id> Name=group-name,Values=default` to M-33-02 and expect empty `IpPermissions` and `IpPermissionsEgress`. In §4, label TC-33-05's SG part as "config only". |
| 4 | should-fix | §2 B11, §1 G1 note, §5 | The rejection path of B11 (destroying `base` fails while ECR still holds an image) has no test case. IMMUTABLE and the lifecycle are checked by configuration only, on the grounds that there is no docker. But an image can be pushed with the aws cli alone: upload a config blob with `ecr initiate-layer-upload` / `upload-layer-part` / `complete-layer-upload`, then `ecr put-image` with a zero-layer manifest. | doc §1 decision, §2 B6/B11, §5 | Add M-33 steps: push tag `t1` with the CLI. Pushing `t1` again must fail with `ImageTagAlreadyExistsException` (IMMUTABLE). Run `start-lifecycle-policy-preview`. `destroy` must fail with RepositoryNotEmpty. Then `batch-delete-image` and destroy again (recovery path). |
| 5 | should-fix | §5 M-33-00 | The session protocol says to check that budget alarms exist before standing anything up, and the README says to turn the 50/100/150 USD Budget alarms on first. §1 itself says the real thresholds aren't confirmed, but no step checks them. | platform.md "Session protocol › Up"; infra/terraform/README.md "Quy ước"; doc §1 | Add `aws budgets describe-budgets --account-id <id>` to M-33-00 and expect 3 thresholds. If they're missing, stop. |
| 6 | should-fix | §1–§3 (no hand-off list) | Nothing lists what this task hands to other tasks. DBS-36 (CI push of SHA tags over OIDC) has to live with IMMUTABLE: re-running CI on the same SHA will fail the push, so it must skip if the tag exists, and there is no `latest`. It also needs an IAM push role scoped to `ecr_repository_arn`. DBS-54 (Cognito) goes into `envs/dev/base`. DBS-34 and DBS-66 must decide which stack the security groups and the DB/cache subnet groups go in. ADR-11 keeps "VPC + subnet + security group", but §1 says the SGs go "with the task that creates the resource". | ADR-11 "Quyết định" table; platform.md "CI/CD"; board DBS-34/36/54/66; doc §1 "Ngoài phạm vi" | Add a "Bàn giao" subsection with one line each for DBS-34, 36, 54, 66. State that the SGs go in `base`, per ADR-11, or record why not. |
| 7 | should-fix | §4 TC-33-07, §2 B7 | TC-33-07 doesn't assert `rulePriority`. A rule with `tagStatus = any` must have the highest `rulePriority` number. B7 also says "giữ 20 image có tag", but `any` counts untagged images too. | doc §2 B7, §4 TC-33-07 | Set explicit priorities: rulePriority 1 for untagged/sinceImagePushed/7 days, 2 for any/imageCountMoreThan/20. Assert the priorities, `tagStatus`, `countType` and `countUnit` in TC-33-07, and fix the wording, or switch to `tagged` + `tagPatternList ["*"]`. |
| 8 | should-fix | §4 TC-33-03 | Assertions that compare references (association `subnet_id == aws_subnet.x.id`, route `gateway_id == aws_internet_gateway.id`) are unknown at `command = plan` under the mock, and the run errors. The bootstrap tests already switch to `apply` for exactly this case. | infra/terraform/bootstrap/tests/bootstrap.tftest.hcl (TC-31-04/07 use `command = apply`) | Use `command = apply` for TC-33-03 and TC-33-04, and say so in §4. |
| 9 | minor | §2 B6, naming | The repo name `dbs-api` breaks the README's "tiền tố `dbs-<env>-`" rule without saying why. The real reason is that it's shared by dev and prod, because prod/session reuses dev base. | infra/terraform/README.md "Quy ước" and "Cấu trúc" | Write the exception in §2/§3 and in the README. |
| 10 | minor | §1 DoD 3, §5 M-33-07 | DoD 3 is about destroying the *daily* part (`session`), but M-33-07 only destroys `base`. Also, apply and destroy against a real account need the human's go-ahead in this conversation, and the script doesn't mark that. | doc §1 DoD 3; platform.md "Never run apply or destroy…" | Add `terraform destroy` on `session` (empty, but it exercises the flow). Mark M-33-02, M-33-07 and the re-apply as "cần go-ahead". |
| 11 | minor | §5 M-33-07 | After the VPC is deleted, `describe-network-interfaces` and `describe-addresses` without a filter don't tie the result to this VPC. Tags also don't prove anything for ENIs and EIPs. | platform.md "Down" | Filter by `vpc-id=<old id>` (and by `status=available` before destroy), and record the old VPC id first. |
| 12 | minor | §5 M-33-06 | Two overlapping `plan` runs on a stack this small finish in seconds, so the race can't be reproduced reliably. The lock behaviour also belongs to DBS-31. | doc §5 M-33-06 | Hold the lock deterministically, for example with `apply` waiting at its prompt in one terminal and `plan -lock-timeout=0` in a second. Or cite the DBS-31 result. |
| 13 | minor | §5 M-33-03 | ECR tags aren't checked, but M-33-02 promises "mọi tài nguyên có 3 tag". `describe-repositories` doesn't return tags. | doc §5 M-33-02/03 | Add `aws ecr list-tags-for-resource --resource-arn <repo arn>`. |

The core design matches ADR-10, ADR-11 and docs/03: 2 AZ, public + private subnets, private without 0.0.0.0/0, S3 gateway endpoint, no NAT, EIP or interface endpoint, `default_tags`, `allowed_account_ids`, a separate state key with `use_lockfile`. Cost if left running is about 0 USD per hour; ECR storage is 0.10 USD/GB-month. Destroying `base` leaves nothing that costs money, as long as the repo is empty.

I checked findings 1, 2, 3 and 8 against how Terraform behaves, not by running anything. On IAM and secrets there was nothing beyond what §3 already says (the user `faker` is AdministratorAccess, flagged and not changed here).

Verdict: REVISE

---

# Vòng 2 (review lại bản đã sửa, nguyên văn)

Reviewer: subagent general-purpose, model opus, 2026-10-25. Verdict: REVISE (1 blocking, 5 should-fix, 6 minor).

| # | Severity | Section | Finding | Suggested fix |
|---|---|---|---|---|
| 1 | blocking | §5 M-33-04, M-33-05 | `terraform destroy` trong M-33-04 sẽ xóa gần hết `base` (tài nguyên độc lập bị xóa song song, chỉ lifecycle policy phụ thuộc repo); M-33-05 "plan No changes" sai; thiếu "cần go-ahead". | Chứng minh B11 bằng `aws ecr delete-repository --repository-name dbs-api` (không `--force`) phải trả `RepositoryNotEmptyException`; hoặc nếu giữ destroy thì đánh dấu go-ahead, mong đợi xóa một phần, M-33-05 đổi thành `apply` rồi plan "No changes". |
| 2 | should-fix | §2 B12, M-33-04 | Đẩy lại cùng manifest cho `ImageAlreadyExistsException`, không phải `ImageTagAlreadyExistsException`. | Lần đẩy thứ hai phải là image khác dưới tag `t1` (blob cấu hình khác). |
| 3 | should-fix | §4 TC-33-10, §3 | `session` không có provider `aws` nên `mock_provider "aws"` lỗi `unknown provider`; `init` không tạo `.terraform.lock.hcl`. Bỏ `mock_provider`, giữ `override_data`; bỏ lock file khỏi danh sách `session`. | |
| 4 | should-fix | TC-33-04b | grep đệ quy trúng binary provider trong `.terraform/`. | `grep -nE '…' envs/dev/base/*.tf` |
| 5 | should-fix | TC-33-04b, M-33-01 | Máy không có `jq`. | Dùng `python3 -c` đọc plan JSON. |
| 6 | should-fix | M-33-00 | `describe-budgets` không trả ngưỡng cảnh báo. | Thêm `aws budgets describe-notifications-for-budget` cho từng budget. |
| 7 | minor | M-33-04 | `start-lifecycle-policy-preview` bất đồng bộ (cần `get-lifecycle-policy-preview`); `upload-layer-part` phải dùng `fileb://`; manifest không layer có thể bị từ chối, cần phương án dự phòng một layer gzip nhỏ; scan zero-layer = unsupported/failed. | |
| 8 | minor | TC-33-03 | Khẳng định "private không có route 0.0.0.0/0" luôn đúng dưới mock. | Assert không có `aws_route` nào gắn vào `aws_route_table.private` và route table private không có `route` inline; ghi "chỉ cấu hình". |
| 9 | minor | §3, M-33-06 | `session` chỉ khai báo `state_bucket`, nếu không `plan` sẽ hỏi `account_id`. | Ghi rõ. |
| 10 | minor | M-33-01 | `tfplan` chưa trong `.gitignore`. | Thêm `*.tfplan`, đặt tên `base.tfplan`. |
| 11 | minor | §3, TC-33-12 | README chưa ghi security group/subnet group ở `base` và ngoại lệ tên `dbs-api`. | Thêm vào phạm vi README và TC-33-12. |
| 12 | minor | TC-33-10 | `grep -c` nhiều file in từng dòng và thoát mã 1. | `! grep -q '^resource ' envs/dev/session/*.tf` |

---

# Vòng 3 (nguyên văn, tóm theo bảng của reviewer)

Reviewer: subagent general-purpose, model opus, 2026-10-25. Verdict: REVISE (0 blocking, 1 should-fix, 6 minor).

1. should-fix · M-33-04/05: `delete-repository` không `--force` sẽ **xóa thật** repo nếu repo đang rỗng (khi đẩy `t1` thất bại); thêm điều kiện `ecr list-images` có ít nhất 1 image, đánh dấu cần go-ahead.
2. minor · M-33-07: thiếu "(cần go-ahead)"; Bash không phải TTY nên apply dừng ở prompt tự hủy, cần chạy trong tab terminal riêng hoặc FIFO; thêm `git diff --exit-code` sau khi hoàn tác thay đổi tạm.
3. minor · TC-33-04b: dấu `|` trong ô bảng chưa escape; `grep` không kết quả thoát mã 1 nên phải viết `! grep -nE …`.
4. minor · TC-33-04b, M-33-01/02: danh sách loại tài nguyên không phân biệt endpoint Gateway/Interface; M-33-02 chưa kiểm `RouteTableIds` của endpoint (cả hai route table) và route của route table private (chỉ `local` + `pl-…`).
5. minor · M-33-06: `base` xuất 8 output, `session` xuất lại 3; chỉ so 3 khóa.
6. minor · TC-33-14 còn placeholder "M-33-xx"; §6 dòng 1 còn ghi `jq`.
7. minor · câu xin phép tắt cuối phiên sai thời điểm (phải xin cùng lúc go-ahead apply); G1 ghi tag bất biến kiểm bằng cấu hình, nay M-33-04 đẩy image thật, thay đổi sau G1 cần ghi và duyệt lại ở G2.

Các sửa vòng 2 được xác nhận đủ và đúng (B11, B12, `session` không mock, `python3`, budgets, TC-33-03/04/12, `fileb://`, `.gitignore`).
