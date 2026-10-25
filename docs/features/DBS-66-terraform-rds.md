# DBS-66 · Terraform: RDS PostgreSQL 17 (dev), mã hóa và ép TLS

> **Status:** Draft (đang làm, đến G2) · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev · **Nhánh:** `chore/DBS-66-terraform-rds` (xếp chồng trên `chore/DBS-54-terraform-cognito`) · **PR:** — · **Cập nhật:** 2026-10-26

## 1. Bối cảnh

- **Task trên board:** Task, Deliverable P3, Ưu tiên Highest, board "To Do" (sẽ đặt In Progress). **Expect:** Có database trên cloud để app nối vào.
- **DoD** (nguyên văn, đánh số):
  1. RDS PostgreSQL 17, Single-AZ (cấu hình dev), mã hóa lưu trữ, parameter group rds.force_ssl=1 và timezone UTC, backup tự động bật; thuộc nhóm «xóa hằng ngày»
  2. Security group chỉ cho phép từ task ECS
  3. Ghi chi phí RDS dev theo giờ vào báo cáo chi phí
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Thực trạng trên board:** chưa có RDS; app đã hỗ trợ `DATABASE_SSL` và `DATABASE_SSL_CA_PATH` (`pg-ssl.ts` + test).
- **Phụ thuộc:** DBS-33 (board In Review; `base` đã dựng thật). Nhánh xếp chồng trên DBS-54 (PR #26): `main` ← #22 ← #23 ← #24 ← #25 ← #26 ← nhánh này.
- **Đã có gì:** `base` có VPC, 2 private subnet không route ra internet, 2 public subnet, SG `alb` và `api` (DBS-34), log group (DBS-34); `session` có cluster, service, ALB, IAM (DBS-34); ADR-10 (RDS ở private subnet, SG chỉ nhận từ task), ADR-11 (RDS `db.t4g.micro` Single-AZ ≈ 0,025 USD/giờ, KMS 1 key), docs/03 §13.1–§13.2 (`DATABASE_POOL_MAX = 10`, `số task × 10 + 5 ≤ max_connections`, `db.t4g.micro` ≈ 80–110 kết nối, dev tối đa 6 task); NFR-SEC-03 (mã hóa at-rest bằng KMS cho RDS; TLS tới RDS) và NFR-SEC-06; `validation.schema.ts` bắt buộc `DATABASE_SSL=true` khi `staging`/`production`.
- **Baseline:** `terraform test`: bootstrap 9/9, `base` 24/24, `session` 9/9; test script Cognito 12/12 (lúc bàn giao DBS-54).
- **Ngoài phạm vi:** tạo DB role `dbs_api`, `dbs_worker`, `dbs_migrator` và chạy migration (DBS-68); `DATABASE_URL`, secret và CA bundle trong image (DBS-67, `Dockerfile`); production Multi-AZ, `db.t4g.small` (cấu hình prod; chỉ để biến); đối soát chi phí thật trên Cost Explorer (BL-031 kiểu, ngày hôm sau); failover (DBS-181).
- **Câu hỏi mở** (kèm đề xuất):
  1. **Vị trí:** KMS CMK (alias `alias/dbs-dev-rds`, bật xoay khóa, chờ xóa 7 ngày), DB subnet group (2 private subnet), SG `db` (`5432` chỉ từ SG `api`) và luật egress `5432` của SG `api` tới SG `db` ở `envs/dev/base` (BL-032; gần như miễn phí: KMS ≈ 1 USD/tháng); parameter group và instance ở `envs/dev/session` (xóa hằng ngày).
  2. **Mật khẩu master:** `manage_master_user_password = true` (RDS tự tạo và xoay secret trong Secrets Manager, mã hóa bằng CMK; mật khẩu không vào Terraform state, không biến). Secret bị xóa cùng instance khi `destroy`. DBS-67 đọc secret này để tạo DB role và ghép `DATABASE_URL`. Tên master user `dbs_master`, database `dbs`.
  3. **Phiên bản:** `engine = "postgres"`, `engine_version = "17"` (RDS chọn bản nhỏ mới nhất của 17, hiện 17.11), `auto_minor_version_upgrade = true`; ghi bản thật vào §8.
  4. **Cấu hình dev:** `db.t4g.micro`, `gp3` 20 GB, Single-AZ (`multi_az` là biến, mặc định `false`), `publicly_accessible = false`, `backup_retention_period = 1`, `skip_final_snapshot = true`, `delete_automated_backups = true`, `deletion_protection = false`, `apply_immediately = true`; không Performance Insights, không enhanced monitoring, không xuất log (tránh phí). Biến `instance_class` và `multi_az` để production đổi (không dùng ở task này).
  5. **Parameter group** `family = postgres17`: `rds.force_ssl = 1`, `timezone = UTC` (cả hai áp dụng ngay, không cần reboot).
  6. **Kiểm TLS và `max_connections` bằng một task thử** (image công khai có `psql`, trong SG `api` ở public subnet) thay vì bastion: dùng một IAM role tạm (tạo bằng CLI, xóa sau) cho phép đọc secret master; `sslmode=disable` phải bị từ chối, `sslmode=require` vào được; ghi `SHOW max_connections`, `SHOW timezone`, `SHOW ssl`. Mật khẩu không bao giờ nằm trên argv hay trong output.
  7. **Chi phí:** ghi ≈ 0,025 USD/giờ (ADR-11) vào §8 và README; đối chiếu thật bằng Cost Explorer ngày hôm sau (BACKLOG, cùng BL-031).
  8. **`apply` và `destroy`** trên AWS thật: người dùng đã đồng ý ngày 2026-10-26 (destroy ngay sau khi kiểm). RDS tạo mất ≈ 5–10 phút, xóa ≈ 5–8 phút; tổng thời gian tính tiền dưới 25 phút (≈ 0,01 USD).

**Quyết định ở G1** (tự duyệt theo `CLAUDE_local.md`, 2026-10-26): chọn đúng đề xuất 1 đến 8; mọi giá trị theo ADR-10, ADR-11, docs/03 §13 và NFR-SEC-03/06, không đổi ADR hay NFR.

## 2. Hành vi

| Tác nhân | Hành động | Kết quả |
|---|---|---|
| Task `api` (SG `api`) | kết nối TCP 5432 tới endpoint RDS | cho phép (SG `db` nhận 5432 chỉ từ SG `api`; SG `api` có luật egress 5432 chỉ tới SG `db`) |
| Bất kỳ ai khác (internet, ALB, SG khác, máy cá nhân) | kết nối 5432 | không tới được: instance ở private subnet, `publicly_accessible = false`, SG chỉ nhận từ SG `api` |
| Client | kết nối không mã hóa (`sslmode=disable`) | **bị từ chối** (`rds.force_ssl = 1`: "no encryption") |
| Client | kết nối `sslmode=require` với đúng user và mật khẩu | vào được; `SHOW ssl` = `on`, `SHOW timezone` = `UTC` |
| RDS | lưu trữ | mã hóa bằng CMK `alias/dbs-dev-rds` (`storage_encrypted = true`); backup tự động giữ 1 ngày |
| Mật khẩu master | tạo và xoay | do RDS quản lý trong Secrets Manager (mã hóa bằng CMK); không có trong state hay biến |
| `terraform destroy session` | xóa | instance xóa không snapshot cuối (`skip_final_snapshot`), xóa cả backup tự động (`delete_automated_backups`), secret master bị xóa theo; chi phí về ≈ 0; KMS key, subnet group, SG ở `base` ở lại |
| `multi_az = true` hoặc `instance_class` khác | đặt qua biến | áp dụng (dành cho production, không dùng ở task này) |

**Ca biên và rủi ro:**
- `max_connections` của `db.t4g.micro` là giá trị tính theo RAM (≈ 80–110): ghi con số thật vào §8 để kiểm `số task × 10 + 5 ≤ max_connections`.
- Dữ liệu dev **bị xóa mỗi lần `destroy`**; seed lại bằng script/migration (DBS-68).
- Nếu quên `destroy`: ≈ 0,025 USD/giờ (RDS) ≈ 18 USD/tháng; KMS CMK ≈ 1 USD/tháng chạy liên tục (giữ lại).
- `rds.force_ssl` chỉ chặn kết nối không TLS; chứng chỉ máy chủ phải được client kiểm bằng CA bundle (DBS-67), không tắt kiểm chứng.
- KMS CMK bị xóa có 7 ngày chờ (teardown DBS-208): lên lịch xóa từ trước.

## 3. Kiến trúc

- **Vị trí:**
  - `envs/dev/base`: `kms.tf` (mới: `aws_kms_key.rds`, `aws_kms_alias.rds`), `rds_network.tf` (mới: `aws_db_subnet_group.main` trên 2 private subnet, `aws_security_group.db`, `aws_vpc_security_group_ingress_rule.db_from_api`, `aws_vpc_security_group_egress_rule.api_to_db`), `outputs.tf` (thêm `kms_rds_key_arn`, `db_subnet_group_name`, `db_security_group_id`), `tests/rds_network.tftest.hcl`.
  - `envs/dev/session`: `rds.tf` (mới: `aws_db_parameter_group.postgres17`, `aws_db_instance.main`), `variables.tf` (thêm `db_instance_class` mặc định `db.t4g.micro`, `db_multi_az` mặc định `false`), `outputs.tf` (thêm `db_endpoint`, `db_address`, `db_port`, `db_master_secret_arn`, `db_instance_id`), `tests/session.tftest.hcl` (thêm các run RDS, cập nhật override).
  - `infra/terraform/README.md`: biến, chi phí RDS theo giờ, cách xóa, ghi chú KMS.
- **Dữ liệu chạm tới:** `dev/base.tfstate` (KMS, subnet group, SG), `dev/session.tfstate` (parameter group, instance; không có mật khẩu). Secret master do RDS tạo (ngoài Terraform).
- **Sơ đồ:**

```mermaid
flowchart LR
  T[Task api, SG api] -->|5432 TLS, egress 5432 chỉ tới SG db| R[(RDS PostgreSQL 17, private subnet, SG db)]
  R -->|mã hóa lưu trữ| K[KMS CMK dbs-dev-rds]
  R -.mật khẩu master do RDS quản lý.-> SM[(Secrets Manager)]
  SM -.mã hóa.-> K
  PG[Parameter group: rds.force_ssl=1, timezone=UTC] --> R
```

- **Thay đổi cấp hệ thống:** README Terraform; docs/03 §13.2 và ADR-11 đã khớp (không đổi).
- **Hợp đồng với task khác:** DBS-67 (đọc secret master, tạo `DATABASE_URL`, thêm `secretsmanager:GetSecretValue` và `kms:Decrypt` cho execution role, CA bundle), DBS-68 (tạo `dbs_api`, `dbs_worker`, `dbs_migrator` bằng master, chạy migration), DBS-34 (SG `api` nay có thêm egress 5432).

## 4. Test cases tự động

`terraform test` với `mock_provider "aws"` (mọi giá trị assert viết tường minh trong HCL; ARN giả hợp lệ bằng `override_resource` khi cần).

| ID | Truy vết | Lớp | Given · When · Then | Mong đợi |
|---|---|---|---|---|
| TC-66-01 | DoD 1 | tf test (session) | Instance: `engine = postgres`, `engine_version` bắt đầu bằng `17`, `instance_class = db.t4g.micro`, `multi_az = false`, `allocated_storage = 20`, `storage_type = gp3`, `db_name = dbs`, `username = dbs_master`, `port = 5432` | đúng |
| TC-66-02 | DoD 1 (security) | tf test (session) | `storage_encrypted = true`, `kms_key_id` là ARN CMK từ base; `publicly_accessible = false` | đúng |
| TC-66-03 | DoD 1 (security) | tf test (session) | Parameter group: `family = postgres17`, `rds.force_ssl = 1`, `timezone = UTC`; instance dùng parameter group đó | đúng |
| TC-66-04 | DoD 1 | tf test (session) | `backup_retention_period = 1`; `skip_final_snapshot = true`, `delete_automated_backups = true`, `deletion_protection = false` (xóa hằng ngày không để lại gì) | đúng |
| TC-66-05 | DoD 1 (security) | tf test (session) | `manage_master_user_password = true`, `master_user_secret_kms_key_id` là CMK; không có thuộc tính `password` | đúng |
| TC-66-06 | DoD 2 | tf test (base) | SG `db`: ingress duy nhất `tcp 5432` từ SG `api`, không CIDR; không có egress; subnet group gồm đúng 2 private subnet | đúng |
| TC-66-07 | DoD 2 | tf test (base) | SG `api` có thêm egress `tcp 5432` chỉ tới SG `db` (luật 443 cũ giữ nguyên) | đúng |
| TC-66-08 | DoD 1 | tf test (session) | Instance gắn SG `db` và subnet group từ base; không public | đúng |
| TC-66-09 | DoD 1 | tf test (base) | CMK: bật xoay khóa, `deletion_window_in_days = 7`, alias `alias/dbs-dev-rds` | đúng |
| TC-66-10 | an toàn | tf test (session) | `db_multi_az` và `db_instance_class` đổi theo biến (prod) | đúng |
| TC-66-11 | hồi quy | tf test | Các test cũ của `base` (24) và `session` (9) vẫn đạt | đúng |
| TC-66-12 | DoD 1, 2 | thủ công | Kết nối thật: TLS ép buộc, không TLS bị từ chối, timezone, `max_connections` (M-66-04…M-66-08) | thủ công |
| TC-66-13 | DoD 4 | quy trình | PR merge, CI xanh, Dev review, bảng đối chiếu | quy trình |

DoD 3 (ghi chi phí) kiểm bằng §8 và README, không có test tự động.

## 5. Test thủ công

Điều kiện chạy: `AWS_PROFILE=dbs-admin`, `.tools/bin` trong PATH; người dùng đã đồng ý `apply` và `destroy` ngày 2026-10-26; destroy ngay sau khi kiểm. Biến session: `-var account_id=<id> -var state_bucket=dbs-tfstate-<id>-ap-southeast-1 -var image_tag=<40 chữ 0>`; `desired_count = 0` (mặc định). Không in mật khẩu; mật khẩu đi qua stdin hoặc biến môi trường của container thử qua `secrets` (không qua tham số).

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-66-00 | `terraform plan -out=base.tfplan -var account_id=<id>` ở `base` | thêm KMS key và alias, subnet group, SG `db`, 2 luật; `0 to destroy` |
| M-66-01 | `apply` base; `describe-security-groups`, `kms describe-key`, `get-key-rotation-status` | SG `db`: ingress 5432 chỉ từ SG `api`; SG `api` có egress 5432 tới SG `db`; xoay khóa `true` |
| M-66-02 | `terraform plan` session với biến trên | `Plan: … to add`, `0 to destroy`; tag đủ |
| M-66-03 | `apply` session (ghi giờ bắt đầu); `aws rds describe-db-instances` | `available`, `postgres 17.x`, `db.t4g.micro`, `MultiAZ false`, `StorageEncrypted true` với CMK, `PubliclyAccessible false`, parameter group `in-sync`, `BackupRetentionPeriod 1` |
| M-66-04 | Dựng IAM role tạm `dbs-probe-exec` (trust `ecs-tasks.amazonaws.com`) có quyền kéo image công khai (không cần), ghi log vào `/dbs/dev/api` và `secretsmanager:GetSecretValue` + `kms:Decrypt` đúng secret master và CMK; đăng ký task definition tạm `dbs-probe-db` (image `public.ecr.aws/docker/library/postgres:17-alpine`, `secrets` lấy `PGPASSWORD` từ `<secret ARN>:password::` và `PGUSER` từ `:username::`, `PGHOST`, `PGDATABASE` là biến thường, log `awslogs` về `/dbs/dev/api` stream `probe`); `run-task` vào public subnet với SG `api`, `assignPublicIp=ENABLED` | task `RUNNING` rồi `STOPPED` với exit code 0 |
| M-66-05 | **TLS ép buộc (bị từ chối):** lệnh container `psql "sslmode=disable" -c 'select 1'` | thất bại với thông báo `no encryption` (từ `rds.force_ssl`); đọc từ CloudWatch Logs |
| M-66-06 | **Thành công:** `psql "sslmode=require" -Atc "show ssl; show timezone; show max_connections; select version()"` | `on`, `UTC`, một số (ghi lại), `PostgreSQL 17.x` |
| M-66-07 | **SG chỉ từ task:** cùng lệnh nhưng task gắn SG `alb` (không có egress 5432) | timeout/không kết nối được |
| M-66-08 | Dọn: xóa task definition tạm, role tạm, dừng task | không còn role/task definition tạm |
| M-66-09 | `terraform destroy` session (ghi giờ kết thúc); đợi cho tới khi instance biến mất | `Destroy complete` |
| M-66-10 | Kiểm sạch: `aws rds describe-db-instances`, `describe-db-snapshots --snapshot-type automated`, `secretsmanager list-secrets --filters Key=owning-service,Values=rds`, `describe-network-interfaces` theo VPC | rỗng (snapshot tự động cũng bị xóa; secret master bị xóa) |
| M-66-11 | Chi phí: ghi giờ bật/tắt và chi phí ước tính (0,025 USD/giờ); đối chiếu Cost Explorer ngày hôm sau | **chưa chạy ở bước này** (billing trễ): BACKLOG |

Thời gian: tạo ≈ 5–10 phút, xóa ≈ 5–8 phút; chi phí ≈ 0,01 USD.

## 6. Domain review (AI)

(Chạy ở Phase 2.)

## 7. Kế hoạch triển khai

(Điền ở Phase 3.)

## 8. Kết quả

(Điền ở Phase 4–5.)

## 9. Tài liệu đã cập nhật

(Điền ở Phase 4–5.)
