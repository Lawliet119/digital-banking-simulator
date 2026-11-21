# BL-418 · Hạn mức ngày đọc từ hàng đếm trên `accounts`, không `SUM` trong lúc giữ khóa

> **Status:** Implemented (sau G4) · **Vai:** Dev (chủ ledger) · **Cặp đôi review:** Dev khác · **Nhánh:** `perf/BL-418-daily-limit-lock` · **PR:** [#227](https://github.com/Lawliet119/digital-banking-simulator/pull/227) · **Cập nhật:** 2026-11-22

## 1. Bối cảnh

- **Task trên board:** không có. Dòng `docs/BACKLOG.md` **BL-418** (nguồn: [báo cáo DBS-173](../components/load-tests/03-ket-qua-toi-uu-p95-2026-11-21.md) §5.1 và §6). **Mã task:** `BL-418` (tiền lệ [BL-360-372](BL-360-372-dlq-cli.md)); mã case là `TC-418-NN` và `M-418-NN`.
- **Đóng khi (chép nguyên văn từ BACKLOG):** «Đo và giảm thời gian giữ khóa (ví dụ số tiền đã chuyển trong ngày giữ trong một hàng đếm cùng giao dịch, hoặc tính ngoài khóa với kiểm lại), giữ AC-5.6 (hạn mức ngày, hai lệnh song song) và NFR-COR-03; `baseline` 120 RPS cho p95 chuyển < 300 ms ở từng phút». Chia thành các điều kiện:
  1. Đo thời gian giữ khóa (có phân rã bằng số).
  2. Giảm thời gian giữ khóa.
  3. Giữ AC-5.6 (hai lệnh 15tr song song khi đã chuyển 180tr: đúng 1 `COMPLETED`) và NFR-COR-03 (0 lần vượt hạn mức khi đồng thời).
  4. `baseline` 120 RPS: p95 chuyển < 300 ms ở từng phút (dòng `scenario = write_120` của `per-minute.json`, chỉ khung ≥ 500 mẫu).
- **Phụ thuộc:** DBS-84 (hạn mức ngày theo giờ Việt Nam), DBS-85 (ranh giới nửa đêm), DBS-69 (checker bất biến), DBS-173 (số đo «trước»): đều có trên `main` (`5195c751`, #226).
- **Đã có gì:** `SyncGuardService.checkGuards` và `SENT_TODAY_SQL` (`backend/src/modules/ledger/sync-guard.service.ts`); `AccountsService.lockForUpdate` / `applyBalanceChange`; `ledger_entries_daily_debit_idx`; spec `daily-limit`, `midnight-boundary`, `transfer-concurrency`, `money-flow`, `idempotency-rollback`, `customer-transfers`, `resource-ownership`, `invariants`, `sync-guard` (db) và `sync-guard.service.spec.ts` (unit); driver đo `backend/test/manual/bl-418-lock-hold.manual.ts` (mới, §2.1).
- **Baseline (2026-11-21, `origin/main` `5195c751`, Node 24.22.2, Postgres 17 Docker):** `lint:check` sạch; `typecheck` sạch; `npm test` 142 suite / 2.404 test xanh; `test:e2e` 18 suite / 182 test xanh; bốn spec tiền chạy từng cái (`DATABASE_URL` unset, `-i`): `daily-limit` 3/3, `midnight-boundary` 11/11, `transfer-concurrency` 13/13, `sync-guard` 18/18.
- **Thực trạng (kiểm bằng cách chạy code, không đọc suông):** `SENT_TODAY_SQL` chạy trong `checkGuards`, sau `lockForUpdate`, nên nằm trong thời gian giữ khóa (đúng như BL-418). Hai nguồn số đo:

  **(a) AWS, DBS-173** (`pg_stat_statements`, plateau 120 của `baseline`, 21.234 lệnh chuyển, [explain-pgss/s2](../components/load-tests/results/explain-pgss/s2/)): câu lệnh của api chạy trong khóa, ms mỗi lần: `SENT_TODAY_SQL` **1,90** (1.030 buffer), INSERT `transfers` 0,31, INSERT `ledger_entries` 0,27, UPDATE `accounts` 2 × 0,08, UPDATE `idempotency_keys` 0,18, INSERT `outbox_events` 0,09. Cộng ≈ 3,3 ms thời gian câu lệnh trong khóa, **`SUM` chiếm ≈ 58%** (chưa tính COMMIT Multi-AZ, vòng đi về mạng giữa ECS và RDS, và độ trễ event loop của api lúc CPU 63%: ba thứ này chỉ đo được từ phía ứng dụng). Chờ khóa `FOR UPDATE` của api: **22,4 ms** trung bình.

  **(b) Cục bộ, đo từ phía ứng dụng** (driver `bl-418-lock-hold.manual.ts`: HTTP → Nest → `TransactionService` → Postgres thật, 3 tài khoản, mỗi lệnh khóa 2, 60 giây; bảng trước/sau đầy đủ ở §8.1, output thô `screenshots/BL-418/before-*.txt`): ở «trước», `checkGuards` là 0,84 ms (ngày trống, 11% thời gian giữ khóa), 1,37 ms (8.000 dòng) và 4,20 ms (47.000 dòng, **36%**): **tăng tuyến tính theo số dòng trong ngày**. Vì mỗi lệnh khóa 2 trong 3 tài khoản nên tối đa ≈ 1,5 lệnh chạy cùng lúc, khả năng chịu tải ≈ 1,5 / thời gian giữ khóa (≈ 185 lệnh/giây ở 8,1 ms, ≈ 130 ở 11,5 ms): ở 120/s thời gian giữ khóa quyết định hàng đợi (chờ khóa 55 ms rồi 101 ms, và 1.907 lệnh lỗi khi bão hòa). Giới hạn: máy tải cùng tiến trình Node, Postgres cục bộ không có Multi-AZ và RTT; chỉ dùng để so «trước» và «sau» cùng máy.

  **Cái chưa chứng minh:** trên AWS thời gian giữ khóa thật (gồm COMMIT Multi-AZ, RTT, event loop) chưa ai đo; chờ khóa 22 ms ở chỉ 24 lệnh ghi/giây trên 3 tài khoản gợi ý thời gian giữ khóa lớn hơn nhiều so với 3,3 ms câu lệnh, nên `SUM` có thể chỉ là phần nhỏ (ước 10 đến 20%) của thời gian giữ khóa trên AWS. Task này giảm được thời gian giữ khóa đúng bằng `SUM` và một vòng đi về, **không hứa** p95 từng phút < 300 ms trên AWS: số đó chỉ có sau một lượt k6 thật (§8.3: đã đo, chưa đạt trọn).
- **Ngoài phạm vi:** cỡ api/worker/pool (BL-417), đứng hình 2 giây (BL-419), `pg_stat_statements` thành script (BL-420), phần cấu trúc fraud O(cửa sổ 30 ngày) (BL-413: dòng backlog khác, **không** thuộc task này dù bàn giao nhắc tới), đối soát định kỳ của worker (`reconciliation.service.ts`, có SQL, metric và alarm riêng: **BL-421**), nhóm nhiều tài khoản funding.
- **Câu hỏi mở:**
  1. `SUM` có đáng sửa không? Đề xuất: có (bảng (b): tăng tuyến tính, 11% đến 39% thời gian giữ khóa; trên AWS 58% thời gian câu lệnh trong khóa), với điều kiện báo trung thực mức giảm thật.
  2. Hướng A (cột đếm trên `accounts`), B (bảng riêng) hay C (SUM ngoài khóa)? Đề xuất: A với bộ đếm do **trigger trên `ledger_entries`** giữ, xem §3 và G2 (khác bản đề xuất «UPDATE chung câu số dư»: lý do ở §3.1).
  3. Đo trên AWS? Đề xuất: sau khi có PR và image; một phiên chung với DBS-174; nếu không dựng được, báo «chưa đo AWS» (§8), không suy ra số.
- **Quyết định ở G1 (agent tự quyết):** xem cuối tài liệu này, mục «Quyết định ở G1».

### Quyết định ở G1

1. **Chọn sửa, không dừng (agent tự quyết).** Lệnh ghi «Nếu `SUM` không đáng kể thì báo lại hoặc dừng». Bảng (a) và (b) cho thấy nó đáng kể và không bị chặn trên (O(số dòng hôm nay), mỗi lệnh chuyển 1.000đ có thể sinh tới 200.000 dòng/ngày dưới hạn mức 200tr). Phạm vi thu hẹp ở điều kiện đóng: đo + giảm thời gian giữ khóa + giữ AC-5.6; điều kiện «p95 từng phút < 300 ms ở 120 RPS trên AWS» là mục tiêu đo ở §8, không phải thứ code cục bộ chứng minh được.
2. **Mã task.** `BL-418` làm khóa, tiền lệ BL-360-372. Không có dòng board; không đụng board.
3. **BACKLOG liên quan.** Chỉ BL-418 cùng module. BL-413, BL-187, BL-414, BL-417 trong lệnh bàn giao thuộc DBS-173 (fraud, cỡ task): task này không giải quyết BL-413; BL-187 và BL-417 chỉ ghi thêm số đo nếu có phiên AWS.
4. **Quy trình.** Phiên có email `huyasuo1109@gmail.com` khớp techlead nên được miễn quy trình; người yêu cầu **đòi đủ 5 phase và G1..G4**, nên làm đủ. Miễn có dùng: merge PR, push trước G3 (nếu cần), đo AWS không bắt buộc; ghi `Techlead waiver:` ở commit và PR.

## 2. Hành vi

API không đổi: cùng request, cùng response 201/422, cùng `errorCode`, cùng thứ tự lỗi **ACCOUNT_NOT_ACTIVE > LIMIT_PER_TX_EXCEEDED > LIMIT_PER_DAY_EXCEEDED > INSUFFICIENT_FUNDS**. Chỉ cách guard lấy «đã chuyển hôm nay» đổi: từ `SUM` trên `ledger_entries` sang đọc hai cột của dòng `accounts` vừa khóa.

### 2.1 Bộ đếm `accounts.sent_today` / `accounts.sent_day`

| Cột | Ý nghĩa |
|---|---|
| `sent_day` (`date`, NULL) | **Ngày giờ Việt Nam lớn nhất** có dòng `DEBIT` của tài khoản này (theo `ledger_entries.created_at`). NULL: chưa từng có dòng ghi nợ. |
| `sent_today` (`bigint`, mặc định 0) | Tổng `amount` các dòng `DEBIT` của đúng ngày `sent_day`. Tên «today» là ngày `sent_day`; guard chỉ tin nó khi `sent_day` là hôm nay. |

Do **trigger mức câu lệnh** `ledger_entries_daily_debit_counter` giữ (`AFTER INSERT … FOR EACH STATEMENT REFERENCING NEW TABLE AS new_rows`), cùng transaction với dòng sổ cái, nên không thể lệch khi rollback, retry deadlock hay lệnh bị từ chối. Trigger gom các dòng `DEBIT` của câu `INSERT` theo (tài khoản, ngày VN), lấy **ngày lớn nhất** của mỗi tài khoản rồi chạy **một câu `UPDATE` nguyên tử** cho các tài khoản đó (`SET sent_today = CASE WHEN sent_day = d THEN sent_today + tổng ELSE tổng END, sent_day = d … WHERE sent_day IS NULL OR sent_day <= d`: điều kiện `WHERE` loại ca dòng lùi ngày, và cả `SET` lẫn `WHERE` được đánh giá lại trên phiên bản dòng mới nhất khi tranh chấp ở READ COMMITTED), sau khi khóa trước các dòng `accounts` liên quan **theo thứ tự id** (`SELECT … ORDER BY id FOR UPDATE`) để hai câu nạp hàng loạt song song (fixture, seed) không deadlock với nhau, nên hai người ghi không giữ khóa của ứng dụng (fixture, seed) cũng không mất lần cộng nào, và một `INSERT … SELECT` 100.000 dòng chỉ cập nhật dòng `accounts` **một** lần:

| Dòng `DEBIT` mới có ngày `d` (giờ VN của `created_at`; `d` là ngày lớn nhất của tài khoản trong câu lệnh) | Kết quả |
|---|---|
| `sent_day IS NULL` hoặc `sent_day < d` | `sent_day = d`, `sent_today` = tổng các dòng ngày `d` trong câu lệnh (qua nửa đêm: tự đặt lại) |
| `sent_day = d` | `sent_today +=` tổng các dòng ngày `d` trong câu lệnh |
| `sent_day > d` (dòng lùi ngày: chỉ seed hoặc test) | bỏ qua, bộ đếm không lùi |
| dòng ngày nhỏ hơn `d` trong cùng câu lệnh | bỏ qua (bộ đếm chỉ giữ ngày lớn nhất) |
| dòng `CREDIT`, hoặc tài khoản SYSTEM (`funding`) | không động tới |

### 2.2 Guard đọc bộ đếm (`SyncGuardService.checkGuards`)

`today` = ngày giờ Việt Nam của `Clock.now()` (đọc **một lần**, sau khóa, như DBS-84). `sentToday` của tài khoản nguồn:

| Điều kiện trên dòng đã khóa | `sentToday` |
|---|---|
| `sent_day = today` | `sent_today` (O(1)) |
| `sent_day IS NULL` hoặc `sent_day < today` | `0` (đúng: không có dòng nợ nào từ hôm nay trở đi, vì `sent_day` là ngày lớn nhất) |
| `sent_day > today` (đồng hồ ứng dụng chạy chậm hơn DB, hoặc test tiêm đồng hồ lùi) | **`SENT_TODAY_SQL`** như cũ (đường chậm, đúng theo định nghĩa) |

Rồi `BigInt(sentToday) + amount > perDay` → `LIMIT_PER_DAY_EXCEEDED`; sau đó kiểm số dư. Kết quả **giống hệt** `SUM` trong mọi trường hợp (đây là điều TC-418-05 kiểm bằng so sánh ngẫu nhiên). Ví dụ AC-5.6: đã chuyển 180.000.000, `sent_today = 180000000`; hai lệnh 15.000.000 song song: lệnh 1 khóa, thấy 180tr + 15tr ≤ 200tr, commit (`sent_today = 195000000`); lệnh 2 chờ khóa, thấy 195tr + 15tr > 200tr → 422 `{"errorCode":"LIMIT_PER_DAY_EXCEEDED"}`.

### 2.3 Ca biên

| Ca | Kết quả |
|---|---|
| 23:59:59,999 và 00:00:00,000 giờ VN | hai ngày khác nhau; lệnh sau nửa đêm thấy `sent_day < today` → 0 (DBS-85 giữ nguyên) |
| Lệnh `REJECTED` (mọi lý do) | không có dòng sổ cái, bộ đếm không đổi |
| Deadlock rồi `TransactionService` chạy lại callback | rollback hoàn tác cả bộ đếm; lần chạy lại cộng đúng một lần |
| Số tiền > 2^53 (ví dụ `9007199254740993`) | `bigint` ↔ chuỗi; đọc bằng `::text`, so bằng `BigInt`; đọc lại đúng từng chữ số |
| Tổng ngày vượt 2^63−1 | chỉ xảy ra khi seed hoặc ghi sổ ngoài guard (guard giữ tổng ≤ `perDay` ở mức cấu hình). Khi xảy ra, `UPDATE` của trigger ném `22003` làm hỏng chính câu `INSERT ledger_entries` (lỗi này không được ánh xạ như `AccountBalanceOverflowError`, nên client nhận **HTTP 500**): transaction rollback, không có tiền nào di chuyển (an toàn; không tương đương `SUM` kiểu `numeric` ở cận này; chấp nhận) |
| Backfill khi migrate | `sent_day`/`sent_today` tính từ `ledger_entries` hiện có, trong cùng transaction với khóa `ACCESS EXCLUSIVE` của `accounts` (§3.2) |
| Bộ đếm bị sửa tay hoặc trigger bị tắt (`session_replication_role = replica`) | kiểm 6 `daily_debit_totals` của checker DBS-69 báo `FAIL` khi chạy `check:invariants`. **Ở production chưa có gì tự phát hiện** cho tới khi job đối soát có kiểm này: BL-421 (§8) |
| `dbs_api` tự `UPDATE accounts SET sent_today = 0` | `42501` (quyền `UPDATE` chỉ theo cột `balance, status, updated_at`); chỉ trigger `SECURITY DEFINER` ghi được khi `UPDATE` |
| `dbs_api` `INSERT INTO accounts(..., sent_day) ` với giá trị tùy ý | **được** (quyền `INSERT` cấp bảng phủ cột mới). Ví dụ `sent_day = '9999-12-31'` làm trigger bỏ qua mãi và guard luôn đi đường lùi `SUM` (chậm, không đếm thiếu); kiểm 6 báo `FAIL`. Rủi ro chấp nhận ở task này (kẻ có `dbs_api` đã `INSERT` được sổ cái); thu hẹp quyền `INSERT` theo cột là BL-422 (§8) |

## 3. Kiến trúc

- **Vị trí:** `api` (và bất kỳ ai ghi dòng `DEBIT`). Module `ledger` (guard) và `accounts` (schema, `lockForUpdate`). **Gate phụ (schema của module `accounts`):** quyết định ở §3.1 và §8.
- **Dữ liệu:** migration `1795000012000-AddDailyDebitCounter` (§3.2): `ALTER TABLE accounts ADD sent_today bigint NOT NULL DEFAULT 0, ADD sent_day date`, ràng buộc `accounts_sent_today_non_negative CHECK (sent_today >= 0)` và `accounts_sent_day_when_sent CHECK (sent_day IS NOT NULL OR sent_today = 0)`; hàm `public.add_daily_debit()` (`SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`, `REVOKE ALL ON FUNCTION … FROM PUBLIC` như các hàm `SECURITY DEFINER` đã có); trigger mức câu lệnh; backfill. Không index cột mới: các cập nhật `accounts` vẫn là HOT (`fillfactor 80`, database-design §6.2 và §9).
- **Ngoại lệ so với quy tắc «chỉ `AccountsService` ghi `accounts`» (database-design §3, accounts README):** bộ đếm là dữ liệu **dẫn xuất** từ `ledger_entries` do trigger của DB ghi, không phải mã ứng dụng. Số dư vẫn chỉ đổi qua `applyBalanceChange`. Quyết định và tài liệu phải sửa cùng PR ở §3.3.
- **Interface:** `LockedAccount` thêm `sentToday: string`, `sentDay: string | null` (`lockForUpdate` chọn thêm `a.sent_today::text`, `to_char(a.sent_day,'YYYY-MM-DD')`; `getOwnedAccount` và DTO **không** có hai trường, để không lộ ra API). `checkGuards(manager, lockedFrom, lockedTo, amount)` giữ nguyên chữ ký; người gọi: `transfer.service.ts` và các spec (grep: `deposit.service` chỉ dùng `lockForUpdate`). `SENT_TODAY_SQL` giữ làm đường lùi và cho test. Hàm `vietnamDay(now: Date): string` (định dạng ngày bằng `Intl`, múi giờ `Asia/Ho_Chi_Minh`, không `new Date(` trong `sync-guard.service.ts` vì TC-85-05).
- **Ranh giới transaction:** không đổi, một `TransactionService.run`; không Redis/HTTP/SQS. Thứ tự: key → khóa 2 tài khoản → guard (**không còn câu SQL nào**) → insert transfer → insert 2 dòng sổ cái (trigger cộng bộ đếm) → cập nhật số dư → audit → outbox → lưu kết quả.
- **Kiểm đối chiếu:** `invariants.sql` thêm kiểm 6 `daily_debit_totals`: với mọi tài khoản không phải SYSTEM, `(sent_day, sent_today)` phải bằng (ngày VN lớn nhất của dòng `DEBIT`, tổng của ngày đó); `invariants.ts` thêm tên kiểm; README mục 9 cập nhật.

```mermaid
sequenceDiagram
    participant S as TransferService
    participant G as SyncGuardService
    participant DB as PostgreSQL
    S->>DB: SELECT ... FOR UPDATE 2 tài khoản (đã kèm sent_today, sent_day)
    S->>G: checkGuards(manager, source, target, amount)
    Note over G: today = vietnamDay(Clock.now()); không truy vấn nào
    G-->>S: null hoặc lý do
    S->>DB: INSERT ledger_entries (DEBIT, CREDIT)
    Note over DB: trigger: UPDATE accounts SET sent_today, sent_day (dòng đã khóa)
    S->>DB: UPDATE accounts SET balance (HOT)
```

### 3.1 Lựa chọn hướng sửa (gate phụ, agent tự quyết)

| Hướng | Ưu | Nhược | Kết luận |
|---|---|---|---|
| A1 cột đếm, **ứng dụng** cộng trong câu `UPDATE` số dư | một UPDATE | **triển khai cuốn chiếu**: task api cũ (chưa biết cột) vẫn ghi dòng `DEBIT` mà không cộng, bộ đếm thiếu và **vượt hạn mức ngày được trong lúc triển khai**; phải `GRANT UPDATE` cột mới cho `dbs_api` (đổi `db-roles.sql`), app có thể sửa bộ đếm | bỏ |
| **A2 cột đếm, trigger** trên `ledger_entries` (chọn) | đúng với mọi phiên bản code ghi sổ; không đổi quyền, app không ghi được; backfill + trigger cùng một transaction; không thêm vòng đi về | thêm một lần cập nhật cùng dòng (HOT, cùng trang) mỗi lệnh chuyển; logic nằm trong DB (có test và kiểm bất biến) | **chọn** |
| B bảng `account_daily_debits` | tách khỏi `accounts` | thêm bảng, migration, GRANT, thêm UPSERT trên đường nóng | bỏ |
| C `SUM` ngoài khóa rồi kiểm lại | không đổi schema | vẫn có `SUM` trong khóa khi kiểm lại, dễ vỡ AC-5.6 | bỏ |

Rủi ro đã tính: (1) hai lần cập nhật dòng `accounts` mỗi lệnh ghi nợ (trigger rồi `applyBalanceChange`): đo `n_tup_hot_upd` trước/sau ở §8; (2) trigger **mức câu lệnh** (không phải từng dòng) để một `INSERT … SELECT` hàng trăm nghìn dòng của fixture chỉ cập nhật `accounts` một lần, không kéo dài chuỗi phiên bản dòng trong một transaction: đo thời gian `daily-limit` TC-84-01 trước/sau ở §8; (3) khóa migration: §3.2.

### 3.2 Migration: thứ tự, khóa, backfill

Thứ tự câu lệnh (trong một transaction của migration, `transaction: 'all'`): `SET LOCAL lock_timeout = '5s'` (như các migration trước) → `ALTER TABLE accounts ADD …` + hai CHECK (lấy `ACCESS EXCLUSIVE` trên `accounts`: chờ mọi lệnh chuyển/nạp đang chạy xong vì chúng giữ khóa dòng `accounts`; trong lúc chờ, lệnh mới xếp hàng sau) → tạo hàm → `CREATE TRIGGER` (đã giữ `accounts` nên không còn người ghi sổ nào đang dở; ngược thứ tự này một lệnh đang giữ khóa dòng `accounts` và chờ `INSERT ledger_entries` sẽ deadlock với migration, và backfill trước khi giữ `accounts` sẽ bỏ sót dòng của giao dịch dở) → backfill (`DISTINCT ON (account_id)` lấy ngày VN lớn nhất, rồi tổng ngày đó; chỉ tài khoản không phải SYSTEM). **Trong suốt thời gian giữ `ACCESS EXCLUSIVE`, mọi `lockForUpdate` và `getOwnedAccount` (ngoài transaction, không có `lock_timeout`) bị chặn:** thời gian này được đo ở §8 (M-418-05, trên sổ cái cỡ lớn) và migration chạy như bước pipeline riêng trước khi đổi task api (§7 rủi ro). `lock_timeout = 5s` chỉ giới hạn **thời gian chờ lấy khóa**, không giới hạn thời gian giữ khóa lúc backfill. Trong tối đa 5 giây chờ, mọi lệnh khóa `accounts` mới xếp hàng sau yêu cầu `ACCESS EXCLUSIVE`: lệnh chuyển/nạp hết `lock_timeout` 2 giây của ứng dụng và trả **503**, `getOwnedAccount` chờ trọn 5 giây. Migration hết giờ chờ thì thất bại (không có gì đổi): `migrate.sh` không tự thử lại, job deploy dừng và api giữ bản cũ; người chạy lại job bằng tay. Job đối soát chạy mỗi 300 giây và có thể giữ `ACCESS SHARE` trên `accounts` tới 60 giây (`statement_timeout`), nên chạy lại tránh lúc job đối soát đang chạy.

### 3.3 Tài liệu nguồn phải sửa cùng PR

ADR-04 (thêm addendum: hạn mức ngày đọc bộ đếm trên hàng đã khóa; `SUM` chỉ là đường lùi; lý do «phương án B không bảo vệ được truy vấn này» cần đọc lại), database-design §3 (ngoại lệ trigger), §4.2 (hai cột), §5 và §6.1 (dòng hạn mức ngày), §9 (số lần `UPDATE accounts`, sync guard không còn index-only scan trên đường thường), `query-plans.md` (dòng hạn mức ngày), `modules/accounts/README.md` («Phải giữ»), `modules/ledger/README.md`, backend README §9 (kiểm thứ 6), docs/03 §6.1 (bảng quy tắc dòng sync guard) và `docs/features/README.md`.

## 4. Test cases tự động

DoD: **D1** đo thời gian giữ khóa, **D2** giảm thời gian giữ khóa, **D3** giữ AC-5.6 và NFR-COR-03, **D4** `baseline` 120 RPS p95 từng phút < 300 ms (đo AWS, §8).

| ID | Truy vết | Lớp | Given · When · Then | `errorCode` |
|---|---|---|---|---|
| TC-418-01 | D2 | db (schema) | migration thêm `sent_today bigint NOT NULL DEFAULT 0` và `sent_day date`, hai CHECK có tên; hàm `add_daily_debit` có `prosecdef`, `proconfig` chứa `search_path`, EXECUTE không cấp cho PUBLIC; trigger mức câu lệnh có `REFERENCING NEW TABLE`; `migration:revert` bỏ hết, `run` lại được | `23514` + tên ràng buộc |
| TC-418-02 | D3, D2 | db (trigger) | cùng ngày cộng dồn; sang ngày VN mới đặt lại; dòng lùi ngày không làm bộ đếm lùi; `CREDIT` và tài khoản SYSTEM không đếm; một câu `INSERT … SELECT` nhiều dòng nhiều ngày của một tài khoản cho đúng (ngày lớn nhất, tổng của ngày đó) và chỉ **một** lần cập nhật dòng `accounts`; hai `INSERT` DEBIT song song cùng tài khoản **không giữ khóa trước** (không `FOR UPDATE`): bộ đếm = `SUM`; số `9007199254740993` đọc lại đúng từng chữ số | — |
| TC-418-03 | D3 | db (migration) | DB có sổ cái thật (nhiều ngày, nhiều tài khoản), `migrateThrough` bản trước rồi `run`: `(sent_day, sent_today)` = (ngày VN lớn nhất, tổng ngày đó) của từng tài khoản | — |
| TC-418-04 | D2 | db + unit | đường thường (`sent_day = today`, `< today`, NULL) **không chạy** câu SQL nào trên `ledger_entries` (đếm `manager.query`); `sent_day > today` mới chạy `SENT_TODAY_SQL` | — |
| TC-418-05 | D3 | db (tương đương) | chuỗi ngẫu nhiên có seed cố định: dòng ghi nợ nhiều ngày (cả lùi và tương lai), hỏi guard tại nhiều đồng hồ (trước/sau nửa đêm VN): phán quyết bằng bộ đếm = phán quyết bằng `SENT_TODAY_SQL` ở mọi điểm | `LIMIT_PER_DAY_EXCEEDED` |
| TC-418-06 | D3 | unit | thứ tự lỗi giữ nguyên với bộ đếm: `ACCOUNT_NOT_ACTIVE` > `LIMIT_PER_TX` > `LIMIT_PER_DAY` > `INSUFFICIENT_FUNDS` (mỗi cặp một case), và ngày đúng sau 00:00 VN | từng mã |
| TC-418-07 | D3 | e2e db | lệnh `REJECTED` (3 lý do) không đổi bộ đếm; bộ đếm = `SUM` sau mỗi lệnh | 3 mã |
| TC-418-08 | D3 | db (deadlock) | trigger lỗi `40P01` một lần ở `BEFORE INSERT` trên `outbox_events` (chạy **sau** khi dòng sổ cái và bộ đếm đã ghi, khác trigger `dbs80_fault` của `transfer-concurrency` chạy trước khi có dòng sổ nào): lần chạy đầu tạo rồi **rollback** cả dòng sổ cái lẫn bộ đếm; `TransactionService` chạy lại; bộ đếm cộng đúng một lần, bằng `SUM`, invariants PASS | — |
| TC-418-09 | D3 (AC-5.6, NFR-COR-03) | db (song song) | 40 lệnh song song từ 3 tài khoản, mỗi lệnh 15tr, hạn mức ngày 200tr: tổng ngày ≤ 200tr, bộ đếm = `SUM`, số `COMPLETED` đúng bằng ⌊(200tr − đã chuyển) / 15tr⌋ | `LIMIT_PER_DAY_EXCEEDED` |
| TC-418-10 | D3 | db (kiểm) | `checkLedgerInvariants` PASS khi đúng; sửa tay bộ đếm (cột `sent_today`, rồi `sent_day`), hoặc xóa bộ đếm: `FAIL`, violation `daily_debit_totals` có `accountId`; rollback khôi phục | — |
| TC-418-11 | D3 | db (quyền) | `dbs_api` thật `UPDATE accounts SET sent_today = 0` → `42501`; vẫn `UPDATE balance` được; `INSERT ledger_entries` vẫn cộng bộ đếm qua trigger; `dbs_api` `INSERT INTO accounts(…, sent_day)` với ngày tùy ý **được** (ghi lại hành vi đã chấp nhận, §2.3) và kiểm 6 báo `FAIL` | `42501` |
| TC-418-12 | D3 | db (có sẵn, giữ xanh) | `daily-limit` (TC-84-01 đổi chỗ khẳng định plan: vẫn khẳng định plan của `SENT_TODAY_SQL`, đường lùi), `midnight-boundary` (DBS-85), `transfer-concurrency` (AC-5.6, 13 test), `money-flow`, `idempotency-rollback`, `customer-transfers`, `resource-ownership`, `invariants`, `sync-guard` | giữ nguyên |
| TC-418-15 | D3 (an toàn triển khai) | db (migration) | **(a)** một transaction giữ khóa dòng `accounts` (lệnh chuyển dở) không bao giờ commit: `migrateThrough` bản trước rồi chạy migration mới thất bại trong ≈ 5 giây với `55P03`, không cột nào được thêm; giải phóng khóa rồi chạy lại: thành công, bộ đếm = `SUM`. **(b)** blocker mở transaction bằng `runner.startTransaction()`, `SELECT … FOR UPDATE` dòng `accounts`, `migrate()` chạy nền (không `await`); **poll `pg_locks` tới khi thấy yêu cầu `AccessExclusiveLock` trên `accounts` có `granted = false`** (để chắc `ALTER` đang chờ), rồi blocker ghi `transfers` + hai dòng sổ cái bằng `postInvariantTransfer` (không tự mở transaction; **không** qua app vì `lockForUpdate` mới chọn cột chưa có; không dùng `postBackdatedTransfer` vì nó tự commit) và commit trong < 5 giây: migration thành công, không `40P01`, bộ đếm của blocker = `SUM` (không bỏ sót dòng của giao dịch dở), invariants PASS | `55P03` |
| TC-418-16 | D2 | db (thời gian) | `daily-limit` TC-84-01 (nạp 100.000 dòng DEBIT trong một transaction) vẫn trong timeout, đo thời gian trước/sau (§8) | — |
| TC-418-13 | D1, D2 | thủ công đo | driver `bl-418-lock-hold.manual.ts` «sau»: thời gian giữ khóa và `checkGuards` giảm, bảng so §8 | — |
| TC-418-14 | D4 | quy trình / đo AWS | một lượt k6 `baseline` trên AWS, p95 từng phút (§8: chạy hoặc ghi chưa chạy) | — |

Bảo mật (`references/testing.md`): quyền (TC-418-11); SQL tham số hóa (trigger không nhận chuỗi từ người dùng, guard truyền id làm tham số); số tiền lớn (TC-418-02/04, `bigint`); sở hữu và 404, audit `DENIED`, không lộ cờ fraud: không đổi (TC-418-12).

## 5. Test thủ công

Điều kiện (từ `backend/`, Git Bash, Node 24): Postgres 17 (`docker run -d --name bl418-pg -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=banking -p 55418:5432 postgres:17`) và Valkey (`docker run -d --name bl418-valkey -p 56379:6379 valkey/valkey:8-alpine`); `REDIS_URL` là biến bắt buộc. Biến môi trường đặt qua shell: `DATABASE_URL=postgres://test:test@localhost:55418/banking`, `REDIS_URL=redis://localhost:56379`, `RATE_LIMIT_TRANSFERS_PER_MINUTE=100` (mặc định 10 lệnh/phút/khách sẽ chặn M-418-03), `AUTH_MODE=local`, `AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json`, bỏ các biến `COGNITO_*`, `SQS_*` trỏ ElasticMQ của compose (hoặc `APP_ROLE=api`, không cần worker). Lần đầu `npm run auth:dev-keys`. Chạy `npm run migration:run` rồi `npm run start:dev:api`. Token: `npm run --silent auth:dev-token -- --role operator --sub nhan-vien-quay` và `-- --role customer --sub nguyen-van-an` (khách A), `--sub tran-thi-binh` (khách B), `--sub le-van-cuong` (khách C). Tạo khách và tài khoản: `POST /v1/customers/me` rồi `POST /v1/accounts` (mỗi khách một tài khoản); nạp tiền: `POST /v1/operator/deposits` (operator). Mọi bước ghi lệnh thật và đầu ra vào `manual-test.txt`; lệnh nào không chạy được đúng như viết thì sửa doc ở §8, không bỏ qua.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-418-01 | `migration:run`, `migration:revert`, `migration:run` trên DB trống; `\d accounts`, `\d ledger_entries` | thêm, bỏ, thêm lại sạch; hai cột, hai CHECK, trigger `ledger_entries_daily_debit_counter` |
| M-418-02 | Đường thành công: nạp 500.000.000 cho A (operator), A chuyển 30.000.000 cho B (`curl` + `Idempotency-Key`), rồi 20.000.000; `psql`: `sent_today`, `sent_day` của A và `SUM` sổ cái | 201, 201; `sent_today = 50000000` = `SUM`; B và funding có `sent_today = 0` |
| M-418-03 | Biên (AC-5.6): chuyển thêm cho tới khi A đã chuyển 180.000.000; hai `curl` 15.000.000 song song | đúng một 201, một 422 `LIMIT_PER_DAY_EXCEEDED`; `sent_today = 195000000` |
| M-418-04a | Sau M-418-03 (A đã chuyển 195tr): A chuyển 60.000.000 (> 50tr/lần) | 422 `LIMIT_PER_TX_EXCEEDED`; `sent_today` vẫn 195.000.000 |
| M-418-04b | A chuyển 10.000.000 (195tr + 10tr > 200tr, số dư A còn đủ) | 422 `LIMIT_PER_DAY_EXCEEDED`; `sent_today` vẫn 195.000.000 |
| M-418-04c | Khách C có 10.000.000, chuyển 20.000.000 | 422 `INSUFFICIENT_FUNDS`; `sent_today` của C vẫn 0 |
| M-418-04d | Gửi lại đúng `Idempotency-Key` của lệnh M-418-02 đầu tiên | cùng 201 và cùng `transferId` như lần đầu; `sent_today` của A không đổi |
| M-418-05 | Backfill thật trên DB chính: **dừng api**, `migration:revert` (bỏ cột), `migration:run`, bật lại api; `psql` so `sent_today` với `SUM` của từng tài khoản. Cỡ lớn trên **DB thứ hai** (không chạy M-418-06 ở đó vì seed chỉ có vế Nợ): seed SQL ≈ 1.000.000 dòng DEBIT của 500 tài khoản trải 2 năm (kiểu `loadDailyDebitLedger`), `revert`, `run`, ghi thời gian migration (= thời gian `accounts` bị khóa) | bằng nhau; thời gian migration ghi lại ở hai cỡ dữ liệu |
| M-418-06 | `npm run --silent check:invariants` (PASS, thoát 0); rồi superuser `UPDATE accounts SET sent_today = 1` cho A, chạy lại | PASS; FAIL thoát 1 kèm `daily_debit_totals`; khôi phục |
| M-418-07 | Driver đo «sau»: `bl-418-lock-hold.manual.ts` đúng 5 cấu hình của §1 | bảng trước/sau: thời gian giữ khóa và `checkGuards` giảm; không còn tăng theo số dòng; không lệnh lỗi mới |
| M-418-08 | `pg_stat_user_tables` của `accounts`: `n_tup_upd`, `n_tup_hot_upd` sau 1.440 lệnh, trước và sau | tỉ lệ HOT không tụt đáng kể (ghi số) |

## 6. Domain review (AI)

**Reviewer:** subagent, model `opus` (effort high), 2026-11-21 · **Kết quả:** lượt 1: 11 phát hiện (blocking 0, should-fix 7, minor 4), REVISE · lượt 2: 7 phát hiện (0, 3, 4), REVISE · lượt 3 (chỉ các mục đã đổi): 2 minor, **APPROVE** · [lượt 1](screenshots/BL-418/domain-review.md), [lượt 2](screenshots/BL-418/domain-review-r2.md), [lượt 3](screenshots/BL-418/domain-review-r3.md) (nguyên văn) (các ký tự `<` `>` trong bảng đã giải mã từ thực thể HTML của thông báo).

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | Thứ tự khóa và `lock_timeout` của migration; `ACCESS EXCLUSIVE` trên `accounts` chặn cả API | đã sửa: §3.2 chốt thứ tự (`lock_timeout` → ALTER → hàm → trigger → backfill), nêu rõ API bị chặn, đo ở M-418-05; thêm TC-418-15 |
| 2 | should-fix | Chỉ checker CLI bắt bộ đếm lệch; job đối soát định kỳ không có kiểm này | không sửa trong task: job đối soát có SQL, kiểu, metric và alarm riêng (Terraform), vượt phạm vi một task tối ưu. Ghi rõ ở §2.3 («ở production chưa có gì tự phát hiện») và dòng BACKLOG **BL-421** (§8) |
| 3 | should-fix | Trigger từng dòng làm fixture 100.000 dòng thành 100.000 lần UPDATE | đã sửa: trigger mức câu lệnh có bảng chuyển tiếp (§2.1), TC-418-02 và TC-418-16 |
| 4 | should-fix | Test deadlock dùng trigger chạy trước dòng sổ cái, không chứng minh rollback bộ đếm | đã sửa: TC-418-08 dùng lỗi sau khi dòng sổ cái và bộ đếm đã ghi |
| 5 | should-fix | M-418-04 không quan sát được `LIMIT_PER_DAY`/`INSUFFICIENT_FUNDS` | đã sửa: tách M-418-04a..d với số liệu cụ thể |
| 6 | should-fix | §5 không chạy được (Redis, khóa dev, token, onboarding) | đã sửa: điều kiện chạy ghi đủ lệnh; lệnh nào lệch khi chạy thật thì sửa ở §8 |
| 7 | should-fix | Ngoại lệ quy tắc ghi `accounts`; ADR-04, database-design §3/§5/§6.1/§9 sẽ sai | đã sửa: §3 (ngoại lệ) và §3.3 (danh sách tài liệu sửa cùng PR) |
| 8 | minor | `dbs_api` có `INSERT` cấp bảng trên `accounts`, phủ cột mới | chấp nhận: §2.3 và TC-418-11 ghi hành vi; thu hẹp quyền là BL-422 (§8, việc của Platform & Ops: `db-roles.sql`) |
| 9 | minor | `bigint` có thể tràn ở 2^63−1, chưa có case 2^53 | đã sửa: §2.3 định nghĩa hành vi (rollback an toàn, chấp nhận), TC-418-02 thêm `9007199254740993` |
| 10 | minor | thiếu `REVOKE ... FROM PUBLIC` cho hàm `SECURITY DEFINER` | đã sửa: §3 Dữ liệu, TC-418-01 |
| 11 | minor | trigger phải là một câu `UPDATE` nguyên tử; thiếu test hai người ghi song song | đã sửa: §2.1, TC-418-02 |

Lượt 2 và 3, đã xử lý: UPDATE thiếu `WHERE sent_day <= d` (sửa §2.1; TC-418-02 bắt lỗi này), TC-418-15 chưa kiểm ca giao dịch dở (thêm biến thể (b), poll `pg_locks`), BL-421/BL-422 chưa tồn tại (đã thêm vào BACKLOG), lời hứa «thất bại an toàn» nói quá (sửa §3.2), khóa trước theo id (sửa §2.1), M-418-05 dùng DB thứ hai (sửa §5), câu tràn số (sửa §2.3), `migrate.sh` không tự thử lại (sửa §3.2).

**Quyết định ở G2 (agent tự quyết):** xem «Quyết định ở G2» ở cuối tài liệu.

### Quyết định ở G2

1. **Hướng A2 (cột đếm + trigger mức câu lệnh), không phải A1/B/C (agent tự quyết).** Lý do ở §3.1: đúng với mọi phiên bản code ghi sổ (triển khai cuốn chiếu), không đổi quyền `dbs_api`, ứng dụng không tự ghi được bộ đếm, không thêm vòng đi về. Bỏ A1 vì task api cũ có thể làm bộ đếm đếm thiếu và vượt hạn mức ngày trong lúc triển khai.
2. **Đường lùi `SENT_TODAY_SQL` giữ lại (agent tự quyết).** Khi `sent_day > today` guard dùng `SUM` như cũ: kết quả giống hệt bản cũ ở mọi ca, nên các test DBS-84/85 không đổi ý nghĩa; TC-84-01 vẫn khẳng định plan của câu SQL này.
3. **Đối soát định kỳ (finding #2) chuyển BL-421, quyền `INSERT` cấp bảng (finding #8) chuyển BL-422 (agent tự quyết).** Reviewer lượt 2 xác nhận để ngoài task là chấp nhận được, với điều kiện hai dòng BACKLOG tồn tại: đã thêm, `check-backlog.mjs` sạch (108 dòng, 0 lỗi).
4. **Gate phụ (schema module `accounts`, ngoại lệ quy tắc ghi `accounts`):** quyết định (1) là quyết định gate phụ; hệ quả và tài liệu phải sửa ở §3.3. Không đổi ADR nào ngoài addendum ADR-04, không đổi `ErrorCode`, env var hay hợp đồng sự kiện.
5. **Lượt review thứ hai (agent tự quyết).** Verdict lượt 1 và 2 đều REVISE (0 blocking); các phát hiện lượt 2 đã sửa, nên chạy lượt 3 trên các mục đã đổi trước khi qua G2 ([lượt 1](screenshots/BL-418/domain-review.md), [lượt 2](screenshots/BL-418/domain-review-r2.md)).

## 7. Kế hoạch triển khai

Thứ tự migration → service → kiểm đối chiếu → test hành vi → tài liệu và đo. Mọi lệnh test db chạy từng spec: `cd backend && unset DATABASE_URL && npx jest --config ./test/jest-db.js -i test/db/<spec>.db-spec.ts` (Node 24 trong `PATH`).

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `src/database/migrations/1795000012000-AddDailyDebitCounter.ts` (mới): `lock_timeout`, `ALTER accounts`, hàm `add_daily_debit` (`SECURITY DEFINER`, `search_path`, `REVOKE … FROM PUBLIC`), trigger mức câu lệnh, backfill, `down` | `test/db/daily-debit-counter.db-spec.ts` (mới): TC-418-01, 02, 03, 15 (a)(b) | _điền_ | `daily-debit-counter` rồi `migration-run-twice`, `migration-revert`, `ledger-schema`, `accounts-schema` | `feat(ledger): cột đếm hạn mức ngày và trigger trên sổ cái (BL-418)` |
| 2 | `src/modules/accounts/account.types.ts` (`LockedAccount` thêm `sentToday`, `sentDay`), `accounts.service.ts` (`lockForUpdate` chọn `sent_today::text`, `to_char(sent_day)`), `src/modules/ledger/sync-guard.service.ts` (`vietnamDay`, đọc bộ đếm, đường lùi `SENT_TODAY_SQL`), `sync-guard.service.spec.ts` (helper `account()`) | TC-418-04, 05, 06 trong `daily-debit-counter.db-spec.ts` và `sync-guard.service.spec.ts` | _điền_ | `daily-debit-counter`, `sync-guard.service.spec`, `sync-guard`, `daily-limit`, `midnight-boundary`, `accounts-service` (db) | `perf(ledger): hạn mức ngày đọc bộ đếm trên hàng đã khóa, bỏ SUM khỏi khóa (BL-418)` |
| 3 | `src/scripts/invariants/invariants.sql` (kiểm 6), `invariants.ts` (tên kiểm), `backend/README.md` mục 9 | TC-418-10 trong `test/db/invariants.db-spec.ts` | _điền_ | `invariants`, `ledger-invariants-helper`, `reconciliation-intentional-mismatch` | `feat(ledger): kiểm bất biến daily_debit_totals (BL-418)` |
| 4 | test hành vi, không code mới: `test/db/daily-debit-counter-flow.db-spec.ts` (mới) | TC-418-07, 08, 09, 11 | khóa hành vi nên xanh ngay; **kiểm bằng đột biến**: tắt trigger hoặc bỏ `WHERE sent_day <= d` thì từng test phải đỏ (ghi lại) | `daily-debit-counter-flow`, rồi cả danh sách TC-418-12 từng spec một | `test(ledger): bộ đếm hạn mức ngày dưới tải song song, deadlock, từ chối (BL-418)` |
| 5 | `test/db/daily-limit.db-spec.ts` (TC-84-01 ghi chú «đường lùi»), `test/support/daily-debit-fixture.ts` nếu cần | TC-418-16 (thời gian TC-84-01 trước/sau) | không áp dụng (đo) | `daily-limit` | `test(ledger): TC-84-01 là đường lùi của hạn mức ngày (BL-418)` |
| 6 | Tài liệu (§3.3): ADR-04 addendum, `database-design.md` §3, §4.2, §5, §6.1, §9, `query-plans.md`, `modules/accounts/README.md`, `modules/ledger/README.md`, docs/03 §6.1, `docs/features/README.md`, `docs/BACKLOG.md` (xóa BL-418; thêm BL-421, BL-422 đã có) | `check-doc-links.mjs`, `check-backlog.mjs` | không áp dụng | hai script | `docs(ledger): bộ đếm hạn mức ngày (BL-418)` |
| 7 | Đo và test thủ công: `test/manual/bl-418-lock-hold.manual.ts` (đã viết ở Phase 1), `docs/features/screenshots/BL-418/` (`manual-test.txt`, `after-*.txt`, ảnh), feature doc §8 | M-418-01..08 | không áp dụng | chạy §5 trên commit cuối đổi code | `docs(ledger): kết quả đo và test thủ công BL-418` |
| 8 | Đo AWS (điều kiện đóng D4): chỉ khi người yêu cầu duyệt chi phí và phiên (cùng phiên DBS-174); nếu không, ghi «chưa đo AWS» ở §8 | — | — | `infra/terraform/README.md` mục «Máy chạy tải và đợt đo k6 (DBS-166)» | — |

**Quét kế hoạch (tài liệu và DoD).** Điều kiện đóng: D1 (bước 7: driver «sau» và bảng trước/sau), D2 (bước 2), D3 (bước 1 đến 5), D4 (bước 8, nếu không chạy được thì BACKLOG và §8 nói thẳng). Giới hạn trong tài liệu: TC-85-05 cấm `new Date(`, `Date.now()`, `clock_timestamp` trong `sync-guard.service.ts`, `vietnamDay` dùng `Intl` nên giữ nguyên; TC-82-07 đòi mọi `checkGuards(` có `await`; TC-82-08 cấm hằng số hạn mức trong module ledger; TC-84-04 đòi đọc `Clock` đúng một lần và sau khóa. Mọi người gọi `lockForUpdate`: `transfer.service`, `deposit.service` (đọc thêm hai trường, không dùng; `operator-account-status.service` có SQL khóa riêng, không đổi), các spec `accounts-service`, `sync-guard`, `daily-limit`, `midnight-boundary`, `accounts-service-probe`, `accounts-service.manual`. Mỗi bước có file, test trước, lệnh và commit.

**Rủi ro và cách lùi.**
- Khóa migration (§3.2): chạy ngoài giờ cao điểm, dừng nếu `lock_timeout`; đã đo thời gian ở M-418-05.
- Hai lần cập nhật dòng `accounts` mỗi lệnh ghi nợ: đo `n_tup_hot_upd` trước/sau (M-418-08); nếu HOT tụt đáng kể thì dừng và ghi BACKLOG.
- Trigger sai làm đếm thiếu: TC-418-02/05/09/10 và kiểm 6 ở mọi test tiền; đường lùi chỉ đúng khi `sent_day > today`.
- **Cách lùi:** `migration:revert` (bỏ trigger, hàm, cột; bộ đếm là dữ liệu dẫn xuất nên không mất dữ liệu gốc) kèm `git revert` của hai commit code; code cũ không biết bộ đếm nên chạy được ở cả hai trạng thái schema. Triển khai theo hai bước: migration trước, image mới sau (code mới cần cột).

**Quyết định ở G3 (agent tự quyết):**
1. Không đổi `checkGuards`, `TransferService`, `LedgerPostingService`: ngày của dòng nợ do chính trigger lấy từ `created_at`, nên không cần truyền «bây giờ» xuống ghi sổ (giữ TC-84-04 «đọc Clock một lần»).
2. Hai commit code tách nhau (migration và guard) để hoàn tác từng phần được; migration vào `main` trước khi image mới được dùng.
3. Đo AWS (bước 8) không tự chạy: chi phí và dựng phiên cần người duyệt; nếu không có phiên thì báo trung thực «D4 chưa đo» thay vì suy từ số cục bộ. **Cập nhật sau G4:** người yêu cầu duyệt và bước 8 đã chạy thật (§8.3).

## 8. Kết quả

**Tóm lại (trung thực):** thời gian giữ khóa **đã đo và đã giảm** cả cục bộ (§8.1) lẫn **trên AWS thật** (§8.3: chờ khóa 22,4 → 9,8 ms, `SUM` không còn, p95 `baseline` plateau 120 262 → 92 ms), AC-5.6 và NFR-COR-03 giữ nguyên. Điều kiện đóng thứ 4, **p95 chuyển < 300 ms ở TỪNG phút**, **chưa đạt trọn**: 13 trên 15 khung đủ mẫu dưới 300 ms (trước 11 trên 16), 2 khung vượt (442 và 377 ms) do đuôi 1 đến 2 giây **chưa giải thích được** (không đến từ `SUM`; cùng dạng BL-419). `baseline` plateau 120 còn 9 lỗi timeout trong một phút và 1 dropped iteration, nên `meetsDoD3` sai (trước đạt). Báo cáo: [04](../components/load-tests/04-ket-qua-bl-418-2026-11-22.md).

- **Lệnh kiểm tra** (HEAD `d343484b`, Node 24.22.2; output ở [final-checks.txt](screenshots/BL-418/final-checks.txt)): `npm run lint:check` thoát 0; `npm run typecheck` thoát 0; `npm test` **142 suite / 2.410 test** xanh (baseline 2.404, thêm 6); `npm run test:e2e` **18 suite / 182 test** xanh ở lượt song song cuối (84 s, như CI chạy) và ở lượt `-i`. Hai lượt song song đầu có 1 đến 3 test đỏ `spawnSync ETIMEDOUT` ở các suite sinh tiến trình con (`fraud-ai-cli`, `dev-auth-bootstrap`) khi máy chỉ còn ≈ 1,3 GB RAM; từng suite chạy riêng xanh (7/7 và 4/4, `fraud-ai-cli` cũng xanh ở checkout không có BL-418). Spec db ([db-specs-final.txt](screenshots/BL-418/db-specs-final.txt), từng spec một, `DATABASE_URL` unset, `-i`): `daily-debit-counter` 8, `daily-debit-guard` 3, `daily-debit-counter-flow` 3, `daily-debit-counter-roles` 6, `invariants` 60 (57 cũ + 3), `transfer-concurrency` 13, `midnight-boundary` 11, `money-flow` 8, `customer-transfers` 37, `daily-limit` 3, `sync-guard` 18, `idempotency-rollback` 4, `resource-ownership` 35, `accounts-service` 45, `rejected-transfers` 7; cộng đợt trước đó `account-opening` 11, `account-reads` 10, `accounts-schema` 15, `audit.service` 13, `operator-deposits` 18, `operator-account-status` 12, `operator-account-search` 20, `seed` 3, `seed-rerun` 3, `transaction-history` 9, `migration-run-twice` 2, `migration-revert` 3, `ledger-schema` 32, `db-role-permissions` 13, `db-roles` 12, `ledger-invariants-helper` 2, `reconciliation-intentional-mismatch` 4, `reconciliation-job` 9. Đợt quét đầu bị hệ thống dừng giữa chừng vì RAM ([db-specs-sweep.txt](screenshots/BL-418/db-specs-sweep.txt)); 15 spec còn lại chạy ở lượt sau, tất cả xanh ([db-specs-sweep-2.txt](screenshots/BL-418/db-specs-sweep-2.txt)): `transaction-history-plan` 3, `transfer-status` 6, `transfers-autovacuum` 3, `outbox-writer` 34, `openapi-completeness` 8, `openapi-export` 1, `denied-load` 1, `dedup-cleanup` 11, `notification-consumer` 15, `risk-decisions` 14, `reconciliation-schema` 98, `migration-owner-role` 4, `append-only` 25, `customer-onboarding` 7, `migration-cli-reduced-env` 2. Không có `.skip`, `.only`, `.todo` trong test của task.
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-418-01 | `daily-debit-counter.db-spec` › TC-418-01 | đạt |
| TC-418-02 | `daily-debit-counter.db-spec` › 4 test TC-418-02 (cộng dồn và nửa đêm, câu `INSERT` nhiều dòng một lần UPDATE, hai người ghi không khóa, số > 2^53) | đạt |
| TC-418-03 | `daily-debit-counter.db-spec` › TC-418-03 (backfill, revert, run lại) | đạt |
| TC-418-04 | `daily-debit-guard.db-spec` (2 test) và `sync-guard.service.spec` (2 test) | đạt |
| TC-418-05 | `daily-debit-guard.db-spec` › TC-418-05 (48 dòng ngẫu nhiên có seed, 33 mốc đồng hồ, cả hai đường) | đạt |
| TC-418-06 | `sync-guard.service.spec` › 4 test TC-418-06 (ngày VN, biên, thứ tự lỗi, > 2^53) | đạt |
| TC-418-07 | `daily-debit-counter-flow.db-spec` › TC-418-07 (4 lý do từ chối, bộ đếm không đổi) | đạt |
| TC-418-08 | `daily-debit-counter-flow.db-spec` › TC-418-08 (lỗi `40P01` sau dòng sổ cái; lần đầu đã cộng 7.000.000, retry chỉ còn một lần) | đạt |
| TC-418-09 | `daily-debit-counter-flow.db-spec` › TC-418-09 (40 lệnh 15tr song song trên 3 tài khoản sau 180tr: mỗi tài khoản đúng 1 `COMPLETED`, còn lại 422 `LIMIT_PER_DAY_EXCEEDED`, `sent_today` 195tr = sổ cái) | đạt |
| TC-418-10 | `invariants.db-spec` › 3 test BL-418 | đạt |
| TC-418-11 | `daily-debit-counter-roles.db-spec` (6 test, vai `dbs_api` và `dbs_worker` thật; gồm `dbs_api` `INSERT` một hàng có `sent_day` tùy ý được chấp nhận và kiểm 6 báo `FAIL` đúng hàng đó) | đạt |
| TC-418-12 | các spec tiền ở trên, từng spec một | đạt (TC-84-01 giữ nguyên, thêm ghi chú) |
| TC-418-13 | M-418-07 (driver «sau» đủ 5 cấu hình) | đạt |
| TC-418-14 | k6 `baseline` và `stress` trên AWS: [báo cáo 04](../components/load-tests/04-ket-qua-bl-418-2026-11-22.md) | **đạt một phần**: đã chạy thật (invariant PASS, 6 kiểm); điều kiện «từng phút < 300 ms» không đạt trọn (2/15 khung vượt) |
| TC-418-15 | `daily-debit-counter.db-spec` › TC-418-15 (a) `55P03` và (b) giao dịch dở commit trong lúc migration chờ | đạt |
| TC-418-16 | [tc-84-01-time.txt](screenshots/BL-418/tc-84-01-time.txt): suite `daily-limit` 26,9 s trước, 24,7 s sau (cache ấm) | đạt |

Kiểm đột biến ([mutation-checks.txt](screenshots/BL-418/mutation-checks.txt)): bỏ `CREATE TRIGGER` làm 6/6 test hành vi đỏ (flow 3, guard 3); bỏ điều kiện `sent_day <= d` làm 2 test đỏ (TC-418-02 và TC-418-05).

### 8.1 Số đo thời gian giữ khóa, trước và sau (cục bộ)

Cùng driver, cùng máy, 3 tài khoản, mỗi lệnh khóa 2, 60 giây, `pool` 10; «trước» trên `origin/main` `5195c751`, «sau» trên `2b284c38` (src cuối giống). Số trung bình, ms; output thô ở `screenshots/BL-418/before-*.txt`, `after-*.txt`:

| Dòng ghi nợ hôm nay mỗi TK | Tải | Chờ khóa | Giữ khóa tới COMMIT | Trong đó guard | Lệnh không 201 |
|---|---|---|---|---|---|
| 0 | 24/s | 0,84 → 0,84 | 7,39 → **6,44** | 0,84 → **0,03** | 0 → 0 |
| 8.000 | 24/s | 0,87 → 0,89 | 8,02 → **6,78** | 1,37 → **0,03** | 0 → 0 |
| 47.000 | 24/s | 1,80 → 0,79 | 11,58 → **6,14** | 4,20 → **0,03** | 0 → 0 |
| 8.000 | 120/s | 55,1 → **2,9** | 8,09 → **6,32** | 1,69 → **0,03** | 0 → 0 |
| 47.000 | 120/s | 101,5 → **3,8** | 11,53 → **6,48** | 4,53 → **0,03** | **1.907 → 0** |

Đọc số: thời gian giữ khóa **không còn tăng theo số dòng trong ngày** (6,1 đến 6,8 ms phẳng) và guard không còn chiếm đáng kể; ở 120/s với tài khoản 47.000 dòng hệ thống từ bão hòa (1.907 lệnh lỗi, chờ khóa 101 ms) về bình thường. **Giới hạn:** cùng tiến trình Node với máy tải, Postgres cục bộ không có Multi-AZ và RTT mạng; số tuyệt đối ở AWS sẽ khác (giữ khóa ở đó lớn hơn, nên phần giảm theo tỉ lệ nhỏ hơn: §1). Giữ khóa lúc ngày trống giảm 0,95 ms ≈ phần guard (0,81 ms) cộng một vòng đi về, nghĩa là chi phí của trigger ở đường ghi không đo được trong nhiễu.

**HOT update** (M-418-08, 8.000 dòng, 24 lệnh/s, 60 s): số dòng `UPDATE accounts` mỗi lệnh 1,98 → 3,00 (thêm một lần cho dòng nợ), **HOT 100% ở cả hai**, dead tuples 58 → 21. Backfill: 1.000.000 dòng ghi nợ, 500 tài khoản, 0 tài khoản lệch; `migration:run` ≈ 5,0 s so với ≈ 5,1 s của `migration:show` (khởi động node): phần giữ `ACCESS EXCLUSIVE` nằm dưới ngưỡng đo của cách này, tức dưới 1 giây.

### 8.2 Test thủ công

Output thô ở [manual-test.txt](screenshots/BL-418/manual-test.txt) (dòng đầu: SHA `c49790a8`, commit cuối đổi code). API thật `nest start` (role api) nối Postgres 17 và Valkey 8 trong Docker, token bằng `auth:dev-token`, kết nối bằng superuser của container (không phải `dbs_api`; vai `dbs_api` được kiểm ở TC-418-11).

| Bước | Kết quả |
|---|---|
| M-418-01 | **đạt**: `run`, `revert` (0 cột, 0 hàm, 0 trigger), `run` lại; `\d accounts` có hai cột, hai CHECK, trigger mức câu lệnh có `new_rows` |
| M-418-02 | **đạt**: 3 khách tiếng Việt, nạp 500tr cho A và 10tr cho C, chuyển 30tr và 20tr: 201, 201; `sent_today` của A = 50.000.000 = tổng sổ cái; B, C và `funding` (ghi nợ 510tr trong sổ cái) đều 0 |
| M-418-03 | **đạt** (AC-5.6): A tới 180tr, hai lệnh 15tr song song: một 201, một 422 `LIMIT_PER_DAY_EXCEEDED`; `sent_today` 195.000.000 = tổng sổ cái (6 dòng) |
| M-418-04a..d | **đạt**: 422 `LIMIT_PER_TX_EXCEEDED`, 422 `LIMIT_PER_DAY_EXCEEDED`, 422 `INSUFFICIENT_FUNDS` (C), mỗi lần bộ đếm không đổi; gửi lại `Idempotency-Key` đầu tiên trả cùng `transferId`, bộ đếm không đổi |
| M-418-05 | **đạt**: dừng api, `revert` rồi `run` trên dữ liệu thật: bộ đếm = sổ cái ở cả 4 tài khoản; `check:invariants` PASS. Sổ cái lớn trên DB thứ hai: xem §8.1 |
| M-418-06 | **đạt**: PASS thoát 0; sửa tay `sent_today = 1`: `FAIL` thoát 1 kèm `daily_debit_totals` (thực tế 1, kỳ vọng 195.000.000); khôi phục: PASS thoát 0 |
| M-418-07 | **đạt**: bảng §8.1 (trong `manual-test.txt`) |
| M-418-08 | **đạt**: HOT 100% (§8.1) |

Lỗi của chính kịch bản thủ công đã sửa trước khi lấy số: Git Bash không có `/proc/sys/kernel/random/uuid` (400 `IDEMPOTENCY_KEY_REQUIRED`) và `curl.exe` làm hỏng dấu tiếng Việt khi truyền tham số (`Nguy?n`): helper đổi sang `node` cho UUID và gửi thân qua file; DB dựng lại và chạy lại từ M-418-01, nên `manual-test.txt` chỉ có lần chạy đúng. Lần đo sổ cái lớn đầu thất bại vì seed không chạy (đường dẫn `docker cp`), đã xóa khỏi file và làm lại.

### 8.3 Đo trên AWS (BL-423), 2026-11-21 16:58Z đến 18:02Z

Chạy thật sau merge, image CI `4a987459`, cùng cấu hình DBS-173 (2 api 0,5 vCPU, 1 worker 0,25 vCPU, RDS `db.t4g.small` Multi-AZ, Valkey 1+1), một lượt `baseline` và một lượt `stress`; đã dọn sạch (`verify-clean.sh` thoát 0, chỉ còn `base`). Đầy đủ ở [báo cáo 04](../components/load-tests/04-ket-qua-bl-418-2026-11-22.md); số thô ở `docs/components/load-tests/results/bl418-*`.

| | Trước (DBS-173) | **Sau (BL-418)** |
|---|---|---|
| `baseline` plateau 120: chuyển p95 / p99 (ms) | 262,4 / 850,9 | **91,9 / 585,5** |
| Khung có p95 > 300 ms | 5 / 16 (đỉnh 678) | **2 / 15** (đỉnh 442) |
| Lỗi hệ thống / dropped / `meetsDoD3` | 1 / 0 / đạt | 9 / 1 / **không đạt** |
| `baseline` plateau 60: lỗi hệ thống | 70 (đứng hình) | 0 |
| `stress` plateau 120: p95 (ms), khung > 300 ms | 304,1, 3/5 | **119,9**, 1/5 |
| `stress` plateau 180: lỗi | 84,9% | 0,13% |
| Chờ khóa `FOR UPDATE` của api (ms, `pg_stat_statements`) | 22,4 | **9,8** |
| `SUM` hạn mức ngày (ms mỗi lần) | 1,9 | không còn |
| Câu lệnh chạy trong khóa (ms) | ≈ 2,9 | ≈ 1,4 (trigger +0,30 trên `INSERT ledger_entries`) |

Điều kiện «từng phút dưới 300 ms» chưa đạt: nút thắt kế tiếp là đuôi 1 đến 2 giây chưa rõ nguyên nhân ([BL-419](../BACKLOG.md)) và cỡ worker/api ([BL-417](../BACKLOG.md)). Mỗi số «sau» là một mẫu, không có khoảng tin cậy.

- **Phạm vi so với §7:** `git diff --stat origin/main...HEAD` nằm ở mục «Kiểm phạm vi» dưới đây.
- **Ảnh chụp** (`screenshots/BL-418/`): **không phải ảnh chụp màn hình**: chương trình vẽ nguyên văn các đoạn output thô của `manual-test.txt` thành PNG (không có công cụ chụp cửa sổ terminal ở phiên này).

![M-418-01](screenshots/BL-418/01-migration-up-down-up.png)
![M-418-03](screenshots/BL-418/02-ac-5-6-parallel-15tr.png)
![M-418-06](screenshots/BL-418/03-invariants-daily-debit-totals.png)
![M-418-07](screenshots/BL-418/04-lock-hold-before-after.png)

- **Lệch so với kế hoạch (gate phụ, agent tự duyệt, ghi trước khi làm hoặc ngay khi phát sinh):**
  1. Thêm file test ngoài §7: `test/db/daily-debit-guard.db-spec.ts` (TC-418-04, 05 tách khỏi `daily-debit-counter.db-spec.ts` để dùng `startDepositApp` và đồng hồ giả), `test/db/daily-debit-counter-roles.db-spec.ts` (TC-418-11 cần vai `dbs_api` thật qua fixture DBS-122), `test/support/daily-debit-counter.ts` (hàm dùng chung). Không đổi hành vi nào của §2.
  2. Thêm `DISABLE_TRIGGER` và thống kê HOT vào driver đo (M-418-08 cần số «trước» của kiểu ghi cũ).
  3. Sửa hai dòng ghi chú trong `.claude/skills/dbs-delivering-task/references/` («năm» thành «sáu» bất biến) vì mô tả đó thành sai.
  4. TC-418-09 và TC-418-11 lúc đầu được làm nhỏ hơn thiết kế (18 lệnh; thiếu ý `INSERT` của `dbs_api`): đã làm đủ sau lượt tự kiểm G4 (40 lệnh; kiểm 6 `FAIL` đúng hàng), nên không còn lệch.
- **Bàn giao cho vai khác:**
  - **BL-421** (Dev): kiểm `daily_debit_totals` trong job đối soát định kỳ của worker (có metric và alarm).
  - **BL-422** (Platform & Ops): thu hẹp quyền `INSERT` cấp bảng của `dbs_api` trên `accounts`.
  - **BL-423** (đo AWS): **đã đo và đã xóa khỏi BACKLOG** (§8.3); phần còn mở chuyển vào BL-419 (đuôi 1 đến 2 giây) và BL-417 (cỡ task).
  - Dòng **BL-418** đã xóa khỏi BACKLOG (đo và giảm thời gian giữ khóa đã làm, đo AWS cũng đã chạy).

## 9. Tài liệu đã cập nhật

`docs/adr/0004-row-locking-read-committed.md` (bổ sung), `docs/components/_shared/database-design.md` (§3 ngoại lệ thứ hai, §4.2, §5, §6.1, §7.1, §9), `docs/03_HIGH_LEVEL_ARCHITECTURE.md` (§6.1), `docs/components/ledger/query-plans.md`, `backend/src/modules/ledger/README.md`, `backend/src/modules/accounts/README.md`, `backend/README.md` (mục 9: sáu bất biến), `.claude/skills/dbs-delivering-task/references/module-notes.md` và `testing.md` (sáu bất biến), `docs/features/README.md` (dòng BL-418), `docs/BACKLOG.md`: **xóa BL-418**, thêm BL-421, BL-422; **BL-423** thêm ở PR #227 rồi xóa ở PR đo AWS (số đo ở §8.3), cập nhật BL-417 và BL-419 với số đo mới; thêm [báo cáo 04](../components/load-tests/04-ket-qua-bl-418-2026-11-22.md) và `results/bl418-*`.

### Kiểm phạm vi

`git diff --name-only origin/main...HEAD` (không tính `screenshots/`): 26 file. Khớp §7: migration `1795000012000-AddDailyDebitCounter.ts`; `account.types.ts`, `accounts.service.ts`, `sync-guard.service.ts` và `sync-guard.service.spec.ts`; `invariants.sql`, `invariants.ts`, `invariants.db-spec.ts`, `backend/README.md`; `daily-debit-counter.db-spec.ts`, `daily-debit-counter-flow.db-spec.ts`, `daily-limit.db-spec.ts`; `bl-418-lock-hold.manual.ts`; tài liệu §3.3 (ADR-04, database-design, docs/03, query-plans, README ledger và accounts), `BACKLOG.md`, `features/README.md` và chính feature doc này. **Ngoài §7, đã ghi ở «Lệch so với kế hoạch»:** `daily-debit-guard.db-spec.ts`, `daily-debit-counter-roles.db-spec.ts`, `test/support/daily-debit-counter.ts`, hai file ghi chú trong `.claude/skills/dbs-delivering-task/references/`. Không file nào của `transfer.service.ts`, `ledger-posting.service.ts`, `deposit.service.ts`, `db-roles.sql`, Terraform hay CI.
