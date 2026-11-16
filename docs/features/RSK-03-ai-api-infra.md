# RSK-03 · Hạ tầng cho API AI: egress từ worker, secret khóa API, quyền đọc secret, hạn mức và chi phí

> **Status:** Implemented (G1–G4 tự duyệt theo `CLAUDE_local.md`) · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev · **Nhánh:** `infra/RSK-03-ai-api-infra` · **PR:** — · **Cập nhật:** 2026-11-16

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 6, High, Deliverable `P4`.
- **Thực trạng (trên board):** Chưa có đường ra `api.openai.com` cho worker (ADR-10 dùng public subnet), chưa có secret cho khóa API và chưa có hạn mức hay ngân sách đã duyệt. Khóa từng xuất hiện trong chat của người làm PR #45 đã lộ, cần thu hồi.
- **Expect:** Worker gọi được API khi bật, chỉ worker; tắt thì không có đường dùng khóa.
- **DoD:**
  1. Egress HTTPS tới `api.openai.com` chỉ cho security group của worker, `api` không có đường này (Terraform, plan khớp)
  2. Secret khóa API trong Secrets Manager (KMS DBS-154), chỉ task role worker đọc được; thu hồi khóa đã lộ và cấp khóa mới; không có khóa trong repo, image hay log
  3. Ghi hạn mức, ngân sách ngày và cảnh báo chi phí đã duyệt (nối Budget alarm DBS-4); AI tắt mặc định
  4. Tắt AI chỉ cần đổi sang phiên bản cấu hình `rule_only`, không phải dừng worker
  5. PR đã merge vào `main`; Dev review; `terraform validate` và `plan` sạch
- **Phụ thuộc:**
  - `DBS-121` (service worker `APP_ROLE=worker` trên ECS): **Done** (`infra/terraform/envs/dev/base/worker.tf`, `infra/terraform/envs/dev/session/worker.tf`)
  - `DBS-120` (ECS task role & execution role riêng cho `api` và `worker`): **Done** (`infra/terraform/envs/dev/session/iam.tf`)
  - `DBS-154` (KMS key `alias/dbs-dev` cho RDS, SQS, Secrets Manager): **Done** (`infra/terraform/envs/dev/base/kms.tf`)
- **Đã có gì:**
  - `infra/terraform/envs/dev/base/worker.tf`: SG `dbs-dev-worker` có `worker_https` (TCP 443 → `0.0.0.0/0`), không có ingress.
  - `infra/terraform/envs/dev/base/security_groups.tf`: SG `dbs-dev-api` có `api_https` (TCP 443 → `0.0.0.0/0`, bắt buộc để gọi ECR, CloudWatch Logs, Cognito JWKS theo ADR-10).
  - `infra/terraform/envs/dev/base/redis_auth.tf`: mẫu vỏ secret nằm ở `base` mã hóa bằng `aws_kms_key.main.arn`, `recovery_window_in_days = 0`, giá trị không lưu trong Terraform state.
  - `infra/terraform/envs/dev/session/worker.tf` & `iam.tf`: task definition `dbs-worker` và `dbs-dev-worker-execution` / `dbs-dev-worker-task`, hiện chưa có `OPENAI_API_KEY` hay các biến `RISK_AI_*`.
  - `backend/src/config/risk-ai.config.ts` & `validation.schema.ts`: đã định nghĩa `OPENAI_API_KEY`, `RISK_AI_EGRESS_APPROVED` (mặc định `false`), `RISK_AI_POLICY_REVISION`, `RISK_AI_DAILY_REQUEST_CAP`, `risk_ai_concurrency`, `RISK_AI_GATE_TIMEOUT_MS`.
  - `backend/src/modules/risk/ai/risk-ai.service.ts`: chỉ nạp ở role `worker`, `api` không gọi OpenAI.
- **Baseline:**
  - `infra/terraform/envs/dev/base`: `fmt -check`, `validate`, `terraform test` → **60 passed, 0 failed**.
  - `infra/terraform/envs/dev/session` (`TF_DATA_DIR=/tmp/tf-dev-session`, `AWS_EC2_METADATA_DISABLED=true`): `fmt -check`, `validate`, `terraform test` → **82 passed, 0 failed**.
  - AWS CLI (`aws sts get-caller-identity`): không có credential trong môi trường hiện tại (`NoCredentials`).
