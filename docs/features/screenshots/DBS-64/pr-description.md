## Thay đổi gì

Task: DBS-64
Feature doc: docs/features/DBS-64-read-accounts.md

Thêm GET `/v1/accounts` và GET `/v1/accounts/{id}` cho customer, lọc owner ngay trong SQL. Balance là string chính xác từ PostgreSQL, không cache Redis. Chỉ trả dữ liệu sau audit SUCCESS commit; invalid/foreign/missing/SYSTEM cùng404 sau audit DENIED riêng.

PR này chỉ được mở vào main sau khi dependency DBS-63 được merge, rồi rebase riêng commit DBS-64 khỏi base24d33f4. Không đưa các commit62/63 vào PR64.

Kiểm tra local: lint/typecheck/build xanh;834/834 unit,135/135 e2e,84/84 test PostgreSQL liên quan; thủ công6/6. Đo HTTP thật gồm JWT/DB/audit: p95 list23.63ms, detail21.18ms. Transcript/samples và SHA9660737 tại `docs/features/screenshots/DBS-64/manual-test.txt`.

## Loại thay đổi

- [x] Tính năng mới
- [x] Tài liệu / ADR
- [x] Test

## Liên quan tới

UC-4, FR-ACC-02, FR-ID-04, BR-10, FR-AUD-02. Public AccountsService và flow ledger giữ nguyên.

## Đối chiếu test case

| DoD / AC | Test | Khớp? |
|---|---|---|
| List/detail own account, balance string | TC-64-01/02/04: HTTP/JWT/PostgreSQL thật, zero accounts qua API63, empty/LOCKED và fresh committed status | Khớp cho trạng thái/số dư zero |
| Foreign account404 | TC-64-03/05/09: owner SQL filtering, uniform404, persisted DENIED, actual roles và concurrent owner/correlation isolation | Khớp |
| Exact bigint | TC-64-07 + mapper unit: PostgreSQL projection/mapper >2^53 và max bigint; strict safe DTO | Đơn giản hóa: không nhận đã kiểm actual account balance >2^53 qua HTTP; BL-147 chờ depositAPI thật |
| Audit fail closed | TC-64-06 trigger audit INSERT lỗi: no data/500, recovery; read+audit transaction, denial separate | Khớp |
| No Redis balances | Query service chỉ inject TransactionService/AuditService, explicit PostgreSQL SELECT; status freshness test | Khớp theo dependency boundary và code review; không nhận đã có Redis integration |
| p95<150ms small data | TC-64-10/M-64-05 manual HTTP benchmark: warm10+100 samples mỗi route, concurrency1, JWT+DB+audit+response | Dùng số đo thật trong transcript; không coi là production/load SLO |
| Swagger | TC-64-08 both GET endpoints, DTO/status enums/examples, bearer and error responses | Khớp |
| PR merge main/CI/Dev review | BL-146 | Chờ dependency, actual CI/review/merge |

## Kiểm tra

- [x] Test thủ công6/6, invariant PASS, list p95 23.63ms/detail21.18ms (<150),100 mẫu/route sau10 warmups; local small data, không nhận đã chứng minh cloud/load SLO
- [x] Có test PostgreSQL và money mapper; không SQL balance seed/fake ledger
- [ ] CI xanh — cần run thật trên main-based PR
- [x] Không secret trong task code; không log token/private key/connection URL
- [x] Feature doc1–9 và independent review APPROVE; user yêu cầu bỏ gate pauses, không nhận đã duyệt4 human gates
- [x] Cập nhật Accounts README, docs03 API, feature index/backlog

## Ghi chú cho người review

Xem owned SELECT JOIN c.user_id từ CurrentUser, safe DTO whitelist và `formatBalance(parseBalance(...))`. Query/audit cùng manager; `recordDenied` chỉ gọi ngoài transaction trước404. UUID path sai không ghi raw path vào metadata. Các lỗi audit/transient giữ mapping500/503 và Retry-After.

`npm run test:db -- --runInBand --runTestsByPath test/db/account-reads.db-spec.ts`; `node scripts/manual-dbs64.cjs` từ backend để lặp functional/performance trên DB/container riêng.

BL-147 là bằng chứng nonzero HTTP chưa có do deposit flow chưa built; BL-112/121/017/130/132 và phần ownership framework DBS-86 giữ đúng phạm vi đã bàn giao. Không claim đóng các gap đó.
