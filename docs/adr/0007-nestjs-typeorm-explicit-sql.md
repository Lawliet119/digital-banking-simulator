# ADR-07: NestJS + TypeScript; TypeORM cho CRUD và migration, SQL tường minh cho luồng tiền

| | |
|---|---|
| Trạng thái | **Accepted** |
| Ngày | 2026-10-11 |
| Người viết | #1 (Ledger) |
| Người duyệt | #4 (cặp đôi); cả nhóm |
| Liên quan | Driver D-1, D-8 · [`docs/03` §19](../03_HIGH_LEVEL_ARCHITECTURE.md) · [ADR-04](0004-row-locking-read-committed.md), [ADR-05](0005-idempotency-in-postgres.md) · [`backend/README.md`](../../backend/README.md) |

## Bối cảnh

Hai câu hỏi:

1. **Ngôn ngữ và framework** cho một ứng dụng có module rõ ràng, DI, validation, OpenAPI tự sinh, chạy được cả HTTP lẫn consumer nền (ADR-13).
2. **Tầng truy cập dữ liệu.** Luồng tiền cần những câu lệnh mà ORM thường che hoặc làm khó: `INSERT … ON CONFLICT DO NOTHING`, `SELECT … FOR UPDATE … ORDER BY id`, `SUM` có điều kiện thời gian theo múi giờ, và nhiều câu lệnh trong **một** transaction do code điều khiển. Phần còn lại (hồ sơ, tài khoản, cờ, nhật ký) là CRUD bình thường.

Khung `backend/` đã chạy NestJS 11, TypeORM 0.3 và `pg`, có 120 unit test và 20 e2e test xanh (kiểm ngày 06/10).

## Các phương án

**Framework**

| Tiêu chí | **A. NestJS (TypeScript)** | B. Spring Boot (Java/Kotlin) | C. FastAPI (Python) |
|---|---|---|---|
| Module, DI, guard, pipe có sẵn | **Có** | Có | Một phần |
| Một ngôn ngữ cho API, worker, script đánh giá, k6 (JS) | **Có** | Không | Không (k6 vẫn là JS) |
| OpenAPI tự sinh | **`@nestjs/swagger`** | springdoc | Có sẵn |
| Kinh nghiệm của nhóm | **Đông nhất** | Ít | Một phần |
| Thời gian khởi động container | **Nhanh** | Chậm hơn | Nhanh |

**Truy cập dữ liệu**

| Tiêu chí | **A. TypeORM + SQL tường minh trong `QueryRunner`** | B. Kysely (query builder có kiểu) | C. Prisma |
|---|---|---|---|
| `FOR UPDATE`, `ON CONFLICT`, transaction do code điều khiển | **SQL tay trong `QueryRunner`** | Tốt | Hạn chế (interactive transaction có giới hạn, `FOR UPDATE` qua raw SQL) |
| Migration | **Có sẵn, đã cấu hình** | Có, tự viết | Có, theo schema riêng |
| Tích hợp NestJS | **`@nestjs/typeorm` đã có trong khung** | Tự viết module | Có |
| Kiểu an toàn của câu truy vấn | Yếu ở phần SQL tay | **Mạnh** | Mạnh |
| Thời gian chuyển đổi | **0** | Viết lại `database/` | Viết lại `database/` và schema |

## Quyết định

- **NestJS 11 trên Node.js 24, TypeScript strict.**
- **TypeORM** cho entity, CRUD và migration. **Luồng tiền** (chuyển tiền, nạp tiền, sync guard, idempotency, đối soát) viết **SQL tường minh** trong `QueryRunner` của `TransactionService`, có tham số hóa (`$1, $2…`), không nối chuỗi.
- `SnakeNamingStrategy` để entity và SQL tay dùng cùng tên cột.
- Không dùng `synchronize`; không chạy migration lúc app khởi động.

## Lý do

- Khung đã chạy và có test. Đổi sang Kysely chỉ để có kiểu cho vài câu SQL không đáng một tuần chuyển đổi đúng lúc đường găng (tuần 1–3).
- Phần quyết định đúng sai của tiền nằm ở **thứ tự câu lệnh và khóa**, không nằm ở cú pháp. Viết SQL tay làm thứ tự đó hiện rõ khi review, đúng như sơ đồ docs/03 §6.1.
- Một ngôn ngữ cho API, worker, script đánh giá fraud và k6 giúp 6 người đọc được code của nhau và cặp đôi review chéo.

## Đánh đổi và hệ quả

- SQL tay không được kiểm kiểu lúc biên dịch. Bù lại bằng test trên PostgreSQL thật (Testcontainers) cho mọi câu SQL tay; không mock DB ở luồng tiền.
- `pg` trả `BIGINT` dạng chuỗi. Tiền đi qua `@common/money` (DBS-22); cấm `parseInt` và `Number` trên tiền.
- TypeORM 0.3 có vài điểm khó chịu (relation lazy, `save` tự sinh câu lệnh). Quy ước: luồng tiền không dùng `save`; CRUD thì được.
- **Xem lại khi:** số câu SQL tay vượt khoảng vài chục và lỗi kiểu bắt đầu lọt qua test. Lúc đó chuyển dần từng module sang Kysely, bắt đầu từ `ledger`.

## Cách kiểm chứng

- AC-5.x xanh trên Postgres thật, với SQL tay trong `QueryRunner` (DBS-60, 61, 79, 80, 82, 84).
- Review: mọi câu SQL tay đều tham số hóa (checklist PR, mục bảo mật).
- `migration:run → migration:revert → migration:run` xanh trong CI (DBS-41).
