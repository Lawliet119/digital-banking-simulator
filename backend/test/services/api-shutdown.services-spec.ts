import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  buildAppImage,
  forContainer,
  removeImage,
  startApp,
  type AppEnvironment,
  type StartedApp,
} from '../support/app-container';
import { seedDepositTarget } from '../support/deposit-app';
import { createDevTokenIssuer, type DevTokenIssuer } from '../support/dev-tokens';
import { checkLedgerInvariants } from '../support/invariants';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';

/** `docker stop -t`: SIGKILL comes this long after SIGTERM. The api's ECS default is 30 s. */
const GRACE_SECONDS = 30;
/** Time given to the process to act on SIGTERM before the test looks at what it did. */
const AFTER_SIGTERM_MS = 1_500;
const JWKS_IN_CONTAINER = '/tmp/jwks.json';

interface Answer {
  status: number;
  body: string;
}

function send(
  url: string,
  options: {
    token?: string;
    body?: unknown;
    agent?: Agent;
    timeoutMs?: number;
  } = {},
): { done: Promise<Answer>; abort: () => void } {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const call = request(url, {
    method: payload === undefined ? 'GET' : 'POST',
    agent: options.agent ?? false,
    timeout: options.timeoutMs ?? 25_000,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(payload === undefined
        ? {}
        : {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'idempotency-key': randomUUID(),
          }),
    },
  });
  const done = new Promise<Answer>((resolve, reject) => {
    call.on('response', res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    call.on('timeout', () => call.destroy(new Error('TIMEOUT')));
    call.on('error', reject);
  });
  call.end(payload);
  return { done, abort: () => call.destroy() };
}

/**
 * BL-381 (UI plan, stage C): SIGTERM while a transfer is inside its database transaction. The real
 * production image runs as `api`; the transaction is held open by locking the source account from
 * another connection.
 */
