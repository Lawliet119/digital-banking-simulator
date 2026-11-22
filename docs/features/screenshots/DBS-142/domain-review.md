# Domain review DBS-142 (nguyên văn trả lời của subagent)

> Subagent `opus`, effort `high`, 2026-11-22, chỉ đọc, lượt 1 (trên commit `84d6203c` và cây làm việc có sửa tài liệu). Prompt: `.claude/skills/dbs-delivering-task/prompts/domain-review.md` kèm câu hỏi riêng về hai quyết định thiết kế và về báo động giả khi có chuyển tiền đồng thời.

| # | Severity | Section of the doc | Finding | Evidence (file and line) | Suggested fix |
|---|---|---|---|---|---|
| 1 | blocking | §3 "Thay đổi cấp hệ thống" (alarm text), §7 step 5 | The new `alarm_description` puts unescaped double quotes inside an HCL string (`dòng log "Ledger reconciliation detected mismatch", …`). I ran `terraform fmt -check -diff` on a copy of the file and it fails: `Error: Missing newline after argument … line 341`, exit 2. CI runs `terraform fmt -check -recursive -diff infra/terraform`, so the PR goes red. `terraform validate`/`test` would also fail, and so would the next `apply`. The doc calls this "chỉ đổi chữ mô tả" (wording only). | `infra/terraform/envs/dev/session/alarms.tf:341`; `.github/workflows/ci.yml:325-326` | Use `«…»` or `\"…\"` around the log message. Run `terraform fmt -check` and `terraform test` in `envs/dev/session` before the PR. Add the Terraform job to the §7 proof commands. |
| 2 | should-fix | §4 TC-421-01, §2.2 "đóng kín" (fail closed) | TC-421-01 promises "thiếu trường → MISMATCH" (missing field gives MISMATCH). No test does this: the spec only checks `daily_counters_valid:false`, and every fixture now sets the field to `true`. The `failedChecks` field that the service puts in the `warn` line (the field the alarm text tells operators to read) is also never asserted. TC-421-05 tests only the pure function, and `run-log.spec`/`metrics.spec` mock `warn` without checking what it receives. Only the manual script checks it. | `reconciliation.types.spec.ts` (diff of 84d6203c: only `daily_counters_valid:false`); `reconciliation.run-log.spec.ts:41`, `reconciliation.metrics.spec.ts:55`; `reconciliation.service.ts:245,260` | Add a unit case where the raw row lacks `daily_counters_valid`: `reconcileOnce` must give `MISMATCH`. Add a `run-log.spec` case that asserts the `warn` payload has `failedChecks:['daily_debit_counters']` and has no `accountId`/UUID. |
| 3 | should-fix | §2.2 "Chi phí", §7 "Rủi ro … không đáng kể" | (a) The cost figures (99→116 ms, 2.06→2.08 s) have no evidence: `screenshots/DBS-142/` holds only the audit file. (b) The bench in M-142-07 is not realistic. All bench DEBIT lines sit on one customer account (plus the SYSTEM account), so `debit_by_day` has about 31 groups. In production it is accounts × days groups, and the `HashAggregate` plus the `DISTINCT ON` sort can spill past `work_mem`. So "+20 ms" does not show the new scan is cheap. | `backend/scripts/manual-dbs142.cjs:166-188`; `reconciliation.service.ts:64-77`; `ls docs/features/screenshots/DBS-142/` | Bench with at least 10k accounts × 30 days and save the EXPLAIN output as evidence. Or rewrite the check the way `invariants.sql` does it (latest line per account, then a range sum on `ledger_entries_daily_debit_idx`). Either way, link BL-277/BL-240 for the RDS run. |
| 4 | should-fix | §1 G1 decision 2, §4 TC-142-02 | The DoD says "không có test flaky nào ở ledger" (no flaky test anywhere in ledger). The 10-run loop lists 17 DB suites but leaves out ledger suites that exist: `midnight-boundary`, `daily-debit-guard`, `daily-debit-counter-roles`, `transaction-history`, `transaction-history-plan`, `append-only`, `transfer-facts`, `reconciliation-schema`, `reconciliation-migration-revert`, `ledger-invariants-helper`. It also leaves out the ledger unit suites and `db-roles` TC-117-10, which runs the new SQL as `dbs_worker`. Limiting the loop to DB suites is a fair reading; this particular subset is not. | `ls backend/test/db` against the list at `DBS-142-ledger-tech-debt.md:84` | Add these suites (and the cheap `jest src/modules/ledger`) to the 10-run loop, or list each excluded suite with the reason it is excluded. |
| 5 | should-fix | §2.1 row 3, DoD 3 | The "Verified against code" line of `docs/03` was not touched. It still says "job đối soát ledger (4 kiểm tra …)", with "Cập nhật: 2026-11-08", and still says the worker/SQS/alarm infrastructure is missing. This contradicts the edited §8, which now lists five checks. DoD 3 names this line explicitly. | `docs/03_HIGH_LEVEL_ARCHITECTURE.md:3` against `:644` | Update the line: give the ledger part a date (2026-11-22, DBS-142), say five checks, and list what was not verified. |
| 6 | should-fix | DoD 3, README | The README status line says "Verified against code: 2026-11-22 … từng mục dưới đây đối chiếu với code và test" (every item below checked against code and tests). The README also carries performance numbers (0.163 ms, 256/203 ms) that the brief, in the same PR, lists as not verified. The two claims cannot both be true, and DoD 3 says to date only what was actually checked. | `backend/src/modules/ledger/README.md:5` against `docs/components/ledger/01-concept-brief.md:3` | Scope the README line the way the brief does: name the sections checked and exclude the measured numbers and ECS grants. |
| 7 | should-fix | §2.2 (behaviour after MISMATCH), §5 M-142-03 | There is no repair procedure for a counter mismatch. `dbs_api` and `dbs_worker` cannot UPDATE `sent_today`/`sent_day`, so a repair needs the owner role, and the tests do it with ad-hoc SQL. Until someone repairs it, every run (60 s in dev) is MISMATCH. The alarm stays in ALARM, so a later real balance mismatch sends no new notification. Reusing one alarm for both checks makes this worse. | `infra/scripts/db-roles.sql:84-87,112`; `1795000012000-AddDailyDebitCounter.ts` (backfill SQL); `docs/components/observability/01-concept-brief.md:173` | In the README (or a runbook), write the repair step: rebuild the counter from the ledger using the migration backfill, as the owner role, then check that `check:invariants` passes. In §2.2, state that a lasting counter mismatch hides later MISMATCHes from the alarm. |
| 8 | minor | §2.2 decision (a), §7 "Quét kế hoạch" | BL-421's close condition (on `origin/main`) says the check uses the same SQL as `invariants.sql` and adds metric and alarm. The implementation uses a different, one-pass SQL and reuses the existing metric and alarm. I think both choices are sound: any MISMATCH already fires `dbs-dev-reconciliation-failed`, and the `details` CHECK cannot hold counter detail. But §7 only says "metric và alarm xem §2.2" (metric and alarm: see §2.2) and does not record the "same SQL" departure. Treating an over-count as MISMATCH is justified: it is derived data and matches check 6. Failing closed is right in principle (see #2). | `git show origin/main:docs/BACKLOG.md` (BL-421 row); `DBS-142-ledger-tech-debt.md:60,119` | In §8/§9, record explicitly: "khác SQL, cùng quy tắc; tương đương chứng bằng TC-421-02..04; BL-428/429 giữ phần còn lại" (different SQL, same rule; equivalence shown by TC-421-02..04; BL-428/429 cover the rest). |
| 9 | minor | §4 TC-421-02..04 (mutation strength) | These mutants are caught: dropping the SYSTEM filter (the funding account has DEBIT lines, TC-421-04), using the UTC date (the 17:00Z case), comparing `sent_today` only (TC-421-03b and the wrong-day step of TC-421-04), comparing `sent_day` only (+1 edit), and summing all days. These survive: `LEFT JOIN` changed to `JOIN`, and `IS DISTINCT FROM` changed to `<>`. No case puts a counter on a non-SYSTEM account that has no DEBIT line (for example `sent_day` set with `sent_today` 0 or above 0). | `reconciliation-daily-counter.db-spec.ts:111-256`; `reconciliation.service.ts:78-88` | Add one step: set the recipient's (never-debited) `sent_day` to a date with `sent_today=0`. Both checks must report a mismatch. |
| 10 | minor | README AC→test table, §2.1 row "AC … không có nhãn" | Row 5.2 cites `TC-83-02` and `TC-83-03`, which test unknown, funding or LOCKED destinations and replay, not insufficient funds. The table leaves out the tests that match the ACs word for word: `TC-61-01` (title "AC5.1 A1m → B300k"), `TC-61-02` ("AC5.2"), and `TC-61-03` (a source account owned by someone else, which is AC-5.8). So the §2.1 claim that AC-5.1 has no label in any test name is false. The other rows are correct: 5.1 TC-65-01 shows 700000/300000; 5.9 TC-99 checks `checkLedgerInvariants` PASS, which includes `customer_balances`. | `README.md:83-90`; `customer-transfers.db-spec.ts:68,205,212`; `rejected-transfers.db-spec.ts:178,208` | Fix row 5.2, add TC-61-01/02/03, and correct the §2.1 wording. |
| 11 | minor | §2.1 row 3 (doc truthfulness) | (a) `docs/03` says `check:invariants` "kiểm sáu điều: thêm số dư khách không âm … và bộ đếm" (six checks, adding non-negative balances and the counter). The job now also checks the counter, so the only extra check is `customer_balances`. (b) The brief says "đã có test so hai kết quả" (a test already compares the two results), as if it covered every rule. It covers only the counter, and BL-428 itself says the other four have no such test. (c) The README says "Quá 10 lệnh … trả 429" (more than 10 transfers returns 429) as an absolute. The limit is an env default, the window is fixed (bursts up to 2× at the boundary), and the limiter lets requests through when Redis is down. | `docs/03…md:644`; `01-concept-brief.md:320`; `README.md:48`; `rate-limiter.ts:16-23`; `validation.schema.ts:216` | Correct the three sentences. |
| 12 | minor | §2.1 table, BACKLOG sources | (a) The doc gives BL-381 as "Thấp · H5", but the BACKLOG row says "Trung bình \| Hoãn · H5". (b) The sources of BL-428..432 point to "DBS-142 §8 (mục nợ N)", but §8 is still a placeholder ("điền ở Phase 5"); the items are actually in §2.1 and the audit file. `check-backlog.mjs` ran on Node 18.20.8: "111 dòng, 0 lỗi" (111 rows, 0 errors). The other classifications are consistent: BL-428/429/430/432 H5, BL-431 H1, BL-416/422 H1, BL-277/240/198 H4, BL-125/200/231 H2, BL-279 H3. BL-421 is removed. | `DBS-142-ledger-tech-debt.md:42`; `docs/BACKLOG.md:68-72` | Align BL-381. Point the sources at §2.1 or `screenshots/DBS-142/doc-vs-code-audit.md`, or fill §8 before the PR. |
| 13 | minor | §5 M-142-07 | The "before" SQL is read from `origin/main`. Once this PR merges, the bench compares the new SQL with itself. | `manual-dbs142.cjs:27-35` | Pin to `3035f02f` instead of `origin/main`. |
| 14 | none (checked, no defect) | §2.2 core logic: false alarm under concurrency | **No false MISMATCH found.** The job runs at READ COMMITTED (default of `withTransaction`). All checks are one `WITH … SELECT`, so all CTEs, including `accounts` and `ledger_entries`, read the same statement snapshot. The trigger updates the counter in the same transaction as the DEBIT lines, so a transfer that commits mid-scan is either fully visible or not visible at all. For every case I checked, the job's result equals check 6 and the trigger's state. Latest day by `MAX(day)` equals the day of the latest `created_at`, because the time-zone conversion is monotonic and Vietnam has no DST. 16:59:59Z/17:00Z goes through the same `(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` in all three places. SYSTEM accounts are excluded in all three. An account with no DEBIT line is handled by `IS DISTINCT FROM` plus `COALESCE(…,0)`. Backdated or out-of-order lines are consistent with "never move `sent_day` back". Comparisons are numeric with no NULL path, and amounts above 2^53 stay in SQL. Totals that overflow bigint give ERROR first, as documented. The log carries names only, and the `details` CHECK is untouched. | `transaction.helper.ts:112`; `reconciliation.service.ts:43-143`; `1795000012000-AddDailyDebitCounter.ts` (trigger); `invariants.sql:40-62`; `CreateTransfersLedgerIdempotency.ts:83` (`timestamptz … clock_timestamp()`) | Optional: a DB test that runs `reconcileOnce` in a loop while concurrent transfers commit and expects only OK. |

