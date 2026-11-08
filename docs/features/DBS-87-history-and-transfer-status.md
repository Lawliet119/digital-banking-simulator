# DBS-87 · UC-6 lịch sử giao dịch phân trang cursor và UC-7 trạng thái giao dịch

> **Status:** Implemented · **Vai:** Dev (ledger) · **Nhánh:** `feat/DBS-87-history-and-status` · **PR:** — · **Cập nhật:** 2026-11-08
>
> Techlead waiver: G1–G4 do agent tự duyệt theo yêu cầu của techlead (`huyasuo1109@gmail.com`); không có Dev khác review trước merge; không có ảnh PNG, bằng chứng là output thô; domain review do chính agent làm, không dùng subagent (§6).

## 1. Bối cảnh

- **Task trên board:** Story, Tuần 3, Dev, ưu tiên High, Demo 4. **Expect:** «Khách xem được lịch sử và trạng thái giao dịch của mình, nhanh và ổn định.»
- **DoD:**
  1. UC-6: phân trang cursor theo `(created_at DESC, id DESC)`, không OFFSET; trang đầu 20 dòng dùng Index Scan không Sort, ≤ 20 ms (EXPLAIN).
  2. UC-7: chỉ người gửi/nhận xem được trạng thái; người khác → 404.
  3. Response không chứa bất kỳ trường nào liên quan tới cờ gian lận (kiểm bằng test snapshot, AC-10.2).
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ.
- **Phụ thuộc:** DBS-86 (kiểm sở hữu, `getOwnedAccount`, `AccountsService`) và DBS-61 (chuyển tiền) đã vào `main`. Index `ledger_entries_account_history_idx (account_id, created_at DESC, id DESC)` có từ DBS-21.
- **Cột «Thực trạng» đúng:** chưa có endpoint lịch sử/trạng thái (kiểm: `grep -rn "transactions" backend/src` không có controller).
- **Baseline `main` `0388ff4`:** lint, typecheck sạch; unit 1074/1074; `test:db` 693/693.
- **Backlog:** **BL-175** (UC-7 không được lộ sự tồn tại của đích qua lệnh `REJECTED`) đúng phạm vi UC-7 → đưa vào task và xóa dòng trong PR này. Hàng khác cùng module (BL-176, 177) không liên quan.
- **Ngoài phạm vi:** sao kê PDF (BRD §2 loại trừ); xem giao dịch của khách bởi operator/auditor (task khác); lịch sử lệnh `REJECTED` (xem quyết định 2); rate limit (DBS-89).
- **Quyết định ở G1 (agent tự duyệt):**
  1. **Hợp đồng UC-6.** `GET /v1/accounts/{id}/transactions?limit=&cursor=&from=&to=` trả các dòng sổ (vào và ra) của tài khoản, mới nhất trước. `limit` mặc định 20, tối đa 100. `from` (bao gồm) và `to` (không bao gồm) là ISO-8601 UTC có `Z`. `cursor` là chuỗi mờ (base64url JSON `{v,t,id,f}` với `t` giữ đủ micro giây, `f` là vân tay của bộ lọc) như `GET /v1/audit/entries` (DBS-103). Trả `{ items, nextCursor }`.
  2. **Lịch sử chỉ gồm giao dịch đã vào sổ (`COMPLETED`).** Truy vấn nóng của database-design §7 đọc `ledger_entries`; lệnh `REJECTED` không có dòng sổ và đã xem được qua UC-7 bằng `transferId` trả về lúc 422. Ghi vào docs/03.
  3. **Lộ gì cho bên kia.** Mỗi dòng có `counterpartyAccountId` (tài khoản đối ứng của giao dịch `TRANSFER`); với `DEPOSIT` là `null` (không lộ id tài khoản `funding`). Không có tên khách, email, số dư của tài khoản khác. `balanceAfter` là số dư của chính tài khoản đang xem.
  4. **UC-7 `GET /v1/transfers/{id}`.** Người gửi (chủ `from_account`) xem được mọi trạng thái; người nhận (chủ `to_account`) chỉ xem được `COMPLETED`. Mọi trường hợp khác (không tồn tại, của người khác, người nhận của lệnh `REJECTED`, lệnh nạp tiền `DEPOSIT` bị từ chối, id sai định dạng) trả **cùng một** `404` và ghi audit `DENIED` (`transfer.read`). Lệnh `REJECTED` không bao giờ có trường id đích (BL-175): ba trường hợp «đích không tồn tại / là `funding` / là tài khoản LOCKED» cho cùng một dạng phản hồi.
  5. **Audit đọc thành công**: `transfer.read` và `account.transactions` ghi `SUCCESS` trong cùng transaction với việc đọc, fail-closed, như `account.read` (DBS-64).
  6. Không đổi schema, `ErrorCode`, env, event.

