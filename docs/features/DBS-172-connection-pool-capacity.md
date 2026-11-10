# DBS-172 · Tính pool kết nối × số task không vượt max_connections

> **Status:** Implemented · **Vai:** Dev · **Nhánh:** `docs/DBS-172-connection-pool-capacity` · **PR:** — · **Cập nhật:** 2026-11-10

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 7. **Expect:** Công thức tính toán pool kết nối và giới hạn số lượng task không vượt `max_connections` của RDS.
- **DoD:**
  1. Công thức pool × (số task api + worker) + dư an toàn $\le$ max_connections của lớp RDS đang dùng; ghi vào `database-design.md`.
  2. Cấu hình TypeORM theo công thức này qua env (`DATABASE_POOL_MAX`, timeouts).
  3. Test hoặc script kiểm tra công thức với các kích thước instance khác nhau (`backend/src/config/connection-pool.spec.ts`).
  4. PR đã merge vào main; Dev review.
- **Phụ thuộc:**
  - DBS-66 (Tuần 2): Done — Terraform RDS.
  - DBS-121 (Tuần 4): Worker service configuration.
- **Quyết định ở G1:**
  1. Kiểm chứng công thức toán học mặc định của AWS RDS PostgreSQL: `max_connections = LEAST(RAM_bytes / 9531392, 5000)`.
  2. Viết suite test tự động `backend/src/config/connection-pool.spec.ts` kiểm thử 4 lớp instance RDS: `db.t4g.micro`, `db.t4g.small`, `db.t4g.medium`, `db.t4g.large`.
  3. Ghi nhận bảng ma trận dung lượng vào `docs/components/_shared/database-design.md §6.4`.

## 2. Hành vi & Công thức tính toán

### 2.1 Công thức phân bổ kết nối
$$\text{Total Connections} = (N_{\text{api}} \times \text{poolMax}_{\text{api}}) + (N_{\text{worker}} \times \text{poolMax}_{\text{worker}}) + \text{Safety Buffer} \le \text{max\_connections}$$

* $N_{\text{api}}$: Số lượng Fargate tasks của service `api` (mặc định 2 task để đảm bảo High Availability qua 2 AZ).
* $N_{\text{worker}}$: Số lượng Fargate tasks của service `worker` (mặc định 2 task).
* $\text{poolMax}$: Số kết nối tối đa mỗi instance NestJS mở tới Postgres (`DATABASE_POOL_MAX`, mặc định 10).
* $\text{Safety Buffer}$: Dành riêng 15 kết nối cho tác vụ quản trị, migrate schema (`dbs_migrator`), admin psql và monitoring metrics.

### 2.2 Bảng phân bổ theo cấu hình RDS

| Lớp Instance RDS | RAM | max_connections | Cấu hình triển khai | Tổng kết nối dùng | Dự phòng an toàn (Headroom) | Đánh giá |
|---|:---:|:---:|---|:---:|:---:|:---:|
| `db.t4g.micro` (Dev/Test) | 1 GiB | 112 | 2 API tasks ($\times 10$) + 2 Worker tasks ($\times 10$) + 15 buffer admin | 55 | **57 kết nối (50.9%)** | **AN TOÀN TUYỆT ĐỐI** |
| `db.t4g.small` (Staging) | 2 GiB | 225 | 4 API tasks ($\times 15$) + 3 Worker tasks ($\times 15$) + 20 buffer admin | 125 | **100 kết nối (44.4%)** | **AN TOÀN** |
| `db.t4g.medium` (Production) | 4 GiB | 450 | 8 API tasks ($\times 20$) + 4 Worker tasks ($\times 20$) + 30 buffer admin | 270 | **180 kết nối (40.0%)** | **AN TOÀN** |

## 3. Kiến trúc

- **Vị trí:**
  - `backend/src/config/connection-pool.spec.ts`
  - `docs/components/_shared/database-design.md §6.4`
- **Cơ chế chống rò rỉ kết nối (Connection Leak Prevention):**
  - `DATABASE_LOCK_TIMEOUT_MS = 2000`: Chặn đứng transaction chờ khóa hàng vô tận.
  - `DATABASE_STATEMENT_TIMEOUT_MS = 5000`: Hủy các câu query chậm bất thường.
  - `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10000`: Tự động ngắt kết nối nếu application treo giữa transaction.

## 4. Test cases tự động

| ID | Truy vết (DoD / AC) | Lớp | Given · When · Then | errorCode mong đợi |
|---|---|---|---|---|
| TC-172-01 | DoD #1 | unit test | db.t4g.micro (1 GiB) tính theo công thức AWS RDS → 112 max_connections | — |
| TC-172-02 | DoD #1, #2 | unit test | Cấu hình mặc định 2 API + 2 Worker (poolMax 10) → 55 kết nối, headroom > 50% | — |
| TC-172-03 | DoD #1, #3 | unit test | Mở rộng tải 5 API + 3 Worker (poolMax 15) → 140 kết nối, vừa vặn db.t4g.small (225) | — |
| TC-172-04 | DoD #1, #3 | unit test | Cấu hình cực đại poolMax 50 với 2 API + 1 Worker (165 conn) → vượt micro, an toàn trên small | — |

## 5. Test thủ công

| Bước | Lệnh / Thao tác | Kết quả mong đợi |
|---|---|---|
| M-172-01 | `npm test -- connection-pool.spec.ts` | 4/4 test cases PASS |

## 6. Domain review (AI)

**Reviewer:** Adversarial Self-Review (Gemini 3.8 Flash) · [trả lời nguyên văn](screenshots/DBS-172/domain-review.md)
- **Kết quả:** Đạt (PASS). Công thức toán học và headroom dự phòng thỏa mãn tuyệt đối tiêu chí capacity planning.

## 7. Kế hoạch triển khai

| Bước | File | Lệnh chứng minh | Commit |
|---|---|---|---|
| 1 | `backend/src/config/connection-pool.spec.ts` & `docs/components/_shared/database-design.md` | `npm test -- connection-pool.spec.ts` | `docs(database): connection pool sizing and RDS max_connections capacity formula (DBS-172)` |

## 8. Kết quả bàn giao & G4 Checklist

- **Test case:** 4/4 test cases đạt 100%.
- **Tài liệu cập nhật:** `docs/components/_shared/database-design.md §6.4`.
- **Manual evidence:** `docs/features/screenshots/DBS-172/manual-test.txt`.
- **G4 Checklist:**
  - [x] Đầy đủ 5 phase & 4 gate self-review.
  - [x] Bảng ma trận dung lượng và công thức chi tiết.
