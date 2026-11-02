## Thay đổi gì

Task: DBS-62
Feature doc: docs/features/DBS-62-customer-onboarding.md

Thêm POST/GET `/v1/customers/me` cho customer. POST tạo hoặc trả hồ sơ cũ (200), không đổi tên khi gọi lại; UNIQUE user_id bảo vệ request đồng thời. Ghi audit cùng transaction, lỗi audit rollback và trả lỗi đã che chi tiết.

Chỉ dùng mô tả này để mở PR sau khi DBS-56 có trên main và rebase các commit DBS-62; không đưa merge dependency tạm vào PR.

## Loại thay đổi

- [x] Tính năng mới
- [x] Tài liệu / ADR
- [x] Test

## Liên quan tới

UC-1, FR-ID-02, FR-AUD-01/02. Board ghi FR-ACC-01 nhưng docs/02 dùng mã đó cho mở tài khoản UC-2; DBS-62 không mở tài khoản hoặc thay đổi tiền.

## Đối chiếu test case

| DoD / AC | Test | Khớp? |
|---|---|---|
| Customer tạo đúng một hồ sơ, replay nhất quán | TC-62-01/02: HTTP + JWT thật + PostgreSQL; response, row/audit, replay khác tên không đổi hồ sơ | Khớp |
| Request song song | TC-62-03: 20 POST đầu tiên đồng thời; một users/customer/creation audit, 19 read audit | Khớp |
| Swagger ví dụ/mã lỗi | TC-62-08 OpenAPI và DTO examples; 401/403 hiện có, 400/404/500 theo HTTP | Khớp; không nhận đã thao tác Swagger UI |
| Sở hữu và phân quyền | TC-62-04/05: missing/expired JWT, staff403, owner GET, giả userId/role400 | Khớp |
| Validation/PII | TC-62-06: tên Việt, độ dài/control/SQL-like input; metadata chỉ id | Khớp |
| Audit fail-closed | TC-62-07: trigger thật làm audit INSERT lỗi; POST rollback, GET/replay không trả hồ sơ; retry sau phục hồi | Khớp |
| PR merge main, CI xanh, Dev review | GitHub checks/review sau khi dependency merge và mở PR | Chưa đạt; BL-144 |

## Kiểm tra

- [x] Chạy thủ công HTTP với PostgreSQL17 Docker dùng riêng; 6/6 bước đạt, transcript có code SHA
- [x] Test thật; không sửa tiền trong task này
- [ ] CI xanh — cần run thật trên PR
- [x] Không có secret trong code/log/commit của task
- [x] Feature doc đủ mục 1–9, domain review và bằng chứng thủ công; user yêu cầu không dừng G1–G4, không nhận đã duyệt gate
- [x] Cập nhật docs/03, Accounts README, feature index, backlog

## Ghi chú cho người review

Xem INSERT ON CONFLICT rồi SELECT riêng ở READ COMMITTED, audit trong cùng manager/transaction, và chỉ lấy caller từ CurrentUser. Test ở `test/db/customer-onboarding.db-spec.ts`; chạy `npm run test:db -- --runInBand --runTestsByPath test/db/customer-onboarding.db-spec.ts`. Lặp thủ công bằng `node scripts/manual-dbs62.cjs`.

BL-130/132 là gap audit của identity/global role denial hiện có, thuộc task khác. DBS-62 không nhận đã sửa hai gap đó. Cần merge AuditService thật trước, rebase khỏi temporary base 08e605e, xác minh lại code SHA/bằng chứng và CI.
