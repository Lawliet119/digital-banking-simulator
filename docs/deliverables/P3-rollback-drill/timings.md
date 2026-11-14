# DBS-156 · Rollback Drill Timings (`dev/session`, `ap-southeast-1`)

- **Ngày thực hiện:** 2026-11-14 (UTC `08:37:02Z` – `08:43:00Z`)
- **Môi trường:** Cluster `dbs-dev`, services `api` (`dbs-api:7` → `dbs-api:8` → `dbs-api:7`), `worker` (`dbs-worker:4` → `dbs-worker:5` → `dbs-worker:4`)
- **Ngưỡng mục tiêu:** Toàn bộ rollback (Phase C) ≤ 600 s (10 phút).

| Mốc | Thời gian (UTC) | Độ trễ từ `T0` | Trạng thái |
|---|---|---|---|
| Phase A (Baseline) | `08:37:02Z` | — | `api` 1/1 (`dbs-api:7`), `worker` 1/1 (`dbs-worker:4`), `/health/live` 200, `/health/ready` 200 |
| Phase B (Deploy lỗi `DB_HOST=broken-db-host.invalid`) | `08:37:07Z` | — | `dbs-api:8` & `dbs-worker:5` đăng ký và deploy; `+30s` `/health/ready` → `503` |
| `T0` (Bắt đầu Rollback) | `08:37:59Z` | `0 s` | `ecs update-service` về `dbs-api:7` và `dbs-worker:4` |
| `/health/ready` hồi phục `200` | `08:39:17Z` | `+78 s` | API mới pass ALB health check và phục vụ `200` |
| `api` ECS rollout `COMPLETED` | `08:39:47Z` | `+108 s` | `api` 1/1 `COMPLETED` |
| `worker` ECS rollout `COMPLETED` | `08:42:58Z` | `+299 s` | `worker` 1/1 `COMPLETED` |
| `T1` (Kết thúc Rollback Drill) | `08:43:00Z` | **`301 s`** (~5m 01s) | Đạt ngưỡng ≤ 600 s (`301 s < 600 s`); `dbs-api:8` và `dbs-worker:5` đã deregister (`INACTIVE`) |
