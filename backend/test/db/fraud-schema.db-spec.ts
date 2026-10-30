import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { CreateFraudStorage1792713600000 } from '@database/migrations/1792713600000-CreateFraudStorage';
import {
  attempt,
  createTempDatabase,
  migrate,
  migrateThrough,
  requireDatabaseUrl,
  type TempDatabase,
} from '../support/temp-database';

const TARGET = 'CreateFraudStorage1792713600000';
const SEED = {
  mode: 'rule_only',
  thresholds: { medium: 40, high: 70 },
  rules: {
    R1: { enabled: true, weight: 30, maxTransfers: 5, windowMinutes: 10 },
    R2: { enabled: true, weight: 25, medianMultiplier: 5, historyDays: 30, minHistory: 5 },
    R3: {
      enabled: true,
      weight: 35,
      maxAccountAgeHoursExclusive: 24,
      minAmountExclusive: '10000000',
    },
    R4: { enabled: true, weight: 20, reverseWindowMinutes: 60 },
    R5: {
      enabled: true,
      weight: 40,
      minNewRecipients: 5,
      windowMinutes: 60,
      noveltyDays: 30,
      sameOwnerExempt: true,
    },
    R6: {
      enabled: true,
      weight: 30,
      minBalancePercent: 90,
      minBalance: '1000000',
      sameOwnerExempt: true,
    },
  },
  ml: { enabled: false },
};

