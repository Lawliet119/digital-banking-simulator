# DBS-67 · Secrets Manager cho kết nối DB, CA bundle RDS trong image, app nối RDS qua TLS

> **Status:** Implemented (G4 duyệt 2026-10-29: chấp nhận M-67-05, 06, 07 chưa chạy, BL-106, và không có ảnh chụp) · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev · **Nhánh:** `chore/DBS-67-rds-tls-secrets` (xếp chồng trên `chore/DBS-38-auto-deploy`) · **PR:** [#37](https://github.com/Lawliet119/digital-banking-simulator/pull/37) · **Cập nhật:** 2026-10-29

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 2, Deliverable P3, Ưu tiên Highest, board "To Do". **Expect:** App trên cloud nối RDS mã hóa; secret không nằm trong repo hay image.
- **DoD** (nguyên văn, đánh số):
  1. Mật khẩu DB do Secrets Manager sinh và đưa vào task ECS; không secret trong repo, image hay Terraform viết thẳng
  2. CA bundle có trong image hoặc bước build; DATABASE_SSL=true, DATABASE_SSL_CA_PATH đúng; thử với CA sai thì kết nối bị từ chối
  3. /health/ready trên cloud trả 200 khi nối RDS được
  4. Cập nhật Dockerfile và backend/README
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Thực trạng trên board:** Dockerfile chỉ có ghi chú; kết nối RDS thật qua TLS chưa thử.
- **Phụ thuộc:** DBS-66 (In Review, mã trên nhánh `chore/DBS-66-terraform-rds`, đã chạy thật ở M-66); DBS-38 (In Progress, mã trên nhánh trước, **mọi bước AWS của DBS-38 chưa chạy**, BL-104). Phạm vi không bị thu hẹp về mã; phần cần AWS thật và Docker thật bị thu hẹp ở §5.
- **Đã có gì:** RDS `dbs-dev` với mật khẩu master do RDS sinh (`manage_master_user_password`, secret mã hóa bằng CMK `alias/dbs-dev`, output `db_master_secret_arn`, JSON `{"username","password"}`); `rds.force_ssl = 1`; app đã có `DATABASE_SSL`, `DATABASE_SSL_CA_PATH`, `buildSslOptions` luôn `rejectUnauthorized: true` (`backend/src/database/pg-ssl.ts`), Joi bắt buộc TLS khi `NODE_ENV` staging/production; task `api` ở `session/ecs.tf` chưa có `secrets`; execution role `dbs-dev-api-execution` chưa có quyền Secrets Manager; BL-039, BL-103 nêu việc của task này. Deploy (DBS-38) render từ revision mới nhất của family nên giữ nguyên `secrets`.
- **Ngoài phạm vi:** tạo role `dbs_api`, `dbs_worker`, `dbs_migrator` và chạy migration (DBS-68, DBS-119); task `api` kết nối bằng **master** tạm thời cho đến lúc đó (BL-103); `REDIS_URL`; xoay mật khẩu tự động cho app (xem rủi ro); service `worker`.
- **Baseline** (lúc bắt đầu): `terraform test` `base` 29/29, `session` 13/13; backend chưa chạy lại (không đụng logic ứng dụng, chỉ thêm một module nạp trước).
- **Câu hỏi mở** (kèm đề xuất):
  1. **Ghép `DATABASE_URL` ở đâu?** ECS `secrets` chỉ cắt được khóa JSON, không ghép chuỗi. Đề xuất (sau review V1-2): `env.bootstrap` (import đầu tiên của `main.ts` và `data-source.ts`, nên phủ cả typeorm CLI của DBS-68) gọi `composeDatabaseUrl(process.env)` ngay sau `loadEnv()`; khi `DATABASE_URL` chưa có (hoặc rỗng) và đủ `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` thì đặt `DATABASE_URL` (mã hóa `encodeURIComponent`). `DB_*` khai báo trong Joi (optional) và `env/.env.example` (theo CONTRIBUTING §5b). Không dùng `NODE_OPTIONS`. Lựa chọn bị loại: secret thứ hai chứa cả URL (mật khẩu vào state hoặc phải tạo bằng script tay); preload `NODE_OPTIONS` (hỏng im lặng nếu ai ghi đè, lỗi ra stack thô).
  2. **CA bundle:** `ADD --checksum=sha256:…` trong Dockerfile tải `global-bundle.pem` về `/etc/ssl/rds/global-bundle.pem`. Ghim hash để chống đổi file ngoài ý muốn; AWS cập nhật bundle thì build đỏ ồn ào và phải cập nhật hash (README ghi cách). Lựa chọn khác: không ghim (nhẹ hơn nhưng không kiểm toàn vẹn).
  3. **Xoay mật khẩu master** (RDS xoay mỗi 7 ngày): task đang chạy giữ mật khẩu cũ trong biến môi trường; kết nối mới sau xoay sẽ lỗi cho đến khi task khởi động lại. Đề xuất: ghi vào README và BL; dev theo phiên ngắn nên chấp nhận; DBS-119 (role riêng) giải quyết.
- **Quyết định ở G1** (tự duyệt theo `CLAUDE_local.md`, 2026-10-26): theo đề xuất cả ba. Mục 1 thêm năm biến `DB_*` optional vào Joi và `.env.example` (biến mới của app, đúng §5b; `DATABASE_URL` vẫn là đầu vào duy nhất mà app dùng); nêu lại ở G4.

## 2. Hành vi

| Điều kiện | Kết quả |
|---|---|
| Task ECS khởi động với `secrets` `DB_USER` và `DB_PASSWORD` (từ khóa `username`, `password` của secret master) và `environment` `DB_HOST` (địa chỉ instance), `DB_PORT=5432`, `DB_NAME=dbs`, `DATABASE_SSL=true`, `DATABASE_SSL_CA_PATH=/etc/ssl/rds/global-bundle.pem` | `env.bootstrap` đặt `DATABASE_URL=postgresql://<user>:<password mã hóa>@<host>:5432/dbs`; app qua Joi, nối RDS qua TLS, xác minh chứng chỉ |
| `DATABASE_URL` đã đặt sẵn (local, CI), kể cả khi có `DB_*` | không đổi gì |
| `DATABASE_URL=""` (rỗng) và đủ `DB_*` | coi như chưa đặt: ghép |
| Không có `DB_HOST` (local, CI, test) | không làm gì |
| Thiếu một phần `DB_*`, hoặc giá trị sai (`DB_PORT` không phải 1–65535, `DB_HOST` có `/` hay khoảng trắng, `DB_USER`/`DB_NAME` rỗng) | **không** ghép và **không ném lỗi**; in một dòng stderr nêu tên biến sai (không kèm giá trị); Joi báo thiếu `DATABASE_URL` |
| Mật khẩu chứa ký tự đặc biệt (`@`, `:`, `/`, `%`, `?`, `#`, khoảng trắng, ký tự Unicode) | được mã hóa đúng; URL parse lại cho ra đúng mật khẩu |
| Mọi trường hợp | không in `DB_PASSWORD` hay URL ra log |
| CA đúng | handshake TLS thành công, kết nối được chấp nhận |
| CA sai (bundle của CA khác) hoặc không có `DATABASE_SSL_CA_PATH` khi server dùng CA của AWS | kết nối **bị từ chối** với `err.code` thuộc {`SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`} (tùy server gửi chuỗi nào); app không khởi động được; không có đường tắt xác minh |
| `DATABASE_SSL_CA_PATH` trỏ file không đọc được | app dừng lúc khởi động, nêu biến và đường dẫn (hành vi có sẵn) |
| Image build | tải bundle bằng `ADD --checksum`: hash lệch thì build **đỏ**; file `0444`, thuộc root, đọc được bởi user `node`; không có secret nào trong image (kiểm bằng `docker history`/lớp) |
| `/health/ready` | trả 200 khi nối được DB (hành vi có sẵn); trên cloud chạy được khi task api chạy thật (BL-038, BL-104) |
| Execution role | policy riêng `read-db-master-secret`: `secretsmanager:GetSecretValue` **đúng một** ARN (secret master) và `kms:Decrypt` đúng CMK với `kms:ViaService = secretsmanager.${var.region}.amazonaws.com`; không `*` |
| Rollback tay (DBS-38) về revision của phiên trước | **không dùng được**: secret master có ARN mới mỗi lần dựng lại RDS, revision cũ trỏ ARN cũ; README ghi chỉ rollback trong cùng phiên; quy trình down deregister revision do `deploy.sh` đăng ký |

**Rủi ro còn lại:** (1) xoay master 7 ngày (§1 câu 3); (2) app dùng master tới DBS-68/119 (BL-103); (3) `DB_PASSWORD` nằm trong môi trường tiến trình (đọc được bởi ai có exec vào container; ECS Exec không bật); (4) hash CA ghim cần cập nhật khi AWS đổi bundle; (5) revision ECS cũ vô dụng sau `destroy` (dòng rollback ở trên).

## 3. Kiến trúc

- **Vị trí:** module `infra` (session) và image backend; role `api`/`worker` đều dùng cùng image.
  - `backend/src/config/compose-database-url.ts` (hàm thuần `composeDatabaseUrl(env): { url?: string; invalid: string[] }`), gọi trong `backend/src/config/env.bootstrap.ts` sau `loadEnv()`; `validation.schema.ts` (+ `DB_*` optional; `config.factories` không đọc chúng) và `env/.env.example` (dòng comment).
  - `backend/Dockerfile`: `# syntax=docker/dockerfile:1`; stage `runtime`: `ADD --checksum=sha256:<hash> --chmod=0444 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds/global-bundle.pem`; thay ghi chú CA cũ.
  - `infra/terraform/envs/dev/session/ecs.tf`: thêm `DB_HOST` (`aws_db_instance.main.address`), `DB_PORT`, `DB_NAME`, `DATABASE_SSL`, `DATABASE_SSL_CA_PATH` vào `environment`; `secrets` `DB_USER` = `<secret_arn>:username::`, `DB_PASSWORD` = `<secret_arn>:password::`; không có `NODE_OPTIONS` hay `NODE_TLS_REJECT_UNAUTHORIZED` trong `environment`.
  - `infra/terraform/envs/dev/session/iam.tf`: policy mới `read-db-master-secret` gắn vào role execution (`GetSecretValue` trên `aws_db_instance.main.master_user_secret[0].secret_arn`; `kms:Decrypt` trên `local.base.kms_key_arn` với `kms:ViaService`); policy `pull-image-and-write-logs` giữ nguyên.
  - `backend/README.md` (mục TLS PostgreSQL), `infra/terraform/README.md` (mục kết nối, cập nhật hash CA, rollback chỉ trong phiên, deregister revision khi down).
- **Interface:** `composeDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined`. Không đổi chữ ký của symbol đã xuất; `data-source.ts` và `database.module.ts` không đổi.
- **Dữ liệu:** không chạm schema. `dev/session.tfstate`: không có mật khẩu (chỉ ARN secret và khóa JSON).
- **Sơ đồ:**

```mermaid
sequenceDiagram
  participant ECS as ECS agent (execution role)
  participant SM as Secrets Manager + KMS
  participant N as node (env.bootstrap)
  participant RDS as RDS (TLS, CA AWS)
  ECS->>SM: GetSecretValue (secret master), Decrypt
  ECS->>N: env DB_USER, DB_PASSWORD (+ DB_HOST, CA path)
  N->>N: composeDatabaseUrl → DATABASE_URL
  N->>RDS: TLS, rejectUnauthorized + CA bundle
  RDS-->>N: chứng chỉ ký bởi CA AWS (OK) / CA khác (từ chối)
```

- **Thay đổi cấp hệ thống:** docs/03 §13 (mô tả luồng bí mật nếu có); `docs/BACKLOG.md`: xóa phần DBS-67 khỏi BL-039 và BL-103, BL-038 giữ. Không đổi ADR.
- **Hợp đồng với task khác:** DBS-68 chạy typeorm CLI trong image: `data-source.ts` import `env.bootstrap` đầu tiên nên cũng ghép; DBS-119 thay `DB_USER`/`DB_PASSWORD` bằng secret của role riêng; DBS-38 giữ `secrets` khi render nhưng revision của phiên cũ không dùng lại được (ARN secret đổi).

## 4. Test cases tự động

`jest` unit (job `unit` của CI) cho `composeDatabaseUrl`, `env.bootstrap`, `pg-ssl` và kiểm tĩnh Dockerfile (`test/support/dockerfile.spec.ts`, không cần Docker hay mạng); `terraform test` (`mock_provider`) cho `session`.

| ID | Truy vết | Lớp | Given · When · Then | Mong đợi |
|---|---|---|---|---|
| TC-67-01 | DoD 1 | unit | Có `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, không `DATABASE_URL` → `postgresql://user:pass@host:5432/name` | đúng |
| TC-67-02 | DoD 1 | unit | Mật khẩu `p@ss:w/o%rd?#x é` → mã hóa; `pg-connection-string` parse lại ra đúng user, mật khẩu, host, port, database | đúng |
| TC-67-03 | DoD 1 | unit | `DATABASE_URL` đã có → không đè; `DATABASE_URL=""` → ghép | đúng |
| TC-67-04 | DoD 1 | unit | Không `DB_HOST`; hoặc thiếu `DB_PASSWORD`/`DB_USER`/`DB_NAME`/`DB_PORT` → không ghép; `invalid` liệt kê tên biến thiếu (rỗng khi chưa cấu hình `DB_HOST`) | đúng |
| TC-67-05 | an toàn | unit | `DB_PORT` không phải số 1–65535, `DB_HOST` có `/` hoặc khoảng trắng, `DB_NAME`/`DB_USER` rỗng → không ghép, không ném; `invalid` chỉ có tên biến; mật khẩu không xuất hiện trong kết quả hay stderr | đúng |
| TC-67-06 | DoD 1 | unit | `env.bootstrap` (nạp bằng `jest.isolateModules` với env giả): đặt `process.env.DATABASE_URL` khi ghép được, không đụng khi không; `validateEnv` chấp nhận bộ `DB_*` và vẫn đòi `DATABASE_URL` khi không ghép được | đúng |
| TC-67-07 | DoD 2 | unit (TLS thật) | Máy chủ giả nói giao thức SSLRequest của PostgreSQL rồi bắt tay TLS bằng chứng chỉ do CA thử ký: `buildSslOptions` với CA đúng → bắt tay thành công; với CA khác và khi không có CA → bị từ chối, `err.code` thuộc tập ở §2; server giả gửi leaf kèm root của nó, rồi leaf trần | đúng |
| TC-67-08 | DoD 2 | tf test (session) | Task definition có `DATABASE_SSL=true`, `DATABASE_SSL_CA_PATH=/etc/ssl/rds/global-bundle.pem`, `DB_HOST` từ instance, `DB_PORT`, `DB_NAME`; mọi `secrets` có `valueFrom` kết thúc `:username::` hoặc `:password::` trên cùng ARN; `environment` không có `DB_PASSWORD`, `NODE_OPTIONS` hay `NODE_TLS_REJECT_UNAUTHORIZED` | đúng |
| TC-67-09 | DoD 1 (security) | tf test (session) | Policy `read-db-master-secret`: `secretsmanager:GetSecretValue` chỉ ARN secret master; `kms:Decrypt` chỉ CMK với `kms:ViaService` theo `var.region`; không `Resource = "*"`; policy cũ không đổi | đúng |
| TC-67-10 | DoD 1, 2 | unit (tĩnh, trong job `unit`) | Đọc `Dockerfile`: có `ADD --checksum=sha256:<64 hex>` từ `truststore.pki.rds.amazonaws.com` với `--chmod=0444`; đích `ADD` bằng `DATABASE_SSL_CA_PATH` trong `session/ecs.tf`; `USER node` còn; không `ENV`/`ARG` chứa PASSWORD hoặc SECRET; không `NODE_OPTIONS`, `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED`. (So hash với file tải về làm tay một lần, M-67-05b) | đúng |
| TC-67-11 | hồi quy | unit + tf | `npm test`, `npm run lint:check`, `npm run typecheck`, `terraform test` (`base`, `session`) vẫn đạt | đúng |
| TC-67-12 | DoD 3, 4 | thủ công | M-67-xx; README đã cập nhật | thủ công |
| TC-67-13 | DoD 5 | quy trình | PR merge, CI xanh, Dev review, bảng đối chiếu | quy trình |

## 5. Test thủ công

Người dùng yêu cầu: **bước chạy thật ghi "chưa chạy" kèm BACKLOG**. Máy này **không có Docker** (`docker ps` lỗi), nên không build được image và không dựng được Postgres/RDS thật. Phần chạy được là kiểm TLS với máy chủ TLS giả bằng Node thật và chạy tiền tải bằng `node` thật.

| Bước | Việc làm | Kết quả mong đợi | Chạy? |
|---|---|---|---|
| M-67-01 | `npm ci && npm run build` rồi `DB_HOST=h DB_PORT=5432 DB_NAME=dbs DB_USER=u DB_PASSWORD='p@ss/x' NODE_ENV=development node -e "require('./dist/config/env.bootstrap');console.log(new URL(process.env.DATABASE_URL).host)"` | in `h:5432`; không in mật khẩu | chạy |
| M-67-02 | Cùng lệnh khi `DATABASE_URL` đã đặt, khi thiếu `DB_PASSWORD`, khi `DB_PORT=abc` | giữ nguyên / không ghép; stderr chỉ nêu tên biến | chạy |
| M-67-03 | Máy chủ TLS giả (`backend/test/support`): nối bằng app (`buildSslOptions`) với CA đúng, rồi CA sai, rồi không CA | đúng: chấp nhận; sai: `err.code` thuộc tập ở §2 | chạy |
| M-67-04 | `terraform plan` ở `session` với `.tools/bin` trong PATH, profile `dbs-admin`, biến `account_id`, `state_bucket`, `image_tag` (không `apply`) | tạo **toàn bộ** stack session (đã destroy); `secrets` chỉ có ARN (known after apply); `grep -i password` trong plan không thấy giá trị | chạy nếu có credential, nếu không: chưa chạy |
| M-67-05 | `docker build` image: file CA, quyền, user, hash | build xanh; file `0444`; hash lệch thì đỏ | **chưa chạy** (không có Docker): BACKLOG |
| M-67-05b | `curl` bundle và `sha256sum`, so với hash trong Dockerfile | khớp | chạy |
| M-67-06 | Dựng `session`, task `api` chạy thật: `/health/ready` 200 qua ALB | 200; target `healthy` | **chưa chạy** (người dùng dặn ghi chưa chạy; cần `apply`, RDS ≈ 0,03 USD/giờ, image trên ECR và Redis, BL-038). Khi chạy: sau đó `destroy`, deregister task definition thử, kiểm secret `rds!db-*` đã xóa và sạch từng dịch vụ: BACKLOG |
| M-67-07 | Trên cloud: task thử với `DATABASE_SSL_CA_PATH` trỏ CA sai, kỳ vọng từ chối | kết nối bị từ chối | **chưa chạy** (cần AWS thật), dọn như M-67-06: BACKLOG |

## 6. Domain review (AI)

**Reviewer:** subagent, model opus, 2026-10-26 · 10 phát hiện (blocking 1, should-fix 5, minor 4), verdict REVISE · [trả lời nguyên văn](screenshots/DBS-67/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | không bước CI nào chạy Dockerfile; preload sai đường dẫn làm chết mọi tiến trình node | đã sửa: bỏ preload; TC-67-10 thành jest trong job `unit`, kiểm đích `ADD` khớp `ecs.tf`; build thật vẫn chưa chạy (M-67-05, BACKLOG) |
| 2 | should-fix | `DB_*` không khai báo, `NODE_OPTIONS` dễ bị ghi đè, lỗi ra stack thô | đã sửa: ghép trong `env.bootstrap`, `DB_*` vào Joi và `.env.example`, không `NODE_OPTIONS`; tf test cấm trong `environment` |
| 3 | should-fix | revision cũ trỏ ARN secret cũ sau `destroy` | đã sửa §2, §3, README; BACKLOG |
| 4 | should-fix | M-67-04 kỳ vọng sai, thiếu điều kiện chạy | đã sửa §5 |
| 5 | should-fix | chuỗi lỗi TLS viết cứng | đã sửa: kiểm theo `err.code` |
| 6 | should-fix | TC-67-05 ném lỗi, §2 không nói | đã sửa: không ghép, không ném, stderr chỉ tên biến |
| 7 | minor | `new URL().password` còn percent-encoded | đã sửa: `pg-connection-string` |
| 8 | minor | cần build/`npm ci` trước M-67-01 | đã sửa §5 |
| 9 | minor | `ViaService` cứng region, tên policy | đã sửa: `var.region`, policy riêng |
| 10 | minor | BACKLOG thiếu dọn dẹp | đã sửa §5 (ghi vào BL khi ở G4) |

Không chạy vòng 2: các sửa là chi tiết, không đổi phạm vi (bỏ preload làm thiết kế đơn giản hơn). **Quyết định ở G2** (tự duyệt theo `CLAUDE_local.md`): chấp nhận mọi xử lý; không còn câu hỏi blocking. Ghi chú: sửa #2 thêm biến `DB_*` vào cấu hình app theo §5b, không đổi `ErrorCode`, ADR hay hợp đồng event.

## 7. Kế hoạch triển khai

Gate: G2 tự duyệt. Rà soát kế hoạch: mọi file ở §3, mọi DoD và giới hạn ở §1/§2 có hàng bên dưới hoặc nằm ngoài phạm vi.

**Tóm tắt `plan` dự kiến (`session`):** thêm `aws_iam_role_policy.read_db_master_secret` (1 to add), đổi tại chỗ task definition (secrets, environment); `0 to destroy`.

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `backend/src/config/{compose-database-url,env.bootstrap}.ts`, `validation.schema.ts`, `env/.env.example` | `compose-database-url.spec.ts`, `env.bootstrap` spec, `validation.schema.spec.ts` (TC-67-01..06) | điền khi chạy | `cd backend && npm test` | `feat(config): compose database url from secret parts` |
| 2 | `backend/test/support/tls-server.ts`, `src/database/pg-ssl.spec.ts` | TC-67-07 | điền khi chạy | `cd backend && npm test` | `test(database): reject a wrong ca over tls` |
| 3 | `session/{iam.tf,ecs.tf}` | `session.tftest.hcl` (TC-67-08, 09) | điền khi chạy | `cd infra/terraform/envs/dev/session && terraform test` | `feat(infra): db secret and tls settings in the api task` |
| 4 | `backend/Dockerfile`, `backend/test/support/dockerfile.spec.ts` | TC-67-10 | điền khi chạy | `cd backend && npm test` | `feat(image): rds ca bundle in the image` |
| 5 | `backend/README.md`, `infra/terraform/README.md`, `docs/BACKLOG.md`, `docs/features/README.md` | `check-doc-links.mjs` | n/a | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(infra): rds tls and secrets` |
| 6 | (không file) | M-67-01..05b | n/a | theo §5, output vào `screenshots/DBS-67/manual-test.txt` | `docs(features): DBS-67 results` |

Rủi ro và cách lùi: lùi bằng revert commit (không đổi schema, không đổi bảng). Dùng master tạm thời (BL-103). **Quyết định ở G3** (tự duyệt): kế hoạch như trên; không `apply` AWS trong task này.

## 8. Kết quả

- **Lệnh kiểm tra** (SHA code cuối `200e041`, sau rebase là `f221a21`, cùng nội dung): `npm test` **490/490** (31 suite, 0 skipped), `npm run lint:check` sạch, `npm run typecheck` sạch, `npm run build` xanh; `terraform test` ở `session` **15/15**, `terraform fmt -check` sạch; `check-doc-links.mjs` 0 link hỏng. Lúc G4 (2026-10-29) chạy lại `npm test` 490/490, lint, typecheck và `check-doc-links.mjs`: xanh; không chạy lại `terraform test` (máy không có terraform).
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-67-01..05 | `compose-database-url.spec.ts` | đạt |
| TC-67-06 | `env.bootstrap.spec.ts` | đạt |
| TC-67-07 | `pg-ssl.tls.spec.ts` (máy chủ TLS giả: CA đúng nhận; CA sai và không CA bị từ chối; kiểm đột biến đã làm) | đạt ở local; trên CI đỏ vì thiếu fixture cho đến khi sửa ở §10, nay xanh trên CI (run 40804747779) |
| TC-67-08, 09 | `session.tftest.hcl` (`db_connection`, `db_secret_policy`) | đạt |
| TC-67-10 | `test/support/dockerfile.spec.ts` (kiểm tĩnh, không build) | đạt |
| TC-67-11 | toàn bộ bộ test, lint, typecheck | đạt |
| TC-67-12 | thủ công: một phần, xem dưới; README đã cập nhật | đạt một phần |
| TC-67-13 | quy trình | chưa làm (chờ review và merge) |

13 test case: 11 đạt, 1 đạt một phần (TC-67-12), 1 chưa làm (TC-67-13).

- **Test thủ công** ([manual-test.txt](screenshots/DBS-67/manual-test.txt), SHA `200e041`, sau rebase là `f221a21`):

| Bước | Kết quả |
|---|---|
| M-67-01 | đạt: in `h:5432`, không in mật khẩu |
| M-67-02 | đạt: `DATABASE_URL` có sẵn được giữ; thiếu `DB_PASSWORD` hoặc `DB_PORT=abc` thì không ghép, stderr chỉ nêu tên biến (giá trị `SECRETVALUE` không xuất hiện) |
| M-67-03 | đạt (5/5 test TLS) |
| M-67-04 | đạt: `terraform plan` (profile `dbs-admin`, `-lock=false`, không `apply`) báo `16 to add, 0 to change, 0 to destroy`; chỉ thấy cờ `manage_master_user_password` và `password_wo` (write-only), không có giá trị mật khẩu. `container_definitions` là `known after apply` nên không đọc được `DB_*` từ plan; phần đó do `session.tftest.hcl` kiểm |
| M-67-05 | **chưa chạy** (không có Docker): BL-106 |
| M-67-05b | đạt: sha256 bundle tải về trùng hash trong Dockerfile |
| M-67-06, M-67-07 | **chưa chạy** (cần `apply` AWS thật, người dùng dặn ghi chưa chạy): BL-106 |

Chưa có ảnh chụp màn hình (không có bước giao diện); bằng chứng là `manual-test.txt`.
- **Chưa chứng minh bằng chạy thật:** `docker build` với `ADD --checksum`, task đọc secret và nối RDS qua TLS trên AWS, quyền `kms:Decrypt` với `kms:ViaService` trên AWS thật.
- **Phạm vi so với §7:** khớp.
- **Handoff / BACKLOG:** BL-106 (chạy thật), BL-107 (xoay mật khẩu 7 ngày, revision cũ sau destroy), BL-108 (làm mới hash CA); đã rút phần DBS-67 khỏi BL-039 và BL-103.
- **Biến môi trường mới:** `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (tùy chọn, đã khai Joi và `.env.example`).

## 9. Tài liệu đã cập nhật

- `backend/README.md`: mục "Kết nối RDS qua TLS" (ghép `DATABASE_URL`, làm mới hash CA).
- `infra/terraform/README.md`: mục "Secret DB và TLS trong task api (DBS-67)".
- `docs/BACKLOG.md`: thêm BL-106, 046, 047; sửa BL-039, BL-103.
- `docs/features/README.md`: thêm dòng DBS-67.

## 10. Sửa sau G4: CI đỏ vì thiếu fixture TLS

> **Status:** Implemented (G1–G4 duyệt 2026-10-29; G4 chấp nhận không có ảnh chụp; M-67-11 PR #38 chạy sau G4, đạt) · **Cập nhật:** 2026-10-29

### 10.1 Bối cảnh

- **Triệu chứng:** job `unit` của CI đỏ trên PR #37 (run 40802029300) và PR #38 DBS-68 xếp chồng lên (run 40802029798, 40794425112): `src/database/pg-ssl.tls.spec.ts` báo `DATABASE_SSL_CA_PATH points to an unreadable file (.../tls-fixtures/ca.pem): ENOENT`, kèm `other-ca.pem`; suite không chạy được (TC-67-07). DoD 5 ("CI xanh") chưa đạt, dù §8 ghi TC-67-07 đạt.
- **Tái hiện:** `git worktree add` sạch của `chore/DBS-67-rds-tls-secrets`, `npx jest src/database/pg-ssl.tls.spec.ts` → `FAIL`, `Tests: 0 total`; thư mục `backend/test/support/tls-fixtures/` chỉ có `README.md`.
- **Nguyên nhân:** `.gitignore` dòng 5–6 (`*.pem`, `*.key`) chặn `ca.pem`, `other-ca.pem`, `server.pem`, `server.key`; commit `6de4370` chỉ đưa `README.md` lên. Ở máy local các file vẫn còn nên test đạt.
- **Fixture:** `CN=dbs-test-ca` (tự ký), `CN=dbs-other-ca` (tự ký), `CN=localhost` ký bởi `dbs-test-ca`, khóa RSA 2048 của server; hạn 2126; khóa CA đã xóa (README). Không dùng ở đâu ngoài test.
- **Baseline:** `npm run lint:check`, `npm run typecheck` sạch; `npm test` 516/516 (một lần chạy đầu có 1 test fail, không lặp lại; `pg-ssl.tls.spec.ts` chạy riêng 5/5 lần đạt). Không có Docker nên không chạy `test:e2e`, không ảnh hưởng vì sửa này chỉ đụng job `unit`.
- **Phạm vi:** đưa fixture vào repo để job `unit` có file; rebase PR #38 (DBS-68) lên nhánh đã sửa. **Ngoài phạm vi:** đổi logic `pg-ssl`, đổi workflow CI.
- **Quyết định ở G1** (người dùng duyệt 2026-10-29): (1) thêm ngoại lệ hẹp trong `.gitignore` và commit đúng 4 file fixture hiện có; (2) ghi tiếp trong §10 của doc này, sửa §8 khi xong, G4 rút gọn; (3) sau G4 rebase DBS-68 lên nhánh đã sửa, `push --force-with-lease` cả hai.

### 10.2 Hành vi

| Điều kiện | Kết quả |
|---|---|
| Clone sạch nhánh (như CI `actions/checkout`) | `backend/test/support/tls-fixtures/` có `ca.pem`, `other-ca.pem`, `server.pem`, `server.key`, `README.md`; `pg-ssl.tls.spec.ts` chạy 5/5 |
| `git check-ignore --no-index` trên 4 file fixture | không bị bỏ qua (khớp dòng ngoại lệ `!backend/test/support/tls-fixtures/…`) |
| `git check-ignore --no-index` trên file `.pem`/`.key` khác: `backend/test/support/tls-fixtures/ca.key`, `backend/test/support/other.pem`, `backend/server.key`, `infra/x.pem`; và `.env`, `backend/.env` | **vẫn** bị bỏ qua (ngoại lệ chỉ mở đúng tên file) |
| Fixture | không đổi nội dung so với bộ đã đạt ở local (cùng sha256); không có khóa CA |

### 10.3 Kiến trúc

- **Nguyên nhân gốc** (đã tái hiện, §10.1): `.gitignore` chặn `*.pem`, `*.key` ở mọi thư mục; commit `6de4370` không có ngoại lệ nên 4 file không vào git.
- **Sửa:** thêm vào cuối nhóm "Secrets" của `.gitignore`, liệt kê **từng tên file**, không dùng `*`:
  ```
  # Chứng chỉ thử của pg-ssl.tls.spec.ts (DBS-67), không phải secret: xem README trong thư mục
  !backend/test/support/tls-fixtures/ca.pem
  !backend/test/support/tls-fixtures/other-ca.pem
  !backend/test/support/tls-fixtures/server.pem
  !backend/test/support/tls-fixtures/server.key
  ```
  Commit 4 file.
- **`backend/test/support/tls-fixtures/README.md`:** sửa tên test sai (`pg-ssl.spec.ts` → `pg-ssl.tls.spec.ts`; `pg-ssl.spec.ts` dùng `readFile` giả, không đọc fixture); thêm: các file được commit có chủ đích nhờ ngoại lệ trong `.gitignore` và CONTRIBUTING §6; `server.key` chỉ thuộc chứng chỉ `CN=localhost` (SAN `localhost`, `127.0.0.1`) ký bởi CA đã hủy khóa; không tin cậy ở đâu ngoài test.
- **`CONTRIBUTING.md` §6:** dòng "Không commit … `.pem`/`.key`" thêm ngoại lệ duy nhất: 4 fixture trên, chỉ dùng cho test, khóa CA đã hủy (review #2).
- **Bàn giao DBS-155** (Gitleaks): luật `private-key` mặc định sẽ báo `server.key` (cả khi quét lịch sử); DBS-155 cần allowlist đúng đường dẫn này kèm lý do. Ghi thành một dòng BACKLOG ở G4 (review #6).
- **Không đổi:** `pg-ssl.ts`, `pg-ssl.tls.spec.ts`, workflow CI, Dockerfile. Build context của image là `backend/`, `.dockerignore` loại `test`, Dockerfile chỉ `COPY src` và file cấu hình: fixture không vào image.
- **DBS-68:** rebase `chore/DBS-68-migration-step` lên `chore/DBS-67-rds-tls-secrets` đã sửa; không đổi nội dung DBS-68.

### 10.4 Test cases tự động

| ID | Truy vết | Lớp | Given · When · Then | Mong đợi |
|---|---|---|---|---|
| TC-67-14 | DoD 5 (hồi quy lỗi này) | unit (`test/support/tls-fixtures.spec.ts`, job `unit`) | Với mỗi file trong 4 fixture: `git check-ignore -q --no-index <file>` thoát mã 1 (luật `.gitignore` không bỏ qua, kể cả khi file đã track) và `git ls-files --error-unmatch <file>` thoát 0 (đã vào git) | đỏ trước sửa, xanh sau sửa |
| TC-67-15 | an toàn | unit (cùng file) | `git check-ignore -q --no-index` trên `backend/test/support/tls-fixtures/ca.key`, `backend/test/support/other.pem`, `backend/server.key`, `infra/x.pem`, `.env`, `backend/.env` thoát 0 (vẫn bị bỏ qua) | đúng; đột biến nới ngoại lệ thành `tls-fixtures/*` làm test đỏ ở `ca.key` (M-67-10) |
| TC-67-07 | DoD 2 | unit (TLS thật) | như §4, chạy trên clone sạch | 5/5 |
| TC-67-11 | hồi quy | unit | `npm test`, `lint:check`, `typecheck` | đạt |

Test TC-67-14/15 gọi `git` bằng `execFileSync` (không qua shell). `cwd` là gốc repo tính từ `__dirname` (`resolve(__dirname, '../../..')`, như `test/support/dockerfile.spec.ts`), không dùng `process.cwd()` vì jest chạy trong `backend/`; đường dẫn truyền cho git là đường dẫn từ gốc repo. Không bỏ qua test khi thiếu `.git` hay `git`: CI có cả hai (`actions/checkout`, runner ubuntu); thiếu thì test đỏ.

### 10.5 Test thủ công

| Bước | Việc làm | Kết quả mong đợi | Chạy? |
|---|---|---|---|
| M-67-08 | **Trước sửa:** `git worktree add` sạch ở `6ed6007`, nối `node_modules`, `npx jest --config ./test/jest-unit.js src/database/pg-ssl.tls.spec.ts` | `FAIL`, `ENOENT ... ca.pem`, `Tests: 0 total` | chạy |
| M-67-09 | **Sau sửa:** cùng lệnh trên worktree sạch ở commit sửa; `ls tls-fixtures`; `sha256sum` so với bản local | 5/5 đạt; 5 file; hash trùng | chạy |
| M-67-10 | `git check-ignore -v -n --no-index` trên các đường dẫn ở §10.2; rồi đột biến: tạm đổi 4 dòng ngoại lệ thành `!backend/test/support/tls-fixtures/*`, chạy `tls-fixtures.spec.ts`, hoàn lại (`git diff .gitignore` rỗng) | 4 fixture khớp dòng `.gitignore:N:!backend/test/support/tls-fixtures/...`; các đường dẫn khác khớp `*.pem`/`*.key`/`.env`; khi đột biến TC-67-15 đỏ ở `ca.key` | chạy |
| M-67-11 | Push nhánh, xem run CI của PR #37 rồi PR #38 (sau rebase) | job `unit` xanh; URL run là bằng chứng | chạy sau khi người dùng cho push (G3 hoặc G4) |

### 10.6 Domain review (AI)

**Reviewer:** subagent, model opus, 2026-10-29 · vòng 1: 6 phát hiện (blocking 0, should-fix 3, minor 3), verdict REVISE; vòng 2 (subagent mới, opus) trên §10.2–10.5 đã sửa: 0 phát hiện, verdict APPROVE · [trả lời nguyên văn](screenshots/DBS-67/domain-review-10.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | `git check-ignore` bỏ qua file đã track nên TC-67-14 và M-67-10 không kiểm gì sau khi commit | đã sửa: `--no-index` ở TC-67-14/15, `-v -n --no-index` ở M-67-10 |
| 2 | should-fix | CONTRIBUTING §6 cấm commit `.pem`/`.key`, thiết kế không cập nhật luật | đã sửa: thêm ngoại lệ duy nhất vào CONTRIBUTING §6 (câu hỏi G2) |
| 3 | should-fix | README fixture ghi sai tên test (`pg-ssl.spec.ts`) | đã sửa §10.3: sửa tên, ghi phạm vi của `server.key` |
| 4 | minor | `cwd` của jest là `backend/`, test có thể kiểm sai đường dẫn | đã sửa: gốc repo từ `__dirname` |
| 5 | minor | TC-67-15 chưa chứng minh đỏ khi ngoại lệ bị nới | đã sửa: đột biến ở M-67-10 |
| 6 | minor (bàn giao DBS-155) | Gitleaks sẽ báo `server.key` khi DBS-155 vào CI | đã ghi §10.3; dòng BACKLOG ở G4 |

**Quyết định ở G2** (người dùng duyệt 2026-10-29): (1) thêm đúng một ngoại lệ vào CONTRIBUTING §6; (2) sau G3 được push `chore/DBS-67-rds-tls-secrets` để lấy run CI làm bằng chứng trước G4; rebase và force-push DBS-68 vẫn sau G4.

### 10.7 Kế hoạch

Rà soát kế hoạch: mọi file ở §10.3 (`.gitignore`, 4 fixture, README fixture, CONTRIBUTING §6), bàn giao DBS-155 (review #6), dòng TC-67-07 và DoD 5 ở §8, và rebase DBS-68 đều có hàng bên dưới. Ngoài phạm vi: logic `pg-ssl`, workflow CI.

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 0 | `docs/features/DBS-67-rds-tls-secrets.md` §10, `screenshots/DBS-67/domain-review-10.md` | n/a | n/a | n/a | `docs(features): DBS-67 ci fixture fix design` |
| 1 | `backend/test/support/tls-fixtures.spec.ts` | TC-67-14, TC-67-15 | điền khi chạy (kỳ vọng: TC-67-14 đỏ vì `check-ignore --no-index` thoát 0 và `ls-files --error-unmatch` lỗi) | `cd backend && npx jest --config ./test/jest-unit.js test/support/tls-fixtures.spec.ts` | gộp với bước 2 |
| 2 | `.gitignore` (4 dòng ngoại lệ), `git add` 4 fixture | (bước 1) | n/a | lệnh bước 1 xanh; `npm test`, `lint:check`, `typecheck` | `fix(database): commit the tls test fixtures` |
| 3 | `backend/test/support/tls-fixtures/README.md`, `CONTRIBUTING.md` §6 | n/a | n/a | `check-doc-links.mjs` | `docs: tls test fixtures are the only committed key` |
| 4 | `screenshots/DBS-67/manual-test.txt` (nối thêm) | M-67-08..10 | n/a | theo §10.5, SHA commit bước 2 ở đầu phần mới | gộp với bước 6 |
| 5 | (không file) push `chore/DBS-67-rds-tls-secrets` | M-67-11 (PR #37) | n/a | `gh run list --branch chore/DBS-67-rds-tls-secrets` → job `unit` xanh | n/a |
| 6 | `docs/features/DBS-67-rds-tls-secrets.md` §8 (TC-67-07, TC-67-14/15, M-67-08..11), §9; `docs/BACKLOG.md` (dòng mới: allowlist Gitleaks cho `server.key`, nguồn DBS-67, vai #5, đóng khi DBS-155 có allowlist) | n/a | n/a | `check-doc-links.mjs` | `docs(features): DBS-67 ci fixture fix results` |
| 7 (sau G4) | rebase `chore/DBS-68-migration-step` lên DBS-67; `push --force-with-lease` cả hai | M-67-11 (PR #38) | n/a | run CI PR #38 xanh | không commit mới |

Rủi ro và cách lùi: revert commit bước 2 trả lại trạng thái cũ (CI đỏ như trước); fixture không vào image (`.dockerignore`). Rebase DBS-68 có thể xung đột ở `docs/BACKLOG.md`: giải quyết bằng tay, giữ cả hai dòng.

### 10.8 Kết quả

- **Commit:** `e6c07dd` (thiết kế), `2dc8402` (sửa: `.gitignore`, 4 fixture, `tls-fixtures.spec.ts`; SHA code cuối), `9220aa1` (README fixture, CONTRIBUTING §6).
- **Lệnh kiểm tra:** `tls-fixtures.spec.ts` trước sửa **đỏ** 8/14 (4 fixture bị luật bỏ qua, 4 chưa track; 6 test TC-67-15 xanh), sau sửa **14/14**; `npm run lint:check`, `npm run typecheck` sạch; `npm test` **530/530**, 35 suite, 0 skipped (lần chạy đạt); `check-doc-links.mjs` 0 link hỏng. `npm test` ở local đỏ 3 trên 7 lần ở test không liên quan `jwks-verifier.service.spec.ts` (bàn giao BL-112). Không chạy `test:e2e` ở local (không có Docker); CI chạy `e2e` xanh.
- **CI:** PR #37 run [40804747779](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/40804747779) xanh cả 6 job (`unit` 530/530). DoD 5 phần "CI xanh" đạt cho PR #37; review và merge vẫn chờ (TC-67-13).
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-67-14 | `test/support/tls-fixtures.spec.ts` (`check-ignore --no-index`, `ls-files --error-unmatch`) | đạt (đỏ trước sửa, xanh sau) |
| TC-67-15 | cùng file, 6 đường dẫn vẫn bị bỏ qua | đạt (đột biến `tls-fixtures/*` làm đỏ đúng `ca.key`) |
| TC-67-07 | `pg-ssl.tls.spec.ts` trên worktree sạch và trên CI | đạt |
| TC-67-11 | `npm test`, lint, typecheck | đạt |

- **Test thủ công** ([manual-test.txt](screenshots/DBS-67/manual-test.txt), phần "§10", SHA code `2dc8402`):

| Bước | Kết quả |
|---|---|
| M-67-08 | đạt: worktree sạch ở `6ed6007` chỉ có `README.md`; `pg-ssl.tls.spec.ts` `FAIL`, `ENOENT ... ca.pem`, `other-ca.pem` (tái hiện đúng lỗi CI) |
| M-67-09 | đạt: worktree sạch ở `9220aa1` có đủ 5 file; `pg-ssl.tls.spec.ts` và `tls-fixtures.spec.ts` 19/19; sha256 trùng bản local |
| M-67-10 | đạt: 4 fixture khớp `.gitignore:13–16` (dòng `!`); 6 đường dẫn khác khớp `*.pem`, `*.key`, `.env`; đột biến làm đỏ đúng `ca.key is still ignored`; hoàn lại, `git diff .gitignore` rỗng |
| M-67-11 | đạt: PR #37 run 40804747779; PR #38 sau rebase run [40805584484](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/40805584484), cả 6 job xanh |

Không có ảnh chụp (không có bước giao diện); bằng chứng là `manual-test.txt` và URL run CI.
- **Phạm vi so với §10.7:** khớp. Sai khác nhỏ: test dùng `spawnSync` thay vì `execFileSync` như §10.4 ghi (cùng không qua shell; `spawnSync` trả mã thoát mà không ném, gọn hơn cho kiểm mã 0/1).
- **Bàn giao / BACKLOG:** BL-111 (allowlist Gitleaks cho `server.key`, DBS-155), BL-112 (test `jwks-verifier` phụ thuộc thời gian, module identity).

### 10.9 Tài liệu đã cập nhật

- `.gitignore`: 4 dòng ngoại lệ.
- `CONTRIBUTING.md` §6: ngoại lệ duy nhất cho fixture TLS.
- `backend/test/support/tls-fixtures/README.md`: sửa tên test, phạm vi của `server.key`, lý do commit.
- `docs/BACKLOG.md`: thêm BL-111, BL-112.
- `docs/features/DBS-67-rds-tls-secrets.md`: §8 dòng TC-67-07, §10.
- **Sau G4:** BL-109/110 trùng ID DBS-68 đã dùng, đổi thành BL-111/112. Rebase DBS-68 lên nhánh này, xung đột ở `docs/BACKLOG.md` giữ cả bốn dòng; PR #38 xanh (M-67-11).
