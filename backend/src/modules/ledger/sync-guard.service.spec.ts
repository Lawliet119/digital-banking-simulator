import { SystemClock } from '@common/clock';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EntityManager } from 'typeorm';
import type { AccountsService, LockedAccount } from '@modules/accounts';
import { parsePositiveMoney } from '@common/money';
import { SyncGuardService } from './sync-guard.service';

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
});
