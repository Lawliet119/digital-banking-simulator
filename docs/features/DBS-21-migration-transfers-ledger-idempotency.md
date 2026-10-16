# DBS-21 · Migration 2: transfers, ledger_entries, idempotency_keys, view v_transfer_facts

> **Status:** Draft · **Vai:** Dev · **Nhánh:** `feat/DBS-21-migration-transfers-ledger-idempotency` · **PR:** — · **Cập nhật:** 2026-10-16

## 1. Bối cảnh

- **Task trên board:** Story, Tuần 1, ưu tiên Highest, Deliverable/Demo **P2**. Role trên board `Dev`, khớp loại việc (migration backend).
- **Expect:** "Mọi bất biến của sổ cái bút toán kép được DB bảo vệ, không chỉ code."
- **DoD** (chép nguyên văn):
  1. transfers: type TRANSFER|DEPOSIT, amount > 0, status COMPLETED|REJECTED, to_account_id cho phép NULL, ràng buộc transfers_distinct_accounts, transfers_reason_matches_status, transfers_completed_has_target
  2. ledger_entries: bigint identity, UNIQUE (transfer_id, direction), amount > 0, cột balance_after, index ledger_entries_daily_debit_idx và index lịch sử (account_id, created_at DESC, id DESC) theo §6
  3. idempotency_keys: PRIMARY KEY (user_id, idem_key), idem_key dài 1–128, request_hash char(64), index created_at
  4. View v_transfer_facts đúng cột ở §8.2; created_at mặc định clock_timestamp()
  5. Không tạo các index trong danh sách «cố ý KHÔNG tạo» (§6.2)
  6. Kiểm: từ chối 2 dòng DEBIT cùng giao dịch, from = to, REJECTED thiếu reject_reason, COMPLETED không có to_account_id, amount ≤ 0; migration revert được
  7. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Thực trạng (board):** "Chưa có bảng nào của luồng tiền. Lược đồ chi tiết ở database-design §4.3–4.5, §6.1 (index) và §8.2 (view)." Đã kiểm: đúng, `backend/src/database/migrations/` chỉ có migration 1.
- **Phụ thuộc:** DBS-20 (Migration 1) **Done** trên board và trong repo: PR #7 đã merge vào `main` (`bd83985`); migration `1791763200000-CreateUsersCustomersAccounts` có `users`, `accounts` và hàng `funding`, đủ để `transfers`/`idempotency_keys` tham chiếu. Harness `test:db` (`test/support/temp-database.ts`, `test/jest-db.js`) của DBS-20 dùng lại được. Không có task phụ thuộc nào chưa xong.
- **Đã có gì:** [database-design §4.3–4.5, §5, §6, §8.2, §11, §12](../components/_shared/database-design.md); [migration 1](../../backend/src/database/migrations/1791763200000-CreateUsersCustomersAccounts.ts) (mẫu: tên ràng buộc tường minh, FK `RESTRICT`, `down` tự kiểm); [DBS-20](DBS-20-migration-users-customers-accounts.md) (cách viết test `test:db`); [`RejectReason`](../../backend/src/common/errors/reject-reason.ts) (4 giá trị, khớp `CHECK` của `reject_reason`); README module [`ledger`](../../backend/src/modules/ledger/README.md); [module-notes](../../.claude/skills/dbs-delivering-task/references/module-notes.md) mục Ledger và Migrations. Chưa có entity hay service nào của ledger (không thuộc task này).
- **Baseline** (nhánh mới từ `origin/main` `bd83985`, 2026-10-16, từ `backend/`, Postgres 17 `timezone=UTC` của docker compose qua `localhost:5433`): `lint:check` sạch, `typecheck` sạch, `npm test` 13 suite / 128 test đạt, `npm run test:e2e` 3 suite / 20 test đạt, `npm run test:db` 2 suite / 17 test đạt. Docker Desktop đang tắt lúc bắt đầu, đã bật lại.
- **Ghi chú môi trường local:** như DBS-20, PostgreSQL 18 cài trên Windows chiếm `5432` (cả `localhost` lẫn `127.0.0.1` đều vào nó, báo sai mật khẩu). Container được map thêm cổng `5433` bằng file override **ngoài repo**; `DATABASE_URL=postgres://banking:banking_local_only@localhost:5433/banking`. Không đổi gì trong repo vì chuyện này.
- **Backlog** (`docs/BACKLOG.md`): không có dòng nào cùng module hay cùng DoD để xử lý trong task này. BL-001 (chưa có CI) cũng chặn DoD #7 ở task này, nên Phase 5 thêm DBS-21 vào nguồn của BL-001. BL-002 (contract `fromUserId` khi `DEPOSIT`) và BL-003 (chặn `TRANSFER` vào/ra SYSTEM) thuộc task outbox và task chuyển tiền, không đụng tới migration này.
- **Ngoài phạm vi:**
  - Entity TypeORM, `TransferService`, `LedgerQueryService`, bất kỳ API nào (task chuyển tiền, nạp tiền, lịch sử).
  - Hàm `forbid_mutation()` và trigger chặn `UPDATE`/`DELETE`/`TRUNCATE` trên `transfers`, `ledger_entries` (migration 6); role `dbs_api`/`dbs_worker`/`dbs_migrator` và `GRANT` kể cả `SELECT` trên `v_transfer_facts` (migration 7). Migration này chỉ tạo bảng, index và view.
  - Bảng `outbox_events`, `processed_events`, `audit_log`, `reconciliation_runs`, bảng fraud (migration 3–5).
  - Bất biến liên dòng mà `CHECK`/`UNIQUE` không biểu diễn được: tổng Nợ = tổng Có của một giao dịch, tài khoản của dòng sổ khớp `from`/`to` của giao dịch, `COMPLETED` có đúng 2 dòng, `REJECTED` có 0 dòng, `balance_after` khớp `accounts.balance` (xem câu hỏi 5).
  - `EXPLAIN` trên dữ liệu lớn (database-design §7, thuộc DBS-69/Task 8). Task này chỉ kiểm index **tồn tại đúng định nghĩa**.