- **Ngoài phạm vi:**
  - `terraform apply` / `put-secret-value` / thu hồi khóa OpenAI lộ ở PR #45 trên tài khoản thật (không có AWS/OpenAI credential và thuộc ngoại lệ cần xác nhận người dùng theo `CLAUDE_local.md`).
  - Bật `RISK_AI_EGRESS_APPROVED = true` ở runtime (chỉ bật sau khi `RSK-05` và gate ADR-14 được duyệt, `BL-043`).
  - Sửa code backend hoặc schema DB.
- **Câu hỏi mở:**
  1. **Ngoại lệ kiến trúc đối với DoD #1 (L4 Security Group vs ADR-10):** AWS Security Group chỉ lọc L4 (IP/cổng), không lọc theo FQDN `api.openai.com`; SG `dbs-dev-api` bắt buộc giữ `api_https` (`0.0.0.0/0:443`) để lấy Cognito JWKS và gọi AWS APIs theo ADR-10 (không có NAT/VPC endpoints). *Đề xuất:* Ghi nhận ngoại lệ L4 trong Doc/README và bảo đảm cô lập AI khỏi `api` bằng Defense-in-Depth ở tầng IAM/secrets/env/ứng dụng (`api` không có `OPENAI_API_KEY`, không có IAM policy đọc secret AI, không có `RISK_AI_*`, không nạp `RiskAiService`).
  2. **Execution role vs Task role đọc secret `OPENAI_API_KEY`:** Theo `iam.tf` (DBS-120) và `risk-ai.config.ts`, app đọc `process.env.OPENAI_API_KEY` do ECS tiêm qua `secrets` của task definition bằng `dbs-dev-worker-execution`, không gọi Secrets Manager API trong runtime. *Đề xuất:* Chỉ cấp `secretsmanager:GetSecretValue` trên `dbs/dev/openai-api-key` + `kms:Decrypt` (với `kms:ViaService = secretsmanager.<region>.amazonaws.com`) cho `dbs-dev-worker-execution` **và chỉ khi `var.risk_ai_egress_approved = true`**; khi `false` (mặc định), policy và `secrets` entry đều không tồn tại ("tắt thì không có đường dùng khóa").
  3. **Hạn mức, mặc định `null` và ngân sách kết nối PostgreSQL (`db.t4g.micro`):** Theo ADR-14, không dùng giá trị ví dụ làm default production khi tắt AI. Ngoài ra, `AiGate` mở kết nối `pg.Client` ngoài pool TypeORM (`docs/03 §13.2`: `desired_count × 10 + worker_desired_count × (10 + RISK_AI_CONCURRENCY) + 5 ≤ 74`). Chi phí OpenAI thanh toán ngoài AWS (AWS Budgets DBS-4 chỉ đo hóa đơn AWS), nên hạn mức ngày được cưỡng chế bởi `AiGate` trong PostgreSQL. *Đề xuất:* Khai báo 4 biến `risk_ai_policy_revision`, `risk_ai_daily_request_cap`, `risk_ai_concurrency`, `risk_ai_gate_timeout_ms` với `default = null` (chỉ bắt buộc khác `null` khi `risk_ai_egress_approved = true`), và kiểm tra công thức kết nối DB `≤ 74` trong Terraform `validation`/`check` (ví dụ khi chạy 1 `api` + 1 `worker` với `concurrency = 5`: `10 + 15 + 5 = 30 ≤ 74`; khi chạy tối đa 6 task thì `concurrency ≤ 4`). Giá trị vận hành đề xuất khi bật: `cap = 10000` req/ngày (~$0,50/ngày với ~500 token/req ở $0,10/1M input token, ~$15/tháng, nằm gọn dưới trần Budget $150 của DBS-4), `concurrency = 4`, `gate_timeout_ms = 500`.
- **Quyết định ở G1 (tự duyệt theo `CLAUDE_local.md`):** Chấp thuận cả 3 đề xuất trên.

## 2. Hành vi

1. **Khi `risk_ai_egress_approved = false` (mặc định):**
   - `dbs-worker` task definition có `RISK_AI_EGRESS_APPROVED = "false"`, **không** tiêm `OPENAI_API_KEY` trong `secrets` và không truyền 4 biến hạn mức `RISK_AI_*`.
   - `dbs-dev-worker-execution` **không** có policy `read-openai-api-key-secret`.
   - `dbs-api` task definition, `dbs-dev-api-execution` và `dbs-dev-api-task` không bao giờ có `OPENAI_API_KEY` hay `RISK_AI_*` (cô lập hoàn toàn ở tầng IAM/secret/env/app; tầng L4 SG giữ `0.0.0.0/0:443` theo ngoại lệ ADR-10 ở §1).
