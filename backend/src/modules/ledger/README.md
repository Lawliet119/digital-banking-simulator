# ledger 🔴 Core — #1

Mọi đồng tiền vào, ra, di chuyển. Nơi duy nhất được phép thay đổi số dư.

> **Status:** Implemented: schema, trigger append-only, công cụ kiểm bất biến, nạp/chuyển tiền, replay idempotency, sync guard (hạn mức lần/ngày, bộ đếm BL-418), lịch sử và trạng thái giao dịch (DBS-87), job đối soát ở worker (DBS-117, bộ đếm BL-421) · **Owner:** Dev (Ledger) · **Verified against code:** `2026-11-22` (DBS-142): mô tả hành vi (nạp và chuyển tiền, guard, lịch sử, job đối soát) đối chiếu với code và test. Chưa kiểm: các số đo hiệu năng (0,163 ms, 0,118 ms, 203 và 256 ms) và quyền `dbs_worker` trên ECS thật.

Migration `AddAppendOnlyTriggers1792627200002` bật hai trigger cho mỗi bảng `transfers`, `ledger_entries`: BEFORE UPDATE/DELETE theo hàng và BEFORE TRUNCATE theo statement, cùng hàm `public.forbid_mutation()` của [DBS-27](../../../../docs/features/DBS-27-append-only-triggers.md). INSERT vẫn được phép; mutation có hàng và TRUNCATE kể cả bảng rỗng trả SQLSTATE `42501` từ RAISE của hàm. UPDATE/DELETE không khớp hàng trả 0 hàng. Test dùng owner NOSUPERUSER và đối chứng quyền sau down; quyền production và chủ view `v_transfer_facts` nằm ở migration `CreateDbRolesAndGrants` ([DBS-119](../../../../docs/features/DBS-119-db-roles-grant-matrix.md)). Revert chỉ gỡ trigger/hàm, giữ dữ liệu và sequence nhưng làm mất lớp bảo vệ này; không dùng revert như cách sửa dữ liệu nghiệp vụ.

|             |                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Use case    | UC-3 nạp tiền · UC-5 chuyển tiền · UC-6 lịch sử · UC-7 trạng thái giao dịch                                                      |
| Chạy ở      | `api`; job đối soát chạy ở `worker` (scheduler bị chặn ở role `api`, ADR-13)                                                     |
| Sở hữu bảng | `transfers`, `ledger_entries`, `idempotency_keys`, `reconciliation_runs`; ghi sự kiện qua `OutboxWriter.add` của module `outbox` |
| Thiết kế    | `docs/03` §6.1 (luồng chuyển tiền), §8 (dữ liệu) · `docs/BRD.md` Phần 2 §3 (AC-5.x)                                                         |

## Phải giữ

- Chuyển tiền và nạp tiền là **một transaction**: `TransactionService.run(manager => …)` — mã yêu cầu, khóa tài khoản, kiểm tra, bút toán, số dư, nhật ký, outbox cùng commit hoặc cùng rollback.
- Khóa hai tài khoản **theo thứ tự id**; sync guard (hạn mức) chạy **sau** `SELECT … FOR UPDATE`.
- Không gọi Redis / HTTP / SQS **bên trong** transaction (retry sẽ lặp lại tác dụng phụ, và khóa bị giữ lâu). Sự kiện đi qua bảng `outbox_events`.
- Tiền là `bigint`/string (đơn vị đồng), không bao giờ `number` có phần thập phân.
- `ledger_entries` chỉ INSERT.
- Lý do từ chối dùng `RejectReason` (`@common/errors/reject-reason`); trả HTTP 422 kèm `errorCode` và `transferId`.

## Export công khai (`index.ts`)

`LedgerModule` phục vụ operator deposit, customer transfer, lịch sử và trạng thái giao dịch ở api/both; không nạp HTTP ledger trong worker. `LedgerReconciliationModule` (job đối soát) chỉ nằm ở `workerModules`. Ngoài hai module, `index.ts` export: `ReconciliationService`, `RECONCILIATION_CHECK_SQL`, `classifyReconciliationSnapshot` và các kiểu của kết quả đối soát; `SyncGuardService`, `SENT_TODAY_SQL`; `buildHistorySql`, `TransactionItemDto` (module `risk` dùng để dựng lịch sử cho fraud); `transferCorrelationId`.

`transferCorrelationId(manager, transferId)` (DBS-135) trả `transfers.correlation_id` trên `manager` của người gọi (`undefined` nếu không có giao dịch). Module khác (hiện là `risk`, khi ghi audit của review) gọi hàm này thay vì đọc bảng `transfers`.

