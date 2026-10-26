# audit 🟡 Supporting — #3

Nhật ký bất biến: ai làm gì, khi nào, trên đối tượng nào.

> **Status:** Schema, trigger và `AuditService` implemented · **Owner:** #3 · **Verified against code:** migration, DB tests và [DBS-56](../../../../docs/features/DBS-56-audit-service-record.md); API tra cứu (UC-8) và production role grants chưa triển khai.

Migration `CreateAuditLog1792627200001` tạo [schema audit](../../../../docs/components/_shared/database-design.md#47-auditlog), actor nullable với FK `ON DELETE RESTRICT`, outcome CHECK và ba index truy vết. `down` chỉ cho phép transaction READ COMMITTED, khóa bảng rồi từ chối bằng SQLSTATE `55000` nếu có dữ liệu. [Bằng chứng DBS-26](../../../../docs/features/DBS-26-migration-audit-log.md#8-kết-quả) gồm CLI run/revert/run và tranh chấp khóa trên PostgreSQL thật.

Migration `AddAppendOnlyTriggers1792627200002` cung cấp hai trigger audit: UPDATE/DELETE theo hàng và TRUNCATE theo statement, cùng `public.forbid_mutation()` trả SQLSTATE `42501`. [DBS-27](../../../../docs/features/DBS-27-append-only-triggers.md) kiểm owner NOSUPERUSER, quyền thực và context RAISE; INSERT vẫn được phép. Revert27 gỡ trigger, giữ dữ liệu, nhưng bỏ lớp bảo vệ này.

`AuditService.record`/`recordDenied` ([DBS-56](../../../../docs/features/DBS-56-audit-service-record.md)) dùng `INSERT` SQL thuần, không `RETURNING` — chạy đúng dưới role chỉ có quyền INSERT (đã kiểm bằng role tạo tạm trong test, xem DBS-56 §3/§4). Thu quyền production (`dbs_api`, `dbs_worker`) và kiểm AC-8.1 đầy đủ với role đó còn chờ task roles; API tra cứu UC-8 còn chờ task riêng.

| | |
|---|---|
| Use case | UC-8 tra cứu cho kiểm toán viên · ghi nhật ký cho mọi thao tác thay đổi dữ liệu |
| Chạy ở | `api` và `worker` — là **thư viện** mọi module ghi dữ liệu gọi (API tra cứu UC-8 chỉ ở `api`) |
| Sở hữu bảng | `audit_log` (chỉ INSERT và SELECT) |
| Thiết kế | `docs/03` §8, §12 · `docs/01` BR-09 |

## Phải giữ

- `AuditService.record(manager, { actor, role, action, outcome, target, correlationId, metadata })` được gọi **trong transaction của module gọi**, bằng chính `manager` đó. Không ghi được nhật ký (hoặc `metadata` sai định dạng) → cả transaction rollback (fail-closed, BR-09). **`record()` không bao giờ được `catch`** bên trong một callback của `TransactionService.run` — transaction đã bị Postgres abort (`25P02`); `catch` rồi tiếp tục khiến `COMMIT` âm thầm thành `ROLLBACK` mà `run()` vẫn resolve như thành công.
- `AuditService.recordDenied(input)` (không có `outcome`, luôn `DENIED`) dùng cho một lần bị từ chối phải để lại dấu vết dù lệnh gốc thất bại: tự mở transaction riêng, `record()` rồi tự `commit`. **Gọi nó ngoài mọi `TransactionService.run` khác** (trước `BEGIN` nghiệp vụ, hoặc sau khi transaction đó đã kết thúc) — không lồng bên trong một callback đang mở: giữ 2 connection, và một lần retry deadlock sẽ ghi trùng dòng. Nếu `recordDenied()` tự lỗi, để lỗi đó lan ra — không trả 404 "sạch" không có bằng chứng từ chối.
- `metadata` chỉ nhận `id`, `reason` (phải thuộc `ErrorCode` hoặc `AuditReason`, không phải câu tự do), `count` — `record()` tự kiểm ở runtime, không chỉ ở kiểu TypeScript. `action`, `role`, `target.id` vẫn là chuỗi tự do — người gọi tự chịu trách nhiệm không nhồi PII vào đó.
- Một consumer chỉ ghi `audit_log` **trong transaction của chính nó**, qua `AuditService.record` (ví dụ `risk` khi tạo cờ). Không có tiến trình nào ghi nhật ký bên ngoài transaction nghiệp vụ; role `dbs_worker` chỉ có quyền INSERT trên bảng này.
- Ghi cả truy cập dữ liệu nhạy cảm và các lần bị từ chối quyền (qua `recordDenied`, trước khi trả dữ liệu).
- Revoke `UPDATE`/`DELETE` trên `audit_log` ở mức database.
- Kiểm toán viên chỉ đọc; chính việc tra cứu cũng được ghi.

## Export công khai (`index.ts`)

`AuditModule`, `AuditService` (`record`, `recordDenied`), `AuditOutcome`, `AuditTarget`, `AuditMetadata`, `AuditRecordInput`, `AuditReason`, `AuditMetadataError`.