## 2. Hành vi

### UC-6 `GET /v1/accounts/{id}/transactions` (customer)

```json
{
  "items": [
    {
      "entryId": "9007199254740994",
      "transferId": "5c7e2e0b-0d7e-4a38-9a4a-8b0f2d1c9e11",
      "type": "TRANSFER",
      "direction": "DEBIT",
      "amount": "300000",
      "balanceAfter": "700000",
      "counterpartyAccountId": "b1f0c2de-1c6f-4e53-8a6c-6f2f0e7a2b10",
      "createdAt": "2026-03-15T09:30:00.123456Z"
    }
  ],
  "nextCursor": "eyJ2IjoxLC…"
}
```

- Sắp `createdAt DESC, entryId DESC`; `nextCursor` là `null` ở trang cuối. Tiền là chuỗi (BR-01).
- Tài khoản không thuộc người gọi, không tồn tại, là SYSTEM hoặc id sai định dạng → `404` giống hệt nhau + audit `DENIED` (`account.transactions`), như DBS-86.
- `limit` ngoài 1..100, `from`/`to` sai định dạng hoặc `from >= to`, `cursor` sai hoặc dùng với bộ lọc khác → `400`.
- Phản hồi **không** có trường nào về cờ gian lận, điểm rủi ro, luật, review (AC-10.2).
- Ca biên: tài khoản chưa có giao dịch → `{ "items": [], "nextCursor": null }`; hai dòng cùng `createdAt` vẫn phân trang ổn định nhờ `entryId`.

### UC-7 `GET /v1/transfers/{id}` (customer)

```json
{ "transferId": "5c7e…", "type": "TRANSFER", "status": "COMPLETED", "amount": "300000",
  "fromAccountId": "…", "toAccountId": "…", "createdAt": "2026-03-15T09:30:00.123456Z" }
```

```json
{ "transferId": "9a1d…", "type": "TRANSFER", "status": "REJECTED", "rejectReason": "ACCOUNT_NOT_ACTIVE",
  "amount": "300000", "fromAccountId": "…", "createdAt": "2026-03-15T09:31:00.000001Z" }
```

- `COMPLETED`: có `fromAccountId` và `toAccountId` (với `DEPOSIT`, `fromAccountId` bị bỏ vì là `funding`). `REJECTED`: có `rejectReason`, **không có `toAccountId`**.
- Người gửi và người nhận (của lệnh `COMPLETED`) đọc được; mọi người khác → `404`.

## 3. Kiến trúc

- **Vị trí:** module `ledger`, role `api`. File mới: `transaction-history.service.ts`, `transaction-history.query.ts` (kiểm tra tham số, cursor), `transaction-history.dto.ts`, `account-transactions.controller.ts`, `transfer-query.service.ts`, `transfer-status.dto.ts`; `transfers.controller.ts` thêm `GET :id`; `ledger.module.ts` đăng ký; `index.ts` không đổi.
- **Interface dùng:** `AccountsService.getOwnedAccount(id, {userId, role:'customer', action:'account.transactions', correlationId})` (ngoài transaction), `AuditService.record(manager, …)` và `recordDenied(…)`, `TransactionService.run`.
- **Dữ liệu:** đọc `ledger_entries` ⨝ `transfers` (PK) cho UC-6; `transfers` ⨝ `accounts` ⨝ `customers` cho UC-7. Ghi: chỉ `audit_log`.
- **Truy vấn UC-6:**