2. **Khi `risk_ai_egress_approved = true`:**
   - Bắt buộc đủ 4 biến `risk_ai_policy_revision`, `risk_ai_daily_request_cap`, `risk_ai_concurrency`, `risk_ai_gate_timeout_ms` khác `null` (nếu thiếu, Terraform `check` / `validation` báo lỗi).
   - `dbs-dev-worker-execution` được cấp policy `read-openai-api-key-secret` (`secretsmanager:GetSecretValue` trên `dbs/dev/openai-api-key` và `kms:Decrypt` qua `secretsmanager.<region>.amazonaws.com`).
   - `dbs-worker` task definition tiêm `OPENAI_API_KEY` từ `local.base.openai_api_key_secret_arn` qua `secrets` và truyền đủ 4 biến hạn mức vào `environment`.
   - Kiểm tra ngân sách kết nối DB: `var.desired_count * 10 + var.worker_desired_count * (10 + coalesce(var.risk_ai_concurrency, 0)) + 5 <= 74` (`docs/03 §13.2`).
   - Validation từng biến cho phép `null` khi tắt; khi khác `null`: `cap`, `concurrency`, `gate_timeout_ms` trong `[1, 2147483647]`, `policy_revision` khớp `^[A-Za-z0-9_.:-]{1,128}$`.
   - Kiểm soát chi phí: `AiGate` cưỡng chế `daily_request_cap` trên PostgreSQL; AWS Budgets (DBS-4: $50/$100/$150) giám sát hóa đơn AWS, còn chi phí OpenAI ước tính (~$15/tháng ở 10k req/ngày) nằm trong tổng ngân sách dự án.
3. **Vỏ secret ở `base`:**
   - `aws_secretsmanager_secret.openai_api_key` (`name = "dbs/dev/openai-api-key"`) mã hóa bằng CMK `aws_kms_key.main.arn` (DBS-154), `recovery_window_in_days = 0`. Giá trị nạp ngoài băng là **chuỗi raw API key** (ví dụ `sk-...`, không bọc JSON), không bao giờ nằm trong repo, image hay Terraform state.
4. **Tắt AI không cần dừng worker:**
   - **Tắt mềm (~60s TTL cache):** tạo phiên bản cấu hình mới `mode = "rule_only"` qua `POST /v1/admin/risk-config` (UC-12), không cần dừng worker.
   - **Tắt cứng ở tầng hạ tầng:** đặt `risk_ai_egress_approved = false`, chạy `terraform apply` (tạo revision `dbs-worker` mới không có secret), và **bắt buộc** chạy ngay `aws ecs update-service --cluster dbs-dev --service worker --task-definition <new-revision> --force-new-deployment` (vì `aws_ecs_service.worker` có `ignore_changes = [task_definition]`) để thay task cũ trước/đồng thời với việc thu hồi policy `worker_read_openai_secret`.

## 3. Kiến trúc

- **Vị trí:**
  - `infra/terraform/envs/dev/base/ai_secret.tf` (mới): vỏ secret `aws_secretsmanager_secret.openai_api_key` dùng CMK `aws_kms_key.main.arn`.
  - `infra/terraform/envs/dev/base/outputs.tf`: export `openai_api_key_secret_arn`.
  - `infra/terraform/envs/dev/base/worker.tf`: ghi chú rõ egress 443 của `dbs-dev-worker` và ngoại lệ L4 ADR-10.
  - `infra/terraform/envs/dev/session/variables.tf`: thêm 5 biến `risk_ai_*` (mặc định `false` / `null`) kèm `validation` hỗ trợ `null`.
  - `infra/terraform/envs/dev/session/iam.tf`: thêm `aws_iam_role_policy.worker_read_openai_secret` (`count = var.risk_ai_egress_approved ? 1 : 0`).
  - `infra/terraform/envs/dev/session/worker.tf`: cập nhật `dbs-worker` `environment` & `secrets`, thêm `check` kiểm tra đủ 4 biến hạn mức + công thức 74 kết nối DB khi bật AI.
  - Cập nhật mock `openai_api_key_secret_arn` trong toàn bộ 6 file `infra/terraform/envs/dev/session/tests/*.tftest.hcl`; cập nhật `TC-121-02` và `TC-121-04` trong `worker.tftest.hcl` và thêm test mới cho `RSK-03`.
  - Thêm `infra/terraform/envs/dev/base/tests/ai_secret.tftest.hcl`.
