import type { TransactionService } from '@database/transaction.service';
import { IdentityService } from './identity.service';

type Row = { id: string };
type QueryImpl = (sql: string, params: unknown[]) => Promise<Row[]> | Row[];

const SUB = '5b0d7c1e-3f4a-4c8e-9d2b-7a1e6f0c9a42';
const isInsert = (sql: string): boolean => sql.trimStart().startsWith('INSERT INTO users');
const isSelect = (sql: string): boolean => sql.trimStart().startsWith('SELECT id FROM users');

/**
 * `TransactionService.run` is faked to hand the callback a manager whose `query` is the mock, so
 * these tests see exactly which SQL runs and how often, without a database (the real race is
 * proven on PostgreSQL in test/db/identity-users.db-spec.ts).
 */
function build(queryImpl: QueryImpl) {
  const query = jest.fn((sql: string, params: unknown[]) =>
    Promise.resolve(queryImpl(sql, params)),
  );
  const run = jest.fn((fn: (manager: { query: typeof query }) => Promise<string>) => fn({ query }));
  const service = new IdentityService({ run } as unknown as TransactionService);
  return { service, query, run };
}

const inserts = (query: jest.Mock, sub: string): number =>
  query.mock.calls.filter(([sql, params]) => isInsert(sql) && (params as unknown[])[0] === sub)
    .length;

describe('IdentityService.resolveUserId', () => {
  it('TC-52-01 returns the id from the INSERT and runs no SELECT', async () => {
    const { service, query } = build(sql => (isInsert(sql) ? [{ id: 'user-a' }] : []));

    await expect(service.resolveUserId(SUB)).resolves.toBe('user-a');

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => isSelect(sql))).toBe(false);
  });

  it('TC-52-02 falls back to a SELECT when the INSERT returns nothing, both parameterised', async () => {
    const { service, query } = build(sql => (isSelect(sql) ? [{ id: 'existing' }] : []));
    const hostile = "x'; DROP TABLE users;--";

    await expect(service.resolveUserId(hostile)).resolves.toBe('existing');

    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, params] of query.mock.calls) {
      expect(params).toEqual([hostile]);
      expect(sql).not.toContain(hostile);
      expect(sql).toMatch(/\$1/);
    }
    expect(query.mock.calls.map(([sql]) => isInsert(sql))).toEqual([true, false]);
  });

  it('TC-52-03 serves the second call for the same sub from the cache', async () => {
    const { service, query, run } = build(() => [{ id: 'user-a' }]);

    await service.resolveUserId(SUB);
    await expect(service.resolveUserId(SUB)).resolves.toBe('user-a');

    expect(query).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('TC-52-04 merges 20 parallel calls for one sub into a single INSERT (single-flight)', async () => {
    let release!: (rows: Row[]) => void;
    const pending = new Promise<Row[]>(resolve => {
      release = resolve;
    });
    const { service, query } = build(() => pending);

    const calls = Array.from({ length: 20 }, () => service.resolveUserId(SUB));
    expect(query).toHaveBeenCalledTimes(1);
    release([{ id: 'user-a' }]);

    await expect(Promise.all(calls)).resolves.toEqual(Array(20).fill('user-a'));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('TC-52-05 does not cache a failure: the next call asks the database again', async () => {
    let attempt = 0;
    const { service, query } = build(() => {
      attempt += 1;
      if (attempt === 1) throw new Error('connection lost');
      return [{ id: 'user-a' }];
    });

    await expect(service.resolveUserId(SUB)).rejects.toThrow('connection lost');
    await expect(service.resolveUserId(SUB)).resolves.toBe('user-a');

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('TC-52-06 keeps at most 10,000 subs and evicts the least recently used', async () => {
    const { service, query } = build((_sql, [sub]) => [{ id: `id-${String(sub)}` }]);
    for (let i = 0; i < 10_000; i++) await service.resolveUserId(`sub-${i}`);
    expect(query).toHaveBeenCalledTimes(10_000);

    await service.resolveUserId('sub-0'); // a hit: sub-0 becomes the most recently used
    await service.resolveUserId('sub-10000'); // the 10,001st sub evicts the oldest, sub-1
    expect(query).toHaveBeenCalledTimes(10_001);

    await service.resolveUserId('sub-0');
    expect(query).toHaveBeenCalledTimes(10_001); // still cached
    await service.resolveUserId('sub-1');
    expect(query).toHaveBeenCalledTimes(10_002); // evicted, asked again
    expect(inserts(query, 'sub-1')).toBe(2);
  });

  it.each([
    ['empty string', ''],
    ['undefined', undefined],
    ['a number', 123],
    ['null', null],
    ['an object', {}],
  ])('TC-52-07 rejects %s without touching the database', async (_label, value) => {
    const { service, run } = build(() => [{ id: 'never' }]);

    await expect(service.resolveUserId(value as unknown as string)).rejects.toThrow(TypeError);

    expect(run).not.toHaveBeenCalled();
  });

  it('TC-52-23 throws when the INSERT and the SELECT both return nothing, and caches nothing', async () => {
    const { service, query } = build(() => []);

    await expect(service.resolveUserId(SUB)).rejects.toThrow();
    await expect(service.resolveUserId(SUB)).rejects.toThrow();

    expect(query).toHaveBeenCalledTimes(4); // two attempts, INSERT + SELECT each
  });

  it('TC-52-26 a rejected promise evicted by the LRU does not delete its successor', async () => {
    const deferred: Array<{ resolve: (r: Row[]) => void; reject: (e: Error) => void }> = [];
    const { service, query } = build((sql, [sub]) => {
      if (sub !== 'victim') return [{ id: `id-${String(sub)}` }];
      expect(isInsert(sql)).toBe(true);
      return new Promise<Row[]>((resolve, reject) => deferred.push({ resolve, reject }));
    });

    const first = service.resolveUserId('victim'); // in flight, the oldest entry
    // Settled into a value right away, so a failing assertion below reports normally instead of
    // leaving a rejected promise nobody handles (which would crash the whole Jest worker).
    const firstOutcome = first.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    for (let i = 0; i < 10_000; i++) await service.resolveUserId(`filler-${i}`); // evicts victim
    const second = service.resolveUserId('victim'); // a new promise for the same sub
    expect(deferred).toHaveLength(2);

    deferred[0].reject(new Error('boom')); // the first promise fails after being evicted
    await expect(firstOutcome).resolves.toBe('boom');

    const third = service.resolveUserId('victim'); // must join `second`, not start a third query
    expect(inserts(query, 'victim')).toBe(2);
    deferred[1].resolve([{ id: 'victim-id' }]);
    await expect(Promise.all([second, third])).resolves.toEqual(['victim-id', 'victim-id']);
  });
});
