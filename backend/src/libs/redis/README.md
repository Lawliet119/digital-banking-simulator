# Redis adapter · DBS-76

Import `RedisModule`, inject `RedisClient` và `RedisMetrics` từ `@libs/redis`. Cấu hình dùng
`redisConfig` có sẵn: `REDIS_URL` và `REDIS_COMMAND_TIMEOUT_MS`. `ioredis` client chuẩn xử lý cả
`redis://` và `rediss://`; TLS certificate verification luôn bật. Không log URL, credential, key,
value hay message gốc của lỗi. ESLint chặn import `ioredis` trực tiếp ở nơi khác (kể cả dynamic
import bằng template literal).

Method: `get(key)`, `set(key,value,ttlSeconds)`, `incr(key,ttlSeconds)`,
`zadd(key,score,member,ttlSeconds)`, `zrangebyscore(key,min,max)`, `del(key)`, `ping()`.
TTL là safe integer 1..604800 giây; score/bound là safe integer. `get` trả `string|null`; `incr`
trả chuỗi decimal chính xác (kể cả > 2^53). `INCR+GET+EXPIRE` và `ZADD+EXPIRE` dùng một Lua script
để tránh interleave. Lua **không rollback**: lỗi runtime/ACL bất ngờ có thể xảy ra sau một ghi đã
thành công trước đó. TTL sai bị từ chối trước khi mutate bất cứ gì. Caller tự chịu trách nhiệm về
định dạng key và loại dữ liệu được phép cache (ADR-12); **không bao giờ** cache số dư, trạng thái
giao dịch hay dữ liệu cá nhân.

Kho cấu hình risk dùng thêm `serverTimeMs()`, `readExpiringVersion(key)`,
`setVersionBefore(key,version,deadlineMs)` và `setIfAbsent(key,value,ttlSeconds)`.
Lua giới hạn thời hạn và so sánh version atomically; lệnh cũ/quá hạn không ghi đè version mới,
`SET NX` không thay nội dung version có sẵn. `readExpiringVersion` trả `null` khi key vắng hoặc quá hạn, và ném `RedisUnavailableError` với `reason: 'CORRUPT'` khi key có mà không phải marker do code này ghi (sai kiểu, sai định dạng, ngoài int4, TTL lệch); `setVersionBefore` vẫn sửa được key hỏng đó. Các lệnh vẫn qua breaker như những method khác.
Caller phải lấy Redis TIME trước khi đọc primary và tự kiểm deadline lúc chọn snapshot; xem
[bugfix freshness](../../../../docs/features/BUG-20261109-risk-config-freshness.md).

Mọi lệnh đi qua `opossum`: timeout `min(config,50ms)`, ngưỡng lỗi 50%, volume 10, rolling 10s,
reset 5s. Một listener `failure` tự viết bù khoảng hở `opossum` dùng `>` strict thành `>=50` theo
đúng rolling stats, không đổi hằng số đã chốt. `opossum` 10.0.0 phát sự kiện `fire` trước khi xét
trạng thái nên một lệnh bị từ chối nhanh lúc OPEN cũng làm tăng `stats.fires`; vì thế `RedisClient`
từ chối `CIRCUIT_OPEN` ngay trong adapter (cùng điều kiện với `opossum`: không closed và chưa tới
lượt thử half-open), để chỉ các lệnh đã chạy mới vào mẫu số của tỷ lệ lỗi (BL-152). Deadline chỉ từ chối sau khi timer của nó chạy hết;
không cam kết scheduler hard real-time. Không offline queue, không tự retry theo lệnh, không gửi
lại lệnh chưa hoàn tất. Reconnect nền được phép và không buffer lệnh. Lúc khởi động có thể trả
`UNAVAILABLE` cho tới khi `isReady`. `circuitState` chỉ đọc: `closed`/`open`/`half-open`/`shutdown`.

Lỗi ném `RedisUnavailableError` với lý do giới hạn: `TIMEOUT`, `CIRCUIT_OPEN`, `UNAVAILABLE`,
`COMMAND_FAILED` hoặc `SHUTDOWN`. Mỗi lần từ chối nghiệp vụ tăng `redis_fallback_total` đúng một
lần; lỗi validate của caller và lỗi socket nền không tăng. Counter này đăng ký cả trên
`Registry` riêng của từng `RedisMetrics` (dùng cho `metrics()`/`count()` theo instance) và trên
`defaultRegister` của `prom-client` (dùng chung một counter cho toàn tiến trình), nên một endpoint
`/metrics` HTTP dựng theo cách thông thường (`defaultRegister.metrics()`) đã thấy được
`redis_fallback_total` ngay, không cần biết tới instance `RedisMetrics` cụ thể nào. Việc ghép HTTP
endpoint/dashboard thật vẫn là việc của task sau (BL-152).

**Redis lỗi không được làm hỏng nghiệp vụ — mọi nơi dùng `@libs/redis` phải có đường dự phòng.**
Caller bắt `RedisUnavailableError` và chọn fallback theo ADR-12: fail-open cho rate limit, đọc
PostgreSQL cho revocation/features/config. Một kết quả `null` (miss) là thành công, không phải lỗi
fallback. Ghi bị timeout là **không xác định**: không retry một `INCR` như thể nó đã rollback.
Dùng event ID hoặc sorted-set member idempotent để phục hồi cache an toàn. Không gọi cache trong
transaction tiền. Adapter này không tự thực hiện fallback Postgres — đó là việc của caller. Ghép
API/worker là việc của các task gọi adapter này.

Nest shutdown dừng timer breaker, timer reconnect và socket ngay, bỏ qua các lệnh cache đang chờ.
Không chờ `QUIT` qua một kết nối đã treo.

Tích hợp health (DBS-78): RedisModule tạo client với `lazyConnect=true`, bắt đầu kết nối ở `onModuleInit` nhưng không chờ Redis sẵn sàng để khởi động app. Nếu Nest lỗi trước khi khởi tạo module, client chưa mở socket reconnect. Client tạo trực tiếp ngoài module vẫn giữ mặc định kết nối ngay; shutdown vẫn đóng socket/timer theo hợp đồng cũ.

Test: `npm run test:services -- --runInBand --runTestsByPath test/services/redis-adapter.services-spec.ts`.
Thủ công: `docker compose up -d valkey`; từ `backend` chạy `npm run build` rồi
`node scripts/manual-dbs76.cjs`. Driver chỉ dùng Compose Valkey và proxy TCP test, prefix key
riêng, dọn sạch ở `finally`; không bao giờ kết nối AWS.

## Rate limit (DBS-89)

`common/rate-limit` dùng adapter này làm bộ đếm: `RateLimiter.hit(scope, id, limit)` gọi `incr` trên khóa **có số phút** (`rl:{ip|user}:{id}:{phút}`, TTL 60 s). Không dùng một khóa cố định: `incr` đặt lại `EXPIRE` ở mỗi lần gọi nên cửa sổ trượt mãi. Mọi `RedisUnavailableError` (và mọi lỗi bất ngờ) làm `hit` **cho qua** (fail-open, docs/03 §9.3); `redis_fallback_total` tăng ở đây như mọi lệnh Redis khác. Chi tiết và test: [DBS-89](../../../../docs/features/DBS-89-rate-limit.md).
