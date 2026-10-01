# audit 🟡 Supporting — #3

Nhật ký bất biến: ai làm gì, khi nào, trên đối tượng nào.

| | |
|---|---|
| Use case | UC-8 tra cứu cho kiểm toán viên · ghi nhật ký cho mọi thao tác thay đổi dữ liệu |
| Chạy ở | `api` — là **thư viện** mọi module ghi dữ liệu gọi |
| Sở hữu bảng | `audit_log` (chỉ INSERT và SELECT) |
| Thiết kế | `docs/03` §8, §12 · `docs/01` BR-09 |

## Phải giữ

- `AuditService.record(manager, { actor, action, target, correlationId })` được gọi **trong transaction của module gọi**, bằng chính `manager` đó. Không ghi được nhật ký → cả transaction rollback (fail-closed, BR-09).
- Không có consumer bất đồng bộ nào ghi `audit_log`.
- Ghi cả truy cập dữ liệu nhạy cảm và các lần bị từ chối quyền (trong transaction riêng, trước khi trả dữ liệu).
- Revoke `UPDATE`/`DELETE` trên `audit_log` ở mức database.
- Kiểm toán viên chỉ đọc; chính việc tra cứu cũng được ghi.

## Export công khai (`index.ts`)

`AuditService.record(...)`.
