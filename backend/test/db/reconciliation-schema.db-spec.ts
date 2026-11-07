import {
  createTempDatabase,
  migrate,
  migrateThrough,
  attempt,
  type TempDatabase,
} from '../support/temp-database';

const BASE = 'AddAppendOnlyTriggers1792627200002';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const DETAIL = { accountId: ACCOUNT, balance: '9007199254740993', ledgerBalance: '600000' };
const INSERT = `INSERT INTO reconciliation_runs
  (started_at,finished_at,status,total_debit,total_credit,total_balance,mismatched_accounts,details)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`;

interface Input {
  started: string | null;
  finished: string | null;
  status: string | null;
  debit: string | null;
  credit: string | null;
  balance: string | null;
  count: number | string | null;
  details: string | null;
}
interface Run {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  total_debit: string | null;
  total_credit: string | null;
  total_balance: string | null;
  mismatched_accounts: number;
  details: unknown;
}
interface Column {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  is_identity: string;
  identity_generation: string | null;
}
const parameters = (input: Partial<Input> = {}): unknown[] => {
  const row: Input = {
    started: '2026-11-03T01:00:00Z',
    finished: '2026-11-03T01:00:01Z',
    status: 'MISMATCH',
    debit: '600000',
    credit: '600000',
    balance: '0',
    count: 1,
    details: JSON.stringify([DETAIL]),
    ...input,
  };
  return [
    row.started,
    row.finished,
    row.status,
    row.debit,
    row.credit,
    row.balance,
    row.count,
    row.details,
  ];
};