- **Dữ liệu / Ranh giới transaction:** không áp dụng.
- **Thay đổi cấp hệ thống:** cập nhật `infra/terraform/README.md`, `docs/components/platform-infra/01-concept-brief.md`, `docs/features/README.md`, `docs/BACKLOG.md`.

## 4. Test cases tự động

| ID | Truy vết (DoD / AC) | Lớp | Given · When · Then | Kết quả mong đợi |
|---|---|---|---|---|
| TC-RSK03-01 | DoD #2 | `terraform test` (`base`) | Secret `dbs/dev/openai-api-key` dùng `kms_key_id = aws_kms_key.main.arn`, `recovery_window_in_days = 0`, export `openai_api_key_secret_arn` | Pass |
| TC-RSK03-02 | DoD #2, #3 (tắt mặc định) | `terraform test` (`session`) | Mặc định `risk_ai_egress_approved = false`: `dbs-worker` có `RISK_AI_EGRESS_APPROVED="false"`, không có `OPENAI_API_KEY` trong `secrets`, `worker_read_openai_secret` count = 0 | Pass |
| TC-RSK03-03 | DoD #1 (cô lập IAM/secret/env), #2 | `terraform test` (`session`) | `risk_ai_egress_approved = true` với đủ 4 biến hạn mức: chỉ `worker_execution` có policy đọc `openai_api_key_secret_arn` + `kms:Decrypt`, `worker` nhận `OPENAI_API_KEY` qua `secrets`; `api`, `api_task`, `migrate`, `db_roles`, `seed` không có quyền và không có biến AI | Pass |
| TC-RSK03-04 | DoD #3 (`validation` & DB budget) | `terraform test` (`session`) | `cap = 0`, `concurrency = 0`, `gate_timeout_ms = 0`, `policy_revision = "bad space"`, hoặc `risk_ai_egress_approved = true` mà thiếu biến hạn mức hoặc vượt 74 kết nối DB | `expect_failures` / `check` chặn đúng |
| TC-RSK03-05 | DoD #5 | `terraform fmt/validate/test` | Chạy `fmt -check`, `validate` và toàn bộ 6 suite `terraform test` trên `dev/base` và `dev/session` | Exit 0 |
| TC-RSK03-06 | DoD #2 | Secret scan | Quét không có khóa `sk-...` trong repo, Dockerfile hay env | Sạch |

## 5. Test thủ công

Điều kiện chạy: kiểm chứng offline bằng Terraform CLI (`terraform test`, `fmt`, `validate`) và quét secret; phần apply AWS thật & thu hồi khóa OpenAI PR #45 cần credential của người dùng.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-RSK03-01 | `terraform -chdir=infra/terraform/envs/dev/base fmt -check && validate && test` | Sạch, toàn bộ test pass |
| M-RSK03-02 | `TF_DATA_DIR=/tmp/tf-dev-session AWS_EC2_METADATA_DISABLED=true terraform -chdir=infra/terraform/envs/dev/session init -backend=false -input=false -lockfile=readonly && validate && test` | Sạch, toàn bộ test pass |
| M-RSK03-03 | Kiểm tra không có secret OpenAI trong repo (`grep` / `gitleaks` nếu có) | Không có phát hiện |
| M-RSK03-04 | *(AWS thật)* `terraform apply` `base` & `session`, nạp raw string API key mới vào `dbs/dev/openai-api-key`, thu hồi khóa cũ PR #45 trên OpenAI | Cần credential AWS/OpenAI (ghi `chưa chạy` nếu thiếu) |

## 6. Domain review (AI)

