import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { DataSource, type QueryRunner } from 'typeorm';
import { buildSslOptions } from '@database/pg-ssl';
import { checkLedgerInvariants } from '../support/invariants';
import {
  INVARIANT_FUNDING_ID,
  invariantState,
  postInvariantTransfer,
  seedInvariantAccounts,
  seedInvariantLedger,
} from '../support/invariant-fixtures';
import {
  createTempDatabase,
  migrate,
  requireDatabaseUrl,
  type TempDatabase,
} from '../support/temp-database';

describe('DBS-69 ledger invariant checks (real PostgreSQL)', () => {
  let db: TempDatabase;
  let server: DataSource;
  let roles: string[];

  beforeAll(async () => {
    server = await new DataSource({ type: 'postgres', url: requireDatabaseUrl() }).initialize();
  });
  afterAll(async () => {
    await server?.destroy();
  });
  beforeEach(async () => {
    roles = [];
    db = await createTempDatabase();
    await migrate(db.url);
    await db.runner.startTransaction();
  });
  afterEach(async () => {
    try {
      if (db?.runner.isTransactionActive) await db.runner.rollbackTransaction();
      await db?.drop();
    } finally {
      for (const role of roles) await server.query(`DROP ROLE "${role}"`);
    }
  });

  async function roleWith(grants: string[]): Promise<string> {
    const role = `dbs_test_inv_${randomBytes(6).toString('hex')}`;
    if (!/^dbs_test_inv_[0-9a-f]{12}$/.test(role)) throw new Error('Unsafe fixture role');
    await server.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    roles.push(role);
    await db.runner.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    for (const grant of grants) await db.runner.query(`${grant} TO "${role}"`);
    return role;
  }
  async function removeFixtureLedgerKeys() {
    await db.runner.query(`ALTER TABLE public.ledger_entries
      DROP CONSTRAINT ledger_entries_transfer_debit_fkey,
      DROP CONSTRAINT ledger_entries_transfer_credit_fkey`);
  }

  const backend = resolve(__dirname, '../..');
  const cliFile = resolve(backend, 'test/support/invariants.ts');
  const tsNodeArgs = [
    '-r',
    require.resolve('ts-node/register'),
    '-r',
    require.resolve('tsconfig-paths/register'),
    cliFile,
  ];
  function childEnvironment(overrides: Record<string, string | undefined> = {}) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: db.url,
      DATABASE_SSL: 'false',
      ...overrides,
    };
    for (const key of [
      'DATABASE_SSL_CA_PATH',
      'REDIS_URL',
      'SQS_RISK_QUEUE_URL',
      'SQS_NOTIFICATION_QUEUE_URL',
      'COGNITO_ISSUER',
    ]) {
      if (!(key in overrides)) delete env[key];
    }
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    return env;
  }
  function cli(args: string[] = [], overrides: Record<string, string | undefined> = {}) {
    return spawnSync(process.execPath, [...tsNodeArgs, ...args], {
      cwd: backend,
      env: childEnvironment(overrides),
      encoding: 'utf8',
      timeout: 45_000,
    });
  }
  function expectInvalid(result: ReturnType<typeof cli>, invalid: string[]) {
    expectSafeError(result, 'INVALID_CONFIG');
    expect((JSON.parse(result.stderr) as { invalid?: unknown }).invalid).toEqual(invalid);
  }
  function expectSafeError(result: ReturnType<typeof cli>, kind = 'CHECK_ERROR') {
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toBe('');
    expect(result.stderr).not.toMatch(
      /SENTINEL|postgres(?:ql)?:\/\/|QueryFailedError|Error:|\bat \w+\s*\(/,
    );
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'ERROR', kind });
  }

  it('TC-69-01 accepts fresh migrated funding and an empty ledger', async () => {
    expect(await checkLedgerInvariants(db.runner)).toEqual({
      status: 'PASS',
      totals: { debit: '0', credit: '0', balance: '0' },
      violations: [],
    });
  });
  it('TC-69-02 includes funding, locked/savings/unused accounts and ignores rejected orders without entries', async () => {
    await seedInvariantLedger(db.runner);
    expect(await checkLedgerInvariants(db.runner)).toEqual({
      status: 'PASS',
      totals: { debit: '1250000', credit: '1250000', balance: '0' },
      violations: [],
    });
  });
  it('TC-69-03 detects both account mismatches even when their errors cancel globally', async () => {
    const refs = await seedInvariantLedger(db.runner);
    await db.runner.query('UPDATE accounts SET balance=balance+1 WHERE id=$1', [refs.senderId]);
    await db.runner.query('UPDATE accounts SET balance=balance-1 WHERE id=$1', [refs.recipientId]);
    const report = await checkLedgerInvariants(db.runner);
    expect(report.status).toBe('FAIL');
    expect(report.totals.balance).toBe('0');
    expect(report.violations).toHaveLength(2);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        {
          check: 'account_balances',
          accountId: refs.senderId,
          transferId: null,
          actual: { balance: '750001' },
          expected: { balance: '750000' },
        },
        {
          check: 'account_balances',
          accountId: refs.recipientId,
          transferId: null,
          actual: { balance: '249999' },
          expected: { balance: '250000' },
        },
      ]),
    );
  });
  it.each(['DEBIT', 'CREDIT'] as const)(
    'TC-69-04 detects a lone %s and names its transfer',
    async direction => {
      const refs = await seedInvariantAccounts(db.runner);
      const id = await postInvariantTransfer(db.runner, {
        actorId: refs.actorId,
        from: INVARIANT_FUNDING_ID,
        to: refs.senderId,
        amount: '100',
        type: 'DEPOSIT',
        entries: [
          {
            direction,
            accountId: direction === 'DEBIT' ? INVARIANT_FUNDING_ID : refs.senderId,
            amount: '100',
          },
        ],
      });
      const report = await checkLedgerInvariants(db.runner);
      expect(report.status).toBe('FAIL');
      expect(report.violations.some(v => v.check === 'ledger_totals')).toBe(true);
      expect(report.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ check: 'completed_pairs', transferId: id }),
        ]),
      );
      expect(report.totals).toMatchObject(
        direction === 'DEBIT' ? { debit: '100', credit: '0' } : { debit: '0', credit: '100' },
      );
    },
  );
  it('TC-69-05 detects a one-dong global balance error and the affected account', async () => {
    const refs = await seedInvariantLedger(db.runner);
    await db.runner.query('UPDATE accounts SET balance=balance+1 WHERE id=$1', [refs.senderId]);
    const report = await checkLedgerInvariants(db.runner);
    expect(report.totals.balance).toBe('1');
    expect(report.violations).toEqual([
      {
        check: 'account_balances',
        accountId: refs.senderId,
        transferId: null,
        actual: { balance: '750001' },
        expected: { balance: '750000' },
      },
      {
        check: 'total_balances',
        accountId: null,
        transferId: null,
        actual: { balance: '1' },
        expected: { balance: '0' },
      },
    ]);
  });
  it('TC-69-06 detects a negative legacy customer; rollback restores the CHECK', async () => {
    const refs = await seedInvariantAccounts(db.runner);
    await db.runner.query('ALTER TABLE accounts DROP CONSTRAINT accounts_balance_non_negative');
    await db.runner.query('UPDATE accounts SET balance=-1 WHERE id=$1', [refs.unusedId]);
    const report = await checkLedgerInvariants(db.runner);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'customer_balances',
          accountId: refs.unusedId,
          actual: { balance: '-1' },
        }),
      ]),
    );
    await db.runner.rollbackTransaction();
    const [{ present }] = await db.runner.query(
      "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.accounts'::regclass AND conname='accounts_balance_non_negative') AS present",
    );
    expect(present).toBe(true);
  });
  it('TC-69-07 detects a completed transfer with zero entries even when all totals are zero', async () => {
    const refs = await seedInvariantAccounts(db.runner);
    const id = await postInvariantTransfer(db.runner, {
      actorId: refs.actorId,
      from: refs.senderId,
      to: refs.recipientId,
      amount: '100',
      entries: [],
    });
    const report = await checkLedgerInvariants(db.runner);
    expect(report.status).toBe('FAIL');
    expect(report.totals).toEqual({ debit: '0', credit: '0', balance: '0' });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({
      check: 'completed_pairs',
      transferId: id,
      actual: { debitCount: '0', creditCount: '0', debitAccountId: null, creditAccountId: null },
    });
  });
  it.each(['amount', 'source', 'target'] as const)(
    'TC-69-08 detects legacy pair with incorrect %s in isolation',
    async wrong => {
      const refs = await seedInvariantLedger(db.runner);
      await removeFixtureLedgerKeys();
      const debitId = wrong === 'source' ? INVARIANT_FUNDING_ID : refs.senderId;
      const creditId = wrong === 'target' ? refs.unusedId : refs.recipientId;
      const amount = wrong === 'amount' ? '99' : '100';
      const id = await postInvariantTransfer(db.runner, {
        actorId: refs.actorId,
        from: refs.senderId,
        to: refs.recipientId,
        amount: '100',
        entries: [
          { direction: 'DEBIT', accountId: debitId, amount },
          { direction: 'CREDIT', accountId: creditId, amount },
        ],
      });
      const report = await checkLedgerInvariants(db.runner);
      expect(report.status).toBe('FAIL');
      expect(report.totals.balance).toBe('0');
      expect(report.totals.debit).toBe(report.totals.credit);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0]).toMatchObject({
        check: 'completed_pairs',
        transferId: id,
        actual: {
          debitCount: '1',
          creditCount: '1',
          debitAmount: amount,
          creditAmount: amount,
          debitAccountId: debitId,
          creditAccountId: creditId,
        },
        expected: { amount: '100', fromAccountId: refs.senderId, toAccountId: refs.recipientId },
      });
    },
  );
  it('TC-69-09 detects opposite per-transfer errors that balance globally', async () => {
    const refs = await seedInvariantLedger(db.runner);
    await removeFixtureLedgerKeys();
    const ids: string[] = [];
    for (const [debit, credit] of [
      ['100', '99'],
      ['99', '100'],
    ]) {
      ids.push(
        await postInvariantTransfer(db.runner, {
          actorId: refs.actorId,
          from: refs.senderId,
          to: refs.recipientId,
          amount: '100',
          entries: [
            { direction: 'DEBIT', accountId: refs.senderId, amount: debit },
            { direction: 'CREDIT', accountId: refs.recipientId, amount: credit },
          ],
        }),
      );
    }
    const report = await checkLedgerInvariants(db.runner);
    expect(report.totals).toEqual({ debit: '1250199', credit: '1250199', balance: '0' });
    expect(report.violations).toHaveLength(2);
    expect(report.violations.map(v => v.transferId).sort()).toEqual(ids.sort());
    expect(report.violations.every(v => v.check === 'completed_pairs')).toBe(true);
  });
  it.each(['9007199254740993', '9223372036854775807'])(
    'TC-69-10 preserves %s and aggregates above int64, then detects a one-dong error',
    async amount => {
      const refs = await seedInvariantAccounts(db.runner);
      for (const [from, to, type] of [
        [INVARIANT_FUNDING_ID, refs.senderId, 'DEPOSIT'],
        [refs.senderId, refs.recipientId, 'TRANSFER'],
        [refs.recipientId, refs.senderId, 'TRANSFER'],
      ] as const) {
        await postInvariantTransfer(db.runner, { actorId: refs.actorId, from, to, type, amount });
      }
      const total = (BigInt(amount) * 3n).toString();
      expect(await checkLedgerInvariants(db.runner)).toEqual({
        status: 'PASS',
        totals: { debit: total, credit: total, balance: '0' },
        violations: [],
      });
      await db.runner.query('UPDATE accounts SET balance=balance+1 WHERE id=$1', [
        refs.recipientId,
      ]);
      const report = await checkLedgerInvariants(db.runner);
      expect(report.status).toBe('FAIL');
      expect(report.totals).toEqual({ debit: total, credit: total, balance: '1' });
    },
  );
  it('TC-69-11 reads committed snapshots while a real concurrent writer holds uncommitted changes', async () => {
    const refs = await seedInvariantLedger(db.runner);
    await db.runner.commitTransaction();
    const source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const writer = source.createQueryRunner();
    await writer.connect();
    try {
      await writer.startTransaction();
      await postInvariantTransfer(writer, {
        actorId: refs.actorId,
        from: refs.senderId,
        to: refs.recipientId,
        amount: '100',
      });
      expect(writer.isTransactionActive).toBe(true);
      expect((await checkLedgerInvariants(db.runner)).totals).toEqual({
        debit: '1250000',
        credit: '1250000',
        balance: '0',
      });
      await writer.commitTransaction();
      const report = await checkLedgerInvariants(db.runner);
      expect(report.status).toBe('PASS');
      expect(report.totals).toEqual({ debit: '1250100', credit: '1250100', balance: '0' });
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
      await source.destroy();
    }
  });
  it('TC-69-12 uses one real query and leaves the caller transaction and rollback intact', async () => {
    const refs = await seedInvariantLedger(db.runner);
    await db.runner.query('UPDATE accounts SET balance=balance+1 WHERE id=$1', [refs.senderId]);
    const spy = jest.spyOn(db.runner, 'query');
    try {
      expect((await checkLedgerInvariants(db.runner)).status).toBe('FAIL');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(db.runner.isTransactionActive).toBe(true);
    } finally {
      spy.mockRestore();
    }
    await db.runner.rollbackTransaction();
    expect(await checkLedgerInvariants(db.runner)).toEqual({
      status: 'PASS',
      totals: { debit: '0', credit: '0', balance: '0' },
      violations: [],
    });
  });
  it('TC-69-13 proves NOSUPERUSER table-owner corruption, detection, restore and unchanged ledger', async () => {
    const refs = await seedInvariantLedger(db.runner);
    const role = await roleWith([]);
    await db.runner.query(`ALTER TABLE accounts OWNER TO "${role}"`);
    await db.runner.commitTransaction();
    const before = await invariantState(db.runner);
    expect((await checkLedgerInvariants(db.runner)).status).toBe('PASS');
    for (const delta of [1, -1]) {
      await db.runner.startTransaction();
      await db.runner.query(`SET LOCAL ROLE "${role}"`);
      const [owner] = await db.runner.query(
        "SELECT r.rolsuper,pg_get_userbyid(c.relowner)=current_user AS owns FROM pg_class c JOIN pg_roles r ON r.rolname=current_user WHERE c.oid='public.accounts'::regclass",
      );
      expect(owner).toEqual({ rolsuper: false, owns: true });
      await db.runner.query('UPDATE accounts SET balance=balance+$2::bigint WHERE id=$1', [
        refs.senderId,
        delta.toString(),
      ]);
      await db.runner.commitTransaction();
      const report = await checkLedgerInvariants(db.runner);
      expect(report.status).toBe(delta === 1 ? 'FAIL' : 'PASS');
      if (delta === 1) expect(report.violations[0].accountId).toBe(refs.senderId);
      const after = await invariantState(db.runner);
      expect(after.entries).toEqual(before.entries);
      expect(after.transfers).toEqual(before.transfers);
    }
    expect(await invariantState(db.runner)).toEqual(before);
  });
  it('TC-69-14 works SELECT-only and READ ONLY without changing rows or exposing identity', async () => {
    await seedInvariantLedger(db.runner);
    const role = await roleWith([
      'GRANT SELECT ON public.accounts,public.transfers,public.ledger_entries',
    ]);
    await db.runner.commitTransaction();
    const before = await invariantState(db.runner);
    await db.runner.startTransaction();
    await db.runner.query('SET TRANSACTION READ ONLY');
    await db.runner.query(`SET LOCAL ROLE "${role}"`);
    const report = await checkLedgerInvariants(db.runner);
    expect(report.status).toBe('PASS');
    expect(JSON.stringify(report)).not.toMatch(
      /full_name|cognito_sub|Nguyễn|Trần|nguyen-minh|tran-lan/,
    );
    const [{ allowed }] = await db.runner.query(
      "SELECT has_table_privilege(current_user,'public.accounts','UPDATE') AS allowed",
    );
    expect(allowed).toBe(false);
    await db.runner.commitTransaction();
    expect(await invariantState(db.runner)).toEqual(before);
  });
  it('TC-69-18 propagates a real statement timeout then succeeds after lock release', async () => {
    await seedInvariantLedger(db.runner);
    await db.runner.commitTransaction();
    const source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const locker: QueryRunner = source.createQueryRunner();
    await locker.connect();
    try {
      await locker.startTransaction();
      await locker.query('LOCK TABLE public.ledger_entries IN ACCESS EXCLUSIVE MODE');
      await db.runner.startTransaction();
      await db.runner.query("SET LOCAL statement_timeout='100ms'");
      await expect(checkLedgerInvariants(db.runner)).rejects.toMatchObject({
        driverError: { code: '57014' },
      });
    } finally {
      if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
      if (locker.isTransactionActive) await locker.rollbackTransaction();
      await locker.release();
      await source.destroy();
    }
    expect((await checkLedgerInvariants(db.runner)).status).toBe('PASS');
  });
  it('TC-69-19a raw SQL and function agree and ignore search_path shadow tables', async () => {
    const refs = await seedInvariantLedger(db.runner);
    await db.runner.query('UPDATE public.accounts SET balance=balance+1 WHERE id=$1', [
      refs.senderId,
    ]);
    for (const table of ['accounts', 'transfers', 'ledger_entries'])
      await db.runner.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await db.runner.query('SET LOCAL search_path=pg_temp,public');
    const sql = readFileSync(resolve(__dirname, '../support/invariants.sql'), 'utf8');
    const [{ report }] = await db.runner.query(sql);
    const fromFunction = await checkLedgerInvariants(db.runner);
    expect(fromFunction).toEqual(report);
    expect(fromFunction.status).toBe('FAIL');
    expect(fromFunction.violations[0].accountId).toBe(refs.senderId);
  });

  it('TC-69-15 CLI reports committed clean, mismatch and recovery with exit 0/1/0', async () => {
    const refs = await seedInvariantLedger(db.runner);
    await db.runner.commitTransaction();
    for (const [delta, status, exit] of [
      [0, 'PASS', 0],
      [1, 'FAIL', 1],
      [-1, 'PASS', 0],
    ] as const) {
      if (delta)
        await db.runner.query('UPDATE accounts SET balance=balance+$2::bigint WHERE id=$1', [
          refs.senderId,
          delta.toString(),
        ]);
      const result = cli();
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(exit);
      const report: unknown = JSON.parse(result.stdout);
      expect(report).toEqual(await checkLedgerInvariants(db.runner));
      expect(report).toMatchObject({ status });
    }
  });
  it('TC-69-15n the npm script check:invariants runs the same CLI', async () => {
    const npmFile = process.env.npm_execpath;
    if (!npmFile) {
      throw new Error(
        'TC-69-15n needs npm_execpath: run the suite through npm (npm run test:db), not jest directly',
      );
    }
    const refs = await seedInvariantLedger(db.runner);
    await db.runner.commitTransaction();
    const run = () =>
      spawnSync(process.execPath, [npmFile, 'run', '--silent', 'check:invariants'], {
        cwd: backend,
        env: childEnvironment(),
        encoding: 'utf8',
        timeout: 45_000,
      });
    const clean = run();
    expect(clean.error).toBeUndefined();
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ status: 'PASS' });
    await db.runner.query('UPDATE accounts SET balance=balance+1 WHERE id=$1', [refs.senderId]);
    const dirty = run();
    expect(dirty.status).toBe(1);
    expect(JSON.parse(dirty.stdout)).toMatchObject({ status: 'FAIL' });
    await db.runner.query('UPDATE accounts SET balance=balance-1 WHERE id=$1', [refs.senderId]);
  });
  it.each([
    'ssl',
    'sslmode',
    'sslcert',
    'sslkey',
    'sslrootcert',
    'sslnegotiation',
    'SSLMODE',
    'uselibpqcompat',
  ])('TC-69-16a rejects URL TLS override %s before connecting', key => {
    const url = new URL(db.url);
    url.searchParams.set(key, key === 'sslnegotiation' ? 'direct' : 'SENTINEL');
    expectInvalid(cli([], { DATABASE_URL: url.toString() }), ['DATABASE_URL']);
  });
  // A complete DB_* set with a valid DB_HOST: composeDatabaseUrl returns no URL when DB_HOST is
  // undefined, so a lone DB_PORT would report DATABASE_URL instead of DB_PORT.
  const DB_PARTS = {
    DATABASE_URL: '',
    DB_HOST: '127.0.0.1',
    DB_PORT: '5432',
    DB_NAME: 'banking',
    DB_USER: 'banking',
    DB_PASSWORD: 'PASSWORD_SENTINEL',
  };
  it.each([
    ['missing URL', { DATABASE_URL: '' }, ['DATABASE_URL']],
    ['malformed URL', { DATABASE_URL: 'INVALID_URL_SENTINEL' }, ['DATABASE_URL']],
    ['production without TLS', { NODE_ENV: 'production', DATABASE_SSL: 'false' }, ['DATABASE_SSL']],
    [
      'unreadable CA',
      { DATABASE_SSL: 'true', DATABASE_SSL_CA_PATH: 'MISSING_CA_SENTINEL.pem' },
      ['DATABASE_SSL_CA_PATH'],
    ],
    ['malformed DB_PORT', { ...DB_PARTS, DB_PORT: 'abc' }, ['DB_PORT']],
    ['empty DB_USER', { ...DB_PARTS, DB_USER: ' ' }, ['DB_USER']],
  ] as const)('TC-69-16b rejects %s and names only the variable', (_name, env, invalid) => {
    const result = cli([], env);
    expectInvalid(result, [...invalid]);
    expect(result.stderr).not.toMatch(/SENTINEL|abc/);
  });
  it('TC-69-16c --help does not need a DB and unexpected arguments fail safely', () => {
    const help = cli(['--help'], { DATABASE_URL: '' });
    expect(help.status).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('check:invariants');
    for (const name of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
      expect(help.stdout).toContain(name);
    }
    expect(help.stdout).toContain('exit code is authoritative');
    expect(help.stdout).not.toContain('2 check error.');
    expectSafeError(cli(['UNEXPECTED_SENTINEL']), 'INVALID_ARGUMENT');
  });
  async function loginRole(password: string): Promise<string> {
    const role = `dbs_test_inv_${randomBytes(6).toString('hex')}`;
    if (!/^dbs_test_inv_[0-9a-f]{12}$/.test(role)) throw new Error('Unsafe fixture role');
    await server.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password.replace(/'/g, "''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
    await db.runner.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    for (const table of ['accounts', 'transfers', 'ledger_entries']) {
      await db.runner.query(`GRANT SELECT ON public.${table} TO "${role}"`);
    }
    return role;
  }
  function dbParts(role: string, password: string, overrides: Record<string, string> = {}) {
    const url = new URL(db.url);
    return {
      DATABASE_URL: '',
      DB_HOST: url.hostname,
      DB_PORT: url.port || '5432',
      DB_NAME: decodeURIComponent(url.pathname.slice(1)),
      DB_USER: role,
      DB_PASSWORD: password,
      ...overrides,
    };
  }
  it('TC-69-21 the ECS DB_* parts are used when DATABASE_URL is empty, and DATABASE_URL wins when set', async () => {
    // beforeAll of this block guarantees an env file cannot add DB_* behind the test's back.
    expect(existsSync(resolve(backend, 'env/.env.test'))).toBe(false);
    const password = 'p@ss:w/rd?x#%y';
    const role = await loginRole(password);
    await seedInvariantLedger(db.runner);
    await db.runner.commitTransaction();
    // (a) DATABASE_URL empty, DB_* correct (password with @ : / ? # %): the parts are composed.
    const composed = cli([], dbParts(role, password));
    expect(composed.stderr).toBe('');
    expect(composed.status).toBe(0);
    expect(JSON.parse(composed.stdout)).toMatchObject({ status: 'PASS' });
    expect(composed.stdout).not.toContain(password);
    // (b) a valid DATABASE_URL wins over DB_* that would fail to log in.
    const urlWins = cli([], { ...dbParts(role, 'WRONG_PASSWORD_SENTINEL'), DATABASE_URL: db.url });
    expect(urlWins.status).toBe(0);
    expect(JSON.parse(urlWins.stdout)).toMatchObject({ status: 'PASS' });
    // (c) no URL and DB_* with a wrong password: the parts were really used, so login fails.
    const wrong = cli([], dbParts(role, 'WRONG_PASSWORD_SENTINEL'));
    expectSafeError(wrong);
    expect(JSON.parse(wrong.stderr)).toMatchObject({ databaseCode: '28P01' });
  });
  it('TC-69-16d the real pg parser preserves the configured CA and certificate verification for accepted URLs', () => {
    const ssl = buildSslOptions({ enabled: true, caPath: 'fixture.pem' }, () => 'FIXTURE_CA');
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const assert = require('node:assert/strict');
      const client = new (require('pg').Client)({ connectionString: process.env.DATABASE_URL, ssl: ${JSON.stringify(ssl)} });
      assert.deepEqual(client.ssl, {rejectUnauthorized:true, ca:'FIXTURE_CA'});
      console.log('TLS_PRESERVED');
    `,
      ],
      { cwd: backend, env: childEnvironment(), encoding: 'utf8', timeout: 10_000 },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toBe('TLS_PRESERVED');
    expect(probe.stderr).toBe('');
  });
  it('TC-69-17a missing schema is ERROR 42P01, never a clean empty database', async () => {
    const empty = await createTempDatabase();
    try {
      const result = cli([], { DATABASE_URL: empty.url });
      expectSafeError(result);
      expect(JSON.parse(result.stderr)).toMatchObject({ databaseCode: '42P01' });
    } finally {
      await empty.drop();
    }
  });
  it('TC-69-17b missing SELECT is ERROR 42501', async () => {
    const role = await roleWith([]);
    await db.runner.commitTransaction();
    const url = new URL(db.url);
    url.searchParams.set('options', `-c role=${role}`);
    const result = cli([], { DATABASE_URL: url.toString() });
    expectSafeError(result);
    expect(JSON.parse(result.stderr)).toMatchObject({ databaseCode: '42501' });
  });
  it('TC-69-17c authentication failure does not expose credentials', () => {
    const url = new URL(db.url);
    url.password = 'WRONG_PASSWORD_SENTINEL';
    const result = cli([], { DATABASE_URL: url.toString() });
    expectSafeError(result);
    expect(JSON.parse(result.stderr)).toMatchObject({ databaseCode: '28P01' });
  });
  it('TC-69-17d a real pool error event cannot log its raw message or emit PASS', async () => {
    await seedInvariantLedger(db.runner);
    await db.runner.commitTransaction();
    const script = `
      require(${JSON.stringify(require.resolve('ts-node/register'))});
      require(${JSON.stringify(require.resolve('tsconfig-paths/register'))});
      const pg = require('pg'); const connect = pg.Pool.prototype.connect; let injected = false;
      pg.Pool.prototype.connect = function(...args) {
        if (!injected) { injected = true; this.emit('error', Object.assign(new Error('POOL_SECRET_SENTINEL'), {code:'57P01'})); }
        return connect.apply(this, args);
      };
      process.argv = [process.execPath, ${JSON.stringify(cliFile)}];
      require('node:module').runMain(${JSON.stringify(cliFile)});
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: backend,
      env: childEnvironment(),
      encoding: 'utf8',
      timeout: 45_000,
    });
    expectSafeError(result);
    expect(JSON.parse(result.stderr)).toMatchObject({ databaseCode: '57P01' });
  });

  // TC-69-20: pool/cleanup failures that arrive AFTER the check was committed. The child patches
  // the real pg/TypeORM objects, then runs the real CLI. The marker goes to a temp file, so stdout
  // stays exactly one JSON document and a test cannot pass without the error being injected.
  function childWithPatch(patch: string) {
    const dir = mkdtempSync(join(tmpdir(), 'dbs69-marker-'));
    const marker = join(dir, 'marker.txt');
    const script = `
      require(${JSON.stringify(require.resolve('ts-node/register'))});
      require(${JSON.stringify(require.resolve('tsconfig-paths/register'))});
      const fs = require('node:fs');
      const mark = name => fs.appendFileSync(process.env.DBS69_MARKER_FILE, name + '\\n');
      ${patch}
      process.argv = [process.execPath, ${JSON.stringify(cliFile)}];
      require('node:module').runMain(${JSON.stringify(cliFile)});
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: backend,
      env: { ...childEnvironment(), DBS69_MARKER_FILE: marker },
      encoding: 'utf8',
      timeout: 45_000,
    });
    const marked = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
    rmSync(dir, { recursive: true, force: true });
    return { result, marked };
  }
  // Emit a pool error just before the real pool.end: after release, the client is idle, so the
  // pool really emits 'error' (it only does for idle clients).
  const POOL_ERROR_AFTER_COMMIT = String.raw`
    const pg = require('pg'); const end = pg.Pool.prototype.end;
    pg.Pool.prototype.end = function(...args) {
      mark('POOL_ERROR_EMITTED');
      this.emit('error', Object.assign(new Error('POOL_SECRET_SENTINEL'), { code: '57P01' }));
      return end.apply(this, args);
    };
  `;
  async function seedClean() {
    await seedInvariantLedger(db.runner);
    await db.runner.commitTransaction();
  }
  async function seedDirty() {
    const refs = await seedInvariantLedger(db.runner);
    await db.runner.commitTransaction();
    await db.runner.query('UPDATE accounts SET balance=balance+1 WHERE id=$1', [refs.senderId]);
  }
  it('TC-69-20a a pool error after commit does not change a PASS result', async () => {
    await seedClean();
    const { result, marked } = childWithPatch(POOL_ERROR_AFTER_COMMIT);
    expect(marked).toContain('POOL_ERROR_EMITTED');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'PASS' });
    expect(result.stdout + result.stderr).not.toContain('POOL_SECRET_SENTINEL');
  });
  it('TC-69-20b a pool error after commit does not hide a FAIL result', async () => {
    await seedDirty();
    const { result, marked } = childWithPatch(POOL_ERROR_AFTER_COMMIT);
    expect(marked).toContain('POOL_ERROR_EMITTED');
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'FAIL' });
    expect(result.stdout + result.stderr).not.toContain('POOL_SECRET_SENTINEL');
  });
  // (c) destroy fails AFTER the original ran, so the pool is really closed and the marker is written.
  const DESTROY_FAILS_AFTER_CLOSE = String.raw`
    const pg = require('pg'); const end = pg.Pool.prototype.end;
    pg.Pool.prototype.end = function(...args) { mark('POOL_END_RAN'); return end.apply(this, args); };
    const { DataSource } = require('typeorm'); const destroy = DataSource.prototype.destroy;
    DataSource.prototype.destroy = async function() {
      await destroy.call(this);
      throw Object.assign(new Error('DESTROY_SECRET_SENTINEL'), { code: '57P01' });
    };
  `;
  it('TC-69-20c1 a cleanup error after commit keeps a FAIL result: report printed, exit 1', async () => {
    await seedDirty();
    const { result, marked } = childWithPatch(DESTROY_FAILS_AFTER_CLOSE);
    expect(marked).toContain('POOL_END_RAN');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'FAIL' });
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'ERROR', kind: 'CHECK_ERROR' });
    expect(result.stdout + result.stderr).not.toContain('DESTROY_SECRET_SENTINEL');
  });
  it('TC-69-20c2 a cleanup error after commit on a PASS is not clean: report printed, exit 2', async () => {
    await seedClean();
    const { result, marked } = childWithPatch(DESTROY_FAILS_AFTER_CLOSE);
    expect(marked).toContain('POOL_END_RAN');
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'PASS' });
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'ERROR', kind: 'CHECK_ERROR' });
    expect(result.stdout + result.stderr).not.toContain('DESTROY_SECRET_SENTINEL');
  });
  // (d) the commit itself fails: nothing was committed, so no report is trusted or printed.
  it('TC-69-20d a failing commit prints no report: stdout empty, exit 2', async () => {
    await seedDirty();
    const { result, marked } = childWithPatch(String.raw`
      const { PostgresQueryRunner } = require('typeorm/driver/postgres/PostgresQueryRunner');
      const commit = PostgresQueryRunner.prototype.commitTransaction;
      PostgresQueryRunner.prototype.commitTransaction = async function() {
        mark('COMMIT_PATCHED');
        throw Object.assign(new Error('COMMIT_SECRET_SENTINEL'), { code: '57P01' });
      };
    `);
    expect(marked).toContain('COMMIT_PATCHED');
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'ERROR', kind: 'CHECK_ERROR' });
    expect(result.stdout + result.stderr).not.toContain('COMMIT_SECRET_SENTINEL');
  });
  // (f) release() of ONLY the runner runCli creates throws, after the original ran. TypeORM also
  // creates and releases its own runner inside source.initialize(); that one must stay untouched,
  // so the throw is attached through DataSource.prototype.createQueryRunner.
  const RELEASE_FAILS_AFTER_RETURN = String.raw`
    const pg = require('pg'); const end = pg.Pool.prototype.end;
    pg.Pool.prototype.end = function(...args) { mark('POOL_END_RAN'); return end.apply(this, args); };
    const { DataSource } = require('typeorm'); const create = DataSource.prototype.createQueryRunner;
    DataSource.prototype.createQueryRunner = function(...args) {
      const runner = create.apply(this, args); const release = runner.release.bind(runner);
      runner.release = async function() {
        await release();
        throw Object.assign(new Error('RELEASE_SECRET_SENTINEL'), { code: '57P01' });
      };
      return runner;
    };
  `;
  it('TC-69-20f1 release failing after commit keeps a FAIL result: report printed, exit 1', async () => {
    await seedDirty();
    const { result, marked } = childWithPatch(RELEASE_FAILS_AFTER_RETURN);
    expect(marked).toContain('POOL_END_RAN');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'FAIL' });
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'ERROR', kind: 'CHECK_ERROR' });
    expect(result.stdout + result.stderr).not.toContain('RELEASE_SECRET_SENTINEL');
  });
  it('TC-69-20f2 release failing after commit on a PASS is not clean: report printed, exit 2', async () => {
    await seedClean();
    const { result, marked } = childWithPatch(RELEASE_FAILS_AFTER_RETURN);
    expect(marked).toContain('POOL_END_RAN');
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'PASS' });
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'ERROR', kind: 'CHECK_ERROR' });
    expect(result.stdout + result.stderr).not.toContain('RELEASE_SECRET_SENTINEL');
  });
  // TC-69-17d, dirty variant: a pool error BEFORE commit (inside source.initialize()) is ERROR only,
  // never the FAIL report, even though the commit afterwards succeeds. The run is not trusted.
  it('TC-69-17e a pool error before commit hides even a FAIL report: stdout empty, exit 2', async () => {
    await seedDirty();
    const { result } = childWithPatch(String.raw`
      const pg = require('pg'); const connect = pg.Pool.prototype.connect; let injected = false;
      pg.Pool.prototype.connect = function(...args) {
        if (!injected) { injected = true; mark('POOL_ERROR_BEFORE_COMMIT'); this.emit('error', Object.assign(new Error('POOL_SECRET_SENTINEL'), { code: '57P01' })); }
        return connect.apply(this, args);
      };
    `);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ databaseCode: '57P01' });
    expect(result.stdout + result.stderr).not.toContain('POOL_SECRET_SENTINEL');
  });
  // TC-69-20e: the exit contract changed (exit 2 may come with a PASS report; the exit code is
  // authoritative). Four places state it. Each is cut out by literal markers, so neither the
  // presence of the new wording nor the absence of the old one can be satisfied by another part of
  // a file (this feature doc quotes the old phrase itself).
  function slice(text: string, from: string, to: string): string {
    const start = text.indexOf(from);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf(to, start + from.length);
    expect(end).toBeGreaterThan(start);
    return text.slice(start, end);
  }
  it('TC-69-20e the four places that state the exit contract say the exit code is authoritative', () => {
    const root = resolve(backend, '..');
    const featureDoc = readFileSync(
      resolve(root, 'docs/features/DBS-69-ledger-invariants.md'),
      'utf8',
    );
    const readme = readFileSync(resolve(backend, 'README.md'), 'utf8');
    const cli = readFileSync(cliFile, 'utf8');
    const NEW = 'thẩm quyền cuối cùng';

    // (i) feature doc section 2.2: first full heading, end marker searched after it.
    const doc22 = slice(featureDoc, '\n### 2.2 Hàm và CLI\n', '\n### 2.3 Giới hạn vận hành');
    expect(doc22).toContain(NEW);
    expect(doc22).not.toContain('Không có report PASS/FAIL');

    // (ii) README section 9 up to the literal "## Docker" (its bash block has a "# từ backend/" line).
    const readme9 = slice(readme, '### 9. Kiểm tra bất biến sổ cái', '\n## Docker');
    expect(readme9).toContain('| Exit | Ý nghĩa');
    expect(readme9).toContain(NEW);
    expect(readme9).not.toContain(
      'ERROR trên stderr: cấu hình, kết nối, quyền, schema, I/O hoặc timeout | Kiểm tra chưa hoàn tất',
    );

    // (iii) the single command-table row of the README.
    const rows = readme
      .split('\n')
      .filter(line => line.startsWith('| `npm run check:invariants` |'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(NEW);
    expect(rows[0]).toContain('DB_*');
    expect(rows[0]).not.toContain('2 không hoàn tất kiểm tra');

    // (iv) the --help text: new English phrase present, old one gone.
    expect(cli).toContain('exit code is authoritative');
    expect(cli).not.toContain('2 check error.');
  });
  it('TC-69-19b import from another cwd neither loads env nor connects or executes the CLI', () => {
    const script = `require(${JSON.stringify(require.resolve('dotenv'))}).config = () => { throw new Error('ENV_LOAD_SENTINEL'); }; require(${JSON.stringify(cliFile)}); console.log('IMPORTED');`;
    const result = spawnSync(
      process.execPath,
      [
        '-r',
        require.resolve('ts-node/register'),
        '-r',
        require.resolve('tsconfig-paths/register'),
        '-e',
        script,
      ],
      {
        cwd: resolve(backend, '..'),
        env: childEnvironment({
          DATABASE_URL: 'INVALID_URL_SENTINEL',
          TS_NODE_PROJECT: resolve(backend, 'tsconfig.json'),
        }),
        encoding: 'utf8',
        timeout: 45_000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('IMPORTED');
    expect(result.stderr).toBe('');
  });
});
