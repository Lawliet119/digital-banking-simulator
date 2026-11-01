# identity ⚪ Generic — #2

Ai đang gọi và họ được làm gì. Dùng Cognito, không tự quản mật khẩu.

| | |
|---|---|
| Use case | UC-1 (liên kết user Cognito với customer) · UC-11 (thu hồi phiên) |
| Chạy ở | `api` |
| Sở hữu bảng | `users` (`cognito_sub`, `sessions_revoked_at`); vai trò lấy từ nhóm Cognito trong JWT, không lưu ở DB |
| Thiết kế | `docs/03` §6.2, §12 · `docs/02` NFR-SEC-01, 02 |

## Phải giữ

- Xác minh JWT bằng JWKS của Cognito; guard theo nhóm `customer` / `operator` / `auditor` / `admin`.
- **Mốc thu hồi phiên:** token phát hành trước `users.sessions_revoked_at` bị từ chối với `ErrorCode.SESSION_REVOKED`. Nguồn sự thật là cột trong Postgres; Redis chỉ cache (`revoked_at:{userId}`, TTL = `ACCESS_TOKEN_TTL_SECONDS`). Redis lỗi → đọc Postgres.
- Rate limit toàn cục theo user và IP (Redis); Redis lỗi → fail-open, WAF vẫn chặn ở biên.
- Kiểm tra **sở hữu** ở service, không chỉ vai trò.
- Dòng `users` được tạo bằng upsert theo `cognito_sub` ở token hợp lệ đầu tiên của mọi vai trò; không bao giờ đổi `sub → users.id` (DBS-52). `JwtAuthGuard` gọi `IdentityService.resolveUserId(sub)` **sau** khi verify xong và gán `request.user.userId` (luôn có giá trị khi request qua guard; lỗi DB thì 503, không phải 401). Hai câu SQL chạy trong một `TransactionService.run` để có `lock_timeout`/`statement_timeout`; cache `sub → userId` trong tiến trình giới hạn 10.000 mục (LRU, gộp request song song, không cache lỗi). Tính đúng đắn dựa vào `ON CONFLICT`, không dựa vào cache.

## Export công khai (`index.ts`)

Đã có: `JwtAuthGuard`, `JwksVerifierService`, `IdentityService.resolveUserId(sub)`, kiểu `AuthenticatedUser` (có `userId`). Chưa có: `IdentityService.revokeSessions(userId, manager)`, `@Roles()`, `@CurrentUser()`.