```sql
SELECT e.id::text AS "entryId", e.transfer_id AS "transferId", t.type, e.direction,
       e.amount::text AS amount, e.balance_after::text AS "balanceAfter",
       CASE WHEN t.type = 'DEPOSIT' THEN NULL
            WHEN e.direction = 'DEBIT' THEN t.to_account_id ELSE t.from_account_id END AS "counterpartyAccountId",
       to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
FROM ledger_entries e JOIN transfers t ON t.id = e.transfer_id
WHERE e.account_id = $1
  AND ($2::timestamptz IS NULL OR e.created_at >= $2)
  AND ($3::timestamptz IS NULL OR e.created_at < $3)
  AND ($4::timestamptz IS NULL OR (e.created_at, e.id) < ($4, $5::bigint))
ORDER BY e.created_at DESC, e.id DESC LIMIT $6
```

  Lấy `limit + 1` dòng để biết còn trang sau. Không `OFFSET`.
- **Transaction:** đọc + audit `SUCCESS` trong một `TransactionService.run`; ownership kiểm **trước** transaction (ràng buộc của `getOwnedAccount`); `DENIED` ghi transaction riêng.
- **Sơ đồ:**

```mermaid
sequenceDiagram
    participant C as Customer
    participant H as TransactionHistoryService
    participant A as AccountsService
    participant DB as PostgreSQL
    C->>H: GET /v1/accounts/{id}/transactions?cursor
    H->>A: getOwnedAccount(id, account.transactions)
    A-->>H: 404 + audit DENIED (nếu không phải chủ)
    H->>DB: BEGIN; SELECT … ORDER BY created_at DESC, id DESC LIMIT n+1
    H->>DB: audit account.transactions SUCCESS; COMMIT
    H-->>C: { items, nextCursor }
```

- **Thay đổi cấp hệ thống:** `docs/03` §7 hai dòng bảng API (hợp đồng, 404, chỉ lệnh COMPLETED), README `ledger`, database-design §7.1 (đo `EXPLAIN` lịch sử), xóa BL-175.

## 4. Test cases tự động

PostgreSQL 17 thật; HTTP thật với JWT thật. Tiền vào qua API nạp tiền; chỉ dòng sổ lùi ngày/nhiều dòng dùng SQL INPUT.

