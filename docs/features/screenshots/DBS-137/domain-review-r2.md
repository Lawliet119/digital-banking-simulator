### Báo cáo Domain Review (Round 2) · DBS-137: Làm sạch OpenAPI

**Tài liệu đánh giá:** `docs/features/DBS-137-clean-openapi.md` (§1–§6).  
**Vai trò:** Senior Core Banking Systems Engineer (Ledger, Concurrency, Security, Idempotent Payment APIs).

---

### 1. Kết quả thẩm định 6 phát hiện từ Round 1

Toàn bộ 6 phát hiện (2 blocking, 2 should-fix, 2 minor) từ Round 1 đã được tác giả xử lý triệt để và chính xác trong tài liệu thiết kế:

| # | Mức độ | Phát hiện Round 1 | Trạng thái thẩm định Round 2 | Đánh giá kỹ thuật |
|---|---|---|---|---|
| 1 | **blocking** | TC-137-01 đến TC-137-05 gắn `unit/spec` boot `AppModule` thật sẽ làm CI unit crash do thiếu PostgreSQL. | **ĐÃ GIẢI QUYẾT TRIỆT ĐỂ** | Đã chuyển toàn bộ sang lớp kiểm thử `db` (`test/db/openapi-spec.db-spec.ts`) chạy trên temp PostgreSQL database (Testcontainers). Sơ đồ kiến trúc Mermaid (§3) và bảng test (§4) đã cập nhật đồng bộ. |
| 2 | **blocking** | Đổi decorators trên `AuditController` và `FraudHttpController` sang `ProblemDetailsDto` làm gãy test schema cứng ở `audit-search.http.db-spec.ts` và `fraud-operator-http.db-spec.ts`. | **ĐÃ GIẢI QUYẾT TRIỆT ĐỂ** | Quyết định G1 #1 (§1) và danh mục thành phần (§3) đã xác định rõ: giữ nguyên vẹn `AuditSearchProblemDto` và `FraudProblemDto`, chỉ dùng `ProblemDetailsDto` cho các controller còn lại. Bảo toàn 100% test contract hiện có. |
| 3 | **should-fix** | TC-137-03 ép buộc mọi response lỗi đều phải có `errorCode` là sai với 404 và 400 validation. | **ĐÃ GIẢI QUYẾT TRIỆT ĐỂ** | Đã làm rõ ở §1, §2.2 và §4 (TC-137-03): trường `errorCode` trên `ProblemDetailsDto` là tùy chọn (`optional`); tiêu chí kiểm tra chuyển thành xác thực 14 mã `ErrorCode` phân bổ đầy đủ trên các examples của các endpoint tương ứng theo Bảng 2.3. |
| 4 | **should-fix** | TC-137-05 đối chiếu trực tiếp `docs/03 §7` sẽ fail do 2 endpoint Planned của UC-12 chưa có controller runtime. | **ĐÃ GIẢI QUYẾT TRIỆT ĐỂ** | Đã giới hạn rõ ở Quyết định G1 #3 (§1) và TC-137-01, TC-137-05 (§4): đối chiếu khớp 1:1 với 17 Implemented paths / 19 operations, loại trừ 2 endpoint Planned UC-12 (`/v1/admin/risk-config*`). |
| 5 | **minor** | `HealthController.live()` thiếu `@ApiOkResponse` khiến OpenAPI sinh response 200 rỗng. | **ĐÃ GIẢI QUYẾT TRIỆT ĐỂ** | Đã bổ sung `@ApiOkResponse` với schema `{ status: { type: 'string', enum: ['ok'] } }` tại §2.4, §3 và tiêu chuẩn kiểm thử tại TC-137-02. |
| 6 | **minor** | Bước test thủ công M-137-01 thiếu điều kiện tiên quyết `docker compose up -d`. | **ĐÃ GIẢI QUYẾT TRIỆT ĐỂ** | Đã bổ sung điều kiện tiên quyết khởi động hạ tầng bằng `docker compose up -d` vào bảng M-137-01 (§5). |

---

### 2. Đánh giá chuyên sâu về nghiệp vụ ngân hàng & an toàn hệ thống

1. **Idempotency & Double-entry Ledger:**
   - Header bắt buộc `Idempotency-Key` (1–128 ký tự) được khai báo chính xác trên 2 endpoint thay đổi tiền tệ: `POST /v1/transfers` và `POST /v1/operator/deposits`.
   - Các mã lỗi nghiệp vụ của chuyển tiền (`ACCOUNT_NOT_ACTIVE`, `LIMIT_PER_TX_EXCEEDED`, `LIMIT_PER_DAY_EXCEEDED`, `INSUFFICIENT_FUNDS`, `IDEMPOTENCY_KEY_REUSED`) và nạp tiền đều trả 422 Problem Details kèm `transferId` đầy đủ, khớp 100% với kiến trúc `transfers.reject_reason`.
2. **Bảo mật & Phân quyền (RBAC):**
   - Security scheme `bearerAuth` (`access-token`) gắn đúng 17 endpoint nghiệp vụ. Hai probe `/health/live` và `/health/ready` là `@Public()`.
   - Sử dụng `@ApiExtension('x-roles', ...)` cho `GET /v1/identity/me` đảm bảo hiển thị đúng vai trò trên Swagger mà không gắn `@Roles()`, bảo vệ tính đúng đắn của `NO_ROLE_ALLOWLIST` trong `roles-app.e2e-spec.ts`.
   - Che giấu số dư và dữ liệu nhạy cảm: `GET /v1/operator/accounts` không lộ `balance`; `GET /v1/transfers/{id}` không lộ cờ gian lận; truy cập tài khoản không thuộc về caller trả 404 thay vì 403 nhằm chống account enumeration.
3. **Tính chuẩn hóa RFC 7807:**
   - Body lỗi chuẩn hóa theo `application/problem+json` với các trường `type`, `title`, `status`, `detail`, `correlationId`, `errorCode` (optional), `errors`, `transferId`.

---

### 3. Bảng tổng hợp phát hiện còn lại

| # | Mức độ | Vị trí | Phát hiện | Khắc phục đề xuất |
|---|---|---|---|---|
| — | — | — | *Không còn phát hiện nào* | *Thiết kế đã hoàn thiện và sẵn sàng triển khai mã nguồn* |

---

Verdict: APPROVE

