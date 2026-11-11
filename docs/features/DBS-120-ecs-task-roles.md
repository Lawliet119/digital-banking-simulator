# DBS-120 · ECS task role riêng cho api và worker với quyền tối thiểu

> **Status:** Draft · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev · **Nhánh:** `chore/DBS-120-ecs-task-roles` (từ `main` 17b011e) · **PR:** — · **Cập nhật:** 2026-11-11

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 4, Ưu tiên High, Deliverable P3, Status "To Do" (cần chuyển "In Progress"). **Expect:** Một tiến trình bị xâm nhập không có quyền ngoài phạm vi của nó.
- **Thực trạng trên board:** Task chưa có IAM role riêng. api không cần SQS (chỉ ghi outbox); worker gửi/nhận/xóa trên 2 queue và DLQ.
- **DoD** (nguyên văn, đánh số):
  1. Task role api: không quyền SQS, chỉ đọc secret của mình; task role worker: SQS đúng 2 queue + DLQ, đọc secret của mình
  2. Task execution role tách khỏi task role
  3. Kiểm bằng thử gọi trái quyền (api gửi SQS → AccessDenied)
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc** (board và repo khớp):

| Task | Board | Trong repo |
|---|---|---|
| DBS-34 ECS cluster, service api, ALB | Done | `envs/dev/session/ecs.tf`, `iam.tf` trên `main` |
| DBS-73 hai queue SQS + DLQ | Done | `envs/dev/base/sqs.tf` trên `main`; 4 queue có thật trên AWS (`aws sqs list-queues`), policy `dbs-dev-worker-sqs` có thật, `AttachmentCount = 0` |

- **Đã có gì** (đọc file và kiểm bằng lệnh AWS chỉ đọc, 2026-11-11):

| Role / policy | Ở đâu | Quyền hiện tại | Dùng bởi |
|---|---|---|---|
| `dbs-dev-api-execution` | `session/iam.tf:16` | `pull-image-and-write-logs` (`iam.tf:24`): `ecr:GetAuthorizationToken` trên `*`; `ecr:BatchGetImage`, `GetDownloadUrlForLayer`, `BatchCheckLayerAvailability` trên repo `dbs-api`; `logs:CreateLogStream`, `PutLogEvents` trên `/dbs/dev/api:*`. `read-db-master-secret` (`iam.tf:56`): `secretsmanager:GetSecretValue` trên secret master RDS, `kms:Decrypt` trên CMK `alias/dbs-dev` khi `kms:ViaService = secretsmanager`. `read-redis-auth-secret` (`iam.tf:80`): `GetSecretValue` trên `dbs/dev/redis-auth` | task def `dbs-api` (`ecs.tf:20`) **và** `dbs-migrate` (`ecs.tf:86`) |
| `dbs-dev-api-task` | `session/iam.tf:97` | không policy, không attachment | `dbs-api` (`ecs.tf:21`) **và** `dbs-migrate` (`ecs.tf:87`) |
| Trust của cả hai role | `session/iam.tf:1` | `sts:AssumeRole` cho `ecs-tasks.amazonaws.com`, `aws:SourceAccount` = tài khoản | — |
| `dbs-dev-worker-sqs` (managed) | `base/sqs.tf:51`, output `worker_sqs_policy_arn` (`base/outputs.tf:134`) | `SendMessage`, `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueAttributes` trên 2 queue chính; `SendMessage` trên 2 DLQ | chưa gắn role nào (BL-113) |
| Queue policy `DenyApiTaskRole` | `base/sqs.tf:91` | `Deny sqs:*` trên 4 queue cho `aws:PrincipalArn` = `role/dbs-dev-api-task` (`sqs.tf:105`) | chặn thêm một lớp |
| `iam:PassRole` của `dbs-github-deploy` | `base/deploy_role.tf:32`, `:113` | đúng 2 ARN `dbs-dev-api-execution`, `dbs-dev-api-task`, điều kiện `iam:PassedToService = ecs-tasks` | `deploy.sh`, `migrate.sh` đăng ký revision mới (giữ nguyên role của revision cũ) |

  - **Secret:** RDS master (session, `aws_db_instance.main.master_user_secret[0]`, đọc ở `ecs.tf:59-60`, `:113-114` qua `DB_USER`, `DB_PASSWORD`); `dbs/dev/redis-auth` (`base/redis_auth.tf:4`, đọc ở `ecs.tf:62` qua `REDIS_AUTH_TOKEN`); `dbs/dev/demo-accounts` (script seed Cognito, không task nào đọc). Không dùng SSM Parameter Store.
  - **Queue:** `dbs-dev-risk-events`, `dbs-dev-notification-events`, `dbs-dev-risk-events-dlq`, `dbs-dev-notification-events-dlq` (`base/sqs.tf:12`, `:20`), ARN qua output `sqs_queue_arns`, `sqs_dlq_arns`.
  - **App cần gì** (`backend/src/config/validation.schema.ts`): mọi role cần `DATABASE_URL` (`:101`) và `REDIS_URL` (`:138`), nên api và worker cần cả secret DB lẫn Redis; worker cần thêm `SQS_*_QUEUE_URL` (`:156-161`, không phải secret). Migration chỉ cần `DB_*` (`ecs.tf:202-215`). Mã app **không** gọi Secrets Manager hay KMS: SDK AWS duy nhất là `@aws-sdk/client-sqs` (`backend/package.json:66`, `libs/sqs/sqs.client.ts`); secret do ECS agent đọc bằng execution role và đưa vào biến môi trường. `OPENAI_API_KEY` (`:221`) chưa có secret trên AWS (BL-043).
  - **Trên AWS hiện giờ:** stack `session` đã destroy (không cluster, không role `dbs-dev-api-*`); `base` có queue, secret Redis, log group `/dbs/dev/api`, SG `dbs-dev-api`; role `dbs-github-deploy` chưa có trên tài khoản (BL-105, BL-109).
  - Tài liệu: docs/03 §12 dòng "Quyền tối thiểu", §13; ADR-13 (`APP_ROLE`, hai service một image); threat-model T9, T23 (`T23` đang "Thiết kế", trỏ DBS-120); feature doc [DBS-34](DBS-34-terraform-ecs-alb.md), [DBS-67](DBS-67-rds-tls-secrets.md), [DBS-68](DBS-68-migration-step.md), [DBS-73](DBS-73-terraform-sqs.md), [DBS-75](DBS-75-terraform-valkey.md), [DBS-38](DBS-38-auto-deploy-ecs.md).
