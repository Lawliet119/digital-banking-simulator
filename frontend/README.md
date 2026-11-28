# Giao diện web

React + Vite + TypeScript, gọi API của `backend/` qua client sinh kiểu từ `docs/deliverables/openapi.json`. Đợt này chỉ chạy local, đăng nhập bằng token ký trên máy (`AUTH_MODE=local`). Kế hoạch: `docs/plans/2026-11-15-ui-implementation-plan.md`.

## Chạy

Cần Node ≥ 24 và Docker (PostgreSQL, Valkey, ElasticMQ từ `docker compose up -d` ở gốc repo).

```bash
# 1. Backend, trong backend/ (một lần: tạo khóa ký local)
npm ci
npm run auth:dev-keys
npm run migration:run
# AUTH_MODE=local, bỏ trống COGNITO_* (xem backend/README.md)
AUTH_MODE=local AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json npm run start:dev

# 2. Frontend, trong frontend/
npm ci
npm run dev        # http://127.0.0.1:5173
```

Vite chuyển `/v1` và `/health` sang `http://127.0.0.1:3000` (đổi bằng `DBS_API_URL`), nên trình duyệt chỉ thấy một origin và API không cần CORS.

Màn hình đăng nhập chọn vai trò và mã người dùng (`sub`). Cùng `sub` là cùng một người ở lần sau. Token do `/__dev-auth/token` của Vite ký bằng lệnh `npm run auth:dev-token` của backend; route này chỉ có ở `vite dev` (`apply: 'serve'`), bản build không có. Lệnh chạy trong `../backend`; backend đang chạy nằm ở checkout khác thì đặt `DBS_BACKEND_DIR` trỏ tới thư mục `backend/` đó, để token được ký bằng đúng khóa API đang tin.

## Màn hình

| Vai trò        | Route                               | Việc                                                                                                |
| -------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| Khách vãng lai | `/welcome`                          | trang giới thiệu (GSAP, tắt khi người dùng chọn giảm chuyển động); `/` chưa đăng nhập về đây        |
| Khách hàng     | `/onboarding`                       | tạo hồ sơ khi `GET /v1/customers/me` trả 404, xem trước tên                                         |
| Khách hàng     | `/accounts`                         | tổng số dư, thẻ từng tài khoản, 5 giao dịch gần nhất, biểu đồ số dư, tiền vào/ra 30 ngày, hạn mức   |
| Khách hàng     | `/accounts/:id`                     | số dư, hạn mức hôm nay, lịch sử lọc tiền vào/ra và theo ngày giờ Việt Nam, "Xem thêm"               |
| Khách hàng     | `/transfer`                         | nhập (người nhận gần đây, số tiền chọn nhanh) → xác nhận (số dư sau chuyển) → biên lai              |
| Khách hàng     | `/transfers/:id`                    | biên lai: trạng thái, số tiền, hai tài khoản, lý do nếu bị từ chối                                  |
| Khách hàng     | `/notifications`                    | số tiền, người đối ứng, số dư sau; lọc vào/ra/tài khoản; đánh dấu đã đọc; tổng hôm nay              |
| Nhân viên      | `/operator/accounts`                | tìm theo tên, số tài khoản hoặc mã; khóa và mở khóa kèm lý do bắt buộc ở khung bên                  |
| Nhân viên      | `/operator/deposit`                 | nạp tiền tại quầy, cùng quy tắc `Idempotency-Key` như chuyển tiền                                   |
| Nhân viên      | `/operator/fraud-flags`             | đếm cờ theo trạng thái review; danh sách có tên hai bên và số tiền; tự làm mới 10 giây              |
| Nhân viên      | `/operator/fraud-flags/:transferId` | điểm do server trả, luật trúng (có thể rỗng), phần AI riêng, form review một lần                    |
| Kiểm toán viên | `/audit`                            | tra nhật ký theo mã truy vết, người, hành động, khoảng thời gian; xem một bản ghi; không có nút ghi |
| Quản trị viên  | `/admin/risk-config`                | trọng số và trạng thái từng luật, ngưỡng, các phiên bản                                             |
| Quản trị viên  | `/admin/risk-config/new`            | thanh trượt trọng số ghi vào JSON gửi đi; cảnh báo đóng băng; lỗi lấy nguyên từ response 400        |

Màn hình khách không có trường nào về cờ gian lận, điểm rủi ro hay AI (AC-10.2). Tài khoản không thuộc mình và id bịa đều chỉ hiện "Không tìm thấy". Sau khi bấm "Chuyển" mà không biết kết quả (mất mạng, 5xx, 429), màn hình chỉ cho bấm "Chuyển" lại với cùng `Idempotency-Key`, không cho sửa để khỏi tạo lệnh thứ hai.

