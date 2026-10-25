# Domain review DBS-34 (vòng 1, subagent opus, 2026-10-26), trả lời nguyên văn

| # | Severity | Section | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| 1 | blocking | §1 câu 3, G1, §2, §3 | Listener chỉ HTTP lệch khỏi NFR-SEC-03 ("100% kết nối mã hóa") và docs/03 §12 ("TLS ở ALB"). Chính doc ghi "Đây là quyết định bảo mật… bạn có thể chọn hoãn", nhưng lại tự duyệt ở G1. Doc nói rủi ro "ghi rõ ở §2", nhưng §2 chỉ có "ALB nhận (chỉ HTTP, dev)". §3 ghi "docs/03 không đổi (đã khớp)", trong khi §12 không khớp. HTTPS giao cho DBS-38 nhưng DoD của DBS-38 không có HTTPS. Khi DBS-54 thêm Cognito, JWT đi trên HTTP qua internet. Ingress là `0.0.0.0/0`. | docs/02 dòng 281; docs/03 §12 bảng "Mã hóa"; CLAUDE_local.md (câu hỏi đụng kiến trúc hoặc NFR thì dừng và hỏi); fetch-task DBS-38 | Đưa câu 3 về cho người dùng quyết định thật. (a) import chứng chỉ self-signed vào ACM (miễn phí, không cần domain), listener 443, kiểm bằng `curl -k`, :80 chuyển hướng sang 443; hoặc (b) biến `alb_ingress_cidrs`, mặc định là IP của người chạy. Ghi rủi ro vào §2. Mở dòng BACKLOG cho HTTPS và giao đúng task. Ghi độ lệch so với docs/03 §12 ở §3. |
| 2 | should-fix | §3, §4 TC-34-03 | Service ECS khai báo `load_balancer` mà không `depends_on` listener: CreateService báo lỗi khi listener chưa tạo xong. | aws_ecs_service chỉ tham chiếu `target_group_arn` | `depends_on = [aws_lb_listener.http]`. |
| 3 | should-fix | §1 câu 2, §2 | `desired_count` mặc định 1; với `NODE_ENV=staging` app từ chối khởi động vì thiếu `DATABASE_URL`, `REDIS_URL` (`rediss`), `DATABASE_SSL=true`, `COGNITO_*`; task chết liên tục và tốn tiền. | validation.schema.ts | Mặc định `desired_count = 0` cho tới khi DBS-66/67/54 xong; bảng "biến còn thiếu → task lo". |
| 4 | should-fix | §3, §6 bàn giao | Hợp đồng với DBS-38 chưa có: nếu Terraform quản `image_tag`, mỗi lần `apply` trả image về giá trị của biến (drift) hoặc deploy ghi đè Terraform. Bàn giao DBS-67 thiếu: execution role cần `secretsmanager:GetSecretValue` (và `kms:Decrypt`). | fetch-task DBS-38 DoD; DBS-67 DoD | Chốt `terraform apply -var image_tag=<sha>` hoặc `ignore_changes = [task_definition]`; ghi BACKLOG cho DBS-38 và DBS-67. |
| 5 | should-fix | §1 câu 5, §3 | Log group trong `session` mâu thuẫn README ("Giữ lại: … logs") và ADR-11; mỗi lần `destroy` mất log (bằng chứng cho P4, diễn tập sự cố). | README; ADR-11 dòng 82 | Chuyển log group sang `base` (giữ 7 ngày) hoặc sửa README/ADR-11. |
| 6 | should-fix | §4 TC-34-09, TC-34-12 | "Task role không có policy nào" không assert được trong `terraform test`; data source dưới `mock_provider` trả chuỗi ngẫu nhiên nên assert về trust, ARN managed policy, region sai; override `terraform_remote_state` hiện có không chứa output mới nên test cũ lỗi. | DBS-36 §3; session.tftest.hcl | Dùng `jsonencode` cho trust/policy, ARN managed policy viết thẳng, region từ biến; "task role rỗng" bằng kiểm tĩnh; override đủ output mới, thêm `account_id`. |
| 7 | should-fix | §5 M-34-02, M-34-08 | Lệnh chưa chạy được: `plan` và `destroy` của `session` cần `state_bucket`, `account_id`, `image_tag`; DoD 4 "trong một lệnh" nhưng không có lệnh cụ thể. | variables.tf của session; README | Viết nguyên lệnh kèm đủ `-var`, đưa vào README. |
| 8 | should-fix | §5 M-34-09 | Kiểm sót tài nguyên chưa đủ: ENI `in-use` còn IPv4 công khai; `describe-addresses` không thấy IPv4 của ALB; ENI của ALB nhả chậm; `list-clusters` không lọc tên. | platform.md "Down" | `describe-network-interfaces --filters Name=vpc-id,...` (mọi trạng thái) rỗng, chạy lại sau 5 phút; thêm `list-tasks`, `describe-clusters`, `describe-target-groups`. |
| 9 | minor | §5 M-34-07, ADR-10 | ADR-10 "Cách kiểm chứng" giao DBS-34 hai việc: curl thẳng IP task phải timeout, qua ALB phải ra 200. Ca timeout làm được ngay bằng một task tạm với image công khai (python `http.server 3000`) trong SG `api`. | docs/adr/0010 | Thêm `aws ecs run-task` một lần rồi dừng. |
| 10 | minor | §2 Health/ALB | `deregistration_delay` mặc định 300 s; `drop_invalid_header_fields` chưa bật; `containerInsights` chưa nêu. | provider mặc định | `deregistration_delay = 30`, `drop_invalid_header_fields = true`, `containerInsights = disabled`. |
| 11 | minor | §2 IAM | Managed `AmazonECSTaskExecutionRolePolicy` cấp ECR và Logs trên `*`; trust chưa có `aws:SourceAccount`. | NFR-SEC-06 | Inline policy theo ARN repo và log group; thêm `Condition StringEquals aws:SourceAccount`. |
| 12 | minor | §2 Task → ra ngoài | Egress 443 đủ để kéo image, Logs, JWKS, SQS, Secrets Manager; bàn giao thiếu egress 6379 tới SG Redis. | ADR-10; docs/03 §12 | Ghi bàn giao: 5432 cho DBS-66, 6379 cho task ElastiCache (SG-to-SG). |
| 13 | minor | §2 Chi phí | ALB ≈ 0,0225 USD/giờ (giá us-east-1); ADR-11 dùng ≈ 0,03. | ADR-11 dòng 75 | Dùng con số ADR-11. |
| 14 | minor | §4 câu cuối, §5 | "DoD 4 chứng minh bằng M-34-04…M-34-06" sai bước (phải là M-34-03, 08, 09); M-34-05/06 cần ARN target group và task definition nhưng §3 không có output; M-34-04 cần retry vì DNS ALB mới có thể chưa phân giải (curl `000`). | §3 outputs | Sửa số bước, thêm output `target_group_arn`, `task_definition_arn`, retry. |
| 15 | minor | §3 | Thêm provider vào `session` cần `required_providers` và commit `.terraform.lock.hcl`; thiếu biến `region`; README phải bỏ câu "stack này không có provider…". | README; DBS-33 §3 | Thêm vào §3. |
| 16 | minor | §4 TC-34-07 | Lọc theo tên chứa `KEY`/`TOKEN` báo nhầm `IDEMPOTENCY_KEY_RETENTION_DAYS`, `ACCESS_TOKEN_TTL_SECONDS`. | validation.schema.ts | Danh sách cấm tường minh và allowlist. |

