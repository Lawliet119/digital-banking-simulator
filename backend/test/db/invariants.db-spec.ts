import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  const npmFile = process.env.npm_execpath!;
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
    return spawnSync(
      process.execPath,
      [npmFile, 'run', '--silent', 'check:invariants', ...(args.length ? ['--', ...args] : [])],
      {
        cwd: backend,
        env: childEnvironment(overrides),
        encoding: 'utf8',
        timeout: 45_000,
      },
    );
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
  it('TC-69-19 raw SQL and function agree and ignore search_path shadow tables', async () => {
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
  it.each([
    'ssl',
    'sslmode',
    'sslcert',
    'sslkey',
    'sslrootcert',
    'sslnegotiation',
    'SSLMODE',
    'uselibpqcompat',
  ])('TC-69-16 rejects URL TLS override %s before connecting', key => {
    const url = new URL(db.url);
    url.searchParams.set(key, key === 'sslnegotiation' ? 'direct' : 'SENTINEL');
    expectSafeError(cli([], { DATABASE_URL: url.toString() }), 'INVALID_CONFIG');
  });
  it.each([
    ['missing URL', { DATABASE_URL: '' }],
    ['malformed URL', { DATABASE_URL: 'INVALID_URL_SENTINEL' }],
    ['production without TLS', { NODE_ENV: 'production', DATABASE_SSL: 'false' }],
    ['unreadable CA', { DATABASE_SSL: 'true', DATABASE_SSL_CA_PATH: 'MISSING_CA_SENTINEL.pem' }],
  ] as const)('TC-69-16 rejects %s without echoing configuration values', (_name, env) => {
    expectSafeError(cli([], env), 'INVALID_CONFIG');
  });
  it('TC-69-16 --help does not need a DB and unexpected arguments fail safely', () => {
    const help = cli(['--help'], { DATABASE_URL: '' });
    expect(help.status).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('check:invariants');
    expectSafeError(cli(['UNEXPECTED_SENTINEL']), 'INVALID_ARGUMENT');
  });
  it('TC-69-16 the real pg parser preserves the configured CA and certificate verification for accepted URLs', () => {
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
  it('TC-69-17 missing schema is ERROR 42P01, never a clean empty database', async () => {
    const empty = await createTempDatabase();
    try {
      const result = cli([], { DATABASE_URL: empty.url });
      expectSafeError(result);
      expect(JSON.parse(result.stderr)).toMatchObject({ databaseCode: '42P01' });
    } finally {
      await empty.drop();
    }
  });
  it('TC-69-17 missing SELECT is ERROR 42501', async () => {
    const role = await roleWith([]);
    await db.runner.commitTransaction();
    const url = new URL(db.url);
    url.searchParams.set('options', `-c role=${role}`);
    const result = cli([], { DATABASE_URL: url.toString() });
    expectSafeError(result);
    expect(JSON.parse(result.stderr)).toMatchObject({ databaseCode: '42501' });
  });
  it('TC-69-17 authentication failure does not expose credentials', () => {
    const url = new URL(db.url);
    url.password = 'WRONG_PASSWORD_SENTINEL';
    const result = cli([], { DATABASE_URL: url.toString() });
    expectSafeError(result);
    expect(JSON.parse(result.stderr)).toMatchObject({ databaseCode: '28P01' });
  });
  it('TC-69-17 a real pool error event cannot log its raw message or emit PASS', async () => {
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
  it('TC-69-19 import from another cwd neither loads env nor connects or executes the CLI', () => {
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