Giao diện dùng CSS thuần (`src/styles.css`), font Plus Jakarta Sans tự host qua `@fontsource-variable`, GSAP chỉ tải ở trang giới thiệu. Số tiền giữ ở `BigInt` đến bước hiển thị, kể cả biểu đồ số dư (`src/lib/chart.ts`). "Số dư sau chuyển" ở bước xác nhận chỉ để xem; server quyết định có đủ tiền hay không.

## Lệnh

| Lệnh                | Việc                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `npm run dev`       | dev server, có route ký token local                                      |
| `npm run build`     | kiểm kiểu rồi build vào `dist/`                                          |
| `npm run lint`      | ESLint và Prettier                                                       |
| `npm run typecheck` | `tsc --noEmit`                                                           |
| `npm test`          | Vitest: tiền, idempotency, lỗi, biểu đồ, cấu hình luật, plugin dev-auth  |
| `npm run test:e2e`  | Playwright, cần backend đang chạy (bước 1); tự bật Vite nếu chưa có      |
| `npm run api:types` | sinh lại `src/api/schema.d.ts` từ OpenAPI; CI đỏ nếu file đã commit khác |

## Test trên trình duyệt

Playwright chạy với backend thật. Kịch bản có thông báo và cờ gian lận cần worker, nên chạy backend ở `APP_ROLE=both` cùng ElasticMQ (`docker compose up -d`). Mọi request đi từ 127.0.0.1, nên nâng giới hạn tốc độ khi chạy test:

```bash
# trong backend/, sau bước 1 ở trên
APP_ROLE=both AUTH_MODE=local AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json \
RATE_LIMIT_REQUESTS_PER_IP_PER_MINUTE=10000 RATE_LIMIT_TRANSFERS_PER_MINUTE=1000 \
RATE_LIMIT_LOOKUPS_PER_MINUTE=1000 npm run start:dev
# trong frontend/
npm run test:e2e
# rồi trong backend/
npm run check:invariants
```

Mỗi test dùng `sub` ngẫu nhiên nên không phụ thuộc dữ liệu cũ. Job CI `frontend-e2e` chạy đúng các bước này.

| #   | Kịch bản (kế hoạch UI, chặng G)                                   | Test                             |
| --- | ----------------------------------------------------------------- | -------------------------------- |
| 1   | Khách mới tạo hồ sơ, mở tài khoản, số dư 0                        | `customer.spec.ts`               |
| 2   | Nhân viên nạp tiền; khách thấy số dư mới và thông báo             | `demo.spec.ts` G2                |
| 3   | Tra người nhận theo số, chuyển tiền, thấy Hoàn tất                | `customer.spec.ts`               |
| 4   | Giao dịch đủ điều kiện gắn cờ hiện ở danh sách cờ của nhân viên   | `demo.spec.ts` G4                |
| 5   | Không màn hình khách nào có chữ về cờ, gian lận, điểm, AI         | `demo.spec.ts` G5                |
| 6   | Nhân viên review cờ; lần review thứ hai bị từ chối                | `demo.spec.ts` G6                |
| 7   | Kiểm toán viên dán mã truy vết, thấy đủ chuỗi bản ghi             | `demo.spec.ts` G7                |
| 8   | Chuyển quá số dư hiện lý do; số dư không đổi                      | `customer.spec.ts`               |
| 9   | Mất phản hồi sau "Chuyển", bấm lại: chỉ một lệnh                  | `customer.spec.ts`               |
| 10  | Nhân viên khóa tài khoản; thao tác kế tiếp của khách về đăng nhập | `demo.spec.ts` G10               |
| 11  | Khách gõ URL của nhân viên: UI chặn, API trả 403                  | `login.spec.ts`, `staff.spec.ts` |

## Quy tắc

- **Tiền là chuỗi số nguyên đồng**, xử lý bằng `BigInt` (`src/lib/money.ts`). Không đổi sang `number`.
- **Form chuyển và nạp tiền** giữ một `Idempotency-Key` cho mỗi lần thử (`src/lib/idempotency.ts`): lỗi mạng, timeout, 5xx, 429 gửi lại cùng mã; câu trả lời dứt khoát (2xx, 4xx khác 429) mới đổi mã.
- **Token** ở bộ nhớ và `sessionStorage`, không bao giờ `localStorage` (ESLint chặn).
- **Lỗi** đọc theo `errorCode` (`src/api/problem.ts`), không theo `detail`. Mã chưa biết hiện câu chung kèm mã truy vết.
- **401** đưa về màn hình đăng nhập với "Phiên đã hết hạn hoặc bị thu hồi".
- **`RequireRole`** chỉ ẩn màn hình; phân quyền thật ở server.
- Nguồn token nằm sau interface `AuthSource` (`src/auth/auth-source.ts`): đợt cloud thêm nguồn Identity Provider mà không sửa màn hình.
