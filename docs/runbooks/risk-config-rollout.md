# Runbook · Bật phiên bản luật fraud mới (UC-12) sau khi thay hết worker cũ

> **Status:** Code và test tự động xong; **chưa chạy trên AWS** (BL-188) · **Owner:** Platform & Ops, #4 Fraud · **Cập nhật:** 2026-11-14

## Vì sao phải thay hết worker cũ trước

Phiên bản luật là một dòng bất biến trong `risk_rule_sets`. `POST /v1/admin/risk-config/versions` (UC-12, admin) ghi dòng mới; **không có bước "kích hoạt" nào khác**: worker chọn phiên bản có số lớn nhất khi đọc.

Cách worker nạp luật (`RuleSetRepository`, [bugfix freshness](../features/BUG-20261109-risk-config-freshness.md) §2): Redis chỉ giữ *số phiên bản hiện hành* ở key `cfg:risk:latest:v2` (TTL tối đa 60 s, ghi bằng Lua chỉ đi tiến); nội dung luật luôn đọc từ PostgreSQL và `parseRuleSet` kiểm lại. Hết 60 s hoặc mất key thì worker đọc DB. Vì vậy **worker mới** thấy phiên bản mới trong tối đa 60 s, kể cả khi Redis hỏng.

Một worker **cũ** còn chạy sau khi phiên bản mới được ghi gây hai loại hại:

| Worker cũ | Hậu quả khi phiên bản luật mới xuất hiện |
|---|---|
| Image trước bugfix freshness (key `cfg:risk:latest`, `SET` không điều kiện) | Không có bảo đảm 60 s: một truy vấn chậm có thể ghim phiên bản cũ lại; worker cũ và worker mới có thể chấm cùng một loại giao dịch bằng hai phiên bản khác nhau, `fraud_flags.rule_set_version` lẫn lộn |
| Image có `parseRuleSet` hẹp hơn API (thiếu một tham số/luật mới, kiểm giá trị khác) | Phiên bản mà API đã nhận bị worker cũ từ chối (`InvalidRuleSetError`): **mọi** event rollback, retry, vào DLQ (`risk-events-dlq`), alarm `dbs-dev-risk-rule-error` / DLQ kêu |

Cả hai đều biến mất khi mọi task `worker` chạy cùng image với API đã nhận phiên bản. Hai service (api, worker) dùng chung image `dbs-api:<SHA>` (ADR-13).

## Quy trình

1. **Deploy bản code mới trước.** Push `main` → `Image` → `Deploy` (`.github/scripts/deploy.sh`): migrate → api → health → worker, rồi `verify-worker-rollout.sh` tự chạy. Dòng cuối thành công phải là `Worker: chỉ còn <revision>; có thể bật phiên bản luật mới`. Nếu job đỏ ở bước này thì **chưa được** tạo phiên bản luật mới.
2. **Kiểm lại ngay trước khi POST** (bắt buộc khi deploy cách đó hơn vài phút, khi worker được dựng/scale tay, hoặc khi `deploy.sh` chạy với `DEPLOY_WORKER=0`):

   ```bash
   AWS_PROFILE=dbs-admin bash .github/scripts/verify-worker-rollout.sh
   # hoặc chốt revision mong đợi: EXPECT_TASK_DEFINITION=arn:aws:ecs:...:task-definition/dbs-worker:<n> bash ...
   ```

   Đạt khi in `OK: chỉ còn dbs-worker:<n>, k/k task RUNNING, không có deployment hay task cũ`. Script chờ tối đa `VERIFY_DEADLINE_SECONDS` (300 s) cho task cũ dừng hẳn (`stopTimeout` 60 s) và tự đỏ nếu: còn deployment `ACTIVE`/`INACTIVE`, `runningCount != desiredCount`, còn task chưa `STOPPED` ở revision khác (kể cả `STOPPING`), hoặc PRIMARY không phải revision mong đợi (circuit breaker đã rollback). Worker `desiredCount = 0` hoặc service không tồn tại: không có task nào chạy, script thoát 0 kèm cảnh báo.
