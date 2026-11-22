# Báo cáo đối chiếu tài liệu ledger với code (trả lời của subagent; mục (b) và hai mục (c).5, (c).9 chỉ gộp dòng cho gọn, không đổi nội dung)

> Subagent `opus`, effort `high`, 2026-11-22, chỉ đọc, trên commit `3035f02f`. Số dòng là của tài liệu và code **trước** khi DBS-142 sửa. Agent làm DBS-142 đã tự mở lại các điểm quan trọng (retry `40001`, quyền xem lệnh, khóa funding, replay) trước khi sửa tài liệu.

## 1. Các chỗ LỆCH

**Về tiền và bất biến**

1. **Công thức hạn mức ngày đã lỗi thời.**
   - Tài liệu: `docs/components/ledger/01-concept-brief.md:251` nói hạn mức ngày là SUM các dòng `DEBIT` trong `ledger_entries`, dùng index `(account_id, created_at)`, mất ≤ 5 ms.
   - Code: guard đọc bộ đếm `sentToday`/`sentDay` trên dòng vừa khóa (`backend/src/modules/ledger/sync-guard.service.ts:102-112`, `backend/src/modules/accounts/accounts.service.ts:51-55`). Bộ đếm do trigger `ledger_entries_daily_debit_counter` giữ (`backend/src/database/migrations/1795000012000-AddDailyDebitCounter.ts:61-89`). SUM chỉ còn là đường lùi khi `sent_day` lớn hơn hôm nay (`sync-guard.service.ts:110`).
   - `docs/03_HIGH_LEVEL_ARCHITECTURE.md:230` mô tả đúng cơ chế, nhưng câu "không còn `SUM`" thiếu ý về đường lùi này.

2. **Job đối soát kiểm gì: tài liệu nói sai.**
   - Brief `:313` nói job kiểm bất biến 1, 2, 4 và "sau load test chạy lại đúng các kiểm tra này". `docs/03:644` liệt kê 3 kiểm tra.
   - Code của job (`reconciliation.service.ts:29-34`, `:39-112`) có 4 kiểm tra: tổng Nợ = tổng Có, Σ balance = 0, số dư từng tài khoản, và mỗi lệnh `COMPLETED` có đúng một cặp bút toán. Tài liệu bỏ sót kiểm tra thứ tư.
   - Script sau load test `backend/src/scripts/invariants/invariants.sql:63-116` có 6 kiểm tra, thêm `customer_balances` (`:86-91`) và `daily_debit_totals` (`:109-115`). Vậy "đúng các kiểm tra này" là sai.

3. **Bảng bất biến thiếu một bất biến.** Brief `:303-311` không có bất biến 6: bộ đếm bằng sổ cái (BL-418). Code kiểm nó ở `invariants.sql:109-115`.

4. **Tập lỗi được retry ghi sai.**
   - `docs/03:234` nói "không phải xử lý lỗi `40001`, chỉ retry khi `40P01` hoặc mất kết nối". `docs/03:1034` nói tương tự.
   - Code retry cả `40P01` và `40001` (`backend/src/common/utils/pg-error.util.ts:34-37`). Mất kết nối **không** được retry, chỉ được trả 503 (`pg-error.util.ts:5-9` và `:39-51`; `backend/src/database/transaction.helper.ts:154`).

5. **"ledger không đọc bảng accounts trực tiếp" không còn đúng.**
   - Tài liệu: `docs/03:161`, brief `:285`, `backend/src/modules/ledger/README.md:35`.
   - Code: `transfer-query.service.ts:27-31` JOIN thẳng `accounts` và `customers`; `reconciliation.service.ts:56-66` đọc `public.accounts`.

6. **Index ghi sai.**
   - `docs/03:645` ghi một index `ledger_entries(account_id, created_at)` dùng cho cả lịch sử lẫn hạn mức ngày.
   - Code có hai index riêng: `ledger_entries_daily_debit_idx` (partial `DEBIT`, `INCLUDE amount`) và `ledger_entries_account_history_idx (account_id, created_at DESC, id DESC)` (`1791849600000-CreateTransfersLedgerIdempotency.ts:104-111`). Hạn mức ngày giờ dùng bộ đếm, không dùng index này nữa.

