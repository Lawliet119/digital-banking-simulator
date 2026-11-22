# DBS-142 · Xử lý nợ kỹ thuật của ledger sau demo giữa kỳ (kèm BL-421)

> **Status:** Implemented (chờ CI và merge; DoD 2 «10 lần liên tiếp» mới 3 lượt, xem §8 và BL-433) · **Vai:** Dev · **Cặp đôi review:** Dev khác (chưa có: opus thay người, xem PR) · **Nhánh:** `fix/DBS-142-ledger-debt` · **PR:** [#238](https://github.com/Lawliet119/digital-banking-simulator/pull/238) · **Cập nhật:** 2026-11-22

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 5, Ưu tiên Medium, Deliverable/Demo «Giữa kỳ», vai `Dev`, To Do. **Expect:** «Ledger ổn định trước giai đoạn bảo mật và tải.» **Thực trạng (board):** «Danh sách nợ kỹ thuật chỉ có sau DBS-141.»
- **DoD (chép nguyên văn từ board):**
  1. Mọi mục nợ của ledger có PR đóng, hoặc được ghi vào docs/components/ledger/05-backlog.md kèm lý do hoãn và mức độ
  2. AC-5.1…5.10 vẫn xanh sau thay đổi; không có test flaky nào ở ledger (chạy 10 lần liên tiếp)
  3. docs/components/ledger/02-architecture.md khớp code; dòng «Verified against code» chỉ ghi ngày cho phần đã đối chiếu thật
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
  - Ghi chú trên board [Cập nhật 11/10]: không còn file 02-architecture, 03-feature, 04-test-cases, 05-backlog theo component. Nên «05-backlog» là [`docs/BACKLOG.md`](../BACKLOG.md) và «02-architecture» là phần ledger của [docs/03](../03_HIGH_LEVEL_ARCHITECTURE.md), [`01-concept-brief.md`](../components/ledger/01-concept-brief.md) và [README module](../../backend/src/modules/ledger/README.md).
- **Phụ thuộc:** DBS-141 (Done trên board; trong repo: `docs/BACKLOG.md` đã có ba cột ưu tiên, xử lý, hạn và `check-backlog.mjs`). **DBS-141 không lập một danh sách «nợ ledger» riêng**: nó phân loại cả bảng. Vì vậy «mọi mục nợ của ledger» được xác định ở §2.1 từ ba nguồn: dòng BACKLOG có nguồn là tài liệu của task ledger; báo cáo đối chiếu tài liệu với code của subagent opus high (2026-11-22, [bằng chứng](screenshots/DBS-142/doc-vs-code-audit.md)); BL-421 (dòng mà TonightWorks.md ghép vào task này).
- **Baseline** (2026-11-22, worktree từ `origin/main` `3035f02f`, Node 24.22.2): `npm run typecheck` sạch; `jest` đơn vị `src/modules/ledger`: 7 suite, 41 test đạt. Không chạy toàn bộ `npm test`/`test:e2e` (máy chỉ còn 1,4 GB RAM trống, Docker Desktop bật lại sau khi khởi động; CI là bằng chứng cuối, xem §8).
- **Ngoài phạm vi:** đổi cấu trúc code (BL-428..432 ghi lại); kiểm trên AWS (chu kỳ đối soát trên dữ liệu lớn là BL-277, đo SQL mới trên RDS là phần đo AWS của phiên sau); apply Terraform (chỉ đổi chữ mô tả alarm, có hiệu lực ở lần dựng sau); đổi migration hay quyền DB (BL-422, BL-431).
- **Dòng BACKLOG cùng DoD:** BL-421 (lấy vào phạm vi, xóa dòng); BL-422, BL-416, BL-277, BL-240, BL-381, BL-125, BL-200, BL-231, BL-198 (giữ nguyên, §2.1); BL-428..432 (mới).
- **Quyết định ở G1 (agent tự quyết):**
  1. Phạm vi «mọi mục nợ ledger» = §2.1; DoD 1 chỉ đạt khi mỗi dòng có trạng thái (PR này đóng, hoặc dòng BACKLOG với ưu tiên, xử lý, hạn).
  2. «Chạy 10 lần liên tiếp» áp cho **các suite DB của ledger** (danh sách ở §4, TC-142-02), không cho toàn bộ `test:db` (91 suite: 90 trong `test/db` và 1 trong `test/security`; vài giờ trên máy này).
  3. Thứ tự: BL-421 (code) → sửa tài liệu → vòng 10 lần → bàn giao.

## 2. Hành vi

### 2.1 Mục nợ ledger và cách xử lý

| Mục nợ | Nguồn | Xử lý |
|---|---|---|
| Job đối soát không kiểm bộ đếm hạn mức ngày (`sent_today`/`sent_day`): bộ đếm thiếu thì hạn mức bị vượt mà không có cảnh báo | BL-421 | **Đóng ở PR này** (§2.2) |
| Dòng `MISMATCH` không nói kiểm tra nào lệch (`details` chỉ có số dư), trong khi alarm bảo «mở dòng để biết kiểm tra nào lệch» | báo cáo đối chiếu (c.2) | **Đóng**: log `failedChecks`; chữ của alarm và README sửa |
| Tài liệu nói sai code: hạn mức ngày còn `SUM`, job đối soát «3 kiểm», retry `40001`, «ledger không đọc `accounts`», index, quyền xem lệnh, ERD, khóa «hai» tài khoản, COMMIT khi replay sai nội dung, `LedgerQueryService` không tồn tại, README lỗi thời và lỗi chính tả, thiếu 429 và luật key | báo cáo đối chiếu (mục 1 đến 18) | **Đóng**: sửa `docs/03`, brief, README (§9) |
| Nhiều AC (5.3, 5.5, 5.7, 5.9, 5.10) không có nhãn AC trong tên test, khó tra | báo cáo đối chiếu (c.9) | **Đóng**: bảng AC → test trong README (không đổi tên test) |
| Lỗi chính tả thông báo 400 «at most128» | báo cáo đối chiếu (c.8) | **Đóng** |
| Hai bộ kiểm cho cùng quy tắc (job và `invariants.sql`) có SQL riêng, chỉ bộ đếm có test so hai bên | báo cáo (c.1) | **BL-428** (Thấp · H5) |
| Quy tắc ngày Việt Nam chép sáu nơi | báo cáo (c.3) | **BL-429** (Thấp · H5) |
| Nạp và chuyển tiền chép nhau; `Clock` đăng ký hai lần | báo cáo (c.4, c.10) | **BL-430** (Thấp · H5) |
| Quyền dư trên `reconciliation_runs` | báo cáo (c.5) | **BL-431** (Thấp · H1) |
| Ranh giới module: ledger đọc `accounts`; `risk` dùng SQL lịch sử của ledger | báo cáo (c.6) | **BL-432** (Thấp · H5); tài liệu đã nói đúng hiện trạng |
| `dbs_api` `INSERT` được vào cột bộ đếm | BL-418 | giữ **BL-422** (Thấp · H1, cần migration) |
| Máy tải dùng `dbs_api` cho checker chỉ đọc | DBS-166 | giữ **BL-416** (Thấp · H1) |
| Chu kỳ đối soát trên dữ liệu lớn; EXPLAIN trên RDS | DBS-123, DBS-171 | giữ **BL-277**, **BL-240** (Trung bình · H4, cần phiên AWS) |
| SIGTERM giữa transaction trả 500 | DBS-185 | giữ **BL-381** (Trung bình · H5; tiền vẫn đúng vì không commit) |
| Crash native Windows của bộ test DB | DBS-57, DBS-65, DBS-186 | giữ **BL-125**, **BL-200**, **BL-231** (Thấp · H2) |
| Chạy luồng tiền trên cloud; review của Dev khác cho #178 | DBS-65, DBS-123 | giữ **BL-198** (H4), **BL-279** (H3) |

### 2.2 Kiểm thứ năm của job đối soát (BL-421)

`RECONCILIATION_CHECK_SQL` thêm cột `daily_counters_valid`, đúng khi **mọi** tài khoản `type <> 'SYSTEM'` có `sent_day` = ngày Việt Nam (`Asia/Ho_Chi_Minh`) lớn nhất có dòng `DEBIT` và `sent_today` = tổng `DEBIT` của ngày đó (không có dòng `DEBIT`: `sent_day` NULL và `sent_today` 0). Đây là quy tắc của kiểm 6 `daily_debit_totals` trong `invariants.sql`, viết một lượt: nhóm `DEBIT` theo `(account_id, ngày)`, rồi lấy ngày lớn nhất mỗi tài khoản.

| Tình huống | Kết quả của một lượt |
|---|---|
| Bộ đếm bằng sổ cái | `OK` (nếu bốn kiểm kia cũng đúng) |
| Bộ đếm thiếu (reset, ngày lùi, trigger tắt khi có chuyển tiền) hoặc thừa (owner sửa +1) | `MISMATCH`, `mismatchedAccounts: 0`, `details: []`; tổng và số dư vẫn đúng |
| Chỉ tài khoản `SYSTEM` có bộ đếm lạ | `OK` (SYSTEM bị loại) |
| Snapshot thiếu trường `daily_counters_valid` | `MISMATCH` (đóng kín: `Boolean(undefined)` = sai) |
| Tổng vượt bigint | `ERROR` như trước (BL-165), bộ đếm không được xét |

Dòng log `Ledger reconciliation detected mismatch` (cấp `warn`) thêm `failedChecks`, mảng tên trong `debit_equals_credit`, `account_balances`, `total_balance_is_zero`, `completed_pairs`, `daily_debit_counters`. Ví dụ: `{"status":"MISMATCH","mismatchedAccounts":0,"failedChecks":["daily_debit_counters"],"totalDebit":"6700000","totalCredit":"6700000","totalBalance":"0"}`. Chỉ có tên kiểm tra, không id tài khoản, không số tiền riêng của khách. Chi tiết từng tài khoản: `npm run check:invariants` (kiểm 6).

**Không thêm metric, alarm hay cột:** `reconciliation_runs_total{Status=MISMATCH}` và alarm `dbs-dev-reconciliation-failed` đã bắt mọi `MISMATCH`; cột `details` bị `CHECK` chỉ cho `{accountId, balance, ledgerBalance}` nên không chứa được chi tiết bộ đếm nếu không đổi migration (xem §6, quyết định G2 1).

**Chi phí** (kiểm thủ công, `EXPLAIN ANALYZE` ba lần, [output thô](screenshots/DBS-142/manual-test.txt)): một tài khoản chi, 100.010 dòng sổ (M-142-07, lần chạy cuối): 166 đến 177 ms trước, 182 đến 217 ms sau. **Dạng gần dữ liệu thật** (M-142-09): 10.000 tài khoản × 30 ngày, 720.010 dòng sổ, 300.031 nhóm (tài khoản, ngày): 1,81 đến 2,00 s trước, 2,25 đến 2,27 s sau (cộng ≈ 0,4 s); phần mới của kế hoạch đi `Index Only Scan` trên `ledger_entries_daily_debit_idx`, `Incremental Sort` (quicksort, 28 kB), `GroupAggregate`, `Unique`; **không tràn đĩa** (phần `HashAggregate` có `Batches: 1` trong output là `entry_by_account` có sẵn). Lần chạy đầu ở 1.000.010 dòng của một tài khoản, trước commit code cuối ([output thô](screenshots/DBS-142/manual-test-1m-first-run.txt)): 1,98 đến 2,20 s trước, 1,99 đến 2,15 s sau (số máy bận, chỉ để xem xu hướng). Vẫn chỉ `AccessShareLock` trên `accounts` (TC-117-09), `statement_timeout` 60 s còn dư xa. Số đo trên RDS thật thuộc BL-277 và BL-240.

**Bộ đếm lệch kéo dài che alarm sau:** chừng nào bộ đếm chưa được sửa, mọi lượt là `MISMATCH`, alarm `dbs-dev-reconciliation-failed` ở trạng thái ALARM và một lệch số dư xảy ra sau đó không gửi thư mới. Vì vậy README có bước sửa bộ đếm (vai owner, dựng lại từ sổ cái) và nói phải sửa ngay.

**Khác BL-421 «Đóng khi» (ghi rõ):** (1) SQL **khác** `invariants.sql` nhưng cùng quy tắc, viết một lượt thay vì `DISTINCT ON` + nối lại; tương đương được chứng bằng TC-421-02..04 (job và `check:invariants` cùng kết luận trên cùng dữ liệu, gồm 17:00Z và nhiều ngày), phần còn lại là BL-428 và BL-429. (2) «metric và alarm»: dùng lại `reconciliation_runs_total{Status=MISMATCH}` và alarm có sẵn, không thêm cái mới, vì mọi `MISMATCH` đã kêu alarm đó và `details` bị `CHECK` chỉ cho `{accountId, balance, ledgerBalance}`.

## 3. Kiến trúc

- **Vị trí:** `backend/src/modules/ledger/` (`reconciliation.service.ts`, `reconciliation.types.ts`), role `worker`. Không đổi giao diện HTTP, event hay migration.
- **Interface:** `RawReconciliationSnapshot.daily_counters_valid: boolean` (mới, bắt buộc); `failedReconciliationChecks(raw): string[]` (mới, export từ `reconciliation.types.ts`, chưa re-export ở `index.ts`). `classifyReconciliationSnapshot` thêm `raw.daily_counters_valid` vào `allChecksPass`. Người gọi (grep): `reconciliation.service.ts`, bốn spec (`types`, `metrics`, `run-log` và `test/manual/reconciliation-emf.manual.ts` đã thêm trường).
- **Dữ liệu chạm tới:** đọc `public.ledger_entries` (đã đọc), `public.accounts` (cột `sent_today`, `sent_day`, `type`); `dbs_worker` có `SELECT` cấp bảng trên `accounts` nên không cần thêm quyền (kiểm bằng TC-117-10 của `db-roles` và M-142-06).
- **Ranh giới transaction:** như cũ, một transaction chỉ đọc, khóa advisory `pg_try_advisory_xact_lock(20261108, 117)`, ghi một dòng `reconciliation_runs`.
- **Thay đổi cấp hệ thống:** chữ của `docs/03` §6 (khóa, retry, replay, đối soát, index), §11, §19; chữ mô tả alarm ở `alarms.tf` (không đổi chỉ số hay ngưỡng, hiệu lực ở lần `apply` sau).

## 4. Test cases tự động

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-421-01 | DoD 1 (BL-421) | đơn vị | `daily_counters_valid:false`, mọi thứ khác đúng → `MISMATCH`, 0 tài khoản, `details []` (`reconciliation.types.spec.ts`); snapshot thiếu trường → `MISMATCH` qua `reconcileOnce` (`run-log.spec`, bảo vệ chống hồi quy: hành vi đóng kín có sẵn từ `Boolean(undefined)`, nên ca này không đỏ trước) |
| TC-421-05 | DoD 1 | đơn vị | `failedReconciliationChecks` trả đúng tên theo từng kiểm; sạch → `[]` |
| TC-421-06 | DoD 1 | đơn vị | chỉ bộ đếm lệch: dòng `warn` đúng bộ khóa `{status, mismatchedAccounts, failedChecks:['daily_debit_counters'], totalDebit, totalCredit, totalBalance}`, không id tài khoản (`reconciliation.run-log.spec.ts`) |
| TC-421-02 | DoD 1 | PostgreSQL thật | bộ đếm đúng → `OK`; owner sửa `sent_today` +1 → `MISMATCH`, tổng và số dư đúng; `checkLedgerInvariants` báo `daily_debit_totals` cho đúng tài khoản; sửa lại → `OK` |
| TC-421-03 | DoD 1 | PostgreSQL thật | reset (0, NULL), ngày lùi 1, bộ đếm có ngày hoặc có số tiền trên tài khoản chưa từng có dòng Nợ, tắt trigger khi có một chuyển tiền cân (chỉ bộ đếm sai) → mỗi ca `MISMATCH`, ca cuối chỉ `daily_debit_totals` |
| TC-421-04 | DoD 1 | PostgreSQL thật | dòng Nợ lúc 16:59:59Z, 17:00:00Z, 23:00Z và hai ngày sau: bộ đếm do trigger giữ, job `OK` sau mỗi dòng; ngày bộ đếm lệch → `MISMATCH`; bộ đếm lạ của SYSTEM → `OK` |
| TC-117-10 (có sẵn) | DoD 1 | PostgreSQL thật | job chạy bằng `dbs_worker` (SQL mới cần `SELECT` trên `accounts`) |
| TC-117-02..11, TC-118-01..04 (có sẵn) | DoD 2 | PostgreSQL thật | bốn kiểm cũ, ERROR do tràn bigint, khóa advisory, không khóa ghi, 100.000 dòng vẫn đạt |
| TC-142-01 | DoD 2 (AC-5.1…5.10) | PostgreSQL thật | chạy các file ở bảng AC → test của README; tất cả xanh |
| TC-142-02 | DoD 2 (flaky) | PostgreSQL thật + đơn vị | **Mục tiêu 10 lần liên tiếp; thực tế 3 lượt (§8, BL-433).** Mỗi lượt: `jest src/modules/ledger` (đơn vị) rồi 29 suite DB (`-i`): `money-flow`, `customer-transfers`, `rejected-transfers`, `transfer-concurrency`, `idempotency-rollback`, `resource-ownership`, `daily-debit-counter`, `daily-debit-counter-flow`, `daily-debit-counter-roles`, `daily-debit-guard`, `daily-limit`, `midnight-boundary`, `sync-guard`, `reconciliation-job`, `reconciliation-intentional-mismatch`, `reconciliation-daily-counter`, `reconciliation-schema`, `reconciliation-migration-revert`, `operator-deposits`, `ledger-schema`, `invariants`, `ledger-invariants-helper`, `append-only`, `transfer-status`, `transfer-facts`, `transfer-facts-cost`, `transaction-history`, `transaction-history-plan`, `db-roles`: 0 đỏ. Không nằm trong vòng: các suite của module khác (outbox, audit, risk, identity…) và e2e |
| TC-142-03 | DoD 3 | kiểm tài liệu | `check-doc-links.mjs` 0 hỏng; `grep` các câu sai đã bỏ (§8); «Verified against code» có ngày và liệt kê phần chưa kiểm |
| TC-142-04 | DoD 1 | công cụ | `check-backlog.mjs` 0 lỗi; BL-421 vắng, BL-428..432 có |
| TC-142-05 | DoD 4 | quy trình | PR merge, CI xanh, Dev review, bảng đối chiếu (sau PR) |

## 5. Test thủ công

Điều kiện: Node 24, Docker chạy, `DATABASE_URL` bỏ trống; từ `backend/`: `node scripts/manual-dbs142.cjs` (app NestJS thật, JWT thật, PostgreSQL 17 trong Testcontainers, tiền vào qua API nạp tiền; `BENCH_ROWS=1000000` cho cỡ lớn).

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-142-01 | hai lệnh chuyển thật 1.500.000 và 200.000 qua API; chạy job; `check:invariants` | bộ đếm 1.700.000 đúng ngày; `OK`; `PASS` |
| M-142-02 | owner reset bộ đếm (0, NULL); chạy job | `MISMATCH`, `mismatchedAccounts` 0, log `failedChecks=[daily_debit_counters]`; `check:invariants` FAIL đúng tài khoản |
| M-142-03 | khôi phục bộ đếm từ sổ cái | `OK`, `PASS` |
| M-142-04 | tắt trigger, một lệnh chuyển thật 100.000, bật lại; chạy job | bộ đếm 1.700.000 so với sổ 1.800.000: `MISMATCH` chỉ ở bộ đếm, `totalBalance` 0; sửa → `OK` |
| M-142-05 | sửa bộ đếm của tài khoản SYSTEM | `OK` (SYSTEM bị loại) |
| M-142-06 | chạy job bằng role `dbs_worker` (script `db-roles.sql`) | `OK`; sửa +1 → `MISMATCH`; sửa lại → `OK` |
| M-142-07 | 100.010 và 1.000.010 dòng sổ trải 30 ngày: EXPLAIN ANALYZE SQL của `origin/main` và SQL mới | thời gian ghi lại; job `OK` |
| M-142-09 | 10.000 tài khoản × 30 ngày, 720.010 dòng sổ: EXPLAIN ANALYZE SQL cũ (ghim `3035f02f`) và SQL mới, ba lần mỗi bên | thời gian và kế hoạch ghi lại, không tràn đĩa; job `OK` |
| M-142-08 | `check:invariants` cuối | `PASS` |

## 6. Domain review (AI)

**Reviewer:** subagent `opus`, effort `high`, 2026-11-22 · **Lượt 1:** 14 mục (blocking 1, should-fix 6, minor 6, 1 mục «đã kiểm, không lỗi»), **Verdict: REVISE** · **Lượt 2:** xem «Lượt 2» dưới bảng, **Verdict: REVISE** (chỉ sửa tài liệu và runbook, code và SQL đúng) · [trả lời nguyên văn](screenshots/DBS-142/domain-review.md) · [báo cáo đối chiếu tài liệu–code](screenshots/DBS-142/doc-vs-code-audit.md)

| # | Mức | Phát hiện (rút gọn) | Xử lý |
|---|---|---|---|
| 1 | blocking | dấu nháy kép trong chuỗi HCL của `alarms.tf` làm `terraform fmt` đỏ | **đã sửa** (dùng «…»); `terraform fmt -check -recursive`, `validate`, `test` (111 đạt) xanh; thêm lệnh vào §7 |
| 2 | should-fix | TC-421-01 «thiếu trường → MISMATCH» và `failedChecks` ở dòng log chưa có test | **đã sửa**: TC-421-06 và TC-421-01 ở `run-log.spec` (ca «thiếu trường» là chống hồi quy, đã đóng kín sẵn) |
| 3 | should-fix | số đo chi phí không có bằng chứng; bench một tài khoản không đại diện | **đã sửa**: M-142-09 (10.000 tài khoản × 30 ngày, 300.031 nhóm), kế hoạch in trong `manual-test.txt`, không tràn đĩa; §2.2 ghi số |
| 4 | should-fix | vòng 10 lần bỏ sót nhiều suite ledger, đơn vị và `db-roles` | **đã sửa phần bộ**: 29 suite DB + đơn vị ledger (TC-142-02). Số lượt: xem §8 (3 lượt, BL-433) |
| 5 | should-fix | dòng «Verified against code» của `docs/03` chưa đổi | **đã sửa** |
| 6 | should-fix | README tự nhận «mọi mục đã kiểm» nhưng còn số đo chưa kiểm | **đã sửa**: nêu phần đã kiểm và phần chưa |
| 7 | should-fix | không có bước sửa bộ đếm; bộ đếm lệch kéo dài che alarm sau | **đã sửa**: README có SQL sửa (vai owner) và lưu ý; §2.2 ghi rõ |
| 8 | minor | «Đóng khi» của BL-421 (cùng SQL, metric, alarm) khác thực hiện | **đã sửa**: §2.2 ghi chỗ khác và lý do |
| 9 | minor | đột biến `JOIN`/`<>` sống sót; thiếu ca bộ đếm của tài khoản chưa từng chi | **đã sửa**: TC-421-03 (b2) |
| 10 | minor | bảng AC → test dẫn nhầm TC-83; bỏ sót TC-61-01/02/03 | **đã sửa** README và §2.1 |
| 11 | minor | ba câu tuyệt đối sai nhẹ (số điều của `check:invariants`, «đã có test so hai kết quả», 429) | **đã sửa** |
| 12 | minor | BL-381 sai mức; nguồn BL-428..432 trỏ §8 trống | **đã sửa** (§2.1, BACKLOG) |
| 13 | minor | SQL «trước» đọc từ `origin/main` | **đã sửa**: ghim `3035f02f` |
| 14 | — | báo động giả khi có chuyển tiền đồng thời: không thấy (một câu `WITH`, một snapshot ở READ COMMITTED; trigger cùng transaction với dòng sổ) | ca thử «lặp `reconcileOnce` song song với chuyển tiền đang commit» là tùy chọn, **không làm**: bằng chứng hiện có là lập luận snapshot, TC-118-02 (50 lệnh song song rồi đối soát) và các lượt chạy ở §8.3 (3 lượt đủ bộ, 0 đỏ); ghi ở §8 |

### Lượt 2 (opus high, 2026-11-22, trên code và §8 đã viết)

Code và SQL đúng, không thấy báo động giả khi có chuyển tiền đồng thời (một câu `WITH`, một snapshot; trigger cùng transaction với dòng sổ; `created_at` lấy sau khi khóa tài khoản nguồn). 13 mục lượt 1 đã sửa được kiểm lại. Phát hiện mới, đều sửa trong cùng PR:

| # | Mức | Phát hiện (rút gọn) | Xử lý |
|---|---|---|---|
| 2.1 | should-fix | chỉ mục `features/README.md` nói «10 lần liên tiếp» như đã đạt, thiếu BL-433, trạng thái cũ | **đã sửa** |
| 2.2 | should-fix | §6 mục 14 dẫn «10 lần chạy» làm bằng chứng | **đã sửa**: dẫn §8.3 |
| 2.3 | should-fix | §8.3 ghi log vòng hẹp mạnh hơn bằng chứng (`run-5.log` không có, `run-10.log` bị ghi đè, dòng `exit=127`, chạy song song với lượt 1) | **đã sửa**: §8.3 viết lại đúng log; `summary.txt` chép vào `screenshots/DBS-142/flake10-summary.txt` |
| 2.4 | should-fix | bước sửa bộ đếm trong README có race với lệnh chuyển đang chạy (`READ COMMITTED`) | **đã sửa**: `BEGIN; SELECT … FOR UPDATE; UPDATE; COMMIT` và lời giải thích |
| 2.5 | should-fix | BL-433 mã H5 «Thấp, Không có hạn» không hợp với một DoD chưa đạt | **đã sửa**: Trung bình · H4, hạn «Trước DBS-202 (tuần 10)», thêm phương án chạy trên runner CI |
| 2.6 | should-fix | «19 chỗ đã sửa» quá lời: mục 14 của báo cáo (`docs/03` dòng `workerModules`) chưa sửa | **đã sửa** dòng `workerModules` (có `RiskWorkerModule`); các cụm «chưa có … hạ tầng worker/SQS/alarm» ở dòng «Verified» của `docs/03` không thuộc ledger, đã ghi là chưa đối chiếu lại; số «19» giữ vì mục 14 đã sửa |
| 2.7 | minor | §8.2 ghi TC-142-02 «đơn giản hóa» | **đã sửa**: «chưa đạt» |
| 2.8 | minor | §2.2 nhầm `HashAggregate Batches: 1` là của phần mới | **đã sửa**: nêu đúng kế hoạch |
| 2.9 | minor | số đo 1 triệu dòng không có trong repo | **đã sửa**: chép output thô vào `manual-test-1m-first-run.txt` và ghi số đúng |
| 2.10 | minor | «74 suite» của `test:db` sai (91) | **đã sửa** |
| 2.11 | minor | M-142-09 thiếu ở §5 và §7 | **đã sửa** |

Chưa kiểm lại bởi reviewer: `terraform validate` và `terraform test` («111 đạt»): tác giả đã chạy ở lượt 1; kết quả ở PR.

### Quyết định ở G2 (agent tự quyết, opus high đã xét)

1. **Không thêm metric, alarm hay cột `reconciliation_runs`** cho bộ đếm (§2.2): reviewer xác nhận hợp lý; chi tiết tài khoản ở `check:invariants`, tên kiểm tra ở log `failedChecks`.
2. **Bộ đếm thừa cũng là `MISMATCH`** (không chỉ thiếu): bộ đếm là dữ liệu dẫn xuất, khớp kiểm 6; reviewer xác nhận.
3. **Đóng kín khi thiếu trường** của snapshot.
4. **Code viết trước khi domain review** (lệch với «không code trước G3»): người dùng giao cả cụm DBS-142 + BL-421 trong một phiên đêm; reviewer đọc cả code lẫn thiết kế, và các test đỏ trước khi có code ghi ở §7. Ghi ở §8 mục «Lệch».

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `reconciliation.types.spec.ts`, `reconciliation-daily-counter.db-spec.ts` | TC-421-01, 02, 03, 04 | TS2353 (trường chưa có); DB: 3/3 đỏ, job báo `OK` dù bộ đếm sai | `npx jest --config ./test/jest-db.js test/db/reconciliation-daily-counter -i` | `feat(ledger): job đối soát kiểm bộ đếm … (BL-421, DBS-142)` |
| 2 | `reconciliation.types.spec.ts` | TC-421-05 | TS2305 (hàm chưa có) | `npx jest --config ./test/jest-unit.js src/modules/ledger` | cùng commit 1 |
| 3 | `reconciliation.service.ts`, `reconciliation.types.ts` (+ fixture của `metrics.spec`, `run-log.spec`, `reconciliation-emf.manual.ts`) | — | `metrics.spec` và `run-log.spec` đỏ vì fixture thiếu trường (đúng ý: đóng kín) | như bước 1 và 2 | cùng commit 1 |
| 4 | `scripts/manual-dbs142.cjs` | M-142-01..09 | — | `node scripts/manual-dbs142.cjs` | cùng commit 1 |
| 5 | `docs/03`, `01-concept-brief.md`, README, `alarms.tf`, `BACKLOG.md` | TC-142-03, 04 | — | `check-doc-links.mjs`, `check-backlog.mjs` | `docs(ledger): … (DBS-142)` |
| 6 | feature doc, `README.md` của features, `screenshots/DBS-142/*` | — | — | `cd infra/terraform/envs/dev/session && terraform fmt -check -recursive ../../../ && terraform init -backend=false && terraform test` (chữ alarm đổi) | `docs: feature doc DBS-142 và bằng chứng` |

Quét kế hoạch: DoD 1 (§2.1: mọi dòng có xử lý), DoD 2 (TC-142-01, 02), DoD 3 (TC-142-03; ba tài liệu và dòng «Verified»), DoD 4 (TC-142-05), BL-421 «Đóng khi» (SQL cùng quy tắc, kiểu, test mismatch cố ý; metric và alarm xem §2.2). **Rủi ro:** SQL mới chậm hơn trên sổ cái lớn (đã đo, không đáng kể); fixture của spec ngoài ledger dùng `RawReconciliationSnapshot` (đã grep: chỉ ba file). **Lùi:** `git revert` commit 1; không có migration, không có dữ liệu bị đổi.

## 8. Kết quả

**Tóm tắt:** BL-421 xong (kiểm thứ năm của job đối soát, log `failedChecks`), 19 chỗ tài liệu nói sai code đã sửa, 5 mục nợ cấu trúc ghi thành BL-428..432, thêm BL-433 cho phần DoD 2 chưa đủ. Không đổi migration, quyền, metric hay alarm.

### 8.1 Lệnh đã chạy (thư mục `backend/`, Node 24, PostgreSQL 17 qua Testcontainers, `DATABASE_URL` bỏ trống)

| Lệnh | Kết quả |
|---|---|
| `npm run lint:check`, `npm run typecheck` | sạch (file mới đã qua `eslint --fix` và `prettier --write`) |
| `npx jest --config ./test/jest-unit.js src/modules/ledger` | **7 suite, 44 test đạt** (baseline trước PR: 7 suite, 41 test; thêm TC-421-01/05/06) |
| `npx jest --config ./test/jest-db.js test/db/reconciliation-daily-counter -i` | 3 suite con (TC-421-02, 03, 04) đạt; trước khi có code: 3/3 đỏ vì job báo `OK` dù bộ đếm sai (§7 bước 1) |
| 29 suite DB của ledger `-i` (danh sách ở TC-142-02) | **29 suite, 478 test đạt**, 3 lượt liên tiếp (xem 8.3) |
| `node scripts/manual-dbs142.cjs` | M-142-01..09 PASS, dọn dẹp PASS ([output thô](screenshots/DBS-142/manual-test.txt)) |
| `cd infra/terraform/envs/dev/session && terraform fmt -check -recursive ../../../ && terraform init -backend=false && terraform validate && terraform test` | sạch, 111 test đạt |
| `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs`, `check-backlog.mjs` | 0 liên kết hỏng, 0 lỗi BACKLOG (lệnh chạy lại trước khi mở PR, kết quả ở PR) |

CI (job `db`, `unit`, `e2e`, `terraform`…) là bằng chứng cho phần không chạy được trên máy này (toàn bộ `npm test`, `test:e2e`): máy chỉ còn 1,4 đến 3,6 GB RAM trống. Kết quả CI ghi ở PR.

### 8.2 Bảng đối chiếu test case

| Case | Test | Kết quả |
|---|---|---|
| TC-421-01 | `reconciliation.types.spec.ts`; `run-log.spec` (thiếu trường) | đạt (ca thiếu trường là chống hồi quy, không đỏ trước: hành vi đóng kín có sẵn) |
| TC-421-05 | `reconciliation.types.spec.ts` | đạt |
| TC-421-06 | `reconciliation.run-log.spec.ts` | đạt |
| TC-421-02, 03, 04 | `reconciliation-daily-counter.db-spec.ts` | đạt |
| TC-117-10 | `db-roles`, `reconciliation-job` | đạt (có sẵn, chạy trong 29 suite) |
| TC-117-02..11, TC-118-01..04 | `reconciliation-job`, `reconciliation-intentional-mismatch` | đạt (có sẵn) |
| TC-142-01 | các file ở bảng AC → test của README, nằm trong 29 suite | đạt |
| TC-142-02 | 3 lượt của bộ đầy đủ | **chưa đạt**: mục tiêu 10 lượt, thực tế 3, 0 đỏ (8.3, BL-433) |
| TC-142-03 | `check-doc-links.mjs`; `grep` các câu sai | đạt (kết quả ở PR) |
| TC-142-04 | `check-backlog.mjs`; BL-421 vắng, BL-428..433 có | đạt (kết quả ở PR) |
| TC-142-05 | quy trình | **chưa**: PR, CI, Dev review (§8.6) |

### 8.3 Về «chạy 10 lần liên tiếp» (DoD 2)

Bằng chứng: [`flake10-summary.txt`](screenshots/DBS-142/flake10-summary.txt) (các log từng lượt nằm ở thư mục tạm của phiên, không đưa vào repo).

- **Bộ đầy đủ của TC-142-02** (đơn vị ledger, rồi 29 suite DB `-i`) trên SHA `071d2ca4` (code không đổi từ `25849047`): **lượt 1, 2, 3 xanh** (478 test DB và 44 test đơn vị mỗi lượt; 1551 s, 955 s, 942 s). Lượt 1 chậm hơn vì chạy **song song** với vòng hẹp bên dưới. Ở lượt 4 hệ thống **dừng tiến trình vì hết RAM** (thông báo của Claude Code, không phải lỗi test); lượt 4 không có kết quả.
- **Vòng hẹp trước đó** (17 suite DB, không có đơn vị ledger), bắt đầu trước commit `25849047` và chạy đến 14:09: còn log đầy đủ cho lượt 6 đến 9 (268 test đạt mỗi lượt); lượt 5 và 10 chỉ còn dòng `exit=0` trong summary (không có số test); các lượt 1 đến 4 không còn bản ghi. Dòng `run 10 exit=127` trong summary là do script bị sửa lúc bash đang chạy nó (`t-db.js: command not found`), **không phải lượt đỏ**. Vòng này chỉ là bằng chứng phụ.

**Không thấy test flaky nào**, nhưng 10 lượt liên tiếp của bộ đầy đủ **không đạt**. Điều kiện dừng của TonightWorks (flaky thì sửa trước khi merge) không kích hoạt vì không có lượt đỏ; phần thiếu ghi thành **BL-433** và nói rõ trong PR. Không chạy lại vòng vì máy vẫn thiếu RAM (agent không tự khởi động lại tiến trình đã bị dừng vì áp lực bộ nhớ).

### 8.4 Kết quả test thủ công (§5, SHA code cuối `25849047`, HEAD lúc chạy `071d2ca4`)

| Bước | Kết quả | Ghi chú |
|---|---|---|
| M-142-01 | đạt | hai lệnh chuyển thật 1.500.000 và 200.000: bộ đếm 1.700.000, ngày 2026-11-22; job `OK`; `check:invariants` `PASS` |
| M-142-02 | đạt | reset bộ đếm: `MISMATCH`, log `failedChecks=[daily_debit_counters]`; `check:invariants` nêu đúng tài khoản |
| M-142-03 | đạt | khôi phục từ sổ cái: `OK`, `PASS` |
| M-142-04 | đạt | tắt trigger khi chuyển thật: bộ đếm 1.700.000 so với sổ 1.800.000, `MISMATCH` chỉ ở bộ đếm, tổng số dư 0; sửa → `OK` |
| M-142-05 | đạt | bộ đếm SYSTEM lạ: `OK` |
| M-142-06 | đạt | bằng role `dbs_worker`: `OK`, +1 → `MISMATCH`, sửa lại → `OK` |
| M-142-07 | đạt | 100.010 dòng: 166 đến 177 ms trước, 182 đến 217 ms sau |
| M-142-09 | đạt | 10.000 tài khoản × 30 ngày, 720.010 dòng, 300.031 nhóm: 1,81 đến 2,00 s trước, 2,25 đến 2,27 s sau; không tràn đĩa |
| M-142-08 | đạt | `check:invariants` cuối `PASS`; dọn dẹp: container và database tạm đã xóa |

Không có ảnh chụp màn hình: task không có giao diện, bằng chứng là output thô ở `screenshots/DBS-142/manual-test.txt` (không chứa token hay secret).

### 8.5 Diff so với kế hoạch §7 và chỗ lệch

`git diff --stat 3035f02f..HEAD` (3 commit trước commit tài liệu này): 14 file, +798 −40. Đúng kế hoạch §7; thêm ngoài kế hoạch ban đầu: TC-421-06, ca (b2) của TC-421-03, M-142-09 và sửa `alarms.tf` (chữ), đều do domain review (§6).

**Lệch:**
1. **Code viết trước domain review** (G2 quyết định 4): các test đỏ trước khi có code vẫn ghi ở §7; reviewer đọc cả code.
2. **«Đóng khi» của BL-421** khác thực hiện ở hai chỗ (SQL không cùng văn bản với `invariants.sql`; không thêm metric và alarm mới): §2.2.
3. **DoD 2 «10 lần liên tiếp»** đạt 3 lượt của bộ đầy đủ (8.3, BL-433).
4. **Không chạy toàn bộ `npm test` và `test:e2e` ở máy này** (RAM); CI thay.
5. **Ca thử «đối soát lặp song song với chuyển tiền đang commit»** (domain review mục 14) không làm: bằng chứng là lập luận snapshot (một câu `WITH`, READ COMMITTED), TC-118-02 và các lượt chạy.

### 8.6 Trạng thái DoD

| DoD | Trạng thái |
|---|---|
| 1. Mọi mục nợ có PR đóng hoặc dòng BACKLOG với lý do và mức | **đạt**: §2.1 (mỗi dòng có xử lý); BL-428..432 mới |
| 2. AC-5.1…5.10 xanh; không flaky (10 lần liên tiếp) | AC xanh: **đạt**. 10 lần liên tiếp: **chưa đạt**, 3 lượt, không thấy flaky (8.3, BL-433) |
| 3. Tài liệu ledger khớp code; dòng «Verified» chỉ ghi ngày cho phần đã đối chiếu | **đạt**: `docs/03`, brief, README; hai dòng «Verified» ghi rõ phần chưa kiểm |
| 4. PR merge (CI xanh), Dev review, bảng đối chiếu | **chưa đủ**: bảng đối chiếu ở 8.2; CI và merge theo PR; **Dev review không có** (opus high thay người, `Techlead waiver` ở PR): DoD «Dev review» **không đạt về hình thức** |

### 8.7 Bàn giao

BL-428 (hai bộ kiểm SQL riêng), BL-429 (ngày Việt Nam chép sáu nơi), BL-430 (nạp và chuyển chép nhau, `Clock` đăng ký hai lần), BL-431 (quyền dư trên `reconciliation_runs`), BL-432 (ranh giới module), BL-433 (đủ 10 lượt). Giữ nguyên: BL-422, BL-416, BL-277, BL-240, BL-381, BL-125, BL-200, BL-231, BL-198, BL-279 (§2.1). Người thật cần: chuyển hàng board DBS-142 sang «In Review» và chỉ định Dev review.

## 9. Tài liệu đã cập nhật

- `docs/03_HIGH_LEVEL_ARCHITECTURE.md` (các đoạn ledger: khóa, retry, replay, hạn mức, đối soát, index, và dòng «Verified against code»), `docs/components/ledger/01-concept-brief.md`, `backend/src/modules/ledger/README.md` (bảng AC → test, bước sửa bộ đếm, mô tả job 5 kiểm, 429 và luật key), `infra/terraform/envs/dev/session/alarms.tf` (chữ mô tả alarm), thông báo 400 của `operator-deposits.controller.ts` (lỗi chính tả).
- `docs/BACKLOG.md`: **xóa BL-421**; **thêm BL-428, 429, 430, 431, 432, 433**.
- `docs/features/README.md`: thêm dòng DBS-142. Bằng chứng: `screenshots/DBS-142/` (`doc-vs-code-audit.md`, `domain-review.md`, `manual-test.txt`).
