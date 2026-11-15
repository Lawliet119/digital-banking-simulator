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
  1. **Làm sao «dừng task giữa transaction»?** Mọi transaction chỉ sống vài giây và ECS không SIGKILL ngay (SIGTERM, app tắt êm chờ request đang chạy), nên phải **giữ transaction lại** đủ lâu, không sửa code sản phẩm. Chọn: **trigger tạm `dbs185_slow`** (`BEFORE INSERT … FOR EACH STATEMENT` trên `ledger_entries`, chỉ gọi `pg_sleep(110)`), tạo và gỡ bằng task `dbs-migrate` (role `dbs_migrator` là chủ bảng). Request chuyển tiền đã `claimKey` (dòng `idempotency_keys` chưa commit), khóa hai tài khoản, `insertTransfer`, rồi vào `INSERT ledger_entries` và ngủ: transaction nằm giữa chừng, đã ghi `idempotency_keys` và `transfers`, đang giữ khóa dòng hai tài khoản. **Vì sao không giữ khóa dòng từ phiên khác (bản thiết kế đầu, đã qua ba vòng review):** lần chạy cloud 1 (2026-11-15, raw ở [manual-test-cloud.txt](screenshots/DBS-185/manual-test-cloud.txt)) cho thấy ECS chỉ gỡ task khỏi ALB 42 s sau `stop-task` rồi SIGTERM sau ≈ 74 s, trong khi chờ khóa bị `lock_timeout` cắt tối đa 30 s (Joi): request tự rollback bằng 503, container thoát 0. `pg_sleep` không bị `lock_timeout`, chỉ bị `statement_timeout` (tối đa 120 s). Phương án loại: `ECS Exec` kill -9 (service chưa bật `enableExecuteCommand`, phải đổi Terraform); hai task api (không biết task nào nhận request).
  2. **Cấu hình tạm của api và ALB (domain review vòng 1 #1; vòng 4 sau lần chạy 1).** (a) Revision `dbs-api` đăng ký bằng CLI (copy bản đang chạy, đổi `DATABASE_STATEMENT_TIMEOUT_MS=120000` và `stopTimeout=2`): giữ được 110 s và SIGKILL tới 2 s sau SIGTERM. (b) `deregistration_delay` của target group `dbs-dev-api` về 0 bằng `aws elbv2 modify-target-group-attributes`, để SIGTERM tới sớm hơn (đo ≈ 74 s sau `stop-task` thay vì ≈ 105 s). Không sửa Terraform; cả hai biến mất khi `destroy`; revision tay được `deregister` ở bước dọn. Code chuyển tiền chạy y nguyên; `lock_timeout` giữ mặc định 2 s. Ghi rõ ở Demo 3 để không nhầm đây là cấu hình dev thường.
  3. **Script và cách vào container.** Image chạy chỉ có `dist/`, `node_modules/`, `package.json`, nên `infra/scripts/ac-5-10-db.js` (bốn chế độ `slow-on`, `slow-off`, `watch`, `probe`) được **nhúng bằng `node -e` vào `--overrides` của `run-task`** (`require('pg')` tìm từ WORKDIR `/app`); ECS giới hạn phần ghi đè 8 KiB, kiểm ở TC-185-03. `infra/scripts/ac-5-10-tools.py` dựng JSON `--overrides` (`overrides`), biến đổi task definition (`taskdef`: bỏ trường chỉ-đọc, chỉ đổi biến môi trường và `stopTimeout`) và kết luận «lần chạy hợp lệ» (`evaluate`); `infra/scripts/ac-5-10-kill.sh` điều phối trong container `dbs-awscli`. Lệnh và kết quả mong đợi ở [Demo 3 phần E](../demos/demo-3-failure-recovery.md).
  4. **Video (DoD 3):** không có người và màn hình để quay. Làm: log có dấu thời gian từng mốc, `manual-test-cloud.txt` thô, kịch bản chạy lại cho người quay (Demo 3 E). Phần «video» là **chưa làm**, có BL (gộp với DBS-140); trong bảng đối chiếu của PR, DoD 3 ghi **một phần** (log, correlationId, thời gian task mới lên; video chưa), để không báo là xong.
  5. **correlationId.** Server luôn tự sinh mã ([correlation-id.middleware.ts](../../backend/src/common/middleware/correlation-id.middleware.ts)); client của lần bị kill chỉ nhận lỗi của ALB nên không có `X-Correlation-Id`. Mã của lần đó (`C1`) **có thể** còn trong log: pino-http ghi dòng `Request completed` ở sự kiện `close` của response, nên nếu ALB cắt kết nối trước SIGKILL thì có một dòng `POST` mang `C1`; nếu không thì không có. Cả hai hợp lệ, ghi lại như quan sát (§2 T12). Mã của lần gửi lại (`C2`) và replay (`C3`) có trong header, log và audit; `transfers.correlation_id` = `C2`.
  6. **Một task api, không hai.** Với hai task phải biết task nào nhận request; một task thì chắc chắn, đổi lại có khoảng không có task (đó là «thời gian task mới lên»).
  7. **Mỗi task một phiên cloud riêng; dọn xong rồi mới sang task khác** (luật phiên).

## 2. Hành vi

**Điều cần chứng minh (AC-5.10):** lệnh chuyển tiền mã `K` đang nằm giữa transaction (đã ghi `idempotency_keys` và `transfers` chưa commit, đang ngủ trong `INSERT ledger_entries`), task api bị dừng cứng (SIGKILL); khách gửi lại đúng `K` và cùng nội dung. Kết quả đúng: lần bị kill không để lại gì (transaction không bao giờ commit được vì COMMIT do client gửi), lần gửi lại tạo đúng một giao dịch, hai bút toán.

**Lần chạy hợp lệ** (mọi điều kiện; nếu không thì ghi «không hợp lệ», chạy lại với `K` mới, tối đa ba lần):
- mẫu của `watch` thấy **một backend đang giữa transaction**: giữ `RowExclusiveLock` trên `idempotency_keys`, `transfers` và `ledger_entries` (đã ghi key và transfer, đang ở lệnh sổ cái);
- mốc thời gian neo vào cơ sở dữ liệu, không vào đồng hồ máy chạy lệnh: `S0` là giờ (đồng hồ container `watch`, đồng bộ AWS) của mẫu cuối chưa có backend giữa transaction, `W1` là giờ mẫu đầu tiên có. Điều kiện: `W1` ≤ `READY` + 30 s, và `executionStoppedAt` của task api (lúc container thoát; không phải `stoppedAt`, đến sau khi gỡ ENI) < `S0` + 110 − 10 s, nghĩa là container chết khi `pg_sleep` còn ít nhất 10 s;
- container `api` thoát **137** (SIGKILL; app không thể thoát 143 trong 2 s vì `pg-pool.end()` chờ client đang giữ và Nest phát lại SIGTERM sau `close()`);
- `ac-5-10-kill.sh` chỉ gửi `K` khi `READY` cách không quá 15 s (đồng hồ máy chạy lệnh: rào chắn thô, kết luận do hai điều kiện trên);
- client của lần gửi đầu nhận lỗi **do ALB sinh ra**: không có header `X-Correlation-Id`, không có thân JSON của app, mã ∈ {502, 503, 504, 000}. Có `X-Correlation-Id` (kể cả 503 `SERVICE_TEMPORARILY_UNAVAILABLE`), 201 hoặc exit 143 nghĩa là transaction tự rollback hoặc app tắt êm: không phải kill. Tiêu chí client là **điều kiện cần, chưa đủ** (ALB cắt kết nối do gỡ target hoặc idle 60 s, không do kill): bằng chứng kill là exit 137, mẫu và mốc thời gian ở trên;
- backend mồ côi đã kết thúc khi `watch` hết hạn (170 s sau `READY`): mẫu cuối **không còn** backend giữa transaction.

| Mốc | Quan sát được | Mong đợi |
|---|---|---|
| T0 trước | số giao dịch `n`, số dòng sổ `e`, số dư nguồn `b1` và đích `b2`, `invariants.js` | ghi lại; PASS |
| T1 bật trigger, chạy `watch` | log task `slow-on`: `SLOW_ON`; log `watch`: `READY`, mỗi 2 s một mẫu | `READY` trước khi gửi `K` |
| T2 gửi `K` | `POST /v1/transfers` (`Idempotency-Key: K`, 100 000 VND) chạy nền, trong ≤ `READY` + 30 s | treo; mẫu: một backend (ghi `pid`) giữ ba khóa nói trên |
| T3 dừng | đúng 5 s sau khi gửi `K`: `aws ecs stop-task`; rồi `describe-tasks`: `stoppingAt`, `executionStoppedAt`, `stoppedAt` (chỉ tham khảo), exit code `api` | exit 137; `executionStoppedAt` < `S0` + 100 s; client lần đầu: lỗi ALB |
| T4 backend mồ côi hết | task `slow-off` (chờ tới khi mồ côi hết rồi gỡ trigger, hàm); `watch` kết thúc | mẫu cuối không còn backend giữa transaction (đường: `pg_sleep` hết, câu lệnh chạy xong, ghi vào socket đã đóng thì hủy, rollback); `probe` báo `triggerPresent` = 0 |
| T5 thăm dò sau kill | `probe` | `keyRows` của `K` = 0 **và** `pid` (từ `watch`) không còn dòng nào trong `pg_locks` (`inflightLocks` = 0); số giao dịch, dòng sổ, số dư **bằng T0**; nếu `inflightLocks` > 0 thì `probe` lại sau ≥ 40 s và ghi các dòng `pg_locks` |
| T6 task mới | ECS dựng task thay; `/health/ready` qua ALB | 200; ghi giây từ `stop-task` tới `/health/ready` 200; `createdAt`, `startedAt` của task mới |
| T7 gửi lại | cùng `K`, cùng body | 201 `{ "transferId": "…", "status": "COMPLETED" }`; header `X-Correlation-Id` = `C2` |
| T8 gửi lại lần hai | cùng `K` | 201, cùng `transferId` (replay, `C3` ≠ `C2`), không thêm dòng nào |
| T9 sau gửi lại | `probe` | `keyRows` = 1 (`response_code` 201); **1** giao dịch mới, **2** dòng sổ (1 DEBIT + 1 CREDIT, 100 000), số dư nguồn `b1 − 100 000`, đích `b2 + 100 000` |
| T10 đối soát | worker chạy `reconcileOnce` (≤ 5 phút sau T7); `probe` đọc `reconciliation_runs` | dòng đầu tiên có `started_at` sau T7: `status = OK`, `mismatched_accounts = 0`, `total_debit = total_credit`, `total_balance = 0` |
| T11 DBS-69 | `invariants.js` qua task `dbs-migrate` | exit code 0, JSON `PASS`, `violations: []` |
| T12 log và audit | `GET /v1/audit/entries?correlationId=C2` (auditor); `aws logs filter-log-events` `/dbs/dev/api` | audit có dòng `transfer` mang `C2`; log của lần gửi lại mang `C2` (201). Luồng log của task cũ giữa lúc gửi `K` và lúc kill: **không có dòng nào** cho `POST`, hoặc **một** dòng `Request completed` `POST` mang `C1` (ALB cắt trước kill; dùng `C1` làm mã lần bị kill cho DoD 3). Không có dòng nào của request đó kèm 201 |

**Backend mồ côi** (vòng 1 #4): khi client chết, backend đang chạy `pg_sleep` không đọc socket; sau khi ngủ xong nó chạy nốt `INSERT` rồi ghi vào socket đã đóng và hủy, **không bao giờ commit** (COMMIT do client gửi). Thời gian sống ≤ 110 s kể từ lúc bắt đầu ngủ. Gửi lại `K` khi nó còn sống: `INSERT … ON CONFLICT` của `claimKey` **chờ** xid của bản mồ côi rồi 201 khi bản mồ côi rollback, hoặc 503 + `Retry-After` nếu chờ quá `lock_timeout` (DBS-80, DBS-81); cả hai ra đúng một giao dịch. Ca này chạy ở local (TC-185-05); trên cloud task mới lên sau ≥ 130 s kể từ `stop-task`, bản mồ côi đã hết.

## 3. Kiến trúc

- **Vị trí:** không đổi code sản phẩm. Thêm vào `infra/scripts/`: `ac-5-10-db.js`, `ac-5-10-tools.py`, `ac-5-10-kill.sh`, test `tests/test_ac_5_10.py` (chạy trong job `script-tests` của CI); thêm phần E vào Demo 3. Role: `api` bị kill, `worker` chạy đối soát.
- **Interface dùng:** `aws ecs run-task` (task `dbs-migrate`, container `migrate`, cùng subnet và security group với `api`, [backend/README §9](../../backend/README.md)), `stop-task`, `describe-tasks`, `describe-task-definition`, `register-task-definition`, `update-service`, `aws elbv2 modify-target-group-attributes`, `aws logs filter-log-events`, API `POST /v1/transfers`, `GET /v1/audit/entries`.
- **Dữ liệu chạm tới:** đọc `idempotency_keys`, `transfers`, `ledger_entries`, `accounts`, `reconciliation_runs`, `pg_locks`, `pg_trigger`. **Ghi (DDL) duy nhất:** tạo và gỡ hàm `public.dbs185_slow()` và trigger `dbs185_slow` trên `ledger_entries` (không đổi dữ liệu, không đổi cột; trigger ngủ rồi trả về, không ghi gì). Trigger tồn tại tới `slow-off` (hoặc `destroy`). Tên bảng, cột khớp [database-design.md](../components/_shared/database-design.md).
- **Ranh giới transaction:** bên api là transaction của `TransferService.transfer`; các task `dbs-migrate` chỉ chạm DDL rồi thoát hoặc đọc.
- **Sơ đồ:**

```mermaid
sequenceDiagram
    participant H as task dbs-migrate
    participant C as client
    participant A as api (ECS task 1)
    participant P as RDS PostgreSQL
    participant W as worker
    H->>P: slow-on: CREATE TRIGGER dbs185_slow (pg_sleep 110)
    H->>P: watch: mỗi 2 s đọc pg_locks
    C->>A: POST /v1/transfers (Idempotency-Key K)
    A->>P: BEGIN; INSERT idempotency_keys (K); khóa tài khoản; INSERT transfers
    A->>P: INSERT ledger_entries → trigger ngủ 110 s
    Note over C,P: giữa transaction: watch thấy backend giữ ba khóa
    C-xA: stop-task (5 s sau K): ECS gỡ khỏi ALB (≈ 42 s), SIGTERM (≈ 74 s), 2 s sau SIGKILL
    P-->>P: ngủ xong, chạy INSERT, ghi socket đóng: hủy, rollback; mất dòng K và transfers
    H->>P: slow-off: DROP TRIGGER (chờ mồ côi hết)
    Note over A: ECS dựng task api mới
    C->>A: POST /v1/transfers (cùng K) gửi lại
    A->>P: claimKey K, khóa, 1 transfers + 2 ledger_entries + audit + outbox, COMMIT
    A-->>C: 201 (C2)
    C->>A: gửi lại lần hai
    A-->>C: 201 replay cùng transferId (C3)
    W->>P: reconcileOnce → reconciliation_runs OK
```

- **Thay đổi cấp hệ thống:** không sửa ADR hay docs/03 về hành vi. Sửa: Demo 3 (phần E, trạng thái), ADR-05 «Cách kiểm chứng», docs/03 §17 (liên kết), `backend/README.md` §9 (BL-128), `docs/features/README.md`, `docs/BACKLOG.md`.
- **Rủi ro vận hành đặc thù:** trigger `dbs185_slow` làm chậm **mọi** lệnh ghi sổ cái (chuyển tiền, nạp tiền) của cả môi trường trong lúc tồn tại: không bật khi người khác dùng phiên, gỡ ngay sau kill; quên gỡ thì mọi giao dịch ngủ 110 s (`destroy` xóa cả DB). Revision `dbs-api` đăng ký tay và `deregistration_delay` 0 làm phiên khác Terraform tới `destroy`. Chi phí ≈ 0,14 USD/giờ khi api và worker chạy; phiên dự kiến ≤ 90 phút ≈ 0,3 USD; quên `destroy` ≈ 3,4 USD/ngày; `verify-clean.sh` không kiểm task definition (không tính tiền).

## 4. Test cases tự động

Task vận hành: «test tự động» là kiểm bằng lệnh trên PostgreSQL thật hoặc kiểm tĩnh script; hành vi trên cloud nằm ở §5. Test chạy trước khi viết script (đỏ vì file chưa có).

| ID | Truy vết (DoD / AC) | Lớp | Given · When · Then | `errorCode` mong đợi |
|---|---|---|---|---|
| TC-185-01 | DoD 1 (cơ chế giữ giữa transaction) | script trên PostgreSQL 17 thật | Given DB có migration; When `slow-on` (SLEEP 8 s) rồi một phiên `BEGIN; LOCK TABLE idempotency_keys IN ROW EXCLUSIVE MODE; INSERT INTO ledger_entries …` (FK sẽ lỗi sau khi trigger ngủ) trong khi `watch` chạy; Then `watch` thấy backend đó với khóa `idempotency_keys:RowExclusiveLock` và `ledger_entries:RowExclusiveLock` trong ≈ 8 s rồi hết; `slow-off` chờ tới khi phiên kia xong rồi gỡ; `pg_trigger` và `pg_proc` không còn `dbs185_slow` | — |
| TC-185-02 | DoD 1, DoD 2 (chế độ `probe`) | script trên PostgreSQL thật | Given dữ liệu có một chuyển tiền COMPLETED; When `probe` với `K`, nguồn, đích; Then JSON có `keyRows`, `balances`, `transfers`, `entries`, `inflightLocks`, `triggerPresent`, `reconciliation` khớp truy vấn tay; `inflightLocks` (với `INFLIGHT_PID`) bằng số dòng `pg_locks` của đúng pid đó và **không đếm chính phiên `probe`** | — |
| TC-185-03 | DoD 1 (an toàn, kích thước) | tĩnh | `ac-5-10-db.js` chỉ có `SELECT`, `BEGIN`, `ROLLBACK` và DDL duy nhất `CREATE OR REPLACE FUNCTION public.dbs185_slow`, `CREATE TRIGGER dbs185_slow`, `DROP TRIGGER IF EXISTS dbs185_slow`, `DROP FUNCTION IF EXISTS public.dbs185_slow`; không `INSERT/UPDATE/DELETE`, không in biến mật khẩu; lệnh `--overrides` là JSON hợp lệ và **≤ 8 192 byte**; `bash -n ac-5-10-kill.sh`; script không in token | — |
| TC-185-04 | DoD 1, AC-5.10 (local) | kill process thật, PostgreSQL thật | Given api local (`node dist/main`, `APP_ROLE=api`, `DATABASE_STATEMENT_TIMEOUT_MS=120000`); When `slow-on` (SLEEP 20 s), `watch`, gửi `K`, mẫu thấy backend giữa transaction, `taskkill /F /T` api (không `/F` thì process console không bị diệt), chờ backend mồ côi hết, `slow-off`, gửi lại `K` hai lần; Then lần đầu đứt kết nối; sau kill `keyRows` = 0 và `inflightLocks` = 0; lần gửi lại 201; 1 giao dịch, 2 dòng sổ; `check:invariants` PASS | — |
| TC-185-05 | AC-5.10, ca biên | kill process thật, PostgreSQL thật | Như TC-185-04 nhưng gửi lại `K` **ngay sau kill**, khi backend mồ côi còn ngủ; Then lần gửi lại chờ rồi 201 (hoặc 503 + `Retry-After` rồi gửi lại 201); dù thế nào cũng đúng 1 giao dịch, 2 dòng sổ, PASS | 503 `SERVICE_TEMPORARILY_UNAVAILABLE` nếu quá `lock_timeout` |
| TC-185-06 | DoD 1 (task definition) | script | `ac-5-10-tools.py taskdef` nhận một mẫu `describe-task-definition` (đủ trường chỉ-đọc); Then đầu ra không có trường chỉ-đọc và chỉ khác mẫu ở biến môi trường và `stopTimeout` của container được chọn | — |
| TC-185-07 | DoD 1 (điều kiện hợp lệ) | script | `ac-5-10-tools.py evaluate` với nhật ký `watch` và mô tả task giả: hợp lệ khi đủ điều kiện §2; không hợp lệ (đủ lý do) khi 503 có `X-Correlation-Id`, exit 143, không có backend giữa transaction, thiếu khóa `ledger_entries`, kill muộn, `W1` muộn, mồ côi còn ở mẫu cuối | — |
| TC-185-08 | DoD 1, AC-5.10 (cloud) | ECS + RDS thật | §2 T0..T9, lần chạy hợp lệ | như §2 |
| TC-185-09 | DoD 2 | cloud | §2 T10, T11 | `reconciliation_runs` `OK`, `invariants.js` exit 0 |
| TC-185-10 | DoD 3 (log, correlationId, thời gian) | cloud | §2 T3, T6, T7, T12 | số giây task mới lên; log và audit mang `C2`; video: chưa làm |
| TC-185-11 | DoD 4 | quy trình | PR, CI xanh, bảng đối chiếu | — |
| TC-185-12 | tài liệu | kiểm tĩnh | `check-doc-links.mjs` sạch; tên bảng, cột, biến môi trường trong tài liệu khớp code (grep); `grep -E "eyJ|arn:aws|[0-9]{12}"` trên bằng chứng = 0 | — |

## 5. Test thủ công

Điều kiện: Docker (diễn tập local); AWS profile cho nhóm `dbs-admin` (repo ghi `dbs-admin`; trên máy này là bí danh `dbs`); image `c0db04a` hoặc SHA mới hơn đã có trên ECR; container Linux `dbs-awscli` (`seed-cognito.sh`, `demo-token.sh`, `db-roles.sh`, `migrate.sh`, `seed-cloud.sh`, `ac-5-10-kill.sh` chạy trong đó); không có phiên cloud nào khác. **Bí mật:** không in token (gán biến, không `echo`, không `curl -v`, không `set -x`); trước khi commit `manual-test*.txt`, thay id tài khoản AWS bằng `<ACCOUNT_ID>`, ARN rút gọn, rồi `grep -E "eyJ|arn:aws|[0-9]{12}"` phải rỗng.

**Local (diễn tập):** PostgreSQL 17 và Valkey riêng (cổng 55434 và 6381, vì 5432 và 6379 bị chiếm), migration, `node dist/main` `APP_ROLE=api` với `DATABASE_STATEMENT_TIMEOUT_MS=120000`.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-185-01 | Chạy TC-185-03, 06, 07 (`python infra/scripts/tests/test_ac_5_10.py`) | như §4 |
| M-185-02 | Local: onboard hai khách, nạp, ghi T0 (`probe`) và `check:invariants` | PASS, số liệu T0 |
| M-185-03 | TC-185-01: `slow-on`, `watch`, phiên giả, `slow-off` | như §4 |
| M-185-04 | Local: `slow-on` (20 s), `watch`, gửi `K` nền, mẫu thấy backend, `taskkill /F /T` api | request đứt; process mất |
| M-185-05 | Local: chờ mồ côi hết, `slow-off`, `probe` | `keyRows = 0`, `inflightLocks = 0`, `triggerPresent = 0`; số liệu bằng T0 |
| M-185-06 | Local: bật api lại, gửi lại `K` hai lần, `probe`, `check:invariants` | 201 cùng `transferId`; 1 giao dịch, 2 dòng sổ; PASS |
| M-185-07 | Local: lặp M-185-04 với gửi lại `K` ngay sau kill (TC-185-05) | chờ rồi 201 (hoặc 503 rồi 201); 1 giao dịch, PASS |

**Cloud:** chạy bằng `infra/scripts/ac-5-10-kill.sh` (in mốc thời gian từng bước; lần không hợp lệ được ghi và chạy lại).

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-185-08 | `terraform apply` phiên (api 0, worker 0), `db-roles.sh`, `migrate.sh`, bật api 1 và worker 1, `seed-cognito.sh`, `seed-cloud.sh` | `/health/ready` 200; seed `total ledger balance = 0` |
| M-185-09 | `prepare` (revision tạm, `deregistration_delay` 0); `baseline`: `probe` T0, `invariants.js` (đối chứng trước) | T0 ghi; invariants exit 0 (lần đầu chạy trên RDS: BL-128) |
| M-185-10 | `kill`: `slow-on`, `watch`, gửi `K` nền, 5 s sau `stop-task`, chờ task cũ dừng, `slow-off`, `evaluate` | §2 T1–T4: lần chạy hợp lệ |
| M-185-11 | `recover`: `probe` T5, chờ `/health/ready` 200, đo giây, gửi lại `K` hai lần, `probe` T9 | §2 T5–T9 |
| M-185-12 | `verify`: chờ `reconciliation_runs` có dòng sau T7, `invariants.js`, audit theo `C2`, `filter-log-events`, sự kiện dừng của ECS | §2 T10–T12 |
| M-185-13 | Dọn: `cleanup`, xóa khách Cognito thêm (nếu có), `terraform destroy`, `verify-clean.sh` | exit 0 |

Video (DoD 3): **chưa làm**, xem G1 quyết định 4.

**Nhánh lỗi của kịch bản cloud:** nếu **bất kỳ** điều kiện «Lần chạy hợp lệ» ở §2 không đạt, hoặc T5 có `keyRows = 1`, ghi nguyên văn, đánh dấu «không hợp lệ», chạy lại pha `kill` với `K` mới (gỡ trigger bằng `slow-off` trước). Tối đa ba lần chạy lại rồi dừng, ghi DoD 1 «chưa đạt» và nguyên nhân (tránh đốt tiền). Lần chạy cloud 1 (giữ khóa dòng) là một lần «không hợp lệ» như vậy: raw giữ ở `manual-test-cloud.txt`.

## 6. Domain review (AI)

Bốn vòng, reviewer subagent model opus (effort medium), 2026-11-15. Raw: [vòng 1](screenshots/DBS-185/domain-review.md), [vòng 2](screenshots/DBS-185/domain-review-2.md), [vòng 3](screenshots/DBS-185/domain-review-3.md), [vòng 4](screenshots/DBS-185/domain-review-4.md). Bản thiết kế đầu (giữ khóa dòng) qua vòng 1–3; sau lần chạy cloud 1 cơ chế đổi (G1 quyết định 1), vòng 4 duyệt phần đổi.

**Vòng 1:** 15 phát hiện (blocking 2, should-fix 8, minor 5), verdict REVISE.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | `stop-task` bỏ task khỏi ALB và chờ `deregistration_delay` rồi mới SIGTERM; `lock_timeout` nổ trước SIGKILL | đã sửa: `deregistration_delay` 0 tạm (G1 QĐ2b). Lần chạy 1 cho thấy chưa đủ (SIGTERM vẫn ≈ 74 s): đổi cơ chế (G1 QĐ1, §8) |
| 2 | blocking | tiêu chí «5xx từ ALB» và «exit 137 hoặc SIGTERM» không phân biệt kill với 503 rollback êm | đã sửa: §2 «Lần chạy hợp lệ» (lỗi ALB không có `X-Correlation-Id`, exit 137) |
| 3 | should-fix | `keyRows = 0` không chứng minh gì (dòng chưa commit vô hình) | đã sửa: `watch` thấy backend giữ khóa `idempotency_keys`; `probe` kiểm `pid` không còn trong `pg_locks` |
| 4 | should-fix | mô tả backend mồ côi sai (không đọc socket khi chờ) | đã sửa: §2 «Backend mồ côi» (không bao giờ commit, sống ≤ 110 s) |
| 5 | should-fix | TC-185-04 thiếu `DATABASE_STATEMENT_TIMEOUT_MS`, thiếu `/F` | đã sửa TC-185-04 |
| 6 | should-fix | thiếu ca gửi lại khi mồ côi còn sống | đã thêm TC-185-05, M-185-07 |
| 7 | should-fix | độ trễ log và khởi động task; `stop-task` ở thời điểm cố định | đã sửa: `stop-task` đúng 5 s sau `K`; mốc neo vào mẫu của `watch`; nhánh lỗi chạy lại |
| 8 | should-fix | script vào container bằng cách nào, giới hạn 8 KiB | đã sửa: G1 QĐ3, TC-185-03 |
| 9 | should-fix | `register-task-definition` cần bỏ trường chỉ-đọc | đã thêm `taskdef` và TC-185-06 |
| 10 | should-fix | rò token, ARN, id tài khoản vào bằng chứng | đã sửa: quy tắc ở §5, TC-185-12 |
| 11 | minor | «log task cũ không có `K`» vô nghĩa | đã sửa §2 T12 |
| 12 | minor | chi phí theo giờ; `delete-task-definitions` | đã sửa §3, `cleanup` |
| 13 | minor | tên profile | đã sửa §5 |
| 14 | minor | quyền của task giữ (đề xuất `READ ONLY`) | **không sửa như đề xuất:** `SELECT FOR UPDATE` bị từ chối trong transaction chỉ-đọc (đã chạy thử, vòng 2 #1). Cơ chế đã đổi sang trigger; an toàn dựa vào danh sách câu lệnh cho phép của TC-185-03 |
| 15 | minor | video chưa làm, DoD 3 không thể tick | giữ BL; bảng đối chiếu ghi DoD 3 «một phần» (G1 QĐ4) |

**Vòng 2:** 6 phát hiện (blocking 1, should-fix 3, minor 2), verdict REVISE: `READ ONLY` làm `FOR UPDATE` lỗi 25006 (reviewer và tôi đều chạy lại, đã sửa); `lockHolders` không bao giờ 0 (probe tự giữ khóa, worker cleanup xóa `idempotency_keys`) nên kiểm theo `pid`; dòng log `close` khi ALB cắt kết nối là `C1` hợp lệ (QĐ5); cận trên thời điểm gửi `K`; tiêu chí client «cần, chưa đủ»; so `xid` với `pg_current_xact_id()::xid`. Đã sửa hết (nay áp dụng cho cơ chế trigger: `inflightLocks`, `S0`, `W1`, QĐ5, `::xid` ở `probe`).

**Vòng 3 (hẹp):** 6 phát hiện (should-fix 3, minor 3), verdict REVISE: dùng `executionStoppedAt` thay `stoppedAt` (đến sau khi gỡ ENI); neo mốc thời gian vào mẫu của tác vụ trong DB (`S0`, `W1`) thay vì so đồng hồ máy với AWS; điều kiện `W1`; nhánh lỗi liệt kê đủ điều kiện; xử lý `inflightLocks` > 0; sửa quyết định G2 mâu thuẫn. Đã sửa hết.

**Vòng 4:** xem dưới, chạy sau khi đổi cơ chế.

**Quyết định ở G2 (agent tự quyết):** (1) ba vòng review cho thiết kế đầu, một vòng 4 hẹp cho cơ chế mới (không còn blocking ngoài các điểm đã sửa thì không chạy vòng 5); (2) giữ DDL của `dbs185_slow` ở mức nhỏ nhất và liệt kê trong TC-185-03; (3) chấp nhận «cần, chưa đủ» cho tiêu chí client thay vì ECS Exec (phải đổi Terraform); (4) mốc thời gian lấy từ mẫu của `watch` vì chỉ log của nó có dấu thời gian chắc chắn trên đồng hồ AWS.

## 7. Kế hoạch triển khai

Công cụ phụ trợ bằng Python (chỉ thư viện chuẩn, chạy được trong container `dbs-awscli` và trong job `script-tests` của CI, không cần Node) và một script Node chạy trong image qua `node -e`. Điều phối bằng bash chạy trong container Linux `dbs-awscli` (có `aws` v1, `curl`, `python3`, `jq`).

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `infra/scripts/tests/test_ac_5_10.py` | TC-185-03, 06, 07 | `python infra/scripts/tests/test_ac_5_10.py` đỏ vì chưa có `ac-5-10-*` (8 lỗi, 2 error trên lần chạy đầu) | cùng lệnh; ở CI: job `script-tests` | `test(infra): TC-185-03, 06 cho công cụ kill giữa transaction (DBS-185)` |
| 2 | `infra/scripts/ac-5-10-db.js`, `infra/scripts/ac-5-10-tools.py` | TC-185-01, 02 (tay trên PostgreSQL 17 local, raw ở `manual-test.txt`) | `Cannot find module` khi chạy script chưa có | bước 1 xanh; M-185-03 | `feat(infra): script giữ khóa, thăm dò và công cụ JSON cho kịch bản AC-5.10 (DBS-185)` |
| 3 | `infra/scripts/ac-5-10-kill.sh` | `bash -n`; thiếu biến môi trường thì từ chối, không in token | `bash -n` báo không có file | `bash -n`; M-185-02..07 (local) | `feat(infra): ac-5-10-kill.sh điều phối kill task api giữa transaction (DBS-185)` |
| 3b | cả ba file trên (gate phụ, §8): cơ chế giữ khóa dòng → trigger `pg_sleep` | TC-185-01, 03, 07 sửa trước | test đỏ với `slow-on`, `watch` chưa có | bước 1 xanh lại; M-185-03..07 chạy lại local | `feat(infra): đổi cơ chế giữ transaction sang trigger pg_sleep (DBS-185)` |
| 4 | `docs/features/screenshots/DBS-185/manual-test.txt` (local) | TC-185-04, 05, M-185-01..07 | — | output thô; SHA commit cuối đổi script ở dòng đầu | `docs(features): kết quả diễn tập local AC-5.10 (DBS-185)` |
| 5 | `docs/features/screenshots/DBS-185/manual-test-cloud.txt` (cloud, không sửa Terraform) | TC-185-08, 09, 10, M-185-08..13 | — | `terraform apply` → `ac-5-10-kill.sh` → `destroy` → `verify-clean.sh` exit 0 | `docs(features): kết quả chạy cloud AC-5.10 (DBS-185)` |
| 6 | `docs/demos/demo-3-failure-recovery.md` (phần E, sửa bảng), `docs/adr/0005-idempotency-in-postgres.md`, `docs/03_HIGH_LEVEL_ARCHITECTURE.md` §17, `backend/README.md` §9 (BL-128), `docs/features/README.md`, `docs/BACKLOG.md`, feature doc §8, §9 | TC-185-12 | — | `check-doc-links.mjs`; `grep -E "eyJ|arn:aws|[0-9]{12}"` trên bằng chứng | `docs: AC-5.10 trên cloud trong Demo 3, ADR-05, BACKLOG (DBS-185)` |

- **Plan sweep.** Hạn chế nêu trong tài liệu liền kề đã rà: Demo 3 «chờ DBS-185» và dòng bảng nằm ngoài bảng (bước 6); ADR-05 «Cách kiểm chứng» (bước 6); [docs/03 §17](../03_HIGH_LEVEL_ARCHITECTURE.md) (bước 6); `backend/README.md` §9 «một lần chạy thật trên RDS dev chưa làm» (bước 5 chạy, bước 6 sửa); BL-128 (bước 6); DoD 3 video (BL mới, G1 QĐ4); DoD 4 quy trình. Không có mục nào chưa có hàng kế hoạch.
- **Rủi ro và cách lùi.** (1) Quên `destroy` → ≈ 3,4 USD/ngày: bước 5 kết thúc bằng `destroy` và `verify-clean.sh`; nếu hết giới hạn giữa chừng, ghi handoff trước khi dừng. (2) Lần chạy cloud không hợp lệ: chạy lại tối đa 3 lần (§5). (3) Trigger quên gỡ: `slow-off` trong pha `kill` và `probe` báo `triggerPresent`; `destroy` xóa cả DB. (4) Kịch bản không cho kết quả theo mô hình: ghi nguyên văn, DoD 1 «chưa đạt» kèm BL. Back-out: bỏ commit; trên cloud `destroy`.
- **Quyết định ở G3 (agent tự quyết):** (1) công cụ JSON bằng Python để có test trong CI và chạy trong container Linux; script DB bằng Node vì chỉ image có `pg`; (2) test DB (TC-185-01, 02) chạy tay local và ghi raw, không đưa vào CI vì job `script-tests` không có PostgreSQL; (3) diễn tập local trước cloud để lỗi kịch bản lộ ra khi chưa tốn tiền. Hàng 3b là **gate phụ** sau G3 (rời kế hoạch đã duyệt): quyết định và lý do ở §8 trước khi sửa code.

## 8. Kết quả

- **Lệch so với kế hoạch #1 (gate phụ, quyết định trước khi sửa code, 2026-11-15 ~09:00).** *Sự việc:* lần chạy cloud 1 với cơ chế «giữ khóa dòng tài khoản» **không hợp lệ**: stop-task lúc 01:52:59, ECS ghi «deregistered 1 targets / begun draining» lúc 01:53:42 (+42 s), container thoát 0 lúc 01:54:16; `lock_timeout` 30 s (mức Joi tối đa) đã làm request tự rollback bằng 503 lúc 01:53:25. Raw: [manual-test-cloud.txt](screenshots/DBS-185/manual-test-cloud.txt). Domain review vòng 1 #1 đã đoán đúng hướng (độ trễ ALB) nhưng không đoán được độ trễ của bộ lập lịch ECS. *Phương án:* (a) giữ khóa dòng và đòi `lock_timeout` lớn hơn 30 s: không thể, Joi chặn ở 30 000; (b) trigger `pg_sleep` trên `ledger_entries`: giữ được tới `statement_timeout` (≤ 120 s), DDL nhỏ và tạm; (c) `ECS Exec`: phải sửa Terraform. *Chọn (b)* vì thay đổi ít nhất, không đổi ADR, hợp đồng hay luật tiền, và cho bằng chứng mạnh hơn (transaction đã ghi `idempotency_keys` và `transfers`). *Hệ quả:* script `ac-5-10-db.js` đổi chế độ (`slow-on`, `slow-off`, `watch`, `probe`), `evaluate` đổi điều kiện, tài liệu §1–§7 viết lại, vòng domain review 4 cho phần đổi, diễn tập local chạy lại.