- **Baseline** (`chore/DBS-120-ecs-task-roles` = `main` 17b011e, Terraform 1.16.6): `terraform fmt -check -recursive` sạch (exit 0); `init -backend=false` và `validate` đạt cả ba stack; `terraform test`: bootstrap **9 passed, 0 failed**, `base` **43 passed, 0 failed**, `session` **24 passed, 0 failed**. Không có code backend thay đổi nên không chạy baseline backend.
- **Dòng BACKLOG liên quan:**

| Dòng | Quyết định |
|---|---|
| BL-113 (gắn `dbs-dev-worker-sqs` vào role task worker; giữ tên role api khớp queue policy) | **Nhận**, xóa dòng trong PR này |
| BL-103 (DB credentials riêng cho từng role; đổi api, worker, `dbs-migrate` sang role riêng kèm execution role riêng và `iam:PassRole`) | **Nhận phần IAM** (execution role riêng, migrate có role riêng, PassRole cho migrate); phần secret/login DB `dbs_api`, `dbs_worker`, `dbs_migrator` giữ ở BL-103, sửa mô tả dòng |
| BL-105 (OIDC thật của role deploy, `environment:`) | Không nhận: không đổi trust OIDC; ghi rõ ở §8 |
| BL-114, BL-119, BL-161 (service worker, URL queue vào task def, SG/Redis cho worker) | Không nhận: DBS-121 |
| BL-107, BL-109, BL-195 (xoay mật khẩu master, chạy migrate thật, owner view) | Không nhận: không liên quan quyền IAM của task |
| BL-101, BL-027 (role cho script seed Cognito, quyền state) | Không nhận: không phải role của ECS task |
| BL-043 (secret `OPENAI_API_KEY`) | Không nhận; khi có secret này, chỉ execution role worker được đọc (ghi ở §3) |

