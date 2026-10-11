# ADR-09: Nạp tiền qua tài khoản SYSTEM `funding`, một hàng duy nhất ở v1

| | |
|---|---|
| Trạng thái | **Accepted** |
| Ngày | 2026-10-11 |
| Người viết | #1 (Ledger) |
| Người duyệt | #4 (cặp đôi); cả nhóm |
| Liên quan | Driver D-1 · BR-01, BR-02, UC-3 · NFR-COR-02 · [`docs/03` §6.1, §6.4](../03_HIGH_LEVEL_ARCHITECTURE.md) · [database-design §4.2, §13 điểm 16](../components/_shared/database-design.md) · [ADR-04](0004-row-locking-read-committed.md) |

## Bối cảnh

Tiền phải đi vào hệ thống từ đâu đó (UC-3: nhân viên nạp tiền tại quầy). Bất biến của sổ cái (NFR-COR-02) là tổng Nợ = tổng Có và **tổng số dư mọi tài khoản = 0**. Nếu nạp tiền bằng cách tăng số dư trực tiếp, cả hai bất biến này bị phá và đối soát không còn ý nghĩa.

## Các phương án

| Tiêu chí | A. Sửa `accounts.balance` trực tiếp | **B. Một tài khoản SYSTEM `funding`** | C. Nhiều tài khoản funding, chọn ngẫu nhiên |
|---|---|---|---|
| Bút toán kép, đối soát được | Không | **Có** | Có |
| Tổng số dư = 0 | Không | **Có (`funding` âm đúng bằng tổng tiền đã nạp)** | Có |
| Dùng lại luồng chuyển tiền (idempotency, nhật ký, outbox) | Không | **Có, chỉ khác `type = DEPOSIT`** | Có |
| Tranh chấp khóa | Không | Mọi lệnh nạp khóa cùng một hàng | Chia tải ra N hàng |
| Độ phức tạp | Thấp | **Thấp** | Thêm logic chọn và bỏ index `accounts_single_system` |

## Quyết định

Chọn **B**:

- Migration 1 tạo đúng một tài khoản `type = 'SYSTEM'`, `customer_id = NULL`, **id cố định**. Index một phần `accounts_single_system` bảo đảm chỉ có một tài khoản SYSTEM.
- Tài khoản SYSTEM được phép âm (`CHECK (type = 'SYSTEM' OR balance >= 0)`).
- `POST /v1/operator/deposits` (chỉ `operator`) đi qua cùng luồng với chuyển tiền: `Idempotency-Key`, khóa theo thứ tự id, hai bút toán, nhật ký, outbox `TransferCompleted` với `type = DEPOSIT`.
- Sync guard bỏ qua kiểm tra số dư và hạn mức **của tài khoản SYSTEM**. Tài khoản nhận vẫn phải `ACTIVE`. Tiền nạp không tính vào hạn mức ngày của khách nhận (hạn mức chỉ tính tiền đi).
- Script seed tạo dữ liệu demo **chỉ qua API nạp tiền**, không bao giờ `UPDATE balance`.

## Lý do

- Nạp tiền trở thành một giao dịch bình thường của sổ cái, nên mọi bất biến, đối soát và nhật ký đều áp dụng mà không cần trường hợp đặc biệt.
- Nạp tiền do nhân viên làm tại quầy, tần suất thấp. Đường nóng là chuyển tiền giữa khách, không đụng `funding`. Xếp hàng ở một hàng là chấp nhận được.

## Đánh đổi và hệ quả

- Mọi lệnh nạp tiền chạy tuần tự qua một hàng. Seed vài nghìn lệnh mất vài chục giây.
- **Khi nào chuyển sang C:** load test (DBS-166) hoặc seed cho thấy thời gian chờ khóa `funding` làm p95 nạp tiền > 1 giây, hoặc có kịch bản nạp tiền tần suất cao. Khi đó tạo N tài khoản funding, chọn ngẫu nhiên mỗi lệnh, bỏ index `accounts_single_system` và đổi kiểm tra đối soát thành "tổng số dư = 0" (vẫn đúng).
- `funding` âm là đúng thiết kế. Dashboard không được báo động vì nó.

## Cách kiểm chứng

- Sau seed và sau mỗi load test: `SUM(balance)` mọi tài khoản = 0, tổng Nợ = tổng Có (DBS-69, DBS-117).
- Test DB từ chối tài khoản SYSTEM thứ hai và SYSTEM có `customer_id` (DBS-20).
- Đo thời gian seed N lệnh nạp và p95 nạp tiền trong load test (DBS-70, DBS-166).
