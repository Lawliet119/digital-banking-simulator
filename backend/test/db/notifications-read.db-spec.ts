import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { buildNotificationSql } from '../../src/modules/notification/notification-query';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import {
  createTempDatabase,
  migrate,
  migrateThrough,
  type TempDatabase,
} from '../support/temp-database';

type App = Awaited<ReturnType<typeof startDepositApp>>;

const THIS = 'GrantNotificationRead1795000014000';

/**
 * UI plan, stage B: `GET /v1/notifications` over real HTTP/JWT/PostgreSQL. The writer is the
 * worker's consumer; here rows are inserted directly, which is what the consumer does.
 */
describe('GET /v1/notifications', () => {
  let db: TempDatabase;
  let app: App;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { notifications: true });
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  async function customer() {
    const row = await seedDepositTarget(db.runner);
    return { ...row, token: await app.issuer.token('customer', { sub: row.sub }) };
  }

  async function notice(userId: string, occurredAt: string, message = 'Giao dịch đã hoàn tất.') {
    const [row] = (await q(
      `INSERT INTO notification_log(event_id, kind, user_id, message, correlation_id, occurred_at)
       VALUES ($1, 'transfer_completed', $2, $3, $4, $5) RETURNING id::text AS id`,
      [randomUUID(), userId, message, randomUUID(), occurredAt],
    )) as { id: string }[];
    return row.id;
  }

  const list = (token: string | undefined, query = '') => {
    const call = request(app.url).get(`/v1/notifications${query}`);
    return token ? call.auth(token, { type: 'bearer' }) : call;
  };

  it('TC-B-01 returns only the caller notices, newest event first, without event or correlation ids', async () => {
    const me = await customer();
    const other = await customer();
    const older = await notice(me.userId, '2026-03-01T01:00:00Z');
    const newer = await notice(me.userId, '2026-03-02T01:00:00Z', 'Tài khoản của bạn đã bị khóa.');
    await notice(other.userId, '2026-03-03T01:00:00Z');

    const res = await list(me.token).expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      items: [
        {
          id: newer,
          kind: 'transfer_completed',
          message: 'Tài khoản của bạn đã bị khóa.',
          occurredAt: '2026-03-02T01:00:00.000000Z',
          read: false,
          accountNumber: null,
          transfer: null,
        },
        {
          id: older,
          kind: 'transfer_completed',
          message: 'Giao dịch đã hoàn tất.',
          occurredAt: '2026-03-01T01:00:00.000000Z',
          read: false,
          accountNumber: null,
          transfer: null,
        },
      ],
      nextCursor: null,
      unreadCount: 2,
    });
  });

  it('TC-B-02 sorts by the event time, not by the order the worker wrote the rows (BL-211)', async () => {
    const me = await customer();
    const writtenFirst = await notice(me.userId, '2026-03-05T00:00:00Z');
    const writtenSecond = await notice(me.userId, '2026-03-04T00:00:00Z');
    const res = await list(me.token).expect(200);
    expect(res.body.items.map((item: { id: string }) => item.id)).toEqual([
      writtenFirst,
      writtenSecond,
    ]);
  });

  it('TC-B-03 the cursor walks every notice once, including two at the same instant', async () => {
    const me = await customer();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await notice(me.userId, `2026-04-0${i + 1}T00:00:00Z`));
    ids.push(await notice(me.userId, '2026-04-03T00:00:00Z'));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await list(me.token, query).expect(200);
      expect(res.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.items.map((item: { id: string }) => item.id));
      cursor = res.body.nextCursor as string | null;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('TC-B-04 default limit 20, at most 50', async () => {
    const me = await customer();
    for (let i = 0; i < 21; i++) {
      await notice(me.userId, `2026-05-01T00:00:${String(i).padStart(2, '0')}Z`);
    }
    const first = await list(me.token).expect(200);
    expect(first.body.items).toHaveLength(20);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    await list(me.token, '?limit=50').expect(200);
    await list(me.token, '?limit=51').expect(400);
  });

  it('TC-B-05 a customer with no notice gets an empty page', async () => {
    const me = await customer();
    expect((await list(me.token).expect(200)).body).toEqual({
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
  });

  it.each([
    ['limit 0', '?limit=0'],
    ['limit with letters', '?limit=2a'],
    ['an unknown parameter', '?userId=1'],
    ['a repeated parameter', '?limit=1&limit=2'],
    ['a cursor that is not base64url', '?cursor=***'],
    [
      'a cursor with a bad date',
      `?cursor=${Buffer.from(JSON.stringify({ v: 1, t: '2026-02-30T00:00:00.000000Z', id: '1' })).toString('base64url')}`,
    ],
  ])('TC-B-06 %s is 400', async (_name, query) => {
    const me = await customer();
    await list(me.token, query).expect(400);
  });

  it('TC-B-07 no token is 401; operator, auditor and admin are 403', async () => {
    await list(undefined).expect(401);
    for (const role of ['operator', 'auditor', 'admin'] as const) {
      await list(await app.issuer.token(role, { sub: randomUUID() })).expect(403);
    }
  });

  it('TC-B-08 the page is an index scan on notification_log_user_idx, without a Sort', async () => {
    const me = await customer();
    const { sql, parameters } = buildNotificationSql(me.userId, {
      limit: 20,
      cursor: null,
      filter: 'all',
    });
    await q('BEGIN');
    try {
      // The table holds a few dozen rows here, so the planner prefers a heap or bitmap scan and a
      // Sort; turned off, the plan shows whether the index can serve the order by itself.
      await q('SET LOCAL enable_seqscan = off');
      await q('SET LOCAL enable_bitmapscan = off');
      const [{ 'QUERY PLAN': plan }] = (await q(`EXPLAIN (FORMAT JSON) ${sql}`, parameters)) as {
        'QUERY PLAN': { Plan: unknown }[];
      }[];
      const text = JSON.stringify(plan);
      expect(text).toContain('notification_log_user_idx');
      expect(text).not.toContain('"Node Type":"Sort"');
    } finally {
      await q('ROLLBACK');
    }
  });
});

describe('migration GrantNotificationRead', () => {
  it('TC-B-09 down removes the grant and the index, up adds them again', async () => {
    const db = await createTempDatabase();
    const state = async () =>
      (
        (await db.runner.query(
          `SELECT has_table_privilege('dbs_api', 'public.notification_log', 'SELECT') AS api_reads,
                  to_regclass('public.notification_log_user_idx') IS NOT NULL AS indexed`,
        )) as { api_reads: boolean; indexed: boolean }[]
      )[0];
    try {
      await migrateThrough(db.url, THIS);
      expect(await state()).toEqual({ api_reads: true, indexed: true });
      await migrate(db.url, 'undoLast');
      expect(await state()).toEqual({ api_reads: false, indexed: false });
      await migrate(db.url);
      expect(await state()).toEqual({ api_reads: true, indexed: true });
    } finally {
      await db.drop();
    }
  });
});