Verdict: REVISE


---

# Lượt 2 (opus high, 2026-11-22), trả lời nguyên văn của reviewer

# Review lượt 2: DBS-142 + BL-421

Phần code và SQL của job đúng; tôi không thấy báo động giả nào. Nhưng tài liệu còn vài chỗ nói quá đúng loại bạn hỏi, và bước sửa bộ đếm trong README có race. Tôi chỉ đọc, không sửa file nào.

## Phát hiện

**should-fix 1: chỉ mục features nói «10 lần liên tiếp» như đã đạt.**
- `docs/features/README.md:181` (chưa commit) ghi «10 lần liên tiếp các suite ledger», «nợ chưa làm thành BL-428..432» (thiếu BL-433) và trạng thái «Plan approved».
- Feature doc thì ghi «Implemented», 10 lượt «không đạt».
- Sửa: «3/10 lượt, BL-433», thêm BL-433, đồng bộ trạng thái.

**should-fix 2: §6 mục 14 dẫn «10 lần chạy» làm bằng chứng không có báo động giả.**
- `DBS-142-ledger-tech-debt.md:128`: thực tế chỉ có 3 lượt đủ bộ, cộng vòng hẹp 17 suite.
- Sửa: «3 lượt đủ bộ + 5 lượt vòng hẹp».

