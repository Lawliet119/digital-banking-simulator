import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { PinoLogger } from 'nestjs-pino';
import { InvalidEventError, type DomainEvent } from '@common/events';
import { TransactionService } from '@database/transaction.service';
import { OutboxWriter } from '@modules/outbox';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { VALID_SAMPLES, TRANSFER_SAMPLE, DEPOSIT_SAMPLE } from '../support/event-samples';

describe('DBS-57 outbox writer in the caller transaction (real PostgreSQL)', () => {
  let db: TempDatabase;
  let source: DataSource;
  let tx: TransactionService;
  let writer: OutboxWriter;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    tx = new TransactionService(source, {
      url: db.url,
      poolMax: 10,
      ssl: false,
      sslCaPath: undefined,
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    });
    writer = new OutboxWriter(new PinoLogger({ pinoHttp: { level: 'silent' } }));
  });

  afterAll(async () => {
    if (source?.isInitialized) await source.destroy();
    await db?.drop();
  });

  const event = (sample: DomainEvent = TRANSFER_SAMPLE): DomainEvent => ({
    ...sample,
    eventId: randomUUID(),
  });
  const rows = (eventId: string) =>
    source.query<
      {
        event_id: string;
        event_type: string;
        aggregate_id: string;
        payload: DomainEvent;
        correlation_id: string;
        published_at: null;
      }[]
    >('SELECT * FROM outbox_events WHERE event_id=$1', [eventId]);
  const seedUser = (manager: EntityManager, sub: string) =>
    manager.query('INSERT INTO users(cognito_sub) VALUES($1)', [sub]);
  const users = (sub: string) =>
    source.query<{ id: string }[]>('SELECT id FROM users WHERE cognito_sub=$1', [sub]);

  it.each(Object.entries(VALID_SAMPLES))(
    'TC-57-01 commits one complete %s envelope',
    async (_, sample) => {
      const input = event(sample);
      await tx.run(manager => writer.add(manager, input));
      expect(await rows(input.eventId)).toEqual([
        expect.objectContaining({
          event_id: input.eventId,
          event_type: input.eventType,
          aggregate_id:
            input.eventType === 'TransferCompleted' ? input.transferId : input.accountId,
          payload: input,
          correlation_id: input.correlationId,
          published_at: null,
        }),
      ]);
    },
  );

  it('TC-57-02 rolls back the outbox and an earlier non-money row when the caller fails', async () => {
    const input = event();
    const sub = randomUUID();
    const failure = new Error('Caller operation failed');
    await expect(
      tx.run(async manager => {
        await seedUser(manager, sub);
        await writer.add(manager, input);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await rows(input.eventId)).toEqual([]);
    expect(await users(sub)).toEqual([]);
  });

  const invalid: {
    label: string;
    mutate: (input: DomainEvent) => unknown;
    path: string;
    code: string;
  }[] = [
    { label: 'non-object', mutate: () => [], path: '', code: 'NOT_AN_OBJECT' },
    {
      label: 'unknown event',
      mutate: input => ({ ...input, eventType: 'Unsupported' }),
      path: 'eventType',
      code: 'UNKNOWN_EVENT_TYPE',
    },
    {
      label: 'missing amount',
      mutate: input => ({ ...input, amount: undefined }),
      path: 'amount',
      code: 'MISSING_FIELD',
    },
    {
      label: 'numeric money',
      mutate: input => ({ ...input, amount: 500000 }),
      path: 'amount',
      code: 'WRONG_TYPE',
    },
    {
      label: 'invalid UUID',
      mutate: input => ({ ...input, eventId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' }),
      path: 'eventId',
      code: 'INVALID_FORMAT',
    },
    {
      label: 'lock reason',
      mutate: () => ({ ...VALID_SAMPLES.ACCOUNT_LOCKED, reason: 'private reason' }),
      path: 'reason',
      code: 'NOT_ALLOWED',
    },
  ];

  it.each(invalid)(
    'TC-57-03/10 refuses $label before SQL and rolls back the caller',
    async ({ mutate, path, code }) => {
      const input = event();
      const sub = randomUUID();
      await expect(
        tx.run(async manager => {
          await seedUser(manager, sub);
          const query = jest.spyOn(manager, 'query');
          try {
            await writer.add(manager, mutate(input) as DomainEvent);
          } finally {
            expect(query).not.toHaveBeenCalled();
            query.mockRestore();
          }
        }),
      ).rejects.toMatchObject({
        name: 'InvalidEventError',
        issues: expect.arrayContaining([expect.objectContaining({ path, code })]),
      });
      expect(await rows(input.eventId)).toEqual([]);
      expect(await users(sub)).toEqual([]);
    },
  );

  it('TC-57-08 propagates duplicate 23505, keeps the committed row and rolls back new work', async () => {
    const input = event();
    await tx.run(manager => writer.add(manager, input));
    const sub = randomUUID();
    await expect(
      tx.run(async manager => {
        await seedUser(manager, sub);
        await writer.add(manager, input);
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'outbox_events_event_id_key' });
    expect(await rows(input.eventId)).toHaveLength(1);
    expect(await users(sub)).toEqual([]);
    const next = { ...input, eventId: randomUUID() };
    await tx.run(manager => writer.add(manager, next));
    expect(await rows(next.eventId)).toHaveLength(1);
  });

  it('TC-57-09 refuses managers without a live transaction before SQL or autocommit', async () => {
    const input = event();
    const managerQuery = jest.spyOn(source.manager, 'query');
    await expect(writer.add(source.manager, input)).rejects.toBeInstanceOf(Error);
    expect(managerQuery).not.toHaveBeenCalled();
    managerQuery.mockRestore();
    const runner = source.createQueryRunner();
    await runner.connect();
    try {
      await expect(writer.add(runner.manager, input)).rejects.toBeInstanceOf(Error);
      await runner.startTransaction();
      await runner.commitTransaction();
      await expect(writer.add(runner.manager, input)).rejects.toBeInstanceOf(Error);
    } finally {
      await runner.release();
    }
    await expect(writer.add(runner.manager, input)).rejects.toBeInstanceOf(Error);
    expect(await rows(input.eventId)).toEqual([]);
  });

  it('TC-57-10 preserves money above 2^53 and a negative SYSTEM snapshot as strings', async () => {
    const input = {
      ...event(DEPOSIT_SAMPLE),
      amount: '9007199254740993',
      fromBalanceBefore: '-9007199254740993',
    } as DomainEvent;
    await tx.run(manager => writer.add(manager, input));
    expect((await rows(input.eventId))[0].payload).toEqual(input);
  });

  it('TC-57-11 snapshots JSON before awaiting, preserves extensions and does not mutate input', async () => {
    const input = { ...event(), extension: { version: 2, note: 'Ngân hàng số' } };
    const expected = structuredClone(input);
    await tx.run(async manager => {
      const pending = writer.add(manager, input);
      input.extension.note = 'changed after add';
      await pending;
    });
    expect((await rows(input.eventId))[0].payload).toEqual(expected);
    expect(input.extension.note).toBe('changed after add');
  });

  it('TC-57-11 rolls back serialization failures, including the caller row', async () => {
    const input: DomainEvent & { cycle?: unknown } = event();
    input.cycle = input;
    const sub = randomUUID();
    await expect(
      tx.run(async manager => {
        await seedUser(manager, sub);
        await writer.add(manager, input);
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await users(sub)).toEqual([]);
    expect(await rows(input.eventId)).toEqual([]);
  });

  it('TC-57-11 validates the serialized envelope, not only the raw object', async () => {
    const input = { ...event(), toJSON: () => ({ eventType: 'TransferCompleted' }) };
    await expect(tx.run(manager => writer.add(manager, input))).rejects.toBeInstanceOf(
      InvalidEventError,
    );
    expect(await rows(input.eventId)).toEqual([]);
  });

  it('TC-57-12 uses one parameterized INSERT and keeps hostile extension text as data', async () => {
    const input = { ...event(), extension: "'; DROP TABLE users; --" };
    await tx.run(async manager => {
      const query = jest.spyOn(manager, 'query');
      try {
        await writer.add(manager, input);
        expect(query).toHaveBeenCalledTimes(1);
        const [sql, parameters] = query.mock.calls[0];
        expect(sql).toMatch(/^\s*INSERT INTO outbox_events/i);
        expect(sql).not.toContain(input.extension);
        expect(parameters).toHaveLength(5);
        expect(parameters?.[3]).toBe(JSON.stringify(input));
      } finally {
        query.mockRestore();
      }
    });
    expect((await rows(input.eventId))[0].payload).toEqual(input);
    expect(await source.query("SELECT to_regclass('public.users') AS relation")).toEqual([
      { relation: 'users' },
    ]);
  });
});