| ID | Truy vết | Lớp | Given · When · Then | `errorCode` / mã |
|---|---|---|---|---|
| TC-87-01 | DoD #1 | e2e HTTP | 45 dòng sổ; `limit=20` ba trang: 20, 20, 5, `nextCursor` null ở trang cuối, không trùng/thiếu, đúng thứ tự `(createdAt, entryId)` giảm dần | 200 |
| TC-87-02 | DoD #1 | e2e HTTP | Nhiều dòng cùng `createdAt` (chèn SQL) vẫn phân trang ổn định qua ranh giới trang | 200 |
| TC-87-03 | DoD #1 | e2e Postgres | `EXPLAIN` truy vấn trang đầu 20 dòng trên 200.000 dòng: `Index Scan` trên `ledger_entries_account_history_idx`, **không có node `Sort`**, không `Seq Scan`; trang kế (có cursor) cũng vậy. Đo 1 triệu dòng ≤ 20 ms ở bước thủ công | — |
| TC-87-04 | DoD #1 | e2e HTTP | Bộ lọc `from`/`to` (bao gồm/không bao gồm), cursor + bộ lọc | 200 |
| TC-87-05 | DoD #1 | e2e HTTP | `limit=0`, `101`, `abc`; `from` sai; `from >= to`; cursor hỏng; cursor của bộ lọc khác | 400 |
| TC-87-06 | DoD #2, AC-5.8 | e2e HTTP | UC-6: tài khoản người khác, không tồn tại, SYSTEM, id sai → cùng 404 + audit `DENIED` `account.transactions` | 404 |
| TC-87-07 | DoD #2 | e2e HTTP | UC-7: người gửi và người nhận đọc `COMPLETED`; người thứ ba, id không tồn tại, id sai → cùng 404 + audit `DENIED` `transfer.read` | 404 |
| TC-87-08 | DoD #2, BL-175 | e2e HTTP | UC-7: lệnh `REJECTED` tới đích không tồn tại, tới `funding`, tới tài khoản LOCKED trả cùng dạng phản hồi cho người gửi (chỉ khác `transferId`, không có trường chứa id đích); người nhận (đích LOCKED) → 404 | 200 / 404 |
| TC-87-09 | DoD #3, AC-10.2 | e2e HTTP | Giao dịch có dòng `fraud_flags` (điểm, mức, review): snapshot khóa của UC-6 và UC-7 đúng danh sách, không chuỗi `fraud`/`flag`/`risk`/`score`/`review`/`rule` trong tên khóa hay giá trị | 200 |
| TC-87-10 | thêm | e2e HTTP | Lịch sử có cả nạp tiền (`DEPOSIT`, `counterpartyAccountId` null) và chuyển đi/đến; tiền là chuỗi; `balanceAfter` khớp | 200 |
| TC-87-11 | thêm | e2e HTTP | Audit `SUCCESS` (`account.transactions`, `transfer.read`) cùng transaction; audit lỗi → không trả dữ liệu | 200 / 500 |
| TC-87-12 | thêm | unit | Bộ phân tích tham số + cursor (microsecond, vân tay bộ lọc, giới hạn độ dài, base64url chuẩn) | — |
| TC-87-13 | thêm | e2e HTTP | Swagger có vai, ví dụ và các mã lỗi của hai route; vai `operator`/`auditor` → 403 | 403 |
| Quy trình | DoD #4 | — | Merge, CI, Dev review | waiver |

## 5. Test thủ công

`node backend/scripts/manual-dbs87.cjs` (Docker, Node 24): app thật, JWT thật, Postgres 17.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-87-01 | Nạp 1.000.000đ cho Vũ Thị Giang; Giang chuyển 3 lần (100.000, 200.000, 300.000đ) cho Bùi Văn Hải | 3 × 201 |
| M-87-02 | Giang `GET /v1/accounts/{giang}/transactions?limit=2` rồi trang kế bằng `nextCursor` | trang 1 có 2 dòng mới nhất (300.000, 200.000 DEBIT), trang 2 có 2 dòng (100.000 DEBIT và nạp 1.000.000 CREDIT, `counterpartyAccountId` null), `nextCursor` null |
| M-87-03 | Hải xem lịch sử của Giang | 404 giống tài khoản không tồn tại; audit `DENIED` |
| M-87-04 | Hải `GET /v1/transfers/{id}` của lệnh 100.000đ; một người thứ ba cùng lệnh | Hải 200 `COMPLETED`; người thứ ba 404 |
| M-87-05 | Giang chuyển 5.000.000đ (thiếu tiền) cho Hải rồi cho một UUID không tồn tại; Giang đọc hai lệnh REJECTED | cùng dạng phản hồi `REJECTED`/`ACCOUNT_NOT_ACTIVE`(đích không tồn tại) và `INSUFFICIENT_FUNDS`; không có `toAccountId` |
| M-87-06 | Tạo tài khoản 1.000.000 dòng trong DB tạm; `EXPLAIN (ANALYZE, BUFFERS)` trang đầu 20 dòng | `Index Scan using ledger_entries_account_history_idx`, không `Sort`, ≤ 20 ms |
| cleanup | Dọn | `DBS-87 cleanup PASS` |

## 6. Domain review (AI)

