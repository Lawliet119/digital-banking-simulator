# DBS-75 · Terraform: ElastiCache Valkey (TLS) theo ADR-12

> **Status:** Draft · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev · **Nhánh:** `chore/DBS-75-terraform-valkey` (từ `main`) · **PR:** — · **Cập nhật:** 2026-10-29

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 3, Deliverable P3, Ưu tiên High, board "To Do". **Expect:** App trên cloud có Redis, xóa được cùng phần «xóa hằng ngày».
- **DoD** (nguyên văn, đánh số):
  1. ElastiCache theo phương án ADR-12, TLS bật, security group chỉ cho phép từ task ECS
  2. REDIS_URL dạng rediss:// đưa vào cấu hình task
  3. apply/destroy trong cùng lệnh với phần dựng/xóa; ghi chi phí
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Thực trạng trên board:** Redis mới chạy local (Valkey 8); production bắt buộc `rediss://`. ADR-12: node `cache.t4g.micro`, cluster mode tắt, TLS + AUTH token (Secrets Manager); production thêm 1 replica Multi-AZ.
- **Phụ thuộc:** DBS-33 (Done, đã merge `main`).
- **Đã có gì:**
  - ADR-12 (Accepted): Valkey node-based, cluster mode tắt, dev 1 node `cache.t4g.micro` (≈ 0,016 USD/giờ), TLS khi truyền, AUTH token ở Secrets Manager. docs/03 §9, §12 (mã hóa at-rest bằng KMS cho ElastiCache, NFR-SEC-03), §13 (Redis chỉ mở cho SG của app, NFR-SEC-06).
  - `validation.schema.ts`: `REDIS_URL` bắt buộc, `rediss://` khi `NODE_ENV` là `staging`/`production`. `redis.config.ts` chỉ đọc `REDIS_URL`. Chưa có `libs/redis` (DBS-76).
  - `envs/dev/base/security_groups.tf`: SG `alb`, `api`; ghi chú dòng 53 hẹn egress 6379 "do task ElastiCache thêm theo SG-to-SG". `envs/dev/session/ecs.tf`: task api chưa có `REDIS_URL`, `desired_count` mặc định 0.
  - Mẫu cùng loại trên PR chưa merge: DBS-66 (#27, SG `db` ở `base`, CMK `alias/dbs-dev`), DBS-67 (#37, app ghép `DATABASE_URL` từ `DB_*` vì ECS `secrets` không ghép được URL).
  - Backlog cùng module: không có dòng Redis/ElastiCache.
- **Baseline** (`main` b8742a3): như DBS-73: `fmt` sạch, `validate` đạt, `terraform test` bootstrap 9/9, `base` 17/17, `session` 9/9.
- **Ngoài phạm vi:** `libs/redis`, timeout và circuit breaker (DBS-76); `/health/ready` degraded (DBS-78); replica Multi-AZ production (DBS-152, chỉ để biến); task worker (DBS-121); diễn tập tắt Redis (DBS-186).
- **Câu hỏi mở** (kèm đề xuất):
  1. **Vị trí:** subnet group ElastiCache (2 private subnet), SG `dbs-dev-redis` (6379 chỉ từ SG `api`) và egress 6379 của SG `api` tới SG `redis` ở `base` (miễn phí, giống DBS-66); `aws_elasticache_replication_group` `dbs-dev` ở `session` (xóa hằng ngày, nên DoD 3 tự đạt: cùng một `apply`/`destroy` của `session`).
  2. **Cấu hình:** engine `valkey` 8, `cache.t4g.micro`, 1 node, cluster mode tắt, `transit_encryption_enabled = true` (mode `required`), `at_rest_encryption_enabled = true` bằng khóa do AWS quản lý (CMK `alias/dbs-dev` chưa có trên `main`; đổi sang CMK khi PR #27 merge, ghi BL), `automatic_failover_enabled = false`, `snapshot_retention_limit = 0`, `apply_immediately = true`. Biến `redis_node_type`, `redis_replicas` (mặc định 0) cho production.
  3. **AUTH token và `REDIS_URL` (gate phụ: biến môi trường):** URL `rediss://:<token>@host:6379` chứa bí mật nên không đặt được làm biến thường, và ECS `secrets` không ghép được URL. Hai cách:
     - **(a) Đề xuất:** app ghép `REDIS_URL` từ `REDIS_HOST`, `REDIS_PORT` (biến thường) và `REDIS_AUTH_TOKEN` (từ secret), cùng cách DBS-67 làm với `DATABASE_URL`. Cần **thêm 3 biến môi trường** và sửa `backend/src/config`; nên xếp chồng lên PR #37 (DBS-67) để dùng lại `env.bootstrap.ts`, hoặc chờ #37 merge.
     - (b) Secret chứa nguyên URL, một script ghi giá trị sau mỗi lần `apply session` (endpoint đổi theo phiên). Không đổi app nhưng thêm một bước tay mỗi phiên, dễ quên.
  4. **Token có vào Terraform state không:** đề xuất secret `dbs/dev/redis-auth` ở `base` (giữ lại; tránh bẫy 7–30 ngày chờ xóa khi tạo lại cùng tên), sinh bằng ephemeral random password và `secret_string_wo` để token không vào state của `base`. Thuộc tính `auth_token` của ElastiCache có bản write-only hay không sẽ kiểm ở Phase 2; nếu không có thì token nằm trong `dev/session.tfstate` (đã chỉ bảo vệ bằng IAM, như README ghi), và mình ghi rõ ở §3.
  5. **Test thủ công trên AWS thật:** task api trên `main` chưa khởi động được (thiếu DB, DBS-67/68 chưa merge), nên kiểm bằng **task thử** dùng image công khai có `valkey-cli` (cách DBS-66 dùng): TLS + token đúng thì `PING` → `PONG`; không TLS hoặc sai token thì bị từ chối; SG khác thì không tới được. Cần `apply`/`destroy envs/dev/session` (RDS không có trên `main`; ALB, ECS, ElastiCache ≈ 0,05 USD/giờ, destroy ngay sau khi kiểm). Cần bạn đồng ý trong hội thoại.
  6. **Chi phí:** ghi ≈ 0,016 USD/giờ cho node (ADR-11/12) và 0,40 USD/tháng cho secret vào README; đối chiếu Cost Explorer ngày hôm sau thành dòng BL (như BL-102).

**Quyết định ở G1:** (chờ)
