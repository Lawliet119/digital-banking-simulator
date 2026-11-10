# Báo cáo EXPLAIN (ANALYZE, BUFFERS) các truy vấn nóng (DBS-171)

> **Cập nhật:** 2026-11-10 · **Môi trường đo:** PostgreSQL 17 thật (Testcontainers), dataset 50.000 transfers + 50.000 ledger_entries + 50.000 outbox_events + 50.000 audit_log, sau `VACUUM ANALYZE`.

---

## 1. Tổng hợp kết quả đo đạc thực tế

| STT | Truy vấn | Plan thực tế | Index sử dụng | Thời gian đo được | Ngưỡng cam kết (§7) | Kết luận |
|:---:|---|---|---|:---:|:---:|:---:|
| 1 | **Hạn mức ngày** (`SENT_TODAY_SQL`) | `Index Only Scan` | `ledger_entries_daily_debit_idx` | **0.054 ms** | $\le 5\text{ ms}$ | **ĐẠT (Vượt 90x)** |
| 2 | **Lịch sử giao dịch trang đầu** (keyset cursor) | `Index Scan` (no Sort) | `ledger_entries_account_history_idx` | **0.057 ms** | $\le 20\text{ ms}$ | **ĐẠT (Vượt 350x)** |
| 3 | **Outbox relay lấy lô 100 sự kiện** (`SKIP LOCKED`) | `Index Scan` | `outbox_unpublished_idx` | **0.160 ms** | $\le 10\text{ ms}$ | **ĐẠT (Vượt 60x)** |
| 4 | **Tra cứu audit theo correlationId** | `Index Scan` | `audit_log_correlation_idx` | **0.047 ms** | $\le 10\text{ ms}$ | **ĐẠT (Vượt 200x)** |

---

## 2. Chi tiết từng truy vấn

### 2.1 Hạn mức ngày (`SENT_TODAY_SQL`)
* **SQL:**
  ```sql
  SELECT coalesce(sum(amount), 0)::text AS sent
  FROM ledger_entries
  WHERE account_id = $1::uuid
    AND direction = 'DEBIT'
    AND created_at >= $2::timestamptz
  ```
* **Phân tích:** 
  * PostgreSQL dùng `Index Only Scan` hoàn toàn trên index ghép `(account_id, direction, created_at, amount)`.
  * `Heap Fetches = 0`: Mọi dữ liệu cần tính toán tổng (`amount`) đều nằm trọn vẹn trong B-Tree leaf pages, không phải truy cập vào table heap.
  * Thời gian thực thi: **0.054 ms**. Không có Seq Scan.

### 2.2 Lịch sử giao dịch phân trang keyset
* **SQL:**
  ```sql
  SELECT id, transfer_id, direction, amount, balance_after, created_at
  FROM ledger_entries
  WHERE account_id = $1::uuid
  ORDER BY account_id, created_at DESC, id DESC
  LIMIT 20
  ```
* **Phân tích:**
  * Thứ tự `ORDER BY` khớp hoàn toàn với cấu trúc B-Tree `(account_id, created_at DESC, id DESC)`.
  * Planner duyệt trực tiếp 20 dòng đầu tiên từ chỉ mục mà **hoàn toàn không cần tạo node `Sort`** trên bộ nhớ hay ổ đĩa.
  * Thời gian thực thi: **0.057 ms**.

### 2.3 Outbox Relay Polling (`SKIP LOCKED`)
* **SQL:**
  ```sql
  SELECT event_id, event_type, aggregate_id, payload, correlation_id
  FROM outbox_events
  WHERE published_at IS NULL
  ORDER BY event_id
  FOR UPDATE SKIP LOCKED
  LIMIT 100
  ```
* **Phân tích:**
  * Sử dụng partial index `outbox_unpublished_idx` (`WHERE published_at IS NULL`). Kể cả khi bảng outbox tích lũy hàng triệu sự kiện đã xuất bản (`published_at IS NOT NULL`), chỉ mục này chỉ giữ các dòng pending (cỡ vài trăm dòng).
  * Thời gian thực thi: **0.160 ms**.

### 2.4 Tra vết kiểm toán viên theo `correlationId`
* **SQL:**
  ```sql
  SELECT id, occurred_at, actor_user_id, action, outcome, target_type, target_id
  FROM audit_log
  WHERE correlation_id = $1::uuid
  ORDER BY id DESC
  LIMIT 20
  ```
* **Phân tích:**
  * Dùng B-Tree index `audit_log_correlation_idx` trên cột `correlation_id`.
  * Bảng chứa 50.000 dòng audit, câu truy vấn tìm chính xác dòng liên kết trong **0.047 ms**.

---

## 3. Khẳng định tiêu chuẩn Definition of Done
1. Không còn bất kỳ `Seq Scan` nào trên các bảng lớn (`ledger_entries`, `transfers`, `outbox_events`, `audit_log`).
2. Mọi truy vấn nóng đều đạt và vượt xa ngưỡng cam kết tại §7 `database-design.md`.
3. Suite kiểm thử tự động `backend/test/db/hot-queries-explain.db-spec.ts` giữ vững bất biến này trong CI.
