# ADR-02: PostgreSQL làm sổ cái và nguồn sự thật duy nhất

| | |
|---|---|
| Trạng thái | **Accepted** |
| Ngày | 2026-10-11 |
| Người viết | #1 (Ledger) |
| Người duyệt | Cả nhóm |
| Liên quan | Driver D-1, D-2, D-3 · NFR-COR-01…03, NFR-AUD-01 · [`docs/03` §8](../03_HIGH_LEVEL_ARCHITECTURE.md) · [database-design](../components/_shared/database-design.md) |

## Bối cảnh

Sổ cái cần bốn khả năng cùng lúc:

1. Transaction nhiều hàng, nhiều bảng: bút toán, số dư, mã yêu cầu, nhật ký và outbox cùng commit (D-1, D-2, D-3).
2. Khóa hàng để hai lệnh đồng thời trên cùng tài khoản không cùng lọt hạn mức (AC-5.6, AC-5.9).
3. Ràng buộc trong DB bảo vệ bất biến kể cả khi code sai: số dư khách không âm, mỗi giao dịch đúng một dòng Nợ và một dòng Có, mã yêu cầu duy nhất theo user.
4. Truy vấn lịch sử, đối soát và đặc trưng gian lận (trung vị 30 ngày, chuyển vòng) bằng SQL.

Workload là OLTP khoảng 120 RPS với 20% ghi (docs/02 §5). Không phải dữ liệu lớn hay streaming.

## Các phương án

| Tiêu chí | **A. PostgreSQL (RDS)** | B. DynamoDB | C. MongoDB (Atlas / DocumentDB) |
|---|---|---|---|
| Transaction nhiều hàng, nhiều bảng | **Tự nhiên** | Có (`TransactWriteItems`, tối đa 100 item) nhưng không có khóa đọc | Có từ v4, phức tạp hơn và chậm hơn |
| Khóa hàng `SELECT … FOR UPDATE` | **Có** | Không, phải dùng điều kiện ghi và retry | Hạn chế |
| Ràng buộc UNIQUE / CHECK / FK | **Đủ** | Không | Một phần (unique index, schema validation) |
| Truy vấn lịch sử, đối soát, đặc trưng | **SQL, index, `percentile_cont`** | Phải thiết kế bảng theo từng truy vấn trước | Aggregation pipeline |
| Scale ngang | Khó hơn | **Tốt nhất** | Tốt |
| Dịch vụ managed trên AWS có PITR, Multi-AZ | **RDS** | Có sẵn | DocumentDB (không hoàn toàn tương thích) |
| Chi phí ở quy mô này | **db.t4g.micro ≈ 14 USD/tháng nếu chạy 24/7** | Rẻ theo request | Atlas M10 trở lên mới có đủ tính năng |

## Quyết định

Chọn **PostgreSQL 17** trên Amazon RDS làm nguồn sự thật duy nhất cho mọi dữ liệu nghiệp vụ, sổ cái, mã yêu cầu, nhật ký kiểm toán và outbox. Local và CI dùng container `postgres:17`, timezone `UTC`.

## Lý do

- Ba bất biến khó nhất (không nhân đôi tiền, không vượt hạn mức khi đồng thời, không mất nhật ký) đều được giải bằng transaction và khóa hàng của PostgreSQL. Với DynamoDB, nhóm phải tự dựng lại các cơ chế này bằng điều kiện ghi và retry.
- Ràng buộc trong DB là lớp phòng thủ thứ hai: code ledger có lỗi thì DB vẫn từ chối số dư khách âm, một dòng sổ sai số tiền hoặc sai tài khoản so với giao dịch của nó, bút toán cho giao dịch bị từ chối, và dòng Nợ hoặc Có thứ hai của cùng một giao dịch (database-design §4.3, §4.4). DB **chưa** ép "mỗi giao dịch `COMPLETED` có đủ cả dòng Nợ và dòng Có" và `balance_after` khớp số dư: phần đó do code cùng transaction và job đối soát giữ (`docs/BACKLOG.md`).
- Truy vấn đặc trưng gian lận và đối soát viết được bằng SQL có index, không cần thêm kho phân tích.
- Lợi thế scale ngang của DynamoDB và MongoDB không cần ở 120 RPS.

## Đánh đổi và hệ quả

- Scale ghi chỉ theo chiều dọc. Ở quy mô đồ án, một instance nhỏ là đủ; nếu tăng nhiều, bước đầu là tăng cỡ instance, tiếp theo là read replica cho truy vấn đọc lịch sử.
- Số kết nối có giới hạn: `DATABASE_POOL_MAX × số task ≤ max_connections` (docs/03 §13.2). Chưa cần RDS Proxy.
- Tiền lưu `BIGINT` (đồng). Driver `pg` trả chuỗi nên domain dùng `bigint`/string, không dùng `number`.
- **Xem lại khi:** ghi vượt khả năng một instance, hoặc cần lưu trữ phân tích dài hạn (khi đó tách sang kho riêng, không đổi sổ cái).

## Cách kiểm chứng

- Test ràng buộc trên Postgres thật (DBS-20, DBS-21): DB từ chối số dư âm, hai dòng Nợ cùng giao dịch, `from = to`.
- AC-5.4, 5.6, 5.9 xanh dưới đồng thời thật (DBS-97…99).
- Đối soát 0 lệch sau mỗi load test (DBS-69, DBS-117).
- `EXPLAIN (ANALYZE, BUFFERS)` các truy vấn nóng đạt ngưỡng ở database-design §7 (DBS-171).
