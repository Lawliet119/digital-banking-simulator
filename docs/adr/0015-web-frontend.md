# ADR-15: Giao diện web là app tĩnh React + Vite, gọi API có sẵn, không thêm service

| | |
|---|---|
| Trạng thái | Accepted |
| Ngày | 2026-11-28 |
| Người viết | Dev (kế hoạch UI) |
| Người duyệt | Techlead |
| Liên quan | BRD §7.1, UC-1…UC-12, AC-10.2, docs/03 §4, kế hoạch UI `docs/plans/2026-11-15-ui-implementation-plan.md` (Q1–Q9, bản nháp ngoài repo), ADR-06, ADR-13 |

## Bối cảnh

Đến tuần 9 hệ thống chỉ dùng được qua công cụ gọi API (Postman, k6, `curl`): BRD §7.1 để "giao diện web hoàn chỉnh" ngoài phạm vi. Demo 9 bước (demo giữa kỳ) vì vậy phải gõ lệnh cho từng vai trò, và người xem không thấy được điều đồ án muốn chứng minh: khách không thấy cờ (AC-10.2), lệnh chuyển gửi lại không trừ tiền hai lần (AC-5.10), nhân viên review một lần (AC-10.1).

Ràng buộc: không đổi hợp đồng `POST /v1/transfers` và các giá trị rate limit mặc định (các task đo tải đo theo chúng); không thêm đường ghi số dư; đợt này chỉ chạy local, đăng nhập thật qua Identity Provider để đợt cloud. Đồ án không chấm thiết kế đồ họa.

## Các phương án

| Tiêu chí | A. App tĩnh React + Vite, gọi `/v1` có sẵn | B. Render phía server (một service web mới, ví dụ Next.js) | C. Giữ dòng lệnh, chỉ viết kịch bản demo tốt hơn |
|---|---|---|---|
| Thêm thành phần chạy | Không: file tĩnh, host bằng Static Web Hosting ở đợt cloud | Một service mới cần chạy, scale, giám sát, quét image | Không |
| Hợp đồng API | Một nguồn: kiểu sinh từ `docs/deliverables/openapi.json`, lệch thì CI đỏ | Có thể gọi thẳng DB hoặc lặp lại logic nếu không giữ kỷ luật | Không đổi |
| Phân quyền | Ở server như cũ; UI chỉ ẩn màn hình | Thêm một lớp phải kiểm | Không đổi |
| Bảo mật token | Token trong bộ nhớ và `sessionStorage` của trình duyệt (rủi ro XSS) | Token ở server, cookie phiên (thêm CSRF) | Token trong terminal |
| Chi phí | Gần 0 (file tĩnh) | Thêm task chạy liên tục | 0 |
| Giá trị cho demo | Đi trọn 9 bước bằng giao diện; Playwright kiểm 11 kịch bản | Như A | Thấp |

## Quyết định

Chọn **A**: `frontend/` là app tĩnh React 19 + Vite + TypeScript (React Router, TanStack Query, CSS thuần), gọi các endpoint `/v1` có sẵn qua `openapi-fetch` với kiểu sinh từ OpenAPI. Không thêm service, không có logic nghiệp vụ ở frontend. Ở local, Vite proxy `/v1` để cùng origin và ký token local qua một plugin chỉ có ở `vite dev`.

Backend chỉ thêm ba thứ UI cần: số tài khoản và tra người nhận (chặng A), đọc thông báo (chặng B), tắt êm khi SIGTERM (chặng C, BL-381).

## Lý do

- Kiến trúc giữ nguyên: một ứng dụng, một image (ADR-13); mọi quy tắc tiền, quyền và kiểm toán vẫn nằm ở server và đã có test. Frontend chỉ là một client nữa, như Postman.
- Kiểu sinh từ OpenAPI làm hợp đồng có một nguồn: backend đổi DTO mà quên frontend thì job `frontend` đỏ ở bước kiểm diff.
- File tĩnh khớp với khối Static Web Hosting trong kiến trúc trung lập, không tốn task chạy liên tục.
- Các quyết định nhỏ (Q1–Q9 của kế hoạch) đều chọn ít phụ thuộc: không thư viện component, không global store, polling thay vì kênh đẩy.

## Đánh đổi và hệ quả

- **Token nằm trong trình duyệt.** Một lỗi XSS đọc được token (15 phút). Giảm bằng: không `localStorage` (ESLint chặn), React escape mặc định, không `dangerouslySetInnerHTML`, `<meta name="referrer" content="no-referrer">`; đợt cloud thêm Content-Security-Policy ở nơi host. Ghi ở threat model T26, T27.
- **Số tài khoản tuần tự đoán được**, nên endpoint tra cứu có thể bị dò tên chủ. Giảm bằng giới hạn 20 lần/phút/khách và audit `account.lookup`; giới hạn fail-open khi Valkey lỗi. Threat model T28.
- **Polling** (10 giây, chỉ ở danh sách cờ và thông báo, dừng khi tab ẩn) thêm khoảng 12 request/phút/tab, dưới ngưỡng 100/phút/IP.
- **Đăng nhập local** là plugin của Vite gọi CLI ký token; không vào bản build, và backend từ chối `AUTH_MODE=local` ở staging/production (T3). Đợt cloud thêm một `AuthSource` cho Identity Provider mà không sửa màn hình.
- Lệch so với kế hoạch: test đơn vị dùng Vitest không có Testing Library (logic thuần ở `src/lib`, `src/api`); màn hình được kiểm bằng Playwright với backend thật.
- Xem lại khi: cần ứng dụng di động, cần đẩy sự kiện thời gian thực, hoặc khi có người dùng thật (khi đó cân nhắc cookie phiên thay cho token trong trình duyệt).

## Cách kiểm chứng

- `frontend/` job CI `frontend`: kiểu khớp OpenAPI, lint, typecheck, Vitest (tiền bằng `BigInt`, idempotency, lỗi theo `errorCode`), build.
- Job CI `frontend-e2e`: Playwright với backend thật `APP_ROLE=both`, 11 kịch bản demo (bảng ở `frontend/README.md`), rồi `check:invariants`.
- Kịch bản 5 quét chữ trên mọi màn hình của khách đã bị gắn cờ: không có "cờ", "gian lận", "điểm", "AI" (AC-10.2). Kịch bản 9 cắt phản hồi sau "Chuyển" rồi bấm lại: cùng `Idempotency-Key`, tiền chỉ chuyển một lần.
