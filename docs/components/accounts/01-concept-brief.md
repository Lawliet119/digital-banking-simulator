# accounts — Concept Brief

> **Status:** Draft · **Owner:** #2 · **Cặp đôi:** #3 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-03

## Component

| | |
|---|---|
| **Slug** | `accounts` |
| **Loại** | 🟡 Supporting · module backend |
| **Chạy ở** | `api` |
| **Use case / NFR** | UC-1, UC-2, UC-4, UC-11 |
| **Sở hữu bảng** | `customers`, `accounts` (gồm tài khoản SYSTEM `funding`) |
| **Task trong roadmap** | Task 2 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Khách cần hồ sơ và tối đa 3 tài khoản; nhân viên cần khóa tài khoản nhanh và khóa phải có hiệu lực ngay (P-6 trong docs/01).

## Ý tưởng

- Sở hữu dữ liệu `customers` và `accounts`, kể cả tài khoản SYSTEM `funding` (được phép âm).
- Export `lockForUpdate` và `applyBalanceChange` cho `ledger`, nhận transaction của ledger thay vì tự mở transaction riêng.
- Khóa tài khoản = đổi trạng thái **và** thu hồi phiên của chủ tài khoản trong cùng lệnh, không chờ sự kiện.
- Truy cập tài khoản không thuộc mình trả 404, không phải 403.

## Ngoài phạm vi (v1)

- Xác minh danh tính thật (eKYC).
- Đóng tài khoản, sao kê.
- Đổi số dư trực tiếp (chỉ ledger làm được).

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §6.2 Khóa tài khoản và thu hồi phiên; §7 API; §8 Dữ liệu.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Quy tắc code và những điều phải giữ: [`backend/src/modules/accounts/README.md`](../../../backend/src/modules/accounts/README.md).
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