**Reviewer:** chính agent (Sonnet 5.5), 2026-11-08; đọc BRD UC-6/7, FR-LED-08/09, AC-5.8, AC-10.2, docs/03 §6.1/§7/§12, database-design §4.7/§6/§7, DBS-83 (REJECTED), DBS-86 (ownership), DBS-103 (cursor). Không dùng subagent.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | UC-7 trả `toAccountId` hay quyết «người nhận được xem» bằng `to_account_id` sẽ phân biệt được đích không tồn tại/funding với LOCKED (BL-175) | Quyết định 4: REJECTED không có `toAccountId`, chỉ người gửi xem; TC-87-08 |
| 2 | should-fix | Cursor chỉ có `Date` mất micro giây → bỏ sót/lặp dòng | Cursor giữ chuỗi micro giây từ PostgreSQL; TC-87-02, TC-87-12 |
| 3 | should-fix | `counterpartyAccountId` của lệnh nạp tiền lộ id `funding` | `null` cho `DEPOSIT`; TC-87-10 |
| 4 | should-fix | 404 phân biệt được «không tồn tại» với «của người khác» qua thời gian hoặc nội dung | Cùng nhánh code, cùng thông điệp; TC-87-06/07 so sánh nguyên văn thân phản hồi (trừ `correlationId`) |
| 5 | should-fix | Cursor dùng lại với bộ lọc khác sai ngữ nghĩa | Vân tay bộ lọc trong cursor, 400 nếu khác |
| 6 | minor | Chọn cột bằng `SELECT *` sẽ vô tình lộ cột mới (ví dụ cờ gian lận) | Truy vấn liệt kê cột, DTO tường minh, test snapshot khóa (TC-87-09) |
| 7 | minor | `OFFSET` | Không dùng; TC-87-03 kiểm plan |

Không có phát hiện blocking còn mở. Verdict tự đánh giá: APPROVE.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `transaction-history.query.ts` + `.spec.ts` | TC-87-12 | điền khi chạy | `npm test -- transaction-history` | `feat(ledger): parse and encode the transaction history cursor (DBS-87)` |
| 2 | `transaction-history.service.ts`, `.dto.ts`, `account-transactions.controller.ts`, `ledger.module.ts`, `test/db/transaction-history.db-spec.ts` | TC-87-01, 02, 04, 05, 06, 09, 10, 11, 13 | điền khi chạy | `npm run test:db -- --runInBand transaction-history` | `feat(ledger): GET /v1/accounts/{id}/transactions with a keyset cursor (DBS-87)` |
| 3 | `transfer-query.service.ts`, `transfer-status.dto.ts`, `transfers.controller.ts`, `test/db/transfer-status.db-spec.ts` | TC-87-07, 08, 09 | điền khi chạy | `npm run test:db -- --runInBand transfer-status` | `feat(ledger): GET /v1/transfers/{id} for sender and recipient (DBS-87)` |
| 4 | `test/db/transaction-history-plan.db-spec.ts`, fixture | TC-87-03 | điền khi chạy | `npm run test:db -- --runInBand transaction-history-plan` | `test(ledger): history page one is an index scan without Sort (DBS-87)` |
| 5 | `scripts/manual-dbs87.cjs` | M-87-01..06 | — | `node backend/scripts/manual-dbs87.cjs` | `test(ledger): DBS-87 manual driver` |
| 6 | docs/03 §7, README ledger, database-design §7.1, doc này, index, BACKLOG (xóa BL-175, BL-176) | — | — | `check-doc-links.mjs` | `docs(ledger): record DBS-87 evidence` |

Rủi ro: thêm bề mặt API đọc dữ liệu tiền → test ownership và snapshot chặn lộ. Không migration; lùi bằng `git revert`. Đột biến: bỏ `getOwnedAccount` (TC-87-06 hỏng); `SELECT *` hoặc thêm cột cờ (TC-87-09 hỏng); `to_account_id` cho REJECTED (TC-87-08 hỏng); bỏ `id` khỏi `ORDER BY` (TC-87-02 hỏng).

**Quyết định ở G3 (agent tự duyệt):** theo bảng trên.

## 8. Kết quả

- **Lệnh kiểm tra** (Node 24.22.2, `backend/`, commit code cuối `da0d926`; SHA ở dòng đầu `manual-test.txt`):

