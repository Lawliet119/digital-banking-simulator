# DBS-185 · AC-5.10 trên cloud: dừng task giữa transaction rồi gửi lại

> **Status:** Plan approved (sau G3) · **Vai:** Dev (kịch bản kiểm, script vận hành, chạy cloud) · **Cặp đôi review:** Dev khác · **Nhánh:** `test/DBS-185-ac-5-10-kill-task-cloud` · **PR:** — · **Cập nhật:** 2026-11-15

## 1. Bối cảnh

- **Task trên board:** Task · Tuần 8 · Ưu tiên High · Deliverable/Demo: Demo 3 · Status board `To Do`. **Thực trạng (board):** AC-5.10 mới được chứng minh ở local (kill tiến trình giữa transaction). **Expect:** Bằng chứng trên cloud cho demo «failure / recovery».
- **DoD (nguyên văn, đánh số):**
  1. Chuyển tiền đang chạy, dừng task ECS giữa transaction, client gửi lại cùng Idempotency-Key → thực hiện đúng một lần (1 giao dịch, 2 bút toán)
  2. Đối soát sau đó 0 lệch; DBS-69 đúng
  3. Video và log kèm correlationId; ghi thời gian task mới lên
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **AC (BRD §5):** AC-5.10 «Hệ thống bị ngắt giữa lúc xử lý lệnh mã K · Khách gửi lại mã K · Lệnh được thực hiện đúng một lần». NFR-COR-01, BG-2 ([ADR-05](../adr/0005-idempotency-in-postgres.md)).
- **Phụ thuộc (đối chiếu repo):** DBS-121 (worker trên ECS, `infra/terraform/envs/dev/session/worker.tf`), DBS-79 (replay idempotency, [DBS-79](DBS-79-idempotency-replay.md)), DBS-117 (job đối soát ở role worker, [DBS-117](DBS-117-reconciliation-worker-job.md)): cả ba có trên `main`. DBS-69 (`check:invariants`, [DBS-69](DBS-69-ledger-invariants.md)) có trên `main`.
- **Đã có gì:**
  - `TransferService.transfer` ([transfer.service.ts](../../backend/src/modules/ledger/transfer.service.ts)) chạy **một** `TransactionService.run`: (1) `claimKey` chèn dòng `idempotency_keys` chưa commit; (2) `lockForUpdate` hai tài khoản (`ORDER BY id FOR UPDATE OF a`); (3) sync guard; (4) `insertTransfer`, `postDoubleEntry` (2 dòng), `audit.record`, `outbox.add`, `storeResult`; một COMMIT. Kill giữa (1) và (4) phải để lại 0 dòng.
  - Mọi transaction đặt `lock_timeout` 2 s, `statement_timeout` 5 s, `idle_in_transaction_session_timeout` 10 s ([transaction.helper.ts](../../backend/src/database/transaction.helper.ts), đổi được qua `DATABASE_LOCK_TIMEOUT_MS` ≤ 30 000 và `DATABASE_STATEMENT_TIMEOUT_MS` ≤ 120 000).
  - Worker chạy `ReconciliationService.reconcileOnce()` mỗi `RECONCILIATION_INTERVAL_MS` (mặc định 300 000 ms) và ghi `reconciliation_runs` ([ledger README](../../backend/src/modules/ledger/README.md#job-đối-soát-ở-role-worker-dbs-117)).
  - `dist/scripts/invariants/invariants.js` trong image, chạy bằng task `dbs-migrate` ghi đè lệnh ([backend/README §9](../../backend/README.md)); **chưa một lần nào chạy trên RDS dev** (phần còn mở của BL-128).
  - Cloud: phiên `envs/dev/session` dựng được trong ≈ 9 phút (DBS-138, DBS-164, DBS-183); service `api` một task, thay task theo kiểu dừng cũ rồi mới chạy mới (`deployment_minimum_healthy_percent = 0` khi `desired_count = 1`).
  - **Không có** test hay tài liệu nào kill một process thật giữa transaction (grep `kill`, `SIGKILL`, `pg_terminate` trong `backend/test` chỉ có kill relay ở DBS-91 và kill connection do server ở DBS-80). «Chứng minh ở local» của board dựa trên rollback của transaction (DBS-79, 80, 81); task này chạy kill thật ở local (diễn tập) rồi ở cloud.
- **Baseline (docs và script vận hành, không đổi code backend):** `check-doc-links.mjs` → `429 files checked, 0 broken link(s)` (2026-11-15, `main` c0db04a). Bốn lệnh backend (lint, typecheck, unit, e2e) không chạy vì không đổi `backend/`; chạy `npm run build` để dựng bản local dùng ở M-185-01..06 và `check:invariants`.
- **Ngoài phạm vi:** đổi code backend hoặc Terraform (mọi lệch tìm thấy thành BL); quay video (cần người thật, xem quyết định 4); kill worker (DBS-124, DBS-184); kịch bản sự cố bất đồng bộ (DBS-184); đối soát gia tăng, alarm `MISMATCH` (BL-127).
- **BACKLOG cùng module:** BL-128 (một lần chạy `invariants.js` thật trên RDS dev): task này chạy nó, đóng phần đó nếu đạt. BL-364, 370, 371 thuộc DBS-184.
- **Câu hỏi mở và quyết định ở G1 (agent tự quyết):**
  1. **Làm sao «dừng task giữa transaction» khi mọi transaction chỉ sống tối đa vài giây?** Mặc định `lock_timeout` 2 s và `statement_timeout` 5 s, ECS `stop-task` gửi SIGTERM rồi SIGKILL sau `stopTimeout` (mặc định 30 s) và app tắt êm chờ request đang chạy xong: không có cách kill đúng lúc giữa transaction mà không giữ transaction lại. Chọn: **giữ khóa dòng tài khoản nguồn từ một phiên khác** (task `dbs-migrate` ghi đè lệnh, role `dbs_migrator`; `BEGIN; SELECT … FOR UPDATE`, đứng yên, rồi `ROLLBACK` vô điều kiện; không đụng schema, không đổi dữ liệu. `SET TRANSACTION READ ONLY` **không dùng được**: PostgreSQL từ chối `SELECT FOR UPDATE` trong transaction chỉ-đọc, đã chạy thử ở vòng 2; an toàn dựa vào danh sách câu lệnh cho phép của TC-185-03), nên request chuyển tiền đã `claimKey` (dòng khóa chưa commit) rồi chờ tại `lockForUpdate`. Phương án loại: trigger `pg_sleep` trên `ledger_entries` (đổi schema trên DB, nặng hơn); `ECS Exec` kill -9 (service chưa bật `enableExecuteCommand`, phải đổi Terraform).
  2. **Hai thay đổi cấu hình tạm cho thí nghiệm (domain review vòng 1, #1).** (a) Revision `dbs-api` đăng ký bằng CLI (copy bản đang chạy, đổi `DATABASE_LOCK_TIMEOUT_MS=30000`, `DATABASE_STATEMENT_TIMEOUT_MS=60000` và `stopTimeout=2`), `update-service` sang revision đó: lock chờ được 30 s thay vì 2 s (lock-wait cũng bị `statement_timeout` giới hạn nên phải nâng cả hai), và SIGKILL tới 2 s sau SIGTERM thay vì 30 s. (b) `deregistration_delay` của target group `dbs-dev-api` về 0 bằng `aws elbv2 modify-target-group-attributes`: ECS bỏ task khỏi target group và **chờ hết thời gian xả kết nối** (30 s trong `alb.tf`, request treo giữ kết nối nên chờ đủ 30 s) rồi mới gửi SIGTERM; nếu để 30 s thì SIGKILL tới sau `stop-task` ≈ 32 s, mà `lock_timeout` (tối đa 30 s theo Joi) nổ trước và request tự rollback bằng 503: đó là rollback êm, không phải kill. Không sửa Terraform; cả hai biến mất khi `destroy` (target group bị xóa); revision đăng ký tay được `deregister` và `delete-task-definitions` ở bước dọn. Code chuyển tiền chạy y nguyên: chỉ thời gian chờ đổi. Ghi rõ ở Demo 3 để không nhầm đây là cấu hình dev thường.
  3. **Script và cách vào container (#8, #9).** Image chạy chỉ có `dist/`, `node_modules/`, `package.json` (không có `infra/`), nên `infra/scripts/ac-5-10-db.js` (hai chế độ `hold`, `probe`) được **nhúng bằng `node -e` vào `--overrides` của `run-task`** (`require('pg')` tìm từ WORKDIR `/app`); ECS giới hạn phần ghi đè 8 KiB nên script ≤ 6 KiB, kiểm ở TC-185-03. `infra/scripts/ac-5-10-overrides.js` dựng JSON `--overrides` (tránh lỗi nháy trong Git Bash); `infra/scripts/ac-5-10-taskdef.js` đọc `describe-task-definition`, bỏ các trường chỉ-đọc (`taskDefinitionArn`, `revision`, `status`, `requiresAttributes`, `compatibilities`, `registeredAt`, `registeredBy`, `deregisteredAt`) và chỉ đổi hai biến môi trường và `stopTimeout`; `infra/scripts/ac-5-10-kill.sh` điều phối. Lệnh và kết quả mong đợi ở [Demo 3 phần E](../demos/demo-3-failure-recovery.md).
  4. **Video (DoD 3):** không có người và màn hình để quay. Làm: log có dấu thời gian từng mốc, `manual-test-cloud.txt` thô, kịch bản chạy lại cho người quay (Demo 3 E). Phần «video» là **chưa làm**, có BL (gộp với DBS-140); trong bảng đối chiếu của PR, DoD 3 ghi **một phần** (log, correlationId, thời gian task mới lên đạt; video chưa), để không báo là xong.
  5. **correlationId.** Server luôn tự sinh mã ([correlation-id.middleware.ts](../../backend/src/common/middleware/correlation-id.middleware.ts)); client của lần bị kill chỉ nhận lỗi của ALB nên không có `X-Correlation-Id`. Mã của lần đó (`C1`) **có thể** còn trong log: pino-http ghi dòng `Request completed` ở sự kiện `close` của response (status 200 mặc định), nên nếu ALB cắt kết nối khi gỡ task (`deregistration_delay` 0) trước SIGKILL thì có một dòng `POST` mang `C1`; nếu ALB không cắt thì không có dòng nào. Cả hai đều hợp lệ và được ghi lại như quan sát (§2 T12). Mã của lần gửi lại (`C2`) và lần replay (`C3`) có trong header, log và audit; `transfers.correlation_id` = `C2`.
  6. **Một task api, không hai.** Với hai task phải biết task nào nhận request; một task thì chắc chắn, đổi lại có khoảng thời gian không có task (đo là «thời gian task mới lên»).
  7. **Mỗi task một phiên cloud riêng; dọn xong rồi mới sang task khác** (luật phiên).

## 2. Hành vi

**Điều cần chứng minh (AC-5.10):** lệnh chuyển tiền mã `K` đang nằm giữa transaction (dòng `idempotency_keys` đã chèn, chưa commit, đang chờ khóa tài khoản), task api bị dừng cứng (SIGKILL); khách gửi lại đúng `K` và cùng nội dung. Kết quả đúng: lần bị kill không để lại gì (transaction không bao giờ commit được, vì COMMIT phải do client gửi), lần gửi lại tạo đúng một giao dịch.

**Lần chạy hợp lệ** (mọi điều kiện, nếu không thì ghi «không hợp lệ» và chạy lại với `K` mới, sau khi giữ khóa mới):
- mẫu của `hold` thấy **một waiter** trên `transactionid` của bên giữ khóa, và waiter đó đang giữ `RowExclusiveLock` trên `idempotency_keys` (chứng minh `claimKey` đã chạy, request đang ở giữa transaction);
- **mốc thời gian neo vào cơ sở dữ liệu, không vào đồng hồ máy chạy lệnh** (vòng 3 #2): gọi `S0` là giờ (đồng hồ container `hold`, đồng bộ với AWS) của mẫu cuối cùng **chưa** có waiter và `W1` là giờ mẫu đầu tiên có waiter; request bắt đầu chờ trong (`S0`, `W1`], nên `lock_timeout` 30 s nổ không sớm hơn `S0` + 30 s. Điều kiện: `W1` ≤ `LOCKED` + 20 s (để `lock_timeout` nổ trước khi `hold` nhả lúc `LOCKED` + 60 s: đường (a) luôn xảy ra trước, hợp lệ trên cloud chỉ có đường này), và `executionStoppedAt` của task api (lúc container thoát, **không** phải `stoppedAt`, vì `stoppedAt` đến sau khi gỡ ENI) < `S0` + 25 s;
- container `api` thoát **137** (SIGKILL; app không thể thoát 143 trong 2 s vì `pg-pool.end()` chờ client đang giữ và Nest chỉ phát lại SIGTERM sau `close()`);
- `ac-5-10-kill.sh` chỉ gửi `K` khi còn không quá 15 s kể từ lúc đọc được `LOCKED` (so bằng đồng hồ máy chạy lệnh: chỉ là rào chắn thô, kết luận hợp lệ do hai điều kiện trên);
- client của lần gửi đầu nhận **502 hoặc đứt kết nối**, không có thân JSON của app và không có header `X-Correlation-Id`. Nhận 503 (`SERVICE_TEMPORARILY_UNAVAILABLE`), 201, hoặc exit 143 nghĩa là transaction tự rollback hoặc app tắt êm: không phải kill. Tiêu chí client là **điều kiện cần, chưa đủ** (502 do ALB gỡ target, không do kill): bằng chứng kill là exit 137, mẫu waiter và mốc thời gian ở trên.

| Mốc | Quan sát được | Mong đợi |
|---|---|---|
| T0 trước | số giao dịch của tài khoản nguồn `n`, số dòng sổ `e`, số dư nguồn `b1` và đích `b2`, `invariants.js` | ghi lại; PASS |
| T1 giữ khóa | log task giữ: `LOCKED` kèm `holderXid` (so bằng `transactionid = pg_current_xact_id()::xid`); mỗi 2 s một dòng mẫu | `LOCKED` trước khi gửi `K` |
| T2 gửi `K` | `POST /v1/transfers` (`Idempotency-Key: K`, 100 000 VND) chạy nền, trong ≤ `LOCKED` + 30 s | treo; mẫu: một waiter (ghi `pid` của nó), giữ `RowExclusiveLock` trên `idempotency_keys` |
| T3 dừng | đúng 5 s sau khi gửi `K`: `aws ecs stop-task`; sau đó `describe-tasks`: `stoppingAt`, `executionStoppedAt`, `stoppedAt` (chỉ để tham khảo), `stopCode`, exit code `api` | exit 137; `executionStoppedAt` < `S0` + 25 s; client lần đầu 502 hoặc đứt, không có `X-Correlation-Id` |
| T4 giữ hết hạn | `hold` nhả khóa (`RELEASED`), tổng 60 s kể từ `LOCKED` | mẫu cuối trước `RELEASED` **không còn waiter** (backend mồ côi đã hết `lock_timeout`, đường (a)); chờ task giữ `STOPPED` exit 0 |
| T5 thăm dò sau kill | `probe` (cloud: chạy sau khi task giữ đã `STOPPED`, ≥ 40 s kể từ `W1`; local: chỉ chạy sau khi process `hold` đã thoát, kèm chờ 2 s) | `keyRows` của `K` = 0 **và** `pid` của waiter (từ log `hold`) không còn dòng nào trong `pg_locks` (`waiterLocks` = 0, tức backend mồ côi đã hết; `probe` truyền `WAITER_PID`); số giao dịch, dòng sổ, số dư **bằng T0**; nếu `waiterLocks` > 0 thì `probe` lại sau ≥ 40 s và ghi các dòng `pg_locks` (`locktype`, `relation`) để phân biệt backend mồ côi còn sống với pid bị dùng lại |
| T6 task mới | ECS dựng task thay (service `desired 1`); `/health/ready` qua ALB | 200; ghi giây từ `stop-task` tới `/health/ready` 200; `createdAt`, `startedAt` của task mới |
| T7 gửi lại | cùng `K`, cùng body | 201 `{ "transferId": "…", "status": "COMPLETED" }`; header `X-Correlation-Id` = `C2` |
| T8 gửi lại lần hai | cùng `K` | 201, cùng `transferId` (replay, `C3` ≠ `C2`), không thêm dòng nào |
| T9 sau gửi lại | `probe` | `keyRows` = 1 (`response_code` 201); **1** giao dịch mới (`transferId`), **2** dòng sổ (1 DEBIT + 1 CREDIT, 100 000), số dư nguồn `b1 − 100 000`, đích `b2 + 100 000` |
| T10 đối soát | worker chạy `reconcileOnce` (≤ 5 phút sau T7); `probe` đọc `reconciliation_runs` | dòng đầu tiên có `started_at` sau T7 có `status = OK`, `mismatched_accounts = 0`, `total_debit = total_credit`, `total_balance = 0` |
| T11 DBS-69 | `invariants.js` qua task `dbs-migrate` | exit code 0, JSON `PASS`, `violations: []` |
| T12 log và audit | `GET /v1/audit/entries?correlationId=C2` (auditor); `aws logs filter-log-events` `/dbs/dev/api` | audit có dòng `transfer` mang `C2`; log của lần gửi lại mang `C2` (status 201). Luồng log của task cũ giữa lúc gửi `K` và lúc kill: **không có dòng nào** cho `POST` (ALB không cắt kết nối), hoặc **một** dòng `Request completed` `POST` status 200 mang `C1` (ALB cắt khi gỡ target, ghi ở sự kiện `close`; dùng `C1` làm mã lần bị kill cho DoD 3). Điều kiện đạt: không có dòng nào của request đó kèm 201 hoặc 503, và không client nào nhận thân 2xx của lần đó (log HTTP không ghi URL hay `Idempotency-Key`) |

**Hai đường kết thúc của backend mồ côi** (domain review #4). Khi client chết, backend PostgreSQL đang chờ khóa không đọc socket (`client_connection_check_interval` mặc định 0), nên nó chỉ kết thúc theo một trong hai cách, và **không bao giờ commit** (COMMIT do client gửi): (a) `lock_timeout` 30 s tính từ lúc bắt đầu chờ nổ (đường duy nhất của lần chạy hợp lệ trên cloud): ERROR, rollback, rồi FATAL khi ghi vào socket đã đóng; (b) task giữ nhả khóa trước: backend lấy được khóa, gửi kết quả, gặp EOF hoặc RST ở lần đọc kế, hủy; chậm nhất `idle_in_transaction_session_timeout` 10 s. Thời gian sống tối đa của backend mồ côi ≤ 30 s + 10 s kể từ lúc bắt đầu chờ. Gửi lại `K` khi backend mồ côi còn sống: lệnh `INSERT … ON CONFLICT` của lần gửi lại **chờ** xid của bản mồ côi, rồi 201 khi bản mồ côi rollback, hoặc 503 + `Retry-After` nếu chờ quá `lock_timeout` (DBS-80, DBS-81); cả hai đều ra đúng một giao dịch. Ca này chạy ở local (TC-185-10); trên cloud task mới lên sau ≥ 40 s nên bản mồ côi đã hết.

## 3. Kiến trúc

- **Vị trí:** không đổi code sản phẩm. Thêm vào `infra/scripts/`: `ac-5-10-db.js`, `ac-5-10-overrides.js`, `ac-5-10-taskdef.js`, `ac-5-10-kill.sh`; thêm phần E vào Demo 3. Role: `api` bị kill, `worker` chạy đối soát.
- **Interface dùng:** `aws ecs run-task` (task `dbs-migrate`, container `migrate`, cùng subnet và security group với `api`, [backend/README §9](../../backend/README.md)), `stop-task`, `describe-tasks`, `describe-task-definition`, `register-task-definition`, `update-service`, `aws elbv2 modify-target-group-attributes`, `aws logs filter-log-events`, API `POST /v1/transfers`, `GET /v1/audit/entries`.
- **Dữ liệu chạm tới:** chỉ **đọc** `idempotency_keys`, `transfers`, `ledger_entries`, `accounts`, `reconciliation_runs`, `pg_locks`; chỉ **khóa** một dòng `accounts` (`FOR UPDATE` trong transaction thường, rồi `ROLLBACK` vô điều kiện, không ghi gì). Tên bảng, cột khớp [database-design.md](../components/_shared/database-design.md).
- **Ranh giới transaction:** bên giữ khóa là một transaction riêng mở bằng script; bên api là transaction của `TransferService.transfer`. Hai transaction chỉ gặp nhau ở khóa dòng `accounts`.
- **Sơ đồ:**

```mermaid
sequenceDiagram
    participant H as task dbs-migrate (hold)
    participant C as client
    participant A as api (ECS task 1)
    participant P as RDS PostgreSQL
    participant W as worker
    H->>P: BEGIN; SELECT … FROM accounts WHERE id=nguồn FOR UPDATE
    C->>A: POST /v1/transfers (Idempotency-Key K)
    A->>P: BEGIN; INSERT idempotency_keys (K) chưa commit
    A->>P: SELECT … ORDER BY id FOR UPDATE (chờ H)
    Note over C,P: giữa transaction: pg_locks có waiter trên xid của H
    C-xA: stop-task (5 s sau K): bỏ khỏi ALB ngay, SIGTERM, 2 s sau SIGKILL
    alt đường (a)
        P-->>P: lock_timeout 30 s: ERROR rồi rollback; FATAL khi ghi socket đóng
    else đường (b)
        H->>P: ROLLBACK (RELEASED)
        P-->>P: backend mồ côi lấy khóa, đọc EOF, hủy: mất dòng K
    end
    Note over A: ECS dựng task api mới
    C->>A: POST /v1/transfers (cùng K) gửi lại
    A->>P: claimKey K, khóa, 1 transfers + 2 ledger_entries + audit + outbox, COMMIT
    A-->>C: 201 (C2)
    C->>A: gửi lại lần hai
    A-->>C: 201 replay cùng transferId (C3)
    W->>P: reconcileOnce → reconciliation_runs OK
```

- **Thay đổi cấp hệ thống:** không sửa ADR hay docs/03 về hành vi. Sửa: Demo 3 (phần E, trạng thái), ADR-05 dòng 53 (đã có bằng chứng), docs/03 §17 nếu cần liên kết, `docs/features/README.md`, `docs/BACKLOG.md`.
- **Rủi ro vận hành đặc thù:** revision `dbs-api` đăng ký tay và `deregistration_delay` 0 làm phiên chạy khác Terraform tới khi `destroy` (mọi thứ gắn với service và target group bị xóa; revision tay bị `deregister` và `delete`); task giữ khóa chặn **mọi** chuyển tiền của tài khoản nguồn trong lúc giữ (dùng khách seed riêng, không dùng khách thật); chi phí ≈ 0,14 USD/giờ khi api và worker chạy, cả phiên dự kiến ≤ 90 phút ≈ 0,3 USD; quên `destroy` ≈ 3,4 USD/ngày; `verify-clean.sh` không kiểm task definition (không tính tiền) nên việc `deregister` không nằm trong exit code của nó.

## 4. Test cases tự động

Task vận hành: «test tự động» là kiểm bằng lệnh trên PostgreSQL thật hoặc kiểm tĩnh script; hành vi trên cloud nằm ở §5. Test chạy trước khi viết script (đỏ vì file chưa có).

| ID | Truy vết (DoD / AC) | Lớp | Given · When · Then | `errorCode` mong đợi |
|---|---|---|---|---|
| TC-185-01 | DoD 1 (cơ chế giữ khóa) | script trên PostgreSQL 17 thật | Given DB có migration, một tài khoản; When `ac-5-10-db.js` chế độ `hold` (qua `node -e`) rồi một phiên khác `INSERT` một dòng chưa commit vào `idempotency_keys` và `SELECT … FOR UPDATE` cùng dòng `accounts`; Then log có `LOCKED` kèm `holderXid`; mẫu thấy đúng một waiter trên `transactionid` đó kèm khóa `idempotency_keys:RowExclusiveLock`; phiên kia chờ tới `RELEASED`; sau `RELEASED` dòng `accounts` có `balance` và `updated_at` **không đổi** (hold không ghi gì) | — |
| TC-185-02 | DoD 1, DoD 2 (chế độ `probe`) | script trên PostgreSQL thật | Given dữ liệu có một chuyển tiền COMPLETED; When `probe` với `K`, nguồn, đích; Then JSON có `keyRows`, `transfers`, `entries`, `balances`, `waiterLocks`, `reconciliation` (3 dòng mới nhất, tiền là chuỗi) khớp truy vấn tay; `waiterLocks` (với `WAITER_PID`) bằng số dòng `pg_locks` của đúng pid đó (≥ 1 khi dựng một transaction treo có khóa `idempotency_keys`, 0 sau khi nó kết thúc) và **không đếm chính phiên `probe`** | — |
| TC-185-03 | DoD 1 (an toàn và kích thước) | tĩnh | `ac-5-10-db.js` chỉ có `SELECT`, `BEGIN`, `ROLLBACK` (và `ROLLBACK` nằm trong `finally`), không `INSERT/UPDATE/DELETE/ALTER` và không in biến mật khẩu; lệnh `--overrides` dựng bởi `ac-5-10-overrides.js` là JSON hợp lệ và **≤ 8 192 byte**; `bash -n ac-5-10-kill.sh` | — |
| TC-185-04 | DoD 1, AC-5.10 (local) | kill process thật, PostgreSQL thật | Given api local (`node dist/main`, `APP_ROLE=api`) với `DATABASE_LOCK_TIMEOUT_MS=30000` **và** `DATABASE_STATEMENT_TIMEOUT_MS=60000`; When `hold`, gửi `K`, mẫu thấy waiter, `taskkill /F /T` api (không `/F` thì process console không bị diệt), nhả khóa, gửi lại `K` hai lần; Then lần đầu không có phản hồi; sau kill `keyRows` = 0 và không còn khóa; lần gửi lại 201; 1 giao dịch, 2 dòng sổ; `check:invariants` PASS | — |
| TC-185-05 | AC-5.10, ca biên (domain review #6) | kill process thật, PostgreSQL thật | Như TC-185-04 nhưng gửi lại `K` **ngay sau kill**, trong lúc backend mồ côi còn chờ (trước khi `hold` nhả và trước `lock_timeout`); Then lần gửi lại chờ rồi 201 (hoặc 503 + `Retry-After` rồi gửi lại 201); dù thế nào cũng đúng 1 giao dịch, 2 dòng sổ, PASS | 503 `SERVICE_TEMPORARILY_UNAVAILABLE` nếu quá `lock_timeout` |
| TC-185-06 | DoD 1 (task definition) | script | `ac-5-10-taskdef.js` nhận một mẫu `describe-task-definition` (có đủ trường chỉ-đọc); Then đầu ra không có các trường chỉ-đọc, chỉ khác mẫu ở hai biến môi trường và `stopTimeout` của container `api` | — |
| TC-185-07 | DoD 1, AC-5.10 (cloud) | ECS + RDS thật | như §2 T0..T9, lần chạy hợp lệ | như §2 |
| TC-185-08 | DoD 2 | cloud | §2 T10, T11 | `reconciliation_runs` `OK`, `invariants.js` exit 0 |
| TC-185-09 | DoD 3 (log, correlationId, thời gian) | cloud | §2 T3, T6, T7, T12: mốc thời gian, `C2`, `C3`, log, audit | có số giây task mới lên; log và audit mang `C2`; video: chưa làm |
| TC-185-10 | DoD 4 | quy trình | PR, CI xanh, bảng đối chiếu | — |
| TC-185-11 | tài liệu | kiểm tĩnh | `check-doc-links.mjs` sạch; tên bảng, cột, biến môi trường trong tài liệu khớp code (grep); `grep -E "eyJ|arn:aws|[0-9]{12}"` trên bằng chứng = 0 | — |

## 5. Test thủ công

Điều kiện: Docker (diễn tập local); AWS profile cho nhóm `dbs-admin` (repo và README ghi `dbs-admin`; trên máy này là bí danh `dbs`, đặt `AWS_PROFILE=dbs`); image `c0db04a` hoặc SHA mới hơn đã có trên ECR; container Linux `dbs-awscli` (`seed-cognito.sh`, `demo-token.sh`, `db-roles.sh`, `migrate.sh`, `seed-cloud.sh` chạy trong đó); không có phiên cloud nào khác đang chạy. **Bí mật:** không in token (gán biến, không `echo`, không `curl -v`, không `set -x`); trước khi commit `manual-test*.txt`, thay id tài khoản AWS bằng `<ACCOUNT_ID>`, ARN rút gọn, rồi `grep -E "eyJ|arn:aws|[0-9]{12}"` phải rỗng.

**Local (diễn tập):** PostgreSQL 17 và Valkey riêng (cổng 55434 và 6381, vì 5432 và 6379 bị chiếm), migration, `node dist/main` `APP_ROLE=api` với `DATABASE_LOCK_TIMEOUT_MS=30000 DATABASE_STATEMENT_TIMEOUT_MS=60000`.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-185-01 | Chạy TC-185-01, 02, 03, 06 | như §4 |
| M-185-02 | Local: onboard hai khách, nạp, ghi T0 (`probe`) và `check:invariants` | PASS, số liệu T0 |
| M-185-03 | Local: `hold` nền, gửi `K` nền, mẫu thấy waiter, `taskkill /F /T` process api (PID Windows) | request không có phản hồi; process mất |
| M-185-04 | Local: chờ `hold` nhả; `probe` | `keyRows = 0`, `waiterLocks = 0`; số liệu bằng T0 |
| M-185-05 | Local: bật api lại, gửi lại `K` hai lần | 201 cùng `transferId`; `probe`: 1 giao dịch, 2 dòng sổ, số dư đổi đúng 100 000 |
| M-185-06 | Local: `check:invariants` | PASS, `violations: []` |
| M-185-07 | Local: lặp M-185-03 với gửi lại `K` ngay sau kill (TC-185-05) | chờ rồi 201 (hoặc 503 rồi 201); 1 giao dịch, PASS |

**Cloud:** chạy bằng `infra/scripts/ac-5-10-kill.sh` (in mốc thời gian từng bước, cho phép chạy lại với `K` mới khi lần chạy không hợp lệ).

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-185-08 | `terraform apply` phiên (api 0, worker 0), `db-roles.sh`, `migrate.sh`, bật api 1 và worker 1, `seed-cognito.sh`, `seed-cloud.sh` | `/health/ready` 200; seed `total ledger balance = 0` |
| M-185-09 | Token `customer1`, `customer3`; id CHECKING nguồn và đích; `probe` T0; `invariants.js` qua task (đối chứng trước) | T0 ghi; invariants exit 0 |
| M-185-10 | Đăng ký revision `dbs-api` (khóa 30 s, statement 60 s, `stopTimeout` 2), `update-service`; `deregistration_delay` 0; chờ ổn định | task api chạy revision mới; `/health/ready` 200 |
| M-185-11 | `hold` (60 s), chờ `LOCKED`, gửi `K` nền, 5 s sau `stop-task` | §2 T1–T3: lần chạy hợp lệ |
| M-185-12 | Chờ `hold` kết thúc, `probe` | §2 T4–T5 |
| M-185-13 | Chờ `/health/ready` 200 qua ALB; đo giây | §2 T6 |
| M-185-14 | Gửi lại `K` hai lần; `probe` | §2 T7–T9 |
| M-185-15 | Chờ `reconciliation_runs` có dòng sau T7; `invariants.js` | §2 T10–T11 |
| M-185-16 | Audit theo `C2`, `filter-log-events`, sự kiện dừng của ECS | §2 T12 |
| M-185-17 | Dọn: `deregister` và `delete-task-definitions` revision tay, xóa khách Cognito thêm (nếu có), `terraform destroy`, `verify-clean.sh` | exit 0 |

Video (DoD 3): **chưa làm**, xem G1 quyết định 4.

**Nhánh lỗi của kịch bản cloud:** nếu **bất kỳ** điều kiện «Lần chạy hợp lệ» ở §2 không đạt (503, 201, exit 143, `W1` > `LOCKED` + 20 s, `executionStoppedAt` ≥ `S0` + 25 s, không có mẫu waiter), hoặc T5 có `keyRows = 1`, ghi nguyên văn, đánh dấu «không hợp lệ», chạy lại từ M-185-11 với `K` mới (task giữ chạy lại, khóa cũ đã nhả); không sửa kết quả cho đẹp. Chạy lại tối đa 3 lần rồi dừng, ghi DoD 1 «chưa đạt» và nguyên nhân (tránh đốt tiền).**Vòng 3 (hẹp, chỉ phần vòng 2 đã đổi):** subagent opus (effort medium), 2026-11-15 · **Kết quả:** 6 phát hiện (blocking 0, should-fix 3, minor 3), verdict **REVISE** · [trả lời nguyên văn](screenshots/DBS-185/domain-review-3.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| R3-1 | should-fix | `stoppedAt` đến sau khi gỡ ENI nên đánh dấu sai nhiều lần kill thật | đã sửa: dùng `executionStoppedAt` (§2 điều kiện, T3), `stoppedAt` chỉ để tham khảo |
| R3-2 | should-fix | «giờ gửi `K`» không có dấu thời gian AWS; so đồng hồ máy với AWS | đã sửa: neo vào mẫu của `hold` (`S0`, `W1`), kết luận không dùng đồng hồ máy chạy lệnh; rào chắn 15 s chỉ để từ chối gửi |
| R3-3 | should-fix | T4 «không còn waiter» sai khi `K` muộn | đã sửa: `W1` ≤ `LOCKED` + 20 s nên `lock_timeout` luôn nổ trước lúc nhả; T4 đúng với đường (a) |
| R3-4 | minor | nhánh lỗi thiếu điều kiện | đã sửa: «bất kỳ điều kiện hợp lệ nào không đạt»; tối đa 3 lần chạy lại |
| R3-5 | minor | `waiterLocks` > 0 ở T5 chưa có hướng xử lý; chạy `probe` local quá sớm | đã sửa T5: probe lại sau ≥ 40 s và ghi `pg_locks`; local chỉ probe sau khi `hold` thoát |
| R3-6 | minor | quyết định G2 (1) mâu thuẫn | đã viết lại dưới đây |

**Quyết định ở G2 (agent tự quyết):** (1) đã chạy ba vòng domain review (vòng 3 hẹp); sau vòng 3 chỉ còn sửa cách đặt mốc thời gian và điều kiện hợp lệ (không còn blocking, không đổi kiến trúc): **không chạy vòng 4**, vì các điều kiện đó được chính kịch bản cloud kiểm khi chạy (lần không hợp lệ bị ghi và chạy lại, tối đa 3 lần). (2) Giữ `SELECT FOR UPDATE` trong transaction thường (R2-1; đã chạy `psql` thấy `25006` khi `READ ONLY`). (3) Chấp nhận «cần, chưa đủ» cho tiêu chí client (R2-5) thay vì ECS Exec (phải đổi Terraform). (4) Tiêu chí giữa `K` và `W1` lấy từ mẫu của `hold`, vì chỉ có dòng log của `hold` mới có dấu thời gian chắc chắn trên đồng hồ AWS.

## 7. Kế hoạch triển khai

Công cụ phụ trợ bằng Python (chỉ thư viện chuẩn, chạy được trong container `dbs-awscli` và trong job `script-tests` của CI, không cần Node) và một script Node chạy trong image qua `node -e`. Điều phối bằng bash chạy trong container Linux `dbs-awscli` (có `aws` v1, `curl`, `python3`, `jq`; không có `uuidgen`: lấy `K` từ `/proc/sys/kernel/random/uuid`).

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `infra/scripts/tests/test_ac_5_10.py` | TC-185-03 (danh sách câu lệnh cho phép, không in mật khẩu, kích thước `--overrides` ≤ 8 192, `bash -n`), TC-185-06 (taskdef) | `python infra/scripts/tests/test_ac_5_10.py` đỏ vì chưa có `ac-5-10-*` | cùng lệnh, ở CI: job `script-tests` | `test(infra): TC-185-03, 06 cho công cụ kill giữa transaction (DBS-185)` |
| 2 | `infra/scripts/ac-5-10-db.js` (`hold`, `probe`), `infra/scripts/ac-5-10-tools.py` (`overrides`, `taskdef`) | TC-185-01, 02 (chạy tay trên PostgreSQL 17 local, raw ở `manual-test.txt`) | chạy `hold` khi file chưa có: `Cannot find module` | bước 1 xanh; M-185-01 | `feat(infra): script giữ khóa và thăm dò cho kịch bản AC-5.10 (DBS-185)` |
| 3 | `infra/scripts/ac-5-10-kill.sh` | `bash -n`; chạy `prepare`, `kill` với `aws` giả không có: kiểm lỗi thiếu biến môi trường (exit ≠ 0, không in token) | `bash -n` báo không có file | `bash -n`; M-185-02..07 (local) cho phần DB; kịch bản đầy đủ ở cloud | `feat(infra): ac-5-10-kill.sh điều phối kill task api giữa transaction (DBS-185)` |
| 4 | `docs/features/screenshots/DBS-185/manual-test.txt` (local) | TC-185-04, 05, M-185-01..07 | — | output thô; SHA commit cuối đổi script ở dòng đầu | `docs(features): kết quả diễn tập local AC-5.10 (DBS-185)` |
| 5 | `docs/features/screenshots/DBS-185/manual-test-cloud.txt` (cloud, không sửa Terraform) | TC-185-07, 08, 09, M-185-08..17 | — | `terraform apply` → `ac-5-10-kill.sh` → `destroy` → `verify-clean.sh` exit 0 | `docs(features): kết quả chạy cloud AC-5.10 (DBS-185)` |
| 6 | `docs/demos/demo-3-failure-recovery.md` (phần E, sửa bảng), `docs/adr/0005-idempotency-in-postgres.md` (dòng cách kiểm chứng), `docs/03_HIGH_LEVEL_ARCHITECTURE.md` §17, `backend/README.md` §9 (BL-128 phần chạy trên RDS), `docs/features/README.md`, `docs/BACKLOG.md`, feature doc §8, §9 | TC-185-11 | — | `check-doc-links.mjs`; `grep -E "eyJ|arn:aws|[0-9]{12}"` trên bằng chứng | `docs: AC-5.10 trên cloud trong Demo 3, ADR-05, BACKLOG (DBS-185)` |

- **Plan sweep.** Hạn chế nêu trong tài liệu liền kề đã rà: Demo 3 «chờ DBS-185» và dòng bảng nằm ngoài bảng (bước 6); ADR-05 «Cách kiểm chứng» (bước 6); [docs/03 §17](../03_HIGH_LEVEL_ARCHITECTURE.md) đã nêu «Kill task giữa lệnh» (bước 6, thêm liên kết); `backend/README.md` §9 «một lần chạy thật trên RDS dev chưa làm» (bước 5 chạy, bước 6 sửa); BL-128 (bước 6); DoD 3 video (BL mới, G1 QĐ4); DoD 4 quy trình. Không có mục nào chưa có hàng kế hoạch.
- **Rủi ro và cách lùi.** (1) Quên `destroy` → ≈ 3,4 USD/ngày: bước 5 kết thúc bằng `destroy` và `verify-clean.sh`, ghi ở §8; nếu hết giới hạn giữa chừng, ghi handoff trước khi dừng. (2) Một lần chạy cloud không hợp lệ (đồng hồ, độ trễ log): chạy lại tối đa 3 lần (§5). (3) Kịch bản không cho kết quả theo mô hình (ví dụ ECS không gỡ target nhanh như giả định): ghi nguyên văn, không sửa kết quả; DoD 1 nếu không đạt thì «chưa đạt» kèm BL. (4) Task giữ khóa chặn tài khoản nguồn: dùng khách seed riêng. (5) Task giữ chết giữa chừng không nhả khóa: khóa tự nhả khi session đóng (transaction bị hủy), không để lại gì. Back-out: bỏ commit; trên cloud `destroy`.
- **Quyết định ở G3 (agent tự quyết):** (1) công cụ JSON bằng Python để có test trong CI (job `script-tests`) và chạy được trong container Linux; script DB bằng Node vì chỉ image có `pg`; (2) test DB (TC-185-01, 02) chạy tay local và ghi raw, không đưa vào CI vì job `script-tests` không có PostgreSQL; (3) chạy diễn tập local trước cloud để lỗi kịch bản (nháy, thời gian) lộ ra khi chưa tốn tiền.