- **Câu hỏi mở** (mỗi câu có đề xuất):
  1. **Tên index.** DoD chỉ đặt tên `ledger_entries_daily_debit_idx` (có sẵn ở §7). Index lịch sử và các index khác chưa có tên. *Đề xuất:* theo quy ước §11 `<bảng>_<mục đích>_idx`: `ledger_entries_account_history_idx`; tên ràng buộc đặt tường minh như DBS-20 (`transfers_pkey`, `transfers_amount_check`, `transfers_from_account_id_fkey`, `ledger_entries_one_per_direction`, `idempotency_keys_idem_key_check`…), danh sách đầy đủ ở §3.
  2. **Hai index của `transfers` cho risk (§6.1: R1/R2/R5 và R4).** Mục "Index nên tạo" của §6.1 liệt kê chúng nhưng DoD chỉ nhắc index của `ledger_entries` và `idempotency_keys`. *Đề xuất:* tạo luôn trong migration này (`transfers_account_completed_idx`, `transfers_pair_completed_idx`), vì bảng đang rỗng thì tạo không cần `CONCURRENTLY`; để task risk tạo sau thì phải viết thêm một migration chạy ngoài transaction trên bảng đã có dữ liệu. Chi phí: hai index một phần, chỉ chứa lệnh `COMPLETED` loại `TRANSFER`, nên `REJECTED` và `DEPOSIT` không tốn gì. Nếu bạn muốn đúng từng chữ DoD thì bỏ hai index này, ghi một dòng `BL-NNN` giao cho task risk.
  3. **`down` tự kiểm trước khi `DROP`.** database-design §11 đòi `down` có `DROP TABLE` phải từ chối khi đã có dữ liệu. *Đề xuất:* như migration 1: `down` đếm `transfers`, `ledger_entries`, `idempotency_keys`; còn dòng nào thì `throw` và transaction rollback, không bảng nào bị xóa. Thứ tự xóa: view, `idempotency_keys`, `ledger_entries`, `transfers`.
  4. **Kiểm thử cần hàng sổ cái mà chưa có luồng nạp tiền.** `task-kinds.md` cho phép SQL seed cho "hàng đầu vào của thứ đang kiểm" nhưng cấm dùng SQL tạo số dư hoặc bút toán. Muốn chứng minh "2 dòng DEBIT cùng giao dịch bị từ chối" thì phải chèn một dòng DEBIT hợp lệ trước. *Đề xuất:* cho phép đúng ở hai chỗ, đều ghi "seed SQL": (a) `test:db` chạy trong `BEGIN … ROLLBACK` trên database tạm; (b) kiểm tay trên một database tạm `dbs_manual_*` rồi `DROP`, không bao giờ trên database `banking`. Các hàng này chỉ là mẫu thử ràng buộc: không `UPDATE accounts.balance`, không dùng làm dữ liệu demo. Nếu không chấp nhận thì TC cho `ledger_entries` thành "chưa làm (chờ task nạp tiền)", và Expect của task không được chứng minh.
  5. **Bất biến liên dòng nằm ngoài `CHECK`/`UNIQUE`.** Expect nói "mọi bất biến … được DB bảo vệ", nhưng thiết kế (§5) chỉ giao cho DB: một Nợ và một Có tối đa mỗi giao dịch, `amount > 0`, `from <> to`, lý do khớp trạng thái, `COMPLETED` có đích. Phần còn lại (Nợ = Có về số tiền, đúng tài khoản, đúng 2 dòng cho `COMPLETED`) giữ bằng code cùng transaction và job đối soát; trigger `forbid_mutation` (migration 6) chặn sửa. *Đề xuất:* không thêm gì ngoài thiết kế ở PR này; ghi giới hạn vào §2 và thêm một dòng `BL-NNN` đề nghị cân nhắc constraint trigger `DEFERRABLE INITIALLY DEFERRED` kiểm "đủ cặp Nợ/Có cùng số tiền, đúng tài khoản" tại thời điểm commit, cùng task làm trigger (migration 6).
  6. **`to_account_id IS NULL` chỉ nên xảy ra khi `REJECTED/ACCOUNT_NOT_ACTIVE`** (comment ở §4.3), nhưng ba `CHECK` đã duyệt không ép điều đó: một hàng `REJECTED/INSUFFICIENT_FUNDS` với đích NULL vẫn qua. *Đề xuất:* giữ đúng ba `CHECK` của DoD, không thêm `CHECK` thứ tư; ghi thành ca biên "được chấp nhận" trong test để ai đổi sau này thấy rõ. Quy tắc này là việc của `TransferService`.
  7. **Board:** nhờ bạn đặt hàng DBS-21 sang "In Progress" (agent không sửa board).
  8. **DoD #7 "CI xanh"** không kiểm được (repo chưa có workflow, BL-001). *Đề xuất:* như DBS-20, dán kết quả chạy local (bốn lệnh + `test:db`) vào PR và thêm DBS-21 vào nguồn của BL-001.

**Quyết định ở G1 (2026-10-16):** duyệt cả 8 đề xuất trên, không sửa. Hệ quả: tạo thêm hai index `transfers` cho risk (câu 2); hàng sổ cái trong test là "seed SQL" chỉ trên database tạm (câu 4); có một dòng backlog mới cho bất biến liên dòng (câu 5); không thêm `CHECK` thứ tư cho `to_account_id` (câu 6).

## 2. Hành vi

Không có API. "Hành vi" là những gì DB chấp nhận và từ chối. Test kiểm **SQLSTATE và tên ràng buộc** của lỗi `pg`, không kiểm câu chữ. Mỗi hàng sai chỉ vi phạm **đúng một** ràng buộc (Postgres kiểm `CHECK` theo thứ tự tên, hàng vi phạm hai cái sẽ báo cái đứng trước).

**2.1 Sau `migration:run` trên DB trống** (cả hai migration): thêm `transfers`, `ledger_entries`, `idempotency_keys` và view `v_transfer_facts`, **không có hàng nào** trong cả ba bảng; hàng `funding` của migration 1 vẫn là tài khoản duy nhất; bảng `migrations` có 2 dòng.

**2.2 `transfers`** (database-design §4.3)