Đã kiểm và đúng: health check khớp docs/03 §13.3; grace 60 s; `/health/ready` không có version prefix; `TRUST_PROXY_HOPS=1` đúng cho một ALB; `X86_64` đúng; validation 40 hex khớp tag `github.sha`; ALB dùng 2 public subnet ở 2 AZ; 503 khi không có target là đúng; base hiện có 13 run.

Verdict: REVISE

---

# Vòng 2 (subagent opus, 2026-10-26), trả lời nguyên văn

Đã sửa xong từ vòng 1: 2, 3, 4, 5, 6, 8, 9 (một phần), 10, 11, 12, 14, 15, 16. Không có phát hiện blocking.

| # | Severity | Section | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §2 Execution role, §4 TC-34-09 | Inline policy giới hạn Logs theo "ARN log group" lấy từ output base `api_log_group_arn`. Với provider AWS ≥ 4 (repo ghim `~> 6.0`), `aws_cloudwatch_log_group.arn` không còn hậu tố `:*`. `logs:CreateLogStream`/`PutLogEvents` tác động lên log-stream (`…:log-group:/dbs/dev/api:log-stream:*`); policy trên ARN trần bị từ chối, task thật lỗi `ResourceInitializationError` khi khởi động (chỉ thấy ở M-34-10). | base/versions.tf `~> 6.0`; doc dòng 54, 82 | Resource `"${api_log_group_arn}:*"` cho các action Logs; ECR `BatchGetImage`/`GetDownloadUrlForLayer` (cùng `BatchCheckLayerAvailability`) trên ARN repo, `GetAuthorizationToken` trên `*`. TC-34-09 assert đúng chuỗi Resource. |
| 2 | should-fix | §5 M-34-07 | Bước mới có thể đạt giả. (a) Public subnet có `map_public_ip_on_launch = false`, bước không nói `assignPublicIp=ENABLED`, không có IP công khai. (b) Không kiểm task đã RUNNING; nếu pull lỗi hoặc task dừng thì `curl -m 10` cũng timeout, kết quả "bị SG chặn" không được chứng minh. (c) Nửa còn lại của ADR-10 ("Qua ALB → 200") vẫn hoãn, dù task tạm làm được ngay. | base/network.tf; ADR-10 "Cách kiểm chứng"; doc dòng 137, 140 | Ghi rõ `--launch-type FARGATE --network-configuration awsvpcConfiguration={subnets=[pub-a],securityGroups=[sg-api],assignPublicIp=ENABLED}`, family khác `dbs-api`; `aws ecs wait tasks-running` và `describe-tasks` (RUNNING) trước khi curl; thêm đối chứng dương: lệnh `sh -c "mkdir -p health && echo ok > health/ready && python -m http.server 3000"`, rồi `register-targets` IP task, `describe-target-health` = healthy, `curl -sk https://<alb>/health/ready` = 200; sau đó `deregister-targets`, `stop-task`, deregister task definition trước M-34-08. |
| 3 | minor | §1 câu 3, §3 `tls.tf` | Đặc tả chứng chỉ self-signed quá mỏng: `tls_self_signed_cert` cần `allowed_uses` và `validity_period_hours`; ACM/ALB chỉ nhận RSA 2048/3072/4096, ECDSA P-256/P-384. | hashicorp/tls schema | `tls_private_key` RSA 2048, `common_name` (ví dụ `dbs-dev.local`), `allowed_uses = ["key_encipherment","digital_signature","server_auth"]`, `validity_period_hours = 720`; assert `ssl_policy`/`certificate_arn` ở TC-34-05. |
| 4 | minor | §1 câu 6 | Chi phí còn "≈ 0,0225 USD/giờ" ở §1 trong khi §2 dùng 0,03 (ADR-11). | doc dòng 34 vs 77 | Dùng 0,03 cả hai nơi. |
| 5 | minor | §5 M-34-00, M-34-01, M-34-09 | Lệnh `plan`/`apply` của base thiếu `-var account_id=<id>`; `describe-clusters --clusters dbs-dev` sau destroy trả cluster `INACTIVE`, không rỗng. | base/variables.tf; README dòng 90 | Viết `terraform plan -out=base.tfplan -var account_id=<id>` / `apply base.tfplan`; kỳ vọng `status INACTIVE` hoặc `failures`. |
| 6 | minor | §1 câu 3, §2 "Rủi ro còn lại" | Chủ của BACKLOG cho chứng chỉ công khai vẫn là "DBS-38 hoặc tuần 6–8"; DBS-38 chỉ là pipeline deploy, không có domain/chứng chỉ. | fetch-task DBS-38 | Gán một chủ (dòng BACKLOG mới cho việc WAF/ALB tuần 6–8), không phải DBS-38. |

