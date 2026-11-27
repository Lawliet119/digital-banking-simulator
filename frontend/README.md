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

Màn hình đăng nhập chọn vai trò và mã người dùng (`sub`). Cùng `sub` là cùng một người ở lần sau. Token do `/__dev-auth/token` của Vite ký bằng lệnh `npm run auth:dev-token` của backend; route này chỉ có ở `vite dev` (`apply: 'serve'`), bản build không có.

## Lệnh

| Lệnh                | Việc                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `npm run dev`       | dev server, có route ký token local                                      |
| `npm run build`     | kiểm kiểu rồi build vào `dist/`                                          |
| `npm run lint`      | ESLint và Prettier                                                       |
| `npm run typecheck` | `tsc --noEmit`                                                           |
| `npm test`          | Vitest: tiền, idempotency, lỗi, plugin dev-auth                          |
| `npm run test:e2e`  | Playwright, cần backend đang chạy (bước 1); tự bật Vite nếu chưa có      |
| `npm run api:types` | sinh lại `src/api/schema.d.ts` từ OpenAPI; CI đỏ nếu file đã commit khác |

## Quy tắc

- **Tiền là chuỗi số nguyên đồng**, xử lý bằng `BigInt` (`src/lib/money.ts`). Không đổi sang `number`.
- **Form chuyển và nạp tiền** giữ một `Idempotency-Key` cho mỗi lần thử (`src/lib/idempotency.ts`): lỗi mạng, timeout, 5xx, 429 gửi lại cùng mã; câu trả lời dứt khoát (2xx, 4xx khác 429) mới đổi mã.
- **Token** ở bộ nhớ và `sessionStorage`, không bao giờ `localStorage` (ESLint chặn).
- **Lỗi** đọc theo `errorCode` (`src/api/problem.ts`), không theo `detail`. Mã chưa biết hiện câu chung kèm mã truy vết.
- **401** đưa về màn hình đăng nhập với "Phiên đã hết hạn hoặc bị thu hồi".
- **`RequireRole`** chỉ ẩn màn hình; phân quyền thật ở server.
- Nguồn token nằm sau interface `AuthSource` (`src/auth/auth-source.ts`): đợt cloud thêm nguồn Identity Provider mà không sửa màn hình.
