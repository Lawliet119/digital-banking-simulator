# identity ⚪ Generic — #2

Ai đang gọi và họ được làm gì. Dùng Cognito, không tự quản mật khẩu.

|             |                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Use case    | UC-1 (liên kết user Cognito với customer) · UC-11 (thu hồi phiên)                                     |
| Chạy ở      | `api`                                                                                                 |
| Sở hữu bảng | `users` (`cognito_sub`, `sessions_revoked_at`); vai trò lấy từ nhóm Cognito trong JWT, không lưu ở DB |
| Thiết kế    | `docs/03` §6.2, §12 · `docs/BRD.md` NFR-SEC-01, 02                                                        |

## Phải giữ

- Xác minh JWT bằng JWKS của Cognito; guard theo nhóm `customer` / `operator` / `auditor` / `admin`.
- **Mốc thu hồi phiên:** token phát hành trước `users.sessions_revoked_at` bị từ chối với `ErrorCode.SESSION_REVOKED`. Nguồn sự thật là cột trong Postgres; Redis chỉ cache (`revoked_at:{userId}`, TTL = `ACCESS_TOKEN_TTL_SECONDS`). Redis lỗi → đọc Postgres. Hiện chỉ có phần Postgres: `JwtAuthGuard` đọc `sessions_revoked_at` mỗi request (so theo giây, `iat <= mốc` thì từ chối) và `IdentityService.revokeSessions(manager, userId)` đặt mốc trong transaction của người gọi; cache Redis và endpoint khóa tài khoản chưa có (BL-155).
- Rate limit toàn cục theo user và IP (Redis); Redis lỗi → fail-open, WAF vẫn chặn ở biên.
- Kiểm tra **sở hữu** ở service, không chỉ vai trò.
- Dòng `users` được tạo bằng upsert theo `cognito_sub` ở token hợp lệ đầu tiên của mọi vai trò; không bao giờ đổi `sub → users.id` (DBS-52). `JwtAuthGuard` gọi `IdentityService.resolveUserId(sub)` **sau** khi verify xong và gán `request.user.userId` (luôn có giá trị khi request qua guard; lỗi DB thì 503, không phải 401). Hai câu SQL chạy trong một `TransactionService.run` để có `lock_timeout`/`statement_timeout`; cache `sub → userId` trong tiến trình giới hạn 10.000 mục (LRU, gộp request song song, không cache lỗi). Tính đúng đắn dựa vào `ON CONFLICT`, không dựa vào cache.

- **Vai trò** chỉ suy ra từ `request.user.groups` (claim `cognito:groups` của token đã verify) bằng `rolesFromGroups`: không nhóm, hoặc chỉ nhóm lạ, là `customer` (ADR-06); nhiều nhóm hợp lệ thì có đủ các vai; so khớp tuyệt đối (không `trim`, không đổi hoa thường) và chỉ nhận mảng thật chứa chuỗi, vì `JwtAuthGuard` chỉ thay claim **vắng** bằng `[]` nên chuỗi hay đối tượng trong token ký hợp lệ vẫn tới được guard. **Không có phân cấp**: `admin` không tự có quyền `operator`, endpoint cho cả hai ghi `@Roles('operator', 'admin')`.
- **`@Roles(...)`** khai báo vai trò được phép trên method hoặc controller (method thay controller, không gộp); danh sách rỗng hay tên lạ làm app dừng lúc khởi động. `RolesGuard` là `APP_GUARD` thứ hai, **sau** `JwtAuthGuard`: sai vai trò thì 403 `FORBIDDEN` và handler không chạy; metadata hỏng thì cũng 403 (không bao giờ mở); `@Roles` trên route `@Public()` thì 401. Mỗi lần 403 ghi một dòng `warn` có `userId`, method, mẫu route, vai trò yêu cầu và `roles` của người gọi, không bao giờ có token, `sub`, `groups`, `claims` hay query string.
- **Route không gắn `@Roles` chỉ cần token hợp lệ.** Quên `@Roles` là mở route cho mọi vai, nên `test/roles-app.e2e-spec.ts` đỏ khi một route của `AppModule` không có `@Public()` hay `@Roles()` và không nằm trong danh sách cho phép viết rõ trong test (hiện chỉ `GET /v1/identity/me`).
- **`@CurrentUser()`** trả `{ userId, sub, roles }` (đối tượng mới mỗi lần, không có `claims`/`groups`); route không có `request.user` thì 401.

## Export công khai (`index.ts`)

Đã có: `JwtAuthGuard`, `JwksVerifierService`, `IdentityService.resolveUserId(sub)`, kiểu `AuthenticatedUser` (có `userId`), `Roles`, `ROLES_KEY`, `RolesGuard`, `CurrentUser`, `ROLES`, `rolesFromGroups`, kiểu `Role` và `CurrentUserInfo`. Chưa có: `IdentityService.revokeSessions(userId, manager)`, ghi audit `DENIED` khi 403 (`BL-132`).
