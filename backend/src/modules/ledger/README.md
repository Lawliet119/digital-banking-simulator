# ledger 🔴 Core — #1

Mọi đồng tiền vào, ra, di chuyển. Nơi duy nhất được phép thay đổi số dư.

> **Status:** Schema, trigger, công cụ kiểm bất biến và nạp tiền bản thô implemented · **Owner:** Dev (Ledger) · **Verified against code:** migration/DB tests và DBS-60; transfer, replay DBS-79 và scheduler đối soát còn chờ.

Migration `AddAppendOnlyTriggers1792627200002` bật hai trigger cho mỗi bảng `transfers`, `ledger_entries`: BEFORE UPDATE/DELETE theo hàng và BEFORE TRUNCATE theo statement, cùng hàm `public.forbid_mutation()` của [DBS-27](../../../../docs/features/DBS-27-append-only-triggers.md). INSERT vẫn được phép; mutation có hàng và TRUNCATE kể cả bảng rỗng trả SQLSTATE `42501` từ RAISE của hàm. UPDATE/DELETE không khớp hàng trả 0 hàng. Test dùng owner NOSUPERUSER và đối chứng quyền sau down; quyền production và chủ view `v_transfer_facts` còn chờ task roles (BL-005). Revert chỉ gỡ trigger/hàm, giữ dữ liệu và sequence nhưng làm mất lớp bảo vệ này; không dùng revert như cách sửa dữ liệu nghiệp vụ.

| | |
|---|---|
| Use case | UC-3 nạp tiền · UC-5 chuyển tiền · UC-6 lịch sử · UC-7 trạng thái giao dịch |
| Chạy ở | `api`; job đối soát chạy ở `worker` (scheduler bị chặn ở role `api`, ADR-13) |
| Sở hữu bảng | `transfers`, `ledger_entries`, `idempotency_keys`, `reconciliation_runs`; ghi sự kiện qua `OutboxWriter.add` của module `outbox` |
| Thiết kế | `docs/03` §6.1 (luồng chuyển tiền), §8 (dữ liệu) · `docs/02` §3 (AC-5.x) |

## Phải giữ

- Chuyển tiền và nạp tiền là **một transaction**: `TransactionService.run(manager => …)` — mã yêu cầu, khóa tài khoản, kiểm tra, bút toán, số dư, nhật ký, outbox cùng commit hoặc cùng rollback.
- Khóa hai tài khoản **theo thứ tự id**; sync guard (hạn mức) chạy **sau** `SELECT … FOR UPDATE`.
- Không gọi Redis / HTTP / SQS **bên trong** transaction (retry sẽ lặp lại tác dụng phụ, và khóa bị giữ lâu). Sự kiện đi qua bảng `outbox_events`.
- Tiền là `bigint`/string (đơn vị đồng), không bao giờ `number` có phần thập phân.
- `ledger_entries` chỉ INSERT.
- Lý do từ chối dùng `RejectReason` (`@common/errors/reject-reason`); trả HTTP 422 kèm `errorCode` và `transferId`.

## Export công khai (`index.ts`)

`LedgerModule` phục vụ operator deposit ở api/both; không nạp HTTP deposit trong worker. Query lịch sử/trạng thái sẽ có ở task riêng, chưa export service chưa tồn tại.

## Nạp tiền bản thô (DBS-60)

`POST /v1/operator/deposits` chỉ operator; body `{toAccountId,amount}` với amount là chuỗi VND dương chuẩn, header `Idempotency-Key` bắt buộc1–128 ký tự. Transaction reserve key → `AccountsService.lockForUpdate` theo id → kiểm đích ACTIVE → transfer DEPOSIT +hai ledger lines +hai cập nhật số dư qua AccountsService → audit → TransferCompleted qua OutboxWriter → lưu response key → commit. SYSTEM funding được âm và bỏ qua hạn mức/số dư nguồn.

Đích LOCKED/missing/SYSTEM: ghi transfer REJECTED +audit +key, commit rồi422 ACCOUNT_NOT_ACTIVE; không bút toán/sự kiện/đổi tiền. Metadata audit giữ UUID đích yêu cầu khi FK đích NULL. Funding thiếu/hỏng hoặc lỗi ghi bất kỳ trả500 (transient503), toàn bộ transaction/key rollback. Thư viện money giữ bigint/string, cả giá trị >2^53; ledger không SQL đọc/ghi accounts trực tiếp.

Bản thô **không replay**: key đã dùng trả409, không thực hiện lần hai, không trả response của actor khác. DBS-79 bổ sung same-body replay/khác-body422 theo ADR05; hash/result đã lưu để tích hợp. Không coi409 là hoàn thành AC-5.3/4/5. Event dùng fromUserId null/sameOwner false, fromBalanceBefore có dấu và occurredAt từ DB, mọi thời gian ISO Z. Test thật/fault rollback và bằng chứng ở [DBS-60](../../../../docs/features/DBS-60-operator-deposits.md).

## Kiểm bất biến

Chạy `npm run --silent check:invariants` từ `backend/` sau money test/load run. Năm phép kiểm dùng chung [invariants.sql](../../../test/support/invariants.sql); [hàm](../../../test/support/invariants.ts) nhận QueryRunner của caller. Exit 0 là sạch, 1 có vi phạm kèm IDs, 2 không kiểm được. Funding âm hợp lệ và vẫn tính vào SUM(balance). Chi tiết quyền/config/snapshot và cách dùng: [backend README](../../../README.md#9-kiểm-tra-bất-biến-sổ-cái).

Công cụ chỉ đọc theo yêu cầu, chưa có lịch chạy worker hoặc `reconciliation_runs`; không kiểm chuỗi `balance_after` và không chữa dữ liệu. Giới hạn DB chưa ép đủ cặp/balance_after vẫn theo BL-006.
