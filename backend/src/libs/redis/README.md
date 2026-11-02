# Redis adapter · DBS-76

Import `RedisModule`, inject `RedisClient` and `RedisMetrics` from `@libs/redis`.
Configuration uses existing `redisConfig`: REDIS_URL and REDIS_COMMAND_TIMEOUT_MS.
ioredis normal node client handles both redis:// and rediss://; TLS certificate
verification remains enabled. No URLs, credentials, keys, values or raw error causes
are logged by this library. ESLint prevents direct production ioredis imports elsewhere.

Methods: get(key), set(key,value,ttlSeconds), incr(key,ttlSeconds),
zadd(key,score,member,ttlSeconds), zrangebyscore(key,min,max), del(key), ping().
TTL is a safe integer1..604800 seconds; score/bounds are safe integers.
get returns string|null; incr returns an exact decimal string (including >2^53).
INCR+GET+EXPIRE and ZADD+EXPIRE use single Lua scripts to avoid interleaving.
Lua is **not rollback**: an unexpected runtime/ACL error may follow an earlier write.
Invalid TTL rejects before any mutation. Callers own key formats and allowed cache data
(ADR-12); never cache balances, transaction status or personal data.

Every operation runs through opossum: timeout min(config,50ms), 50% error threshold,
volume10, rolling10s, reset5s. A failure listener handles opossum's strict >50 boundary
as inclusive >=50 using the same rolling stats and unchanged accepted constants.
The deadline rejects after its timer runs; it cannot promise hard real-time scheduling.
No offline queue, per-command retries, or resend of unfulfilled commands. Background
reconnect is allowed and does not buffer operations. Startup may return UNAVAILABLE
until isReady. circuitState is read-only: closed/open/half-open/shutdown.

Failures reject `RedisUnavailableError` with a bounded reason:
TIMEOUT, CIRCUIT_OPEN, UNAVAILABLE, COMMAND_FAILED or SHUTDOWN. Each operational
rejection increments redis_fallback_total exactly once; caller validation errors and
background socket errors do not. `RedisMetrics.metrics()` exposes Prometheus text;
`count()` supports diagnostics. Metrics HTTP/dashboard integration is a later task.

Caller must catch this error and choose ADR-12 fallback: rate limit fail-open,
revocation/config/features read PostgreSQL. A miss (`null`) is a successful operation,
not a fallback error. Timed-out writes are **indeterminate**: do not retry INCR under
the assumption it rolled back. Use event IDs/idempotent set members for cache recovery.
Do not perform cache calls inside a money transaction. No Postgres fallback is executed
by this generic adapter. API/worker wiring belongs the caller tasks.

Nest shutdown stops breaker timers, reconnect timers and sockets immediately, discarding
pending cache operations. No Redis QUIT is awaited through a stalled connection.

DBS-78 integration: RedisModule constructs a lazy client, starting connection in
onModuleInit without awaiting Redis availability. This keeps a failed NestFactory.create
from leaking reconnect sockets before the bootstrap code receives a cleanup context.
Direct diagnostic constructor calls keep the previous eager default. Callers importing
RedisModule get automatic initialization and shutdown through Nest lifecycle.

Test: npm run test:services -- --runInBand --runTestsByPath test/services/redis-adapter.services-spec.ts
Manual: docker compose up -d valkey; from backend run npm run build then
node scripts/manual-dbs76.cjs. Driver uses only Compose Valkey and a local TCP proxy,
isolated key prefix, and cleans up in finally; it never connects to AWS.
