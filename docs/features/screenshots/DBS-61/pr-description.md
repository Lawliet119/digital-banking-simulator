## Thay đổi gì

Task: DBS-61
Feature doc: docs/features/DBS-61-customer-transfers.md

Customer POST `/v1/transfers` kiểm quyền nguồn, khóa hai account theo id, kiểm ACTIVE/số dư, ghi transfer +hai ledger entries +hai số dư +audit +outbox +key result trong một transaction. Thiếu tiền trả422 INSUFFICIENT_FUNDS sau khi commit REJECTED; không đổi tiền/bút toán. Foreign/missing/SYSTEM nguồn404 kèm DENIED audit riêng; đích SYSTEM/missing/LOCKED422 ACCOUNT_NOT_ACTIVE.

**Chưa mở PR:** nhánh tạm kế thừa DBS-60 theo cho phép của người dùng. Chờ PR57 merge vào main, rebase riêng DBS61, chạy lại kiểm chứng/manual trên SHA mới rồi dùng nội dung này tạo Draft PR base main. Không dùng nhánh DBS60 làm base PR.

## Loại thay đổi

- [x] Tính năng mới
- [ ] Sửa lỗi
- [ ] Hạ tầng / CI
- [x] Tài liệu / ADR
- [x] Test

## Liên quan tới

UC-5, FR-LED-02/03/06, BR-02/03/09/10, AC-5.1/5.2/5.7/5.8; ADR-04/05/07/09 và TransferCompleted contract. Chỉ bản thô: chưa full-limit FR-LED-04/AC5.6; chưa replay AC5.3/4/5 (DBS-79). Key đã dùng409 an toàn. BL-003/122 resolved; BL-148,BL-152/151 handoff.

## Đối chiếu test case

Test file: `backend/test/db/customer-transfers.db-spec.ts`, thực sự gọi HTTP +JWT +PostgreSQL17; seed tiền qua operator deposit API.

| DoD / AC | Test | Khớp? |
|---|---|---|
| DoD1 customer/key/ownership | TC03,TC05,TC11 real JWT/roles/keys/404/DENIED/failclosed | Khớp |
| DoD2 atomic double entry, AC5.1 | TC01 exact balances700k/300k +2lines/balance_after +audit/event/key; TC06 concurrent withdrawals/cross-transfer | Khớp |
| DoD2 rollback | TC08 five actual success-write fault triggers +two rejection-write faults; TC09 real lock timeout503/recovery; TC10 signed64overflow500/no effects | Khớp |
| DoD3 insufficient; DoD4 AC5.2 | TC02 source100k transfer300k422problem+json; persistedREJECTED/key/audit, money/lines/eventsunchanged | Khớp |
| ACTIVE; AC5.7 | TC04 lockedsource/target,missing/SYSTEM target422 including FKnull semantics | Khớp |
| Ownership; AC5.8 | TC03/11 foreign/missing/SYSTEM sources404+DENIED; actual auditfault500 | Khớp |
| Money/string/event contract | TC01 DBtimes/owners/CID/hash; TC07 sameOwnertrue; TC10 >2^53 exact API/DB/event | Khớp |
| API contract | TC05 validation,TC12 Swagger statuses/key/body | Khớp |
| DoD5 CI/Dev review/merge | Draft PR base main; final checks/review/merge | Chưa làm,BL-152 |
| Replay / full limits | Safe409 barrier TC07; full replay79 and full syncguard week3 | Ngoài phạm vi bản thô,BL-148/151; không claim các AC đầy đủ |

## Kiểm tra

- [x] Docker compose local đang chạy; actual HTTP/PG17 manual workflow6/6 đạt trên owned database/container
- [x] Test tiền PostgreSQL thật:19/19 DBS61,123/123 relatedDB (5 explicit suites); e2e135/135 (after rebase96.796s)
- [ ] Full unit xanh:824/826,hai lỗi inherited BL-112 JWKS cooldown; baseline826/826. Không sửa Identity trong DBS61
- [ ] CI xanh — chưa có PR/CI; phải cập nhật trên SHA sau rebase
- [x] Không có secret trong code/log/evidence
- [x] Feature doc1–9 và review độc lập; manual-test.txt có SHA code58d628e, ảnh thật tại docs/features/screenshots/DBS-61/
- [x] Đã cập nhật ledger README,docs03 API maturity,feature index,BACKLOG

## Ghi chú cho người review

Xem guard sau orderedlock, deny audit ngoài transaction, throw422 sau commit, fault rollback trước/sau balancewrites và final keyUPDATE. Không có Redis/SQS/HTTP trong transaction. Không đổi migration/event/env/dependency; không fake AuditService/AccountsService.

Account fixtures SQL INPUT ở defaultzero vì onboarding chưa vào main; toàn bộ tiền vào qua deposit API. Chạy `npm run test:db -- --runInBand customer-transfers` và `node scripts/manual-dbs61.cjs` từ backend. Cần Docker; không có Docker thì fail rõ, không skip xanh.

Full unit có hai lỗi timing BL-112 ngoài Ledger. 10samekey chỉ chứng minh oneexecution/nine409, chưa phải same-response replay. Hạn mức lần/ngày chưa thực thi ở endpoint bản thô; cần tuần3. Không merge hoặc chuyển Done khi dependency/CI/review chưa hoàn thành.
