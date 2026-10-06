# audit 🟡 Supporting — #3

Nhật ký bất biến: ai làm gì, khi nào, trên đối tượng nào.

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
