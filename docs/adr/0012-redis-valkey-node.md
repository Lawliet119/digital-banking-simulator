# ADR-12: Redis (Valkey trên ElastiCache, node cố định) cho rate limit, mốc thu hồi, bộ đếm gian lận và cache cấu hình; không cache số dư

| | |
|---|---|
| Trạng thái | **Accepted** |
| Ngày | 2026-10-11 |
| Người viết | #2 (rate limit, thu hồi phiên), #4 (bộ đếm, cấu hình) |
| Người duyệt | #5 (người dựng hạ tầng); cả nhóm |
| Liên quan | Driver D-4, D-6 · NFR-SEC-02, NFR-SEC-05, NFR-FRD-01, UC-12 · [`docs/03` §9](../03_HIGH_LEVEL_ARCHITECTURE.md) · [ADR-11](0011-aws-managed-session-based.md) |

## Bối cảnh

Có bốn việc mà PostgreSQL hoặc bộ nhớ trong từng task làm không tốt (docs/03 §9.1):

- **R-1 Rate limit toàn cục.** Đếm trong từng task thì 2 task cho giới hạn gấp đôi.
- **R-2 Cache mốc thu hồi phiên.** Nếu không có cache, mọi request phải đọc bảng `users`.
- **R-3 Bộ đếm velocity và fan-out** cho luật R1, R5. Nếu không có, mỗi sự kiện phải quét lịch sử bằng SQL.
- **R-4 Cache cấu hình luật.** Nếu không có, mỗi sự kiện phải đọc lại cấu hình từ DB.

Hai câu hỏi cần chốt: **có dùng Redis cho những việc này không**, và **dựng kiểu nào** trên AWS.

## Các phương án

**Dùng cho việc gì**

| Tiêu chí | A. Không cache | B. Bộ nhớ trong từng task | **C. Redis cho R-1…R-4, không cache số dư** | D. Redis cho cả số dư |
|---|---|---|---|---|
| Rate limit đúng khi nhiều task | Không có rate limit | Sai: gấp N lần | **Đúng** | Đúng |
| Tải RDS từ đặc trưng gian lận ở 120 RPS | Cao | Không dùng được (worker có thể nhiều task) | **Thấp** | Thấp |
| Tiền đúng khi Redis mất dữ liệu | Đúng | Đúng | **Đúng: Redis không giữ dữ liệu gốc** | **Sai**: số dư cũ có thể bị dùng để quyết định |

**Dựng kiểu nào**

| Tiêu chí | **A. Node `cache.t4g.micro`, cluster mode tắt** | B. ElastiCache Serverless (Valkey) |
|---|---|---|
| Client | **ioredis thường, giống hệt local** | Cần client hỗ trợ cluster mode; local (container Valkey thường) và cloud khác nhau |
| Chi phí khi bật | ~0,016 USD/giờ (Singapore, ước tính) | Tối thiểu ~0,008 USD/giờ cho dữ liệu, cộng phí ECPU |
| Multi-AZ | Thêm 1 replica khi cần (cấu hình production) | Có sẵn |
| TLS | Bật được (`transit_encryption_enabled`) | Luôn bật |
| Thời gian tạo | ~5–10 phút | Vài phút |

## Quyết định

- Chọn **C**: Redis chỉ cho R-1…R-4. **Không bao giờ** lưu số dư, trạng thái giao dịch, mã yêu cầu, session hay dữ liệu cá nhân (docs/03 §9.2).
- Chọn **node-based Valkey, cluster mode tắt**: dev 1 node `cache.t4g.micro`; cấu hình production thêm 1 replica ở AZ khác với automatic failover. Bật TLS khi truyền (`rediss://`) và AUTH token (lưu ở Secrets Manager).
- Mọi key có TTL. Danh sách key:

  | Key | Kiểu | TTL |
  |---|---|---|
  | `rl:user:{userId}:{phút}`, `rl:ip:{ip}:{phút}` | Counter | 60 giây |
  | `revoked_at:{userId}` | Chuỗi (epoch giây) | Bằng `ACCESS_TOKEN_TTL_SECONDS` (900) |
  | `risk:vel:{accountId}` | Sorted set, member = `transferId`, score = `occurredAt` | 2 giờ |
  | `risk:fan:{accountId}` | Sorted set, member = id tài khoản nhận, score = `occurredAt` | 2 giờ |
  | `cfg:risk:latest` | Số phiên bản | 60 giây |
  | `cfg:risk:v{n}` | JSON cấu hình bất biến | 7 ngày |

- **Client** (`libs/redis`): timeout mỗi lệnh **50 ms** (`REDIS_COMMAND_TIMEOUT_MS`), circuit breaker (opossum) với `errorThresholdPercentage = 50`, `volumeThreshold = 10`, cửa sổ 10 giây, `resetTimeout = 5 giây`. Breaker mở hoặc lệnh lỗi thì caller rơi về đường dự phòng, và metric `redis_fallback_total` tăng.
- **Khi Redis lỗi** (docs/03 §9.3): R-1 fail-open (WAF vẫn giới hạn theo IP ở biên); R-2 đọc `users.sessions_revoked_at`; R-3 truy vấn SQL qua `v_transfer_facts`; R-4 đọc `risk_rule_sets`.

## Lý do

- Nguyên tắc P-1: "xóa sạch Redis bất kỳ lúc nào, hệ thống vẫn đúng". Chỉ đưa vào Redis những thứ dựng lại được. Số dư thì không, vì cache số dư có thể dẫn tới quyết định chuyển tiền dựa trên số cũ.
- Node non-cluster cho phép dùng cùng một client và cùng một đoạn code ở local, CI (Testcontainers) và cloud. Serverless rẻ hơn vài USD trong cả kỳ nhưng bắt `libs/redis` có hai chế độ, và lỗi chỉ xuất hiện trên cloud là loại lỗi tốn thời gian nhất.
- 50 ms lớn hơn nhiều độ trễ bình thường trong cùng AZ (dưới 1 ms) nhưng nhỏ so với ngân sách p95 300 ms, nên Redis chậm không kéo chuyển tiền vượt SLO.

## Đánh đổi và hệ quả

- Dev chỉ có 1 node, nên Redis restart là mất bộ đếm và cache. Đúng thiết kế: hệ thống tự dựng lại, chỉ chậm hơn một lúc.
- Rate limit fail-open nghĩa là trong lúc Redis lỗi, giới hạn theo user không còn; WAF giới hạn theo IP ở biên.
- **Xem lại khi:** cần nhiều hơn một shard, hoặc chuyển sang chạy 24/7 lâu dài (khi đó so lại Serverless).

## Cách kiểm chứng

- Adapter: Redis **chậm** (proxy làm trễ quá timeout) chứ không chỉ chết → breaker mở, hồi phục khi Redis ổn (DBS-76).
- Luồng nghiệp vụ: Redis chậm hoặc tắt giữa luồng chuyển tiền → vẫn COMPLETED, p95 trong ngưỡng, `/health/ready` 200 kèm `redis=degraded` (DBS-78, DBS-100).
- Flush Redis rồi chạy AC-11.1 → vẫn từ chối `SESSION_REVOKED` (DBS-186).
- Load test có và không có Redis, so tải RDS và p95 thời gian tới cờ (DBS-167).
- Rate limit với 2 task `api`: có Redis thì số request được chấp nhận đúng bằng giới hạn (docs/03 §9.4).
