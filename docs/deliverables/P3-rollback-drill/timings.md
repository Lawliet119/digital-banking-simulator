# DBS-156 · Rollback Drill Timings (`dev/session`, `ap-southeast-1`)

## Lần 1 (2026-11-14, lịch sử: không có giao dịch mẫu, không kiểm bản lỗi hỏng thật)

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

## Lần 2 (2026-11-15, lịch sử: rollback trước khi bản lỗi hỏng thật)

- **Image:** `c96c1de`. Bản tốt `dbs-api:16`, `dbs-worker:12`; bản lỗi `dbs-api:17`, `dbs-worker:13` (chỉ khác `DB_HOST=broken-db-host.invalid`).
- **Lỗi của kịch bản:** rollback bắt đầu ở +47 s sau deploy lỗi, khi `/health/ready` ra 503 lần đầu nhưng chưa task lỗi nào dừng: 503 đó do api chạy 1 task với min healthy 0%, nên lần này không chứng minh bản lỗi hỏng (domain review DBS-156 #1).
- **Số đo:** `/health/ready` 200 sau 86 s, api `COMPLETED` sau 118 s, worker sau 305 s, **tổng 305 s**. Giao dịch mẫu trước và sau rollback đạt. Bản ghi terminal thô (`run-2/drill.typescript`, `run-2/drill.timing`) không còn trong cây làm việc; lấy lại từ lịch sử git tại commit `dd93d1b` (đường dẫn cũ `docs/deliverables/P3-rollback-drill/run-2/`).

## Lần 3 (2026-11-15, bằng chứng chính)

- **Image:** `c96c1de`; `drill.sh` commit `f2d6a45`. Bản tốt `dbs-api:16`, `dbs-worker:12`; bản lỗi `dbs-api:18`, `dbs-worker:14`.

| Mốc | Thời gian (UTC) | Từ `T0` | Trạng thái |
|---|---|---|---|
| Phase A | `12:24:11Z` | — | nạp 5.000.000 và chuyển 1.000.000 → `201` `COMPLETED`; số dư customer1 57.500.000, customer2 14.000.000 |
| Phase B | deploy lỗi `12:24:25Z` | −201 s | +39 s `/health/ready` 503; +197 s mỗi service `failedTasks` = 1 (`Essential container in task exited 1`), PRIMARY vẫn là bản lỗi |
| `T0` | `12:27:46Z` | 0 s | `update-service` api và worker về `dbs-api:16`, `dbs-worker:12` |
| `/health/ready` 200 | | +127 s | |
| api `COMPLETED` | | +184 s | api 1/1 |
| worker `COMPLETED` | `12:32:14Z` | +267 s | worker 1/1 |
| `T1` | `12:32:14Z` | **267 s** | đạt ≤ 600 s |
| Sau rollback | đến `12:33:27Z` | | số dư nguyên; replay cùng khóa → cùng `transferId`, không chuyển lần hai; nạp và chuyển mới `201` `COMPLETED`; revision lỗi hủy đăng ký, AWS từ chối `update-service` về chúng; `invariants.js` thoát 0 |

- **Mất phục vụ** (`/health/ready` khác 200): khoảng 290 s, từ 40 s sau deploy lỗi tới 127 s sau `T0`, dài vì kịch bản chờ task lỗi dừng thật.
- Bản ghi terminal thô (`run-3/drill.typescript`, `run-3/drill.timing`) không còn trong cây làm việc; lấy lại từ lịch sử git tại commit `dd93d1b` (đường dẫn cũ `docs/deliverables/P3-rollback-drill/run-3/`), ví dụ `git show dd93d1b:docs/deliverables/P3-rollback-drill/run-3/drill.typescript`. `scriptreplay` cần cả hai file `drill.typescript` và `drill.timing`.
