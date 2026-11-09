import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createClient } from 'redis';
import { DataSource } from 'typeorm';
import { RedisClient } from '@libs/redis';
import { startDepositApp } from './deposit-app';
import { migrate } from './temp-database';
import {
  assertDockerAvailable,
  awaitContainerStart,
  STARTUP_TIMEOUT_MS,
  withTimeout,
} from './postgres.container';
import { startValkeyContainer, type StartedValkey } from './valkey.container';
import { startLatencyProxy } from './latency-proxy';
import { checkLedgerInvariants } from './invariants';

type App = Awaited<ReturnType<typeof startDepositApp>>;
const docker = promisify(execFile);
export interface RevocationHttpResult {
  status: number;
  body: Record<string, unknown>;
  correlationId: string | null;
}

/** Own PG/Valkey only: real API credentials, no role/password changes on the shared server. */
export async function createSessionRevocationFixture() {
  let pg: StartedPostgreSqlContainer | undefined, valkey: StartedValkey | undefined;
  let proxy: Awaited<ReturnType<typeof startLatencyProxy>> | undefined;
  let owner: DataSource | undefined, admin: ReturnType<typeof createClient> | undefined;
  let stopped = false,
    active: App | undefined;
  let who: { sub: string; userId: string; accountId: string; issuedAt: number } | undefined;
  let operatorSub = '';
  let apiUrl = '';
  const apps: App[] = [];
  const tokens = new Map<App, { customer: string; operator: string }>();
  const actor = () => {
    assert.ok(who);
    return who;
  };
  const current = () => {
    assert.ok(active);
    return active;
  };
  const database = () => {
    assert.ok(owner);
    return owner;
  };
  const administration = () => {
    assert.ok(admin?.isReady);
    return admin;
  };
  const key = () => `revoked_at:${actor().userId}`;
  const until = async (
    check: () => boolean | Promise<boolean>,
    message: string,
    timeout = 5000,
  ) => {
    const deadline = Date.now() + timeout;
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error(message);
      await wait(10);
    }
  };
  const openAdmin = async () => {
    assert.ok(valkey);
    for (let i = 0; i < 20; i++) {
      const candidate = createClient({
        url: valkey.url,
        socket: { connectTimeout: 500, reconnectStrategy: false },
      });
      candidate.on('error', () => undefined);
      try {
        await candidate.connect();
        admin = candidate;
        return;
      } catch {
        if (candidate.isOpen) candidate.destroy();
        if (i === 19) throw new Error('Fixture Valkey admin unavailable');
        await wait(50);
      }
    }
  };
  const startRedis = async () => {
    assert.ok(valkey);
    if (stopped) {
      await docker('docker', ['start', valkey.containerId], {
        windowsHide: true,
        timeout: 20000,
      });
      // Docker can assign a new ephemeral host port after stop/start, including on Desktop.
      const mapping = (
        await docker('docker', ['port', valkey.containerId, '6379/tcp'], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 10000,
        })
      ).stdout
        .trim()
        .split(/\r?\n/)[0];
      const match = mapping.match(/:(\d+)$/);
      assert.ok(match, 'Valkey mapped port missing after restart');
      valkey.port = Number(match[1]);
      const updated = new URL(valkey.url);
      updated.port = match[1];
      valkey.url = updated.toString();
      await proxy?.stop();
      proxy = await startLatencyProxy(valkey.host, valkey.port);
      stopped = false;
    }
    if (!admin?.isReady) {
      if (admin?.isOpen) admin.destroy();
      await openAdmin();
    }
  };
  const allowSet = async () => {
    await administration().sendCommand(['ACL', 'SETUSER', 'default', '+set']);
  };
  const dropFault = async () => {
    if (!owner?.isInitialized) return;
    await owner.query('DROP TRIGGER IF EXISTS dbs114_audit_fault ON audit_log');
    await owner.query('DROP FUNCTION IF EXISTS dbs114_audit_fault()');
    await owner.query('DROP SEQUENCE IF EXISTS dbs114_retry_attempts');
  };
  const closeApps = async () => {
    const errors: unknown[] = [];
    for (const app of [...apps].reverse()) {
      try {
        await app.close();
      } catch (error) {
        errors.push(error);
      }
    }
    apps.length = 0;
    tokens.clear();
    active = undefined;
    if (errors.length) throw new AggregateError(errors, 'Fixture API cleanup failed');
  };
  const restore = async () => {
    proxy?.setDelay(0);
    await startRedis();
    await allowSet();
    await dropFault();
    await closeApps();
  };
  const close = async () => {
    const errors: unknown[] = [];
    try {
      await closeApps();
    } catch (error) {
      errors.push(error);
    }
    if (admin?.isOpen) admin.destroy();
    try {
      await proxy?.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      if (owner?.isInitialized) await owner.destroy();
    } catch (error) {
      errors.push(error);
    }
    try {
      await valkey?.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await pg?.stop();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'DBS-114 fixture cleanup failed');
  };
  const startApp = async () => {
    assert.ok(proxy);
    const app = await startDepositApp(apiUrl, { revocation: { redisUrl: proxy.url } });
    apps.push(app);
    await until(() => app.app.get(RedisClient).isReady, 'Fixture API Redis client not ready');
    return app;
  };
  const send = async (
    app: App,
    token: string,
    method: string,
    path: string,
    body?: unknown,
    idem?: string,
  ): Promise<RevocationHttpResult> => {
    const response = await fetch(`${app.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(idem ? { 'Idempotency-Key': idem } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      correlationId: response.headers.get('x-correlation-id'),
    };
  };
  try {
    await assertDockerAvailable(undefined, 'DBS-114 revocation integration');
    pg = await awaitContainerStart(
      new PostgreSqlContainer('postgres:17-alpine').withStartupTimeout(STARTUP_TIMEOUT_MS).start(),
      'DBS-114 PostgreSQL startup timed out',
    );
    await migrate(pg.getConnectionUri());
    owner = await new DataSource({ type: 'postgres', url: pg.getConnectionUri() }).initialize();
    const password = randomBytes(24).toString('hex');
    await owner.query(`ALTER ROLE dbs_api LOGIN PASSWORD '${password}'`);
    const uri = new URL(pg.getConnectionUri());
    uri.username = 'dbs_api';
    uri.password = password;
    apiUrl = uri.toString();
    valkey = await startValkeyContainer();
    proxy = await startLatencyProxy(valkey.host, valkey.port);
    await openAdmin();
    const invariants = async () => {
      const runner = database().createQueryRunner();
      try {
        await runner.connect();
        const result = await checkLedgerInvariants(runner);
        assert.equal(result.status, 'PASS', JSON.stringify(result));
      } finally {
        await runner.release();
      }
    };
    const marker = async (): Promise<number | null> => {
      const [row] = await database().query<{ seconds: string | null }[]>(
        'SELECT floor(extract(epoch FROM sessions_revoked_at))::text AS seconds FROM users WHERE id=$1',
        [actor().userId],
      );
      return row.seconds === null ? null : Number(row.seconds);
    };
    return {
      get owner() {
        return database();
      },
      get admin() {
        return administration();
      },
      get proxy() {
        assert.ok(proxy);
        return proxy;
      },
      get containerIds() {
        return [pg!.getId(), valkey!.containerId];
      },
      current,
      actor,
      key,
      marker,
      restore,
      close,
      allowSet,
      startRedis,
      invariants,
      redis() {
        return current().app.get(RedisClient);
      },
      async fresh() {
        await restore();
        await administration().flushDb();
        const app = await startApp();
        active = app;
        const sub = randomUUID();
        operatorSub = randomUUID();
        const issuedAt = Math.floor(Date.now() / 1000);
        const customer = await app.issuer.token('customer', { sub, iat: issuedAt });
        const operator = await app.issuer.token('operator', { sub: operatorSub });
        tokens.set(app, { customer, operator });
        const profile = await send(app, customer, 'POST', '/v1/customers/me', {
          fullName: 'Nguyễn Minh Anh',
        });
        assert.equal(profile.status, 200);
        const account = await send(app, customer, 'POST', '/v1/accounts', { type: 'CHECKING' });
        assert.equal(account.status, 201);
        const [row] = await database().query<{ user_id: string }[]>(
          'SELECT user_id FROM customers WHERE id=$1',
          [profile.body.id],
        );
        who = { sub, userId: row.user_id, accountId: account.body.id as string, issuedAt };
        const deposit = await send(
          app,
          operator,
          'POST',
          '/v1/operator/deposits',
          { toAccountId: actor().accountId, amount: '1000000' },
          randomUUID(),
        );
        assert.equal(deposit.status, 201);
        await invariants();
      },
      async second() {
        const app = await startApp();
        tokens.set(app, {
          // Re-sign the same old session claims for this fixture's separate local JWKS key.
          customer: await app.issuer.token('customer', { sub: actor().sub, iat: actor().issuedAt }),
          operator: await app.issuer.token('operator', { sub: operatorSub }),
        });
        return app;
      },
      token(iat: number, app = current()) {
        return app.issuer.token('customer', { sub: actor().sub, iat });
      },
      async otherCustomer() {
        const app = current();
        const token = await app.issuer.token('customer', { sub: randomUUID() });
        const profile = await send(app, token, 'POST', '/v1/customers/me', {
          fullName: 'Trần Thu Hà',
        });
        assert.equal(profile.status, 200);
        assert.equal(
          (await send(app, token, 'POST', '/v1/accounts', { type: 'CHECKING' })).status,
          201,
        );
        const [row] = await database().query<{ user_id: string }[]>(
          'SELECT user_id FROM customers WHERE id=$1',
          [profile.body.id],
        );
        return { token, userId: row.user_id };
      },
      me(app = current(), token?: string) {
        return send(app, token ?? tokens.get(app)!.customer, 'GET', '/v1/accounts');
      },
      lock() {
        const app = current();
        return send(
          app,
          tokens.get(app)!.operator,
          'POST',
          `/v1/operator/accounts/${actor().accountId}/lock`,
          { reason: 'CONFIRMED_FRAUD' },
        );
      },
      unlock() {
        const app = current();
        return send(
          app,
          tokens.get(app)!.operator,
          'POST',
          `/v1/operator/accounts/${actor().accountId}/unlock`,
          { reason: 'CUSTOMER_REQUEST' },
        );
      },
      async accountStatus() {
        const [row] = await database().query('SELECT status FROM accounts WHERE id=$1', [
          actor().accountId,
        ]);
        return row.status as string;
      },
      assertRevoked(response: RevocationHttpResult) {
        assert.equal(response.status, 401, JSON.stringify(response.body));
        assert.equal(response.body.errorCode, 'SESSION_REVOKED');
        assert.match(response.correlationId ?? '', /^[0-9a-f-]{36}$/);
        assert.equal(response.body.correlationId, response.correlationId);
      },
      async waitForLock() {
        await until(
          async () =>
            (
              await database()
                .query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query ILIKE '%FROM accounts a%'`)
            ).length > 0,
          'Operator lock did not reach the held row',
        );
      },
      async stopRedis() {
        assert.ok(valkey);
        if (admin?.isOpen) admin.destroy();
        await docker('docker', ['stop', '-t', '0', valkey.containerId], {
          windowsHide: true,
          timeout: 20000,
        });
        stopped = true;
      },
      async seedOlderRevocation() {
        // SQL INPUT auth state for the stale-cache adversarial test, never financial seed.
        const seconds = Math.floor(Date.now() / 1000) - 60;
        await database().query(
          'UPDATE users SET sessions_revoked_at=to_timestamp($2) WHERE id=$1',
          [actor().userId, seconds],
        );
        await administration().set(key(), String(seconds), { EX: 900 });
      },
      async denySet() {
        await administration().sendCommand(['ACL', 'SETUSER', 'default', '-set']);
      },
      async installAuditFault(mode: 'rollback' | 'retry') {
        await dropFault();
        if (mode === 'retry') {
          await database().query('CREATE SEQUENCE dbs114_retry_attempts');
          await database().query(
            'GRANT USAGE, SELECT ON SEQUENCE dbs114_retry_attempts TO dbs_api',
          );
        }
        const fault =
          mode === 'retry'
            ? `IF nextval('dbs114_retry_attempts')=1 THEN RAISE EXCEPTION 'fixture retry' USING ERRCODE='40001'; END IF;`
            : `RAISE EXCEPTION 'fixture rollback' USING ERRCODE='23514';`;
        await database()
          .query(`CREATE FUNCTION dbs114_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.action='account.lock' THEN ${fault} END IF; RETURN NEW; END $$`);
        await database().query(
          'CREATE TRIGGER dbs114_audit_fault BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs114_audit_fault()',
        );
      },
      async attempts() {
        const [row] = await database().query(
          'SELECT last_value::int AS n FROM dbs114_retry_attempts',
        );
        return row.n as number;
      },
      async effects() {
        const [row] = await database().query<{ audit: number; events: number }[]>(
          `SELECT
        (SELECT count(*)::int FROM audit_log WHERE target_id=$1 AND action='account.lock') AS audit,
        (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1::uuid AND event_type='AccountStatusChanged') AS events`,
          [actor().accountId],
        );
        return row;
      },
      async ready() {
        await withTimeout(startRedis(), 15000, 'Valkey recovery deadline');
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'DBS-114 setup and cleanup failed');
    }
    throw error;
  }
}
export type SessionRevocationFixture = Awaited<ReturnType<typeof createSessionRevocationFixture>>;
