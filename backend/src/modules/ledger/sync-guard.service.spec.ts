import { SystemClock, type Clock } from '@common/clock';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EntityManager } from 'typeorm';
import type { AccountsService, LockedAccount } from '@modules/accounts';
import { parsePositiveMoney } from '@common/money';
import { SENT_TODAY_SQL, SyncGuardService } from './sync-guard.service';

const SRC = resolve(__dirname, '../..');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const account = (over: Partial<LockedAccount> = {}): LockedAccount => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  customerId: 'c',
  userId: 'u',
  type: 'CHECKING',
  status: 'ACTIVE',
  balance: '100',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  sentToday: '0',
  sentDay: null,
  ...over,
});
const limits = { transfer: { perTx: 1000n, perDay: 1500n } };
const accounts = { assertLocked: jest.fn() } as unknown as AccountsService;
const manager = {
  query: jest.fn().mockResolvedValue([{ total: '0' }]),
} as unknown as EntityManager;

describe('SyncGuardService (what needs no database)', () => {
  it('TC-82-07 returns a Promise, so a caller that forgets to await holds a Promise, never a verdict', async () => {
    const guard = new SyncGuardService(accounts, new SystemClock(), limits as never);
    const result = guard.checkGuards(
      manager,
      account(),
      account({ id: '00000000-0000-4000-8000-0000000000b2' }),
      parsePositiveMoney('1'),
    );
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBeNull();
  });

  it('TC-82-07 every call of checkGuards in src/ is awaited', () => {
    const calls: string[] = [];
    for (const file of sources(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (!/\bcheckGuards\(/.test(line)) return;
          if (/\basync checkGuards\(|^\s*(\*|\/\/)/.test(line)) return; // the definition, comments
          if (!/\bawait\b[^;]*\bcheckGuards\(/.test(line)) calls.push(`${file}:${index + 1}`);
        });
    }
    expect(calls).toEqual([]);
  });

  it('TC-82-08 the ledger module holds no limit constant of its own', () => {
    const offenders = sources(join(SRC, 'modules/ledger')).filter(file =>
      /\b(50_?000_?000|200_?000_?000)n?\b/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('TC-85-05 the day boundary never reads the real time of the machine (only the Clock)', () => {
    const code = readFileSync(join(SRC, 'modules/ledger/sync-guard.service.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/^\s*\/\/.*$/gm, ''); // line comments
    const wallClock = /new Date\(|Date\.now\(|clock_timestamp|statement_timestamp|[^.]\bnow\(\)/;
    expect(code).not.toMatch(wallClock);
    // The one allowed read is the injected clock, and the SQL takes it as a parameter.
    expect(code).toMatch(/this\.clock\.now\(\)/);
    expect(code).toMatch(/\$2::timestamptz AT TIME ZONE 'Asia\/Ho_Chi_Minh'/);
  });

  it('TC-82-08 decides on the account state before it asks the database anything', async () => {
    const query = jest.fn();
    const guard = new SyncGuardService(accounts, new SystemClock(), limits as never);
    const verdict = await guard.checkGuards(
      { query } as unknown as EntityManager,
      account({ status: 'LOCKED' }),
      account({ id: '00000000-0000-4000-8000-0000000000b2' }),
      parsePositiveMoney('5000'),
    );
    expect(verdict).toBe('ACCOUNT_NOT_ACTIVE');
    expect(query).not.toHaveBeenCalled(); // no day total is computed for a refused transfer
  });

  // BL-418: the day total is read from the locked row, in Vietnam days of the injected Clock.
  describe('BL-418 the day total comes from the locked account row', () => {
    const at = (iso: string): Clock => ({ now: () => new Date(iso) });
    const target = account({ id: '00000000-0000-4000-8000-0000000000b2' });
    const run = (
      source: LockedAccount,
      amount: string,
      clock: Clock = at('2026-03-10T05:00:00Z'),
      query = jest.fn().mockResolvedValue([{ total: '0' }]),
    ) =>
      new SyncGuardService(accounts, clock, limits as never)
        .checkGuards(
          { query } as unknown as EntityManager,
          source,
          target,
          parsePositiveMoney(amount),
        )
        .then(verdict => ({ verdict, query }));

    it('TC-418-04 asks the database nothing when the counter is today, older, or empty', async () => {
      for (const over of [
        { sentToday: '1000', sentDay: '2026-03-10' },
        { sentToday: '1400', sentDay: '2026-03-09' },
        { sentToday: '0', sentDay: null },
      ]) {
        const { query } = await run(account(over), '100');
        expect(query).not.toHaveBeenCalled();
      }
    });

    it('TC-418-04 falls back to SENT_TODAY_SQL only when the counter is a later day than the clock', async () => {
      const query = jest.fn().mockResolvedValue([{ total: '1400' }]);
      const { verdict } = await run(
        account({ sentToday: '5', sentDay: '2026-03-11' }),
        '200',
        at('2026-03-10T05:00:00Z'),
        query,
      );
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toBe(SENT_TODAY_SQL);
      // 1,400 sent today by the ledger, and 200 more is above the 1,500 limit: the counter is not believed.
      expect(verdict).toBe('LIMIT_PER_DAY_EXCEEDED');
    });

    it('TC-418-06 counts the counter only for today in Vietnam time (00:00 is 17:00Z the day before)', async () => {
      const counter = { sentToday: '1400', sentDay: '2026-03-10', balance: '1000' };
      // 16:59:59Z is still the 10th in Vietnam: 1,400 + 200 > 1,500.
      expect((await run(account(counter), '200', at('2026-03-10T16:59:59Z'))).verdict).toBe(
        'LIMIT_PER_DAY_EXCEEDED',
      );
      // 17:00:00Z is 00:00 on the 11th: nothing was sent today yet.
      expect((await run(account(counter), '200', at('2026-03-10T17:00:00Z'))).verdict).toBeNull();
    });

    it('TC-418-06 the limit itself is allowed, one dong more is not', async () => {
      const counter = { sentToday: '1400', sentDay: '2026-03-10' };
      expect((await run(account(counter), '100')).verdict).toBeNull();
      expect((await run(account({ ...counter, balance: '1000' }), '101')).verdict).toBe(
        'LIMIT_PER_DAY_EXCEEDED',
      );
    });

    it('TC-418-06 keeps the order ACCOUNT_NOT_ACTIVE > LIMIT_PER_TX > LIMIT_PER_DAY > INSUFFICIENT_FUNDS', async () => {
      const full = { sentToday: '1400', sentDay: '2026-03-10', balance: '10' };
      // all four are broken at once: locked, 1,001 > 1,000 per transfer, 1,400 + 1,001 > 1,500, balance 10
      expect((await run(account({ ...full, status: 'LOCKED' }), '1001')).verdict).toBe(
        'ACCOUNT_NOT_ACTIVE',
      );
      expect((await run(account(full), '1001')).verdict).toBe('LIMIT_PER_TX_EXCEEDED');
      // per-transfer fine (200), day broken (1,600 > 1,500), balance broken (10)
      expect((await run(account(full), '200')).verdict).toBe('LIMIT_PER_DAY_EXCEEDED');
      // day fine (1,400 + 50), balance broken
      expect((await run(account(full), '50')).verdict).toBe('INSUFFICIENT_FUNDS');
    });

    it('TC-418-06 reads an amount above 2^53 exactly', async () => {
      const big = '9007199254740993';
      const bigLimits = { transfer: { perTx: 2n ** 62n, perDay: 9007199254740993n } };
      const guard = new SyncGuardService(accounts, at('2026-03-10T05:00:00Z'), bigLimits as never);
      const ask = (sent: string, amount: string) =>
        guard.checkGuards(
          { query: jest.fn() } as unknown as EntityManager,
          account({ sentToday: sent, sentDay: '2026-03-10', balance: big }),
          target,
          parsePositiveMoney(amount),
        );
      expect(await ask('9007199254740992', '1')).toBeNull();
      expect(await ask('9007199254740992', '2')).toBe('LIMIT_PER_DAY_EXCEEDED');
    });
  });
});
