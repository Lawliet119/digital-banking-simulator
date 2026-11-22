## DBS-186 phần cloud: drill thu hồi phiên khi Redis mất khóa hoặc chết, đã chạy trên AWS

Phần local của DBS-186 đã merge ở #127. PR này làm nốt DoD 3 nửa sau: «một lần chạy trên cloud; ghi vào bảng sự cố P4». Thêm driver chạy từ máy vận hành vào ALB thật (Cognito thật, ElastiCache Valkey TLS, ECS, RDS), test của driver chạy trong CI, và kết quả chạy thật ngày 2026-11-22.

**Kết quả lần chạy thật (run `df7a1229`, image `76b80bdbc6985738f49a366f0157e1afcc593564`, `ap-southeast-1`, 01:15:51Z–01:28:59Z): `verdict PASS`, exit 0, 35 bước PASS, 0 FAIL.**

- **flush:** khóa `revoked_at:*` 1 → 0, request kế tiếp của A **401 `SESSION_REVOKED`** có correlationId, mốc SQL không đổi, B 200, bất biến PASS.
- **down:** NACL deny 6379 (cắt cả kết nối đang mở), `/health/ready` báo `redis: degraded` sau 218 ms, A **401 `SESSION_REVOKED`** (SQL fallback), B 200 khi Redis chết, mốc nguyên, phục hồi `redis: up` sau 84,3 s, A vẫn 401, bất biến PASS.
- **BL-222:** `CAUGHT` ở `hit`, `flush`, `down` (cùng giây và đúng +1, 0 vi phạm). Đường đi cache hit/miss/fallback là suy ra, không quan sát trực tiếp.
- Bằng chứng: `docs/components/load-tests/results/dbs-186-cloud/report.json` và `drill-log.txt` (đã quét: 0 JWT, `Bearer`, ARN, id tài khoản AWS, mật khẩu). Chi tiết và số từng bước: `docs/features/DBS-186-redis-revocation-drill.md` §8.1; dòng cloud ở `docs/deliverables/P4-incident-table.md`.

### Thay đổi
- `infra/scripts/drill-revocation-cloud.mjs`: driver Node không phụ thuộc ngoài. Thứ tự lock → fault → request kế tiếp; hook là lệnh shell (`--flush-cmd`, `--down-cmd`, `--up-cmd`, `--sql-marker-cmd`, `--invariants-cmd`, `--operator-token-cmd`); fault phải có hiệu lực thật (health `redis: degraded`, số khóa `revoked_at:*` 1 → 0), không tin mã thoát của hook; che token ở mọi đầu ra; luôn chạy `--up-cmd` kể cả khi nhận SIGINT/SIGTERM; mã thoát 0/1/2/3/4.
- `infra/scripts/tests/drill-revocation-cloud.test.mjs` và `drill-fake-backend.mjs`: máy chủ giả cùng tiến trình, hook giả bằng `spawn` bất đồng bộ; thêm vào bước `node --test` của job `unit` trong `.github/workflows/ci.yml`.
- `docs/features/DBS-186-redis-revocation-drill.md` (§1.1, §2.1, §3.1, §4.1, §5.1, §6.1, §7.1, §8.1), `docs/deliverables/P4-incident-table.md`, `docs/features/README.md`, evidence ở `docs/features/screenshots/DBS-186/` (domain review hai vòng, `cloud-driver-local.txt`).
- `docs/BACKLOG.md`: **xóa BL-222** (ba chế độ `CAUGHT`); **thu hẹp BL-220** còn failover ElastiCache và cấu hình production (`envs/prod`).
- Không đổi production, schema, env, dependency, Terraform.

### Đối chiếu test case

| ID | Truy vết | Test | Kết quả |
|---|---|---|---|
| TC-186-04 | DoD1/2, AC-11.1 | `drill-revocation-cloud.test.mjs` › TC-186-04 (ca đạt, thứ tự lock → fault → request kế tiếp, mốc nguyên, B 200) | đạt |
| TC-186-05 | DoD1 (negative control) | › TC-186-05 (bỏ SQL fallback ⇒ exit 1, up vẫn chạy) | đạt; đột biến tạm làm đỏ đúng chỗ |
| TC-186-06 | AC-11.1 | › TC-186-06 (sai errorCode/correlationId, `TOKEN_EXPIRED`, token sắp hết hạn) | đạt |
| TC-186-07 | DoD3 (che token) | › TC-186-07 (không JWT/mật khẩu/ARN trong stdout, log, report; hook không thấy mật khẩu) | đạt |
| TC-186-08 | DoD3 | › TC-186-08, 08b (hook lỗi, quá hạn, SIGINT, `--shell`) | đạt; ca SIGINT bỏ qua trên Windows, chạy đạt trên Linux (Docker `node:22`) |
| TC-186-09 | DoD1, bất biến | › TC-186-09 (checker thoát 1 ⇒ exit 4, thoát 2 ⇒ exit 3) | đạt |
| TC-186-10 | DoD1 | › TC-186-10 (mốc SQL đổi/mất ⇒ exit 1) | đạt |
| TC-186-11 | BL-222 | › TC-186-11 (`CAUGHT`, `NOT_CAUGHT`, `SAME_SECOND_ONLY`, `VIOLATION` cả `<` và lệch +1, down tự lành) | đạt |
| TC-186-12 | an toàn | › TC-186-12 (tham số, chạy lại khi A `LOCKED`) | đạt |
| TC-186-13 | quy trình | bước `node --test` trong job `unit` | chờ CI của PR |
| TC-186-14 | DoD1/2 | › TC-186-14 (flush/down không hiệu lực ⇒ exit 3, chờ phục hồi) | đạt |
| TC-186-15 | 429 | › TC-186-15 | đạt |
| TC-186-16 | Cognito, TLS | › TC-186-16 | đạt; hai ca TLS bỏ qua ở lượt Docker (thiếu `openssl`), chạy đạt trên Windows |
| TC-186-17 | User-Agent (lỗi gặp ở lần chạy cloud đầu) | › TC-186-17 | đạt |
| DoD3 cloud | M-186-08..16 | lần chạy thứ ba trên AWS | **đạt** (`verdict PASS`, §8.1) |

