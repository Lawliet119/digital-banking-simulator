## Thay đổi gì

Task: DBS-63
Feature doc: docs/features/DBS-63-open-accounts.md

Thêm `POST /v1/accounts` cho customer mở CHECKING/SAVINGS, số dư chuỗi `"0"`, trạng thái ACTIVE. Khóa hàng customer trước khi đếm và tạo để tối đa ba tài khoản kể cả khi gọi song song. Ghi audit cùng transaction; từ chối hạn mức được commit audit trước khi trả 409.

Mô tả PR đã chuẩn bị; chỉ mở PR vào main sau khi DBS-62 PR #56 được merge và rebase riêng DBS-63 khỏi base7d41a51.

Kiểm tra local: lint/typecheck/build xanh;832/832 unit,135/135 e2e,75/75 test PostgreSQL của bốn suite liên quan; test thủ công6/6 và invariants PASS. Chưa chạy CI của DBS-63 vì chưa mở PR vào main.

## Loại thay đổi

- [x] Tính năng mới
- [x] Tài liệu / ADR
- [x] Test

## Liên quan tới

UC-2, FR-ACC-01, BR-14, FR-AUD-01/02, NFR-AUD-01, ADR-04. Public AccountsService và flow ledger giữ nguyên.

## Đối chiếu test case

| DoD / AC | Test | Khớp? |
|---|---|---|
| Mở CHECKING/SAVINGS, khóa customer trong transaction | TC-63-01/05: HTTP/PostgreSQL thật; thực sự chờ parent row lock, customer khác vẫn mở được | Khớp |
| >=5 request cùng lúc, đúng3 tài khoản | TC-63-03: 10 request đầu cùng lúc ->3x201+7x409 ACCOUNT_LIMIT_REACHED; kiểm DB và audit theo từng correlationId | Khớp |
| Giới hạn3 gồm LOCKED và theo từng chủ | TC-63-02/04/05: tuần tự, hai customer độc lập và status fixture LOCKED | Khớp |
| Audit, zero balance, cấm SYSTEM | TC-63-01/06/08: balance là string0, SYSTEM/forged body400; trigger audit lỗi rollback, rejection/denial fail closed | Khớp |
| Bảo mật | TC-63-07: JWT thật, customer/staff, missing/expired; chưa onboarding404 có DENIED audit riêng | Khớp |
| Swagger / lỗi tạm thời | TC-63-09/10: enum/examples/errors; khóa thật quá timeout503 + Retry-After, nhả khóa retry201 | Khớp |
| PR merge main / CI / Dev review | Chờ dependency và PR; BL-145 | Chưa đạt; local xanh chưa chứng minh CI |

## Kiểm tra

- [x] Test thủ công HTTP với PostgreSQL17 Docker riêng, 6/6 bước và invariant PASS, transcript có code SHA
- [x] Test thật PostgreSQL; invariant checker sau mọi case nghiệp vụ; không seed số dư/bút toán bằng SQL
- [ ] CI xanh — cần kiểm chứng trên PR vào main sau khi dependency merge
- [x] Không secret trong code/log/commit task; không log token/private key/connection URL
- [x] Feature doc đủ mục1–9, independent review APPROVE và ảnh/raw output; user yêu cầu bỏ gate pauses, không nhận đã có4 human approvals
- [x] Đã cập nhật Accounts README, docs03 API, feature index và backlog

## Ghi chú cho người review

Xem parent row lock trước COUNT, các nhánh audit SUCCESS/REJECTED cùng manager, `recordDenied` chỉ gọi sau transaction đầu đã kết thúc. Không nhận owner/balance/status từ client. Count bao gồm tài khoản LOCKED. Chỉ API theo protocol này bảo đảm hạn mức; admin SQL ngoài flow không được coi là đã có CHECK bảo vệ.

Chạy `npm run test:db -- --runInBand --runTestsByPath test/db/account-opening.db-spec.ts`, test tay `node scripts/manual-dbs63.cjs` từ backend. Script dùng database/container riêng và tự dọn.

BL-112/121 là timing test hiện có; BL-130/132 thuộc identity/global role-denial audit; BL-017 về application DB roles chưa được task này giải quyết. Dev reviewer và merge phải có bằng chứng riêng.
