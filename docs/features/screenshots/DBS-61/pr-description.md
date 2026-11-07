## Thay đổi gì

Khách chuyển tiền cho khách khác bằng `POST /v1/transfers`. Endpoint kiểm quyền tài khoản nguồn, khóa hai tài khoản theo thứ tự id, kiểm ACTIVE và số dư, rồi ghi transfer, hai dòng sổ, hai số dư, audit, outbox và kết quả của key trong một transaction. Thiếu tiền hoặc tài khoản không ACTIVE trả 422 sau khi commit transfer REJECTED, không đổi tiền và không có bút toán. Nguồn của người khác, không tồn tại hoặc SYSTEM trả 404 kèm audit DENIED ghi riêng. Lệnh chuyển tới tài khoản `funding` không khóa hàng `funding`, nên không xếp hàng sau lệnh nạp tiền.

Task: DBS-61
Feature doc: docs/features/DBS-61-customer-transfers.md

## Loại thay đổi

- [x] Tính năng mới
- [ ] Sửa lỗi
- [ ] Hạ tầng / CI
- [x] Tài liệu / ADR
- [x] Test

## Liên quan tới

UC-5, FR-LED-02/03/06, BR-02/03/09/10, AC-5.1, AC-5.2, AC-5.7, AC-5.8; ADR-04/05/07/09 và hợp đồng event `TransferCompleted`.

Đây là bản thô. Chưa có hạn mức theo lần và theo ngày (FR-LED-04, AC-5.6, BL-154). Chưa có replay response cũ (AC-5.3/4/5, DBS-79, BL-148): dùng lại key chỉ trả 409. Rate limit và `SESSION_REVOKED` chưa có (BL-155). Dòng BACKLOG đã xử lý: BL-003, BL-122.

## Đối chiếu test case

Test: `backend/test/db/customer-transfers.db-spec.ts` (HTTP, JWT và PostgreSQL 17 thật; tiền được nạp qua API nạp tiền của operator).

| DoD / AC | Test | Khớp? |
|---|---|---|
| DoD #1: customer, key bắt buộc, nguồn thuộc người gọi | TC-61-03, 05, 11, 13 | khớp |
| DoD #2: bút toán kép nguyên tử, AC-5.1 | TC-61-01, 06, 14 | khớp (AC-5.9 người gửi → tài khoản nóng: BL-156) |
| DoD #2: rollback | TC-61-08 (7 ca), 09, 10 | khớp |
| DoD #3: thiếu tiền, AC-5.2 | TC-61-02 | khớp |
| ACTIVE, AC-5.7 | TC-61-04 | khớp |
| Quyền sở hữu, AC-5.8 | TC-61-03, 11, 13 | khớp |
| Số tiền, chuỗi, event | TC-61-01, 07, 10 | khớp |
| API và Swagger | TC-61-05, 12 | khớp |
| DoD #4: AC-5.1 và AC-5.2 trên Postgres thật | TC-61-01, 02 | khớp |
| DoD #5: CI, Dev review, merge | — | chờ review và merge (BL-153) |
| Replay, hạn mức đầy đủ | TC-61-07 chỉ kiểm rào chắn 409 | ngoài phạm vi bản thô (BL-148, BL-154) |

## Kiểm tra

- [x] Chạy được ở local với `docker compose` (test manual dùng Testcontainers: `node scripts/manual-dbs61.cjs`, 6/6 bước đạt trên commit `b34bec7`)
- [x] Có test; logic về tiền được test trên PostgreSQL thật (`test:db` đầy đủ 390/390; `customer-transfers` 21/21)
- [ ] CI xanh: chưa có kết quả trên đầu mới sau khi rebase lên `main` (06a276a); xem tab Checks của PR. CI chạy trước khi rebase (đầu `e2e2d75`) đã xanh 6/6
- [x] Không có secret trong code, log, commit (transcript manual đã kiểm không có token, header Authorization, chuỗi kết nối hay ARN)
- [x] Feature doc đủ mục 1–9 (đã qua 4 gate): G1, G2, G3 được duyệt khi làm bù, G4 đã được duyệt. Test thủ công đã chạy 6/6, ảnh chụp ở `docs/features/screenshots/DBS-61/`
- [x] Đã cập nhật tài liệu: docs/03, README module ledger, chỉ mục feature, BACKLOG

Unit: 831/832, một test hỏng trong `jwks-verifier.service.spec.ts` thuộc BL-112 (lỗi thời gian của module identity, mỗi lần chạy hỏng một test khác nhau, không sửa Identity). e2e 135/135.

## Ghi chú cho người review

- Xem `transfer.service.ts`: kiểm lại chủ sở hữu sau khi khóa, DENIED ghi ngoài transaction, 422 chỉ ném sau commit, và điều kiện bỏ khóa `funding` (đúng khi `funding` là tài khoản SYSTEM duy nhất, ADR-09).
- Không có Redis, SQS hay HTTP trong transaction. Không đổi migration, event, `ErrorCode`, biến môi trường hay dependency.
- Chạy lại: từ `backend/`, `npm run test:db -- customer-transfers` và `node scripts/manual-dbs61.cjs` (cần Docker và Node 24). Nếu máy có PostgreSQL chiếm cổng 5432, chạy e2e với `DATABASE_URL` trỏ tới một Postgres khác.
- Số lệnh trong cùng một key chỉ chứng minh một lần thực thi và các lần còn lại trả 409, chưa phải replay cùng response.