7. **Quyền xem `GET /v1/transfers/{id}`.** Brief `:297` nói "người gửi hoặc người nhận". Code chỉ cho người nhận xem lệnh `COMPLETED` (`transfer-query.service.ts:53-55`).

8. **Quan hệ trong ERD.** Brief `:74` vẽ `TRANSFERS ||--|{ LEDGER_ENTRIES` ("sinh ra 2 dòng"). Lệnh `REJECTED` không có dòng sổ nào (`transfer.service.ts:114`; ràng buộc `1791849600000…:93-98`), nên phải là `||--o{` như `docs/03:577`.

9. **Luôn khóa "hai tài khoản" là không đúng.**
   - Tài liệu: brief `:155`, `docs/03:204`, `docs/03:314`.
   - Code: khi đích là `funding` thì chỉ khóa nguồn (`transfer.service.ts:77-81`). Đích không tồn tại thì không có dòng nào để khóa.

10. **Replay sai nội dung kết thúc bằng ROLLBACK, không phải COMMIT.** Brief `:154,162` và `docs/03:200-202` ghi COMMIT rồi trả 422. Code ném 422 ngay trong callback (`ledger-posting.service.ts:90-95`, gọi tại `transfer.service.ts:75`), nên transaction bị rollback. Kết quả dữ liệu như nhau (không ghi gì), chỉ sai chữ.

**Về tên và đường dẫn**

11. **`LedgerQueryService` không tồn tại.** Brief `:280` vẽ nó cấp lịch sử và trạng thái cho `accounts`. Code thật là `TransactionHistoryService` và `TransferQueryService`, đăng ký trong ledger với controller riêng (`ledger.module.ts:24-27`). Không có chỗ nào trong `src` dùng tên `LedgerQueryService`.

12. **README phần "Export công khai" lỗi thời.**
    - `README.md:27` nói "Query lịch sử/trạng thái sẽ có ở task riêng".
    - Thực tế `index.ts:2-21` còn export `LedgerReconciliationModule`, `ReconciliationService`, `RECONCILIATION_CHECK_SQL`, `classifyReconciliationSnapshot`, `SENT_TODAY_SQL`, `SyncGuardService`, `buildHistorySql`, `TransactionItemDto`.
    - Module `risk` đang dùng `buildHistorySql`, `transferCorrelationId` và `TransactionItemDto` (`risk/fraud-http.service.ts:4`, `risk/fraud-http.dto.ts:3`).

13. **README `:7` nói chủ view `v_transfer_facts` "còn chờ BL-005".** Việc này đã xong: `1793664000000-CreateDbRolesAndGrants.ts:46-51`.

14. **`docs/03:158` nói worker "chưa có consumer và scoring của risk".** Code đã có `RiskWorkerModule` (`backend/src/modules/index.ts:48`). Mục này nằm ngoài ledger, chỉ nêu để biết.

**Về chữ lỗi thời**

15. Dòng "Verified" của brief (`:3`) liệt kê là "chưa có" những thứ đã có: replay idempotency, hạn mức, lịch sử, `GET /v1/transfers/{id}`, đối soát. Ngày cập nhật vẫn là 2026-11-07.
16. README `:5` (Status) không nhắc DBS-87 và BL-418.
17. Lỗi đánh máy trong README: `:33` "bắt buộc1–128", `:35` "rồi422", "trả500 (transient503)".
18. Số đo Seq Scan không khớp nhau: README `:50` ghi 203 ms, comment code `sync-guard.service.ts:23` ghi 256 ms.
19. Brief §14 (`:351-361`) là lộ trình theo tuần đã qua.

## 2. Các chỗ THIẾU (code có, tài liệu không nói)

