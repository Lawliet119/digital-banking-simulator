# identity — Concept Brief

> **Status:** Draft · **Owner:** #2 · **Cặp đôi:** #3 · **Verified against code:** n/a (chưa có code) · **Cập nhật:** 2026-10-06

## Component

| | |
|---|---|
| **Slug** | `identity` |
| **Loại** | ⚪ Generic · module backend |
| **Chạy ở** | `api` |
| **Use case / NFR** | UC-1 (liên kết user với customer), UC-11 (thu hồi phiên) |
| **Sở hữu bảng** | `users` (`cognito_sub`, `sessions_revoked_at`); vai trò lấy từ nhóm Cognito trong JWT, không lưu ở DB |
| **Task trong roadmap** | Task 2 ([master roadmap](../../superpowers/plans/2026-10-02-master-roadmap.md)) |

## Vấn đề

Cần xác thực người dùng và phân quyền theo 4 vai trò mà không tự quản mật khẩu; khi khóa tài khoản, token cũ phải mất hiệu lực ngay.

## Ý tưởng

- Dùng Cognito (dịch vụ managed), xác minh JWT tại chỗ bằng JWKS, cache khóa công khai.
- Mốc thu hồi phiên `users.sessions_revoked_at` là nguồn sự thật trong Postgres; Redis chỉ cache (`revoked_at:{userId}`).
- Rate limit toàn cục theo user và IP bằng Redis; Redis lỗi thì fail-open, WAF vẫn chặn ở biên.
- Kiểm tra **sở hữu** ở service, không chỉ kiểm tra vai trò.

## Ngoài phạm vi (v1)

- Tự quản mật khẩu, MFA, đăng nhập mạng xã hội.
- Quản lý người dùng nội bộ qua giao diện.

## Liên kết

- Thiết kế cấp hệ thống: [docs/03](../../03_HIGH_LEVEL_ARCHITECTURE.md) — §6.2 Khóa tài khoản và thu hồi phiên; §9 Redis (R-1 rate limit, R-2 mốc thu hồi); §12 Bảo mật.
- Yêu cầu: [docs/02](../../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) · Nghiệp vụ: [docs/01](../../01_BUSINESS_ANALYSIS.md).
- Quy tắc code và những điều phải giữ: [`backend/src/modules/identity/README.md`](../../../backend/src/modules/identity/README.md).
- Tiếp theo: [`02-architecture.md`](02-architecture.md).