- **Ngoài phạm vi:** service, task definition và log group của worker (DBS-121); secret và login DB riêng cho từng tiến trình (BL-103); quyền `iam:PassRole` và `ecs:UpdateService` cho service worker trong role deploy (DBS-121, khi có service để deploy); queue policy dạng allow-list cho mọi principal khác ngoài worker (threat-model T9, ghi BL ở Phase 5); OIDC thật (BL-105); WAF (BL-037). Danh sách bàn giao ở §8.
- **Câu hỏi mở** và **Quyết định ở G1** (agent tự quyết):
  1. **Tạo role worker khi chưa có service worker?** Có. DBS-121 phụ thuộc DBS-120 (board), BL-113 giao việc gắn policy cho task này. Role không có task chạy thì không cấp gì cho ai; đây không phải stub vì role là sản phẩm của chính DBS-120. Output `worker_task_role_arn`, `worker_execution_role_arn` cho DBS-121.
  2. **"Đọc secret của mình" nằm ở role nào?** Ở **execution role của từng service**. Lý do: app không gọi Secrets Manager (đã grep), secret đi vào container qua `secrets` của task definition, do ECS agent đọc bằng execution role. Cho task role quyền `GetSecretValue` là thêm quyền mà mã app không dùng, trái Expect. Vậy: task role api và worker **không có** quyền Secrets Manager hay KMS; mỗi service có execution role riêng, chỉ `GetSecretValue` đúng các secret mà task definition của nó tham chiếu. Ghi diễn giải này trong PR cho reviewer.
  3. **Tách execution role theo service?** Có: `dbs-dev-api-execution` (giữ tên), `dbs-dev-worker-execution`, `dbs-dev-migrate-execution`. Hôm nay api và worker đọc cùng hai secret, nhưng `dbs-migrate` không cần secret Redis mà vẫn đọc được (dùng chung role với api). Tách cũng là chỗ để BL-103 (secret DB riêng) và BL-043 (khóa OpenAI chỉ cho worker) gắn vào mà không mở rộng role của service khác.
  4. **Task `dbs-migrate` dùng task role nào?** **Không có task role** (bỏ `task_role_arn`). Migration chỉ nói chuyện với PostgreSQL, không gọi API AWS nào, nên container không cần credential AWS. Cách này chặt hơn một role rỗng và không cần thêm PassRole. `render-task-definition.py` chỉ chép khóa có trong revision cũ nên vẫn chạy (kiểm ở Phase 4).
  5. **Tên role api** giữ `dbs-dev-api-task` để queue policy `Deny` ở `base/sqs.tf:105` vẫn khớp (bàn giao của DBS-73). Có test khóa tên này.
  6. **Log của worker:** execution role worker được ghi log vào log group `/dbs/dev/worker` (ARN dựng theo quy ước tên); DBS-121 tạo log group đó. Ghi dòng BL cho DBS-121 để tên khớp.
  7. **Role deploy:** thêm `dbs-dev-migrate-execution` vào `iam:PassRole` (migrate.sh đăng ký revision mới với role mới); **không** thêm role worker lúc này (chưa có gì để deploy; DBS-121 thêm cùng `ecs:UpdateService` cho service worker).
  8. **Kiểm DoD 3 thế nào?** Không assume được task role từ máy (trust chỉ `ecs-tasks`); ECS Exec cần thêm `ssmmessages:*` vào task role nên bị loại; `simulate-principal-policy --resource-policy` không dùng được với principal là role (cần `--caller-arn` là IAM user, nên `aws:PrincipalArn` không bao giờ là ARN role; DBS-73 §6 V2-1). Chọn ba lớp: (a) **gọi thật** bằng task Fargate tạm `dbs-probe` (image `public.ecr.aws/aws-cli/aws-cli`, như M-34-07 của DBS-34) dưới task role api thật: `aws sqs send-message` trả `AccessDenied` với thông báo "explicit deny in a resource-based policy"; dưới task role worker thì gửi, nhận, xóa được; (b) **trường hợp xấu nhất** theo cách M-73-11 của DBS-73: trước khi dựng session, tạo role tạm **cùng tên** `dbs-dev-api-task` có `sqs:*`, assume và gọi thật, vẫn bị explicit deny; xóa ngay; (c) `simulate-principal-policy` (chỉ identity policy) và `simulate-custom-policy` (policy lấy từ `terraform show -json`) cho phần còn lại của ma trận. Cần dựng stack `session` (desired_count 0, không chạy app) rồi destroy ngay: ước tính khoảng 40 phút bật, ≈ 0,10 USD (RDS, Valkey, ALB, IPv4 theo docs/03 §13.2), task probe ≈ 0,01 USD. Phương án lùi nếu RDS không dựng được: `apply -target` **chỉ** `aws_iam_role.*`, attachment worker, các policy kéo image và ghi log, `aws_ecs_cluster.main` (những resource này không phụ thuộc RDS hay Valkey; các policy đọc secret và task def thì có nên không target), probe chạy bằng task def CLI; execution role kiểm bằng `simulate-custom-policy` trên JSON của `terraform plan -out` rồi `terraform show -json`.
  10. **Trust của task role:** thêm `ArnLike aws:SourceArn = arn:aws:ecs:ap-southeast-1:<account>:*` cạnh `aws:SourceAccount` cho hai task role (khuyến nghị chống confused deputy của ECS cho task role). Execution role giữ trust hiện tại (chỉ `aws:SourceAccount`): agent chưa có nguồn khẳng định ECS agent gửi `aws:SourceArn` khi assume execution role, và một trust sai làm task không khởi động; M-120-08 khởi động task thật bằng execution role api nên bắt được lỗi trust.
  9. **Lệch vai:** không có; task Terraform, vai #5, baseline Terraform.

**Tự kiểm G1** (2026-11-11): DoD và Expect chép nguyên văn từ `fetch-task.mjs DBS-120`; trong và ngoài phạm vi ghi rõ ở trên; "Thực trạng" kiểm bằng đọc Terraform và lệnh AWS chỉ đọc (`iam list-roles`, `iam list-policies --scope Local`, `sqs list-queues`, `secretsmanager list-secrets`, `ecs list-clusters`, `logs describe-log-groups`); hai phụ thuộc Done và có trong `main`; baseline xanh (9/43/24); mọi dòng BACKLOG cùng chủ đề đã nhận hoặc nêu tên. **G1 qua.**

## 2. Hành vi

Không có API; hệ thống là ma trận "principal → hành động → kết quả" trên AWS.

**Role sau task này:**

| Role | Loại | Quyền | Gắn vào |
|---|---|---|---|
| `dbs-dev-api-task` | task | **không có** (không inline, không attachment); queue policy `Deny sqs:*` | task def `dbs-api` |
| `dbs-dev-worker-task` | task | đúng một attachment: managed policy `dbs-dev-worker-sqs` (lấy ARN qua `terraform_remote_state`); không inline | chưa gắn task def nào (DBS-121) |
| `dbs-dev-api-execution` | execution | kéo image `dbs-api`, ghi log `/dbs/dev/api`, `GetSecretValue` đúng {secret master RDS, `dbs/dev/redis-auth`}, `kms:Decrypt` CMK qua Secrets Manager | task def `dbs-api` |
| `dbs-dev-worker-execution` | execution | kéo image `dbs-api`, ghi log `/dbs/dev/worker`, `GetSecretValue` đúng {secret master RDS, `dbs/dev/redis-auth`}, `kms:Decrypt` CMK qua Secrets Manager | chưa gắn (DBS-121) |
| `dbs-dev-migrate-execution` | execution | kéo image `dbs-api`, ghi log chỉ stream `migrate/*` của `/dbs/dev/api` (không ghi được stream `api/`), `GetSecretValue` đúng {secret master RDS}, `kms:Decrypt` CMK qua Secrets Manager | task def `dbs-migrate` (không task role) |

Cả năm role tin đúng `ecs-tasks.amazonaws.com` với `aws:SourceAccount` = tài khoản; hai task role thêm `ArnLike aws:SourceArn = arn:aws:ecs:ap-southeast-1:<account>:*` (§1 câu 10); năm tên khác nhau; không role nào có `*` trong `Action` hay `Resource` của Secrets Manager, KMS, SQS.

