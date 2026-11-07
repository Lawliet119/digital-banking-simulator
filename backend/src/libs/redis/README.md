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

Mọi lệnh đi qua `opossum`: timeout `min(config,50ms)`, ngưỡng lỗi 50%, volume 10, rolling 10s,
reset 5s. Một listener `failure` tự viết bù khoảng hở `opossum` dùng `>` strict thành `>=50` theo
đúng rolling stats, không đổi hằng số đã chốt. Deadline chỉ từ chối sau khi timer của nó chạy hết;
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

Test: `npm run test:services -- --runInBand --runTestsByPath test/services/redis-adapter.services-spec.ts`.
Thủ công: `docker compose up -d valkey`; từ `backend` chạy `npm run build` rồi
`node scripts/manual-dbs76.cjs`. Driver chỉ dùng Compose Valkey và proxy TCP test, prefix key
riêng, dọn sạch ở `finally`; không bao giờ kết nối AWS.