| Lệnh | Kết quả |
|---|---|
| `npm run lint:check`, `typecheck`, `build` | đạt (mã thoát 0) |
| `npm test -- --runInBand` | **1082/1082**, 67 suite (+8 ca `transaction-history.query.spec.ts`) |
| `npm run test:e2e -- --runInBand` (Postgres 17 tạm qua `DATABASE_URL`) | **148/148**, 14 suite |
| `npm run test:db -- --runInBand` | **711/711**, 41 suite (+18 ca, +3 suite so với 693/38 của DBS-85) |
| `node scripts/manual-dbs87.cjs` | 6/6 bước + dọn dẹp đạt |

  0 test bị `.skip/.only/.todo`.

- **Đối chiếu test case:** (số TC giữ như §4; TC-87-10 được dùng ở cả hai file: lịch sử có nạp tiền trong `transaction-history.db-spec.ts`, và trạng thái lệnh nạp tiền trong `transfer-status.db-spec.ts`)

| ID | Test | Đạt? |
|---|---|---|
| TC-87-01 | `transaction-history.db-spec.ts` › `TC-87-01` (23 dòng, trang 10/10/3, size 7, mặc định 20, rỗng) so với `ORDER BY created_at DESC, id DESC` trong SQL | đạt |
| TC-87-02 | `TC-87-02` (6 dòng cùng `createdAt` micro giây, `limit` 4 và 2). **Đột biến:** bỏ `e.id DESC` khỏi `ORDER BY` → hỏng | đạt |
| TC-87-03 | `transaction-history-plan.db-spec.ts` (3 ca: trang 1, trang 2 có cursor, có cửa sổ thời gian; 200.000 dòng; `Index Scan` hướng `Forward`, không `Sort`/`Seq Scan`, ≤ 21 dòng đọc, `Index Cond` có `created_at`). **Đột biến:** `ORDER BY e.amount` → cả 3 ca hỏng. Đo ≤ 20 ms ở M-87-06 | đạt |
| TC-87-04 | `TC-87-04` (`from` bao gồm, `to` không bao gồm, cursor + bộ lọc) | đạt |
| TC-87-05 | `TC-87-05` (12 yêu cầu sai → 400, cursor còn dùng được sau đó) và `transaction-history.query.spec.ts` | đạt |
| TC-87-06 | `TC-87-06` (khác chủ, không tồn tại, SYSTEM, sai định dạng, UUID viết hoa của người khác: cùng thân 404, audit `DENIED` `account.transactions`) | đạt |
| TC-87-07 | `transfer-status.db-spec.ts` › `TC-87-07`. **Đột biến:** bỏ kiểm sở hữu → hỏng | đạt |
| TC-87-08 | `TC-87-08` (đích không tồn tại / `funding` / LOCKED: cùng khóa, cùng giá trị trừ `transferId`/`createdAt`; không chứa id đích; người nhận LOCKED → 404). **Đột biến:** có `toAccountId` khi REJECTED, hoặc người nhận đọc REJECTED → hỏng | đạt |
| TC-87-09 | `TC-87-09` ở cả hai file (có dòng `fraud_flags` điểm 85 mức HIGH: danh sách khóa chính xác, không `fraud/flag/risk/score/review/rule/HIGH`). **Đột biến:** thêm cột vào SELECT → hỏng | đạt |
| TC-87-10 | `transaction-history.db-spec.ts` › `TC-87-10` (nạp tiền `DEPOSIT` + chuyển; số dư; `counterpartyAccountId`) và `transfer-status.db-spec.ts` › `TC-87-10` (nạp tiền đọc được, không lộ `funding`; nạp bị từ chối không ai đọc được) | đạt |
| TC-87-11 | `TC-87-11` ở cả hai file (audit `SUCCESS` đúng hàng; trigger chặn `audit_log` → 500 không dữ liệu; khôi phục → 200) | đạt |
| TC-87-12 | `transaction-history.query.spec.ts` (8 ca) | đạt |
| TC-87-13 | `TC-87-13` ở cả hai file (operator/auditor/admin → 403, không token → 401, `Cache-Control: no-store`, Swagger có vai, tham số và mã lỗi) | đạt |
| Quy trình | DoD #4 | chưa làm: Dev review (BL-176) |

  13 ca/nhóm đạt, 0 đơn giản hóa.

