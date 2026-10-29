import { composeDatabaseUrl } from './compose-database-url';
import { composeRedisUrl } from './compose-redis-url';
import { loadEnv } from './load-env';

/**
 * Side-effect module: import it FIRST in every entrypoint (main.ts, data-source.ts).
 *
 * `APP_ROLE` decides which modules AppModule imports, and that decision is made when the module
 * file is evaluated — before Nest's ConfigModule exists. The env file must therefore already be
 * in `process.env`. ES imports run in order, so importing this file first guarantees it.
 */
loadEnv();

// On ECS the database credentials arrive as separate parts (DB_USER and DB_PASSWORD come from Secrets
// Manager); join them into DATABASE_URL, the only variable the rest of the app reads.
const database = composeDatabaseUrl(process.env);
if (database.url) {
  process.env.DATABASE_URL = database.url;
} else if (database.invalid.length > 0) {
  process.stderr.write(
    `DB_* variables are incomplete or malformed, DATABASE_URL not composed: ${database.invalid.join(', ')}\n`,
  );
}

// Same for Redis (DBS-75): the ElastiCache AUTH token arrives as REDIS_AUTH_TOKEN from Secrets Manager;
// join it with REDIS_HOST and REDIS_PORT into REDIS_URL.
const redis = composeRedisUrl(process.env);
if (redis.url) {
  process.env.REDIS_URL = redis.url;
} else if (redis.invalid.length > 0) {
  process.stderr.write(
    `REDIS_* variables are incomplete or malformed, REDIS_URL not composed: ${redis.invalid.join(', ')}\n`,
  );
}