## Nạp tiền bản thô (DBS-60)

`POST /v1/operator/deposits` chỉ operator; body `{toAccountId,amount}` với amount là chuỗi VND dương chuẩn, header `Idempotency-Key` bắt buộc, 1–128 ký tự. Transaction reserve key → `AccountsService.lockForUpdate` theo id → kiểm đích ACTIVE → transfer DEPOSIT +hai ledger lines +hai cập nhật số dư qua AccountsService → audit → TransferCompleted qua OutboxWriter → lưu response key → commit. SYSTEM funding được âm và bỏ qua hạn mức/số dư nguồn.

Đích LOCKED/missing/SYSTEM: ghi transfer REJECTED +audit +key, commit rồi 422 ACCOUNT_NOT_ACTIVE; không bút toán/sự kiện/đổi tiền. Metadata audit giữ UUID đích yêu cầu khi FK đích NULL. Funding thiếu/hỏng hoặc lỗi ghi bất kỳ trả 500 (lỗi tạm thời: 503), toàn bộ transaction/key rollback. Thư viện money giữ bigint/string, cả giá trị >2^53; ledger không ghi `accounts` trực tiếp (chỉ qua `AccountsService`), và chỉ đọc thẳng ở tra cứu lệnh (`transfer-query.service.ts`) và job đối soát.

Idempotency (ADR-05): cùng key và cùng body trả lại đúng kết quả lần đầu mà không nạp lần hai (cả 422 đã lưu, cùng `transferId`); cùng key khác body trả 422 `IDEMPOTENCY_KEY_REUSED`. Key theo từng actor nên không lộ kết quả của người khác. Phần dùng chung (đặt chỗ key, hash, ghi transfer, sổ kép, lưu kết quả) nằm ở `ledger-posting.service.ts`. Event dùng fromUserId null/sameOwner false, fromBalanceBefore có dấu và occurredAt từ DB, mọi thời gian ISO Z. Test thật/fault rollback và bằng chứng ở [DBS-60](../../../../docs/features/DBS-60-operator-deposits.md).

## Chuyển tiền bản thô (DBS-61)

`POST /v1/transfers` chỉ dành cho customer. Body `{fromAccountId, toAccountId, amount}`: hai UUID khác nhau, `amount` là chuỗi số đồng dương. Header `Idempotency-Key` bắt buộc, 1–128 ký tự.

- Nguồn được kiểm quyền bằng `getOwnedAccount(fromId, {userId, role:'customer', action:'ledger.transfer', correlationId})` trước khi mở transaction; chính `getOwnedAccount` ghi audit `DENIED` (action `ledger.transfer`) rồi mới ném 404, `TransferService` không ghi thêm. Nguồn của người khác, không tồn tại hoặc là SYSTEM đều trả cùng một 404, và audit `DENIED` được ghi ngoài transaction nghiệp vụ.
- Trong một transaction: đặt chỗ key → khóa tài khoản theo thứ tự id → kiểm lại chủ sở hữu trên bản đã khóa, rồi chạy sync guard → ghi transfer, hai dòng sổ, hai số dư, audit, event `TransferCompleted` và kết quả của key.
- Nguồn hoặc đích LOCKED, đích không tồn tại hoặc SYSTEM → 422 `ACCOUNT_NOT_ACTIVE`; thiếu tiền (và không vượt hạn mức) → 422 `INSUFFICIENT_FUNDS`. Transfer REJECTED, audit và kết quả của key được commit trước khi trả 422; không có dòng sổ, event hay thay đổi số dư.
- Đích là tài khoản `funding` không bị khóa (chỉ khóa nguồn), để lệnh chuyển tới `funding` không phải xếp hàng sau các lệnh nạp tiền. Nếu sau này có tài khoản SYSTEM khác, phải mở rộng điều kiện này trong `transfer.service.ts`.
- Mọi lỗi ghi đều rollback toàn bộ kể cả key; lỗi tạm thời trả 503 và thử lại được với cùng key.
- Vượt `RATE_LIMIT_TRANSFERS_PER_MINUTE` (mặc định 10, cửa sổ cố định một phút, đếm trong Redis; Redis lỗi thì bộ giới hạn cho qua) trả 429 `RATE_LIMITED` (DBS-89) trước khi chạm sổ cái.
- Cùng key khác body: lỗi 422 `IDEMPOTENCY_KEY_REUSED` được ném ngay trong transaction nên transaction **rollback** (không ghi gì); cùng body thì replay và commit.
- Hai tài khoản khác nhau của cùng một người được phép, event có `sameOwner = true`.