- **Test thủ công** (output thô [manual-test.txt](screenshots/DBS-87/manual-test.txt)):

| Bước | Kết quả thật | Kết quả |
|---|---|---|
| M-87-01 | Nạp 1.000.000, 3 lệnh 100.000/200.000/300.000 → 3 × 201 | đạt |
| M-87-02 | Trang 1 (`limit=2`): 300.000, 200.000 DEBIT; trang 2 theo `nextCursor`: 100.000 DEBIT, nạp 1.000.000 CREDIT (`counterpartyAccountId` null), `nextCursor` null | đạt |
| M-87-03 | Hải đọc lịch sử của Giang: 404, thân giống tài khoản không tồn tại; 2 hàng `DENIED` | đạt |
| M-87-04 | Giang và Hải đọc lệnh 100.000 `COMPLETED` (thân giống nhau); Khánh 404 | đạt |
| M-87-05 | 5.000.000 (thiếu tiền) và tới tài khoản không tồn tại: `REJECTED`, không `toAccountId`, lý do `INSUFFICIENT_FUNDS` / `ACCOUNT_NOT_ACTIVE`; Hải không đọc được lệnh đầu; bất biến PASS | đạt |
| M-87-06 | 1.000.400 dòng: `Limit → Nested Loop → Index Scan using ledger_entries_account_history_idx` (21 dòng) + `Index Scan using transfers_pkey`, không `Sort`, 88 buffer, trung vị **0,118 ms** (ngưỡng 20 ms); qua HTTP đầy đủ trung vị **13,0 ms** (lần đầu 40 ms) | đạt |
| cleanup | JWKS, database tạm, container đã dọn | đạt |

  Seed SQL cho user/customer/tài khoản số dư 0 và (M-87-06) 1,5 triệu dòng sổ trong DB tạm; tiền ở M-87-01..05 vào qua API nạp tiền.

- **Phạm vi so với §7:** khớp, thêm `transfers.controller.ts` (route `GET :id`), `ledger.module.ts`, `transaction-history.query.spec.ts` (TC-87-12), `docs/03` §7 + bảng phiên bản v1.10, `database-design` §7.2, README `ledger`.
- **Ảnh chụp:** không có (waiver); bằng chứng là `manual-test.txt`.
- **Lệch so với kế hoạch:** (1) `transaction-history.query.ts` được viết **trước** spec của nó (trái quy tắc test trước); độ nhạy được bù bằng các đột biến ở trên, nhưng không có bước "đỏ" cho TC-87-12. (2) Hai test cho UC-6/UC-7 chạy xanh ngay lần đầu (hành vi đã được thiết kế sẵn), nên «kết quả đỏ» thay bằng đột biến. (3) Một regex trong TC-87-09 (`…|85`) tình cờ khớp UUID ngẫu nhiên (`…4d85…`) làm test chập chờn; phát hiện nhờ chạy lặp, đã bỏ chữ số khỏi mọi regex kiểm «không lộ» (cả hai file); đã chạy lại 3 lần xanh. (4) Các lệnh gộp `transaction-history`, `transfer-status` trong §7 thực tế là 5 commit.
- **Để lead xem kỹ:** (a) lịch sử chỉ gồm lệnh đã vào sổ, lệnh bị từ chối xem qua UC-7 theo `transferId`; (b) `counterpartyAccountId` cho người xem là id tài khoản bên kia của chính giao dịch của họ; (c) người nhận không đọc được lệnh `REJECTED` dù đích là tài khoản của họ (BL-175).
- **Bàn giao:** BL-176 (thêm PR này). Đã xóa **BL-175**.

## 9. Tài liệu đã cập nhật

`docs/03_HIGH_LEVEL_ARCHITECTURE.md` (§7 hai dòng bảng API, phiên bản v1.10), `docs/components/_shared/database-design.md` (§7.2), `backend/src/modules/ledger/README.md`, `docs/features/README.md`, `docs/BACKLOG.md` (xóa **BL-175**, thêm PR vào BL-176).
