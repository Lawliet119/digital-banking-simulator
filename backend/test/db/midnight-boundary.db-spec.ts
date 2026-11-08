import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Clock } from '@common/clock';
import { parsePositiveMoney } from '@common/money';
import { TransactionService } from '@database/transaction.service';
import { AccountsService } from '@modules/accounts';
import { SyncGuardService } from '@modules/ledger';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { postBackdatedTransfer } from '../support/backdated-transfer';
import { checkLedgerInvariants } from '../support/invariants';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Row = Awaited<ReturnType<typeof seedDepositTarget>>;

/**
 * DBS-85. The database runs in UTC; the day of the limit starts at 00:00 Asia/Ho_Chi_Minh. Neither
 * the real time of the machine nor the time zone of the session may change the answer: the guard
 * is given a fixed Clock and the ledger lines are inserted at exact instants (the ledger is
 * append-only, so a line can be inserted in the past, never moved there).
 */
describe('DBS-85 the daily limit resets at 00:00 Vietnam time while the database runs on UTC', () => {
  let db: TempDatabase, app: App, operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const tx = () => app.app.get(TransactionService, { strict: false });
  const accounts = () => app.app.get(AccountsService, { strict: false });
  const guard = () => app.app.get(SyncGuardService, { strict: false });
  const clock = () => app.app.get(Clock, { strict: false });
  const at = (iso: string) => new Date(iso);

  const deposit = (to: string, amount: string) =>
    request(app.url)
      .post('/v1/operator/deposits')
      .auth(operator, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: to, amount })
      .expect(201);
  async function funded(amount: string): Promise<Row> {
    const row = await seedDepositTarget(db.runner);
    await deposit(row.accountId, amount);
    return row;
  }
  const post = async (from: Row, to: Row, amount: string, when: string) =>
    postBackdatedTransfer(db.runner, {
      from: from.accountId,
      to: to.accountId,
      amount,
      at: when,
      actorId: from.userId,
    });
  /** The guard's verdict for `amount`, with `now` as the clock and `zone` as the session time zone. */
  const ask = (source: Row, sink: Row, amount: string, now: Date, zone = 'UTC') => {
    jest.spyOn(clock(), 'now').mockReturnValue(now);
    return tx().run(async manager => {
      await manager.query(`SET LOCAL TIME ZONE '${zone}'`);
      const locked = await accounts().lockForUpdate([source.accountId, sink.accountId], manager);
      return guard().checkGuards(
        manager,
        locked.find(a => a.id === source.accountId)!,
        locked.find(a => a.id === sink.accountId),
        parsePositiveMoney(amount),
      );
    });
  };

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    operator = await app.issuer.token('operator', { sub: randomUUID() });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    Object.assign(app.limits.transfer, { perTx: 50_000_000n, perDay: 200_000_000n });
    const result = await checkLedgerInvariants(db.runner);
    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-85-01 the test database and the application sessions run on UTC', async () => {
    expect((await q('SHOW timezone'))[0].TimeZone).toBe('UTC');
    const inApp = await tx().run(async manager => (await manager.query('SHOW timezone'))[0]);
    expect(inApp.TimeZone).toBe('UTC');
  });

  // [debit written at, clock reads, counted today?]. 15 March 2026 starts at 14 March 17:00Z.
  const rows: [string, string, string, boolean][] = [
    [
      '23:59:59+07 on 14th, clock 00:00:00+07 on 15th',
      '2026-03-14T23:59:59+07:00',
      '2026-03-15T00:00:00+07:00',
      false,
    ],
    [
      '23:59:59.999+07 on 14th, clock 00:00:00.000+07 on 15th',
      '2026-03-14T23:59:59.999+07:00',
      '2026-03-15T00:00:00.000+07:00',
      false,
    ],
    [
      '00:00:00+07 on 15th, clock 00:00:00+07 on 15th (>= the boundary)',
      '2026-03-15T00:00:00+07:00',
      '2026-03-15T00:00:00+07:00',
      true,
    ],
    [
      '23:59:59+07 on 14th, clock 23:59:59+07 on 14th (same day)',
      '2026-03-14T23:59:59+07:00',
      '2026-03-14T23:59:59+07:00',
      true,
    ],
    [
      '00:00:00+07 on 15th, clock 23:59:59.999+07 on 15th',
      '2026-03-15T00:00:00+07:00',
      '2026-03-15T23:59:59.999+07:00',
      true,
    ],
    [
      '23:59:59+07 on 14th, clock 23:59:59.999+07 on 15th',
      '2026-03-14T23:59:59+07:00',
      '2026-03-15T23:59:59.999+07:00',
      false,
    ],
    [
      '00:00:00+07 on 15th, clock 00:00:00+07 on 16th',
      '2026-03-15T00:00:00+07:00',
      '2026-03-16T00:00:00+07:00',
      false,
    ],
    [
      '23:00+07 on 14th vs 01:00+07 on 15th: same UTC day, different Vietnam day',
      '2026-03-14T16:00:00Z',
      '2026-03-14T18:00:00Z',
      false,
    ],
    [
      '01:00+07 vs 09:00+07 on 15th: different UTC day, same Vietnam day',
      '2026-03-14T18:00:00Z',
      '2026-03-15T02:00:00Z',
      true,
    ],
  ];
  const ZONES = ['UTC', 'Asia/Ho_Chi_Minh', 'America/Los_Angeles', 'Pacific/Kiritimati'];

  it.each(rows)(
    'TC-85-02 / TC-85-03 %s',
    async (_name, written, clockReads, counted) => {
      app.limits.transfer.perTx = 1500n;
      app.limits.transfer.perDay = 1500n;
      const source = await funded('100000'),
        sink = await seedDepositTarget(db.runner);
      await post(source, sink, '1000', written);
      // 1,000 already sent in the day of the clock + 600 > 1,500; otherwise 600 passes.
      for (const zone of ZONES)
        expect(await ask(source, sink, '600', at(clockReads), zone)).toBe(
          counted ? 'LIMIT_PER_DAY_EXCEEDED' : null,
        );
    },
    60_000,
  );

  it('TC-85-04 through the API: the limit is full until 23:59:59+07 and free again at 00:00:00+07', async () => {
    const send = async (from: Row, to: Row, amount: string, now: string) => {
      jest.spyOn(clock(), 'now').mockReturnValue(at(now));
      return request(app.url)
        .post('/v1/transfers')
        .auth(await app.issuer.token('customer', { sub: from.sub }), { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ fromAccountId: from.accountId, toAccountId: to.accountId, amount });
    };
    const giang = await funded('300000000'),
      hai = await seedDepositTarget(db.runner);
    await post(giang, hai, '200000000', '2026-03-14T23:59:59+07:00');
    const refused = await send(giang, hai, '1', '2026-03-14T23:59:59+07:00');
    expect(refused.status).toBe(422);
    expect(refused.body.errorCode).toBe('LIMIT_PER_DAY_EXCEEDED');
    const free = await send(giang, hai, '50000000', '2026-03-15T00:00:00+07:00');
    expect(free.status).toBe(201);
    expect(free.body.status).toBe('COMPLETED');
    // 00:00:00+07 already belongs to the new day: 200,000,000 written then fills the limit.
    const khanh = await funded('300000000'),
      lan = await seedDepositTarget(db.runner);
    await post(khanh, lan, '200000000', '2026-03-15T00:00:00+07:00');
    const full = await send(khanh, lan, '1', '2026-03-15T00:00:00+07:00');
    expect(full.status).toBe(422);
    expect(full.body.errorCode).toBe('LIMIT_PER_DAY_EXCEEDED');
  });
});
