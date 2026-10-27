import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { DomainEvent } from '@common/events';
import type { TempDatabase } from '../support/temp-database';

const runtimeKeys =
  /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|HOME|COMSPEC|PATHEXT|DOCKER_.+|TESTCONTAINERS_.+)$/i;

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'commit';
  const role = process.argv.find(arg => arg.startsWith('--role='))?.slice(7) ?? 'both';
  assert.ok(
    ['commit', 'rollback', 'invalid', 'duplicate', 'context', 'transaction'].includes(mode),
  );
  assert.ok(['api', 'worker', 'both'].includes(role));
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let baseUrl = originalEnv.DATABASE_URL;
  const sandbox = mkdtempSync(join(tmpdir(), 'dbs57-manual-'));
  let app: NestExpressApplication | undefined;
  let temp: TempDatabase | undefined;
  let ownsContainer = false;
  let stopContainer: (() => Promise<void>) | undefined;
  let failure: Error | undefined;
  let result: Record<string, unknown> = {};
  const cleanup = { databaseDropped: false, ownContainerStopped: false, cwdRestored: false };

  // This entrypoint deliberately imports no project runtime until configuration is isolated.
  process.env = {
    ...Object.fromEntries(Object.entries(originalEnv).filter(([key]) => runtimeKeys.test(key))),
    NODE_ENV: 'test',
    APP_ROLE: role,
    DATABASE_SSL: 'false',
    DATABASE_POOL_MAX: '15',
    REDIS_URL: 'redis://127.0.0.1:6379',
    SQS_RISK_QUEUE_URL: 'http://127.0.0.1:9324/000000000000/risk-events',
    SQS_NOTIFICATION_QUEUE_URL: 'http://127.0.0.1:9324/000000000000/notification-events',
    LOG_LEVEL: 'fatal',
  };
  process.chdir(sandbox);

  try {
    const postgres = await import('../support/postgres.container');
    stopContainer = postgres.stopPostgresContainer;
    if (!baseUrl) {
      baseUrl = (await postgres.startPostgresContainer()).databaseUrl;
      ownsContainer = true;
    }
    process.env.DATABASE_URL = baseUrl;
    const harness = await import('../support/temp-database');
    temp = await harness.createTempDatabase();
    await harness.migrate(temp.url);
    process.env.DATABASE_URL = temp.url;
    const [probe, outbox, database, orm, pino, events, samples] = await Promise.all([
      import('../support/outbox-writer-probe'),
      import('@modules/outbox'),
      import('@database/transaction.service'),
      import('typeorm'),
      import('nestjs-pino'),
      import('@common/events'),
      import('../support/event-samples'),
    ]);
    app = await probe.createOutboxProbe();
    const source = app.get(orm.DataSource);
    const writer = app.get(outbox.OutboxWriter);
    const tx = app.get(database.TransactionService);
    const logger = await app.resolve(pino.PinoLogger);
    const event = (sample: DomainEvent = samples.TRANSFER_SAMPLE): DomainEvent => ({
      ...sample,
      eventId: randomUUID(),
    });
    const rows = (id: string) =>
      source.query<
        {
          event_id: string;
          aggregate_id: string;
          payload: DomainEvent;
          correlation_id: string;
          published_at: null;
        }[]
      >('SELECT * FROM outbox_events WHERE event_id=$1', [id]);
    const users = (sub: string) =>
      source.query<{ id: string }[]>('SELECT id FROM users WHERE cognito_sub=$1', [sub]);

    if (mode === 'commit') {
      const input = {
        ...samples.DEPOSIT_SAMPLE,
        eventId: randomUUID(),
        amount: '9007199254740993',
        fromBalanceBefore: '-9007199254740993',
        extension: { channel: 'chi nhánh Hà Nội' },
      };
      await tx.run(manager => writer.add(manager, input));
      const persisted = await rows(input.eventId);
      assert.equal(persisted.length, 1);
      assert.deepEqual(persisted[0].payload, input);
      assert.equal(persisted[0].correlation_id, input.correlationId);
      assert.equal(persisted[0].published_at, null);
      result = {
        eventId: input.eventId,
        correlationId: input.correlationId,
        outboxRows: persisted.length,
        amount: '9007199254740993',
      };
    } else if (mode === 'rollback') {
      const input = event();
      const sub = randomUUID();
      const sentinel = new Error('Caller operation failed');
      await assert.rejects(
        tx.run(async manager => {
          await manager.query('INSERT INTO users(cognito_sub) VALUES($1)', [sub]);
          await writer.add(manager, input);
          throw sentinel;
        }),
        error => error === sentinel,
      );
      assert.equal((await rows(input.eventId)).length, 0);
      assert.equal((await users(sub)).length, 0);
      result = { eventId: input.eventId, userRows: 0, outboxRows: 0 };
    } else if (mode === 'invalid') {
      const cases = ['missing-correlation', 'numeric-money', 'cycle'] as const;
      for (const invalidCase of cases) {
        const input = { ...event() } as DomainEvent & { cycle?: unknown };
        if (invalidCase === 'missing-correlation')
          delete (input as Partial<DomainEvent>).correlationId;
        if (invalidCase === 'numeric-money') Object.assign(input, { amount: 500000 });
        if (invalidCase === 'cycle') input.cycle = input;
        const sub = randomUUID();
        await assert.rejects(
          logger.runInContext(
            () =>
              tx.run(async manager => {
                await manager.query('INSERT INTO users(cognito_sub) VALUES($1)', [sub]);
                await writer.add(manager, input);
              }),
            { bindings: { correlationId: samples.TRANSFER_SAMPLE.correlationId } },
          ),
          error => {
            if (invalidCase === 'cycle') return error instanceof TypeError;
            const code = invalidCase === 'missing-correlation' ? 'MISSING_FIELD' : 'WRONG_TYPE';
            return (
              error instanceof events.InvalidEventError &&
              error.issues.some(issue => issue.code === code)
            );
          },
        );
        assert.equal((await rows(input.eventId)).length, 0);
        assert.equal((await users(sub)).length, 0);
      }
      result = { refused: cases, userRows: 0, outboxRows: 0 };
    } else if (mode === 'duplicate') {
      const input = event();
      await tx.run(manager => writer.add(manager, input));
      const sub = randomUUID();
      await assert.rejects(
        tx.run(async manager => {
          await manager.query('INSERT INTO users(cognito_sub) VALUES($1)', [sub]);
          await writer.add(manager, input);
        }),
        { code: '23505', constraint: 'outbox_events_event_id_key' },
      );
      assert.equal((await users(sub)).length, 0);
      assert.deepEqual((await rows(input.eventId))[0].payload, input);
      const recovered = { ...input, eventId: randomUUID() };
      await tx.run(manager => writer.add(manager, recovered));
      assert.equal((await rows(recovered.eventId)).length, 1);
      result = {
        eventId: input.eventId,
        duplicate: '23505',
        constraint: 'outbox_events_event_id_key',
        originalRows: 1,
        recoveredRows: 1,
      };
    } else if (mode === 'context') {
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address() as AddressInfo;
      app.get(probe.ProbeGate).arm(10);
      const ids = Array.from({ length: 10 }, () => randomUUID());
      const correlations = await Promise.all(
        ids.map(async eventId => {
          const response = await fetch(`http://127.0.0.1:${address.port}/v1/outbox-probe/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': randomUUID() },
            body: JSON.stringify({ eventId }),
            signal: AbortSignal.timeout(12000),
          });
          assert.equal(response.status, 201);
          const body = (await response.json()) as { eventId: string; correlationId: string };
          const correlationId = response.headers.get('x-correlation-id');
          assert.equal(body.eventId, eventId);
          assert.equal(body.correlationId, correlationId);
          const persisted = await rows(eventId);
          assert.equal(persisted.length, 1);
          assert.equal(persisted[0].correlation_id, correlationId);
          assert.equal(persisted[0].payload.correlationId, correlationId);
          return correlationId;
        }),
      );
      assert.equal(new Set(correlations).size, 10);
      for (const [correlationId, code] of [
        [randomUUID(), 'NOT_ALLOWED'],
        ['invalid-context', 'INVALID_FORMAT'],
      ] as const) {
        const input = event();
        await assert.rejects(
          logger.runInContext(() => tx.run(manager => writer.add(manager, input)), {
            bindings: { correlationId },
          }),
          error =>
            error instanceof events.InvalidEventError &&
            error.issues.some(issue => issue.code === code),
        );
        assert.equal((await rows(input.eventId)).length, 0);
      }
      const outside = event();
      await tx.run(manager => writer.add(manager, outside));
      assert.equal((await rows(outside.eventId))[0].correlation_id, outside.correlationId);
      result = {
        httpRows: 10,
        distinctCorrelationIds: correlations,
        mismatch: 'NOT_ALLOWED',
        malformed: 'INVALID_FORMAT',
        outsideContextRows: 1,
      };
    } else {
      const input = event();
      await assert.rejects(writer.add(source.manager, input), { name: 'Error' });
      const runner = source.createQueryRunner();
      await runner.connect();
      try {
        await assert.rejects(writer.add(runner.manager, input), { name: 'Error' });
        await runner.startTransaction();
        await runner.commitTransaction();
        await assert.rejects(writer.add(runner.manager, input), { name: 'Error' });
      } finally {
        await runner.release();
      }
      await assert.rejects(writer.add(runner.manager, input), { name: 'Error' });
      assert.equal((await rows(input.eventId)).length, 0);
      result = { refusedManagers: 4, outboxRows: 0 };
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error('Manual driver failed');
  } finally {
    const finish = async (action: () => Promise<void> | void): Promise<void> => {
      try {
        await action();
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error('Manual cleanup failed');
      }
    };
    await finish(async () => {
      await app?.close();
    });
    if (baseUrl) process.env.DATABASE_URL = baseUrl;
    const tempToDrop = temp;
    if (tempToDrop)
      await finish(async () => {
        await tempToDrop.drop();
        cleanup.databaseDropped = true;
      });
    const ownedStop = stopContainer;
    if (ownsContainer && ownedStop)
      await finish(async () => {
        await ownedStop();
        cleanup.ownContainerStopped = true;
      });
    process.env = originalEnv;
    await finish(() => {
      process.chdir(originalCwd);
      cleanup.cwdRestored = true;
    });
    // Only remove our known-empty cwd. Unexpected files are left intact and fail the driver.
    await finish(() => {
      rmdirSync(sandbox);
    });
  }
  if (failure) throw failure;
  process.stdout.write(`${JSON.stringify({ mode, role, pass: true, ...result, cleanup })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ pass: false, errorType: error instanceof Error ? error.name : 'UnknownError' })}\n`,
  );
  process.exitCode = 1;
});
