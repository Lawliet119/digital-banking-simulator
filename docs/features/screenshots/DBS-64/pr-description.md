## Thay đổi gì

Task: DBS-64
Feature doc: docs/features/DBS-64-read-accounts.md

Thêm GET `/v1/accounts` và GET `/v1/accounts/{id}` cho customer, lọc owner ngay trong SQL. Balance là string chính xác từ PostgreSQL, không cache Redis. Chỉ trả dữ liệu sau audit SUCCESS commit; invalid/foreign/missing/SYSTEM cùng404 sau audit DENIED riêng.

DBS-63 PR58 đã merge vào main `ea1af08`; sau đó đã cập nhật main `e8d7ab6` khi PR45 merge trong lúc CI. Đã rebase riêng phần DBS-64 sau base24d33f4 lên main; PR này base main, giữ nguyên các cập nhật Ledger/Identity/Audit mới. Code đọc không đổi thiết kế; bổ sung kiểm chứng số dư qua API nạp tiền thật hiện đã có trên main.

Kiểm tra sau rebase: lint/typecheck/build xanh;860/860 unit,135/135 e2e,86/86 test PostgreSQL liên quan; thủ công7/7 trên commit `5e700cfeb929d9786b3ed9de6ec0bbc7a53fc179`. Đo HTTP thật gồm JWT/DB/audit: p95 list16.21ms, detail16.29ms, đều dưới150ms. Transcript giữ toàn bộ200mẫu tại `docs/features/screenshots/DBS-64/manual-test.txt`.

## Loại thay đổi

- [x] Tính năng mới
- [x] Tài liệu / ADR
- [x] Test

## Liên quan tới

UC-4, FR-ACC-02, FR-ID-04, BR-10, FR-AUD-02. Public AccountsService và flow ledger giữ nguyên.

## Đối chiếu test case

| DoD / AC | Test | Khớp? |
|---|---|---|
| List/detail own account, balance string | TC-64-01/02/04/11: mở account qua API63; list/detail zero, empty/LOCKED; đọc số dư sau hai lần nạp thật | Khớp đầy đủ |
| Foreign account404 | TC-64-03/05/09: owner SQL filtering, uniform404, persisted DENIED, actual roles và concurrent owner/correlation isolation | Khớp |
| Exact bigint và đọc số dư mới | TC-64-07 +8 mapper unit; TC-64-11/M-64-07: nạp1000000 rồi9007199253740993, cả list/detail trả chính xác9007199254740993; audit SUCCESS,4 ledger lines và invariant PASS | Khớp; BL-147 đã đóng bằng luồng API thật, không seed tiền bằng SQL |
| Audit fail closed | TC-64-06 trigger audit INSERT lỗi: no data/500, recovery; read+audit transaction, denial separate | Khớp |
| No Redis balances | Query service chỉ inject TransactionService/AuditService, explicit PostgreSQL SELECT; status freshness test | Khớp theo dependency boundary và code review; không nhận đã có Redis integration |
| p95<150ms small data | TC-64-10/M-64-05 manual HTTP benchmark: warm10+100 samples mỗi route, concurrency1, JWT+DB+audit+response | Dùng số đo thật trong transcript; không coi là production/load SLO |
| Swagger | TC-64-08 both GET endpoints, DTO/status enums/examples, bearer and error responses | Khớp |
| PR merge main/CI/Dev review | BL-146, final checks trên PR base main | Chờ kết quả CI thật, Dev khác review và merge; dependency đã có |

## Kiểm tra

- [x] Test thủ công7/7, invariant PASS, list p95 16.21ms/detail16.29ms (<150),100 mẫu/route sau10 warmups; đo sơ bộ local, không thay cloud/load SLO
- [x] Có test PostgreSQL và money mapper; không SQL balance seed/fake ledger
- [ ] CI xanh — cần run thật trên main-based PR
- [x] Không secret trong task code; không log token/private key/connection URL
- [x] Feature doc1–9 và independent review APPROVE; user yêu cầu bỏ gate pauses, không nhận đã duyệt4 human gates
- [x] Cập nhật Accounts README, docs03 API, feature index/backlog

## Ghi chú cho người review

Xem owned SELECT JOIN c.user_id từ CurrentUser, safe DTO whitelist và `formatBalance(parseBalance(...))`. Query/audit cùng manager; `recordDenied` chỉ gọi ngoài transaction trước404. UUID path sai không ghi raw path vào metadata. Các lỗi audit/transient giữ mapping500/503 và Retry-After.

`npm run test:db -- --runInBand --runTestsByPath test/db/account-reads.db-spec.ts`; `node scripts/manual-dbs64.cjs` từ backend để lặp functional/performance trên DB/container riêng.

BL-147 đã đóng: nạp qua HTTP thật, GET số dư sau commit, không tạo tiền bằng SQL. Các backlog Identity/DB roles/observability khác giữ nguyên theo main; framework ownership DBS-86 nằm ngoài phạm vi task này. Sheet đang Done không thay bằng chứng Dev review/merge; agent không sửa sheet hay tự merge.

CI trên head9ce0a13 trước cập nhật Risk đã6/6 xanh; sau rebase lên maine8d7ab6 phải kiểm chứng lại CI trên HEAD mới. Accounts code/tests/manual giữ nguyên; đã chạy lại86/86 test PostgreSQL liên quan và manual7/7, p95 mới từ toàn bộ200mẫu. Unit860/e2e135 local là trước cập nhật Risk; full suites của main mới được chứng minh bằng CI cuối.
