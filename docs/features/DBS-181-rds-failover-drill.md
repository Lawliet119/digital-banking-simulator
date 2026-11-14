# DBS-181 · Diễn tập RDS Multi-AZ failover và đo RTO

> **Status:** Done (live AWS drill completed; chờ PR) · **Vai:** #5 Platform & Ops · **Nhánh:** `docs/DBS-181-rds-failover-drill` · **Cập nhật:** 2026-11-14

## 1. Bối cảnh & Mục tiêu

- **Task trên board:** DBS-181 (Tuần 8, Deliverable P4) — diễn tập `aws rds reboot-db-instance --force-failover` dưới tải nhẹ, đo thời gian gián đoạn (RTO) và kiểm chứng ứng dụng tự phục hồi không cần restart tay.
- **Phụ thuộc:** DBS-180 (bật `db_multi_az = true` trên `dev/session`).

## 2. Kịch bản kiểm chứng

1. Xác nhận RDS `dbs-dev` ở trạng thái `MultiAZ = true`, `Status = available`.
2. Chạy vòng lặp gửi `GET /health/ready` mỗi `0,5 s` (~2 RPS, giữ dưới ngưỡng rate limit WAF `1000 req / 300 s`, `/health/ready` truy vấn trực tiếp PostgreSQL và Valkey).
3. Gọi `aws rds reboot-db-instance --db-instance-identifier dbs-dev --force-failover`, lặp **2 lần liên tiếp**.
4. Ghi lại tổng số request, số phản hồi `200`, số lỗi `503` (và header `Retry-After`), khoảng thời gian gián đoạn từ `503` đầu tới `503` cuối, và xác nhận app tự hồi về `200` không cần restart ECS task.

## 3. Kết quả đo thực tế (2026-11-14)

| Lần | Thời điểm kích hoạt (UTC) | Tổng req | `200 OK` | `503` | `Retry-After` (`/health/ready`) | Thời gian gián đoạn (RTO) | Tự phục hồi? |
|---|---|---|---|---|---|---|---|
| **Lần 1** | `2026-11-14T09:32:20Z` | 522 | 508 | 14 | 0 | **14,7 s** | Có (không restart ECS) |
| **Lần 2** | `2026-11-14T09:38:19Z` | 528 | 514 | 14 | 0 | **12,7 s** | Có (không restart ECS) |

- **Nhận xét kỹ thuật:**
  - Thời gian gián đoạn thực tế trên PostgreSQL `db.t4g.micro` Multi-AZ chỉ từ **12,7 s – 14,7 s** (thấp hơn nhiều mức 60–120 s điển hình của DNS failover nhờ pool kết nối của TypeORM/pg reconnect tự động ngay khi DNS chuyển sang standby).
  - `/health/ready` dùng NestJS Terminus trả `503` chuẩn (không gắn `Retry-After` — header `Retry-After` được filter lỗi DB tạm thời gắn trên các endpoint nghiệp vụ như `/v1/transfers`). Kiểm chứng dưới tải k6 ~12 RPS trên endpoint nghiệp vụ vẫn chờ script k6 (`DBS-165` của Dev).

## 4. Bằng chứng & Tài liệu liên quan

- Bằng chứng đã redact: [manual-test.txt](screenshots/DBS-181/manual-test.txt)
- Bảng sự cố P4: [P4-incident-table.md](../deliverables/P4-incident-table.md)
