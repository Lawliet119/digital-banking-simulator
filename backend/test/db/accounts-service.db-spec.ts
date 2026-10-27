import { AccountsService } from '@modules/accounts';
import {
  ACCOUNT_FIXTURE as f,
  assertAccountsInvariants,
  closeProbeRunner,
  createAccountsFixture,
  proveAccountLockOrder,
  proveCrossedAccountLocks,
  withMoneyProbe,
  type AccountsFixture,
} from '../support/accounts-service-probe';

describe('DBS-55 AccountsService on PostgreSQL', () => {
  let fixture: AccountsFixture;
  let service: AccountsService;

  beforeAll(async () => {
    fixture = await createAccountsFixture();
    service = new AccountsService(fixture.source);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  afterEach(async () => {
    await assertAccountsInvariants(fixture.source);
  });

  it('TC-55-01 returns sorted unique snapshots, subsets and unchanged input', async () => {
    await withMoneyProbe(fixture.source, async manager => {
      const input = [f.accountB.toUpperCase(), f.accountA, f.accountA];
      const before = [...input];
      const rows = await service.lockForUpdate(input, manager);
      expect(rows.map(row => row.id)).toEqual([f.accountA, f.accountB]);
      expect(rows[0]).toMatchObject({ userId: f.userA, balance: '0', type: 'CHECKING' });
      expect(rows[0].createdAt).toBeInstanceOf(Date);
      expect(rows[0].updatedAt).toBeInstanceOf(Date);
      expect(rows[1]).toMatchObject({ userId: f.userB, status: 'LOCKED', type: 'SAVINGS' });
      expect(input).toEqual(before);
      expect(await service.lockForUpdate([], manager)).toEqual([]);
      expect(
        (await service.lockForUpdate([f.missing, f.accountA], manager)).map(row => row.id),
      ).toEqual([f.accountA]);
      expect((await service.lockForUpdate([f.funding], manager))[0]).toMatchObject({
        type: 'SYSTEM',
        customerId: null,
        userId: null,
      });
    });
  });

  it('TC-55-02 really locks low before high for reversed ids', async () => {
    expect((await proveAccountLockOrder(fixture.source, service)).highAvailable).toBe(true);
  });

  it('TC-55-03 opposing transactions finish without retry or deadlock', async () => {
    expect(await proveCrossedAccountLocks(fixture.source, service)).toMatchObject({
      completed: 2,
      retries: 0,
    });
  });

  it('TC-55-04 lock requires an active unreleased caller transaction even for empty input', async () => {
    await expect(service.lockForUpdate([], fixture.source.manager)).rejects.toThrow(Error);
    const runner = fixture.source.createQueryRunner();
    await runner.connect();
    try {
      await expect(service.lockForUpdate([], runner.manager)).rejects.toThrow(Error);
      await runner.release();
      await expect(service.lockForUpdate([], runner.manager)).rejects.toThrow(Error);
    } finally {
      await closeProbeRunner(runner);
    }
  });

  it('TC-55-13 lock rejects hostile ids and invalid arrays without a query', async () => {
    await withMoneyProbe(fixture.source, async manager => {
      const count = fixture.trace.length;
      await expect(service.lockForUpdate(["' OR 1=1 --"], manager)).rejects.toThrow(TypeError);
      await expect(service.lockForUpdate(null as unknown as string[], manager)).rejects.toThrow(
        TypeError,
      );
      expect(fixture.trace).toHaveLength(count);
      await service.lockForUpdate([f.accountA], manager);
      const query = fixture.trace.at(-1)!;
      expect(query.query).toContain('$1');
      expect(query.query).not.toContain(f.accountA);
      expect(query.parameters).toEqual([[f.accountA]]);
    });
  });
});