describe('DBS-58 fraud migration on PostgreSQL', () => {
  let db: TempDatabase;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  beforeEach(async () => {
    db = await createTempDatabase();
    await migrateThrough(db.url, TARGET);
  });
  afterEach(async () => {
    if (db?.runner.isTransactionActive) await db.runner.rollbackTransaction();
    await db?.drop();
  });

  async function fixture() {
    const [user] = await q('INSERT INTO users(cognito_sub) VALUES($1) RETURNING id', [
      randomUUID(),
    ]);
    const [customer] = await q(
      'INSERT INTO customers(user_id,full_name) VALUES($1,$2) RETURNING id',
      [user.id, 'Khach test'],
    );
    const accounts: string[] = [];
    for (const name of ['CHECKING', 'SAVINGS']) {
      const [account] = await q(
        'INSERT INTO accounts(customer_id,type) VALUES($1,$2) RETURNING id',
        [customer.id, name],
      );
      accounts.push(account.id);
    }
    const [transfer] = await q(
      "INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id) VALUES('TRANSFER',$1,$2,'1000000','COMPLETED',$3,$4) RETURNING id",
      [accounts[0], accounts[1], user.id, randomUUID()],
    );
    return { user: user.id as string, transfer: transfer.id as string };
  }

  async function rejected(sql: string, args: unknown[], code: string, constraint: string) {
    await db.runner.startTransaction();
    try {
      await expect(attempt(db.runner, sql, args)).rejects.toMatchObject({
        driverError: { code, constraint },
      });
    } finally {
      await db.runner.rollbackTransaction();
    }
  }

  it('TC-58-01 exact schema, seed v1 and append-only trigger catalog', async () => {
    expect(new CreateFraudStorage1792713600000().name).toBe(TARGET);
    const columns = await q(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position",
      [['risk_rule_sets', 'fraud_flags', 'fraud_rule_hits']],
    );
    expect(
      columns
        .filter((r: { table_name: string }) => r.table_name === 'risk_rule_sets')
        .map((r: { column_name: string }) => r.column_name),
    ).toEqual(['version', 'config', 'created_by', 'created_at']);
    expect(
      columns
        .filter((r: { table_name: string }) => r.table_name === 'fraud_flags')
        .map((r: { column_name: string }) => r.column_name),
    ).toEqual([
      'transfer_id',
      'score',
      'risk_level',
      'rule_set_version',
      'review_status',
      'reviewed_by',
      'reviewed_at',
      'review_note',
      'created_at',
    ]);
    expect(
      columns
        .filter((r: { table_name: string }) => r.table_name === 'fraud_rule_hits')
        .map((r: { column_name: string }) => r.column_name),
    ).toEqual(['transfer_id', 'rule_id', 'weight', 'explanation']);
    expect(await q('SELECT version,config,created_by FROM risk_rule_sets')).toEqual([
      { version: 1, config: SEED, created_by: null },
    ]);
    const constraints = await q(
      'SELECT conrelid::regclass::text AS table_name,conname FROM pg_constraint WHERE conrelid=ANY($1::regclass[]) ORDER BY table_name,conname',
      [['risk_rule_sets', 'fraud_flags', 'fraud_rule_hits']],
    );
    expect(constraints.map((r: { conname: string }) => r.conname)).toEqual(
      expect.arrayContaining([
        'risk_rule_sets_pkey',
        'risk_rule_sets_created_by_fkey',
        'fraud_flags_pkey',
        'fraud_flags_transfer_id_fkey',
        'fraud_flags_rule_set_version_fkey',
        'fraud_flags_review_consistent',
        'fraud_rule_hits_pkey',
        'fraud_rule_hits_transfer_id_fkey',
      ]),
    );
    expect(
      await q(
        "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='fraud_flags' AND indexname='fraud_flags_open_queue_idx'",
      ),
    ).toEqual([{ indexname: 'fraud_flags_open_queue_idx' }]);
    expect(
      await q(
        "SELECT tgname,tgtype,tgenabled FROM pg_trigger WHERE tgrelid='risk_rule_sets'::regclass AND NOT tgisinternal ORDER BY tgname",
      ),
    ).toEqual([
      { tgname: 'risk_rule_sets_append_only', tgtype: 27, tgenabled: 'O' },
      { tgname: 'risk_rule_sets_no_truncate', tgtype: 34, tgenabled: 'O' },
    ]);
  });

  it('TC-58-02 PK, FK and rule ID constraints reject duplicates and invalid references', async () => {
    const { transfer } = await fixture();
    const flag =
      "INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version) VALUES($1,40,'MEDIUM',1)";
    await q(flag, [transfer]);
    await rejected(flag, [transfer], '23505', 'fraud_flags_pkey');
    await rejected(flag, [randomUUID()], '23503', 'fraud_flags_transfer_id_fkey');
    const second = await fixture();
    await rejected(
      "INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version) VALUES($1,40,'MEDIUM',99)",
      [second.transfer],
      '23503',
      'fraud_flags_rule_set_version_fkey',
    );
    const hit =
      "INSERT INTO fraud_rule_hits(transfer_id,rule_id,weight,explanation) VALUES($1,$2,30,'velocity')";
    await q(hit, [transfer, 'R1']);
    await rejected(hit, [transfer, 'R1'], '23505', 'fraud_rule_hits_pkey');
    await rejected(hit, [transfer, 'R7'], '23514', 'fraud_rule_hits_rule_id_check');
    await rejected(hit, [randomUUID(), 'R1'], '23503', 'fraud_rule_hits_transfer_id_fkey');
  });

  it('TC-58-03 review CHECK rejects partial or missing reviewer fields', async () => {
    const { user, transfer } = await fixture();
    const insert =
      "INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version,review_status,reviewed_by,reviewed_at) VALUES($1,40,'MEDIUM',1,$2,$3,$4)";
    for (const [status, by, at] of [
      ['OPEN', user, null],
      ['OPEN', null, new Date()],
      ['CONFIRMED_FRAUD', null, null],
      ['CONFIRMED_FRAUD', user, null],
      ['FALSE_POSITIVE', null, new Date()],
    ] as const) {
      await rejected(insert, [transfer, status, by, at], '23514', 'fraud_flags_review_consistent');
    }
    await q(insert, [transfer, 'CONFIRMED_FRAUD', user, new Date()]);
    expect(
      await q(
        'SELECT review_status,reviewed_by IS NOT NULL AS has_reviewer,reviewed_at IS NOT NULL AS has_review_time FROM fraud_flags',
      ),
    ).toEqual([{ review_status: 'CONFIRMED_FRAUD', has_reviewer: true, has_review_time: true }]);
  });

  it('TC-58-04 owner is non-superuser; matched mutation and empty TRUNCATE are blocked', async () => {
    const admin = await new DataSource({
      type: 'postgres',
      url: requireDatabaseUrl(),
    }).initialize();
    const role = `dbs_fraud_owner_${randomBytes(6).toString('hex')}`;
    try {
      await admin.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      await q(`ALTER TABLE risk_rule_sets OWNER TO "${role}"`);
      await q(`ALTER TABLE fraud_flags OWNER TO "${role}"`);
      await q(`ALTER TABLE fraud_rule_hits OWNER TO "${role}"`);
      expect(await q('SELECT rolsuper FROM pg_roles WHERE rolname=$1', [role])).toEqual([
        { rolsuper: false },
      ]);
      await db.runner.startTransaction();
      try {
        await q(`SET LOCAL ROLE "${role}"`);
        for (const sql of [
          'UPDATE risk_rule_sets SET config=config WHERE version=1',
          'DELETE FROM risk_rule_sets WHERE version=1',
          'TRUNCATE risk_rule_sets CASCADE',
        ]) {
          await expect(attempt(db.runner, sql)).rejects.toMatchObject({
            driverError: { code: '42501' },
          });
        }
        expect(
          await q('UPDATE risk_rule_sets SET config=config WHERE version=99 RETURNING version'),
        ).toEqual([]);
        expect(await q('DELETE FROM risk_rule_sets WHERE version=99 RETURNING version')).toEqual(
          [],
        );
        await q('INSERT INTO risk_rule_sets(version,config) VALUES(2,$1)', [SEED]);
      } finally {
        await db.runner.rollbackTransaction();
      }
      // Fixture-only trigger disable lets us prove the statement trigger still fires on an empty table.
      await q('ALTER TABLE risk_rule_sets DISABLE TRIGGER USER');
      await q('DELETE FROM risk_rule_sets');
      await q('ALTER TABLE risk_rule_sets ENABLE TRIGGER USER');
      await db.runner.startTransaction();
      try {
        await q(`SET LOCAL ROLE "${role}"`);
        await expect(attempt(db.runner, 'TRUNCATE risk_rule_sets CASCADE')).rejects.toMatchObject({
          driverError: { code: '42501' },
        });
      } finally {
        await db.runner.rollbackTransaction();
      }
    } finally {
      await db.drop();
      db = undefined!;
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.destroy();
    }
  });

  it('TC-58-05 run, revert, run retains DBS-27 and refuses loss of user data', async () => {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error('Run via npm run test:db');
    const cli = (script: string) =>
      execFileSync(process.execPath, [npmCli, 'run', script], {
        cwd: resolve(__dirname, '../..'),
        env: { ...process.env, DATABASE_URL: db.url },
        stdio: 'pipe',
      });
    cli('migration:revert');
    expect(await q("SELECT to_regclass('public.risk_rule_sets') AS table_name")).toEqual([
      { table_name: null },
    ]);
    expect(await q("SELECT to_regprocedure('public.forbid_mutation()') AS routine")).not.toEqual([
      { routine: null },
    ]);
    cli('migration:run');
    expect(await q('SELECT version FROM risk_rule_sets')).toEqual([{ version: 1 }]);
    const { transfer } = await fixture();
    await q(
      "INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version) VALUES($1,40,'MEDIUM',1)",
      [transfer],
    );
    await expect(migrate(db.url, 'undoLast')).rejects.toThrow(/Refusing to revert fraud/);
    expect(await q('SELECT transfer_id FROM fraud_flags')).toEqual([{ transfer_id: transfer }]);
  });

  it.each(['extra-version', 'altered-seed', 'missing-seed'])(
    'TC-58-05 down refuses %s',
    async scenario => {
      if (scenario === 'extra-version')
        await q('INSERT INTO risk_rule_sets(version,config) VALUES(2,$1)', [SEED]);
      else {
        await q('ALTER TABLE risk_rule_sets DISABLE TRIGGER USER');
        if (scenario === 'altered-seed')
          await q("UPDATE risk_rule_sets SET config='{}'::jsonb WHERE version=1");
        else await q('DELETE FROM risk_rule_sets WHERE version=1');
        await q('ALTER TABLE risk_rule_sets ENABLE TRIGGER USER');
      }
      await expect(migrate(db.url, 'undoLast')).rejects.toThrow(/Refusing to revert fraud/);
      expect(await q("SELECT to_regclass('public.risk_rule_sets') AS table_name")).toEqual([
        { table_name: 'risk_rule_sets' },
      ]);
    },
  );
});