| Thao tác | Kết quả | `code` / `constraint` |
|---|---|---|
| `COMPLETED` `TRANSFER` A→B, amount 300000 | chấp nhận | — |
| `COMPLETED` `DEPOSIT` từ `funding` → B | chấp nhận | — |
| `REJECTED` + `to_account_id NULL` + `reject_reason` ∈ 4 giá trị | chấp nhận (lệnh tới tài khoản không tồn tại, UC-5 6a) | — |
| `REJECTED/INSUFFICIENT_FUNDS` với `to_account_id NULL` | **chấp nhận** (giới hạn đã duyệt ở G1 câu 6: quy tắc "NULL chỉ khi `ACCOUNT_NOT_ACTIVE`" thuộc `TransferService`) | — |
| `type = 'WITHDRAWAL'` hoặc `'transfer'` | từ chối | `23514` / `transfers_type_check` |
| `status = 'PENDING'` | từ chối | `23514` / `transfers_status_check` |
| `REJECTED` với `reject_reason = 'FRAUD'` | từ chối | `23514` / `transfers_reject_reason_check` |
| `amount = 0`, `amount = -1` | từ chối | `23514` / `transfers_amount_check` |
| `amount = 1` | chấp nhận (biên) | — |
| `amount = '9223372036854775808'` (max `bigint` + 1) | từ chối (tràn số) | `22003` |
| `from_account_id = to_account_id` (kể cả `REJECTED`) | từ chối | `23514` / `transfers_distinct_accounts` |
| `REJECTED` không có `reject_reason`; `COMPLETED` có `reject_reason` | từ chối | `23514` / `transfers_reason_matches_status` |
| `COMPLETED` với `to_account_id NULL` | từ chối | `23514` / `transfers_completed_has_target` |
| `from_account_id`, `to_account_id` (không NULL) hoặc `initiated_by` không tồn tại | từ chối | `23503` / `transfers_from_account_id_fkey`, `transfers_to_account_id_fkey`, `transfers_initiated_by_fkey` |
| `amount = '9007199254740993'` (2^53 + 1); `'9223372036854775807'` | lưu và đọc lại nguyên vẹn dạng chuỗi | — |
| Không ghi `created_at` | mặc định `clock_timestamp()`: hai `INSERT` trong cùng một transaction cách nhau `pg_sleep(0.01)` có `created_at` khác nhau, đều khác `now()` | — |

**2.3 `ledger_entries`** (§4.4). Dòng sổ cái ở test là "seed SQL" trong `BEGIN … ROLLBACK` (G1 câu 4).

| Thao tác | Kết quả | `code` / `constraint` |
|---|---|---|
| Một `DEBIT` và một `CREDIT` cho cùng giao dịch | chấp nhận | — |
| `DEBIT` thứ hai (hoặc `CREDIT` thứ hai) cho cùng `transfer_id` | từ chối | `23505` / `ledger_entries_one_per_direction` |
| `DEBIT` cho hai giao dịch khác nhau | chấp nhận | — |
| `amount = 0`, `-5` | từ chối | `23514` / `ledger_entries_amount_check` |
| `direction = 'debit'` (chữ thường) | từ chối | `23514` / `ledger_entries_direction_check` |
| `balance_after` NULL | từ chối | `23502` (cột `balance_after`) |
| `balance_after = -1` | **chấp nhận** (tài khoản SYSTEM được âm, ADR-09; DB không có luật số dư khách ở bảng này) | — |
| `amount` hoặc `balance_after = '9223372036854775808'` | từ chối (tràn số) | `22003` |
| `transfer_id` hoặc `account_id` không tồn tại | từ chối | `23503` / `ledger_entries_transfer_id_fkey`, `ledger_entries_account_id_fkey` |
| ghi tường minh `id` | từ chối (`GENERATED ALWAYS`) | `428C9` |
| hai `INSERT` liên tiếp | `id` tăng dần | — |
| không ghi `created_at` | mặc định `clock_timestamp()`, như `transfers` | — |

**2.4 `idempotency_keys`** (§4.5)

| Thao tác | Kết quả | `code` / `constraint` |
|---|---|---|
| Cùng `(user_id, idem_key)` hai lần | từ chối | `23505` / `idempotency_keys_pkey` |
| Hai user khác nhau, cùng `idem_key` | chấp nhận (không lộ response của nhau) | — |
| `idem_key` dài 0 ký tự; 129 ký tự | từ chối | `23514` / `idempotency_keys_idem_key_check` |
| `idem_key` dài 1; dài 128 (kể cả 128 ký tự `đ`, 256 byte) | chấp nhận (biên; đếm ký tự, không đếm byte) | — |
| `request_hash` 64 ký tự hex | chấp nhận | — |
| `request_hash` 65 ký tự hex (không khoảng trắng) | từ chối | `22001` |
| `request_hash` 64 ký tự hex + khoảng trắng ở cuối | chấp nhận (Postgres cắt khoảng trắng cuối khi ép sang `char(64)`; ghi lại hành vi) | — |
| `request_hash` NULL | từ chối | `23502` |
| `request_hash` ngắn hơn 64 (`'ab'`) | chấp nhận và **đệm khoảng trắng** tới 64: `pg` trả chuỗi dài 64 (hành vi của `char(n)`; hình dạng hash do code bảo đảm, xem §6) | — |
| Dòng giữ chỗ không có `transfer_id`, `response_code`, `response_body` | chấp nhận (`INSERT … ON CONFLICT DO NOTHING` trước, điền kết quả sau) | — |
| `user_id` hoặc `transfer_id` (không NULL) không tồn tại | từ chối | `23503` / `idempotency_keys_user_id_fkey`, `idempotency_keys_transfer_id_fkey` |

**2.5 View `v_transfer_facts`** (§8.2): đúng 7 cột theo thứ tự `id, type, from_account_id, to_account_id, amount, status, created_at`, cùng kiểu với bảng; **không** có `reject_reason`, `initiated_by`, `correlation_id`. Đọc view trả đúng hàng đã chèn vào `transfers`. Quyền `SELECT` cho `dbs_worker` thuộc migration 7.