3. **Tạo phiên bản luật** qua `POST /v1/admin/risk-config/versions` (token `admin`). API từ chối cấu hình hỏng ngay (400), nên không có phiên bản hỏng lọt vào DB.
4. **Theo dõi 5 phút sau khi ghi:** không có alarm `dbs-dev-risk-rule-error`, `dbs-dev-risk-config-invalid`, `dbs-dev-risk-config-freshness`; DLQ vẫn 0. Phiên bản mới có hiệu lực ở worker trong tối đa 60 s (`fraud_flags.rule_set_version` của giao dịch mới).

Không đổi thứ tự: **đừng** POST phiên bản mới giữa lúc `deploy.sh` còn chạy bước worker.

## Khi một phiên bản mới đã lọt vào trong lúc còn worker cũ

- Dấu hiệu: DLQ risk có message, alarm `risk-rule-error`, log `/dbs/dev/worker` có `Invalid risk rule set`.
- Phiên bản không sửa/xóa được (append-only). Xử lý: hoàn tất deploy worker (bước 1, 2) cho tới khi `verify-worker-rollout.sh` đạt, sau đó redrive DLQ theo [dlq-redrive.md](dlq-redrive.md). Hoặc ghi một phiên bản mới (số lớn hơn) quay về cấu hình cũ nếu không thể thay worker.

## Giả định về đồng hồ và Redis, và giám sát

Bound 60 giây giả định (bugfix §2): đồng hồ Redis (kể cả lúc failover) và đồng hồ local không lùi hoặc chạy sai tốc độ, primary dùng READ COMMITTED, UC-12 serialize version tăng và thứ tự commit (advisory lock, DBS-160).

| Giả định | Cách đang giữ / giám sát |
|---|---|
| Đồng hồ task Fargate và node ElastiCache | Cả hai đồng bộ qua Amazon Time Sync Service; **không có metric lệch giờ** và không dựng alarm giả. Đồng hồ chỉ bị bắt gián tiếp khi nó làm hỏng một lần chọn |
| Một lần chọn không chứng minh được độ tươi (SQL ≥ 60 s, đồng hồ lùi hay lệch) | Alarm `dbs-dev-risk-config-freshness` (`risk_config_freshness_exceeded_total` > 0, worker): `RuleSetRepository` bỏ lựa chọn, đọc lại một lần, rồi ném lỗi cho consumer |
| Redis sống | `dbs-dev-redis-node-missing` (heartbeat, bắt cả failover/thay node), `dbs-dev-redis-fallback`, `dbs-dev-risk-config-redis-fallback` (Redis lỗi hay trả giá trị hỏng nên đọc DB) |
| Redis chậm, thiếu bộ nhớ, bị evict | Không alarm riêng: key `latest:v2` mất thì worker đọc DB (đúng, chỉ chậm); lỗi/timeout đã vào hai alarm fallback. CPU/bộ nhớ Valkey xem trên dashboard `dbs-dev-infra` |

Alarm `risk-config-freshness` kêu: (1) kiểm RDS (kết nối, CPU, failover) và độ trễ truy vấn `risk_rule_sets`; (2) so timestamp trong log `/dbs/dev/worker` với giờ thật (Fargate không cho chạy `chronyc`); (3) nếu nghi đồng hồ Redis lùi, dừng cache (xóa key `cfg:risk:latest:v2`) hoặc thay node Valkey, như [bugfix §5](../features/BUG-20261109-risk-config-freshness.md) dặn.

## Kiểm trên AWS (chưa làm, BL-188)

Xem mục "Đóng khi" ở `docs/BACKLOG.md` (BL-188) và [DBS-38 §12](../features/DBS-38-auto-deploy-ecs.md): chạy `deploy.sh` thật với worker `desired 1`, chạy `verify-worker-rollout.sh` khi cố tình giữ một task cũ, và kích alarm freshness bằng số mô phỏng.
