# ADR-06: Amazon Cognito cho định danh, ECS Fargate để chạy container

| | |
|---|---|
| Trạng thái | **Accepted** |
| Ngày | 2026-10-11 |
| Người viết | #2 (phần Cognito), #5 (phần Fargate) |
| Người duyệt | Cả nhóm |
| Liên quan | Driver D-6, D-8 · FR-ID-01…03, NFR-SEC-01, 02 · [`docs/03` §4, §12, §13](../03_HIGH_LEVEL_ARCHITECTURE.md) · [ADR-11](0011-aws-managed-session-based.md), [ADR-13](0013-one-app-app-role.md) |

## Bối cảnh

Hai câu hỏi cùng bản chất "tự làm hay thuê dịch vụ managed":

1. **Định danh.** Hệ thống có 4 vai trò (customer, operator, auditor, admin). Khóa tài khoản phải thu hồi truy cập ngay ở request kế tiếp (AC-11.1). Nhóm không muốn tự lưu và băm mật khẩu.
2. **Chạy container.** Một image chạy thành hai service `api` và `worker` (ADR-13). Một người (#5) lo toàn bộ hạ tầng, và hạ tầng được dựng/xóa theo phiên (ADR-11).

## Các phương án

**Định danh**

| Tiêu chí | **A. Cognito user pool** | B. JWT tự cấp (bcrypt/argon2) | C. Keycloak tự chạy |
|---|---|---|---|
| Lưu mật khẩu | **Không phải lưu** | Nhóm tự lưu và băm | Keycloak lưu, nhóm vận hành |
| Bề mặt tấn công do nhóm viết | **Chỉ phần xác minh token** | Đăng nhập, đặt lại mật khẩu, khóa brute-force | Cấu hình và vá Keycloak |
| Chi phí | **Miễn phí ở quy mô này** | 0 | Một container chạy liên tục |
| Thu hồi phiên ngay | Tự làm bằng mốc thu hồi (giống mọi JWT) | Như A | Như A |

**Chạy container**

| Tiêu chí | **A. ECS Fargate** | B. EKS | C. ECS trên EC2 |
|---|---|---|---|
| Phí control plane | **0** | ~0,10 USD/giờ ≈ 73 USD/tháng, vượt ngân sách | 0 |
| Quản lý máy chủ | **Không** | Node group hoặc Fargate profile | Vá AMI, scale cluster |
| Rolling update, health check qua ALB | **Có sẵn** | Có, cần thêm controller | Có sẵn |
| Dựng/xóa theo phiên | **Nhanh, không có máy chủ để chờ** | Chậm (cluster mất 10–15 phút) | Phải chờ EC2 |

## Quyết định

**Cognito user pool** và **ECS Fargate** (x86_64), với các giá trị chốt sau.

| Mục | Giá trị |
|---|---|
| Nhóm Cognito | `customer`, `operator`, `auditor`, `admin` |
| Vai trò trong ứng dụng | Lấy từ claim `cognito:groups` của **access token**. Token không thuộc nhóm nào (khách tự đăng ký) được coi là `customer`. Không có cột `users.role` |
| Định danh | Claim `sub` → `users.cognito_sub`; dòng `users` được upsert ở token hợp lệ đầu tiên |
| Kiểm tra khi xác minh | Chữ ký (JWKS, cache khóa, gặp `kid` lạ thì tải lại tối đa 1 lần/phút), `iss`, `client_id`, `token_use = access`, `exp` |
| Thời gian sống | Access token **15 phút** (`ACCESS_TOKEN_TTL_SECONDS=900`), ID token 15 phút, refresh token 1 ngày |
| App client | Một app client **không có secret**, luồng `USER_SRP_AUTH`, `REFRESH_TOKEN_AUTH` và `USER_PASSWORD_AUTH` (luồng cuối để script seed và k6 lấy token) |
| Khách hàng | Tự đăng ký qua Cognito (UC-1) |
| Nhân viên | Terraform tạo user pool và 4 nhóm; script seed (#5) tạo operator, auditor, admin demo bằng `AdminCreateUser`. Mật khẩu demo để ở Secrets Manager, không nằm trong repo hay lịch sử git. Chưa có giao diện quản lý nhân viên |
| Local và test | `AUTH_MODE=local`: app xác minh token bằng JWKS cục bộ (`AUTH_LOCAL_JWKS_PATH`) do lệnh `npm run auth:dev-keys` sinh vào thư mục bị gitignore. `npm run auth:dev-token -- --role <vai>` cấp token mẫu. Test e2e sinh cặp khóa trong bộ nhớ. Validation schema **từ chối khởi động** nếu `AUTH_MODE=local` ở staging hoặc production |
| Task Fargate | `api`: 0,5 vCPU / 1 GB. `worker`: 0,25 vCPU / 0,5 GB. Dev chạy 1 task mỗi service; production và load test chạy `api` ≥ 2 task trên 2 AZ |

## Lý do

- Cognito bỏ hẳn phần nhạy cảm nhất (lưu mật khẩu, khóa brute-force, đặt lại mật khẩu) khỏi code của nhóm. Thứ còn lại, xác minh JWT bằng JWKS, là thư viện chuẩn.
- Access token của Cognito đã mang `cognito:groups`, nên phân quyền không cần đọc DB. Thu hồi phiên ngay được giải bằng mốc `sessions_revoked_at` (docs/03 §6.2); 15 phút là thời gian một token cũ còn có thể bị dùng nếu không có cơ chế thu hồi, và cũng là TTL của key `revoked_at:{userId}` trong Redis.
- Coi "không có nhóm" là `customer` giúp bỏ được Lambda trigger gán nhóm khi đăng ký. Nhân viên luôn có nhóm tường minh nên không thể bị nhầm thành khách hàng có quyền nhân viên.
- Fargate không có phí control plane và không có máy chủ để vá, hợp với ngân sách và với việc dựng/xóa theo phiên. EKS một mình đã tốn khoảng 73 USD/tháng.
- x86_64 thay vì ARM64: runner GitHub Actions là x86, build đa kiến trúc qua QEMU chậm. Tiết kiệm khoảng 20% của ARM không đáng so với thời gian build ở quy mô này.

## Đánh đổi và hệ quả

- Phụ thuộc AWS cho định danh. Hệ thống chỉ cần JWT có `sub` và nhóm, nên đổi sang IdP khác chỉ ảnh hưởng module `identity`.
- `USER_PASSWORD_AUTH` gửi mật khẩu tới Cognito qua TLS, kém an toàn hơn SRP. Chỉ dùng cho script seed và k6 với tài khoản demo.
- Đường `AUTH_MODE=local` là một bề mặt tấn công nếu lọt lên cloud. Chặn bằng validation lúc khởi động và có test riêng (DBS-53).
- **Xem lại khi:** cần SSO doanh nghiệp, MFA bắt buộc cho nhân viên, hoặc cần giao diện quản lý nhân viên.

## Cách kiểm chứng

- Token sai chữ ký, hết hạn, sai `iss` → 401; sai vai trò → 403; thử đặt vai trò qua body hoặc header không có tác dụng (DBS-50, 51, 159).
- AC-11.1: khóa tài khoản → request kế tiếp nhận `SESSION_REVOKED`, kể cả khi Redis bị flush (DBS-114, DBS-186).
- App từ chối khởi động với `AUTH_MODE=local` khi `NODE_ENV=production` (test trong `validation.schema.spec.ts`, DBS-53).
- Dựng môi trường dev từ trống ≤ 30 phút (DBS-139); rolling update và rollback ≤ 10 phút (DBS-156).
