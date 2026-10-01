# ADR-13: Một ứng dụng, một image, chạy theo `APP_ROLE`

| | |
|---|---|
| Trạng thái | **Proposed** — đã hiện thực trong `backend/`, chờ nhóm xác nhận (đổi thành Accepted sau khi review) |
| Ngày | 2026-10-01 |
| Người viết | Bản nháp ban đầu; #1 và #5 rà soát và nhận làm chủ ADR |
| Người duyệt | #1 duyệt; cả nhóm đồng ý ở buổi họp đầu tuần |
| Liên quan | Driver D-8 · ADR-01 (modular monolith) · `docs/03` §4, §13 · [`backend/README.md`](../../backend/README.md) |

## Bối cảnh

Kiến trúc có hai thành phần chạy riêng trên ECS: **API** (phục vụ HTTP) và **Worker** (outbox relay, chấm điểm rủi ro, thông báo). Cả hai đều là code NestJS dùng chung module, entity và cấu hình. Câu hỏi: cấu trúc repo và image thế nào?

Điểm khó nằm ở các module vừa có phần HTTP vừa có phần nền. Ví dụ `risk`: controller cho nhân viên review cờ (API) và consumer chấm điểm giao dịch (Worker) dùng chung entity `fraud_flags`, `risk_rule_sets` và cùng bộ luật.

Ràng buộc: nhóm 6 người, 10 tuần, một người lo toàn bộ CI/CD và hạ tầng (#5).

## Các phương án

| Tiêu chí | A. Hai app (`apps/api`, `apps/worker`) + thư viện chung | **B. Một app, một image, `APP_ROLE`** | C. Hai repo |
|---|---|---|---|
| Số Dockerfile / pipeline build / lần quét image | 2 | **1** | 2 + liên repo |
| Module có cả HTTP lẫn consumer (`risk`) | Phải tách đôi (`risk-admin`, `risk-scoring`) và đẩy entity + luật sang `libs/` | **Một thư mục, một module** | Trùng lặp hoặc package riêng |
| Phụ thuộc giữa module | Qua `libs/`, dễ phình thành "bãi chứa" | **Qua `index.ts` của module, eslint ép** | Qua package, phải version |
| Chạy ở máy local | 2 process | **1 process (`APP_ROLE=both`)** | 2 process, 2 repo |
| Scale độc lập API và Worker | Có | **Có** (hai ECS service, cùng image) | Có |
| Rủi ro | Phải duy trì ranh giới `libs/` | Chạy nhầm consumer trên instance `api` nếu quên chặn | Cao nhất |

## Quyết định

**Phương án B.** Một ứng dụng NestJS (`backend/`), một Dockerfile. Biến `APP_ROLE` chọn vai trò khi khởi động:

| `APP_ROLE` | Chạy | Không chạy |
|---|---|---|
| `api` | HTTP (controller) | consumer, scheduler |
| `worker` | outbox relay, risk scoring, notification | HTTP listener |
| `both` (mặc định) | tất cả | — |

Trên AWS là hai ECS service dùng cùng image, khác `APP_ROLE`; scale độc lập nhau.

## Lý do

- **Một image, một pipeline.** Đúng một lần build, một lần quét lỗ hổng, một tag, và image chạy ở production chính là image đã test. Với một người lo toàn bộ DevOps, đây là khoản giảm việc lớn nhất.
- **Module nguyên vẹn.** `risk` không bị tách đôi. Luật, entity và cấu hình ở một chỗ; #4 làm việc trong một thư mục.
- **Vẫn giữ được lợi ích của hai service.** Scale riêng, deploy riêng, worker không mở cổng HTTP, hỏng worker không làm sập API.
- **Local đơn giản.** `npm run start:dev` chạy mọi thứ trong một process; cần tách thì `start:dev:api` và `start:dev:worker`.

## Đánh đổi và hệ quả

| Mất gì / rủi ro | Cách giảm |
|---|---|
| Instance `api` chứa code của consumer (image lớn hơn một chút, bề mặt tấn công rộng hơn một chút) | Chấp nhận: cùng một ngôn ngữ, cùng dependency; consumer không được khởi động ở role `api` |
| Quên chặn consumer ở role `api` → instance API poll queue | `src/modules/index.ts` là nơi duy nhất đăng ký module theo role; module dùng chung bọc consumer bằng `runsWorkers()`; có test cho `modulesForRole` |
| Gõ sai `APP_ROLE` âm thầm thành `both` | `parseAppRole` ném lỗi với giá trị không hợp lệ; Joi cũng kiểm tra lúc khởi động |
| Ranh giới module dễ bị xói mòn khi mọi thứ ở chung một app | Rào chắn bằng eslint (`no-restricted-imports`): chỉ import qua `@modules/<tên>`, cấm với tay vào ruột module khác kể cả bằng `../` |
| Worker không có cổng HTTP nên không dùng `/health/ready` | ECS health check bằng lệnh riêng cho service `worker` |

**Khi nào xem lại:** nếu một thành phần cần runtime hoặc phụ thuộc khác hẳn (ví dụ chấm điểm bằng mô hình Python), tách thành service riêng — khi đó ranh giới module đã sẵn nên việc tách không đau.

## Cách kiểm chứng

- `backend/src/common/app-role/app-role.spec.ts`, `backend/src/modules/modules.spec.ts`: ma trận role → những gì được chạy.
- Chạy `node dist/main.js` với từng `APP_ROLE`: role `api` nạp `HealthModule`, role `worker` thì không; gõ sai role thì từ chối khởi động.
- Demo failure/recovery: tắt service `worker` — API vẫn nhận chuyển tiền; bật lại thì outbox được xử lý bù.