**should-fix 3: §8.3 ghi log vòng hẹp mạnh hơn bằng chứng.** Đối chiếu với `flake10\`:
- `run-5.log` không tồn tại. Dòng `run 5 exit=0 seconds=245` trong summary không có số test.
- `run-10.log` đã bị ghi đè bằng lỗi `flake10.sh: line 19: t-db.js: command not found`. Lý do: script bị viết lại lúc bash đang chạy nó. Summary vì thế có thêm dòng `run 10 exit=127`, dễ đọc nhầm thành lượt đỏ.
- Chỉ lượt 6–9 còn log (268/268). Lượt 10 chỉ còn dòng summary 268 đạt.
- «Trước đó» cũng sai thời điểm: vòng hẹp lượt 6–10 (13:44–14:09) chạy song song với lượt 1 đủ bộ (13:43–14:08). Đó cũng là lý do lượt 1 mất 1551 s so với 955 và 942 s.
- Lượt 5 chạy vắt qua commit `25849047` (13:41).
- Những gì khớp log: lượt 1–3 đủ bộ (29 suite, 478 test; 44 test đơn vị mỗi lượt), `run-4.log` rỗng, `unit-4.log` 44 đạt.
- Sửa: ghi «log còn cho lượt 6–9, lượt 10 chỉ có summary, lượt 5 không có số test; chạy song song lượt 1», giải thích dòng exit=127. Chép `summary.txt` vào `screenshots/DBS-142/`, vì scratchpad sẽ bị dọn.

**should-fix 4: bước sửa bộ đếm trong README có race với chuyển tiền đang chạy.**
- Vị trí: `backend/src/modules/ledger/README.md:74-80`.
- Ở READ COMMITTED, CTE `d` được tính trên snapshot đầu câu lệnh. Nếu một lệnh chuyển của tài khoản đó đang giữ khóa hàng rồi commit, `UPDATE` chờ khóa rồi ghi đè bằng tổng cũ (thiếu số tiền lệnh vừa commit).
- Hậu quả: bộ đếm lại thiếu, khách có thể vượt hạn mức ngày đúng bằng số đó. Lượt đối soát sau sẽ lại `MISMATCH`.
- Sửa: `BEGIN; SELECT 1 FROM accounts WHERE id='<id>' FOR UPDATE;` rồi mới chạy `UPDATE` (câu mới có snapshot mới), `COMMIT`.

**should-fix 5: BL-433 phân loại chưa hợp lý.**
- Đủ 8 cột, `check-backlog.mjs` báo 112 dòng, 0 lỗi.
- Nhưng «Hoãn · H5» là mã cho «cải tiến tùy chọn hoặc giảm chi phí», trong khi đây là DoD 2 chưa đạt của chính task. «Hạn: Không có» nghĩa là DoD này không có hạn.
- Đề xuất: đặt hạn (ví dụ trước DBS-200 hoặc trước khi chuyển DBS-142 sang Done). Ở «Đóng khi», thêm phương án chạy 10 lượt bằng `workflow_dispatch` trên runner CI, vì máy đó đủ RAM.

**should-fix 6: con số «19 chỗ tài liệu sai đã sửa» quá lời.**
- Báo cáo audit có 19 mục ở §1, còn §2.1 dòng 31 ghi «mục 1 đến 18».
- Mục 14 chưa sửa: `docs/03_HIGH_LEVEL_ARCHITECTURE.md:158` vẫn nói `workerModules` chỉ có 3 module và «chưa có consumer và scoring của risk», trong khi `backend/src/modules/index.ts:48` có `RiskWorkerModule`.
- Dòng «Verified» ở `docs/03:3` (vừa đổi ngày) vẫn nói «chưa có … hạ tầng worker/SQS/alarm», mâu thuẫn với `alarms.tf` và README.
- Sửa: hoặc sửa hai chỗ đó, hoặc ghi «18/19, mục 14 ngoài ledger chưa sửa».

**minor:**
- **Bảng đối chiếu ghi nhẹ tay:** §8.2 ghi TC-142-02 là «đơn giản hóa». Đúng ra là «chưa đạt».
- **Mô tả sai kế hoạch truy vấn:** §2.2 dòng 62 nói kế hoạch dùng «`HashAggregate` với `Batches: 1`». Trong `manual-test.txt`, `HashAggregate Batches: 1` là của `entry_by_account` (có sẵn). Phần mới (`counter_diffs`) chạy `Index Only Scan ledger_entries_daily_debit_idx` → `Incremental Sort` (quicksort, 28 kB) → `GroupAggregate` → `Unique`. Kết luận «không tràn đĩa» vẫn đúng.
- **Số đo 1 triệu dòng thiếu bằng chứng trong repo:** «≈ 2,06 s trước, ≈ 2,08 s sau» chỉ có trong `scratchpad\manual-dbs142-1m.txt` (lúc 13:25, trước commit `84d6203c`), không có trong `manual-test.txt` mà doc dẫn.
- **Số suite sai:** §1 dòng 20 ghi `test:db` có «74 suite». Thực tế 91 (90 trong `test/db` + 1 trong `test/security`).
- **Thiếu M-142-09 trong kế hoạch test thủ công:** bảng §5 không có bước này, §7 bước 4 ghi «M-142-01..08», trong khi §8.4 báo M-142-09 đạt.

## Kiểm chứng các mục lượt 1

| Mục | Kết quả |
|---|---|
| #1 HCL | Đã sửa: `alarms.tf` dùng «…». `terraform fmt -check -diff` exit 0. Mô tả dài 387 ký tự (< 1024). Tôi không chạy `validate`/`test`, và không thấy output lưu lại cho «111 đạt». |
| #2 | Đã sửa: TC-421-06 khớp đủ khóa của dòng warn. TC-421-01 thiếu trường dẫn tới `MISMATCH`. |
| #3 | Đã sửa (M-142-09), lệch nhỏ ở mô tả kế hoạch (xem minor). |
| #4 | Đã sửa: cả 29 tên suite tồn tại đúng trong `backend/test/db`, khớp regex của `flake10.sh`. |
| #5, #6, #7 | Đã sửa (còn race ở #7, xem should-fix 4). |
| #8, #9, #10, #11, #12, #13 | Đã sửa. #9 (b2) diệt được cả hai đột biến `JOIN` và `<>`. Các TC trong bảng AC đều tồn tại. BL-381 khớp. Script ghim `3035f02f`. |

## Số liệu ở §8 đã khớp

- **Test đơn vị:** 44 test (base 41) theo đếm `it(`, khớp `unit-1..4.log`.
- **Diff:** `3035f02f..HEAD` là 14 file, +798 −40.
- **Chi phí M-142-07 và M-142-09:** khớp `manual-test.txt` (166–177 / 182–217 ms; 1,81–2,00 / 2,25–2,27 s).
- **Công cụ kiểm:** `check-doc-links` 0 hỏng, `check-backlog` 0 lỗi.

## SQL của job

Không thấy lỗi đúng/sai nào:
- **Ngày Việt Nam:** cùng biểu thức `(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` với trigger và `invariants.sql`, không phụ thuộc `TimeZone` của phiên. `MAX(day)` tương đương «ngày của `created_at` mới nhất» vì phép đổi múi giờ đơn điệu và Việt Nam không có giờ mùa hè.
- **SYSTEM:** bị loại ở cả ba nơi. Cột `type` là NOT NULL và có CHECK.
- **Tài khoản chưa từng chi và NULL:** `LEFT JOIN` + `IS DISTINCT FROM` + `COALESCE` xử lý đúng. `sent_today` là NOT NULL.
- **So sánh kiểu:** date với date, numeric với numeric.
- **Chuyển tiền đồng thời:** không có báo động giả. Lý do:
  - Mọi kiểm nằm trong một câu `WITH`, nên dùng chung một snapshot.
  - Trigger cập nhật bộ đếm cùng transaction với `INSERT` dòng sổ (`ledger-posting.service.ts:152`).
  - `created_at` là `clock_timestamp()` lấy sau khi đã khóa tài khoản nguồn, nên đơn điệu theo từng tài khoản.
  - Trường hợp dòng sổ ngày cũ đến muộn vẫn nhất quán với quy tắc «không lùi `sent_day`».

Verdict: REVISE. Code và SQL đúng. Cần sửa trước PR: các chỗ nói quá về «10 lần» (chỉ mục features, §6 mục 14, §8.3), race của bước sửa bộ đếm trong README, phân loại và hạn của BL-433, và con số «19 chỗ đã sửa». Toàn bộ là sửa tài liệu và runbook, không phải sửa logic.
