# Health probes · DBS-78

Public, version-neutral routes: `/health/live` and `/health/ready`.

- live returns200 `{status:"ok"}` without database/Redis calls. It checks the process.
- ready first runs existing PostgreSQL Terminus probe (1500ms timeout). Failure keeps
  existing503 response/database-down details and skips the Redis call.
- With PostgreSQL up, the bounded DBS-76 RedisClient.ping probe adds a root `redis`
  field: `up` for PONG, `degraded` for operational Redis errors or a non-PONG reply.
  HTTP200 and Terminus `status:"ok"` remain, so ALB does not drain a task for Redis.
  Existing info/error/details database fields remain intact.
- Unexpected programming errors propagate through the normal sanitized500 filter.
  No Redis URL, credential, raw exception reason or stack is returned.

RedisModule owns its client lifecycle. No direct ioredis, second timeout loop,
new config/env, database fallback query or worker HTTP endpoint is introduced.
Swagger's200 response documents redis=up|degraded;503 retains Terminus schema.

Targeted HTTP suite: npm run test:e2e -- --runInBand --runTestsByPath test/health.e2e-spec.ts
Real services: npm run test:services -- --runInBand --runTestsByPath test/services/health-readiness.services-spec.ts
Manual: npm run build; node scripts/manual-dbs78.cjs from backend. Driver starts
disposable PostgreSQL17/Valkey plus a local latency proxy and real Nest HTTP app.
It stops only its own containers, never the shared Compose database, then closes
HTTP/pools/Redis/proxy. Docker must run; failure is explicit, never skipped.
