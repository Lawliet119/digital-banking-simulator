# ledger 🔴 Core — #1

Mọi đồng tiền vào, ra, di chuyển. Nơi duy nhất được phép thay đổi số dư.

> **Status:** Schema, trigger, công cụ kiểm bất biến, nạp/chuyển tiền, sync guard implemented · **Owner:** Dev (Ledger) · **Verified against code:** migration/DB tests, DBS-60/61; replay idempotency, hạn mức lần/ngày đã có; scheduler đối soát còn chờ.

Migration `AddAppendOnlyTriggers1792627200002` bật hai trigger cho mỗi bảng `transfers`, `ledger_entries`: BEFORE UPDATE/DELETE theo hàng và BEFORE TRUNCATE theo statement, cùng hàm `public.forbid_mutation()` của [DBS-27](../../../../docs/features/DBS-27-append-only-triggers.md). INSERT vẫn được phép; mutation có hàng và TRUNCATE kể cả bảng rỗng trả SQLSTATE `42501` từ RAISE của hàm. UPDATE/DELETE không khớp hàng trả 0 hàng. Test dùng owner NOSUPERUSER và đối chứng quyền sau down; quyền production và chủ view `v_transfer_facts` còn chờ task roles (BL-005). Revert chỉ gỡ trigger/hàm, giữ dữ liệu và sequence nhưng làm mất lớp bảo vệ này; không dùng revert như cách sửa dữ liệu nghiệp vụ.

|             |                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Use case    | UC-3 nạp tiền · UC-5 chuyển tiền · UC-6 lịch sử · UC-7 trạng thái giao dịch                                                      |
| Chạy ở      | `api`; job đối soát chạy ở `worker` (scheduler bị chặn ở role `api`, ADR-13)                                                     |
| Sở hữu bảng | `transfers`, `ledger_entries`, `idempotency_keys`, `reconciliation_runs`; ghi sự kiện qua `OutboxWriter.add` của module `outbox` |
| Thiết kế    | `docs/03` §6.1 (luồng chuyển tiền), §8 (dữ liệu) · `docs/BRD.md` Phần 2 §3 (AC-5.x)                                                         |

## Phải giữ

- Chuyển tiền và nạp tiền là **một transaction**: `TransactionService.run(manager => …)` — mã yêu cầu, khóa tài khoản, kiểm tra, bút toán, số dư, nhật ký, outbox cùng commit hoặc cùng rollback.
- Khóa hai tài khoản **theo thứ tự id**; sync guard (hạn mức) chạy **sau** `SELECT … FOR UPDATE`.
- Không gọi Redis / HTTP / SQS **bên trong** transaction (retry sẽ lặp lại tác dụng phụ, và khóa bị giữ lâu). Sự kiện đi qua bảng `outbox_events`.
- Tiền là `bigint`/string (đơn vị đồng), không bao giờ `number` có phần thập phân.
- `ledger_entries` chỉ INSERT.
- Lý do từ chối dùng `RejectReason` (`@common/errors/reject-reason`); trả HTTP 422 kèm `errorCode` và `transferId`.

## Export công khai (`index.ts`)

`LedgerModule` phục vụ operator deposit và customer transfer ở api/both; không nạp HTTP ledger trong worker. Query lịch sử/trạng thái sẽ có ở task riêng, chưa export service chưa tồn tại.

## Nạp tiền bản thô (DBS-60)

`POST /v1/operator/deposits` chỉ operator; body `{toAccountId,amount}` với amount là chuỗi VND dương chuẩn, header `Idempotency-Key` bắt buộc1–128 ký tự. Transaction reserve key → `AccountsService.lockForUpdate` theo id → kiểm đích ACTIVE → transfer DEPOSIT +hai ledger lines +hai cập nhật số dư qua AccountsService → audit → TransferCompleted qua OutboxWriter → lưu response key → commit. SYSTEM funding được âm và bỏ qua hạn mức/số dư nguồn.

Đích LOCKED/missing/SYSTEM: ghi transfer REJECTED +audit +key, commit rồi422 ACCOUNT_NOT_ACTIVE; không bút toán/sự kiện/đổi tiền. Metadata audit giữ UUID đích yêu cầu khi FK đích NULL. Funding thiếu/hỏng hoặc lỗi ghi bất kỳ trả500 (transient503), toàn bộ transaction/key rollback. Thư viện money giữ bigint/string, cả giá trị >2^53; ledger không SQL đọc/ghi accounts trực tiếp.

