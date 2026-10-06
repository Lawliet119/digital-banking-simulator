# audit — Concept Brief

> **Status:** Draft · **Owner:** #3 · **Cặp đôi:** #2 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

## Component

| | |
|---|---|
| **Slug** | `audit` |
| **Loại** | 🟡 Supporting · module backend (thư viện + API tra cứu) |
| **Chạy ở** | `api` và `worker` (là thư viện mọi module ghi dữ liệu gọi; API tra cứu chỉ ở `api`) |
| **Use case / NFR** | UC-8 |
| **Sở hữu bảng** | `audit_log` (chỉ INSERT và SELECT) |
| **Task trong roadmap** | Task 4 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

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
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