Verdict: REVISE

---

# Vòng 3 (subagent opus, 2026-10-26), trả lời nguyên văn

6/6 phát hiện vòng 2 đã sửa. Phát hiện mới đều ở bước M-34-07 mới:

| # | Severity | Section | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| 1 | minor | §5 M-34-07, 07c | Lệnh probe thiếu `--cluster`: `run-task`, `wait tasks-running`, `describe-tasks`, `stop-task` đi vào cluster `default` (không tồn tại): `ClusterNotFoundException`. `register-task-definition` cho Fargate cần `--requires-compatibilities FARGATE --network-mode awsvpc --cpu 256 --memory 512`. | doc dòng 137; cluster là `dbs-dev` | Thêm `--cluster dbs-dev` (và `--tasks <arn>`); ghi đủ cờ `register-task-definition`; không cần execution role hay logConfiguration cho image công khai. |
| 2 | minor | §5 M-34-07, 07b | `python:3-alpine` không đặt WORKDIR nên `http.server` phục vụ `/`; trong lúc 07b, cả filesystem container (kể cả `/proc/*/environ`) liệt kê được qua ALB mở `0.0.0.0/0`. Rủi ro thấp (probe không có task role) nhưng tránh được. | doc dòng 137 | `sh -c "mkdir -p /srv/health && echo ok > /srv/health/ready && python -m http.server 3000 --directory /srv"`. |
| 3 | minor | §5 M-34-07a | 07a chỉ đạt nếu task RUNNING, nhưng RUNNING chưa chứng minh có gì lắng nghe port 3000. | doc dòng 138 | Tính 07a đạt chỉ sau khi 07b thành công, hoặc chạy 07a sau 07b, trước 07c. |
| 4 | minor | §5 M-34-07c | `deregister-task-definition` chỉ đánh dấu INACTIVE; revision vẫn còn. | hành vi AWS ECS | Thêm `aws ecs delete-task-definitions --task-definitions dbs-probe:1` hoặc đổi kỳ vọng thành "INACTIVE". |

Verdict: APPROVE