**Reviewer:** subagent (`pro`), 2026-11-16 · **Kết quả vòng 1:** 8 phát hiện (3 blocking, 3 should-fix, 2 minor), verdict `REVISE` · [trả lời nguyên văn](screenshots/RSK-03/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | DoD #1 L4 SG vs ADR-10 (`api_https` mở `0.0.0.0/0:443` cho JWKS) | Đã sửa §1, §2, §4: ghi rõ ngoại lệ L4 và bảo đảm cô lập AI khỏi `api` bằng IAM/secret/env/app |
| 2 | blocking | Nguy cơ cạn 74 kết nối `db.t4g.micro` khi `AiGate` mở `pg.Client` ngoài pool | Đã sửa §1, §2, §3, §4: thêm kiểm tra `desired_count * 10 + worker_desired_count * (10 + concurrency) + 5 <= 74` |
| 3 | blocking | `ignore_changes = [task_definition]` trên `aws_ecs_service.worker` làm tắt cứng không hiệu lực ngay và có thể gây `AccessDeniedException` | Đã sửa §2.4: nêu rõ bắt buộc chạy `aws ecs update-service` sau `terraform apply` |
| 4 | should-fix | Cả 6 file `dev/session/tests/*.tftest.hcl` cần mock `openai_api_key_secret_arn` | Đã sửa §3, §4: cập nhật đủ 6 file test |
| 5 | should-fix | `TC-121-02` và `TC-121-04` trong `worker.tftest.hcl` sẽ gãy nếu thêm env/secret | Đã sửa §3: cập nhật assertion của hai TC này |
| 6 | should-fix | Thiếu xử lý `null` trong `validation` và cross-validation khi `risk_ai_egress_approved = true` | Đã sửa §1, §2, §3, §4: `default = null` cho 4 biến hạn mức + kiểm tra đủ khi bật |
| 7 | minor | Chưa ghi rõ định dạng secret là raw string (không phải JSON) | Đã sửa §2.3, §5 |
| 8 | minor | Làm rõ AWS Budgets DBS-4 chỉ theo dõi hóa đơn AWS, OpenAI do `AiGate` giới hạn | Đã sửa §1, §2 |

**Reviewer vòng 2:** subagent (`pro`), 2026-11-16 · **Kết quả vòng 2:** 0 phát hiện mới · **Verdict: APPROVE**

**Quyết định ở G2 (tự duyệt theo `CLAUDE_local.md`):** Chấp thuận thiết kế sau khi đã xử lý toàn bộ 8 phát hiện.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `infra/terraform/envs/dev/base/ai_secret.tf`, `outputs.tf`, `worker.tf`, `tests/ai_secret.tftest.hcl` | `TC-RSK03-01` (`ai_secret.tftest.hcl`) | `Error: Reference to undeclared resource "aws_secretsmanager_secret" "openai_api_key"` | `terraform -chdir=infra/terraform/envs/dev/base test` | `6d0daea` |
| 2 | `infra/terraform/envs/dev/session/variables.tf`, `iam.tf`, `worker.tf`, 6 file `tests/*.tftest.hcl` | `TC-RSK03-02`, `TC-RSK03-03`, `TC-RSK03-04` (`worker.tftest.hcl`) | `Invalid index ["RISK_AI_EGRESS_APPROVED"]` & `undeclared worker_read_openai_secret` | `TF_DATA_DIR=/tmp/tf-dev-session AWS_EC2_METADATA_DISABLED=true terraform -chdir=infra/terraform/envs/dev/session test` | `27386d0` |
| 3 | `infra/terraform/README.md`, `docs/components/platform-infra/01-concept-brief.md`, `docs/BACKLOG.md`, `docs/features/README.md`, `docs/features/RSK-03-ai-api-infra.md` | `TC-RSK03-05`, `TC-RSK03-06` | — | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | — |

- **Rủi ro & cách lùi:** Chỉ thêm vỏ secret ở `base` và các biến/policy mặc định tắt ở `session` (`risk_ai_egress_approved = false`), không đổi hành vi runtime khi tắt; lùi bằng `git revert`.
- **Quyết định ở G3 (tự duyệt theo `CLAUDE_local.md`):** Chấp thuận kế hoạch 3 bước trên; thực hiện đúng quy tắc test-first cho Terraform.

## 8. Kết quả

- **Lệnh kiểm tra** (trên commit code cuối `27386d0`):
  - `terraform fmt -check -recursive -diff infra/terraform` → `FMT_OK` (exit 0)
  - `terraform -chdir=infra/terraform/envs/dev/base validate && test` → `Success! 61 passed, 0 failed.`
  - `TF_DATA_DIR=/tmp/tf-dev-session AWS_EC2_METADATA_DISABLED=true terraform -chdir=infra/terraform/envs/dev/session validate && test` → `Success! 88 passed, 0 failed.`
  - `git grep -nE "\bsk-(proj-|svcacct-)?[A-Za-z0-9]{20,}\b" -- infra/ backend/src/ docs/` → `SECRET_SCAN_CLEAN` (exit 0)
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-RSK03-01 | `base/tests/ai_secret.tftest.hcl` › `openai_api_key_secret` | đạt |
| TC-RSK03-02 | `session/tests/worker.tftest.hcl` › `rsk03_ai_disabled_by_default` | đạt |
| TC-RSK03-03 | `session/tests/worker.tftest.hcl` › `rsk03_ai_enabled_worker_only` | đạt |
| TC-RSK03-04 | `session/tests/worker.tftest.hcl` › `rsk03_rejects_bad_cap`, `rsk03_rejects_bad_revision`, `rsk03_rejects_missing_limits_when_approved`, `rsk03_rejects_db_connection_budget_overflow` | đạt |
| TC-RSK03-05 | `fmt -check -recursive`, `validate`, `terraform test` (`61/61` base, `88/88` session) | đạt (mock provider; `terraform plan` thật chờ credential AWS ở `BL-397`) |
| TC-RSK03-06 | `git grep` secret pattern check | đạt |

- **Test thủ công:** đầu ra thô tại [manual-test.txt](screenshots/RSK-03/manual-test.txt) (SHA dòng đầu `27386d0a35c2c97d0f7712e85abd36f0ffd3431c`).
  - `M-RSK03-01`: **đạt** (`61 passed, 0 failed`)
  - `M-RSK03-02`: **đạt** (`88 passed, 0 failed`)
  - `M-RSK03-03`: **đạt** (`SECRET_SCAN_CLEAN`)
  - `M-RSK03-04`: **chưa chạy** (môi trường không có AWS credential / quyền tài khoản OpenAI để thu hồi khóa lộ PR #45 và nạp khóa mới vào `dbs/dev/openai-api-key`; chuyển sang `BL-397`)
- **Phạm vi so với §7:** `git diff --stat main...HEAD` (13 file code/test Terraform, 309 insertions, 43 deletions) khớp hoàn toàn danh sách file ở §7 (`alarms.tftest.hcl` và `dashboard.tftest.hcl` được `terraform fmt` chỉnh thẳng hàng cột).
- **Ảnh chụp:** không có ảnh chụp console AWS vì chưa chạy `apply` thật (`M-RSK03-04` chưa chạy, dùng `manual-test.txt` làm bằng chứng kiểm tra Terraform).
- **Lệch so với kế hoạch:** không có.
- **Bàn giao:** `BL-397` trong [`docs/BACKLOG.md`](../BACKLOG.md) (`terraform apply` thật, thu hồi khóa OpenAI lộ PR #45, nạp khóa mới vào `dbs/dev/openai-api-key`, Dev review và merge PR).

## 9. Tài liệu đã cập nhật

- `docs/features/RSK-03-ai-api-infra.md`, `docs/features/screenshots/RSK-03/domain-review.md`, `docs/features/screenshots/RSK-03/manual-test.txt`
- `docs/features/README.md`, `docs/BACKLOG.md` (thêm `BL-397`), `docs/components/platform-infra/01-concept-brief.md`, `infra/terraform/README.md`

## Checklist G4 (tự duyệt theo `CLAUDE_local.md`)

- [x] 5/6 test case đạt đủ độ sâu (`TC-RSK03-05` đạt offline mock; `plan`/`apply` thật ghi `BL-397`)
- [x] Test thủ công chạy trên commit cuối đổi code (`27386d0`); `M-RSK03-01..03` đạt, `M-RSK03-04` ghi `chưa chạy` kèm lý do
- [x] `manual-test.txt` lưu đầy đủ, không chứa token/key/ARN thật; thiếu ảnh console AWS do `M-RSK03-04` chưa chạy
- [x] `git diff --stat main...HEAD` khớp §7
- [x] Baseline Terraform chạy lúc bàn giao (`61/61` base, `88/88` session, `fmt` sạch)
- [x] Tài liệu cập nhật đủ; `check-doc-links.mjs` sạch
- [x] Việc còn thiếu bàn giao tại §8 và `BL-397` trong `docs/BACKLOG.md`