Sync guard (DBS-82): `SyncGuardService.checkGuards(manager, lockedFrom, lockedTo, amount): Promise<RejectReason | null>` chạy **sau** `lockForUpdate`, luôn `await`, và từ chối trả lời (`AccountNotLockedError`) nếu hai tài khoản chưa được khóa trong transaction này. Lý do đầu tiên đúng được trả, theo thứ tự: hai tài khoản ACTIVE (đích không tồn tại hoặc không phải tài khoản khách tính là không ACTIVE) → hạn mức mỗi lần (`TRANSFER_LIMIT_PER_TX`) → hạn mức ngày (`TRANSFER_LIMIT_PER_DAY`, tổng dòng ghi nợ của tài khoản nguồn từ 00:00 giờ Việt Nam) → đủ tiền. **Hạn mức ngày (DBS-84, BL-418) đọc bộ đếm trên dòng đã khóa, không truy vấn:** `lockForUpdate` trả thêm `sentToday` và `sentDay` (ngày VN lớn nhất có dòng ghi nợ và tổng ngày đó, do trigger `ledger_entries_daily_debit_counter` giữ trong cùng transaction với dòng sổ cái). `"bây giờ"` do `Clock` (tiêm được, đọc **sau** khóa, một lần) đổi ra ngày VN bằng `vietnamDay`: cùng ngày thì dùng `sentToday`, ngày cũ hơn hoặc NULL thì 0, ngày **mới hơn** đồng hồ thì chạy `SENT_TODAY_SQL` như trước (đường lùi, kết quả giống hệt). `SENT_TODAY_SQL`: mốc 00:00 giờ Việt Nam tính từ `$2` của `Clock`; plan là `Index Only Scan` trên `ledger_entries_daily_debit_idx`, 0,163 ms với tài khoản 1 triệu dòng ([database-design §7.1](../../../../docs/components/_shared/database-design.md)); không đưa `clock_timestamp()` vào câu SQL này: hàm VOLATILE không làm được điều kiện index (Seq Scan: 256 ms ở lần đo thiết kế và 203 ms ở lần chạy lại, [DBS-84](../../../../docs/features/DBS-84-daily-limit-vn-time.md)). Ai ghi dòng `DEBIT` cũng được đếm (trigger), nên code cũ trong lúc triển khai cuốn chiếu không làm bộ đếm thiếu; kiểm bất biến `daily_debit_totals` so bộ đếm với sổ cái ([BL-418](../../../../docs/features/BL-418-daily-limit-counter.md)). Giới hạn đọc từ `limits.config` lúc gọi. Vượt hạn mức → 422 `LIMIT_PER_TX_EXCEEDED` / `LIMIT_PER_DAY_EXCEEDED`, lệnh vẫn được lưu `REJECTED`. Ranh giới 00:00 giờ Việt Nam được test với DB chạy UTC, `Clock` cố định và dòng sổ chèn đúng thời điểm ([DBS-85](../../../../docs/features/DBS-85-midnight-boundary.md)). Test dùng PostgreSQL thật, tiền vào qua API nạp tiền. Bảng case và bằng chứng nằm ở [DBS-61](../../../../docs/features/DBS-61-customer-transfers.md).

## Lịch sử và trạng thái giao dịch (DBS-87)

- `GET /v1/accounts/{id}/transactions` (UC-6, customer): `getOwnedAccount` (`account.transactions`) trước transaction, rồi một transaction đọc trang + ghi audit `SUCCESS`. Câu SQL (`buildHistorySql`) liệt kê từng cột, sắp `created_at DESC, id DESC` đúng thứ tự index `ledger_entries_account_history_idx` nên trang đầu là Index Scan không Sort (0,118 ms với 1 triệu dòng, [database-design §7.1](../../../../docs/components/_shared/database-design.md)); cursor là `(created_at, id)` giữ micro giây, gắn với bộ lọc `from`/`to`; không dùng OFFSET. Chỉ có dòng sổ, tức lệnh `COMPLETED`.
- `GET /v1/transfers/{id}` (UC-7, customer): người gửi xem mọi trạng thái, người nhận chỉ lệnh `COMPLETED`; còn lại là cùng một 404 + audit `DENIED` (`transfer.read`). Lệnh `REJECTED` không có trường id đích (BL-175 đã đóng): ba loại đích bị từ chối cho cùng một dạng phản hồi.
- Hai DTO (`TransactionItemDto`, `TransferStatusDto`) chép từng trường; test chụp danh sách khóa và quét chuỗi `fraud|flag|risk|score|review|rule` (AC-10.2). Thêm cột vào `transfers`/`ledger_entries` không tự lộ ra API.

