# DBS-88 · FR-ACC-04: GET /v1/operator/accounts cho nhân viên tra cứu tài khoản của khách

> **Status:** Implemented · **Vai:** Dev · **Nhánh:** `feat/DBS-88-operator-account-search` · **PR:** [#77](https://github.com/Lawliet119/digital-banking-simulator/pull/77) · **Cập nhật:** 2026-11-08
>
> Techlead waiver: G1–G4 do agent tự duyệt theo yêu cầu của techlead (`huyasuo1109@gmail.com`); không có Dev khác review trước merge; không có ảnh PNG, bằng chứng là output thô; domain review do chính agent làm, không dùng subagent (§6).

## 1. Bối cảnh

- **Task trên board:** Story, Tuần 3, Dev, ưu tiên High, Demo 4. **Expect:** «Nhân viên tìm đúng tài khoản trước khi nạp hoặc khóa mà không thấy số dư.»
- **DoD:**
  1. Tìm theo `accountId` hoặc tên khách (khớp một phần), tối đa 20 kết quả; trả id, loại, trạng thái, tên chủ; KHÔNG trả số dư.
  2. Mỗi lần tra cứu ghi audit (người tra, từ khóa, số kết quả); không có index trên `customers.full_name` (đã quyết định).
  3. Chỉ operator; customer/auditor gọi → 403.
  4. Cập nhật sơ đồ UC-3 (docs/03 §6.4) nếu hành vi khác bản thiết kế.
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ.
- **Phụ thuộc:** DBS-86 (ownership, audit `DENIED`) và DBS-51 (`@Roles`, `RolesGuard`) đã vào `main`.
- **Cột «Thực trạng» đúng:** docs/02 (FR-ACC-04) và docs/03 §7 mô tả endpoint, chưa có code (kiểm: `grep -rn "operator/accounts" backend/src` chỉ thấy comment). Index trên `customers.full_name` cố ý không có: database-design §6.2.
- **Baseline `main` `37798b8`:** lint, typecheck sạch; unit 1082/1082; e2e 148/148; `test:db` 711/711.
- **Backlog:** không có hàng nào cùng module/DoD (BL-176, BL-177 không liên quan).
- **Ngoài phạm vi:** khóa/mở khóa tài khoản (DBS-113); tìm không dấu (`unaccent`); tìm theo số điện thoại/email (không có trong dữ liệu).
- **Quyết định ở G1 (agent tự duyệt):**
  1. **Một tham số `q`.** `GET /v1/operator/accounts?q=<từ khóa>`. Nếu `q` là một UUID đầy đủ → tìm đúng tài khoản đó; ngược lại → khớp một phần, không phân biệt hoa thường, trên `customers.full_name`. `q` dài 1–100 ký tự sau khi bỏ khoảng trắng hai đầu, không có ký tự điều khiển, chuẩn hóa NFC. Ký tự `%`, `_`, `\` trong `q` là chữ, không phải ký tự đại diện.
  2. **Audit không lưu tên khách dạng chữ.** Bộ khóa metadata của audit là danh sách đóng `{id, reason, count}` và chặn mọi văn bản tự do vì tên khách là PII (`audit-metadata.guard.ts`, module-notes «ids and codes only»). Vì vậy DoD «ghi từ khóa» được hiện thực như sau: tìm theo UUID → `target = {account, <uuid>}`; tìm theo tên → `target = {account_search, <32 ký tự đầu của SHA-256(từ khóa đã chuẩn hóa, chữ thường)>}`; luôn có `metadata.count` và người tra là `actor`. Kiểm toán viên kiểm một từ khóa đã biết bằng cách băm nó. **Đây là chỗ lệch có chủ đích so với chữ của DoD** (không lưu chữ thô); lead có thể đổi bằng cách mở rộng danh sách khóa của audit, cần quyết định riêng vì chạm quy tắc PII.
  3. **Chỉ tài khoản của khách.** Tài khoản `SYSTEM` (`funding`) không có chủ nên không bao giờ xuất hiện; tìm bằng id của nó trả danh sách rỗng. Tài khoản LOCKED vẫn xuất hiện (UC-11 cần mở khóa).
  4. **Không phân trang**; luôn tối đa 20 dòng, sắp `full_name, created_at, id` để ổn định. Có thể có nhiều hơn 20 khớp: client thu hẹp từ khóa (không trả «còn nữa» để khỏi lộ quy mô).
  5. Tra cứu rỗng vẫn ghi audit (count 0). Audit lỗi → 500, không trả dữ liệu (fail-closed như `account.list`).
  6. Không đổi schema, `ErrorCode`, env, event; không thêm index.

## 2. Hành vi

`GET /v1/operator/accounts?q=Nguy%E1%BB%85n` (operator):

```json
{
  "items": [
    { "id": "2e859a80-d4d0-471d-8cee-e9d0de9d4bc7", "type": "CHECKING", "status": "ACTIVE", "ownerName": "Nguyễn Minh Anh" },
    { "id": "7c0f1a3e-4b6d-4a8e-9a31-5d2f3f6a1b20", "type": "SAVINGS", "status": "LOCKED", "ownerName": "Nguyễn Văn Bình" }
  ]
}
```

- Không có `balance` (hay bất kỳ số tiền nào) trong phản hồi; mỗi phần tử chỉ có 4 khóa.
- `q` thiếu, rỗng sau khi cắt khoảng trắng, dài hơn 100, có ký tự điều khiển, tham số lạ hoặc lặp lại → `400`.
- Vai khác operator (customer, auditor, admin) → `403`; không token → `401`. (`admin` không kế thừa `operator`, docs/03 §12.)
- Ca biên: `q` = `50%` chỉ khớp tên chứa đúng chuỗi «50%» (không phải ký tự đại diện); `q` = `%` không khớp mọi tên; nhiều hơn 20 khớp → đúng 20 dòng đầu theo thứ tự.
- Mỗi lần gọi hợp lệ (kể cả kết quả rỗng) ghi một hàng audit `operator.account.search`.

## 3. Kiến trúc

- **Vị trí:** module `accounts`, role `api`. File mới: `operator-accounts.controller.ts`, `operator-account-search.service.ts`, `operator-account-search.dto.ts`, `operator-account-search.query.ts` (kiểm tra `q`, escape); `accounts.module.ts` đăng ký.
- **Interface dùng:** `TransactionService.run`, `AuditService.record(manager, …)`.
- **Dữ liệu:** đọc `accounts` ⨝ `customers` (khóa ngoại, PK). Ghi: `audit_log`. Không index mới.
- **Truy vấn:**

```sql
SELECT a.id, a.type, a.status, c.full_name AS "ownerName"
FROM accounts a JOIN customers c ON c.id = a.customer_id
WHERE a.id = $1::uuid                                   -- q là UUID
-- hoặc
WHERE c.full_name ILIKE $1 ESCAPE '\'                   -- $1 = '%' || escape(q) || '%'
ORDER BY c.full_name, a.created_at, a.id
LIMIT 20
```

- **Transaction:** đọc + audit `SUCCESS` trong một `TransactionService.run`; trả dữ liệu sau COMMIT.
- **Sơ đồ UC-3 (docs/03 §6.4):** khớp thiết kế (`GET /v1/operator/accounts` → SELECT tối đa 20 → INSERT audit_log → 200 không số dư). Chỉ bổ sung ghi chú: audit lưu vân tay SHA-256 của từ khóa chứ không lưu tên (quyết định 2).
- **Thay đổi cấp hệ thống:** docs/03 §7 (dòng bảng API) và §6.4 (ghi chú), README `accounts`.

## 4. Test cases tự động

PostgreSQL 17 thật; HTTP thật với JWT thật.

| ID | Truy vết | Lớp | Given · When · Then | Mã |
|---|---|---|---|---|
| TC-88-01 | DoD #1 | e2e HTTP | Tìm theo UUID: đúng một tài khoản, 4 khóa `id,type,status,ownerName`, không `balance`; UUID viết hoa vẫn tìm được | 200 |
| TC-88-02 | DoD #1 | e2e HTTP | Tìm theo tên một phần: «nguyễn» (khác hoa thường) khớp «Nguyễn Minh Anh», cả tài khoản LOCKED và khách có hai tài khoản; không khớp tên khác | 200 |
| TC-88-03 | DoD #1 | e2e HTTP | 25 khách cùng họ: đúng 20 dòng, theo thứ tự `full_name, created_at, id` | 200 |
| TC-88-04 | DoD #1 | e2e HTTP | Tài khoản `funding` (SYSTEM) tìm bằng id → rỗng; khách có số dư lớn: phản hồi không chứa số dư (so khớp với chuỗi số dư thật) | 200 |
| TC-88-05 | DoD #1 | e2e HTTP | `q` có `%`, `_`, `\`: coi là chữ (chỉ khớp tên chứa đúng chuỗi); `q=%` không khớp mọi tên | 200 |
| TC-88-06 | DoD #1 | e2e HTTP | `q` thiếu, rỗng, toàn khoảng trắng, 101 ký tự, ký tự điều khiển, `q` lặp, tham số lạ | 400 |
| TC-88-07 | DoD #2 | e2e HTTP | Mỗi lần tra cứu hợp lệ ghi đúng một hàng `operator.account.search`: actor là operator, `metadata.count` đúng; tìm UUID → `target_id` là UUID; tìm tên → `target_id` là 32 hex đúng SHA-256, không chứa tên; kết quả rỗng vẫn ghi | 200 |
| TC-88-08 | DoD #2 | e2e HTTP | Trigger chặn `audit_log` → 500, không có dữ liệu; khôi phục → 200 | 500 / 200 |
| TC-88-09 | DoD #2 | e2e Postgres | `pg_indexes` không có index nào trên `customers.full_name` | — |
| TC-88-10 | DoD #3 | e2e HTTP | customer, auditor, admin → 403 (không để lại hàng audit tra cứu); không token → 401 | 403 / 401 |
| TC-88-11 | thêm | unit | Bộ kiểm tra `q`: NFC, cắt khoảng trắng, escape `%_\`, phân biệt UUID | — |
| TC-88-12 | thêm | e2e HTTP | Swagger có vai operator, tham số `q`, mã lỗi; `Cache-Control: no-store` | — |
| Quy trình | DoD #4, #5 | — | Sơ đồ §6.4 đã đối chiếu; merge, CI, Dev review | waiver |

## 5. Test thủ công

`node backend/scripts/manual-dbs88.cjs` (Docker, Node 24): app thật, JWT thật, Postgres 17.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-88-01 | Tạo ba khách (Nguyễn Minh Anh có hai tài khoản, Trần Thu Hà, Nguyễn Văn Bình LOCKED); nạp 5.000.000đ cho Minh Anh. Operator tìm `q=nguyễn` | 3 tài khoản, không `balance` |
| M-88-02 | Operator tìm bằng `accountId` của Hà | đúng 1 tài khoản của Hà |
| M-88-03 | Operator tìm `q=%` | rỗng |
| M-88-04 | Customer (Hà) và auditor gọi cùng endpoint | 403 |
| M-88-05 | Đọc `audit_log` | 3 hàng `operator.account.search` của operator với `count` 3, 1, 0; không hàng nào chứa «Nguyễn» hay «Hà» |
| M-88-06 | Tạo 50.000 khách; tìm `q=Nguyễn` | ≤ 20 dòng, `EXPLAIN ANALYZE` của truy vấn là `Seq Scan` trên `customers` (đúng quyết định không index), thời gian ghi lại |
| cleanup | Dọn | `DBS-88 cleanup PASS` |

## 6. Domain review (AI)

**Reviewer:** chính agent (Sonnet 5.5), 2026-11-08; đọc BRD FR-ACC-04/BR-10, docs/03 §6.4/§7/§12, database-design §6.2, `audit-metadata.guard.ts`, DBS-86, `operator-deposits.controller.ts`. Không dùng subagent.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | DoD đòi ghi «từ khóa» vào audit nhưng guard chỉ cho `{id, reason, count}` vì tên khách là PII | Quyết định 2: vân tay SHA-256 + `count`; nêu rõ là lệch chữ DoD |
| 2 | should-fix | `ILIKE` với `%`/`_` do người dùng nhập thành ký tự đại diện → quét/ lộ nhiều hơn ý định | Escape + `ESCAPE '\'`; TC-88-05 |
| 3 | should-fix | Tài khoản `funding` không được lộ qua tìm kiếm | `JOIN customers` loại SYSTEM; TC-88-04 |
| 4 | should-fix | `admin` có thể vô tình truy cập | `@Roles('operator')`, không kế thừa; TC-88-10 |
| 5 | minor | Bảng khách ~50.000 dòng: Seq Scan chấp nhận được (database-design §6.2) | M-88-06 đo và ghi lại |
| 6 | minor | `ILIKE` trên Postgres Alpine (musl) không gấp hoa thường ký tự có dấu như glibc | Test dùng khác biệt hoa thường ở ký tự ASCII và khớp có dấu cùng dạng; tìm không dấu ngoài phạm vi (BL) |
| 7 | minor | Kết quả phụ thuộc thứ tự ổn định giữa các lần gọi | `ORDER BY full_name, created_at, id` |

Không có phát hiện blocking còn mở. Verdict tự đánh giá: APPROVE.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `operator-account-search.query.ts` + `.spec.ts` | TC-88-11 | điền khi chạy | `npm test -- operator-account-search` | `feat(accounts): validate and escape the operator account search term (DBS-88)` |
| 2 | `operator-account-search.service.ts`, `.dto.ts`, `operator-accounts.controller.ts`, `accounts.module.ts`, `test/db/operator-account-search.db-spec.ts` | TC-88-01..10, 12 | điền khi chạy | `npm run test:db -- --runInBand operator-account-search` | `feat(accounts): GET /v1/operator/accounts for operators (DBS-88)` |
| 3 | `scripts/manual-dbs88.cjs` | M-88-01..06 | — | `node backend/scripts/manual-dbs88.cjs` | `test(accounts): DBS-88 manual driver` |
| 4 | docs/03 §7 + §6.4, README accounts, doc này, index, BACKLOG (BL-176, BL không dấu) | — | — | `check-doc-links.mjs` | `docs(accounts): record DBS-88 evidence` |

Rủi ro: endpoint đọc dữ liệu khách → test 403, không số dư, không `funding`. Không migration; lùi bằng `git revert`. Đột biến: bỏ escape (TC-88-05 hỏng); thêm cột `balance` vào SELECT và DTO (TC-88-01/04 hỏng); `@Roles('operator','customer')` (TC-88-10 hỏng); bỏ ghi audit (TC-88-07 hỏng).

**Quyết định ở G3 (agent tự duyệt):** theo bảng trên.

## 8. Kết quả

- **Lệnh kiểm tra** (Node 24.22.2, `backend/`, commit code cuối `b643691`; SHA ở dòng đầu `manual-test.txt`):

| Lệnh | Kết quả |
|---|---|
| `npm run lint:check`, `typecheck`, `build` | đạt (mã thoát 0) |
| `npm test -- --runInBand` | **1089/1089**, 68 suite (+7 ca `operator-account-search.query.spec.ts`) |
| `npm run test:e2e -- --runInBand` (Postgres 17 tạm qua `DATABASE_URL`) | **148/148**, 14 suite |
| `npm run test:db -- --runInBand` | **722/722**, 42 suite (+11 ca, +1 suite so với 711/41 của DBS-87) |
| `node scripts/manual-dbs88.cjs` | 6/6 bước + dọn dẹp đạt |

  0 test bị `.skip/.only/.todo`.

- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-88-01 | `operator-account-search.db-spec.ts` › `TC-88-01` (tìm theo id, viết hoa, thừa khoảng trắng; 4 khóa; không `balance` dù có 5.000.000đ). **Đột biến:** thêm `a.balance` → hỏng | đạt |
| TC-88-02 | `TC-88-02` (tìm theo tên: khác hoa thường ASCII, khách hai tài khoản, tài khoản LOCKED; không khớp → rỗng) | đạt |
| TC-88-03 | `TC-88-03` (25 khách cùng họ → đúng 20 dòng, thứ tự ổn định giữa hai lần gọi) | đạt |
| TC-88-04 | `TC-88-04` (id `funding` và «funding» → rỗng) | đạt |
| TC-88-05 | `TC-88-05` (`50%`, `Lê_`, `\Ngang`, `%`, `_` là chữ). **Đột biến:** bỏ escape → hỏng ở DB và 2 ca unit | đạt |
| TC-88-06 | `TC-88-06` (9 yêu cầu sai → 400, không để lại hàng audit) | đạt |
| TC-88-07 | `TC-88-07` (hàng audit: actor, vai, `count`, `target` là id hoặc đúng 32 hex SHA-256; kết quả rỗng vẫn ghi; log không chứa «Võ/Sáu/Tồn Tại»). **Đột biến:** bỏ ghi audit → hỏng | đạt |
| TC-88-08 | `TC-88-08` (trigger chặn `audit_log` → 500, không dữ liệu; khôi phục → 200) | đạt |
| TC-88-09 | `TC-88-09` (`pg_indexes` không có index chứa `full_name`) | đạt |
| TC-88-10 | `TC-88-10` (customer, auditor, admin → 403, không token → 401, không để lại hàng audit). **Đột biến:** `@Roles('operator','customer')` → hỏng | đạt |
| TC-88-11 | `operator-account-search.query.spec.ts` (7 ca) | đạt |
| TC-88-12 | `TC-88-12` (Swagger: vai, `q` bắt buộc, mã lỗi, DTO không có `balance`) | đạt |
| Quy trình | DoD #4: sơ đồ UC-3 §6.4 đối chiếu và ghi chú audit; DoD #5 | #4 đạt; #5 chưa làm: Dev review (BL-176) |

  12 ca/nhóm đạt, 0 đơn giản hóa. Ca `TC-88-04` của kế hoạch («khách có số dư lớn không lộ số dư») được gộp vào TC-88-01.

- **Test thủ công** (output thô [manual-test.txt](screenshots/DBS-88/manual-test.txt)):

| Bước | Kết quả thật | Kết quả |
|---|---|---|
| M-88-01 | `q=nguyễn`: 3 tài khoản (một LOCKED, một SAVINGS), 4 khóa mỗi dòng, không số dư dù Minh Anh có 5.000.000đ | đạt |
| M-88-02 | `accountId` của Trần Thu Hà → đúng tài khoản của chị | đạt |
| M-88-03 | `q=%` → rỗng | đạt |
| M-88-04 | customer và auditor → 403, không dữ liệu | đạt |
| M-88-05 | 3 hàng audit, `count` 3/1/0, id của Hà, hai vân tay, không có tên; hai lần bị 403 không để lại hàng | đạt |
| M-88-06 | 50.003 khách: 20 kết quả; kế hoạch `Hash Join` với `Seq Scan on customers` (đúng quyết định không index), thực thi 22,5–25,7 ms cho từ khóa trùng 10% tên | đạt |
| cleanup | JWKS, database tạm, container đã dọn | đạt |

  Seed SQL cho user/customer/tài khoản (tên khách đặt bằng SQL) và 50.000 khách ở M-88-06; tiền ở M-88-01 vào qua API nạp tiền.

- **Phạm vi so với §7:** khớp, thêm `docs/03` bảng phiên bản v1.11.
- **Ảnh chụp:** không có (waiver); bằng chứng là `manual-test.txt`.
- **Lệch so với kế hoạch:** (1) **Audit không lưu «từ khóa» dạng chữ** như DoD ghi (G1 câu 2): lưu `accountId` hoặc vân tay SHA-256 vì guard metadata cấm PII; lead có thể đổi bằng cách mở rộng danh sách khóa (quyết định riêng). (2) Ca ILIKE có dấu: chỉ kiểm khác biệt hoa thường ASCII vì gấp hoa thường ký tự có dấu phụ thuộc locale máy chủ (G2 mục 6). (3) Lần chạy đột biến đầu bị áp sai (`sed` không khớp) nên chạy lại bằng Edit; ghi nhận ở đây vì lần đầu kết quả «xanh» là giả.
- **Để lead xem kỹ:** quyết định lưu vân tay thay cho từ khóa trong audit; Seq Scan ~25 ms với từ khóa phổ biến ở 50.000 khách.
- **Bàn giao:** BL-176 (thêm PR này), **BL-178** (tìm không dấu và gấp hoa thường ký tự Việt theo locale).

## 9. Tài liệu đã cập nhật

`docs/03_HIGH_LEVEL_ARCHITECTURE.md` (§6.4 sơ đồ UC-3, §7 dòng bảng API, phiên bản v1.11), `backend/src/modules/accounts/README.md`, `docs/features/README.md`, `docs/BACKLOG.md` (thêm BL-178, thêm PR vào BL-176). Không xóa dòng BL nào.