**Ma trận chấp nhận và từ chối.** Cột kết quả ghi kết quả simulate (chỉ identity policy, vì simulate không áp được queue policy cho role) và, nếu có, kết quả gọi thật:

| Principal | Hành động | Tài nguyên | Kết quả |
|---|---|---|---|
| task api | `sqs:SendMessage`, `ReceiveMessage`, `DeleteMessage`, `GetQueueAttributes` | 2 queue chính, 2 DLQ | simulate: `implicitDeny` (role không có Allow) · thật (probe, `send-message` tới `dbs-dev-risk-events`): `AccessDenied`, thông báo có "explicit deny in a resource-based policy" (queue policy `DenyApiTaskRole`) |
| role tạm cùng tên `dbs-dev-api-task` có `sqs:*` (trường hợp xấu nhất) | `send-message`, `receive-message` | `dbs-dev-risk-events` | thật: `AccessDenied`, "explicit deny in a resource-based policy" |
| task api | `secretsmanager:GetSecretValue` | `dbs/dev/redis-auth`, secret master | `implicitDeny` · thật: `AccessDeniedException` |
| task api | `kms:Decrypt` | CMK | `implicitDeny` |
| task worker | `SendMessage`, `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueAttributes` | `dbs-dev-risk-events`, `dbs-dev-notification-events` | `allowed` · thật: có `MessageId`, nhận và xóa được |
| task worker | `SendMessage` | 2 DLQ | `allowed` (consumer đẩy message sai schema, hợp đồng event) |
| task worker | `ReceiveMessage`, `DeleteMessage`, `PurgeQueue` | 2 DLQ | `implicitDeny` (redrive là việc của Ops) · thật: `AccessDenied` |
| task worker | `PurgeQueue`, `DeleteQueue`, `SetQueueAttributes`, `CreateQueue` | queue chính | `implicitDeny` |
| task worker | `SendMessage` | queue không thuộc dự án (ARN `dbs-dev-other`) | `implicitDeny` |
| task worker | `secretsmanager:GetSecretValue`, `kms:Decrypt` | secret Redis, secret master, CMK | `implicitDeny` |
| execution api, worker | `GetSecretValue` | secret master, `dbs/dev/redis-auth` | `allowed` |
| execution api, worker, migrate | `GetSecretValue` | `dbs/dev/demo-accounts` | `implicitDeny` |
| execution migrate | `GetSecretValue` | `dbs/dev/redis-auth` | `implicitDeny` |
| execution migrate | `GetSecretValue` | secret master | `allowed` |
| mọi execution role | `kms:Decrypt` không qua Secrets Manager (không có `kms:ViaService`) | CMK | `implicitDeny` |
| mọi execution role | `sqs:SendMessage` | queue chính | `implicitDeny` |
| execution worker | `logs:PutLogEvents` | `/dbs/dev/api` | `implicitDeny` (chỉ log group của mình) |
| execution migrate | `logs:CreateLogStream`, `PutLogEvents` | stream `api/x` của `/dbs/dev/api` | `implicitDeny`; stream `migrate/migrate/x` → `allowed` |
| role deploy (policy render từ `terraform plan` của base, `simulate-custom-policy`, context `iam:PassedToService`) | `iam:PassRole`, `PassedToService = ecs-tasks.amazonaws.com` | `dbs-dev-migrate-execution`, hai role api | `allowed` |
| role deploy | `iam:PassRole`, `PassedToService = ecs-tasks.amazonaws.com` | `dbs-dev-worker-task`, `dbs-dev-worker-execution` | `implicitDeny` (tới DBS-121) |
| role deploy | `iam:PassRole`, `PassedToService = lambda.amazonaws.com` | `dbs-dev-migrate-execution` | `implicitDeny` |

**Ca biên:**
- Task def `dbs-migrate` không có `taskRoleArn`: container không lấy được credential (`aws sts get-caller-identity` trong container sẽ lỗi "Unable to locate credentials"); migration vẫn chạy vì không gọi AWS.
- Mỗi `valueFrom` trong `secrets` của một task def phải nằm trong tập `GetSecretValue` của execution role của chính nó; thiếu thì task không khởi động (`ResourceInitializationError`), thừa là quyền dư. Test kiểm hai chiều.
- Đổi tên role api thì queue policy hết khớp: test khóa tên `dbs-dev-api-task` ở `session` và chuỗi ARN ở `base`.

## 3. Kiến trúc

