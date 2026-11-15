# Demo 3 · Failure / recovery

> **Status:** Active (phần A–D và E đã chạy; E trên cloud ngày 2026-11-15, chưa quay video: BL-380) · **Owner:** Dev · **Cập nhật:** 2026-11-15

Demo bắt buộc "Failure / recovery" ([docs/03 §17](../03_HIGH_LEVEL_ARCHITECTURE.md#17-demo-bắt-buộc)): chứng minh khi một phần hệ thống chết, tiền vẫn đúng và sự kiện không mất. Mỗi phần dưới đây đã được chạy thật, kèm output thô trong feature doc của task tương ứng.

| Phần | Nội dung | Task | Trạng thái |
|---|---|---|---|
| A | Relay chết hoặc queue treo: outbox gửi bù, không mất sự kiện | [DBS-91](../features/DBS-91-relay-fault-tolerance.md) | đã chạy (M-91-01..04) |
| B | Worker chết rồi bật lại: mọi cờ cần có vẫn xuất hiện, không trùng | [DBS-124](../features/DBS-124-worker-down-recovery.md) | đã chạy (M-124-01..05) |
| C | Consumer lỗi 5 lần → DLQ, consumer khác không bị chặn; đọc và redrive DLQ | [DBS-125](../features/DBS-125-dlq-isolation-runbook.md) | đã chạy (M-125-01..04) |
| D | Redis chậm hoặc chết giữa luồng chuyển tiền: fail-open, bất biến đúng | [DBS-100](../features/DBS-100-redis-slow-transfer.md) | đã chạy (test services) |
| E | Dừng task api giữa lệnh chuyển tiền, gửi lại cùng `Idempotency-Key`: đúng một giao dịch (AC-5.10) | [DBS-185](../features/DBS-185-ac-5-10-kill-task-cloud.md) | đã chạy trên cloud (2026-11-15); video chưa (BL-380) |

Bản chạy lặp lại được của A–C (lệnh local bằng test dịch vụ, lệnh cloud **đã chạy trên AWS ngày 2026-11-15 ([DBS-184](../features/DBS-184-cloud-incident-scenarios.md))** kèm số đo, cách xác nhận; bảng tổng hợp: [P4](../deliverables/P4-incident-table.md)): [kịch bản sự cố bất đồng bộ](../runbooks/async-incident-scenarios.md) ([DBS-183](../features/DBS-183-async-incident-scenarios.md)).

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

## E. Dừng task api giữa lệnh chuyển tiền (AC-5.10, DBS-185)

Chứng minh trên cloud: lệnh chuyển tiền mã `K` đang nằm giữa transaction (đã ghi `idempotency_keys` và `transfers`, chưa commit) thì ECS dừng task api; khách gửi lại đúng `K` thì ra **một** giao dịch, hai bút toán, đối soát 0 lệch. Thiết kế, điều kiện «lần chạy hợp lệ», test case và các lệch: [DBS-185](../features/DBS-185-ac-5-10-kill-task-cloud.md).

**Cơ chế (không sửa code sản phẩm).** Mọi transaction chỉ sống vài giây, nên task `dbs-migrate` (role `dbs_migrator`, chủ bảng) bật một trigger tạm `dbs185_slow` trên `ledger_entries` chỉ gọi `pg_sleep(115)`: lệnh chuyển tiền chạy tới `INSERT ledger_entries` rồi ngủ, trong khi `watch` đọc `pg_locks` mỗi 2 s. `stop-task` 5 s sau khi gửi `K`. Cách giữ khóa dòng tài khoản **không dùng được** (đã thử, lần chạy cloud 1 không hợp lệ): ECS SIGTERM sau ≈ 70 s nhưng `lock_timeout` tối đa 30 s.

**Cấu hình tạm của phiên (mất khi `destroy`).** `ac-5-10-kill.sh prepare` đăng ký một revision `dbs-api` (copy bản đang chạy, `DATABASE_STATEMENT_TIMEOUT_MS=120000`, `stopTimeout=2`) và đặt `deregistration_delay` của target group về 0. `cleanup` trả lại. **Trigger làm mọi lệnh ghi sổ cái của môi trường ngủ 115 s khi đang bật**: chỉ chạy khi không ai khác dùng phiên.

**Chuẩn bị.** Phiên cloud đã dựng (api 1, worker 1, `seed-cloud.sh`; xem [demo giữa kỳ, nhánh cloud](demo-midterm-end-to-end.md#nhánh-cloud)), container Linux `dbs-awscli`, token `customer1` và auditor (không in ra màn hình), `FROM_ACCOUNT` là CHECKING của `customer1`, `TO_ACCOUNT` là CHECKING của `customer3`.

```bash
# từ gốc repo, trong container dbs-awscli; API=https://<alb>; CUST_TOKEN, AUD_TOKEN, FROM_ACCOUNT, TO_ACCOUNT đã export
bash infra/scripts/ac-5-10-kill.sh prepare    # ≈ 3 phút: revision tạm, deregistration_delay 0
bash infra/scripts/ac-5-10-kill.sh baseline   # ≈ 2 phút: probe T0 và invariants.js
bash infra/scripts/ac-5-10-kill.sh kill       # ≈ 5 phút: trigger, watch, gửi K, stop-task, gỡ trigger, đánh giá
bash infra/scripts/ac-5-10-kill.sh recover    # ≈ 1 phút: probe, gửi lại K hai lần, probe
bash infra/scripts/ac-5-10-kill.sh verify     # ≈ 6 phút: chờ đối soát, invariants.js, audit, log
bash infra/scripts/ac-5-10-kill.sh cleanup
```

Pha `kill` in `LẦN CHẠY HỢP LỆ` hoặc `KHÔNG HỢP LỆ` kèm lý do (kiểm bằng `ac-5-10-tools.py evaluate`); không hợp lệ thì chạy lại pha `kill` (tối đa ba lần).

| Bước | Kết quả mong đợi |
|---|---|
| `kill` | client lần đầu nhận lỗi do ALB (502, không có `X-Correlation-Id`); `watch` thấy một backend giữ khóa `idempotency_keys`, `transfers`, `ledger_entries` cho tới khi `pg_sleep` hết; task api dừng khi backend còn ngủ; `slow-off` gỡ trigger |
| `recover` | sau kill: không có dòng `idempotency_keys` của `K`, số giao dịch, dòng sổ và số dư bằng trước khi kill; gửi lại `K`: 201 và `transferId`, gửi lần nữa: 201 cùng `transferId`; sau đó +1 giao dịch, +2 dòng sổ (1 DEBIT, 1 CREDIT), số dư đổi đúng 100 000 |
| `verify` | `reconciliation_runs` dòng mới sau lần gửi lại: `OK`, 0 lệch; `invariants.js` PASS; audit theo mã của lần gửi lại có dòng `transfer`; log có mã đó |

**Đã chạy** ngày 2026-11-15 trên phiên cloud (image `c0db04a`), raw ở [manual-test-cloud.txt](../features/screenshots/DBS-185/manual-test-cloud.txt):
- Task api cũ dừng khi backend (`pid` 3174) còn ngủ trong `INSERT ledger_entries` (đã giữ khóa `idempotency_keys`, `transfers`, `ledger_entries`; thấy trong `pg_locks` từ 02:19:09 tới 02:21:03). `stop-task` lúc 02:19:12.7. ECS gỡ target sau 25 s (ALB cắt kết nối: client lần đầu nhận **502** không có `X-Correlation-Id`), container thoát sau 69 s (**exit 0**: ứng dụng tắt êm, request đang chạy lỗi `Unhandled exception`, không commit), task STOPPED sau 92 s.
- **Thời gian task mới lên (kể từ `stop-task`):** task mới tạo +102 s, RUNNING +131 s, đăng ký vào target group +129 s, service «steady state» +137 s (desired 1, nên không có task nào chạy trong ≈ 2 phút).
- Sau kill: `idempotency_keys` của `K` 0 dòng; `pg_locks` không còn backend đó; giao dịch 1, dòng sổ (3 CREDIT, 1 DEBIT), số dư 48.000.000 / 5.500.000 đúng bằng trước.
- Gửi lại `K`: 201, `transferId` `3d4c3901-…`, mã `C2` `13cdd8b9-…`; lần hai: 201 cùng `transferId` (replay, `C3` `02b3cbb0-…`). Sau đó giao dịch 2, DEBIT 2, CREDIT 4, số dư 47.900.000 / 5.600.000.
- Mã của lần bị dừng `C1` = `83bf5675-…` chỉ còn trong log task cũ (`Unhandled exception` lúc 02:20:10 khi tắt êm); audit theo `C1` và `C3` trả 0 dòng (replay không ghi audit); audit theo `C2`: `transfer` (customer) và `notification.sent` (worker).
- Đối soát: dòng `reconciliation_runs` số 10 (02:29:38, sau lần gửi lại 02:25:06) `OK`, 0 lệch, nợ = có = 87.600.000, tổng số dư 0. `invariants.js` qua task ECS (lần đầu chạy trên RDS dev): PASS, thoát 0.

**Giới hạn đã biết.** Task bị dừng bằng `stop-task` (SIGTERM, ứng dụng thoát 0), không phải SIGKILL cứng; điều chứng minh là transaction đang mở trên DB khi task chết và không bao giờ commit. Phần video chưa quay (BL-380). Các pha chạy riêng từng pha, chưa chạy một mạch. Lần chạy này được kết luận hợp lệ sau khi sửa tiêu chí exit code: `evaluate` chạy lại trên các tệp đã lưu (tiêu chí cũ đòi exit 137, xem [DBS-185 §8](../features/DBS-185-ac-5-10-kill-task-cloud.md#8-kết-quả)).