## Lưu kết quả đối soát

`reconciliation_runs` có trong [migration](../../database/migrations/1793577600000-CreateReconciliationRuns.ts), với status `OK`, `MISMATCH`, `ERROR`, các tổng bigint nullable và details không chứa văn bản tự do. Hợp đồng JSON chỉ gồm `accountId`, `balance`, `ledgerBalance`; tiền trong JSON là chuỗi nguyên signed bigint. [Schema chuẩn](../../../../docs/components/_shared/database-design.md#49-notificationlog-reconciliationruns) và [DBS-116](../../../../docs/features/DBS-116-reconciliation-runs.md) mô tả các ràng buộc và kiểm thử.

Bảng không tự chạy hoặc tính đối soát; job nằm ở mục dưới (DBS-117). Quyền production trên bảng này nằm trong migration `CreateDbRolesAndGrants` ([DBS-119](../../../../docs/features/DBS-119-db-roles-grant-matrix.md)); chưa có job dọn dòng quá 90 ngày. Revert chỉ được khi rỗng, trong transaction READ COMMITTED; writer đồng thời được khóa/kiểm lại trước DROP. Không xóa kết quả đã ghi để ép revert.

## Job đối soát ở role worker (DBS-117)

`LedgerReconciliationModule` (chỉ trong `workerModules`; `ReconciliationService` còn kiểm `runsWorkers()`) chạy `reconcileOnce()` mỗi `RECONCILIATION_INTERVAL_MS` (mặc định 300000 ms, miền 1000..86400000).

- **Một instance:** `pg_try_advisory_xact_lock(20261108, 117)` ở câu đầu transaction; không lấy được khóa thì trả `{ executed: false }`, không đọc sổ, không ghi dòng. Khóa tự nhả khi COMMIT/ROLLBACK.
- **Năm kiểm tra** trong **một** câu `WITH … SELECT` (một snapshot, không khóa hàng `accounts`): tổng Nợ = tổng Có; `accounts.balance` = Σ(Có) − Σ(Nợ) từng tài khoản; Σ balance = 0; mỗi `COMPLETED` (đọc qua `v_transfer_facts`, không đọc `transfers`) có đúng một Nợ và một Có khớp; bộ đếm hạn mức ngày `sent_today`/`sent_day` của mọi tài khoản không phải SYSTEM bằng ngày Việt Nam mới nhất có dòng Nợ và tổng của ngày đó (BL-421, cùng quy tắc với kiểm 6 của `check:invariants`). `statement_timeout` 60 s, truyền được `reconcileOnce({ statementTimeoutMs })`. Số dư khách ≥ 0 không nằm trong job (đã có `CHECK` ở DB; `check:invariants` kiểm thêm).
- **Lưu `reconciliation_runs`:** `OK` / `MISMATCH` (details `{accountId, balance, ledgerBalance}` theo `accountId`, chỉ cho số dư từng tài khoản: lệch ở tổng, cặp bút toán hoặc bộ đếm cho `details = []` và `mismatched_accounts = 0`, nên dòng log `Ledger reconciliation detected mismatch` có thêm `failedChecks` nêu tên kiểm tra lệch) / `ERROR` khi tổng hoặc `ledgerBalance` vượt miền signed bigint (cột vượt = NULL, `details` NULL; đóng BL-165) hoặc truy vấn lỗi runtime. Job chỉ `INSERT` (không `RETURNING`); `dbs_worker` không có `UPDATE` trên bảng này.
- **Metric và alarm:** mỗi lượt tăng counter `reconciliation_runs_total` theo `Status`; alarm `dbs-dev-reconciliation-failed` (`infra/terraform/envs/dev/session/alarms.tf`) báo khi `MISMATCH` hoặc `ERROR`, nên một bộ đếm lệch cũng kêu alarm này mà không cần metric riêng. Chu kỳ mặc định của ứng dụng là 300000 ms; Terraform dev đặt 60000 ms (`worker.tf`).
- **Sửa bộ đếm lệch (BL-421):** `dbs_api` và `dbs_worker` không có `UPDATE` trên `sent_today`/`sent_day`, nên chỉ vai owner (`dbs_migrator`) sửa được. Mở `check:invariants` (kiểm `daily_debit_totals`) để lấy tài khoản, rồi dựng lại bộ đếm từ sổ cái, mỗi tài khoản một câu (cùng quy tắc với backfill của migration `AddDailyDebitCounter`):

  ```sql
  BEGIN;
  SELECT 1 FROM accounts WHERE id = '<id>' FOR UPDATE;  -- chờ lệnh chuyển đang chạy của tài khoản này commit
  WITH d AS (SELECT (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day, SUM(amount) AS total
             FROM ledger_entries WHERE account_id = '<id>' AND direction = 'DEBIT'
             GROUP BY 1 ORDER BY 1 DESC LIMIT 1)
  UPDATE accounts SET sent_day = (SELECT day FROM d), sent_today = COALESCE((SELECT total FROM d), 0)
  WHERE id = '<id>' AND type <> 'SYSTEM';
  COMMIT;
  ```

  Phải khóa hàng trước: ở `READ COMMITTED`, `UPDATE` đứng một mình tính tổng trên snapshot đầu câu lệnh; nếu lúc đó có lệnh chuyển của tài khoản này chưa commit, `UPDATE` chờ khóa rồi ghi đè bằng tổng cũ (thiếu số tiền lệnh vừa commit). Câu `UPDATE` sau `SELECT … FOR UPDATE` có snapshot mới nên thấy dòng đã commit.

  Chạy lại `check:invariants` (phải `PASS`). **Lưu ý alarm:** chừng nào bộ đếm còn lệch, mọi lượt đối soát là `MISMATCH` nên alarm `dbs-dev-reconciliation-failed` ở trạng thái ALARM và một lệch số dư xảy ra sau đó không gửi thư mới. Sửa bộ đếm ngay, rồi xem `failedChecks` của các lượt kế tiếp.
- **Giới hạn hiện tại:** chưa có job dọn `reconciliation_runs` quá 90 ngày, chưa có đối soát gia tăng; quyền production của `dbs_worker` chưa kiểm trên ECS thật.
- Bằng chứng: [DBS-117](../../../../docs/features/DBS-117-reconciliation-worker-job.md), bộ đếm: [DBS-142](../../../../docs/features/DBS-142-ledger-tech-debt.md) (BL-421).

## Điều kiện nghiệm thu AC-5.x → test

Tên test không luôn mang nhãn AC; bảng này là chỗ tra (chạy từng file bằng `npm run test:db -- <file>` với `DATABASE_URL` bỏ trống, thư mục `backend/test/db`).

| AC | Test |
|---|---|
| 5.1 chuyển 300.000, hai số dư, hai bút toán | `customer-transfers` TC-61-01; `money-flow` TC-65-01 |
| 5.2 thiếu tiền → `REJECTED`, không bút toán | `customer-transfers` TC-61-02; `money-flow` TC-65-04; `transfer-concurrency` TC-98-03..04 |
| 5.3 gửi lại cùng key → kết quả cũ | `customer-transfers` TC-79-01, 03, 04, 10; `money-flow` TC-65-02 |
| 5.4 10 lệnh cùng key song song → 1 giao dịch | `customer-transfers` TC-61-07, TC-79-07 (TC-97-01..03), TC-79-08 |
| 5.5 cùng key khác nội dung → 422 | `customer-transfers` TC-79-02, TC-79-09 |
| 5.6 hạn mức ngày, hai lệnh song song | `customer-transfers` TC-54-04, TC-84-06; `transfer-concurrency` TC-98-01..02; `daily-debit-counter-flow` TC-418-09 |
| 5.7 đích `LOCKED` → `REJECTED` | `rejected-transfers` TC-83-01, TC-83-02 |
| 5.8 tài khoản của người khác → từ chối, có nhật ký | `customer-transfers` TC-61-03; `resource-ownership` TC-86-01..03; `money-flow` TC-65-05 |
| 5.9 nhiều khách chuyển chéo, tài khoản nóng | `transfer-concurrency` TC-99-01..03; `reconciliation-intentional-mismatch` TC-118-02 |
| 5.10 ngắt giữa lúc xử lý, gửi lại → đúng một lần | `idempotency-rollback` TC-81-01..04 (rollback giữa chừng); trên cloud: `infra/scripts/ac-5-10-kill.sh` ([DBS-185](../../../../docs/features/DBS-185-ac-5-10-kill-task-cloud.md)) |