Lệnh chạy lúc bàn giao: `node --test infra/scripts/tests/drill-revocation-cloud.test.mjs`: Windows Node 24.22.2 **54 test, 52 đạt, 0 đỏ, 2 bỏ qua**; Docker `node:22-bookworm-slim` **54 test, 52 đạt, 0 đỏ, 2 bỏ qua**; `check-doc-links.mjs` 504 file 0 lỗi; `check-backlog.mjs` 104 dòng 0 lỗi. Backend không đổi nên bốn lệnh backend không chạy.

### Bước chưa chạy hoặc chạy khác kế hoạch
- **M-186-09** (thử khô từng hook ngoài driver): chưa chạy theo kế hoạch; hai lần chạy đầu thất bại thay cho thử khô.
- **M-186-10:** khách tạm tạo bằng `admin-create-user` (nhóm `customer`, mật khẩu ghi tệp tạm đã xóa; hai khách đã `admin-delete-user`, `list-users` trả 0) thay cho `sign-up` trong container Docker.
- **M-186-08**: một phần. Không có `RequestCount` ALB và `sts get-caller-identity` trong báo cáo. **M-186-16** đã chạy: hủy stack (`destroy session` 66 tài nguyên, `destroy loadgen` 21 tài nguyên) và `verify-clean.sh` exit 0 «sạch (13 loại)», không còn NACL riêng, `list-user-pool-clients` chỉ còn `dbs-app`; kiểm `terraform plan` của `base` không chạy vì fault là NACL của stack `loadgen`.
- **Alarm:** `dbs-dev-redis-fallback` đã ALARM từ trước drill (lúc thử công cụ ở DBS-167) và không về OK, nên drill không tạo chuyển trạng thái alarm; không dùng alarm làm bằng chứng down.
- **Failover ElastiCache** (stack có 1 replica) và cấu hình production chưa chạy: giữ ở BL-220.
- **Dev review/merge** vẫn ở BL-230 (DoD 4 chưa đạt về hình thức).

### Lệch so với kế hoạch (đã ghi ở §8.1)
1. Hai lần chạy đầu thất bại, giữ làm bằng chứng: (a) preflight 403 do WAF `AWSManagedRulesCommonRuleSet` chặn request không có `User-Agent`, đã sửa trong driver (commit `598f5a96`, TC-186-17); (b) hook `down` thoát 1 vì `get-command-invocation` của SSM bị throttling làm vỡ công cụ SSM của người điều phối, driver dọn, chạy `--up-cmd` và thoát 3 `ERROR` (không PASS giả), NACL kiểm sạch.
2. Client `dbs-loadgen` thay `dbs-app` (API của stack đo chỉ nhận client này).
3. Hook thật qua SSM tới máy tải EC2 cùng VPC (không phải Docker `dbs-awscli` hay task ECS một lần): flush = `FLUSHALL SYNC` và đếm khóa bằng `SCAN`; `sql-marker` đọc `users.sessions_revoked_at` bằng role `dbs_api`; bất biến chạy `invariants.ts`; token operator bằng `loadgen-tokens.mjs`; down = NACL riêng deny 6379 từ CIDR public, up = gỡ luật (cơ chế của DBS-167, `redis-fault.sh`, nhánh riêng chưa merge).
4. Stack có `redis_replicas = 1` (thiết kế từng giả định 0 replica, sai): đã sửa.

### Quyết định agent tự chốt (không có human gate)
- Hook thay vì cơ chế cố định; không tin mã thoát của hook, đo hiệu lực bằng `/health/ready` (chỉ trường `redis` báo, vì health trả 200 cả khi Redis chết) và số khóa.
- Một khách A dùng cho cả hai kiểu (mở khóa, chờ, token mới, khóa lần hai; kiểm token cũ vẫn 401); B là khách không bị thu hồi.
- BL-222: token +1 đăng nhập ngay sau khóa, trước khi đọc mốc; `CAUGHT` chỉ khi có cả mẫu cùng giây và mẫu +1 ở cả ba chế độ.
- Token sắp hết hạn là «không kết luận» (exit 3); 429 là exit 3.
- Domain review: hai vòng opus effort high (18 rồi 9 phát hiện, 0 blocking ở vòng 2), đã sửa hết; vòng 2 vẫn `REVISE` nhưng hết lượt nên mỗi sửa được kiểm bằng test, không có vòng 3.

Techlead waiver: không qua Dev review và không qua human gate; G1..G4, domain review do agent (opus) tự duyệt; CLAUDE.md miễn các ràng buộc quy trình cho phiên của techlead. Việc chạy trên AWS do người điều phối thực hiện; board do người cập nhật.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
