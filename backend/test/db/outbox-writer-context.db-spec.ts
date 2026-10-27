import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { PinoLogger } from 'nestjs-pino';
import { type DomainEvent, InvalidEventError } from '@common/events';
import { TransactionService } from '@database/transaction.service';
import { OutboxWriter } from '@modules/outbox';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { TRANSFER_SAMPLE } from '../support/event-samples';

describe('DBS-57 existing Pino ALS and real HTTP/PG propagation', () => {
  const originalEnv = process.env;
  let db: TempDatabase;
  let app: NestExpressApplication;
  let source: DataSource;
  let writer: OutboxWriter;
  let tx: TransactionService;
  let logger: PinoLogger;
  let probe: typeof import('../support/outbox-writer-probe');

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      APP_ROLE: 'both',
      DATABASE_URL: db.url,
      DATABASE_POOL_MAX: '15',
      REDIS_URL: 'redis://127.0.0.1:6379',
      SQS_RISK_QUEUE_URL: 'http://127.0.0.1:9324/000000000000/risk-events',
      SQS_NOTIFICATION_QUEUE_URL: 'http://127.0.0.1:9324/000000000000/notification-events',
      LOG_LEVEL: 'fatal',
    };
    probe = await import('../support/outbox-writer-probe');
    app = await probe.createOutboxProbe();
    await app.listen(0, '127.0.0.1');
    source = app.get(DataSource);
    writer = app.get(OutboxWriter);
    tx = app.get(TransactionService);
    logger = await app.resolve(PinoLogger);
  });

  afterAll(async () => {
    await app?.close();
    process.env = originalEnv;
    await db?.drop();
  });

  const event = (): DomainEvent => ({ ...TRANSFER_SAMPLE, eventId: randomUUID() });
  const rows = (eventId: string) =>
    source.query<{ correlation_id: string; payload: DomainEvent }[]>(
      'SELECT correlation_id,payload FROM outbox_events WHERE event_id=$1',
      [eventId],
    );

  it.each([
    { value: undefined, code: 'MISSING_FIELD' },
    { value: 42, code: 'WRONG_TYPE' },
    { value: 'invalid-correlation', code: 'INVALID_FORMAT' },
  ])(
    'TC-57-04 refuses invalid raw correlation $code even with a good ALS id',
    async ({ value, code }) => {
      for (const withContext of [false, true]) {
        const input = { ...event(), correlationId: value } as unknown as DomainEvent;
        const write = () => tx.run(manager => writer.add(manager, input));
        const pending = withContext
          ? logger.runInContext(write, { bindings: { correlationId: randomUUID() } })
          : write();
        await expect(pending).rejects.toMatchObject({
          name: 'InvalidEventError',
          issues: expect.arrayContaining([
            expect.objectContaining({ path: 'correlationId', code }),
          ]),
        });
        expect(await rows(input.eventId)).toEqual([]);
      }
    },
  );

  it('TC-57-05 uses the server HTTP id for the envelope, column and header', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/outbox-probe/events')
      .set('X-Correlation-Id', randomUUID())
      .set('X-Request-Id', randomUUID())
      .send({})
      .expect(201);
    const id = response.headers['x-correlation-id'];
    expect(response.body.correlationId).toBe(id);
    expect(await rows(response.body.eventId)).toEqual([
      expect.objectContaining({
        correlation_id: id,
        payload: expect.objectContaining({ correlationId: id }),
      }),
    ]);
  });

  it('TC-57-06 isolates ten parallel requests that cross a real producer barrier', async () => {
    app.get(probe.ProbeGate).arm(10);
    const eventIds = Array.from({ length: 10 }, () => randomUUID());
    const responses = await Promise.all(
      eventIds.map(eventId =>
        request(app.getHttpServer()).post('/v1/outbox-probe/events').send({ eventId }).expect(201),
      ),
    );
    expect(new Set(responses.map(response => response.headers['x-correlation-id'])).size).toBe(10);
    for (const [i, response] of responses.entries()) {
      const id = response.headers['x-correlation-id'];
      expect(response.body).toEqual({ eventId: eventIds[i], correlationId: id });
      expect(await rows(eventIds[i])).toEqual([
        expect.objectContaining({
          correlation_id: id,
          payload: expect.objectContaining({ correlationId: id }),
        }),
      ]);
    }
  });

  it.each([undefined, null])(
    'TC-57-07 uses the valid event id when context is %s',
    async correlationId => {
      const input = event();
      const write = () => tx.run(manager => writer.add(manager, input));
      await logger.runInContext(write, { bindings: { correlationId } });
      expect((await rows(input.eventId))[0].correlation_id).toBe(input.correlationId);
    },
  );

  it('TC-57-07 accepts a matching context and refuses a different valid context', async () => {
    const input = event();
    await logger.runInContext(() => tx.run(manager => writer.add(manager, input)), {
      bindings: { correlationId: input.correlationId },
    });
    expect((await rows(input.eventId))[0].correlation_id).toBe(input.correlationId);
    const mismatch = event();
    await expect(
      logger.runInContext(() => tx.run(manager => writer.add(manager, mismatch)), {
        bindings: { correlationId: randomUUID() },
      }),
    ).rejects.toMatchObject({
      name: 'InvalidEventError',
      issues: [
        expect.objectContaining({
          path: 'correlationId',
          code: 'NOT_ALLOWED',
        }),
      ],
    });
    expect(await rows(mismatch.eventId)).toEqual([]);
  });

  it.each([42, '', 'invalid-context', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'])(
    'TC-57-07 refuses malformed ALS binding %s without fallback',
    async correlationId => {
      const input = event();
      await expect(
        logger.runInContext(() => tx.run(manager => writer.add(manager, input)), {
          bindings: { correlationId },
        }),
      ).rejects.toMatchObject({
        name: InvalidEventError.name,
        issues: [
          expect.objectContaining({
            path: 'correlationId',
            code: 'INVALID_FORMAT',
          }),
        ],
      });
      expect(await rows(input.eventId)).toEqual([]);
    },
  );
});
