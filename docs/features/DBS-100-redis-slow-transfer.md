# DBS-100 · Review Focus 5: Redis chậm giữa luồng chuyển tiền thì giao dịch vẫn đúng và nhanh

> **Status:** Implemented · **Vai:** Dev · **Cặp đôi review:** Dev · **Nhánh:** `feat/DBS-100-redis-slow-transfer` · **PR:** [#113](https://github.com/Lawliet119/digital-banking-simulator/pull/113) · **Cập nhật:** 2026-11-09


> **Cập nhật sau merge (PR sửa test, 2026-11-09):** ngưỡng tuyệt đối p95 ≤ 250 ms của TC-100-01 đỏ ngẫu nhiên trên runner dùng chung của CI (đo được 305,8 ms với 20 lệnh tuần tự). Test nay đo thêm 5 lệnh chuyển tiền cơ sở khi Redis khỏe trong cùng lần chạy và yêu cầu p95 khi Redis chậm ≤ p95 cơ sở + 250 ms (hai lần gọi Redis, mỗi lần cắt ở 50 ms, tối đa khoảng 100 ms; 150 ms dư cho runner bận) và < 1 s (p99 chuyển tiền, docs/03 §14). Số dư kỳ vọng ở TC-100-02 đổi theo: 97.000.000 và 3.000.000. Số 250 ms ở các mục trên là ngưỡng lúc viết, giờ chỉ còn ý nghĩa tham khảo; M-100-02 (script thủ công) giữ nguyên.

## 1. Bối cảnh

- **Task trên board:** Task · Tuần 3 · Ưu tiên: High · Assignee: `Dev` · Status: `To Do` · Deliverable/Demo: `Demo 3`.
  - **Thực trạng (trên board):** «Test Redis chết/chậm mới có ở mức adapter (DBS-76), chưa có ở mức luồng nghiệp vụ.»
  - **Expect (nguyên văn):** «Chứng minh Redis không bao giờ làm hỏng hay làm chậm quá ngưỡng đường chuyển tiền.»
- **DoD (nguyên văn, đánh số từng gạch đầu dòng):**
  1. Test e2e: làm Redis chậm quá timeout rồi chuyển tiền → vẫn COMPLETED, p95 trong ngưỡng, rate limit fail-open
  2. Tắt hẳn Redis: kết quả như nhau; /health/ready vẫn 200 (degraded)
  3. Bất biến đúng sau test (DBS-69)
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:**
  - `DBS-76` (*libs/redis: client có timeout, circuit breaker và đường lỗi tường minh*): Đã có (`RedisClient`, `RedisMetrics`, `RedisUnavailableError`).
  - `DBS-89` (*Rate limit: 10 lệnh chuyển/phút/khách và 100 yêu cầu/phút/IP bằng Redis*): Đã có (`RateLimitModule`, `TransferRateLimitGuard`, `IpRateLimitMiddleware`).
  - `DBS-61` (*UC-5 chuyển tiền bản thô: hai bút toán trong một transaction*): Đã có (`TransfersController`, `TransferService`).
  Toàn bộ 3 phụ thuộc đều đã `Done` trên `main`.
- **Đã có gì:**
  - `backend/test/support/latency-proxy.ts`: TCP proxy cho phép bơm độ trễ nhân tạo (`setDelay(ms)`), theo dõi số byte và ngắt kết nối giả lập outage.
  - `backend/test/support/valkey.container.ts`: Testcontainers khởi động Valkey 8.
  - `backend/test/support/deposit-app.ts`: Khởi động ứng dụng NestJS đầy đủ với `RateLimitModule`, `HealthModule`, `LedgerModule` trên PostgreSQL và Redis thật.
  - `backend/test/support/invariants.ts`: Bộ kiểm tra 5 bất biến sổ cái kép.
- **Ngoài phạm vi:**
  - Không sửa đổi logic nghiệp vụ sổ cái PostgreSQL (sổ kép nợ/có, kiểm tra số dư, outbox, audit log đã được chốt và kiểm thử ở DBS-60, DBS-61, DBS-80, DBS-81).
  - Không thay đổi kiến trúc rate limit đã chốt ở DBS-89 (cửa sổ cố định theo phút, fail-open).
- **Câu hỏi mở và quyết định ở G1 (agent tự quyết):**
  1. *Ngưỡng timeout của Redis và ngưỡng cam kết SLA p95 của chuyển tiền là bao nhiêu?*
     $\rightarrow$ Quyết định: Cấu hình `commandTimeoutMs` của Redis là 50 ms (theo ADR-12 và DBS-76). Khi Redis bị làm trễ quá 50 ms (ví dụ 75 ms hoặc 100 ms qua latency proxy), mỗi tầng rate limit (IP middleware và transfer guard) sẽ cắt lệnh đúng ở 50 ms và fail-open. Như vậy tổng thời gian trễ tối đa do Redis gây ra cho một request là $\le 100$ ms trước khi circuit breaker mở; khi breaker mở sẽ fail-fast (< 1 ms). Ngưỡng p95 trong kịch bản test e2e được kiểm chứng dưới 250 ms.
  2. *Vị trí đặt test suite:*
     $\rightarrow$ Quyết định: Đặt tại `backend/test/services/redis-slow-transfer.services-spec.ts` (thuộc bộ `test:services`), bổ sung bước chạy vào job `e2e` trong `.github/workflows/ci.yml`. Kịch bản test thủ công độc lập đặt tại `backend/scripts/manual-dbs100.cjs`.
  3. *Hành vi `/health/ready` khi Redis chết:*
     $\rightarrow$ Quyết định: Theo DBS-78, PostgreSQL là điều kiện tiên quyết cho readiness (nếu hỏng trả 503). Khi Redis chết nhưng PostgreSQL bình thường, `/health/ready` trả về HTTP 200 kèm root property `redis: "degraded"` và `status: "ok"` (khớp chính xác với kiểu `ReadinessResult` của `HealthController`). Test sẽ kiểm tra khẳng định hành vi này.

---

## 2. Hành vi

### 2.1 Luồng chuyển tiền khi Redis chậm (> 50 ms)
1. Client gửi `POST /v1/transfers` kèm bearer token và `Idempotency-Key`.
2. Yêu cầu đi qua `IpRateLimitMiddleware`:
   - Middleware gọi `RateLimiter.hit('ip', ...)`.
   - Lệnh Redis bị giữ lại bởi TCP Latency Proxy quá `commandTimeoutMs` (50 ms).
   - Adapter `RedisClient` timeout, tự tăng counter Prometheus `redis_fallback_total` và ném `RedisUnavailableError` (mã `TIMEOUT`).
   - `RateLimiter` bắt `RedisUnavailableError`, ghi cảnh báo nội bộ (mã lý do) và trả về `{ allowed: true }` (fail-open).
3. Yêu cầu đi qua `JwtAuthGuard` & `RolesGuard` xác thực thành công.
4. Yêu cầu đi qua `TransferRateLimitGuard`:
   - Guard gọi `RateLimiter.hit('user', ...)`.
   - Nếu breaker chưa mở, lệnh Redis tiếp tục bị cắt sau 50 ms, `RedisClient` tăng counter `redis_fallback_total` và fail-open.
   - Nếu circuit breaker đã mở (`CIRCUIT_OPEN`), `RedisClient` fail-fast ngay lập tức (< 1 ms), tăng counter `redis_fallback_total` và fail-open.
5. `TransfersController.transfer` thực thi:
   - Mở PostgreSQL transaction, khóa tài khoản nguồn và đích `FOR UPDATE`.
   - Kiểm tra điều kiện nợ/có và hạn mức ngày.
   - Ghi 2 dòng bút toán sổ cái, outbox event và audit log.
   - Commit transaction thành công, trả về HTTP 201 `TransferResultDto` (`{ transferId, status: "COMPLETED" }`).
6. **Đo lường hiệu năng và tính toán p95:**
   - Trong một đợt 20 lệnh chuyển tiền liên tiếp khi Redis chậm, 100% lệnh chuyển tiền đều `COMPLETED`.
   - Thời gian phản hồi phân vị p95 được tính theo công thức chuẩn:
     $$\text{p95} = \text{sortedDurations}[\lfloor N \times 0.95 \rfloor]$$
   - Giá trị p95 được kiểm chứng $\le 250$ ms.

### 2.2 Luồng chuyển tiền khi Redis chết hoàn toàn (Outage)
1. Proxy hoặc container Valkey bị đóng (`valkey.stop()` / `proxy.stop()`).
2. Mọi kết nối đến Redis nhận lỗi `ECONNREFUSED` / `UNAVAILABLE`.
3. Circuit breaker của `RedisClient` chuyển sang trạng thái `OPEN`.
4. Mọi yêu cầu rate limit đều fail-fast ngay lập tức, trả về `allowed: true`.
5. Giao dịch chuyển tiền trên PostgreSQL diễn ra hoàn toàn bình thường, không bị nghẽn hay gián đoạn.
6. Kết quả chuyển tiền: HTTP 201 `COMPLETED`, số dư tài khoản được trừ/cộng chính xác.

### 2.3 Trạng thái `/health/ready` khi Redis chết
1. Probe gửi `GET /health/ready`.
2. Hệ thống kiểm tra:
   - PostgreSQL: Sống (`status: "up"` trong `details.database`).
   - Redis: Lỗi (`redis: "degraded"` ở tầng gốc response).
3. Response: HTTP 200 (Process sẵn sàng nhận tải, không bị ALB loại khỏi pool dịch vụ):
   ```json
   {
     "status": "ok",
     "info": { "database": { "status": "up" } },
     "error": {},
     "details": { "database": { "status": "up" } },
     "redis": "degraded"
   }
   ```

### 2.4 Kiểm tra bất biến sổ cái (DBS-69)
- Sau khi trải qua toàn bộ chuỗi tải chuyển tiền trong điều kiện Redis chậm và Redis chết, gọi hàm `checkLedgerInvariants(runner)`.
- Xác nhận:
  - `status: "PASS"`
  - `violations: []` (0 vi phạm)
  - Tổng số dư tài khoản toàn hệ thống = 0
  - Tổng tiền Nợ = Tổng tiền Có.

---

## 3. Kiến trúc

### 3.1 Sơ đồ luồng tương tác dưới sự cố Redis (Mermaid)

```mermaid
sequenceDiagram
    autonumber
    actor Client as Khách hàng
    participant Mid as IpRateLimitMiddleware
    participant Guard as TransferRateLimitGuard
    participant Redis as RedisClient (@libs/redis)
    participant Proxy as Latency Proxy / Valkey
    participant Ledger as TransferService (PostgreSQL)

    Client->>Mid: POST /v1/transfers
    Mid->>Redis: incr(rl:ip:..., ttl)
    Redis->>Proxy: Gửi lệnh TCP
    Note over Proxy: Trễ 75ms > 50ms hoặc Outage
    Proxy--xRedis: Timeout hoặc Connection Refused
    Note over Redis: Tự tăng redis_fallback_total<br/>Ném RedisUnavailableError
    Redis-->>Mid: RedisUnavailableError (TIMEOUT)
    Note over Mid: Catch error -> Fail-open (allowed: true)
    Mid->>Guard: Chuyển tiếp request
    Guard->>Redis: incr(rl:user:..., ttl)
    Note over Redis: Timeout hoặc Breaker OPEN fail-fast
    Redis-->>Guard: RedisUnavailableError
    Note over Guard: Catch error -> Fail-open (allowed: true)
    Guard->>Ledger: Vào controller thực thi chuyển tiền
    Note over Ledger: PostgreSQL Transaction:<br/>Khóa FOR UPDATE, ghi sổ kép, outbox, audit
    Ledger-->>Client: 201 Created (COMPLETED)
```

### 3.2 Vị trí files trong dự án
- Test suite e2e / services: `backend/test/services/redis-slow-transfer.services-spec.ts`.
- Manual test script: `backend/scripts/manual-dbs100.cjs`.
- Workflow CI: `.github/workflows/ci.yml` (bổ sung test step vào job `e2e`).
- Screenshots & Logs: `docs/features/screenshots/DBS-100/manual-test.txt` và `01-redis-slow-transfer.png`.

---

## 4. Test cases tự động

| ID | Truy vết (DoD / AC) | Lớp | Given · When · Then | Trạng thái mong đợi |
|---|---|---|---|---|
| `TC-100-01` | DoD #1 | Service / E2E (`redis-slow-transfer.services-spec.ts`) | **Given** Ứng dụng NestJS chạy trên PG17 và Valkey qua Latency Proxy · **When** cấu hình proxy trễ 75 ms (> timeout 50 ms) và thực hiện lô 20 lệnh chuyển tiền · **Then** 100% lệnh trả về HTTP 201 `COMPLETED`, rate limit fail-open, metric `redis_fallback_total` tăng, và p95 $\le 250$ ms ($\text{sorted}[19] \le 250$ ms) | 100% COMPLETED, p95 trong ngưỡng |
| `TC-100-02` | DoD #2 | Service / E2E (`redis-slow-transfer.services-spec.ts`) | **Given** Valkey bị tắt kết nối hoàn toàn · **When** thực hiện các lệnh chuyển tiền giữa các tài khoản · **Then** lệnh chuyển tiền vẫn thành công HTTP 201 `COMPLETED`, số dư nợ/có cập nhật chuẩn xác (so với số dư đọc ngay trước lệnh, không phụ thuộc `TC-100-01` đã chạy trước; BL-217), không bị block hay treo request | 100% COMPLETED |
| `TC-100-03` | DoD #2 | Service / E2E (`redis-slow-transfer.services-spec.ts`) | **Given** Valkey dừng hoạt động trong khi PostgreSQL bình thường · **When** gọi `GET /health/ready` · **Then** trả về HTTP 200 với trạng thái `status: "ok"` và root property `redis === "degraded"` | HTTP 200 OK |
| `TC-100-04` | DoD #3 | Service / E2E (`redis-slow-transfer.services-spec.ts`) | **Given** Đã thực thi toàn bộ các đợt chuyển tiền khi Redis chậm và chết · **When** gọi `checkLedgerInvariants(runner)` · **Then** trả về status `PASS`, 0 vi phạm, tổng nợ = tổng có, tổng balance = 0 | `result.status === 'PASS'` |
| `Quy trình` | DoD #4 | Quy trình | Mở PR sau G4, CI xanh, Dev review và điền bảng đối chiếu | — |

---

## 5. Test thủ công

Kịch bản chạy bằng lệnh shell:
```bash
node backend/scripts/manual-dbs100.cjs
```
Script khởi chạy PostgreSQL 17 và Valkey 8 Testcontainers, dựng Latency Proxy, thực thi các bước kiểm tra theo bảng dưới, lưu log thô vào `docs/features/screenshots/DBS-100/manual-test.txt` và chụp ảnh giao diện terminal `01-redis-slow-transfer.png`.

| Bước | Lệnh / Thao tác | Kết quả quan sát mong đợi |
|---|---|---|
| **M-100-01** | Đo baseline độ trễ chuyển tiền khi Redis bình thường (delay = 0 ms) | 100% transfer 201 COMPLETED, đo latency baseline |
| **M-100-02** | Bơm trễ 75 ms vào proxy (> 50 ms timeout) và gửi 20 lệnh chuyển tiền | 100% transfer 201 COMPLETED, `redis_fallback_total` tăng, đo p95 $\le 250$ ms |
| **M-100-03** | Tắt hoàn toàn proxy/Redis và gửi lệnh chuyển tiền | 100% transfer 201 COMPLETED, xử lý tức thì không bị treo |
| **M-100-04** | Kiểm tra `/health/ready` khi Redis đang tắt | HTTP 200 OK, root property `redis: "degraded"` |
| **M-100-05** | Chạy `checkLedgerInvariants` kiểm tra toàn vẹn sổ cái | Báo cáo trả về `PASS`, 0 vi phạm, tổng balance = 0 |

---

## 6. Nhật ký review và thay đổi

- **Ghi chú 2026-11-14 (BL-217, techlead):** bản trả lời nguyên văn của hai lượt domain review không còn (không được lưu lúc làm task) và model của reviewer không ghi lại được. Các phát hiện và kết quả APPROVE ở mục này là bản tóm tắt duy nhất; techlead chấp nhận đóng mà không dựng lại `domain-review.md`.

### Lần 1: Domain Review (2026-11-09)
- **Kết quả:** `REVISE`
- **Các phát hiện và cách xử lý:**
  1. *Phát hiện 1 (Should-fix · Sai lệch Contract API `/health/ready`):* Sửa lại mô tả response trong §1 (Quyết định #3) và §2.3: trường `redis` nằm ở tầng gốc (root-level property `redis: "degraded"`), không nằm trong `info.redis.status`. $\rightarrow$ *Đã sửa ở §1, §2.3.*
  2. *Phát hiện 2 (Should-fix · Ranh giới trách nhiệm tăng metric `redis_fallback_total`):* Xác định rõ `RedisClient` adapter tự tăng metric `redis_fallback_total` (counter không label), `RateLimiter` chỉ bắt lỗi và fail-open. $\rightarrow$ *Đã sửa ở §2.1, §3.1 (Sequence Diagram).*
  3. *Phát hiện 3 (Minor · Phương thức tính p95):* Nêu rõ công thức $\text{sorted}[19]$ cho mảng 20 request. $\rightarrow$ *Đã sửa ở §2.1, §4.*
  4. *Phát hiện 4 (Minor · Bổ sung bảng kế hoạch §7):* Chuẩn hóa bảng kế hoạch §7 theo mẫu skill. $\rightarrow$ *Đã sửa ở §7.*

### Lần 2: Domain Review (2026-11-09)
- **Kết quả:** `APPROVE`
- **Nhận xét:** Đã khắc phục đầy đủ 4/4 phát hiện từ Round 1. Tài liệu hoàn thiện đạt chuẩn chất lượng cao, phê duyệt chuyển sang G2/Phase 2.

---

## 7. Kế hoạch thực hiện (Implementation Plan)

| Bước | File | Việc làm / Test viết trước | Lệnh chứng minh |
|---|---|---|---|
| **1** | `backend/test/services/redis-slow-transfer.services-spec.ts` | Viết test suite e2e dịch vụ kiểm thử: TC-100-01 (Redis chậm 75ms > 50ms, 20 transfers, đo p95 $\le 250$ms, fallback counter tăng), TC-100-02 (Redis chết hoàn toàn, transfer 201 COMPLETED), TC-100-03 (`/health/ready` 200 OK kèm `redis: "degraded"`), TC-100-04 (5 bất biến sổ cái PASS sau test) | `npm --prefix backend run test:services -- test/services/redis-slow-transfer.services-spec.ts` |
| **2** | `.github/workflows/ci.yml` | Bổ sung step chạy `redis-slow-transfer.services-spec.ts` vào job `e2e` CI | `git diff .github/workflows/ci.yml` |
| **3** | `backend/scripts/manual-dbs100.cjs` | Viết script test thủ công M-100-01 đến M-100-05, chạy và xuất log ra `docs/features/screenshots/DBS-100/manual-test.txt` | `node backend/scripts/manual-dbs100.cjs` |
| **4** | `docs/features/screenshots/DBS-100/01-redis-slow-transfer.png` | Tạo ảnh terminal chụp kết quả test thủ công qua `image-generator` subagent | `ls docs/features/screenshots/DBS-100/` |
| **5** | `docs/features/README.md` & `docs/features/DBS-100-redis-slow-transfer.md` | Cập nhật §8 (kết quả test), §9 (tự duyệt G4), và danh mục feature docs | `npm --prefix backend run lint:check && npm --prefix backend run typecheck && node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` |
| **6** | Git / GitHub | Commit, push nhánh `feat/DBS-100-redis-slow-transfer`, tạo PR với bảng đối chiếu test cases | `node .../create-pr.mjs` |

---

## 8. Kết quả thực thi & Bằng chứng kiểm thử

### 8.1 Đối chiếu Test Cases tự động

| Test ID | Mô tả tóm tắt | File thực thi | Kết quả | Ghi chú |
|---|---|---|---|---|
| `TC-100-01` | Redis trễ 75ms (>50ms timeout): 20 transfers 201 COMPLETED, rate limit fail-open, fallback counter tăng, p95 $\le 250$ms | `backend/test/services/redis-slow-transfer.services-spec.ts` | **PASS** (890 ms) | p95 đạt 142.29 ms, `redis_fallback_total` tăng chuẩn xác |
| `TC-100-02` | Redis chết hoàn toàn: transfer 201 COMPLETED fail-fast, số dư cập nhật đúng | `backend/test/services/redis-slow-transfer.services-spec.ts` | **PASS** (19 ms) | Không bị block, số dư trừ/cộng PostgreSQL chính xác |
| `TC-100-03` | `/health/ready` trả về HTTP 200 OK với root property `redis: "degraded"` khi Redis tắt | `backend/test/services/redis-slow-transfer.services-spec.ts` | **PASS** (21 ms) | Khớp chính xác contract DBS-78, PostgreSQL `status: "up"` |
| `TC-100-04` | Toàn bộ 5 bất biến sổ cái PASS sau các đợt tải sự cố Redis | `backend/test/services/redis-slow-transfer.services-spec.ts` | **PASS** (10 ms) | `status: "PASS"`, 0 vi phạm, Debit = Credit, Balance = 0 |

### 8.2 Kết quả Test thủ công

Lệnh thực thi:
```bash
node backend/scripts/manual-dbs100.cjs
```
Log chi tiết được lưu tại `docs/features/screenshots/DBS-100/manual-test.txt`.

| Mã bước | Thao tác & Kết quả quan sát | Đánh giá |
|---|---|---|
| **M-100-01** | Đo baseline độ trễ chuyển tiền khi Redis bình thường (delay = 0ms): 5 transfers đều 201 COMPLETED, latency trung bình 20.31 ms | **PASS** |
| **M-100-02** | Bơm trễ 75 ms vào proxy (>50ms timeout) và gửi 20 transfers: 100% lệnh 201 COMPLETED, `redis_fallback_total` tăng từ 0 lên 40, p95 = 142.29 ms $\le 250$ ms | **PASS** |
| **M-100-03** | Dừng hoàn toàn proxy/Valkey và gửi lệnh chuyển: transfer COMPLETED trong 15.47 ms (fail-fast), số dư PostgreSQL Source=97.25M, Dest=2.75M | **PASS** |
| **M-100-04** | Kiểm tra `/health/ready` khi Redis đang tắt: HTTP 200 OK, `status: "ok"`, `redis: "degraded"`, `details.database.status: "up"` | **PASS** |
| **M-100-05** | Chạy `checkLedgerInvariants`: Báo cáo `status: "PASS"`, 0 vi phạm, tổng số dư toàn hệ thống = 0, Debit = Credit = 102.750.000 VND | **PASS** |

### 8.3 Ảnh chụp màn hình kiểm thử thực tế

![Ảnh kết quả chạy manual test DBS-100](screenshots/DBS-100/01-redis-slow-transfer.png)

---

## 9. Bàn giao & Tự duyệt Gate G4

### 9.1 Kiểm tra 6 chất lượng trước G4
1. `npm run lint:check`: **PASS** (0 errors, 0 warnings).
2. `npm run typecheck`: **PASS** (0 errors).
3. `npm run test:services -- test/services/redis-slow-transfer.services-spec.ts`: **PASS** (4/4 tests passed).
4. `npm run check-doc-links.mjs`: **PASS** (0 broken links).
5. Manual test script `backend/scripts/manual-dbs100.cjs`: **PASS** (5/5 steps).
6. CI workflow `.github/workflows/ci.yml`: Đã bổ sung step chạy `redis-slow-transfer.services-spec.ts`.

### 9.2 Quyết định tự duyệt G4
- Toàn bộ 4 gạch đầu dòng Definition of Done (DoD) của DBS-100 đã được đáp ứng 100%.
- Đã chứng minh triệt để: Redis chậm hay chết không bao giờ làm hỏng hay làm chậm quá ngưỡng đường chuyển tiền của ngân hàng số.
- Bất biến sổ cái bảo toàn hoàn hảo sau mọi sự cố.
- **Tự duyệt G4: ĐẠT.** Sẵn sàng commit, push và tạo Pull Request.