- **Vị trí:** `infra/terraform/envs/dev/session/iam.tf` (thêm role worker, migrate; tách policy kéo image và log thành từng role), `session/ecs.tf` (`dbs-migrate` đổi execution role, bỏ task role), `session/outputs.tf` (thêm `worker_task_role_arn`, `worker_execution_role_arn`), `session/tests/session.tftest.hcl` (override ARN role mới, thêm `worker_sqs_policy_arn` vào base mock), `base/deploy_role.tf` (PassRole thêm migrate execution), `base/tests/deploy_role.tftest.hcl`. Không đổi code backend, không đổi `base/sqs.tf`.
- **Interface dùng:** output base `worker_sqs_policy_arn`, `redis_auth_secret_arn`, `kms_key_arn`, `ecr_repository_arn`, `api_log_group_arn`; `aws_db_instance.main.master_user_secret[0].secret_arn`. **Cung cấp** cho DBS-121: output session `worker_task_role_arn`, `worker_execution_role_arn`; log group phải tên `/dbs/dev/worker`.
- **Thứ tự apply:** `base/deploy_role.tf` đổi PassRole, `session` đổi execution role của `dbs-migrate`. Nếu dựng session mới mà chưa `apply base`, `migrate.sh` (`register-task-definition` rồi `run-task`) lỗi `iam:PassRole` trên `dbs-dev-migrate-execution`. Quy tắc: `apply base` trước lần deploy kế tiếp; ghi vào README Terraform và §8. Hiện role deploy chưa có trên tài khoản (BL-105, BL-109) nên chưa ảnh hưởng ai.
- **`render-task-definition.py`:** chỉ chép khóa có trong revision cũ (`{key: definition[key] for key in ALLOWED if key in definition}`), nên revision `dbs-migrate` không có `taskRoleArn` vẫn ra JSON không có khóa đó; test tự động TC-120-14 khóa hành vi này (fixture hiện tại luôn có `taskRoleArn`).
- **Người dùng của symbol bị đổi:** `aws_iam_role.execution`, `aws_iam_role.task` được tham chiếu ở `session/ecs.tf` (4 chỗ) và `session/tests/session.tftest.hcl` (override, run `task_definition`, `iam`, `db_secret_policy`, `redis_secret_policy`, `migrate_task_definition`). Chuỗi tên role ở `base/sqs.tf:105`, `base/deploy_role.tf:33-34`, `base/tests/sqs.tftest.hcl:154`, `base/tests/deploy_role.tftest.hcl:69`. Giữ địa chỉ resource của role api (hoặc dùng `moved` nếu đổi tên địa chỉ; session bị destroy mỗi phiên nên không có rủi ro state).
- **Dữ liệu:** không chạm database.
- **Ranh giới transaction:** không áp dụng.
- **Sơ đồ:**

```mermaid
flowchart LR
    subgraph session
        AT[dbs-dev-api-task<br/>không quyền]
        WT[dbs-dev-worker-task]
        AE[dbs-dev-api-execution]
        WE[dbs-dev-worker-execution]
        ME[dbs-dev-migrate-execution]
        TDA[task def dbs-api]
        TDM[task def dbs-migrate<br/>không task role]
    end
    subgraph base
        POL[policy dbs-dev-worker-sqs]
        Q[[2 queue + 2 DLQ<br/>Deny dbs-dev-api-task]]
        SR[secret dbs/dev/redis-auth]
    end
    SM[secret master RDS]
    TDA --> AT
    TDA --> AE
    TDM --> ME
    WT -->|attachment| POL
    POL -->|gửi, nhận, xóa| Q
    AT -.->|bị chặn| Q
    AE --> SM
    AE --> SR
    WE --> SM
    WE --> SR
    ME --> SM
```

- **Thay đổi cấp hệ thống:** không ADR mới (đúng docs/03 §12 "IAM role riêng cho task API và worker"). Phase 5 sửa: threat-model **chỉ T23** sang "Đã kiểm" kèm bằng chứng; **T9 giữ "một phần"**: queue policy chỉ chặn `dbs-dev-api-task`, mọi principal khác trong tài khoản có quyền SQS (admin, role tương lai) vẫn gửi được message giả, DBS-120 không đổi điều đó; ghi dòng BL cho queue policy dạng allow-list (Deny `sqs:SendMessage`, `ReceiveMessage`, `DeleteMessage` trừ khi `aws:PrincipalArn` thuộc {role task worker, role admin break-glass}); `infra/terraform/README.md` bảng IAM (dòng nói policy chưa gắn) và mục migration (task migrate dùng role riêng); docs/03 §12 nếu cần nêu execution role theo service.

## 4. Test cases tự động

Tất cả là `terraform test` với `mock_provider` (không cần credential), chạy bằng `terraform test` trong thư mục stack.

