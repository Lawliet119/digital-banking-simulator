# ADR-04: Khóa `SELECT … FOR UPDATE` theo thứ tự id ở READ COMMITTED

| | |
|---|---|
| Trạng thái | **Accepted** |
| Ngày | 2026-10-11 |
| Người viết | #1 (Ledger) |
| Người duyệt | #4 (cặp đôi); cả nhóm |
| Liên quan | Driver D-1 · NFR-COR-01, NFR-COR-03, NFR-SCAL-02 · AC-5.6, AC-5.9 · [`docs/03` §6.1](../03_HIGH_LEVEL_ARCHITECTURE.md) · [ADR-02](0002-postgresql-ledger.md) |

## Bối cảnh

Hai lệnh chuyển tiền chạy đồng thời trên cùng tài khoản nguồn có thể cùng đọc "còn đủ số dư" hoặc "còn hạn mức ngày" rồi cùng ghi, và số dư hoặc hạn mức bị vượt (AC-5.6). Hai lệnh A→B và B→A khóa hai tài khoản theo thứ tự ngược nhau thì có thể deadlock. Tài khoản "nóng" nhận 20 lệnh/giây (NFR-SCAL-02) cần khóa giữ thật ngắn.

## Các phương án

| Tiêu chí | **A. `FOR UPDATE` theo thứ tự id, READ COMMITTED** | B. Optimistic (`version` + retry) | C. SERIALIZABLE |
|---|---|---|---|
| Đúng khi đồng thời | **Đúng: lệnh sau chờ lệnh trước** | Đúng nếu mọi đường ghi đều kiểm `version` | Đúng |
| Hạn mức ngày (đọc `SUM` trên bảng khác) | **Đúng: tài khoản nguồn đang khóa nên lệnh khác phải chờ** | Không tự bảo vệ: `SUM` đọc bảng khác, không có `version` | Đúng nhờ phát hiện xung đột |
| Hành vi khi tranh chấp cao (tài khoản nóng) | **Xếp hàng, mỗi lệnh vài ms** | Retry dồn dập, p95 tăng mạnh | Nhiều lỗi `40001`, retry dồn dập |
| Deadlock | **Không, nhờ khóa theo thứ tự id** | Không có khóa | Có thể có |
| Độ phức tạp code | **Thấp: 1 câu SQL khóa + 1 sync guard** | Retry ở mọi đường ghi | Retry ở mọi transaction |

## Quyết định

Chọn **A**:

1. Transaction chạy ở **READ COMMITTED** (mặc định của PostgreSQL).
2. Khóa hai tài khoản bằng `SELECT … FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE`, **luôn theo thứ tự id tăng dần**, không theo thứ tự nguồn/đích.
3. Sync guard (trạng thái, hạn mức lần, hạn mức ngày, số dư) chạy **sau** khi đã khóa.
4. `TransactionService` đặt `lock_timeout = 2 s`, `statement_timeout = 5 s`, `idle_in_transaction_session_timeout = 10 s`. Gặp `40P01` (deadlock) hoặc `40001` thì chạy lại cả callback, tối đa 3 lần, có backoff và jitter. Vẫn lỗi thì trả **503 + `Retry-After`**.

## Lý do

- Hạn mức ngày là `SUM` trên `ledger_entries`, không nằm trên hàng tài khoản. Phương án B không bảo vệ được truy vấn này. Ở A, tài khoản nguồn đã khóa nên mọi lệnh khác từ tài khoản đó phải chờ, và `SUM` luôn thấy dữ liệu đã commit của lệnh trước.
- Khóa theo thứ tự id loại bỏ deadlock giữa hai lệnh chuyển chéo mà không cần logic đặc biệt.
- Transaction chỉ gồm vài câu lệnh và không gọi dịch vụ ngoài, nên khóa được giữ vài ms. Tài khoản nóng xếp hàng chứ không retry dồn dập.

## Đánh đổi và hệ quả

- Lệnh trên cùng tài khoản chạy tuần tự. Thông lượng của một tài khoản bị chặn trên bởi thời gian một transaction (mục tiêu ≤ 20 ms ở tài khoản nóng nên trên 20 lệnh/giây vẫn đạt).
- Cấm gọi Redis, HTTP, SQS trong transaction (CONTRIBUTING §5). Callback phải chạy lại được an toàn vì có thể bị retry.
- Tài khoản SYSTEM `funding` bị khóa ở mỗi lần nạp tiền, nên nạp tiền xếp hàng (ADR-09).
- **Xem lại khi:** load test cho thấy `lock_timeout` xảy ra thường xuyên ở tải thiết kế.

## Cách kiểm chứng

- AC-5.6: 2 lệnh 15 triệu song song khi đã chuyển 180 triệu → đúng 1 COMPLETED (DBS-98).
- A→B và B→A song song ≥ 100 lần không treo, không 500 (DBS-80); AC-5.9 với ≥ 50 luồng và một tài khoản nóng (DBS-99).
- Tài khoản nóng 20 lệnh/giây, p95 < 1 giây (DBS-166).
- Đối soát 0 lệch sau mọi test đồng thời (DBS-69).
