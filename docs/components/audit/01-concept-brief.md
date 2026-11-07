# audit — Concept Brief

> **Status:** Draft · **Owner:** Dev · **Verified against code:** một phần: bảng `audit_log` (DBS-26), trigger append-only (DBS-27), `AuditService.record` ghi trong transaction của module gọi (DBS-56). Chưa có trên `main`: API tra cứu UC-8 (DBS-103, PR #59 đang mở) · **Cập nhật:** 2026-11-07

## Component

| | |
|---|---|
| **Slug** | `audit` |
| **Loại** | 🟡 Supporting · module backend (thư viện + API tra cứu) |
| **Chạy ở** | `api` và `worker` (là thư viện mọi module ghi dữ liệu gọi; API tra cứu chỉ ở `api`) |
| **Use case / NFR** | UC-8 |
| **Sở hữu bảng** | `audit_log` (chỉ INSERT và SELECT) |
| **Task trong roadmap** | Task 4 của roadmap cũ (đã xóa ngày 2026-11-07); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md) |

## Vấn đề

Nhật ký thao tác rời rạc và có thể bị sửa nên không đáp ứng kiểm toán, khó điều tra sự cố (P-4 trong docs/01).

## Ý tưởng

- Thư viện `AuditService.record(manager, …)` được module ghi dữ liệu gọi **trong transaction của chính nó**; không ghi được nhật ký thì cả transaction rollback.
- Bảng `audit_log` chỉ cấp quyền INSERT/SELECT ở mức DB.
- Ghi cả truy cập dữ liệu nhạy cảm và các lần bị từ chối quyền.
- `correlationId` xuyên suốt API → outbox → consumer → audit.

## Ngoài phạm vi (v1)

- Export sang S3 Object Lock (tùy chọn).
- Báo cáo theo chuẩn cơ quan quản lý.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §8 Dữ liệu; §12 Bảo mật; §14 Quan sát (`correlationId`).
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Quy tắc code và những điều phải giữ: [`backend/src/modules/audit/README.md`](../../../backend/src/modules/audit/README.md).
- Giao diện và mốc: Task 4 của roadmap cũ (đã xóa); việc đang làm xem bảng task trên board và [docs/features](../../features/README.md). Thiết kế chi tiết nằm ở các mục docs/03 nêu trên (không có file 02 riêng).