| ID | Truy vết | Lớp | Given · When · Then | Mong đợi |
|---|---|---|---|---|
| TC-120-01 | DoD 1 (api) | tf test session | plan session · mọi `aws_iam_role_policy` và `aws_iam_role_policy_attachment` **có tên trong config** (assert chỉ tham chiếu được resource có địa chỉ) không trỏ role api task; tên role = `dbs-dev-api-task`. "Không có policy nào" được chứng minh bằng TC-120-02 (grep) và M-120-03 (`list-role-policies`, `list-attached-role-policies` thật) | đúng |
| TC-120-02 | DoD 1 (api) | grep tĩnh (lệnh và kết quả ghi ở §8, như M-34-02b của DBS-34) | `grep -nE 'aws_iam_role\.task\b' infra/terraform/envs/dev/session/*.tf` chỉ ra khai báo role, `task_role_arn` của `dbs-api` (`ecs.tf`) và output (nếu có); `git grep -n 'dbs-dev-api-task' -- infra/terraform/envs` chỉ ra `session/iam.tf` (tên role), `base/sqs.tf` (queue policy), `base/deploy_role.tf` (PassRole) và các file test; không dòng nào là `aws_iam_role_policy*` | đúng |
| TC-120-03 | DoD 1 (worker) | tf test session | role `dbs-dev-worker-task` có đúng một `aws_iam_role_policy_attachment` với `policy_arn` = output base `worker_sqs_policy_arn`; không inline policy | đúng |
| TC-120-04 | DoD 1 (worker) | tf test base (TC-73-05 giữ nguyên) | policy `dbs-dev-worker-sqs` chỉ có action `sqs:*` liệt kê trên đúng 2 ARN queue + `SendMessage` trên 2 DLQ | đúng (chạy lại, không sửa) |
| TC-120-05 | DoD 1 (secret của mình) | tf test session | tập `Resource` của `GetSecretValue` trên execution api = {secret master, secret Redis}; worker = {secret master, secret Redis}; migrate = {secret master} | đúng, không `*` |
| TC-120-06 | DoD 1 (secret của mình) | tf test session | với `dbs-api` và `dbs-migrate`: mọi ARN (bỏ hậu tố `:key::`) trong `secrets[].valueFrom` thuộc tập `GetSecretValue` của execution role gắn với task def đó, và ngược lại | bằng nhau |
| TC-120-07 | DoD 1 | tf test session | `kms:Decrypt` của mỗi execution role chỉ trên CMK và có `kms:ViaService = secretsmanager.ap-southeast-1.amazonaws.com`; task role không có action `secretsmanager:*`, `kms:*` | đúng |
| TC-120-08 | DoD 2 | tf test session | `dbs-api`: execution = api execution, task = api task, hai ARN khác nhau; `dbs-migrate`: execution = migrate execution, `task_role_arn` null; năm tên role đôi một khác nhau | đúng |
| TC-120-09 | DoD 2 | tf test session | trust policy của năm role: `Principal.Service = ecs-tasks.amazonaws.com`, `aws:SourceAccount` = `account_id`; hai task role có thêm `ArnLike aws:SourceArn = arn:aws:ecs:ap-southeast-1:<account_id>:*` | đúng |
| TC-120-10 | DoD 1 (log) | tf test session | log statement: api execution trên `/dbs/dev/api:*`; migrate execution chỉ trên `…:log-group:/dbs/dev/api:log-stream:migrate/*`; worker execution trên `arn:aws:logs:…:log-group:/dbs/dev/worker:*`; ECR pull chỉ trên ARN repo | đúng |
| TC-120-11 | DoD 2 (deploy truyền role) | tf test base | `iam:PassRole` của role deploy = đúng {api execution, api task, migrate execution}, điều kiện `ecs-tasks`; không chứa `dbs-dev-worker-*` | đúng |
| TC-120-12 | DoD 1 (worker) | tf test session | output `worker_task_role_arn`, `worker_execution_role_arn` bằng ARN role tương ứng | đúng |
| TC-120-13 | DoD 3 | thủ công | ma trận §2 trên AWS thật | xem M-120-02, M-120-04…09 |
| TC-120-14 | DoD 2 (migrate không task role vẫn deploy được) | unit Python (`.github/scripts/tests/test_render_task_definition.py`) | phản hồi `describe-task-definition` của `dbs-migrate` **không có** `taskRoleArn`, `--container migrate` · render · thoát 0, JSON ra không có khóa `taskRoleArn`, `executionRoleArn` giữ nguyên | đúng |
| — | DoD 4 | quy trình | PR merge, CI xanh, Dev review, bảng đối chiếu | không có test |

## 5. Test thủ công