describe('BL-381 the api finishes the running transfer before it exits (production image)', () => {
  let image: string;
  let db: TempDatabase;
  let valkey: StartedValkey;
  let issuer: DevTokenIssuer;
  let keys: string;
  let env: AppEnvironment;
  const started: StartedApp[] = [];

  beforeAll(async () => {
    valkey = await startValkeyContainer();
    db = await createTempDatabase();
    await migrate(db.url);
    image = await buildAppImage();
    issuer = await createDevTokenIssuer();
    keys = mkdtempSync(join(tmpdir(), 'dbs-jwks-'));
    writeFileSync(join(keys, 'jwks.json'), JSON.stringify(issuer.jwks), { mode: 0o644 });
    env = {
      databaseUrl: forContainer(db.url),
      redisUrl: forContainer(valkey.url),
      // The api role never calls the queue.
      sqsEndpoint: 'http://127.0.0.1:9324',
      riskQueueUrl: 'http://127.0.0.1:9324/000000000000/risk-events',
      notificationQueueUrl: 'http://127.0.0.1:9324/000000000000/notification-events',
    };
  });

  afterEach(async () => {
    expect((await checkLedgerInvariants(db.runner)).status).toBe('PASS');
  });

  afterAll(async () => {
    await Promise.all(started.map(app => app.remove()));
    if (image) await removeImage(image);
    if (keys) rmSync(keys, { recursive: true, force: true });
    await db?.drop();
    await valkey?.stop();
  });

  async function startApi(vars: Record<string, string> = {}) {
    const api = await startApp(image, 'api', env, {
      publish: true,
      mounts: [[join(keys, 'jwks.json'), JWKS_IN_CONTAINER]],
      vars: {
        AUTH_MODE: 'local',
        AUTH_LOCAL_JWKS_PATH: JWKS_IN_CONTAINER,
        COGNITO_USER_POOL_ID: undefined,
        COGNITO_CLIENT_ID: undefined,
        COGNITO_ISSUER: undefined,
        // The test holds a row lock longer than the default 2 s lock wait.
        DATABASE_LOCK_TIMEOUT_MS: '15000',
        DATABASE_STATEMENT_TIMEOUT_MS: '20000',
        DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '30000',
        ...vars,
      },
    });
    started.push(api);
    await api.ready(/HTTP listener started/);
    return { api, url: await api.url() };
  }

  /** Two customers, the first one funded through the real deposit endpoint. */
  async function fundedPair(url: string) {
    const from = await seedDepositTarget(db.runner);
    const to = await seedDepositTarget(db.runner);
    const operator = await issuer.token('operator', { sub: randomUUID() });
    const deposit = await send(`${url}/v1/operator/deposits`, {
      token: operator,
      body: { toAccountId: from.accountId, amount: '100000' },
    }).done;
    expect(deposit.status).toBe(201);
    return { from, to, token: await issuer.token('customer', { sub: from.sub }) };
  }

  /** Locks the account row until the returned function is called. */
  async function holdRow(accountId: string): Promise<() => Promise<void>> {
    await db.runner.query('BEGIN');
    await db.runner.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await db.runner.query('ROLLBACK');
    };
  }

  /** Resolves once a session of this database waits for a lock: the transfer is mid-transaction. */
  async function transferIsWaiting(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      // pg_stat_activity is a snapshot per transaction; the holding connection must refresh it.
      await db.runner.query('SELECT pg_stat_clear_snapshot()');
      const [{ waiting }] = await db.runner.query(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (waiting > 0) return;
      if (Date.now() > deadline) throw new Error('the transfer never reached the row lock');
      await wait(100);
    }
  }

  async function balanceOf(accountId: string): Promise<string> {
    const rows = (await db.runner.query(
      'SELECT balance::text AS balance FROM accounts WHERE id = $1',
      [accountId],
    )) as { balance: string }[];
    return rows[0].balance;
  }

  it('TC-C-01 SIGTERM mid-transfer: the client gets 201, new connections are refused, exit 0', async () => {
    const { api, url } = await startApi();
    const { from, to, token } = await fundedPair(url);
    const agent = new Agent({ keepAlive: true }); // the ALB keeps its connections open
    const release = await holdRow(from.accountId);
    try {
      const transfer = send(`${url}/v1/transfers`, {
        token,
        agent,
        body: { fromAccountId: from.accountId, toAccountId: to.accountId, amount: '40000' },
      });
      const answer = transfer.done.catch((error: Error) => ({ status: 0, body: error.message }));
      await transferIsWaiting();

      const stopping = api.stop(GRACE_SECONDS);
      await wait(AFTER_SIGTERM_MS);
      // Refused at once, not queued behind the transfer.
      await expect(send(`${url}/health/live`, { timeoutMs: 3_000 }).done).rejects.not.toThrow(
        'TIMEOUT',
      );

      await release();
      const releasedAt = Date.now();
      expect(await answer).toMatchObject({ status: 201 });
      expect((await stopping).exitCode).toBe(0);
      // It must not sit on the idle keep-alive connection until SIGKILL.
      expect(Date.now() - releasedAt).toBeLessThan(10_000);
      expect(await balanceOf(to.accountId)).toBe('40000');
    } finally {
      await release();
      agent.destroy();
    }
  });

  it('TC-C-02 the caller hangs up, then SIGTERM: the transfer still commits before the exit', async () => {
    const { api, url } = await startApi();
    const { from, to, token } = await fundedPair(url);
    const release = await holdRow(from.accountId);
    try {
      const transfer = send(`${url}/v1/transfers`, {
        token,
        body: { fromAccountId: from.accountId, toAccountId: to.accountId, amount: '40000' },
      });
      transfer.done.catch(() => undefined);
      await transferIsWaiting();
      transfer.abort(); // what a load balancer does when it drops a deregistered target

      const stopping = api.stop(GRACE_SECONDS);
      await wait(AFTER_SIGTERM_MS);
      await release();

      expect((await stopping).exitCode).toBe(0);
      expect(await balanceOf(to.accountId)).toBe('40000');
      expect(await api.logs()).not.toContain('Unhandled exception');
    } finally {
      await release();
    }
  });

  it('TC-C-03 a transfer that never finishes does not hold the exit past the drain limit', async () => {
    const { api, url } = await startApi({ HTTP_DRAIN_TIMEOUT_MS: '3000' });
    const { from, to, token } = await fundedPair(url);
    const release = await holdRow(from.accountId);
    try {
      const transfer = send(`${url}/v1/transfers`, {
        token,
        body: { fromAccountId: from.accountId, toAccountId: to.accountId, amount: '40000' },
      });
      transfer.done.catch(() => undefined);
      await transferIsWaiting();

      const { exitCode, elapsedMs } = await api.stop(GRACE_SECONDS);

      expect(exitCode).toBe(0); // it left by itself, not by SIGKILL
      expect(elapsedMs).toBeGreaterThanOrEqual(3_000);
      expect(elapsedMs).toBeLessThan(12_000);
    } finally {
      await release();
    }
    expect(await balanceOf(to.accountId)).toBe('0');
    expect(await balanceOf(from.accountId)).toBe('100000');
  });
});
