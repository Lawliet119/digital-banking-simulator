# audit 🟡 Supporting — #3

Nhật ký bất biến: ai làm gì, khi nào, trên đối tượng nào.

> **Status:** Schema và trigger implemented · **Owner:** #3 · **Verified against code:** migration và DB tests; service/API chưa triển khai.

Migration `CreateAuditLog1792627200001` tạo [schema audit](../../../../docs/components/_shared/database-design.md#47-auditlog), actor nullable với FK `ON DELETE RESTRICT`, outcome CHECK và ba index truy vết. `down` chỉ cho phép transaction READ COMMITTED, khóa bảng rồi từ chối bằng SQLSTATE `55000` nếu có dữ liệu. [Bằng chứng DBS-26](../../../../docs/features/DBS-26-migration-audit-log.md#8-kết-quả) gồm CLI run/revert/run và tranh chấp khóa trên PostgreSQL thật. Production roles, `AuditService` và API tra cứu còn là các bước bàn giao; các quy tắc bên dưới là hợp đồng triển khai các bước đó.

Migration `AddAppendOnlyTriggers1792627200002` cung cấp hai trigger audit: UPDATE/DELETE theo hàng và TRUNCATE theo statement, cùng `public.forbid_mutation()` trả SQLSTATE `42501`. [DBS-27](../../../../docs/features/DBS-27-append-only-triggers.md) kiểm owner NOSUPERUSER, quyền thực và context RAISE; INSERT vẫn được phép. Revert27 gỡ trigger, giữ dữ liệu, nhưng bỏ lớp bảo vệ này. Thu quyền production và kiểm AC-8.1 đầy đủ còn chờ task roles.

| | |
|---|---|
| Use case | UC-8 tra cứu cho kiểm toán viên · ghi nhật ký cho mọi thao tác thay đổi dữ liệu |
| Chạy ở | `api` và `worker` — là **thư viện** mọi module ghi dữ liệu gọi (API tra cứu UC-8 chỉ ở `api`) |
| Sở hữu bảng | `audit_log` (chỉ INSERT và SELECT) |
| Thiết kế | `docs/03` §8, §12 · `docs/01` BR-09 |

## Phải giữ

- `AuditService.record(manager, { actor, action, target, correlationId })` được gọi **trong transaction của module gọi**, bằng chính `manager` đó. Không ghi được nhật ký → cả transaction rollback (fail-closed, BR-09).
- Một consumer chỉ ghi `audit_log` **trong transaction của chính nó**, qua `AuditService.record` (ví dụ `risk` khi tạo cờ). Không có tiến trình nào ghi nhật ký bên ngoài transaction nghiệp vụ; role `dbs_worker` chỉ có quyền INSERT trên bảng này.
- Ghi cả truy cập dữ liệu nhạy cảm và các lần bị từ chối quyền (trong transaction riêng, trước khi trả dữ liệu).
- Revoke `UPDATE`/`DELETE` trên `audit_log` ở mức database.
- Kiểm toán viên chỉ đọc; chính việc tra cứu cũng được ghi.

## Export công khai (`index.ts`)

`AuditService.record(...)`.
