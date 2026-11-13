# identity ⚪ Generic — #2

Ai đang gọi và họ được làm gì. Dùng Cognito, không tự quản mật khẩu.

> **Status:** Draft · **Owner:** Dev · **Verified against code:** JWT/roles, users và thu hồi phiên PostgreSQL/Valkey local; Cognito/HA cloud chưa kiểm.

|             |                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Use case    | UC-1 (liên kết user Cognito với customer) · UC-11 (thu hồi phiên)                                     |
| Chạy ở      | `api`                                                                                                 |
| Sở hữu bảng | `users` (`cognito_sub`, `sessions_revoked_at`); vai trò lấy từ nhóm Cognito trong JWT, không lưu ở DB |
| Thiết kế    | `docs/03` §6.2, §12 · `docs/BRD.md` NFR-SEC-01, 02                                                        |

## Phải giữ

- Xác minh JWT bằng JWKS của Cognito; guard theo nhóm `customer` / `operator` / `auditor` / `admin`.
- **Mốc thu hồi phiên:** `users.sessions_revoked_at` là nguồn sự thật. `JwtAuthGuard` đọc `revoked_at:{userId}` qua libs/redis trước, chuỗi epoch giây/TTL=`ACCESS_TOKEN_TTL_SECONDS` (mặc định900). `iat <= marker` bị401 `SESSION_REVOKED`, kể cả cùng giây. Cache miss, lỗi/chậm, malformed hoặc marker chưa đủ để từ chối đều đọc SQL; không cacheNULL, không cho phép chỉ dựa trên cache cũ. SQL lỗi vẫn thất bại theo filter, không đổi thành401 hoặc cho qua. Cache giảm query cho token chắc chắn đã bị thu hồi; phiên có thể hợp lệ vẫn xác nhận nguồn SQL để tránh stale cache sau SET lỗi.
- **Ghi cache:** `IdentityService.revokeSessions(manager,userId)` chỉ UPDATE trong transaction khóa tài khoản. Sau COMMIT, caller gọi `publishRevocation(userId,revokedAt)`; callback retry trả outcome, không ghi Redis/giữ mốc ngoài attempt. Publish trong `activeTransactionContext` bị TypeError trướcI/O; Redis SET lỗi saucommit không rollback thao tác. Cache fill từ SQL chỉ sau khi SELECT/transaction đọc kết thúc. Unlock không xóa mốc để hồi sinh token cũ. [DBS-114](../../../../docs/features/DBS-114-session-revocation.md) có proof PG/Valkey thật, rollback/retry, stale-cache và haiAPI.
- **Wiring:** `SessionRevocationModule` global trong api/both dùng RedisModule, cung cấp một cache cho guard và accounts; SQL-only fixture hoặc worker không nạp module vẫn dùng đường SQL qua optional injection. Test runtime module và fixture114 dùng đúng module production, không fake Identity/guard.
- Rate limit toàn cục theo user và IP (Redis); Redis lỗi → fail-open, WAF vẫn chặn ở biên.
- Kiểm tra **sở hữu** ở service, không chỉ vai trò.
- Dòng `users` được tạo bằng upsert theo `cognito_sub` ở token hợp lệ đầu tiên của mọi vai trò; không bao giờ đổi `sub → users.id` (DBS-52). `JwtAuthGuard` gọi `IdentityService.resolveUserId(sub)` **sau** khi verify xong và gán `request.user.userId` (luôn có giá trị khi request qua guard; lỗi DB thì 503, không phải 401). Hai câu SQL chạy trong một `TransactionService.run` để có `lock_timeout`/`statement_timeout`; cache `sub → userId` trong tiến trình giới hạn 10.000 mục (LRU, gộp request song song, không cache lỗi). Tính đúng đắn dựa vào `ON CONFLICT`, không dựa vào cache.

- **Vai trò** chỉ suy ra từ `request.user.groups` (claim `cognito:groups` của token đã verify) bằng `rolesFromGroups`: không nhóm, hoặc chỉ nhóm lạ, là `customer` (ADR-06); nhiều nhóm hợp lệ thì có đủ các vai; so khớp tuyệt đối (không `trim`, không đổi hoa thường) và chỉ nhận mảng thật chứa chuỗi, vì `JwtAuthGuard` chỉ thay claim **vắng** bằng `[]` nên chuỗi hay đối tượng trong token ký hợp lệ vẫn tới được guard. **Không có phân cấp**: `admin` không tự có quyền `operator`, endpoint cho cả hai ghi `@Roles('operator', 'admin')`.
- **`@Roles(...)`** khai báo vai trò được phép trên method hoặc controller (method thay controller, không gộp); danh sách rỗng hay tên lạ làm app dừng lúc khởi động. `RolesGuard` là `APP_GUARD` thứ hai, **sau** `JwtAuthGuard`: sai vai trò thì 403 `FORBIDDEN` và handler không chạy; metadata hỏng thì cũng 403 (không bao giờ mở); `@Roles` trên route `@Public()` thì 401. Mỗi lần 403 ghi một dòng `warn` có `userId`, method, mẫu route, vai trò yêu cầu và `roles` của người gọi, không bao giờ có token, `sub`, `groups`, `claims` hay query string. Cùng lúc, mỗi 403 ghi một dòng `audit_log` `DENIED` qua `RoleDenialAudit` (BL-132, xem README audit): lỗi ghi audit thì request nhận 500/503 chứ không phải 403, handler vẫn không chạy; dòng `warn` được giữ có chủ đích.
- **Route không gắn `@Roles` chỉ cần token hợp lệ.** Quên `@Roles` là mở route cho mọi vai, nên `test/roles-app.e2e-spec.ts` đỏ khi một route của `AppModule` không có `@Public()` hay `@Roles()` và không nằm trong danh sách cho phép viết rõ trong test (hiện chỉ `GET /v1/identity/me`).
- **`@CurrentUser()`** trả `{ userId, sub, roles }` (đối tượng mới mỗi lần, không có `claims`/`groups`); route không có `request.user` thì 401.

## Export công khai (`index.ts`)

Đã có: `JwtAuthGuard`, `JwksVerifierService`, `IdentityService.resolveUserId(sub)`, kiểu `AuthenticatedUser` (có `userId`), `Roles`, `ROLES_KEY`, `RolesGuard`, `CurrentUser`, `ROLES`, `rolesFromGroups`, kiểu `Role` và `CurrentUserInfo`. Cổng `RoleDenialAudit` và kiểu `RoleDenial` (`RolesGuard` ghi audit `DENIED` khi 403 qua nó, BL-132; `AuditModule` cung cấp bản thật). Chưa có: `IdentityService.revokeSessions(userId, manager)`.
