# DBS-158 · Test bảo mật tập trung: truy cập chéo, auditor chỉ đọc, khách không thấy cờ

> **Trạng thái:** Kiểm chứng cục bộ; chờ CI và Dev review (DoD 3 «kịch bản Demo 4 ghi lại»: đã viết ở [docs/demos/demo-4-security-audit.md](../demos/demo-4-security-audit.md), BL-237) · **Vai:** Dev · **Nhánh:** `test/DBS-158-security-suite` · **PR:** [#136](https://github.com/Lawliet119/digital-banking-simulator/pull/136) · **Cập nhật:** 2026-11-11

> **Ghi chú về lịch sử (2026-11-11):** bản đầu của PR có bảy test lặp lại các test đã có trên `main` và yếu hơn (TC-86-02/03, TC-87-06, TC-61-03, TC-65-05, TC-159-01, TC-87-09), không chứng minh DoD 2, bằng chứng thủ công gắn sai SHA, và gây xung đột ở `deposit-app.ts` (option `auditHttp` trùng option `audit` của #138). Một review độc lập (subagent, 2026-11-11) chỉ ra điều đó; bản này giữ **phần mới thật sự** và trỏ tới các test cũ. G1 đến G3 và domain review độc lập lúc làm bản đầu không được ghi; không dựng lại dấu vết đó.

## 1. Bối cảnh

- **Task trên board:** Story, Tuần 5, High, Demo 4. **Expect:** «Bằng chứng gọn cho Demo 4 (security & audit review).» **Thực trạng:** «Các kiểm tra quyền nằm rải rác trong test từng module.»
- **DoD (chép nguyên văn từ board):**
  1. Suite backend/test/security: AC-5.8 (truy cập chéo → 404 + audit DENIED), AC-8.1 (auditor chỉ đọc), AC-10.2 (khách không thấy cờ)
  2. Không endpoint nào trả stack trace, SQL hay dữ liệu của người khác; lỗi luôn problem+json
  3. Chạy trong CI; mỗi test gắn id test case; kịch bản Demo 4 ghi lại
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:** DBS-86, DBS-103 Done; **DBS-131 ghi `In Review` trên board** (không phải Done): phần AC-10.2 dựa vào test của DBS-87/DBS-131 đã có trên `main`.
- **Đã có trên `main` (không viết lại):** AC-5.8 qua TC-86-02/03 (`resource-ownership.db-spec.ts`), TC-87-06 (`transaction-history.db-spec.ts`), TC-61-03 (`customer-transfers.db-spec.ts`), TC-65-05 (`money-flow.db-spec.ts`), TC-159-01/03 (`auth-attacks.db-spec.ts`); AC-8.1 qua `audit-search.http.db-spec.ts`; AC-10.2 qua TC-87-09 (`transfer-status.db-spec.ts`, `transaction-history.db-spec.ts`) và `fraud-operator-http.db-spec.ts`.
- **Phần mới của task này:** (a) DoD 2: mọi lỗi 401/403/404/400 và route lạ là `application/problem+json` có `correlationId` và không lộ stack, SQL hay đường dẫn nội bộ; (b) AC-8.1 rộng hơn: auditor bị từ chối (403 `FORBIDDEN`) trên **mọi** route ghi (bảy route), và không bảng nào đổi (`transfers`, `ledger_entries`, `accounts`, `customers`, `outbox_events`, `fraud_flags`, `audit_log`); (c) suite nằm ở `backend/test/security` như DoD 1 và được `test:db` chạy (regex của `jest-db.js` mở thêm `test/security`).
- **Quyết định (agent tự quyết):** không lặp lại test có sẵn; ghi tham chiếu ở đây. DoD 3 «kịch bản Demo 4» viết sau ở `docs/demos/demo-4-security-audit.md` (BL-237).
- **Ngoài phạm vi:** kịch bản Demo 4, 403 của `RolesGuard` chưa ghi audit `DENIED` (BL-132), phần cloud.

## 2. Hành vi

| # | Điều kiện | Kết quả |
|---|---|---|
| S1 | không token, sai vai, tài khoản của người khác, id sai dạng, query sai, route lạ | status 401/403/404/404/400/404; `Content-Type: application/problem+json`; thân có `status` đúng và `correlationId`; không có `stack`, đường dẫn `.ts`, `node_modules`, câu SQL, `QueryFailed`, tên `pg_*` |
| S2 | token auditor gọi từng route ghi (`POST /v1/transfers`, `/v1/operator/deposits`, `/v1/accounts`, `/v1/customers/me`, lock, unlock, review cờ) | 403 `FORBIDDEN`; số dòng của bảy bảng trên không đổi |

## 3. Kiến trúc

`backend/test/security/security-boundaries.db-spec.ts` (HTTP thật qua `startDepositApp(url, { audit: true, fraud: true })`, PostgreSQL thật qua Testcontainers); `backend/test/jest-db.js` (regex). Không đổi mã chạy, schema, env.

## 4. Test cases tự động

| ID | Truy vết | Lớp | Nội dung |
|---|---|---|---|
| TC-158-01 | DoD 2 | integration (PostgreSQL thật) | S1 |
| TC-158-02 | DoD 1 (AC-8.1) | integration | S2 |
| TC-158-03 | DoD 1 (AC-5.8, AC-10.2) | tham chiếu | TC-86-02/03, TC-87-06, TC-61-03, TC-65-05, TC-159-01/03, TC-87-09: đã có trên `main`, không viết lại |
| TC-158-04 | DoD 3 | quy trình | mỗi test có id; CI chạy `test:db` (job `db`); Demo 4: `docs/demos/demo-4-security-audit.md` (BL-237) |
| TC-158-05 | DoD 4 | quy trình | PR merge, CI xanh, Dev review |

## 5. Test thủ công

Suite chỉ là test tự động; không có thao tác người dùng. Bước duy nhất: `npm run test:db -- test/security/security-boundaries.db-spec.ts` trên commit cuối, kết quả ở `screenshots/DBS-158/manual-test.txt` (SHA ở dòng đầu).

## 6. Domain review (AI)

Review độc lập (subagent, 2026-11-11), nguyên văn không lưu. Phát hiện và xử lý: DoD 2 không có test (đã thêm TC-158-01); bảy test trùng test cũ (đã bỏ, ghi tham chiếu); xung đột `deposit-app.ts` (bỏ thay đổi, dùng option `audit`); AC-8.1 chỉ thử hai route (đã phủ bảy route, kiểm không ghi gì); AC-10.2 yếu hơn TC-87-09 (không viết lại); `jest-db.js` mở regex sang `.spec.ts` (đã thu hẹp về `test/(db|security)/…db-spec.ts`); DoD không chép nguyên văn, §9 thiếu, SHA sai (đã sửa); kịch bản Demo 4 chưa làm (BL-237). Chưa có lượt review thứ hai. Self-review đầu bị loại.

## 7. Kế hoạch triển khai

Một commit viết lại test và doc, một commit bằng chứng. Lùi: revert; không đổi mã chạy.

## 8. Kết quả

- `test/security/security-boundaries.db-spec.ts`: 2 test đạt trên PostgreSQL thật; lint và typecheck sạch.
- **Chưa làm:** ảnh chụp (đầu ra là log test), review độc lập thứ hai, DoD 4.
- **Bàn giao:** BL-237 đã xử lý (2026-11-13): kịch bản Demo 4 ghi ở [docs/demos/demo-4-security-audit.md](../demos/demo-4-security-audit.md), trỏ tới các test nêu ở §1 (kèm file và id test case, đã kiểm bằng `git grep` và chạy lại) và lệnh chạy bộ test. Phần chạy tay của kịch bản chưa được quay hay chạy trọn một lượt; trạng thái Draft ghi trong chính tài liệu đó.

## 9. Tài liệu đã cập nhật

`docs/features/README.md`, `docs/BACKLOG.md` (BL-237), doc này.

## Checklist G4 (2026-11-11)

- [x] 2 test mới đạt đủ độ sâu; AC-5.8 và AC-10.2 dựa vào test có sẵn (đơn giản hóa so với DoD «suite»: nêu ở §1)
- [x] Test thủ công trên commit cuối (SHA ở dòng đầu `manual-test.txt`)
- [ ] Ảnh chụp: không có (lý do ở §8)
- [ ] G1 đến G3 và domain review độc lập lúc làm: không có (ghi ở đầu tài liệu)
- [x] Bàn giao và DoD chưa đạt ở §8 và BL-237
