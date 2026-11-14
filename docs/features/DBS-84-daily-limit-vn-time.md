# DBS-84 · Sync guard bước 2: hạn mức ngày theo giờ Việt Nam, ≤ 5 ms

> **Status:** Implemented · **Vai:** Dev (ledger; #4 review theo ghi chú 12/10 trên board) · **Nhánh:** `feat/DBS-84-daily-limit-vn-time` · **PR:** [#74](https://github.com/Lawliet119/digital-banking-simulator/pull/74) · **Cập nhật:** 2026-11-08
>
> Techlead waiver: G1–G4 do agent tự duyệt theo yêu cầu của techlead (`huyasuo1109@gmail.com`); không có Dev khác (kể cả #4) review trước merge; không có ảnh PNG, bằng chứng là output thô; domain review do chính agent làm, không dùng subagent (§6).

## 1. Bối cảnh

- **Task trên board:** Story, Tuần 3, Dev, ưu tiên Highest, Demo 1. **Expect:** «Hạn mức ngày đúng tuyệt đối kể cả khi đồng thời.»
- **DoD:**
  1. Truy vấn `SUM(amount)` với `direction = DEBIT` và `created_at ≥ 00:00 hôm nay` theo `Asia/Ho_Chi_Minh`, chạy sau `FOR UPDATE`; chỉ tính tiền đi.
  2. `EXPLAIN (ANALYZE, BUFFERS)` dùng `Index Only Scan` trên `ledger_entries_daily_debit_idx`, ≤ 5 ms với tài khoản 1 triệu dòng; lưu kết quả vào tài liệu.
  3. AC-5.6 (đã chuyển 180tr, 2 lệnh 15tr song song, hạn mức 200tr → đúng 1 COMPLETED, 1 REJECTED) xanh trên Postgres thật.
  4. Lệnh DEPOSIT bỏ qua guard của SYSTEM; deposit không tính vào hạn mức ngày của khách nhận.
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ.
- **Phụ thuộc:** DBS-82 (`SyncGuardService`) đã vào `main` (#72).
- **Cột «Thực trạng» đã cũ ở một điểm quan trọng.** Index `ledger_entries_daily_debit_idx` có từ DBS-21 và truy vấn ngày chạy từ DBS-61/82, **nhưng chưa ai đo `EXPLAIN` trên dữ liệu lớn**. Agent đo trước khi thiết kế (Postgres 17 tạm, UTC, 1.000.004 dòng ghi nợ của một tài khoản + 500.000 dòng của 50.000 tài khoản khác, `VACUUM ANALYZE`):

| Biểu thức mốc ngày | Plan | Thời gian |
|---|---|---|
| **Hiện tại:** `date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE …` | **`Parallel Seq Scan`** (không dùng index; `clock_timestamp()` là hàm VOLATILE nên không được làm điều kiện index, chỉ làm `Filter`) | **256 ms** |
| `statement_timestamp()` (STABLE) | `Index Only Scan`, `Heap Fetches: 0` | 0,10 ms |
| Tham số `$2::timestamptz` rồi `date_trunc(… $2 AT TIME ZONE …)` | `Index Only Scan`, `Index Cond: created_at >= '2026-11-07 17:00:00+00'` (planner gấp hằng), `Heap Fetches: 0` | 0,22 ms |

  Vậy DoD #2 hiện **không đạt**: với tài khoản nóng 1 triệu dòng, mỗi lệnh chuyển giữ khóa thêm ~250 ms, đúng điều database-design §6.1 cảnh báo. Đây là lỗi thật cần sửa, không chỉ thiếu bằng chứng.
- **Baseline `main` `e21669d`** (Node 24.22.2): lint, typecheck sạch; unit 1073/1073; `test:db` xem §8.
- **Đối chiếu DoD với `main`:**

| DoD | Hiện trạng | Việc task này làm |
|---|---|---|
| #1 | SQL đúng ngữ nghĩa (chỉ DEBIT, mốc 00:00 giờ VN, chạy sau khóa vì `assertLocked`) | Giữ ngữ nghĩa; đổi cách lấy "bây giờ" |
| #2 | **Seq Scan 256 ms** (bảng trên) | Sửa SQL; test plan tự động; đo 1 triệu dòng, ghi §8 và `database-design.md` §7 |
| #3 | `customer-transfers.db-spec.ts` › `TC-54-04` đúng kịch bản AC-5.6, đang xanh | Giữ, đối chiếu; thêm ca song song 5 lệnh để chắc hơn |
| #4 | `TC-60-02` (SYSTEM âm, bỏ qua hạn mức), `TC-54-05` (tiền nhận qua chuyển khoản không tính) | Thêm ca nạp tiền (DEPOSIT) cho khách rồi khách chuyển đủ hạn mức |

- **Ngoài phạm vi:** test ranh giới nửa đêm 23:59:59/00:00:00 (DBS-85, BL-154); rate limit (DBS-89).
- **Backlog:** BL-154 (nửa đêm) thuộc DBS-85, để task đó xử lý. Không có hàng khác cùng DoD.
- **Quyết định ở G1 (agent tự duyệt):**
  1. **"Bây giờ" lấy từ một `Clock` có thể tiêm** (`SystemClock` = `new Date()` ở production) rồi truyền vào SQL như tham số `$2`, thay cho `clock_timestamp()` trong SQL. Lý do: (a) sửa được Seq Scan; (b) module-notes đã quy định "now comes from an injectable clock" để DBS-85 test được nửa đêm mà không phụ thuộc giờ máy. Đánh đổi: đồng hồ ứng dụng và đồng hồ DB lệch nhau vài mili-giây có thể đẩy một lệnh sát 00:00 sang ngày bên kia; chấp nhận vì ECS/RDS đều đồng bộ Amazon Time Sync và hạn mức ngày là kiểm soát nghiệp vụ, không phải bất biến sổ cái. Ghi vào BL.
  2. Mốc ngày vẫn tính **trong SQL** bằng `AT TIME ZONE 'Asia/Ho_Chi_Minh'` (database-design nguyên tắc 6), không cứng `+07` trong TypeScript.
  3. Không đổi schema, `ErrorCode`, env, event.

## 2. Hành vi

Không đổi API. Với lệnh chuyển đến được bước hạn mức ngày (nguồn và đích ACTIVE, `amount ≤ perTx`):

- `đã gửi hôm nay = SUM(amount)` các dòng `DEBIT` của tài khoản nguồn có `created_at ≥ 00:00 giờ Việt Nam của ngày chứa Clock.now()`.
- `đã gửi hôm nay + amount > perDay` → `LIMIT_PER_DAY_EXCEEDED`; bằng thì qua.
- Dòng `CREDIT` (tiền nhận, kể cả nạp tiền) không bao giờ được cộng. Lệnh `DEPOSIT` đi từ SYSTEM và không gọi guard (ADR-09): SYSTEM âm bao nhiêu cũng được.
- Ví dụ AC-5.6: đã chuyển 180.000.000đ; hai lệnh 15.000.000đ song song → một `201 COMPLETED`, một `422 LIMIT_PER_DAY_EXCEEDED` (đã lưu REJECTED, DBS-83). Tổng ngày ≤ 200.000.000đ.
- Truy vấn ngày chạy **một lần** mỗi lệnh, sau `lockForUpdate`, và chỉ khi lệnh qua bước ACTIVE và `perTx`.

## 3. Kiến trúc

- **Vị trí:** module `ledger`, role `api`. Thêm `src/common/clock.ts` (`Clock` abstract class, `SystemClock`); `LedgerModule` đăng ký `{ provide: Clock, useClass: SystemClock }` và export `Clock` qua `ledger/index.ts` để test thay thế; `sync-guard.service.ts` tiêm `Clock`, export `SENT_TODAY_SQL`.
- **Interface:**

```ts
// common/clock.ts
export abstract class Clock { abstract now(): Date }
export class SystemClock extends Clock { now(): Date { return new Date() } }

// ledger/sync-guard.service.ts
export const SENT_TODAY_SQL: string   // $1 = account id, $2 = "now" (timestamptz)
checkGuards(manager, lockedFrom, lockedTo, amount): Promise<RejectReason | null>   // chữ ký không đổi
```

  Người gọi `SENT_TODAY_SQL`: chỉ `SyncGuardService`. Người gọi `checkGuards`: chỉ `TransferService` (không đổi).
- **SQL mới:**

```sql
SELECT coalesce(sum(amount),0)::text AS total FROM ledger_entries
 WHERE account_id=$1 AND direction='DEBIT'
   AND created_at >= date_trunc('day', $2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')
                     AT TIME ZONE 'Asia/Ho_Chi_Minh'
```

- **Dữ liệu:** chỉ đọc `ledger_entries`; không đổi schema; dùng index sẵn có `ledger_entries_daily_debit_idx (account_id, created_at) INCLUDE (amount) WHERE direction = 'DEBIT'`.
- **Transaction:** trong `TransactionService.run` của `TransferService`, sau khóa. `Clock.now()` đọc **sau** khi giữ khóa (trong `checkGuards`), nên lệnh chờ khóa lâu không dùng mốc ngày đã cũ.
- **Thay đổi cấp hệ thống:** `docs/components/_shared/database-design.md` §7 (kết quả đo 1 triệu dòng), `docs/components/ledger/01-concept-brief.md` dòng 251 không đổi; README `ledger` (dòng Clock).

## 4. Test cases tự động

PostgreSQL 17 thật (Testcontainers). Đột biến kèm theo ở §7.

| ID | Truy vết | Lớp | Given · When · Then | `errorCode` |
|---|---|---|---|---|
| TC-84-01 | DoD #2 | e2e Postgres | Một tài khoản 100.000 dòng DEBIT rải 2 năm + dòng của 5.000 tài khoản khác, `VACUUM ANALYZE`; `EXPLAIN (FORMAT JSON)` của `SENT_TODAY_SQL` → có node `Index Only Scan` trên `ledger_entries_daily_debit_idx`, không có `Seq Scan`, `Heap Fetches = 0` | — |
| TC-84-02 | DoD #2 | thủ công (script có cổng) | 1.000.000 dòng của một tài khoản; `EXPLAIN (ANALYZE, BUFFERS)` ≤ 5 ms, `Index Only Scan` | — |
| TC-84-03 | DoD #1 | e2e Postgres | `checkGuards` cộng đúng các dòng DEBIT hôm nay: biên `đã gửi + amount == perDay` qua, `+1` bị từ chối (đã có ở TC-82-03, chạy lại với `Clock`); dòng CREDIT bằng 10 lần hạn mức không được cộng | `LIMIT_PER_DAY_EXCEEDED` |
| TC-84-04 | DoD #1 | e2e Postgres | `Clock` được đọc **sau** khóa: thay `Clock.now()` ghi lại thời điểm và thứ tự so với `lockForUpdate` | — |
| TC-84-05 | DoD #3 | e2e HTTP | AC-5.6 có sẵn (`TC-54-04`): 180tr + 2 × 15tr song song → đúng 1 `201`, 1 `422` | `LIMIT_PER_DAY_EXCEEDED` |
| TC-84-06 | DoD #3 | e2e HTTP | Mở rộng AC-5.6: đã gửi 180tr, **5** lệnh 10tr song song → đúng 2 `201`, 3 `422`; bất biến sổ cái PASS | `LIMIT_PER_DAY_EXCEEDED` |
| TC-84-07 | DoD #4 | e2e HTTP | Khách nhận 3 lần nạp 100.000.000đ (tổng > hạn mức ngày) → vẫn chuyển được 4 × 50.000.000đ; lệnh thứ năm 1đ → từ chối. Nạp tiền không bị chặn dù SYSTEM âm | `LIMIT_PER_DAY_EXCEEDED` |
| TC-84-08 | DoD #4 | e2e HTTP | (có sẵn `TC-60-02`) DEPOSIT lớn hơn `perTx`, `perDay` vẫn `201`, SYSTEM âm | — |
| Quy trình | DoD #5 | — | Merge, CI, Dev review | waiver |

## 5. Test thủ công

`node backend/scripts/manual-dbs84.cjs` (Docker, Node 24): app thật, JWT thật, Postgres 17; sau đó script đo 1 triệu dòng.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-84-01 | Nạp 300.000.000đ cho Vũ Thị Giang; chuyển 4 × 50.000.000đ cho Bùi Văn Hải | 4 × `201` |
| M-84-02 | Giang chuyển 1đ | `422 LIMIT_PER_DAY_EXCEEDED`; Hải có 200.000.000đ |
| M-84-03 | Nạp lại 500.000.000đ cho Giang (tiền vào không tính hạn mức); Hải (vừa nhận 200tr) chuyển 50.000.000đ cho Giang | `201` |
| M-84-04 | Tạo 1.000.000 dòng ghi nợ của một tài khoản trong DB tạm; `EXPLAIN (ANALYZE, BUFFERS)` truy vấn ngày | `Index Only Scan` trên `ledger_entries_daily_debit_idx`, `Heap Fetches: 0`, `Execution Time` ≤ 5 ms |
| M-84-05 | Chạy lại `EXPLAIN` với truy vấn **cũ** (`clock_timestamp()`) làm đối chứng | `Seq Scan`, hàng trăm ms |
| cleanup | Dọn | `DBS-84 cleanup PASS` |

## 6. Domain review (AI)

**Reviewer:** chính agent (Sonnet 5.5), 2026-11-08; đọc `sync-guard.service.ts`, `transfer.service.ts`, `deposit.service.ts`, database-design §6–§7, ADR-04/09, BRD AC-5.6. Không dùng subagent.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | Truy vấn ngày Seq Scan 256 ms trên 1 triệu dòng (VOLATILE) | Sửa trong phạm vi; TC-84-01/02 |
| 2 | should-fix | Lệch đồng hồ app–DB quanh 00:00 | Chấp nhận, nêu ở G1 câu 1, ghi BL |
| 3 | should-fix | `Clock.now()` phải đọc sau khóa, nếu không lệnh chờ lâu dùng ngày cũ | TC-84-04 |
| 4 | minor | Plan có thể chuyển sang Seq Scan nếu thống kê lệch | TC-84-01 chạy sau `ANALYZE`; ghi cách chạy lại trong runbook (database-design §7) |
| 5 | minor | Gather song song làm tăng thời gian nhỏ nếu ước lượng sai (đã gặp với dữ liệu nhiễu tập trung) | Đo lại với dữ liệu phân bố thật; hằng số hóa mốc ngày làm planner ước lượng đúng |

Không có phát hiện blocking còn mở. Verdict tự đánh giá: APPROVE.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `common/clock.ts`, `ledger.module.ts`, `ledger/index.ts`, `sync-guard.service.ts` (`SENT_TODAY_SQL` export + `$2`), `test/db/daily-limit.db-spec.ts` (TC-84-01, 03, 04) | TC-84-01 | điền khi chạy | `npm run test:db -- --runInBand daily-limit sync-guard` | `fix(ledger): daily limit query uses an index-only scan from an injectable clock` |
| 2 | `customer-transfers.db-spec.ts` (TC-84-06, 07) | TC-84-06/07 | — (kiểm tra bổ sung, xanh ngay) | `npm run test:db -- --runInBand customer-transfers` | `test(ledger): AC-5.6 with five parallel transfers and deposits do not count (DBS-84)` |
| 3 | `test/manual/daily-limit.explain.manual.ts`, `scripts/manual-dbs84.cjs` | M-84-01..05 | — | `node backend/scripts/manual-dbs84.cjs` | `test(ledger): DBS-84 manual driver and one-million-row EXPLAIN` |
| 4 | docs (database-design §7, README ledger, doc này, index, BACKLOG) | — | — | `check-doc-links.mjs` | `docs(ledger): record DBS-84 evidence` |

Rủi ro: đồng hồ app lệch DB (ghi BL). Lùi: `git revert`, không migration. Đột biến: đổi SQL về `clock_timestamp()` (TC-84-01 phải hỏng); đọc `Clock` trước khóa (TC-84-04 phải hỏng); bỏ `direction='DEBIT'` (TC-84-03/07 phải hỏng).

**Quyết định ở G3 (agent tự duyệt):** theo bảng trên.

## 8. Kết quả

- **Lệnh kiểm tra** (Node 24.22.2, `backend/`, commit code cuối `a5e89bc`; SHA ở dòng đầu `manual-test.txt`):

| Lệnh | Kết quả |
|---|---|
| `npm run lint:check`, `typecheck`, `build` | đạt (mã thoát 0) |
| `npm test -- --runInBand` | **1073/1073**, 66 suite |
| `npm run test:e2e -- --runInBand` (với `DATABASE_URL` tới Postgres 17 tạm) | **148/148**, 14 suite |
| `npm run test:db -- --runInBand` | **682/682**, 37 suite (+12 ca, +2 suite so với 670/35 của DBS-82) |
| `node scripts/manual-dbs84.cjs` | 5/5 bước + dọn dẹp đạt |

  0 test bị `.skip/.only/.todo`.

- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-84-01 | `daily-limit.db-spec.ts` › `TC-84-01` (200.000 dòng; `Index Only Scan`, không `Seq Scan`, `Index Cond` có `created_at >=`, `Heap Fetches` 0). **Đột biến:** đưa `clock_timestamp()` vào SQL → ca hỏng | đạt |
| TC-84-02 | `scripts/manual-dbs84.cjs` M-84-04: 1.000.400 dòng, trung vị 0,163 ms (7 lần), ngưỡng 5 ms | đạt |
| TC-84-03 | `daily-limit.db-spec.ts` › `TC-84-03` (biên 50.000.000 qua / +1 bị từ chối, 300.000.000 CREDIT không tính, `Clock` +1 ngày → 0, tổng SQL) | đạt |
| TC-84-04 | `daily-limit.db-spec.ts` › `TC-84-04` (`lockForUpdate` 1 lần, `Clock.now` 1 lần, đúng thứ tự) | đạt. Chưa chạy đột biến "đọc Clock trước khóa" (xem Lệch) |
| TC-84-05 | `customer-transfers.db-spec.ts` › `TC-54-04` (AC-5.6, có sẵn) | đạt |
| TC-84-06 | `customer-transfers.db-spec.ts` › `TC-84-06` (5 lệnh 10tr song song → 2 × 201, 3 × 422, tổng nợ 200.000.000) | đạt |
| TC-84-07 | `customer-transfers.db-spec.ts` › `TC-84-07` (3 lần nạp 100tr không tính; 4 × 50tr qua, 1đ bị từ chối) | đạt |
| TC-84-08 | `operator-deposits.db-spec.ts` › `TC-60-02` (có sẵn) | đạt |
| Quy trình | DoD #5 | chưa làm: Dev review (BL-176) |

  8 ca/nhóm đạt, 0 đơn giản hóa. TC-84-01 đỏ khi dùng `clock_timestamp()` (đột biến); các test còn lại không đỏ riêng trước khi cài đặt vì `@common/clock` và `SENT_TODAY_SQL` chưa tồn tại (lỗi biên dịch `Cannot find module '@common/clock'`).

- **Test thủ công** (output thô [manual-test.txt](screenshots/DBS-84/manual-test.txt)):

| Bước | Kết quả thật | Kết quả |
|---|---|---|
| M-84-01 | Nạp 300tr, 4 × 50tr → 201 | đạt |
| M-84-02 | 1đ → 422 `LIMIT_PER_DAY_EXCEEDED`, không dòng sổ mới; Hải có 200.000.000 | đạt |
| M-84-03 | Nạp thêm 500tr + nhận 50tr, vẫn kẹt hạn mức gửi; bất biến PASS | đạt |
| M-84-04 | 1.000.400 dòng: `Index Only Scan using ledger_entries_daily_debit_idx`, `Index Cond … created_at >= '2026-11-07 17:00:00+00'` (00:00 giờ VN), `Heap Fetches: 0`, 14 buffer, trung vị **0,163 ms**; `SHOW timezone` = UTC | đạt |
| M-84-05 | Truy vấn cũ cùng dữ liệu: `Parallel Seq Scan`, 24.369 buffer đọc, **203 ms** | đạt (đối chứng) |
| cleanup | JWKS, database tạm, container đã dọn | đạt |

  Seed SQL cho user/customer/tài khoản số dư 0 và (M-84-04/05) 1,5 triệu dòng sổ trong DB tạm để đo plan; tiền ở M-84-01..03 vào qua API nạp tiền.

- **Phạm vi so với §7:** khớp. Thêm `test/support/daily-debit-fixture.ts` (dữ liệu cho TC-84-01 và M-84-04), `sync-guard.service.spec.ts` (nhận `Clock`), `ledger/index.ts`.
- **Ảnh chụp:** không có (waiver); bằng chứng là `manual-test.txt`.
- **Lệch so với kế hoạch:** (1) TC-84-04 chưa chạy đột biến "đọc Clock trước khóa". (2) Kế hoạch ghi 4 commit; thực tế có thêm commit sửa fixture (bỏ qua transfer REJECTED), lộ ra khi chạy test thủ công.
- **Để lead xem kỹ:** hạn mức ngày giờ lấy "bây giờ" từ đồng hồ ứng dụng thay vì đồng hồ DB (G1 câu 1); đánh đổi nêu ở BL-177.
- **Bàn giao:** BL-176 (Dev review các PR techlead), BL-177 (đo độ lệch đồng hồ ECS–RDS). BL-154 (nửa đêm) để DBS-85.


### Độ lệch đồng hồ ECS–RDS đo trên AWS 2026-11-14 (BL-177)

Task Fargate một lần trong VPC (cùng mạng với api) gọi `SELECT clock_timestamp()` 50 lần trên RDS PostgreSQL 17 qua TLS và
so với `Date.now()` hai đầu: RTT nhỏ nhất 0–1 ms, lệch ở mẫu RTT nhỏ nhất **0,48 ms**, trung vị 0,51 ms (mẫu lệch nhất
−25,8 ms là mẫu có RTT lớn, nên là trễ mạng chứ không phải lệch đồng hồ). Dưới ngưỡng 100 ms của BL-177 nên giữ `Clock` của
ứng dụng như quyết định §2. Bằng chứng: [manual-test DBS-139](screenshots/DBS-139/manual-test.txt).

## 9. Tài liệu đã cập nhật

`docs/components/_shared/database-design.md` (§7.1 kết quả đo), `backend/src/modules/ledger/README.md`, `docs/features/README.md`, `docs/BACKLOG.md` (thêm BL-176, BL-177). Không xóa dòng BL nào.
