import { AccountsModule, AccountsService } from '@modules/accounts';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ACCOUNT_FIXTURE as f,
  assertAccountsInvariants,
  closeProbeRunner,
  createAccountsFixture,
  proveAccountLockOrder,
  proveCrossedAccountLocks,
  startProbeRunner,
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
      await expect(service.lockForUpdate(Array(1) as string[], manager)).rejects.toThrow(TypeError);
      const mixed = [f.accountA as string];
      mixed.length = 3;
      mixed[2] = f.accountB;
      await expect(service.lockForUpdate(mixed, manager)).rejects.toThrow(TypeError);
      expect(fixture.trace).toHaveLength(count);
      await service.lockForUpdate([f.accountA], manager);
      const query = fixture.trace.at(-1)!;
      expect(query.query).toContain('$1');
      expect(query.query).not.toContain(f.accountA);
      expect(query.parameters).toEqual([[f.accountA]]);
    });
  });

  it('TC-55-04 apply rejects inactive and released managers without querying', async () => {
    const runner = fixture.source.createQueryRunner();
    await runner.connect();
    try {
      await expect(
        service.applyBalanceChange(f.accountA, 0n, fixture.source.manager),
      ).rejects.toThrow(Error);
      await expect(service.applyBalanceChange(f.accountA, 0n, runner.manager)).rejects.toThrow(
        Error,
      );
      await runner.release();
      await expect(service.applyBalanceChange(f.accountA, 0n, runner.manager)).rejects.toThrow(
        Error,
      );
    } finally {
      await closeProbeRunner(runner);
    }
  });

  it('TC-55-04 probe setup releases its real runner when a SET fails', async () => {
    const runner = fixture.source.createQueryRunner();
    const failure = new Error('Injected probe setup failure');
    const realQuery = runner.query.bind(runner);
    const create = jest.spyOn(fixture.source, 'createQueryRunner').mockReturnValue(runner);
    const query = jest
      .spyOn(runner, 'query')
      .mockImplementation((sql: string, parameters?: unknown[]) => {
        if (sql.startsWith('SET LOCAL statement_timeout')) return Promise.reject(failure);
        return realQuery(sql, parameters);
      });
    try {
      await expect(startProbeRunner(fixture.source)).rejects.toBe(failure);
      expect(runner.isReleased).toBe(true);
      expect(runner.isTransactionActive).toBe(false);
    } finally {
      create.mockRestore();
      query.mockRestore();
      await closeProbeRunner(runner);
    }
  });

  it.each([
    ['ordered', proveAccountLockOrder],
    ['crossed', proveCrossedAccountLocks],
  ] as const)(
    'TC-55-04 %s probe cleans earlier runners if later allocation fails',
    async (_name, probe) => {
      const runners: ReturnType<typeof fixture.source.createQueryRunner>[] = [];
      const failure = new Error('Injected second-runner connection failure');
      const realCreate = fixture.source.createQueryRunner.bind(fixture.source);
      let connectSpy: jest.SpyInstance | undefined;
      const create = jest.spyOn(fixture.source, 'createQueryRunner').mockImplementation(() => {
        const runner = realCreate();
        runners.push(runner);
        if (runners.length === 2)
          connectSpy = jest.spyOn(runner, 'connect').mockRejectedValue(failure);
        return runner;
      });
      try {
        await expect(probe(fixture.source, service)).rejects.toBe(failure);
        expect(runners).toHaveLength(2);
        expect(runners.every(runner => runner.isReleased)).toBe(true);
      } finally {
        create.mockRestore();
        connectSpy?.mockRestore();
        await Promise.allSettled(runners.map(closeProbeRunner));
      }
    },
  );

  it('TC-55-05 changes are visible only in the caller transaction and roll back together', async () => {
    const before = await fixture.source.query<{ id: string; balance: string; updated_at: Date }[]>(
      'SELECT id,balance,updated_at FROM accounts ORDER BY id',
    );
    await withMoneyProbe(fixture.source, async manager => {
      await service.lockForUpdate([f.accountA, f.funding], manager);
      await expect(
        service.applyBalanceChange(f.funding, -300000n, manager),
      ).resolves.toBeUndefined();
      await expect(
        service.applyBalanceChange(f.accountA, 300000n, manager),
      ).resolves.toBeUndefined();
      const rows = await service.lockForUpdate([f.funding, f.accountA], manager);
      expect(rows.map(row => row.balance)).toEqual(['-300000', '300000']);
      const outside = await fixture.source.query<{ balance: string }[]>(
        'SELECT balance FROM accounts',
      );
      expect(outside.every(row => row.balance === '0')).toBe(true);
    });
    expect(
      await fixture.source.query('SELECT id,balance,updated_at FROM accounts ORDER BY id'),
    ).toEqual(before);
  });

  it('TC-55-06 preserves amounts above 2^53, serializes strings, and accepts zero delta', async () => {
    await withMoneyProbe(fixture.source, async manager => {
      await service.lockForUpdate([f.funding, f.accountA], manager);
      await service.applyBalanceChange(f.funding, -9007199254740993n, manager);
      await service.applyBalanceChange(f.accountA, 9007199254740993n, manager);
      await service.applyBalanceChange(f.accountA, 0n, manager);
      const [row] = await service.lockForUpdate([f.accountA], manager);
      expect(row.balance).toBe('9007199254740993');
      expect(JSON.parse(JSON.stringify(row))).toMatchObject({ balance: '9007199254740993' });
      const update = fixture.trace
        .filter(
          trace =>
            trace.query.startsWith('UPDATE accounts') && trace.parameters[1] === '9007199254740993',
        )
        .at(-1);
      expect(update?.parameters).toEqual([f.accountA, '9007199254740993']);
      expect(update?.query).toContain('$2::bigint');
    });
  });

  it('TC-55-07 PostgreSQL refuses a negative customer balance', async () => {
    await expect(
      withMoneyProbe(fixture.source, async manager => {
        await service.lockForUpdate([f.accountA], manager);
        await service.applyBalanceChange(f.accountA, -1n, manager);
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'accounts_balance_non_negative' });
  });

  it('TC-55-08 accepts signed bigint bounds for funding with balanced service probes', async () => {
    const max = 9223372036854775807n;
    await withMoneyProbe(fixture.source, async manager => {
      await service.lockForUpdate([f.funding, f.accountA], manager);
      await service.applyBalanceChange(f.funding, -max, manager);
      await service.applyBalanceChange(f.accountA, max, manager);
      expect(
        (await service.lockForUpdate([f.funding, f.accountA], manager)).map(row => row.balance),
      ).toEqual(['-9223372036854775807', '9223372036854775807']);
    });
    await withMoneyProbe(fixture.source, async manager => {
      await service.lockForUpdate([f.funding, f.accountA, f.accountC], manager);
      await service.applyBalanceChange(f.funding, -9223372036854775808n, manager);
      await service.applyBalanceChange(f.accountA, max, manager);
      await service.applyBalanceChange(f.accountC, 1n, manager);
      const rows = await service.lockForUpdate([f.funding, f.accountA, f.accountC], manager);
      expect(rows.map(row => row.balance)).toEqual([
        '-9223372036854775808',
        '9223372036854775807',
        '1',
      ]);
      expect(rows.reduce((sum, row) => sum + BigInt(row.balance), 0n)).toBe(0n);
    });
  });

  it.each(['customer overflow', 'funding underflow', 'large delta', 'small delta'])(
    'TC-55-09 rejects %s without leaving tentative balances',
    async scenario => {
      await expect(
        withMoneyProbe(fixture.source, async manager => {
          await service.lockForUpdate([f.funding, f.accountA, f.accountC], manager);
          if (scenario === 'customer overflow') {
            await service.applyBalanceChange(f.funding, -9223372036854775807n, manager);
            await service.applyBalanceChange(f.accountA, 9223372036854775807n, manager);
            await service.applyBalanceChange(f.accountA, 1n, manager);
          } else if (scenario === 'funding underflow') {
            await service.applyBalanceChange(f.funding, -9223372036854775808n, manager);
            await service.applyBalanceChange(f.accountA, 9223372036854775807n, manager);
            await service.applyBalanceChange(f.accountC, 1n, manager);
            await service.applyBalanceChange(f.funding, -1n, manager);
          } else {
            const delta = scenario === 'large delta' ? 9223372036854775808n : -9223372036854775809n;
            await service.applyBalanceChange(f.accountA, delta, manager);
          }
        }),
      ).rejects.toMatchObject({ code: '22003' });
    },
  );

  it('TC-55-10 missing update is 404 rather than mistaking the raw tuple for rows', async () => {
    await expect(
      withMoneyProbe(fixture.source, manager => service.applyBalanceChange(f.missing, 0n, manager)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('TC-55-13 apply rejects injection and non-bigint deltas before SQL', async () => {
    await withMoneyProbe(fixture.source, async manager => {
      const count = fixture.trace.length;
      await expect(service.applyBalanceChange("' OR 1=1 --", 0n, manager)).rejects.toThrow(
        TypeError,
      );
      await expect(
        service.applyBalanceChange(f.accountA, 300000 as unknown as bigint, manager),
      ).rejects.toThrow(TypeError);
      expect(fixture.trace).toHaveLength(count);
    });
  });

  it('TC-55-11 returns only the account snapshot belonging to the internal user', async () => {
    const row = await service.getOwnedAccount(f.accountA.toUpperCase(), f.userA);
    expect(row).toMatchObject({
      id: f.accountA,
      customerId: f.customerA,
      userId: f.userA,
      type: 'CHECKING',
      status: 'ACTIVE',
      balance: '0',
    });
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(Object.keys(row).sort()).toEqual([
      'balance',
      'createdAt',
      'customerId',
      'id',
      'status',
      'type',
      'updatedAt',
      'userId',
    ]);
    expect(await service.getOwnedAccount(f.accountB, f.userB)).toMatchObject({ status: 'LOCKED' });
  });

  it('TC-55-11 returns the same safe 404 for foreign, missing and SYSTEM accounts', async () => {
    const inputs = [
      [f.accountA, f.userB],
      [f.missing, f.userA],
      [f.accountA, f.missing],
      [f.funding, f.userA],
    ];
    const responses: unknown[] = [];
    for (const [account, user] of inputs) {
      const error = await ownershipError(account, user);
      expect(error.getStatus()).toBe(404);
      responses.push(error.getResponse());
    }
    expect(
      responses.every(response => JSON.stringify(response) === JSON.stringify(responses[0])),
    ).toBe(true);
    expect(JSON.stringify(responses)).not.toMatch(/SELECT|customer_id|30000000|3a000000|10000000/);
  });

  it('TC-55-11 ownership reads committed state rather than a mutation manager snapshot', async () => {
    await withMoneyProbe(fixture.source, async manager => {
      await service.lockForUpdate([f.funding, f.accountA], manager);
      await service.applyBalanceChange(f.funding, -300000n, manager);
      await service.applyBalanceChange(f.accountA, 300000n, manager);
      expect((await service.getOwnedAccount(f.accountA, f.userA)).balance).toBe('0');
      expect((await service.lockForUpdate([f.accountA], manager))[0].balance).toBe('300000');
    });
  });

  it.each([
    [null, f.userA],
    [undefined, f.userA],
    ['', f.userA],
    ["' OR 1=1 --", f.userA],
    [f.accountA, null],
    [f.accountA, undefined],
    [f.accountA, ''],
    [f.accountA, "' OR 1=1 --"],
  ])(
    'TC-55-12 rejects malformed account/user identifiers uniformly (%s, %s)',
    async (account, user) => {
      const count = fixture.trace.length;
      const error = await ownershipError(account as string, user as string);
      expect(error.getStatus()).toBe(404);
      expect(fixture.trace).toHaveLength(count);
    },
  );

  it('TC-55-12 a valid Cognito sub UUID is not the internal users.id', async () => {
    expect(f.cognitoSubA).not.toBe(f.userA);
    await expect(service.getOwnedAccount(f.accountA, f.cognitoSubA)).rejects.toMatchObject({
      status: 404,
    });
    expect((await service.getOwnedAccount(f.accountA, f.userA)).id).toBe(f.accountA);
  });

  it('TC-55-15 resolves the exported provider through its real Nest module and PostgreSQL', async () => {
    const context = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          ...fixture.source.options,
          synchronize: false,
          migrationsRun: false,
        }),
        AccountsModule,
      ],
    }).compile();
    try {
      const provider = context.get(AccountsService);
      expect(provider).toBeInstanceOf(AccountsService);
      expect((await provider.getOwnedAccount(f.accountA, f.userA)).balance).toBe('0');
      await withMoneyProbe(fixture.source, async manager => {
        await provider.lockForUpdate([f.accountA], manager);
        await expect(provider.applyBalanceChange(f.accountA, 0n, manager)).resolves.toBeUndefined();
      });
    } finally {
      await context.close();
    }
  });

  async function ownershipError(account: string, user: string): Promise<NotFoundException> {
    try {
      await service.getOwnedAccount(account, user);
    } catch (error) {
      if (error instanceof NotFoundException) return error;
      throw error;
    }
    throw new Error('Expected ownership rejection');
  }
});