**2.6 Khóa ngoại và index**
- Cả 7 khóa ngoại là `ON DELETE RESTRICT`: xóa tài khoản đã có giao dịch, xóa giao dịch đã có bút toán, xóa user còn khóa idempotency hoặc là `initiated_by` đều bị từ chối `23503`. Test kiểm **tên ràng buộc** của FK mới, và mỗi ca chỉ có một bảng tham chiếu (user thử là nhân viên, không có `customers`, nếu không `customers_user_id_fkey` của migration 1 báo trước).
- Tập index của mỗi bảng **đúng bằng** danh sách ở §3 (không thừa, không thiếu): nghĩa là không có index nào trong §6.2 (`accounts(balance)`, `accounts(status)`, `transfers(to_account_id, created_at)`, `transfers(created_at)`, GIN trên jsonb…).

**2.7 Revert:** `migration:revert` chỉ hoàn tác migration 2 (migration mới nhất): xóa view và ba bảng, giữ `users`, `customers`, `accounts`, `funding`. Chạy lại `migration:run` cho đúng trạng thái 2.1. `down` **tự kiểm trước khi xóa**: nếu một trong ba bảng còn dòng thì `throw new Error('Refusing to revert CreateTransfersLedgerIdempotency…: tables hold data')`, transaction rollback, không bảng nào bị xóa. Trên DB trống revert chạy bình thường (DoD #6).

**2.8 Giới hạn của phương án đang thiết kế (theo đúng database-design, chờ G2 câu 1).** DB chưa ép: dòng sổ cùng số tiền với giao dịch (nên Nợ = Có), dòng sổ đúng tài khoản `from`/`to`, giao dịch `REJECTED` có 0 dòng, `COMPLETED` có đúng 2 dòng, `balance_after` khớp `accounts.balance`; chưa chặn `UPDATE`/`DELETE` (trigger migration 6, quyền migration 7). Hiện chỉ code và job đối soát giữ các điều này. **Đính chính so với §1 câu 5:** ba mục đầu *không* cần trigger, biểu diễn được bằng khóa ngoại kép (đã chạy thử trên Postgres 17, xem §6 #1); chỉ "đúng 2 dòng" và `balance_after` mới cần constraint trigger hoặc job đối soát. Có làm ba mục đó ở migration này hay không là câu hỏi 1 ở G2.

## 3. Kiến trúc

- **Vị trí:** tầng hạ tầng dùng chung `backend/src/database/migrations/`, không thuộc module nghiệp vụ; chạy như một bước pipeline (`migration:run:prod`), không chạy ở `api`/`worker` (ADR-13). Bảng thuộc module `ledger` (database-design §3).
- **File thêm / sửa:**

| File | Việc |
|---|---|
| `src/database/migrations/1791849600000-CreateTransfersLedgerIdempotency.ts` | **Mới.** `class CreateTransfersLedgerIdempotency1791849600000 implements MigrationInterface`; `up` tạo 3 bảng, 5 index, view; `down` tự kiểm rồi xóa ngược thứ tự |
| `test/db/ledger-schema.db-spec.ts` | **Mới.** TC-21-01…22, 25, 26 trên database tạm đã migrate |
| `test/db/migration-revert.db-spec.ts` | **Sửa.** TC-20-13 và TC-20-18 giả định migration 1 là migration mới nhất; thêm migration 2 thì `migration:revert` lần đầu chỉ hoàn tác migration 2. Sửa cho đúng (xem dưới) và thêm TC-21-23, 24 |
| `docs/…` | database-design (header, §11), `backend/README.md` (mục Migration), `docs/features/README.md`, `docs/BACKLOG.md` |

  **TC-20-13 được thay hẳn bằng TC-21-23** (cùng một test CLI, nâng lên hai migration, không giữ hai bản trùng nhau): `run` → `revert` (chỉ migration 2 mất, migration 1 còn) → `revert` (migration 1 mất) → `run` (cả hai về lại). Helper `tables()` của file được mở rộng để thấy 3 bảng mới và view (`information_schema.views`), danh sách `migrations` mong đợi thành hai tên. **TC-20-18**: gọi `migrate(url, 'undoLast')` một lần trước để hoàn tác migration 2 (rỗng), rồi giữ nguyên các khẳng định cũ về migration 1. Ý nghĩa test của DBS-20 không đổi. Không sửa `src/` hay `test/support/`.
- **Interface dùng:** `MigrationInterface`, `QueryRunner` của `typeorm`; helper có sẵn `createTempDatabase`, `migrate`, `attempt` (`test/support/temp-database.ts`). Không export symbol mới nên không có người gọi nào bị đổi.
- **Interface cung cấp:** schema (hợp đồng cho task chuyển tiền, nạp tiền, lịch sử, risk) và view `v_transfer_facts`. Không có endpoint, event, `ErrorCode`, env var mới. `reject_reason` khớp `REJECT_REASONS` trong `@common/errors/reject-reason` (một test đọc hằng số và so với `CHECK` để hai nơi không lệch).
- **Dữ liệu** (đối chiếu database-design §4.3–4.5, §6.1, §8.2). Tên ràng buộc là tường minh; trùng tên Postgres tự sinh nên SQL mẫu của tài liệu vẫn đúng:

| Bảng | Cột | Ràng buộc / index |
|---|---|---|
| `transfers` | `id uuid DEFAULT gen_random_uuid()`, `type text`, `from_account_id uuid`, `to_account_id uuid NULL`, `amount bigint`, `status text`, `reject_reason text NULL`, `initiated_by uuid`, `correlation_id uuid`, `created_at timestamptz DEFAULT clock_timestamp()`; tất cả NOT NULL trừ hai cột ghi chú | `transfers_pkey`; `transfers_from_account_id_fkey`, `transfers_to_account_id_fkey` → `accounts(id)`, `transfers_initiated_by_fkey` → `users(id)`, đều `RESTRICT`; `transfers_type_check`, `transfers_amount_check` (`> 0`), `transfers_status_check`, `transfers_reject_reason_check`, `transfers_distinct_accounts`, `transfers_reason_matches_status`, `transfers_completed_has_target`; index một phần `transfers_account_completed_idx (from_account_id, created_at) INCLUDE (amount, to_account_id) WHERE status = 'COMPLETED' AND type = 'TRANSFER'` (R1/R2/R5), `transfers_pair_completed_idx (from_account_id, to_account_id, created_at) WHERE status = 'COMPLETED' AND type = 'TRANSFER'` (R4) |
| `ledger_entries` | `id bigint GENERATED ALWAYS AS IDENTITY`, `transfer_id uuid`, `account_id uuid`, `direction text`, `amount bigint`, `balance_after bigint`, `created_at timestamptz DEFAULT clock_timestamp()`; tất cả NOT NULL | `ledger_entries_pkey`; `ledger_entries_transfer_id_fkey` → `transfers(id)`, `ledger_entries_account_id_fkey` → `accounts(id)`, `RESTRICT`; `ledger_entries_direction_check`, `ledger_entries_amount_check`, `ledger_entries_one_per_direction UNIQUE (transfer_id, direction)`; `ledger_entries_daily_debit_idx (account_id, created_at) INCLUDE (amount) WHERE direction = 'DEBIT'` (hạn mức ngày, index-only scan khi đang giữ khóa); `ledger_entries_account_history_idx (account_id, created_at DESC, id DESC)` (lịch sử phân trang cursor, UC-6) |
| `idempotency_keys` | `user_id uuid`, `idem_key text`, `request_hash char(64)` (cả ba NOT NULL), `transfer_id uuid NULL`, `response_code smallint NULL`, `response_body jsonb NULL`, `created_at timestamptz NOT NULL DEFAULT now()` | `idempotency_keys_pkey (user_id, idem_key)`; `idempotency_keys_user_id_fkey` → `users(id)`, `idempotency_keys_transfer_id_fkey` → `transfers(id)`, `RESTRICT`; `idempotency_keys_idem_key_check (char_length(idem_key) BETWEEN 1 AND 128)`; `idempotency_keys_created_idx (created_at)` (job dọn 7 ngày) |
| view `v_transfer_facts` | `SELECT id, type, from_account_id, to_account_id, amount, status, created_at FROM transfers` | Chủ view là role chạy migration; **không** đặt `security_invoker`, để `dbs_worker` chỉ cần `SELECT` trên view mà không cần quyền trên `transfers` (đúng mục đích §8.2) |

  Index tồn tại vì truy vấn nào (checklist §12): xem cột "ràng buộc / index" ở trên, mỗi index kèm truy vấn. Không có index cho `transfers.initiated_by`, `ledger_entries.transfer_id` (đã nằm trong `UNIQUE`), `idempotency_keys.transfer_id`: không có truy vấn nào cần và ta không xóa (§6.1, đoạn cuối).
- **Ranh giới transaction:** TypeORM mặc định bọc migration đang chờ trong một transaction; `up` (DDL) commit cùng nhau hoặc không gì cả. Không có `CREATE INDEX CONCURRENTLY` (bảng mới, rỗng) nên không cần tắt transaction.
- **Sơ đồ:**

```mermaid
flowchart LR
  CLI["npm run migration:run<br/>(data-source.ts)"] -->|"BEGIN; CREATE TABLE ×3; CREATE INDEX ×5; CREATE VIEW; INSERT migrations; COMMIT"| PG[(PostgreSQL 17<br/>timezone=UTC)]
  T["test:db: ledger-schema.db-spec.ts<br/>migration-revert.db-spec.ts"] -->|"CREATE DATABASE dbs_test_xxx → migrate → hàng sai → 23514/23505/23503 + tên ràng buộc → DROP"| PG
  W["dbs_worker (sau này, migration 7)"] -.->|"chỉ SELECT"| V["v_transfer_facts"] --> TR["transfers"]
```

- **Thay đổi cấp hệ thống:** chỉ docs: database-design header "Verified against code" (thêm §4.3–4.5, §8.2) và §11 (tên migration 2); `backend/README.md` mục Migration. Không đổi ADR, event contract, `ErrorCode`, env var. Không đổi `_shared`.

## 4. Test cases tự động

Tất cả lớp **db** (`npm run test:db`, Postgres thật, database tạm chạy migration thật), trừ khi ghi khác. Quy ước giữ như DBS-20: `DATABASE_URL` từ env, thiếu hoặc không nối được thì **fail**; case ghi dữ liệu chạy trong `BEGIN … ROLLBACK` (ngoại lệ: TC-21-23, 24 và TC-20-18 phải **commit** vì `migrate()` mở kết nối riêng; chúng dùng database riêng và tự dọn); hàng sổ cái và giao dịch là **seed SQL** chỉ để thử ràng buộc, không `UPDATE accounts.balance`.

| ID | Truy vết | Given · When · Then | Mã mong đợi |
|---|---|---|---|
| TC-21-01 | DoD #1–#4, rule 2, 6 | DB đã migrate · đọc `information_schema.columns` của 3 bảng · danh sách cột, kiểu (`uuid`, `text`, `bigint`, `character(64)`, `smallint`, `jsonb`, `timestamp with time zone`), NULL/NOT NULL, default (`gen_random_uuid()`, `clock_timestamp()` ở `transfers`/`ledger_entries`, `now()` ở `idempotency_keys`) đúng §3; `ledger_entries.id` là identity `ALWAYS`; không cột `numeric`, `integer`, `real`, `double precision`, `timestamp without time zone` | — |
| TC-21-02 | DoD #1, #4 | DB vừa migrate · `SELECT count(*)` 3 bảng; `accounts` · cả 3 bảng rỗng; `accounts` chỉ còn `funding`; `migrations` có 2 dòng | — |
| TC-21-03 | DoD #1 | `funding` và hai tài khoản khách A, B · chèn `COMPLETED TRANSFER` A→B; `COMPLETED DEPOSIT` funding→B; `REJECTED` với 4 `reject_reason` và `to_account_id NULL`; `REJECTED/INSUFFICIENT_FUNDS` với `to NULL`; `amount = 1` · tất cả được chấp nhận | — |
| TC-21-04 | DoD #1, #6 | như trên · `type` = `'WITHDRAWAL'`, `'transfer'`; `status = 'PENDING'`; `REJECTED` với `reject_reason = 'FRAUD'` · từ chối từng hàng | `23514` / `transfers_type_check`, `transfers_status_check`, `transfers_reject_reason_check` |
| TC-21-05 | DoD #1, #6 | `amount` = `0`, `-1` · từ chối | `23514` / `transfers_amount_check` |
| TC-21-06 | DoD #1, #6 | `from = to` với `COMPLETED`; với `REJECTED` + reason · từ chối | `23514` / `transfers_distinct_accounts` |
| TC-21-07 | DoD #1, #6 | `REJECTED` không có `reject_reason`; `COMPLETED` có `reject_reason` (đích hợp lệ) · từ chối | `23514` / `transfers_reason_matches_status` |
| TC-21-08 | DoD #1, #6 | `COMPLETED` với `to_account_id NULL` · từ chối | `23514` / `transfers_completed_has_target` |
| TC-21-09 | DoD #1, rule 8 | `from_account_id` ngẫu nhiên; `to_account_id` ngẫu nhiên (không NULL); `initiated_by` ngẫu nhiên · từ chối từng hàng | `23503` / `transfers_from_account_id_fkey`, `transfers_to_account_id_fkey`, `transfers_initiated_by_fkey` |
| TC-21-10 | DoD #4 | đọc cột của view `v_transfer_facts` · đúng 7 cột, thứ tự và kiểu; không có `reject_reason`, `initiated_by`, `correlation_id`; `SELECT` view trả đúng hàng vừa chèn | — |
| TC-21-11 | DoD #4 | hai `INSERT` `transfers` và hai `INSERT` `ledger_entries` trong **một** transaction, giữa hai lần `pg_sleep(0.01)`, không ghi `created_at` · hai `created_at` khác nhau và đều lớn hơn `now()` của transaction (với `now()` thì bằng nhau) | — |
| TC-21-12 | DoD #2 | `INSERT ledger_entries` với `id` tường minh · từ chối; hai `INSERT` thường · `id` tăng dần | `428C9` |
| TC-21-13 | DoD #2, #6 | giao dịch T có một `DEBIT` · thêm `DEBIT` thứ hai cho T · từ chối; `CREDIT` thứ hai cho T · từ chối; `CREDIT` đầu tiên cho T · chấp nhận; `DEBIT` cho T' khác · chấp nhận | `23505` / `ledger_entries_one_per_direction` |
| TC-21-14 | DoD #2, #6 | `amount` = `0`, `-5`; `direction = 'debit'`; `balance_after` NULL; `balance_after = -1` · bốn hàng đầu bị từ chối, hàng cuối chấp nhận | `23514` / `ledger_entries_amount_check`, `ledger_entries_direction_check`; `23502` |
| TC-21-15 | DoD #2, rule 8 | `transfer_id` ngẫu nhiên; `account_id` ngẫu nhiên · từ chối | `23503` / `ledger_entries_transfer_id_fkey`, `ledger_entries_account_id_fkey` |
| TC-21-16 | DoD #3 | user U · chèn `(U, 'k1')` hai lần · từ chối lần hai; user V cùng `'k1'` · chấp nhận | `23505` / `idempotency_keys_pkey` |
| TC-21-17 | DoD #3 | `idem_key` dài 0, 129 · từ chối; dài 1, 128, và 128 ký tự `đ` · chấp nhận | `23514` / `idempotency_keys_idem_key_check` |
| TC-21-18 | DoD #3 | `request_hash` 64 hex · chấp nhận; 65 ký tự hex không khoảng trắng · từ chối; 64 hex + khoảng trắng cuối · chấp nhận (ghi lại hành vi `char(n)`); NULL · từ chối; `'ab'` · chấp nhận và `pg` trả chuỗi có `.length === 64`; dòng giữ chỗ không `transfer_id`/`response_*` · chấp nhận | `22001`; `23502` |
| TC-21-19 | DoD #3, rule 8 | `user_id` ngẫu nhiên; `transfer_id` ngẫu nhiên · từ chối | `23503` / `idempotency_keys_user_id_fkey`, `idempotency_keys_transfer_id_fkey` |
| TC-21-20 | DoD #2, #3, #5 | đọc `pg_indexes` · định nghĩa của `ledger_entries_daily_debit_idx` (cột, `INCLUDE (amount)`, `WHERE direction = 'DEBIT'`), `ledger_entries_account_history_idx` (`created_at DESC, id DESC`), `idempotency_keys_created_idx`, hai index `transfers` đúng §3; **tập index của từng bảng bằng đúng danh sách** (kể cả khóa chính và `UNIQUE`), nên không thể có index trong §6.2 | — |
| TC-21-21 | rule 8 | đọc `pg_constraint` · cả 7 khóa ngoại có `confdeltype = 'r'`; mỗi ca chỉ một bảng tham chiếu, user thử là nhân viên (không có `customers`): xóa tài khoản chỉ có giao dịch; xóa giao dịch chỉ có bút toán (không có khóa idempotency); xóa giao dịch chỉ có khóa idempotency; xóa user chỉ có khóa idempotency; xóa user chỉ là `initiated_by` · từ chối, kiểm cả **tên ràng buộc** của FK mới | `23503` / `transfers_from_account_id_fkey`, `ledger_entries_transfer_id_fkey`, `idempotency_keys_transfer_id_fkey`, `idempotency_keys_user_id_fkey`, `transfers_initiated_by_fkey` |
| TC-21-22 | DoD #2 | `SET LOCAL enable_seqscan = off` và `enable_bitmapscan = off` · `EXPLAIN` truy vấn hạn mức ngày (`SUM(amount) WHERE account_id = $1 AND direction = 'DEBIT' AND created_at >= $2`) có node `Index Only Scan` trên `ledger_entries_daily_debit_idx`; truy vấn lịch sử trang đầu (`WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`) có node `Index Scan` trên `ledger_entries_account_history_idx` và không có node `Sort` · khẳng định theo tên index và loại node, không theo cost (kiểm khả năng dùng, không đo hiệu năng: việc của DBS-69) | — |
| TC-21-23 | DoD #6 | database tạm trống · chạy **đúng các lệnh CLI** `npm run migration:run` → `migration:revert` → `migration:revert` → `migration:run` (tiến trình con) · cả bốn thoát mã 0; sau revert đầu chỉ mất 3 bảng + view mới (migration 1 và `funding` còn); sau revert hai mất cả `users`/`customers`/`accounts`; sau run cuối có lại đúng trạng thái §2.1 và `migrations` có hai tên. **Thay hẳn TC-20-13** (một test, không trùng) | — |
| TC-21-24 | DoD #6 | DB đã migrate, **commit** dữ liệu thật rồi `undoLastMigration`, lần lượt: (a) chỉ một dòng `transfers`; (b) chỉ một dòng `idempotency_keys` với `transfer_id` NULL; (c) `transfers` + `ledger_entries`. (Không có ca "chỉ `ledger_entries`": `transfer_id` là FK NOT NULL.) · mỗi lần ném lỗi "Refusing to revert", 3 bảng + view và dòng `migrations` còn nguyên; xóa hết dòng · revert chạy được | — |
| TC-21-25 | rule 2 | đọc `REJECT_REASONS` từ `@common/errors/reject-reason`, `pg_get_constraintdef` của `transfers_reject_reason_check` · tập giá trị bằng nhau (hằng số và `CHECK` không lệch) | — |
| TC-21-26 | DoD #2, #4 | `transfers.amount`, `ledger_entries.amount` và `balance_after` = `'9007199254740993'` và `'9223372036854775807'` (tham số chuỗi) · đọc lại nguyên chuỗi; `'9223372036854775808'` cho cả ba cột · từ chối | `22003` |
| TC-20-18 (sửa) | hồi quy DoD #5 của DBS-20 | như mô tả ở §3 · vẫn đạt trên hai migration (TC-20-13 đã được TC-21-23 thay) | — |
| — | DoD #7 | quy trình | PR có bảng «Đối chiếu test case»; Dev khác review; CI: chưa có workflow (G1 câu 8) | — |

Mọi gạch đầu dòng DoD #1–#6 có ít nhất một case; DoD #7 là bước quy trình. **Bảo mật** (`testing.md`): không có endpoint, nên role guard, ownership, audit, `ProblemDetailsFilter` đều *không áp dụng*; SQL của test dùng tham số `$1…`; không PII trong 3 bảng (chỉ id, mã, số tiền, `response_body` do code ghi, ngoài phạm vi); không secret trong repo.

## 5. Test thủ công

Môi trường: `docker compose up -d`; `DATABASE_URL` trỏ container (máy này: cổng `5433`, xem §1). Mọi bước chạy trên **database tạm** `dbs_manual_21` và `dbs_manual_21_prod`, tạo bằng `CREATE DATABASE`, xóa ở cuối; **không** đụng database `banking`. Chạy trong Git Bash. **Thư mục chạy:** lệnh `docker compose …` và `psql` chạy từ **gốc repo** (nơi có `docker-compose.yml`); lệnh `npm run …` chạy từ `backend/`. Ghi `| tee -a <gốc repo>/docs/features/screenshots/DBS-21/manual-test.txt` (đường dẫn tuyệt đối; thư mục đã `mkdir -p`); dòng đầu là SHA commit cuối đổi code. psql chạy bằng `docker compose exec -T postgres psql -U banking -d dbs_manual_21 -v VERBOSITY=verbose` (lỗi hiện SQLSTATE và tên ràng buộc; truyền cờ ở **mỗi** lần gọi vì mỗi lần là một phiên mới). Dữ liệu mẫu là "seed SQL" của hàng thử ràng buộc, dùng tên Việt: user `seed-nguyen-van-an`, `seed-tran-thi-binh`; khách "Nguyễn Văn An", "Trần Thị Bình"; số tiền 300.000đ.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-21-01 | `CREATE DATABASE dbs_manual_21`; `DATABASE_URL=…/dbs_manual_21 npm run migration:run` | Cả hai migration `executed successfully`, thoát mã 0 |
| M-21-02 | `\d transfers`, `\d ledger_entries`, `\d idempotency_keys`, `\d+ v_transfer_facts`; `SELECT count(*)` 3 bảng; `SELECT id FROM accounts` | Cột, `CHECK`, FK `ON DELETE RESTRICT`, index đúng §3; view có 7 cột; 3 bảng 0 hàng; `accounts` chỉ có `funding` `…0001` |
| M-21-03 | Seed SQL: 2 user, 2 khách, 2 tài khoản; chèn `COMPLETED TRANSFER` An→Bình 300000 và hai bút toán `DEBIT`/`CREDIT`, rồi `SELECT * FROM v_transfer_facts` | Đường thành công: các `INSERT` thành công; view trả đúng 1 hàng với 7 cột |
| M-21-04 | Chèn từng hàng sai: `DEBIT` thứ hai cùng giao dịch; `from = to`; `REJECTED` không `reject_reason`; `COMPLETED` không `to_account_id`; `amount = 0`; `amount = -1`; `idem_key` 129 ký tự | Mỗi hàng bị từ chối với đúng SQLSTATE và tên ràng buộc ở §2 (`23505 ledger_entries_one_per_direction`, `23514 transfers_distinct_accounts`, `transfers_reason_matches_status`, `transfers_completed_has_target`, `transfers_amount_check` ×2, `idempotency_keys_idem_key_check`) |
| M-21-05 | Biên chấp nhận: `amount = 1`; `idem_key` 128 ký tự; `REJECTED/ACCOUNT_NOT_ACTIVE` với `to_account_id NULL` | Cả ba được chấp nhận |
| M-21-06 | Còn dữ liệu seed: `npm run migration:revert` | Thất bại với `Refusing to revert CreateTransfersLedgerIdempotency1791849600000: tables hold data`; `\dt` vẫn đủ bảng; bảng `migrations` vẫn 2 dòng |
| M-21-07 | Xóa dòng seed (`idempotency_keys`, `ledger_entries`, `transfers`, rồi `customers`/`users`/`accounts` của An và Bình); `migration:revert`; `\dt` và `\dv`; `migration:run` | Revert thành công, chỉ mất 3 bảng + view (migration 1 và `funding` còn); run lại cho đúng trạng thái M-21-02 |
| M-21-08 | `npm run build`; `CREATE DATABASE dbs_manual_21_prod`; `DATABASE_URL=…/dbs_manual_21_prod npm run migration:run:prod`; `DROP DATABASE` cả hai | Migration biên dịch trong `dist/` được nạp, cả hai chạy; xóa sạch database tạm |

Bước M-21-03 và M-21-05 dùng SQL seed cho hàng thử ràng buộc (task-kinds.md, cuối); không bước nào tạo số dư.

## 6. Domain review (AI)

**Reviewer:** subagent mới (không có lịch sử), model Claude Opus, ngày 2026-10-16 · **Kết quả:** 10 phát hiện (blocking 0, should-fix 4, minor 6), verdict REVISE → đã sửa §2–§5 như dưới; phát hiện #1 thành câu hỏi G2 · [trả lời nguyên văn](screenshots/DBS-21/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | Tiền đề câu 5 ở G1 sai: Nợ = Có về số tiền, đúng tài khoản `from`/`to` và "`REJECTED` có 0 dòng" biểu diễn được bằng khóa ngoại kép, không cần trigger; ADR-02 hứa "DB vẫn từ chối bút toán lệch". **Đã tự chạy thử lại** trên Postgres 17 (DB tạm, đã xóa): CREDIT số tiền 1, CREDIT vào tài khoản nguồn, DEBIT cho giao dịch `REJECTED` đều bị `23503` | **Chưa sửa thiết kế, thành câu hỏi 1 ở G2** (đổi schema so với database-design đã Accepted nên cần người duyệt). §2.8 đã đính chính tiền đề. Phương án dưới bảng |
| 2 | should-fix | TC-21-22: với `enable_seqscan = off` planner chọn Bitmap Heap Scan rồi `Sort` ở truy vấn lịch sử, nên khẳng định "không `Sort`" đỏ vì lý do ngoài index | **Đã sửa** TC-21-22: thêm `enable_bitmapscan = off`, khẳng định theo tên index và loại node |
| 3 | should-fix | TC-21-24: ca "chỉ có dòng `ledger_entries`" làm không được (FK `NOT NULL`); dòng phải commit mới thấy qua `migrate()` | **Đã sửa** TC-21-24 thành (a) `transfers`, (b) `idempotency_keys` không `transfer_id`, (c) `transfers` + `ledger_entries`; ghi ngoại lệ commit ở đầu §4 |
| 4 | should-fix | TC-21-21 có thể xanh vì FK khác báo trước (`customers_user_id_fkey`); chỉ đòi `23503` | **Đã sửa** TC-21-21 và §2.6: user nhân viên không có `customers`, mỗi ca một bảng tham chiếu, kiểm tên ràng buộc FK mới |
| 5 | minor | TC-20-13 sửa và TC-21-23 là cùng một test; `tables()` chưa thấy bảng/view mới; danh sách `migrations` phải thành hai tên | **Đã sửa** §3: TC-21-23 thay hẳn TC-20-13, mở rộng `tables()` |
| 6 | minor | Lệnh M-21-xx chưa chạy được nguyên văn: thư mục chạy, `\set VERBOSITY` không giữ giữa các phiên, thư mục `DBS-21` chưa có | **Đã sửa** §5 (thư mục chạy, `-v VERBOSITY=verbose`, đường dẫn tuyệt đối, đã `mkdir -p`) |
| 7 | minor | `char(64)`: chỉ ký tự không-khoảng-trắng thừa mới gây `22001`; khoảng trắng cuối bị cắt | **Đã sửa** §2.4, TC-21-18 (65 hex, thêm ca khoảng trắng cuối, đo `.length`) |
| 8 | minor | Thiếu ca tràn `'9223372036854775808'` | **Đã sửa** §2.2, §2.3, TC-21-26 (`22003`) |
| 9 | minor | `request_hash` có hai định nghĩa đầu vào: database-design §4.5 `(from, to, amount, type)` và ADR-05 "method, path, body chuẩn hóa" | **Không sửa ở PR này** (migration không bị ảnh hưởng; thuộc task idempotency/chuyển tiền). **Chuyển sang §8 Bàn giao** và `BL-NNN` |
| 10 | minor | (a) Khi migration 6 thêm `forbid_mutation`, phần dọn bằng `DELETE` trong TC-20-18, TC-21-24, M-21-07 sẽ bị chặn; (b) view chạy bằng quyền chủ view: migration 7 đổi chủ bảng thì phải đổi chủ view theo | **Không sửa ở PR này.** **Chuyển sang §8 Bàn giao** cho người làm migration 6 và 7, và `BL-NNN` |

**Phương án cho #1 (câu hỏi 1 ở G2).**
- **A (đang thiết kế, đúng database-design):** giữ nguyên. Giới hạn ghi ở §2.8 và `BL-NNN`; ADR-02 đang hứa nhiều hơn thực tế, sửa lời hứa ở PR này hoặc ghi BL.
- **B (đề xuất):** thêm ba bất biến bằng khóa ngoại kép. `transfers` thêm `UNIQUE (id, amount, status, from_account_id)` và `UNIQUE (id, amount, status, to_account_id)`; `ledger_entries` thêm ba cột `GENERATED ALWAYS … STORED` (`transfer_status = 'COMPLETED'`, `debit_account`, `credit_account`) và hai khóa ngoại tổng hợp trỏ vào hai unique đó. Kết quả: lệnh ghi sổ sai số tiền, sai tài khoản, hay cho giao dịch `REJECTED` đều bị `23503`. Còn lại ngoài DB: "`COMPLETED` có đúng 2 dòng" và `balance_after` (cần constraint trigger deferred hoặc job đối soát).
- **Chi phí của B:** 2 unique index nữa trên `transfers` (mỗi lệnh chuyển ghi 1 dòng `transfers`), 3 cột sinh ra và 2 lần tra khóa ngoại cho mỗi dòng sổ (mỗi lệnh 2 dòng), tất cả nằm trong đoạn đang giữ khóa tài khoản; chưa đo (NFR-SCAL-02 đo bằng load test). Entity của #2 phải ánh xạ ba cột sinh ra là không ghi. Đổi database-design §4.3, §4.4, §6.1/§6.2 (hai unique index không nằm trong danh sách «cố ý KHÔNG tạo» nhưng DoD #5 cần được hiểu là không thêm index ngoài thiết kế). Nếu để sau thì thêm cột sinh ra và khóa ngoại trên bảng đã có dữ liệu phải quét kiểm tra toàn bảng.
- Nếu chọn B: thêm khoảng 5 test case (TC-21-27…31), sửa §2.2/2.3, §3, rồi chạy lại domain review trên các mục đã đổi.

**Quyết định ở G2:** chờ duyệt.

## 7. Kế hoạch triển khai

_(Phase 3)_

## 8. Kết quả

_(Phase 4–5)_

## 9. Tài liệu đã cập nhật

_(Phase 5)_
