# ADR-03: Chuyển tiền đồng bộ, tác vụ phụ bất đồng bộ qua outbox và SQS (mỗi consumer một queue)

| | |
|---|---|
| Trạng thái | **Accepted** |
| Ngày | 2026-10-11 |
| Người viết | #3 (Async & Audit) |
| Người duyệt | Cả nhóm |
| Liên quan | Driver D-4, D-5 · NFR-PERF-01, NFR-FRD-01, FR-RSK-04 · [`docs/03` §10, §11](../03_HIGH_LEVEL_ARCHITECTURE.md) · [event-contract](../components/_shared/event-contract.md) |

## Bối cảnh

Sau khi chuyển tiền, hệ thống còn hai việc: chấm điểm gian lận (UC-9) và gửi thông báo (FR-NOT-01). Hai việc này không được làm chậm phản hồi chuyển tiền (p95 < 300 ms, NFR-PERF-01) và lỗi của chúng không được làm hỏng giao dịch. Đồng thời không được mất sự kiện: giao dịch đã commit thì chắc chắn phải được chấm điểm (D-5).

Ghi DB rồi gửi message ngay trong request có hai lỗi kinh điển. Gửi trước commit thì rollback rồi mà sự kiện vẫn đi. Gửi sau commit thì tiến trình chết giữa hai bước là mất sự kiện.

## Các phương án

| Tiêu chí | A. Đồng bộ toàn bộ | B. Full async / saga | **C. Đồng bộ phần tiền + outbox + SQS** | D. Như C nhưng fan-out bằng SNS |
|---|---|---|---|---|
| Latency chuyển tiền | Cộng thêm thời gian chấm điểm và thông báo | Khách không biết ngay kết quả | **Chỉ một transaction DB** | Như C |
| Tiền đúng (D-1) | Đúng | Cần bù trừ khi bước sau lỗi | **Đúng: phần tiền vẫn một transaction** | Như C |
| Không mất sự kiện (D-5) | Không áp dụng | Phụ thuộc broker | **Outbox ghi cùng transaction** | Như C |
| Lỗi notification ảnh hưởng chuyển tiền | Có | Không | **Không** | Không |
| Chạy giống nhau ở local và AWS | Có | Khó | **ElasticMQ tương thích SQS** | Cần giả lập SNS |
| Số dịch vụ AWS | 0 | 1+ | **1 (SQS)** | 2 (SNS + SQS) |

## Quyết định

Chọn **C**:

- Request chuyển tiền chỉ làm một transaction PostgreSQL. Transaction này ghi thêm một dòng `outbox_events` cùng lúc với bút toán.
- Outbox relay chạy ở role `worker`. Mỗi chu kỳ nó lấy một lô bằng `FOR UPDATE SKIP LOCKED`, gửi sự kiện tới **mọi queue quan tâm** theo bảng định tuyến, rồi mới đặt `published_at`.
- Mỗi consumer có **một queue SQS standard riêng và một DLQ riêng**: `risk-events`, `notification-events`. Lý do: một queue SQS chỉ giao mỗi message cho một consumer.
- Consumer idempotent bằng `processed_events(consumer, event_id)`, ghi cùng transaction với tác động của nó.

Tham số chốt cho v1:

| Tham số | Giá trị | Lý do |
|---|---|---|
| Chu kỳ poll của relay khi rảnh | 500 ms | Đạt mục tiêu "≤ 1 giây" với dư địa; tinh chỉnh ở DBS-175 |
| Kích thước lô relay | 100 sự kiện | 120 RPS × 20% ghi ≈ 25 sự kiện/giây, một lô đủ cho vài giây tồn |
| Visibility timeout | 30 giây | Lớn hơn nhiều thời gian xử lý một sự kiện (mục tiêu < 50 ms) |
| Long polling (`WaitTimeSeconds`) | 20 giây | Giảm số lần gọi rỗng, giảm chi phí |
| Chuyển DLQ sau | 5 lần nhận (`maxReceiveCount = 5`) | Đủ cho lỗi tạm thời; message sai schema thì consumer chuyển DLQ ngay |
| Thời gian giữ message | 4 ngày (mặc định SQS) | `processed_events` giữ 7 ngày, lâu hơn 4 ngày cộng dư (database-design §10) |
| Sự kiện phát ở v1 | `TransferCompleted`, `AccountStatusChanged` | `TransferRejected` không phát ở v1 (event-contract) |

## Lý do

- Phần tiền giữ ACID đơn giản, không cần saga. Phần phụ trở thành at-least-once kèm consumer idempotent, tức là effectively-once về hiệu ứng.
- Outbox là ngoại lệ duy nhất của quy tắc "không gọi SQS trong transaction". Relay chỉ khóa hàng `outbox_events`, không đụng hàng tài khoản, nên gửi lặp vẫn an toàn.
- Bảng định tuyến thay SNS. Với hai consumer, thêm SNS chỉ thêm một dịch vụ cần dựng, cấp quyền và giả lập, mà không giải quyết vấn đề nào nhóm đang có.

## Đánh đổi và hệ quả

- Cờ gian lận xuất hiện sau giao dịch vài trăm ms tới vài giây, không chặn được giao dịch đang chạy. Chấp nhận vì có nhân viên review (ADR-08).
- SQS standard không đảm bảo thứ tự và có thể giao trùng. Consumer không được phụ thuộc thứ tự, và mọi cửa sổ thời gian tính theo `occurredAt`.
- Bảng outbox lớn dần, nên job dọn xóa dòng đã gửi sau 7 ngày (DBS-92). Dòng chưa gửi không bao giờ bị xóa.
- Thêm consumer mới nghĩa là thêm queue, thêm DLQ và thêm một dòng vào bảng định tuyến. **Xem lại SNS khi** có từ 4 consumer trở lên.

## Cách kiểm chứng

- Kill relay giữa chừng rồi bật lại: sự kiện vẫn tới đủ queue (DBS-91, Demo 3).
- Gửi cùng `eventId` 3 lần thì chỉ có 1 hiệu ứng; message sai schema vào DLQ ngay (DBS-101, DBS-104).
- Notification lỗi liên tục không ảnh hưởng risk và chuyển tiền (DBS-125, DBS-183).
- Đo thời gian từ giao dịch tới cờ ở 12, 60 và 120 RPS (DBS-174): p95 < 5 giây.