describe('reconciliation storage schema on PostgreSQL', () => {
  let db: TempDatabase;
  let baseFunctions: unknown[];
  let baseFunding: unknown[];
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    db.runner.query(sql, params) as Promise<T[]>;
  const functions = () =>
    q(
      "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname",
    );
  const funding = () => q('SELECT id,type,balance FROM accounts ORDER BY id');
  const insert = async (input: Partial<Input> = {}): Promise<Run> =>
    (await q<Run>(INSERT, parameters(input)))[0];
  async function rejected(
    input: Partial<Input>,
    code: string,
    extra: Record<string, unknown> = {},
  ) {
    await expect(attempt(db.runner, INSERT, parameters(input))).rejects.toMatchObject({
      driverError: { code, ...extra },
    });
  }
  const invalidDetails = (value: unknown) =>
    rejected({ details: JSON.stringify(value) }, '23514', {
      constraint: 'reconciliation_runs_details_check',
    });

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrateThrough(db.url, BASE);
    baseFunctions = await functions();
    baseFunding = await funding();
    await migrate(db.url);
  });
  beforeEach(async () => db.runner.startTransaction());
  afterEach(async () => {
    if (db?.runner.isTransactionActive) await db.runner.rollbackTransaction();
  });
  afterAll(async () => db?.drop());

  it('TC-116-01 exact nine columns, named constraints, identity and no extra objects', async () => {
    const columns = await q<Column>(
      "SELECT column_name,data_type,is_nullable,column_default,is_identity,identity_generation FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_runs' ORDER BY ordinal_position",
    );
    expect(columns.map(c => c.column_name)).toEqual([
      'id',
      'started_at',
      'finished_at',
      'status',
      'total_debit',
      'total_credit',
      'total_balance',
      'mismatched_accounts',
      'details',
    ]);
    expect(columns.map(c => c.data_type)).toEqual([
      'bigint',
      'timestamp with time zone',
      'timestamp with time zone',
      'text',
      'bigint',
      'bigint',
      'bigint',
      'integer',
      'jsonb',
    ]);
    expect(columns.map(c => c.is_nullable)).toEqual([
      'NO',
      'NO',
      'YES',
      'NO',
      'YES',
      'YES',
      'YES',
      'NO',
      'YES',
    ]);
    expect(columns[0]).toMatchObject({ is_identity: 'YES', identity_generation: 'ALWAYS' });
    expect(columns.map(c => c.column_default)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      '0',
      null,
    ]);
    const constraints = await q<{ conname: string; definition: string }>(
      "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.reconciliation_runs'::regclass ORDER BY conname",
    );
    expect(constraints.map(c => c.conname)).toEqual([
      'reconciliation_runs_details_check',
      'reconciliation_runs_pkey',
      'reconciliation_runs_status_check',
    ]);
    expect(constraints[0].definition).toContain('jsonb_path_query_array');
    expect(constraints[0].definition).toContain('IS TRUE');
    for (const status of ['OK', 'MISMATCH', 'ERROR'])
      expect(constraints[2].definition).toContain(status);
    expect(
      await q(
        "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='reconciliation_runs' ORDER BY indexname",
      ),
    ).toEqual([{ indexname: 'reconciliation_runs_pkey' }]);
    expect(
      await q(
        "SELECT tgname FROM pg_trigger WHERE tgrelid='public.reconciliation_runs'::regclass AND NOT tgisinternal",
      ),
    ).toEqual([]);
    expect(await functions()).toEqual(baseFunctions);
    expect(await funding()).toEqual(baseFunding);
  });

  it('TC-116-02 generated ids are strings and omitted count defaults to zero', async () => {
    const rows = await q<Run>(
      "INSERT INTO reconciliation_runs(started_at,status) VALUES($1,'OK'),($1,'ERROR') RETURNING *",
      ['2026-11-03T01:00:00Z'],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
    for (const row of rows) {
      expect(typeof row.id).toBe('string');
      expect(row.id).toMatch(/^[1-9][0-9]*$/);
      expect(row.mismatched_accounts).toBe(0);
      expect(row.finished_at).toBeNull();
      expect(row.details).toBeNull();
    }
  });
  it.each(['OK', 'MISMATCH', 'ERROR'])(
    'TC-116-03 stores status %s with nullable results',
    async status => {
      const row = await insert({
        status,
        finished: null,
        debit: null,
        credit: null,
        balance: null,
        details: null,
      });
      expect(row).toMatchObject({
        status,
        finished_at: null,
        total_debit: null,
        total_credit: null,
        total_balance: null,
        details: null,
      });
    },
  );
  it.each(['RUNNING', '', 'ok', 'mismatch', 'error'])(
    'TC-116-04 refuses invalid status %j',
    async status => {
      await rejected({ status }, '23514', { constraint: 'reconciliation_runs_status_check' });
    },
  );
  it.each([
    ['started', 'started_at'],
    ['status', 'status'],
    ['count', 'mismatched_accounts'],
  ] as const)('TC-116-05 refuses NULL %s', async (key, column) => {
    await rejected({ [key]: null }, '23502', { column });
  });
  it('TC-116-06 timestamptz preserves the instant and nullable finish', async () => {
    const row = await insert({ started: '2026-11-03T08:00:00+07:00', finished: null });
    expect(row.started_at.toISOString()).toBe('2026-11-03T01:00:00.000Z');
    expect(row.finished_at).toBeNull();
  });
  it.each(['0', '9007199254740993', '9223372036854775807', '-9223372036854775808'])(
    'TC-116-07 all three totals round-trip exact bigint %s',
    async value => {
      const row = await insert({ debit: value, credit: value, balance: value });
      expect([row.total_debit, row.total_credit, row.total_balance]).toEqual([value, value, value]);
      expect(JSON.parse(JSON.stringify(row))).toMatchObject({
        total_debit: value,
        total_credit: value,
        total_balance: value,
      });
    },
  );
  for (const key of ['debit', 'credit', 'balance'] as const) {
    it.each(['9223372036854775808', '-9223372036854775809'])(
      `TC-116-08 ${key} overflow %s`,
      async value => {
        await rejected({ [key]: value }, '22003');
      },
    );
    it(`TC-116-08 ${key} rejects a decimal input string`, async () => {
      await rejected({ [key]: '1.5' }, '22P02');
    });
  }
  it.each(['2147483648', '-2147483649'])('TC-116-08 count rejects int overflow %s', async count => {
    await rejected({ count }, '22003');
  });
  it('TC-116-09 identity ALWAYS and named primary key both enforce their contract', async () => {
    await expect(
      attempt(
        db.runner,
        "INSERT INTO reconciliation_runs(id,started_at,status) VALUES(77,$1,'OK')",
        ['2026-11-03T01:00:00Z'],
      ),
    ).rejects.toMatchObject({ driverError: { code: '428C9' } });
    const row = await insert();
    await expect(
      attempt(
        db.runner,
        "INSERT INTO reconciliation_runs(id,started_at,status) OVERRIDING SYSTEM VALUE VALUES($1,$2,'OK')",
        [row.id, '2026-11-03T01:00:00Z'],
      ),
    ).rejects.toMatchObject({
      driverError: { code: '23505', constraint: 'reconciliation_runs_pkey' },
    });
  });

  it.each(
    [
      [],
      [DETAIL],
      [
        DETAIL,
        {
          accountId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
          balance: '-9223372036854775808',
          ledgerBalance: '9223372036854775807',
        },
      ],
      [{ accountId: ACCOUNT, balance: '0', ledgerBalance: '-1' }],
    ].map(details => ({ details })),
  )('TC-116-10 valid details preserve exactly their strings: %j', async ({ details }) => {
    const row = await insert({ details: JSON.stringify(details) });
    expect(row.details).toEqual(details);
  });
  it('TC-116-10 SQL NULL remains distinct from rejected JSON null', async () => {
    expect((await insert({ details: null })).details).toBeNull();
    await invalidDetails(null);
  });
  it.each(
    [null, {}, 'private text', 1, true, [null], [1], ['text'], [[DETAIL]]].map(value => ({
      value,
    })),
  )('TC-116-11 refuses wrong top-level or element shape %j', async ({ value }) =>
    invalidDetails(value),
  );
  it.each(['accountId', 'balance', 'ledgerBalance'] as const)(
    'TC-116-12 refuses missing key %s',
    async key => {
      const item: Record<string, unknown> = { ...DETAIL };
      delete item[key];
      await invalidDetails([item]);
    },
  );
  it.each(
    ['not-a-uuid', '11111111111141118111111111111111', '', null, 1, {}, []].map(accountId => ({
      accountId,
    })),
  )('TC-116-12 refuses invalid UUID %j', async ({ accountId }) =>
    invalidDetails([{ ...DETAIL, accountId }]),
  );
  it.each(['name', 'email', 'accountNumber', 'error', 'stack', 'extra'])(
    'TC-116-13 refuses extra %s on INSERT and preserves the old row on UPDATE',
    async key => {
      const row = await insert();
      const payload = JSON.stringify([
        { ...DETAIL, [key]: key === 'extra' ? null : { text: 'private fixture' } },
      ]);
      await rejected({ details: payload }, '23514', {
        constraint: 'reconciliation_runs_details_check',
      });
      await expect(
        attempt(db.runner, 'UPDATE reconciliation_runs SET details=$1::jsonb WHERE id=$2', [
          payload,
          row.id,
        ]),
      ).rejects.toMatchObject({
        driverError: { code: '23514', constraint: 'reconciliation_runs_details_check' },
      });
      expect(
        (await q<Run>('SELECT * FROM reconciliation_runs WHERE id=$1', [row.id]))[0].details,
      ).toEqual([DETAIL]);
    },
  );
  for (const key of ['balance', 'ledgerBalance']) {
    it.each(
      [
        1,
        null,
        true,
        {},
        [],
        '',
        ' 1',
        '1 ',
        '+1',
        '-0',
        '01',
        '-01',
        '1.5',
        '1e3',
        "'; DROP TABLE users; --",
      ].map(value => ({ value })),
    )(`TC-116-14 ${key} refuses noncanonical value %j`, async ({ value }) => {
      await invalidDetails([{ ...DETAIL, [key]: value }]);
      expect(await q("SELECT to_regclass('public.users') AS name")).toEqual([{ name: 'users' }]);
    });
    it.each(['9223372036854775808', '-9223372036854775809', '9'.repeat(100)])(
      `TC-116-15 ${key} rejects overflow without a CHECK-NULL bypass: %s`,
      async value => invalidDetails([{ ...DETAIL, [key]: value }]),
    );
  }
  it('TC-116-16 one invalid middle element rejects the entire array; key order is irrelevant', async () => {
    await invalidDetails([DETAIL, { ...DETAIL, balance: null }, DETAIL]);
    const item = {
      ledgerBalance: DETAIL.ledgerBalance,
      balance: DETAIL.balance,
      accountId: ACCOUNT,
    };
    expect((await insert({ details: JSON.stringify([item]) })).details).toEqual([DETAIL]);
  });
  it('TC-116-17 storage adds no foreign key or unapproved cross-field business constraints', async () => {
    const item = {
      accountId: '00000000-0000-0000-0000-000000000000',
      balance: '0',
      ledgerBalance: '0',
    };
    const row = await insert({
      status: 'OK',
      finished: '2026-11-02T01:00:00Z',
      balance: '5',
      count: 7,
      details: JSON.stringify([item, item]),
    });
    expect(row).toMatchObject({
      status: 'OK',
      total_balance: '5',
      mismatched_accounts: 7,
      details: [item, item],
    });
  });
});