Điều kiện: profile `dbs-admin`, `ap-southeast-1`, budget alarm có; image app không cần (desired_count 0). Lệnh chạy trong bash, output thô vào `screenshots/DBS-120/manual-test.txt`, xóa id tài khoản và ARN trước khi commit. Biến dùng chung: `ACCT=$(aws sts get-caller-identity --query Account --output text)`, `Q=arn:aws:sqs:ap-southeast-1:$ACCT`.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-120-01 | `aws sts get-caller-identity`; `aws budgets describe-budgets --account-id $ACCT`; `terraform plan -out=s.tfplan` ở `envs/dev/session` (`-var image_tag=<sha main>`), `terraform show -json s.tfplan > s.json`; `terraform plan -out=b.tfplan` ở `envs/dev/base` (chỉ đọc, không apply), `terraform show -json b.tfplan > b.json` | đúng tài khoản; session tạo đủ 5 role, 1 attachment, các inline policy theo §2; base chỉ đổi `deploy-dbs-dev-api` (cộng lệch state đã biết, ghi lại nếu có) |
| M-120-02 | **Trường hợp xấu nhất, trước khi dựng session** (cách M-73-11 của DBS-73). Điều kiện: `aws iam get-role --role-name dbs-dev-api-task` → `NoSuchEntity`. Đặt `trap` dọn trước (`delete-role-policy`, `delete-role`); `create-role dbs-dev-api-task` trust chỉ IAM user đang chạy; inline `sqs:*` trên 4 queue; chờ 10 giây; `sts assume-role`; với credential đó `aws sqs send-message --queue-url <risk> --message-body '{"probe":"DBS-120"}'` và `receive-message` | cả hai lệnh: `AccessDenied`, thông báo có "explicit deny in a resource-based policy"; role tạm đã xóa (`get-role` → `NoSuchEntity`) |
| M-120-03 | `terraform apply s.tfplan` (ghi giờ bắt đầu); `aws iam list-role-policies` và `list-attached-role-policies` cho `dbs-dev-api-task`, `dbs-dev-worker-task` | api task: cả hai danh sách rỗng; worker task: không inline, attached đúng `dbs-dev-worker-sqs` |
| M-120-04 | `aws ecs describe-task-definition` cho `dbs-api` và `dbs-migrate`; `aws iam get-role` hai task role (trust) | `dbs-api`: hai role api khác nhau; `dbs-migrate`: execution migrate, không có `taskRoleArn`; trust task role có `aws:SourceArn` |
| M-120-05 | `simulate-principal-policy` **chỉ identity policy** (không `--resource-policy`) cho task api: 4 action SQS trên 4 ARN queue; `secretsmanager:GetSecretValue` 2 secret; `kms:Decrypt` CMK | tất cả `implicitDeny` (explicit deny của queue chứng minh ở M-120-02 và M-120-08) |
| M-120-06 | `simulate-principal-policy` cho task worker theo bảng §2, một lệnh cho mỗi nhóm action và tài nguyên | đúng từng ô: cho phép trên 2 queue chính và `SendMessage` 2 DLQ; từ chối DLQ receive, delete, purge; quản trị queue; queue `dbs-dev-other`; secret; KMS |
| M-120-07 | `simulate-principal-policy` cho ba execution role: `GetSecretValue` secret của mình, secret của role khác, `dbs/dev/demo-accounts`; `kms:Decrypt` **hai lần**, có và không có `--context-entries ContextKeyName=kms:ViaService,ContextKeyValues=secretsmanager.ap-southeast-1.amazonaws.com,ContextKeyType=string`; `logs:PutLogEvents` trên log group, stream khác của mình; `sqs:SendMessage`. Role deploy: `simulate-custom-policy` với policy `deploy-dbs-dev-api` lấy từ `b.json`, `iam:PassRole` trên 5 ARN role, context `iam:PassedToService` = `ecs-tasks.amazonaws.com` rồi `lambda.amazonaws.com` | đúng từng ô của bảng §2; KMS có context → `allowed`, không có → `implicitDeny`; PassRole: migrate execution và hai role api `allowed`, hai role worker `implicitDeny`, `lambda` `implicitDeny` |
| M-120-08 | **Gọi thật dưới task role api.** Đăng ký task def tạm `dbs-probe` (JSON dưới bảng) với task role `dbs-dev-api-task`, execution role `dbs-dev-api-execution`; `aws ecs run-task --cluster dbs-dev --launch-type FARGATE --task-definition dbs-probe --network-configuration 'awsvpcConfiguration={subnets=[<public-a>],securityGroups=[<sg dbs-dev-api>],assignPublicIp=ENABLED}'`; chờ `STOPPED`; đọc log stream `probe/…` | task khởi động (execution role api và trust của nó hoạt động); log có `== sqs send ==` rồi `AccessDenied` với "explicit deny in a resource-based policy"; `== secret ==` rồi `AccessDeniedException`; `== identity ==` in ARN phiên assumed-role `dbs-dev-api-task` |
| M-120-09 | **Gọi thật dưới task role worker, ca được phép và ca biên:** đăng ký revision mới `dbs-probe` với task role `dbs-dev-worker-task` (execution role vẫn là api, xem ghi chú), lệnh: `send-message` tới `dbs-dev-risk-events` body `{"probe":"DBS-120"}`, `receive-message`, `delete-message` bằng receipt handle vừa nhận, rồi `receive-message` trên `dbs-dev-risk-events-dlq` | `send` có `MessageId`; nhận đúng message đó và xóa được; DLQ `AccessDenied`; sau bước, `get-queue-attributes ApproximateNumberOfMessages` của queue chính = 0 |
| M-120-10 | **Down:** `deregister-task-definition` mọi revision `dbs-probe` rồi `delete-task-definitions`; `terraform destroy` session; kiểm còn sót từng loại: load balancer, RDS, ElastiCache, task ECS, Elastic IP, ENI `available`, role `dbs-dev-*-task`, `dbs-dev-*-execution` | không còn gì của session; queue, policy `dbs-dev-worker-sqs`, log group base vẫn còn; ghi giờ tắt; chi phí ghi ngày hôm sau (Cost Explorer) |

**Task def `dbs-probe`** (đăng ký bằng CLI, không ở Terraform; xóa ở M-120-10). Image có entrypoint `aws`, nên ghi đè `entryPoint` bằng `sh -c`. Mỗi lệnh có dòng đánh dấu riêng và `|| true`, để một lệnh bị từ chối không che lệnh sau; kết quả đọc từ log, không từ exit code.

```json
{
  "family": "dbs-probe",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "256",
  "memory": "512",
  "taskRoleArn": "arn:aws:iam::<account>:role/dbs-dev-api-task",
  "executionRoleArn": "arn:aws:iam::<account>:role/dbs-dev-api-execution",
  "containerDefinitions": [{
    "name": "probe",
    "image": "public.ecr.aws/aws-cli/aws-cli:latest",
    "essential": true,
    "entryPoint": ["sh", "-c"],
    "command": ["echo '== identity =='; aws sts get-caller-identity || true; echo '== sqs send =='; aws sqs send-message --queue-url https://sqs.ap-southeast-1.amazonaws.com/<account>/dbs-dev-risk-events --message-body '{\"probe\":\"DBS-120\"}' || true; echo '== secret =='; aws secretsmanager get-secret-value --secret-id dbs/dev/redis-auth --query Name || true; echo '== done =='"],
    "environment": [{ "name": "AWS_REGION", "value": "ap-southeast-1" }],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/dbs/dev/api",
        "awslogs-region": "ap-southeast-1",
        "awslogs-stream-prefix": "probe"
      }
    }
  }]
}
```

Revision cho M-120-09 đổi `taskRoleArn` sang `dbs-dev-worker-task` và `command` thành chuỗi `send-message` → `receive-message` (lấy `ReceiptHandle` bằng `--query 'Messages[0].ReceiptHandle' --output text`) → `delete-message` → `receive-message` trên DLQ, cùng kiểu dòng đánh dấu. Tag `latest` của image chỉ dùng cho probe tạm, không phải image ứng dụng.

**Giới hạn đã biết:** execution role worker chỉ được kiểm bằng simulate (M-120-07) tới DBS-121: log group `/dbs/dev/worker` chưa có, nên một task khởi động bằng role này sẽ lỗi ghi log. Probe dùng execution role api cho cả hai lần. DBS-121 khởi động task worker thật và kiểm lại (bàn giao ở §8).

