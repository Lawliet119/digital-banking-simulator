# Demo 3 · Failure / recovery

> **Status:** Active (phần A–D đã chạy; kill API giữa lệnh chờ DBS-185) · **Owner:** Dev · **Cập nhật:** 2026-11-10

Demo bắt buộc "Failure / recovery" ([docs/03 §17](../03_HIGH_LEVEL_ARCHITECTURE.md#17-demo-bắt-buộc)): chứng minh khi một phần hệ thống chết, tiền vẫn đúng và sự kiện không mất. Mỗi phần dưới đây đã được chạy thật, kèm output thô trong feature doc của task tương ứng.

| Phần | Nội dung | Task | Trạng thái |
|---|---|---|---|
| A | Relay chết hoặc queue treo: outbox gửi bù, không mất sự kiện | [DBS-91](../features/DBS-91-relay-fault-tolerance.md) | đã chạy (M-91-01..04) |
| B | Worker chết rồi bật lại: mọi cờ cần có vẫn xuất hiện, không trùng | [DBS-124](../features/DBS-124-worker-down-recovery.md) | đã chạy (M-124-01..05) |
| C | Consumer lỗi 5 lần → DLQ, consumer khác không bị chặn; đọc và redrive DLQ | [DBS-125](../features/DBS-125-dlq-isolation-runbook.md) | đã chạy (M-125-01..04) |
| D | Redis chậm hoặc chết giữa luồng chuyển tiền: fail-open, bất biến đúng | [DBS-100](../features/DBS-100-redis-slow-transfer.md) | đã chạy (test services) |
| — | Kill API giữa lệnh (AC-5.10) | DBS-185 | chưa làm |

## Chuẩn bị chung

- **Hai process thật** cùng một bản build (từ `backend/`): `npm run build`, rồi `APP_ROLE=api node dist/main` và `APP_ROLE=worker node dist/main`.
- **PostgreSQL** và **Valkey** của `docker compose`. Dùng một database riêng cho buổi demo và chạy `npm run migration:run` trên nó.
- **ElasticMQ riêng** cho buổi demo, để không worker nào khác lấy mất message. Lệnh chạy từ thư mục gốc repo:

  ```bash
  docker run -d --name demo3-mq -p 9334:9324 \
    -v "$PWD/infra/local/elasticmq.conf:/opt/elasticmq.conf:ro"     softwaremill/elasticmq-native@sha256:e4580ab9ad1bd5cd37b4ba04911bc5ccc8cd2d9ab4de56ece65acee71c24e05c
  ```

  Image ghim digest (BL-225): đúng bản mà DBS-125 đã thử (redrive, `list-message-move-tasks` làm ElasticMQ sập). Không đổi về `:latest`; muốn nâng bản thì làm theo [runbook DLQ, mục "Nâng image ElasticMQ"](../runbooks/dlq-redrive.md#nâng-image-elasticmq) trước.

  Đặt cho cả hai process:
  - `SQS_ENDPOINT=http://localhost:9334`
  - `SQS_RISK_QUEUE_URL=http://localhost:9334/000000000000/risk-events`
  - `SQS_NOTIFICATION_QUEUE_URL=http://localhost:9334/000000000000/notification-events`
- **Process api:** đặt `RATE_LIMIT_TRANSFERS_PER_MINUTE` và `RATE_LIMIT_REQUESTS_PER_IP_PER_MINUTE` đủ lớn, vì demo tạo nhiều khách liên tiếp.
- **Kill cứng trong Git Bash** phải dùng PID Windows: `taskkill //F //T //PID $(cat /proc/<pid>/winpid)`. `kill` của Git Bash không với tới `node.exe`.
- **Đếm queue** (với `AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_DEFAULT_REGION=us-east-1`):

  ```bash
  aws --endpoint-url http://localhost:9334 sqs get-queue-attributes \
    --queue-url http://localhost:9334/000000000000/risk-events \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed
  ```

  Queue "cạn" khi cả ba thuộc tính bằng 0. Lệnh tương tự với `risk-events-dlq`.
- **Token** lấy bằng `npm run --silent auth:dev-token -- --role <role> --sub <sub>`, mỗi khách một `--sub`. Mỗi khách gọi `POST /v1/customers/me` rồi `POST /v1/accounts`.

## A. Relay chết, queue treo

Kịch bản và kết quả ở [DBS-91 §5 và §8](../features/DBS-91-relay-fault-tolerance.md):
- Không có worker: sự kiện nằm chờ trong outbox. Bật worker lên thì outbox được gửi bù hết.
- `docker pause` queue: relay báo lỗi gửi, API vẫn trả 201. `unpause` thì gửi bù.
- Kill cứng worker khi đang gửi: cuối cùng không còn dòng nào chưa gửi. Mỗi `eventId` có mặt ít nhất một lần trên queue; bản trùng do consumer chặn lại.

## B. Worker chết, cờ vẫn xuất hiện (DBS-124)

**Dữ liệu cho mỗi lệnh:** một tài khoản nguồn mới chỉ chuyển đúng một lần, tới một người nhận mới. Người nhận không chuyển ngược lại.
- **Đạt ngưỡng** (AC-9.1): nạp 21.000.000đ, chuyển 20.000.000đ. R3 + R6 = 65 điểm, mức MEDIUM.
- **LOW:** nạp 5.000.000đ, chuyển 1.000.000đ. 0 điểm.

| Bước | Làm | Kết quả mong đợi |
|---|---|---|
| B1 | Hai process chạy; một lệnh đạt ngưỡng | Vài trăm ms sau có cờ 65 MEDIUM |
| B2 | Nạp tiền cho 6 nguồn, đợi worker xử lý xong lệnh nạp; kill worker; 3 lệnh đạt ngưỡng + 3 lệnh LOW | 6 lệnh 201 (chuyển tiền không phụ thuộc worker); outbox có đúng 6 sự kiện chưa gửi; 0 decision mới |
| B3 | Bật lại worker | ≤ 60 s: 6 decision, 3 cờ 65 MEDIUM, mỗi cờ đúng 1 audit `fraud.flagged` và 2 hit (R3, R6); outbox 0; `risk-events` cạn; DLQ 0 |
| B4 | Kill worker giữa chừng: gửi 10 lệnh đạt ngưỡng cách nhau 1 s, kill khi đã có 1..9 decision; bật lại | ≤ 60 s: đủ 10 decision, 10 cờ, mỗi cờ đúng 1 audit; queue cạn; DLQ 0 |
| B5 | `npm run --silent check:invariants` | PASS: worker không chạm tiền |

**Vì sao có khi phải chờ ~30 giây.** Worker bị kill trong lúc đang long poll (tối đa 20 s) vẫn để lại kết nối đó trên ElasticMQ.
- Message đầu tiên đến sau khi bật lại worker có thể bị giao cho kết nối đã chết.
- Message đó ẩn hết visibility timeout 30 s rồi được giao lại cho worker mới.
- Đây là hành vi at-least-once đúng thiết kế (ADR-03): message trễ chứ không mất.

Lần chạy thật: [DBS-124 manual-test.txt](../features/screenshots/DBS-124/manual-test.txt), có dòng thời gian từ log worker. Dừng worker bằng SIGTERM (ECS) thì không có độ trễ này, vì vòng lặp kết thúc long poll trước khi thoát.

## C. Consumer lỗi → DLQ (DBS-125)

Đọc và redrive theo [runbook DLQ](../runbooks/dlq-redrive.md).

**Ép notification lỗi mà không đổi code:** `ALTER TABLE notification_log ADD CONSTRAINT demo3_block CHECK (false) NOT VALID`. Mọi INSERT mới vi phạm CHECK nên bị rollback; gỡ bằng `DROP CONSTRAINT`.

| Bước | Làm | Kết quả mong đợi |
|---|---|---|
| C1 | Nạp tiền cho một nguồn mới, đợi hai queue cạn; thêm constraint; chuyển theo AC-9.1 (21M, chuyển 20M) | Cờ 65 MEDIUM có ngay (risk không bị chặn). ≈ 150–155 s sau (backoff 10+20+40+80 s, BL-210), `notification-events-dlq` có 1 message mang `eventId` của lệnh; `notification_log` của `eventId` = 0 |
| C2 | Gửi `{not json` vào `risk-events` | `risk-events-dlq` có 1 message ngay |
| C3 | Gỡ constraint; làm theo runbook: quét DLQ, xóa message hỏng, trả message hợp lệ về, rồi `start-message-move-task` với đích ghi rõ | DLQ về 0; `notification_log` của `eventId` có đúng 2 dòng; queue chính cạn |
| C4 | `npm run --silent check:invariants` | PASS |

## D. Redis chậm hoặc chết (DBS-100)

[DBS-100](../features/DBS-100-redis-slow-transfer.md):
- Redis trễ 75 ms (vượt timeout 50 ms): chuyển tiền vẫn COMPLETED, rate limit fail-open, p95 so với baseline cùng lần chạy.
- Redis chết: chuyển tiền vẫn chạy, `/health/ready` báo `redis: degraded`, bất biến PASS.
- Phần "tắt Redis giữa load test" thuộc load test của #5.