- **429 `RATE_LIMITED`** trên `POST /v1/transfers` (`transfers.controller.ts:60`, `:87-90`): brief §8 và §10 (`:255-299`) không nhắc.
- **Quy tắc `Idempotency-Key`**: dài 1–128 ký tự, key toàn khoảng trắng bị coi là thiếu (`transfers.controller.ts:100-106`). Brief `:201` chỉ ghi "thiếu header".
- **Hash của request** gồm method, path và body đã sắp khóa (`ledger-posting.service.ts:57-61`): brief không nói.
- **Chủ tài khoản đổi giữa chừng**: nếu chủ sở hữu khác đi sau khi khóa thì ném `SourceOwnershipChangedError`, ghi audit `DENIED` ngoài transaction rồi trả 404 (`transfer.service.ts:166-183`). README `:44` chỉ nói "kiểm lại".
- **Cấu hình của job đối soát** (`reconciliation.service.ts:249`, `:274`):
  - không retry (`maxRetries: 0`);
  - Terraform đặt chu kỳ mặc định 60 000 ms, chỉ nhận 10 000..300 000 (`infra/terraform/envs/dev/session/worker.tf:31-38`), trong khi README `:66` chỉ ghi mặc định của ứng dụng là 300 000.
- **Trigger append-only** trên `transfers` và `ledger_entries` (`1792627200002-AddAppendOnlyTriggers.ts:7-20`): brief `:311` và `docs/03:635` chỉ nói "thu hồi quyền".
- **Cột thiếu trong ERD**: brief `:79-102` thiếu `initiated_by`, `correlation_id`, `created_at` (transfers), `balance_after` (ledger_entries), `transfer_id`, `created_at` (idempotency_keys). `docs/03:588-602` thiếu `accounts.sent_today`/`sent_day` và `transfers.correlation_id`.

## 3. Cái chưa kiểm được

- Các số đo hiệu năng: 0,163 ms, 0,118 ms, 203 ms.
- Ánh xạ AC → test cho AC-5.1, 5.3, 5.5, 5.9, 5.10: trong `backend/test/db` không có nhãn AC nào cho mấy mục này. AC-5.2, 5.4, 5.6, 5.7, 5.8 thì có nhãn.
- "Seed qua API nạp tiền" (brief §12).
- Quyền `dbs_worker` trên ECS thật (README `:72`).
- Test quét chuỗi `fraud|flag|…` của DTO (README `:56`): chưa mở file test.

## (a) Các phần của 01-concept-brief.md đã đối chiếu và KHỚP

- **Bảng đầu**: sở hữu bảng; chạy ở `api`, job ở `worker` (`modules/index.ts:33-49`, `reconciliation.service.ts:148-151`).
- **§2, §5**: ví dụ sổ cái; `funding` được âm (`1791763200000…:53`).
- **§4**: bảng 5 khái niệm (ERD không tính) và quy tắc tiền là bigint/string.
- **§6**: thứ tự các bước (kiểm tra sở hữu trước BEGIN → claim key → khóa → guard → ghi → lưu kết quả), READ COMMITTED, rollback thì key không lưu. Ngoại lệ là các mục 9 và 10 ở phần 1.
- **§7 Lá chắn 1**: cả 6 dòng bảng khớp, kể cả 422 `IDEMPOTENCY_KEY_REUSED` và 400 `IDEMPOTENCY_KEY_REQUIRED`; key nằm trong Postgres, scope `(user_id, idem_key)`.
- **§7 Lá chắn 2**: khóa theo thứ tự id (`accounts.service.ts:55`); retry tối đa 3 lần có backoff; 503 kèm `Retry-After`; timeout 2 s / 5 s / 10 s (`validation.schema.ts:129-131`).
- **§7 Lá chắn 3**: bảng 4 quy tắc, giá trị 50 tr / 200 tr (`validation.schema.ts:206-207`), mã lỗi, thứ tự guard (`sync-guard.service.ts:80-89`), ví dụ AC-5.6. Riêng dòng `:251` sai (mục 1 phần 1).
- **§8**: ba kết quả có thể xảy ra (thiếu 429).
- **§10**: bốn endpoint đều tồn tại, cùng các quy ước tiền là string, problem+json, 404 thay cho 403. Ngoại lệ là mục 7 phần 1.
- **§11**: cách bảo vệ bất biến 1–5. Câu CHECK khớp nguyên văn `1791763200000…:53`. Câu về job đối soát thì sai (mục 2 phần 1).
- **§13**: test chạy trên Postgres thật (Testcontainers).