## 6. Domain review (AI)

**Reviewer:** subagent mới, chỉ đọc (do coordinator gọi), model claude-opus-5-5, ngày 2026-11-11 · **Kết quả vòng 1:** 12 phát hiện (blocking 1, should-fix 4, minor 7), verdict REVISE · [trả lời nguyên văn](screenshots/DBS-120/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | `simulate-principal-policy --resource-policy` không dùng được với role, nên `explicitDeny` không bao giờ thấy được | đã sửa §1 câu 8, ma trận §2 (simulate api SQS = `implicitDeny`; explicit deny chỉ ghi cho gọi thật), §5: M-120-05 bỏ `--resource-policy`; explicit deny chứng minh bằng probe thật M-120-08 (thông báo "explicit deny in a resource-based policy") và role tạm cùng tên M-120-02 (cách M-73-11) |
| 2 | should-fix | Phương án lùi `-target` không miễn phí vì policy secret và task def kéo theo RDS, Valkey | đã sửa §1 câu 8: chỉ target role, attachment, policy kéo image và ghi log, cluster; execution role kiểm bằng `simulate-custom-policy` trên `terraform show -json` |
| 3 | should-fix | PassRole mới của role deploy không có bước thủ công; rủi ro thứ tự apply base/session | đã thêm dòng ma trận §2, M-120-07 (`simulate-custom-policy` trên policy render từ plan base, có `iam:PassedToService`), M-120-01 (plan base), §3 "Thứ tự apply" (apply base trước lần deploy kế tiếp, ghi README và §8) |
| 4 | should-fix | Đánh dấu T9 "Đã kiểm" là nói quá | đã sửa §3: chỉ T23 sang "Đã kiểm", T9 giữ "một phần"; BL queue policy allow-list ghi ở §8 và thêm ở Phase 5 |
| 5 | should-fix | TC-120-01 không liệt kê được mọi policy | đã sửa TC-120-01: chỉ assert resource có tên; "không có gì" dựa vào TC-120-02 và M-120-03 |
| 6 | minor | grep của TC-120-02 không neo, bỏ sót tên chuỗi | đã sửa: `grep -nE 'aws_iam_role\.task\b'` và `git grep -n 'dbs-dev-api-task' -- infra/terraform/envs`, kèm danh sách kết quả mong đợi |
| 7 | minor | Image aws-cli có entrypoint `aws`; worker execution role không được khởi động thật | đã sửa §5: JSON task def đầy đủ (`entryPoint ["sh","-c"]`, dòng đánh dấu, `\|\| true`, `assignPublicIp=ENABLED`); ghi giới hạn execution role worker chỉ simulate tới DBS-121, bàn giao §8 |
| 8 | minor | KMS cần `--context-entries kms:ViaService`; mỗi queue một lệnh | đã sửa M-120-07 (KMS có và không có context). Mục "mỗi queue một lệnh" không còn áp dụng vì không dùng `--resource-policy` nữa; simulate identity nhận nhiều `--resource-arns` một lần |
| 9 | minor | Execution role migrate ghi được stream `api/` | đã sửa §2, TC-120-10: chỉ `log-stream:migrate/*`; thêm dòng ma trận |
| 10 | minor | Trust thiếu `aws:SourceArn` | đã sửa một phần: thêm cho hai task role (§1 câu 10, §2, TC-120-09); execution role không đổi vì chưa có nguồn khẳng định ECS agent gửi `aws:SourceArn` khi assume execution role, và trust sai làm task không khởi động; M-120-08 khởi động task thật bằng execution role |
| 11 | minor | Hành vi render khi không có `taskRoleArn` để tới Phase 4 | đã thêm TC-120-14 (unit Python, fixture `dbs-migrate` không có `taskRoleArn`) và ghi ở §3 |
| 12 | minor (bàn giao) | Log group worker ở base, PassRole/UpdateService worker, SG/Redis worker, worker vẫn dùng secret master | đã ghi ở §8 "Bàn giao" (DBS-121, BL-103, BL-119); dòng BL thêm ở Phase 5 |

**Quyết định ở G2:** (ghi sau khi review vòng 2 xong)

## 7. Kế hoạch triển khai

(Phase 3.)

## 8. Kết quả

(Điền ở Phase 4–5. Phần bàn giao đã biết từ thiết kế:)

- **Bàn giao cho vai khác** (dòng BL thêm ở Phase 5):
  - DBS-121: tạo log group `/dbs/dev/worker` ở `base/logs.tf` (cạnh `/dbs/dev/api`, sống qua `destroy session`, tên khớp ARN của execution role worker); thêm `iam:PassRole` cho `dbs-dev-worker-task`, `dbs-dev-worker-execution` và `ecs:UpdateService` trên `service/dbs-dev/worker` vào `base/deploy_role.tf`; khởi động task worker thật để kiểm execution role worker (M-120-07 chỉ simulate); dùng output `worker_task_role_arn`, `worker_execution_role_arn`.
  - DBS-121 / BL-119: SG worker và ingress Redis, RDS.
  - BL-103: execution role worker và api vẫn đưa credential **master** RDS vào container; đổi sang secret `dbs_api`, `dbs_worker`, `dbs_migrator` thì chỉ sửa `Resource` của execution role tương ứng.
  - BL mới (#5): queue policy dạng allow-list để T9 thành "Đã kiểm".
  - README Terraform: `apply base` trước lần deploy kế tiếp sau khi session có `dbs-dev-migrate-execution`.
