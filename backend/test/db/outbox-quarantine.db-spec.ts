import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import type { MetricsService } from '@common/metrics';
import type { SqsClient } from '@libs/sqs';
import { OutboxCleanupService } from '@modules/outbox/outbox-cleanup.service';
import { OUTBOX_AGE_SQL, OutboxAgeGauge } from '@modules/outbox/outbox-age.gauge';
import {
  OUTBOX_QUARANTINED_METRIC,
  OUTBOX_QUARANTINED_SQL,
  OutboxQuarantineGauge,
} from '@modules/outbox/outbox-quarantine.gauge';
import {
  OutboxRelayService,
  QueueNotConfiguredError,
  RELAY_QUARANTINE_AFTER_ATTEMPTS,
} from '@modules/outbox/outbox-relay.service';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { clearOutbox } from '../support/outbox-fixtures';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { QuarantineOutboxEvents1795000009000 } from '@database/migrations/1795000009000-QuarantineOutboxEvents';

type Send = SqsClient['send'];
const sqsError = (status: number, name = 'InvalidParameterValue') =>
  Object.assign(new Error('MessageBody secret-payload-text is not valid'), {
    name,
    $metadata: { httpStatusCode: status },
  });

/**
 * BL-181: an outbox event that can never be sent is quarantined in its own row (attempts, last
 * attempt, error code, quarantine time) and the relay skips it for good, on real PostgreSQL.
 */
