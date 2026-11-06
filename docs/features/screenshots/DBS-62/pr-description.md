## Thay đổi gì

Task: DBS-62
Feature doc: docs/features/DBS-62-customer-onboarding.md

Thêm POST/GET `/v1/customers/me` cho customer. POST tạo hoặc trả hồ sơ cũ (200), không đổi tên khi gọi lại; UNIQUE user_id bảo vệ request đồng thời. Ghi audit cùng transaction, lỗi audit rollback và trả lỗi đã che chi tiết.

Nhánh đã rebase lên main a9e607b sau khi AuditService được merge qua PR #54. Diff chỉ gồm thay đổi DBS-62; kiểm tra tích hợp dùng AuditService thật sau review.

Kiểm tra sau rebase: lint/typecheck/build xanh; 135/135 e2e, 65/65 test PostgreSQL của onboarding/AccountsService/AuditService và 6/6 bước thủ công xanh. Lượt unit đầy đủ: 825/826 xanh; retry riêng 12/13, cùng test cooldown JWKS Identity bị lỗi timing trên máy local (BL-112). Identity giữ nguyên trong DBS-62. Xem GitHub checks để xác minh CI.

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
| PR merge main, CI xanh, Dev review | GitHub checks trên Draft PR; Dev review và merge theo quy trình nhóm | Chờ kết quả CI/review/merge; BL-144 |

## Kiểm tra

- [x] Chạy thủ công HTTP với PostgreSQL17 Docker dùng riêng; 6/6 bước đạt, transcript có code SHA
- [x] Test thật; không sửa tiền trong task này
- [ ] CI xanh — cập nhật sau khi GitHub checks hoàn tất
- [x] Không có secret trong code/log/commit của task
- [x] Feature doc đủ mục 1–9, domain review và bằng chứng thủ công; user yêu cầu không dừng G1–G4, không nhận đã duyệt gate
- [x] Cập nhật docs/03, Accounts README, feature index, backlog

## Ghi chú cho người review

Xem INSERT ON CONFLICT rồi SELECT riêng ở READ COMMITTED, audit trong cùng manager/transaction, và chỉ lấy caller từ CurrentUser. Test ở `test/db/customer-onboarding.db-spec.ts`; chạy `npm run test:db -- --runInBand --runTestsByPath test/db/customer-onboarding.db-spec.ts`. Lặp thủ công bằng `node scripts/manual-dbs62.cjs`.

BL-130/132 là gap audit của identity/global role denial hiện có, thuộc task khác. DBS-62 không nhận đã sửa hai gap đó. Bằng chứng thủ công đã chạy lại trên SHA sau rebase, trong `docs/features/screenshots/DBS-62/manual-test.txt`.
