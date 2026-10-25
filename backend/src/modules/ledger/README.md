# ledger 🔴 Core — #1

Mọi đồng tiền vào, ra, di chuyển. Nơi duy nhất được phép thay đổi số dư.

> **Status:** Schema và trigger implemented · **Owner:** #1 · **Verified against code:** migration và DB tests; luồng chuyển/nạp tiền chưa triển khai.

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

`LedgerQueryService` cho `accounts`/`identity` đọc lịch sử và trạng thái.
