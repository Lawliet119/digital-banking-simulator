# ADR-01: Modular monolith cộng một worker, không dùng microservices

| | |
|---|---|
| Trạng thái | **Accepted** |
| Ngày | 2026-10-11 |
| Người viết | #1 (Ledger) |
| Người duyệt | Cả nhóm |
| Liên quan | Driver D-1, D-8 · NFR-COR-01, NFR-SCAL-01 · [`docs/03` §2, §4, §5](../03_HIGH_LEVEL_ARCHITECTURE.md) · [ADR-13](0013-one-app-app-role.md) |

## Bối cảnh

Hệ thống có 8 module nghiệp vụ (identity, accounts, ledger, risk, audit, outbox, notification, health). Use case quan trọng nhất là chuyển tiền (UC-5). Nó chạm bốn module trong một thao tác: `ledger` ghi bút toán, `accounts` khóa và đổi số dư, `audit` ghi nhật ký, `outbox` ghi sự kiện. Ba việc phải thành công cùng nhau hoặc cùng không xảy ra (BR-02, NFR-COR-01).

Ràng buộc: 6 sinh viên, 10 tuần, một người lo toàn bộ hạ tầng (#5). Tải thiết kế là 120 RPS (docs/02 §5), nhỏ so với khả năng của một tiến trình Node.js có pool kết nối.

## Các phương án

| Tiêu chí | A. Monolith không chia module | **B. Modular monolith + worker** | C. Microservices |
|---|---|---|---|
| Chuyển tiền nguyên tử (D-1) | Một transaction | **Một transaction** | Trải qua nhiều service, cần saga và bù trừ |
| Giao việc cho 6 người | Code dính nhau, dễ đụng nhau | **Mỗi người một module, ranh giới do eslint ép** | Mỗi người một service |
| Tác vụ nền không làm chậm request (D-4) | Phải tự tách luồng trong cùng tiến trình | **Worker riêng, cùng image** | Service riêng |
| Vận hành | 1 service | **2 ECS service, 1 image, 1 pipeline** | 6–8 service, 6–8 pipeline, service discovery |
| Scale ở 120 RPS | Đủ | **Đủ: API scale ngang 1 → N task** | Thừa |
| Chi phí | Thấp nhất | **Thấp** | Cao (nhiều task tối thiểu, nhiều ALB target) |

## Quyết định

Chọn **B**: một ứng dụng NestJS chia module theo bounded context của docs/02 §6, chạy thành hai ECS service là `api` và `worker`. Hai service dùng cùng image và khác nhau ở biến `APP_ROLE` (ADR-13).

## Lý do

- Chuyển tiền đúng tuyệt đối là thứ đề bài chấm nặng nhất. Với B, toàn bộ luồng (mã yêu cầu, khóa, bút toán, số dư, nhật ký, outbox) nằm trong **một transaction PostgreSQL**, không cần saga.
- Ranh giới module vẫn rõ: mỗi module chỉ lộ `index.ts`, module khác import qua `@modules/<tên>`. eslint chặn import sâu (docs/03 §5), nên kỷ luật này không phụ thuộc vào trí nhớ của người viết.
- Worker tách tác vụ chậm (relay outbox, chấm điểm, thông báo) ra khỏi đường request. Nhờ vậy p95 chuyển tiền không phụ thuộc phần fraud.
- Với 120 RPS, scale cả khối là đủ. Microservices giải quyết bài toán scale và deploy độc lập mà nhóm không gặp, và đổi lại bằng chi phí vận hành mà một người không gánh nổi.

## Đánh đổi và hệ quả

- Scale theo cả khối: module nóng nhất kéo theo cả ứng dụng. Chấp nhận được ở tải thiết kế.
- Một lỗi rò bộ nhớ ở bất kỳ module nào ảnh hưởng cả tiến trình `api`. Giảm bằng health check và ECS thay task.
- Nếu sau này cần tách service, ranh giới đã có sẵn: `risk` và `notification` chỉ nói chuyện với phần còn lại qua sự kiện, nên tách ra là ít đau nhất.
- **Xem lại khi:** tải vượt xa 120 RPS và một module chiếm phần lớn tài nguyên, hoặc nhóm cần deploy độc lập theo nhịp khác nhau.

## Cách kiểm chứng

- AC-5.1…5.10 xanh trên PostgreSQL thật: chuyển tiền nguyên tử trong một transaction.
- `npm run lint:check` bắt được import xuyên module sai quy tắc (đã có trong CI).
- Load test 120 RPS (DBS-166) đạt NFR-PERF-01 với API scale ngang.
