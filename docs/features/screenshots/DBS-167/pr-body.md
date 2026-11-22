## DBS-167: tải có/không Redis và Redis chậm giữa tải (120 RPS, AWS)

Đo cùng kịch bản 120 RPS khi Redis bật (đối chứng), chậm giữa tải (hai lượt) và tắt giữa tải, trên stack `session` thật (image CI `76b80bdb`, RDS Multi-AZ, Valkey 1 replica, 2 api, 1 worker). Báo cáo: `docs/components/load-tests/05-ket-qua-redis-2026-11-22.md`. Feature doc: `docs/features/DBS-167-redis-fault-load.md`.

**Kết luận ngắn:** Redis tắt không làm hỏng giao dịch (0 lỗi, `/health/ready` luôn 200, breaker mở trong 10 giây). **Redis chậm vừa phải là ca xấu**: breaker không mở, đọc p95 138 và 149 ms (`history` 154 ms vượt SLO 150 ms ở lượt 2), chuyển tiền p95 289 ms (SLO 300). Hồi phục sau khi mạng thông: 42,5 giây. Ba trong bốn lượt có một lần đứng hình 1 đến 3 giây **trước** sự cố, không do Redis và không do event loop (BL-419). Bất biến DBS-69 PASS sau cả bốn lượt.

### Thay đổi
- Kịch bản k6 `redis-fault` (một plateau 120 RPS, 900 s); `window-stats.cjs` (p95/p99/lỗi theo cửa sổ trước, sự cố, hồi phục, sau, phán quyết theo tiêu chí chốt trước); `redis-fault.cjs` (xung `CLIENT PAUSE`, `FLUSHALL`, `probe`, có chặn cứng `P ≤ 500 ms`); `redis-fault.sh` (tắt bằng NACL deny 6379, chậm, flush, `wait-healthy`, `schedule`, khôi phục ba lớp); `loadgen-run.sh` chép mốc sự cố.
- Hạ tầng chỉ ở stack `envs/dev/loadgen`, sau biến `redis_fault_enabled` (**mặc định `false`**): egress và một luật ingress 6379 (như `db_from_loadgen`), NACL riêng gắn hai private subnet, quyền IAM giới hạn theo ARN. Không đổi `base` hay `session`; hủy stack gỡ sạch.
- `pgss.sh`: sửa đường dẫn Windows (`pwd -W`), lần chạy thật đầu tiên của BL-420.
- Kết quả thô `docs/components/load-tests/results/redis-*` (không có `run.log`: có tên miền ALB), `redis-evidence/` (log, alarm, pgss, CloudWatch).
- BACKLOG: đóng BL-420; cập nhật BL-216 (còn failover), BL-221, BL-419; thêm BL-424 (hồi phục sau mạng thông), BL-425 (không có metric breaker).

### Đối chiếu test case
| ID | Test | Kết quả |
|---|---|---|
| TC-167-01 | `config.test.mjs` | đạt |
| TC-167-02..04 | `window-stats.test.mjs` (11 test, mutation làm đỏ 2) | đạt |
| TC-167-05 | `redis-fault.test.mjs` (7) | đạt |
| TC-167-06 | `redis-fault-sh.test.mjs` (7, bash + `aws` giả) | đạt |
| TC-167-07, 08 | `loadgen.tftest.hcl` (7 test tổng) | đạt |
| TC-167-09 | thủ công trên AWS, `screenshots/DBS-167/manual-test.txt` | đạt phần đã chạy |

Lệnh: `node --test load-tests/test/*.test.mjs` 125 đạt, 0 skipped; `terraform test` ở `loadgen` 7 đạt; `check-doc-links.mjs` 0 lỗi; `check-backlog.mjs` 0 lỗi.

### Quyết định tự chốt, bước chưa chạy, lệch kế hoạch
- Cách tiêm sự cố do subagent opus (effort high) chốt; domain review opus high một lượt (12 phát hiện, 1 blocking đã sửa), không có lượt hai (ghi §6).
- Lệch: code bước 1 đến 5 viết trước khi review G2 trả về (không lên GitHub, không chạy AWS trước G3); `flush` thử sau `prepare`; thêm lượt chậm thứ hai theo điều khoản G1.9; hai lỗi chỉ thấy khi chạy thật và đã sửa kèm test (`REDIS_HOST` không export cho công cụ Node; `enableOfflineQueue`).
- **Không có ảnh console AWS** (không có màn hình trong phiên tự động). Dev review **chưa đạt về hình thức**.
- Hạ tầng đã hủy: `verify-clean.sh` exit 0, chỉ còn `dbs-app` (giống hệt trước), plan `base` giống hệt trước.

`Techlead waiver:` không qua human gate và Dev review (G1..G4 do opus và agent tự duyệt đêm nay), không merge PR qua người duyệt, không sửa board (mục 1 của `TonightWorks.md`).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