describe('outbox quarantine of permanently failing events (real PostgreSQL)', () => {
  let db: TempDatabase;
  let source: DataSource;
  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> =>
    db.runner.query(sql, args) as Promise<T[]>;
  const tx = () =>
    new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);

  /** A NEW relay on every call: the in-memory park of the previous one is gone, like after a restart. */
  const relayWith = (send: Send, riskQueueUrl: string | null = 'http://queue/risk') =>
    new OutboxRelayService(tx(), { send } as unknown as SqsClient, {
      region: 'us-east-1',
      endpoint: undefined,
      riskQueueUrl: riskQueueUrl ?? undefined,
      notificationQueueUrl: 'http://queue/notification',
    });

  async function enqueue(): Promise<{ id: string; eventId: string }> {
    const eventId = randomUUID();
    const event = { ...TRANSFER_SAMPLE, eventId };
    const [row] = await q<{ id: string }>(
      `INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id)
       VALUES($1,'TransferCompleted',$2,$3::jsonb,$4) RETURNING id`,
      [eventId, randomUUID(), JSON.stringify(event), event.correlationId],
    );
    return { id: row.id, eventId };
  }
  const row = async (eventId: string) =>
    (
      await q<{
        attempts: number;
        last_attempt_at: Date | null;
        last_error_code: string | null;
        quarantined_at: Date | null;
        published_at: Date | null;
      }>(
        `SELECT attempts,last_attempt_at,last_error_code,quarantined_at,published_at
           FROM outbox_events WHERE event_id=$1`,
        [eventId],
      )
    )[0];
  const bodyOf = (body: string) => (JSON.parse(body) as { eventId: string }).eventId;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
  });
  afterAll(async () => {
    await source?.destroy();
    await db?.drop();
  });
  beforeEach(async () => {
    await clearOutbox(q);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('TC-181-01 the new columns, defaults, checks and partial indexes are exactly these', async () => {
    const columns = await q<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
        WHERE table_name='outbox_events' AND column_name IN
          ('attempts','last_attempt_at','last_error_code','quarantined_at') ORDER BY column_name`,
    );
    expect(columns).toEqual([
      { column_name: 'attempts', data_type: 'integer', is_nullable: 'NO', column_default: '0' },
      {
        column_name: 'last_attempt_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'last_error_code',
        data_type: 'text',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'quarantined_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
    const defs = Object.fromEntries(
      (
        await q<{ indexname: string; indexdef: string }>(
          `SELECT indexname,indexdef FROM pg_indexes WHERE tablename='outbox_events'
              AND indexname IN ('outbox_unpublished_idx','outbox_quarantined_idx')`,
        )
      ).map(r => [r.indexname, r.indexdef]),
    );
    expect(defs.outbox_unpublished_idx).toContain(
      'USING btree (id) WHERE ((published_at IS NULL) AND (quarantined_at IS NULL))',
    );
    expect(defs.outbox_quarantined_idx).toContain(
      'USING btree (id) WHERE ((quarantined_at IS NOT NULL) AND (published_at IS NULL))',
    );
    const { eventId } = await enqueue();
    expect(await row(eventId)).toMatchObject({
      attempts: 0,
      last_attempt_at: null,
      last_error_code: null,
      quarantined_at: null,
    });
  });

  it('TC-181-02 the database refuses a negative count and an error code that is text, not a code', async () => {
    const { eventId } = await enqueue();
    await expect(
      q('UPDATE outbox_events SET attempts=-1 WHERE event_id=$1', [eventId]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'outbox_events_attempts_check' });
    for (const bad of ['has a space', "'; DROP TABLE users; --", 'x'.repeat(81), '']) {
      await expect(
        q('UPDATE outbox_events SET last_error_code=$2 WHERE event_id=$1', [eventId, bad]),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'outbox_events_last_error_code_check',
      });
    }
    await q('UPDATE outbox_events SET last_error_code=$2 WHERE event_id=$1', [
      eventId,
      'SQS_400_InvalidParameterValue',
    ]);
  });

  it('TC-181-03 a failure that will repeat is counted in the row; the fifth one quarantines it, across restarts', async () => {
    const poison = await enqueue();
    const send: Send = () => Promise.reject(sqsError(400));
    for (let attempt = 1; attempt < RELAY_QUARANTINE_AFTER_ATTEMPTS; attempt++) {
      const result = await relayWith(send).relayOnce();
      expect(result).toMatchObject({ published: 0 });
      expect(await row(poison.eventId)).toMatchObject({
        attempts: attempt,
        last_error_code: 'SQS_400_InvalidParameterValue',
        quarantined_at: null,
        published_at: null,
      });
    }
    const before = await row(poison.eventId);
    expect(before.last_attempt_at).toBeInstanceOf(Date);
    await relayWith(send).relayOnce();
    const after = await row(poison.eventId);
    expect(after).toMatchObject({
      attempts: RELAY_QUARANTINE_AFTER_ATTEMPTS,
      last_error_code: 'SQS_400_InvalidParameterValue',
      published_at: null,
    });
    expect(after.quarantined_at).toBeInstanceOf(Date);
    expect(after.last_attempt_at!.getTime()).toBeGreaterThanOrEqual(
      before.last_attempt_at!.getTime(),
    );
  });

  it('TC-181-04 a quarantined row is never selected again by any relay, and the healthy event beside it goes out', async () => {
    const poison = await enqueue();
    const good = await enqueue();
    const sent: string[] = [];
    const send: Send = (_url, body) => {
      if (bodyOf(body) === poison.eventId) return Promise.reject(sqsError(400));
      sent.push(bodyOf(body));
      return Promise.resolve();
    };
    const result = await relayWith(send).relayOnce(100, { quarantineAfterAttempts: 1 });
    expect(result.published).toBe(1);
    expect((await row(poison.eventId)).quarantined_at).not.toBeNull();
    expect((await row(good.eventId)).published_at).not.toBeNull();

    const probe = jest.fn<ReturnType<Send>, Parameters<Send>>(() => Promise.resolve());
    expect(await relayWith(probe).relayOnce()).toEqual({ published: 0 });
    expect(await relayWith(probe).relayOnce()).toEqual({ published: 0 });
    expect(probe).not.toHaveBeenCalled();
    expect((await row(poison.eventId)).attempts).toBe(1);
  });

  it('TC-181-05 more poison events than the old in-memory cap of 1000 are all quarantined, and a healthy one still goes out', async () => {
    await q(
      `INSERT INTO outbox_events(event_type,aggregate_id,payload,correlation_id)
       SELECT 'AccountStatusChanged', gen_random_uuid(), '{"poison":true}'::jsonb, gen_random_uuid()
         FROM generate_series(1,1100)`,
    );
    const good = await enqueue();
    const sent: string[] = [];
    const send: Send = (_url, body) => {
      const parsed = JSON.parse(body) as { poison?: boolean; eventId?: string };
      if (parsed.poison) return Promise.reject(sqsError(400));
      sent.push(String(parsed.eventId));
      return Promise.resolve();
    };
    // A new relay each run: nothing is parked in memory, only the rows remember.
    for (let run = 0; run < 12; run++) {
      await relayWith(send).relayOnce(100, { quarantineAfterAttempts: 1 });
    }
    const [{ quarantined, waiting }] = await q<{ quarantined: number; waiting: number }>(
      `SELECT count(*) FILTER (WHERE quarantined_at IS NOT NULL)::int AS quarantined,
              count(*) FILTER (WHERE published_at IS NULL AND quarantined_at IS NULL)::int AS waiting
         FROM outbox_events`,
    );
    expect(quarantined).toBe(1100);
    expect(waiting).toBe(0);
    expect([...new Set(sent)]).toEqual([good.eventId]); // one copy per queue
  });

  it('TC-181-06 transient failures, and failures of the deployment, never count or quarantine', async () => {
    const event = await enqueue();
    const failures: [string, Send, string | null][] = [
      ['500', () => Promise.reject(sqsError(500, 'InternalFailure')), 'http://queue/risk'],
      ['429', () => Promise.reject(sqsError(429, 'ThrottlingException')), 'http://queue/risk'],
      ['socket', () => Promise.reject(new Error('socket hang up')), 'http://queue/risk'],
      ['403', () => Promise.reject(sqsError(403, 'AccessDenied')), 'http://queue/risk'],
      ['404', () => Promise.reject(sqsError(404, 'NotFound')), 'http://queue/risk'],
      [
        'missing queue',
        () => Promise.reject(sqsError(400, 'AWS.SimpleQueueService.NonExistentQueue')),
        'http://queue/risk',
      ],
      ['not configured', () => Promise.resolve(), null],
    ];
    for (const [, send, risk] of failures) {
      for (let run = 0; run < RELAY_QUARANTINE_AFTER_ATTEMPTS + 2; run++) {
        const result = await relayWith(send, risk).relayOnce();
        expect(result.published).toBe(0);
      }
      expect(await row(event.eventId)).toMatchObject({
        attempts: 0,
        last_attempt_at: null,
        last_error_code: null,
        quarantined_at: null,
        published_at: null,
      });
    }
    expect(new QueueNotConfiguredError('risk').name).toBe('QueueNotConfiguredError');
  });

  it('TC-181-07 the log names the event and the code and never the payload or the SQS message', async () => {
    const poison = await enqueue();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await relayWith(() => Promise.reject(sqsError(400))).relayOnce(100, {
      quarantineAfterAttempts: 1,
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('Outbox event quarantined');
    expect(logged).toContain('SQS_400_InvalidParameterValue');
    expect(logged).toContain(TRANSFER_SAMPLE.correlationId);
    expect(logged).not.toContain('secret-payload-text');
    expect(logged).not.toContain(TRANSFER_SAMPLE.fromAccountId);
    expect(logged).not.toContain(poison.eventId);
  });

  it('TC-181-08 a quarantined row cannot be deleted, not even by the owner (BL-180 guard)', async () => {
    const poison = await enqueue();
    await relayWith(() => Promise.reject(sqsError(400))).relayOnce(100, {
      quarantineAfterAttempts: 1,
    });
    await expect(
      q('DELETE FROM outbox_events WHERE event_id=$1', [poison.eventId]),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await row(poison.eventId)).toBeDefined();
  });

  it('TC-181-09 the cleanup job never deletes a quarantined row, however old', async () => {
    const poison = await enqueue();
    await relayWith(() => Promise.reject(sqsError(400))).relayOnce(100, {
      quarantineAfterAttempts: 1,
    });
    await q(
      `UPDATE outbox_events SET created_at = now() - interval '400 days',
              quarantined_at = now() - interval '399 days' WHERE event_id=$1`,
      [poison.eventId],
    );
    const cleaner = new OutboxCleanupService(tx(), {
      idempotencyKeyRetentionDays: 7,
      outbox: { retentionDays: 7, processedEventsRetentionDays: 7 },
    } as never);
    await cleaner.cleanOnce({ pauseMs: 0 });
    expect((await row(poison.eventId)).quarantined_at).not.toBeNull();
  });

  it('TC-181-10 the documented re-queue statement puts the row back in the relay, which then sends it', async () => {
    const poison = await enqueue();
    await relayWith(() => Promise.reject(sqsError(400))).relayOnce(100, {
      quarantineAfterAttempts: 1,
    });
    expect((await row(poison.eventId)).quarantined_at).not.toBeNull();

    await q(
      `UPDATE outbox_events SET quarantined_at = NULL, attempts = 0
        WHERE event_id = $1 AND quarantined_at IS NOT NULL AND published_at IS NULL`,
      [poison.eventId],
    );
    const sent: string[] = [];
    const result = await relayWith((_url, body) => {
      sent.push(bodyOf(body));
      return Promise.resolve();
    }).relayOnce();
    expect(result.published).toBe(1);
    expect(sent).toEqual([poison.eventId, poison.eventId]); // risk and notification
    expect(await row(poison.eventId)).toMatchObject({ attempts: 0, quarantined_at: null });
    expect((await row(poison.eventId)).published_at).not.toBeNull();
  });

  describe('gauges', () => {
    const registerGauge = jest.fn();
    const quarantineGauge = () =>
      new OutboxQuarantineGauge(tx(), { registerGauge } as unknown as MetricsService);
    const ageGauge = () => new OutboxAgeGauge(tx(), { registerGauge } as unknown as MetricsService);

    it('TC-181-11 outbox_quarantined_events counts quarantined unpublished rows and is 0 otherwise', async () => {
      const gauge = quarantineGauge();
      expect(await gauge.read()).toBe(0);
      const a = await enqueue();
      await enqueue(); // waiting, not quarantined
      expect(await gauge.read()).toBe(0);
      await relayWith(() => Promise.reject(sqsError(400))).relayOnce(1, {
        quarantineAfterAttempts: 1,
      });
      expect(await gauge.read()).toBe(1);
      // Published by hand after a manual delivery: not "waiting for an operator" any more.
      await q('UPDATE outbox_events SET published_at=now() WHERE event_id=$1', [a.eventId]);
      expect(await gauge.read()).toBe(0);
    });

    it('TC-181-12 the age gauge leaves quarantined rows out, so one poison event cannot keep the age alarm firing', async () => {
      const poison = await enqueue();
      await q(`UPDATE outbox_events SET created_at = now() - interval '2 hours'`);
      expect(await ageGauge().read()).toBeGreaterThan(7000);
      await relayWith(() => Promise.reject(sqsError(400))).relayOnce(100, {
        quarantineAfterAttempts: 1,
      });
      expect((await row(poison.eventId)).quarantined_at).not.toBeNull();
      expect(await ageGauge().read()).toBe(0);
      const fresh = await enqueue();
      await q(
        `UPDATE outbox_events SET created_at = now() - interval '42 seconds' WHERE event_id=$1`,
        [fresh.eventId],
      );
      const age = await ageGauge().read();
      expect(age).toBeGreaterThanOrEqual(42);
      expect(age).toBeLessThan(45);
    });

    it('TC-181-13 both gauge reads and the relay poll use their partial index', async () => {
      for (let i = 0; i < 30; i++) await enqueue();
      await q(`UPDATE outbox_events SET quarantined_at = now() WHERE id % 3 = 0`);
      await q('ANALYZE outbox_events');
      await q('BEGIN');
      try {
        await q('SET LOCAL enable_seqscan = off');
        const age = await q(`EXPLAIN (FORMAT JSON) ${OUTBOX_AGE_SQL}`);
        expect(JSON.stringify(age)).toContain('outbox_unpublished_idx');
        const count = await q(`EXPLAIN (FORMAT JSON) ${OUTBOX_QUARANTINED_SQL}`);
        expect(JSON.stringify(count)).toContain('outbox_quarantined_idx');
      } finally {
        await q('ROLLBACK');
      }
    });

    it('TC-181-14 registers itself as a gauge of counts with no dimension when the process runs workers', () => {
      registerGauge.mockClear();
      quarantineGauge().onModuleInit();
      expect(registerGauge).toHaveBeenCalledWith(
        expect.objectContaining({ name: OUTBOX_QUARANTINED_METRIC, unit: 'Count' }),
      );
      expect(OUTBOX_QUARANTINED_METRIC).toBe('outbox_quarantined_events');
    });
  });
});

describe('BL-181 migration 1795000009000: revert is safe and the schema comes back', () => {
  let db: TempDatabase;
  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> =>
    db.runner.query(sql, args) as Promise<T[]>;
  const columns = async () =>
    (
      await q<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='outbox_events' ORDER BY ordinal_position`,
      )
    ).map(r => r.column_name);
  const indexDef = async (name: string) =>
    (await q<{ indexdef: string }>('SELECT indexdef FROM pg_indexes WHERE indexname=$1', [name]))[0]
      ?.indexdef;

  beforeEach(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
  });
  afterEach(async () => {
    await db?.drop();
  });

  it('TC-181-16 reverting refuses while an event is quarantined, then restores the old index and drops the columns', async () => {
    expect(new QuarantineOutboxEvents1795000009000().name).toBe(
      'QuarantineOutboxEvents1795000009000',
    );
    const latest = await q<{ name: string }>(
      'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
    );
    expect(latest[0].name).toBe('QuarantineOutboxEvents1795000009000');
    await q(
      `INSERT INTO outbox_events(event_type,aggregate_id,payload,correlation_id,attempts,quarantined_at)
       VALUES ('TransferCompleted',gen_random_uuid(),'{}'::jsonb,gen_random_uuid(),5,now())`,
    );
    await expect(migrate(db.url, 'undoLast')).rejects.toMatchObject({ code: '55000' });
    expect(await columns()).toContain('quarantined_at');

    await q('UPDATE outbox_events SET quarantined_at = NULL, attempts = 0');
    await migrate(db.url, 'undoLast');
    expect(await columns()).not.toEqual(expect.arrayContaining(['attempts']));
    expect(await indexDef('outbox_quarantined_idx')).toBeUndefined();
    expect(await indexDef('outbox_unpublished_idx')).toContain('WHERE (published_at IS NULL)');
    expect(await indexDef('outbox_unpublished_idx')).not.toContain('quarantined_at');

    await migrate(db.url, 'up');
    expect(await columns()).toEqual(expect.arrayContaining(['attempts', 'quarantined_at']));
    expect(await indexDef('outbox_quarantined_idx')).toBeDefined();
    // The row written before the revert is still there, with the defaults.
    expect(await q('SELECT attempts, quarantined_at FROM outbox_events')).toEqual([
      { attempts: 0, quarantined_at: null },
    ]);
  });
});