Idempotency (ADR-05): cùng key và cùng body trả lại đúng kết quả lần đầu mà không nạp lần hai (cả 422 đã lưu, cùng `transferId`); cùng key khác body trả 422 `IDEMPOTENCY_KEY_REUSED`. Key theo từng actor nên không lộ kết quả của người khác. Phần dùng chung (đặt chỗ key, hash, ghi transfer, sổ kép, lưu kết quả) nằm ở `ledger-posting.service.ts`. Event dùng fromUserId null/sameOwner false, fromBalanceBefore có dấu và occurredAt từ DB, mọi thời gian ISO Z. Test thật/fault rollback và bằng chứng ở [DBS-60](../../../../docs/features/DBS-60-operator-deposits.md).

## Chuyển tiền bản thô (DBS-61)

`POST /v1/transfers` chỉ dành cho customer. Body `{fromAccountId, toAccountId, amount}`: hai UUID khác nhau, `amount` là chuỗi số đồng dương. Header `Idempotency-Key` bắt buộc, 1–128 ký tự.

- Nguồn được kiểm quyền bằng `getOwnedAccount(fromId, {userId, role:'customer', action:'ledger.transfer', correlationId})` trước khi mở transaction; chính `getOwnedAccount` ghi audit `DENIED` (action `ledger.transfer`) rồi mới ném 404, `TransferService` không ghi thêm. Nguồn của người khác, không tồn tại hoặc là SYSTEM đều trả cùng một 404, và audit `DENIED` được ghi ngoài transaction nghiệp vụ.
- Trong một transaction: đặt chỗ key → khóa tài khoản theo thứ tự id → kiểm lại chủ sở hữu trên bản đã khóa, rồi chạy sync guard → ghi transfer, hai dòng sổ, hai số dư, audit, event `TransferCompleted` và kết quả của key.
- Nguồn hoặc đích LOCKED, đích không tồn tại hoặc SYSTEM → 422 `ACCOUNT_NOT_ACTIVE`; thiếu tiền (và không vượt hạn mức) → 422 `INSUFFICIENT_FUNDS`. Transfer REJECTED, audit và kết quả của key được commit trước khi trả 422; không có dòng sổ, event hay thay đổi số dư.
- Đích là tài khoản `funding` không bị khóa (chỉ khóa nguồn), để lệnh chuyển tới `funding` không phải xếp hàng sau các lệnh nạp tiền. Nếu sau này có tài khoản SYSTEM khác, phải mở rộng điều kiện này trong `transfer.service.ts`.
- Mọi lỗi ghi đều rollback toàn bộ kể cả key; lỗi tạm thời trả 503 và thử lại được với cùng key.
- Hai tài khoản khác nhau của cùng một người được phép, event có `sameOwner = true`.

Sync guard (DBS-82): `SyncGuardService.checkGuards(manager, lockedFrom, lockedTo, amount): Promise<RejectReason | null>` chạy **sau** `lockForUpdate`, luôn `await`, và từ chối trả lời (`AccountNotLockedError`) nếu hai tài khoản chưa được khóa trong transaction này. Lý do đầu tiên đúng được trả, theo thứ tự: hai tài khoản ACTIVE (đích không tồn tại hoặc không phải tài khoản khách tính là không ACTIVE) → hạn mức mỗi lần (`TRANSFER_LIMIT_PER_TX`) → hạn mức ngày (`TRANSFER_LIMIT_PER_DAY`, tổng dòng ghi nợ của tài khoản nguồn từ 00:00 giờ Việt Nam) → đủ tiền. Giới hạn đọc từ `limits.config` lúc gọi. Vượt hạn mức → 422 `LIMIT_PER_TX_EXCEEDED` / `LIMIT_PER_DAY_EXCEEDED`, lệnh vẫn được lưu `REJECTED`. Chưa có test ở ranh giới nửa đêm (BL-154). Test dùng PostgreSQL thật, tiền vào qua API nạp tiền. Bảng case và bằng chứng nằm ở [DBS-61](../../../../docs/features/DBS-61-customer-transfers.md).

## Lưu kết quả đối soát

`reconciliation_runs` có trong [migration](../../database/migrations/1793577600000-CreateReconciliationRuns.ts), với status `OK`, `MISMATCH`, `ERROR`, các tổng bigint nullable và details không chứa văn bản tự do. Hợp đồng JSON chỉ gồm `accountId`, `balance`, `ledgerBalance`; tiền trong JSON là chuỗi nguyên signed bigint. [Schema chuẩn](../../../../docs/components/_shared/database-design.md#49-notificationlog-reconciliationruns) và [DBS-116](../../../../docs/features/DBS-116-reconciliation-runs.md) mô tả các ràng buộc và kiểm thử.

Bảng không tự chạy hoặc tính đối soát. Job/producer thuộc DBS-117; quyền production và cleanup90 ngày thuộc DBS-119/job cleanup. Revert chỉ được khi rỗng, trong transaction READ COMMITTED; writer đồng thời được khóa/kiểm lại trước DROP. Không xóa kết quả đã ghi để ép revert.
