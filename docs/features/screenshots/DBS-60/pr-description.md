## Thay đổi gì

Task: DBS-60
Feature doc: docs/features/DBS-60-operator-deposits.md

Thêm POST `/v1/operator/deposits` chỉ operator. Một transaction ghi key, khóa funding/đích qua AccountsService, DEPOSIT transfer, hai ledger entries, hai số dư, audit, TransferCompleted outbox và response key. Lỗi ở bất kỳ bước nào rollback toàn bộ; đích không ACTIVE commit REJECTED rồi422.

Bản thô theo board: **key đã dùng trả409 để không ghi tiền lần hai**. Full replay cùng body và conflict khác body thuộc DBS-79, không nhận đã hoàn thành AC-5.3/4/5. Hash/result đã lưu để tích hợp tiếp. Không dùng code từ các nhánh62–64.

## Loại thay đổi

- [x] Tính năng mới
- [x] Tài liệu / ADR
- [x] Test

## Liên quan tới

UC-3, FR-LED-01/05/06 (replay phần79), BR-01/02/04/07/09, ADR-04/05/07/09, event contract DEPOSIT. BL-002 đã giải quyết; BL-122 chỉ còn phần transfer; BL-148 replay79 và BL-149 review/merge.

## Đối chiếu test case

| DoD / AC | Test | Khớp? |
|---|---|---|
| Operator-only, key bắt buộc, amount string | TC-60-04/05: JWT thật, thiếu/expired401, các role khác403, key thiếu400 code,128/129 boundary, DTO money/UUID/extra fields | Khớp |
| Atomic double entry + key/audit/outbox | TC-60-01: nạp1m, funding -1m/đích1m, exactly2 lines balance_after, audit1/outbox1/key1; invariant PASS | Khớp |
| SYSTEM nguồn âm, không hạn mức/số dư nguồn | TC-60-02: nạp300m, snapshot âm, event null owner/false sameOwner/DBtimeZ | Khớp |
| LOCKED/missing/SYSTEM đích REJECTED422 | TC-60-03: rejected transfer+audit+key commit, no money/lines/event; metadata giữ requested UUID khi FKNULL | Khớp |
| Đồng thời/không nhân đôi tiền | TC-60-06:10 distinct keys,10 same key (one201/nine409), user-scoped key | Khớp với bản thô; exact replay response chưa làm79 |
| Fail closed | TC-60-07/08/09/09b: DB trigger audit/outbox/CREDIT/account UPDATE/final key UPDATE lỗi; mọi state rollback; same-key retry/rejected audit fault | Khớp |
| Transient retry | TC-60-10: funding locktimeout503 +Retry-After, key rollback, nhả khóa/same-key retry201 | Khớp |
| Exact money/capacity | TC-60-11: >2^53 qua API/DB/ledger/event, funding reaches min only via API, overflow500 atomically | Khớp |
| Funding integrity/OpenAPI/registry | TC-60-12/13: funding thiếu500, Swagger roles/key/errors; real AppModule e2e | Khớp |
| PR merge/CI/Dev review | Checks thật trên Draft PR, Dev review/merge | Đang chờ BL-149 |

## Kiểm tra

- [x] HTTP manual6/6 trên PostgreSQL17 Docker riêng; actual ledger/audit/outbox/key counts và invariant PASS
- [x] Lint/typecheck/build;826 unit,135 e2e,104 PostgreSQL tests liên quan; deposit suite16/16 trên code cuối
- [ ] CI xanh — cập nhật từ GitHub checks sau khi chạy
- [x] Không secret trong task code/log; không log JWT/private key/connection URL
- [x] Feature doc1–9, raw independent review APPROVE và manual screenshot/transcript có final code SHA; user yêu cầu không dừng gates, không nhận đã có4 human gate approvals
- [x] Cập nhật ledger README/docs03/index/backlog; không đổi schema/env/ADR/event contract

## Ghi chú cho người review

Xem thứ tự reserve key/ordered locks/guards trước UPDATE; REJECTED throw chỉ sau commit; mọi ghi tiền qua public AccountsService cùng outermost manager. Event fromUserId null/sameOwner false/fromBalanceBefore signed/occurredAt từ DB. Audit metadata giữ đích yêu cầu, không PII. Không Redis/SQS/HTTP trong callback.

SQL input fixtures chỉ tạo users/customers/accounts tại default zero vì main chưa có opening API; không seed số dư/bút toán hoặc fake business service. Không claim kiểm production DB grants (BL-017) hay hoàn thành replay79. Chạy `npm run test:db -- --runInBand --runTestsByPath test/db/operator-deposits.db-spec.ts`; test tay `node scripts/manual-dbs60.cjs` từ backend.