## (b) Các mục tài liệu cần sửa, xếp theo mức nghiêm trọng

1. **Sai sự thật về tiền và bất biến**: brief `:251`; brief `:313` và `docs/03:644`; thêm bất biến 6 vào brief §11; `docs/03:234,1034`; `docs/03:161`, brief `:285`, README `:35`; `docs/03:645`; brief `:297`; brief `:74`; brief `:155`, `docs/03:204,314`; brief `:154` và `docs/03:201`.
2. **Sai tên và đường dẫn**: brief `:280` (`LedgerQueryService`), README `:27`, README `:7` (BL-005), các cột ERD, `docs/03:158`.
3. **Chữ lỗi thời**: brief `:3`, README `:5`, lỗi đánh máy README `:33,35`, số 203 so với 256 ms, brief §14, thêm 429 vào §8 và §10.

## (c) Nợ kỹ thuật của ledger thấy khi đọc code

1. **Job đối soát và `invariants.sql` đã lệch nhau.** Job có 4 kiểm tra, script có 6. Job đọc `v_transfer_facts`, script đọc `transfers` (`invariants.sql:32`). Kiểm tra cặp bút toán viết khác nhau: job dùng `COUNT<>2 … LIMIT 1` (`reconciliation.service.ts:69-88`), script so số tiền và tài khoản theo từng chiều (`invariants.sql:24-35`, `:104-107`). Không có test nào giữ hai bên khớp nhau.
2. **Lượt `MISMATCH` không cho biết kiểm tra nào lệch.** `details` chỉ chứa danh sách tài khoản lệch số dư (`reconciliation.types.ts:89-101`). Nếu chỉ kiểm tra cặp bút toán hỏng thì dòng ghi ra có `details = []` và `mismatched_accounts = 0`. Trong khi đó mô tả alarm bảo người trực "mở `reconciliation_runs` để biết kiểm tra nào lệch" (`infra/terraform/envs/dev/session/alarms.tf:341`).
3. **Logic "ngày VN, tổng ngày" bị chép 5 lần**: trigger (`1795000012000…:66-81`), backfill (`:91-106`), `invariants.sql:40-55`, `SENT_TODAY_SQL` (`sync-guard.service.ts:26-29`) và `vietnamDay` viết bằng TS (`:31-41`).
4. **Chuyển tiền và nạp tiền chép nhau** phần dựng event, lưu kết quả và replay: `transfer.service.ts:133-165` so với `deposit.service.ts:102-138`.
5. **Quyền dư**: `dbs_api` có `SELECT` trên `reconciliation_runs` (`CreateDbRolesAndGrants.ts:88`) nhưng trong `src` không có code api nào đọc bảng này; `dbs_worker` có `SELECT, DELETE` trên bảng đó (`:112`) trong khi job chỉ `INSERT` và chưa có job dọn dòng cũ (README `:62,72`).
6. **Ranh giới module bị vượt bằng SQL**: `transfer-query.service.ts:27-31` đọc `accounts` và `customers`; `risk` chạy SQL của ledger qua `buildHistorySql` (`risk/fraud-http.service.ts:4`).
7. **Ngoại lệ `funding` viết cứng** ở `transfer.service.ts:77-81` (code đã tự ghi chú điều này).
8. **Lỗi chính tả trong thông báo lỗi trả về client**: `operator-deposits.controller.ts:68` "at most128".
9. **Test**: không có test nào cho thấy job đối soát bắt được khi bộ đếm lệch sổ cái hoặc số dư khách âm (hợp lý vì job không kiểm hai thứ này, nhưng vẫn là lỗ hổng); AC-5.1, 5.3, 5.5, 5.9, 5.10 không có nhãn trong `test/db`; `ledger-posting.service.spec.ts` chỉ 52 dòng, chưa kiểm có phủ các nhánh lỗi của `claimKey`/`replay` hay không.
10. **Nhỏ**: `Clock` được đăng ký riêng ở hai module (`ledger.module.ts:19`, `ledger-reconciliation.module.ts:13`). Không có TODO/FIXME nào trong `modules/ledger`.
