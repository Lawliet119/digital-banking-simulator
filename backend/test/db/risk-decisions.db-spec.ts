import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { DataSource, type QueryRunner } from 'typeorm';
import { insertRuleOnlyDecision } from '../support/risk-decisions';
import {
  attempt,
  createTempDatabase,
  migrate,
  migrateThrough,
  requireDatabaseUrl,
  type TempDatabase,
} from '../support/temp-database';

/**
 * RSK-01: risk_decisions (one immutable row per scored TRANSFER, ADR-14), the composite key from
 * fraud_flags, grants and append-only, on real PostgreSQL. Design:
 * docs/features/RSK-01-risk-decisions-migration.md; target schema FRAUD-API-01 §3.8.
 */
const BEFORE_RSK01 = 'AddNotificationLogCorrelationId1793750400000';
const HEX = 'a'.repeat(64);
/** The allowlisted feature object of FRAUD-API-01 §2.3, with realistic sizes. */
const SNAPSHOT = {
  amount: '50000000',
  fromBalanceBefore: '123456789012',
  fromAccountAgeHours: 1234,
  toAccountAgeHours: 5678,
  sameOwner: false,
  transfers10m: 3,
  transfers1h: 7,
  historyCount30d: 42,
  historyMedian30d: '2500000',
  minutesSinceReverse: null,
  newRecipients1h: 2,
  distinctRecipients24h: 5,
};

const COLUMNS =
  'transfer_id,event_id,rule_set_version,mode,rule_score,feature_snapshot,ai_status,ai_applied_weight,' +
  'probability,provider,requested_model,response_model,rubric_sha256,input_sha256,provider_request_id';
type Row = Record<string, unknown>;
const ruleOnly = (transferId: string): Row => ({
  transfer_id: transferId,
  event_id: randomUUID(),
  rule_set_version: 1,
  mode: 'rule_only',
  rule_score: 30,
  feature_snapshot: JSON.stringify(SNAPSHOT),
  ai_status: 'DISABLED',
  ai_applied_weight: 0,
  probability: null,
  provider: null,
  requested_model: null,
  response_model: null,
  rubric_sha256: null,
  input_sha256: null,
  provider_request_id: null,
});
const aiSucceeded = (transferId: string): Row => ({
  ...ruleOnly(transferId),
  mode: 'rules_with_external_ai',
  ai_status: 'SUCCEEDED',
  ai_applied_weight: 15,
  probability: 0.73,
  provider: 'openai',
  requested_model: 'gpt-5-mini',
  response_model: 'gpt-5-mini-2026-08-07',
  rubric_sha256: HEX,
  input_sha256: 'b'.repeat(64),
  provider_request_id: 'req_0123456789abcdef0123456789',
});
const aiUnavailable = (transferId: string): Row => ({
  ...aiSucceeded(transferId),
  ai_status: 'UNAVAILABLE',
  ai_applied_weight: 0,
  probability: null,
  response_model: null,
  provider_request_id: null,
});

function insertSql(row: Row): [string, unknown[]] {
  const cols = COLUMNS.split(',');
  const values = cols.map(c => row[c]);
  const placeholders = cols.map((c, i) =>
    c === 'feature_snapshot' ? `$${i + 1}::jsonb` : `$${i + 1}`,
  );
  return [
    `INSERT INTO risk_decisions(${COLUMNS}) VALUES(${placeholders.join(',')}) RETURNING transfer_id`,
    values,
  ];
}

async function seedTransfers(runner: Pick<QueryRunner, 'query'>, count: number): Promise<string[]> {
  const [user] = await runner.query('INSERT INTO users(cognito_sub) VALUES($1) RETURNING id', [
    randomUUID(),
  ]);
  const [customer] = await runner.query(
    'INSERT INTO customers(user_id,full_name) VALUES($1,$2) RETURNING id',
    [user.id, 'Trần Văn An'],
  );
  const accounts: string[] = [];
  for (const type of ['CHECKING', 'SAVINGS']) {
    const [account] = await runner.query(
      'INSERT INTO accounts(customer_id,type) VALUES($1,$2) RETURNING id',
      [customer.id, type],
    );
    accounts.push(account.id);
  }
  const rows: { id: string }[] = await runner.query(
    `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id)
     SELECT 'TRANSFER',$1,$2,'1000000','COMPLETED',$3,gen_random_uuid() FROM generate_series(1,$4)
     RETURNING id`,
    [accounts[0], accounts[1], user.id, count],
  );
  return rows.map(r => r.id);
}

const rejects = (code: string, constraint?: string) => ({
  driverError: constraint ? { code, constraint } : { code },
});

describe('RSK-01 risk_decisions on PostgreSQL', () => {
  let db: TempDatabase;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
  });
  afterAll(async () => {
    if (db?.runner.isTransactionActive) await db.runner.rollbackTransaction();
    await db?.drop();
  });

  it('TC-RSK01-01 the migration creates the named constraints of §2 and the columns of FRAUD-API-01 §3.8', async () => {
    const names = (
      await q(
        `SELECT conname FROM pg_constraint
          WHERE conrelid IN ('risk_decisions'::regclass,'fraud_flags'::regclass,'fraud_rule_hits'::regclass)
          ORDER BY conname`,
      )
    ).map((r: { conname: string }) => r.conname);
    for (const name of [
      'risk_decisions_pkey',
      'risk_decisions_transfer_id_fkey',
      'risk_decisions_rule_set_version_fkey',
      'risk_decisions_transfer_version',
      'risk_decisions_mode_check',
      'risk_decisions_rule_score_check',
      'risk_decisions_feature_snapshot_check',
      'risk_decisions_ai_status_check',
      'risk_decisions_ai_applied_weight_check',
      'risk_decisions_rubric_sha256_check',
      'risk_decisions_input_sha256_check',
      'risk_decisions_total_fits_int',
      'risk_decisions_mode_metadata',
      'risk_decisions_status_probability',
      'fraud_flags_decision_fkey',
      'fraud_rule_hits_weight_check',
    ]) {
      expect(names).toContain(name);
    }
    // No constraint on risk_decisions is left with a name PostgreSQL made up.
    const own = names.filter((n: string) => n.startsWith('risk_decisions_'));
    expect(own).toHaveLength(14);

    const columns = await q(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name='risk_decisions' ORDER BY ordinal_position`,
    );
    expect(columns).toEqual([
      { column_name: 'transfer_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'event_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'rule_set_version', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'mode', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'rule_score', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'feature_snapshot', data_type: 'jsonb', is_nullable: 'NO' },
      { column_name: 'ai_status', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'ai_applied_weight', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'probability', data_type: 'double precision', is_nullable: 'YES' },
      { column_name: 'provider', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'requested_model', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'response_model', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'rubric_sha256', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'input_sha256', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'provider_request_id', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'decided_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    ]);
    const [fk] = await q(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='fraud_flags_decision_fkey'`,
    );
    expect(fk.def).toBe(
      'FOREIGN KEY (transfer_id, rule_set_version) REFERENCES risk_decisions(transfer_id, rule_set_version) ON DELETE RESTRICT',
    );
  });

  describe('rows the table accepts and refuses', () => {
    let transfers: string[];
    beforeAll(async () => {
      transfers = await seedTransfers(db.runner, 40);
    });
    beforeEach(async () => {
      await db.runner.startTransaction();
    });
    afterEach(async () => {
      await db.runner.rollbackTransaction();
    });

    it('TC-RSK01-02 accepts rule_only, AI SUCCEEDED at p = 0, 1 and -0, UNAVAILABLE and CONFIG_INVALID', async () => {
      const rows: Row[] = [
        ruleOnly(transfers[0]),
        { ...aiSucceeded(transfers[1]), probability: 0 },
        { ...aiSucceeded(transfers[2]), probability: 1 },
        { ...aiSucceeded(transfers[3]), probability: -0 },
        aiUnavailable(transfers[4]),
        {
          ...ruleOnly(transfers[5]),
          mode: 'rules_with_external_ai',
          ai_status: 'CONFIG_INVALID',
        },
      ];
      for (const row of rows) {
        const [sql, args] = insertSql(row);
        expect(await attempt(db.runner, sql, args)).toEqual([{ transfer_id: row.transfer_id }]);
      }
    });

    it('TC-RSK01-03 refuses every wrong state with 23514 and the constraint it breaks', async () => {
      const t = () => transfers[10 + probes.indexOf(current)];
      type Probe = [string, (id: string) => Row, string[]];
      const probes: Probe[] = [
        [
          'mode hybrid',
          id => ({ ...ruleOnly(id), mode: 'hybrid' }),
          ['risk_decisions_mode_check', 'risk_decisions_mode_metadata'],
        ],
        [
          'mode upper case',
          id => ({ ...ruleOnly(id), mode: 'RULE_ONLY' }),
          ['risk_decisions_mode_check', 'risk_decisions_mode_metadata'],
        ],
        [
          'rule_only with SUCCEEDED',
          id => ({ ...ruleOnly(id), ai_status: 'SUCCEEDED' }),
          ['risk_decisions_mode_metadata', 'risk_decisions_status_probability'],
        ],
        [
          'negative rule score',
          id => ({ ...ruleOnly(id), rule_score: -1 }),
          ['risk_decisions_rule_score_check'],
        ],
        [
          'snapshot not an object',
          id => ({ ...ruleOnly(id), feature_snapshot: '[]' }),
          ['risk_decisions_feature_snapshot_check'],
        ],
        [
          'p above 1',
          id => ({ ...aiSucceeded(id), probability: 1.2 }),
          ['risk_decisions_status_probability'],
        ],
        [
          'p NaN',
          id => ({ ...aiSucceeded(id), probability: 'NaN' }),
          ['risk_decisions_status_probability'],
        ],
        [
          'p Infinity',
          id => ({ ...aiSucceeded(id), probability: 'Infinity' }),
          ['risk_decisions_status_probability'],
        ],
        [
          'p -Infinity',
          id => ({ ...aiSucceeded(id), probability: '-Infinity' }),
          ['risk_decisions_status_probability'],
        ],
        [
          'SUCCEEDED without p',
          id => ({ ...aiSucceeded(id), probability: null }),
          ['risk_decisions_status_probability'],
        ],
        [
          'ai_status lower case',
          id => ({ ...aiUnavailable(id), ai_status: 'unavailable' }),
          ['risk_decisions_ai_status_check'],
        ],
        [
          'rubric not hex',
          id => ({ ...aiSucceeded(id), rubric_sha256: 'ABC' }),
          ['risk_decisions_rubric_sha256_check'],
        ],
        [
          'input hash upper case',
          id => ({ ...aiSucceeded(id), input_sha256: 'B'.repeat(64) }),
          ['risk_decisions_input_sha256_check'],
        ],
        [
          'negative AI weight',
          id => ({ ...aiSucceeded(id), ai_applied_weight: -1 }),
          ['risk_decisions_ai_applied_weight_check'],
        ],
        [
          'total above int',
          id => ({ ...aiSucceeded(id), rule_score: 2147483647, ai_applied_weight: 1 }),
          ['risk_decisions_total_fits_int'],
        ],
        [
          'AI mode without provider',
          id => ({ ...aiSucceeded(id), provider: null }),
          ['risk_decisions_mode_metadata'],
        ],
        [
          'weight while UNAVAILABLE',
          id => ({ ...aiUnavailable(id), ai_applied_weight: 5 }),
          ['risk_decisions_status_probability'],
        ],
      ];
      let current: Probe = probes[0];
      const seen: string[] = [];
      for (current of probes) {
        const [name, build, allowed] = current;
        const [sql, args] = insertSql(build(t()));
        const error = await attempt(db.runner, sql, args).then(
          () => undefined,
          (e: { driverError?: { code?: string; constraint?: string } }) => e.driverError,
        );
        expect({ name, code: error?.code }).toEqual({ name, code: '23514' });
        expect({ name, allowed: allowed.includes(error?.constraint ?? '') }).toEqual({
          name,
          allowed: true,
        });
        seen.push(error!.constraint!);
      }
      expect(await q('SELECT count(*)::int AS n FROM risk_decisions')).toEqual([{ n: 0 }]);
    });

    it('TC-RSK01-05 a flag needs a decision of the same rule-set version', async () => {
      const flag = (id: string) =>
        attempt(
          db.runner,
          "INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version) VALUES($1,45,'MEDIUM',1)",
          [id],
        );
      await expect(flag(transfers[30])).rejects.toMatchObject(
        rejects('23503', 'fraud_flags_decision_fkey'),
      );
      await q(
        'INSERT INTO risk_rule_sets(version,config) SELECT 2, config FROM risk_rule_sets WHERE version=1',
      );
      await insertRuleOnlyDecision(db.runner, transfers[31], { version: 2 });
      await expect(flag(transfers[31])).rejects.toMatchObject(
        rejects('23503', 'fraud_flags_decision_fkey'),
      );
      await insertRuleOnlyDecision(db.runner, transfers[32]);
      await flag(transfers[32]);
    });

    it('TC-RSK01-06 a rule hit cannot carry a negative weight', async () => {
      await insertRuleOnlyDecision(db.runner, transfers[33]);
      await q(
        "INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version) VALUES($1,45,'MEDIUM',1)",
        [transfers[33]],
      );
      await expect(
        attempt(
          db.runner,
          "INSERT INTO fraud_rule_hits(transfer_id,rule_id,weight,explanation) VALUES($1,'R6',-1,'x')",
          [transfers[33]],
        ),
      ).rejects.toMatchObject(rejects('23514', 'fraud_rule_hits_weight_check'));
    });

    it('TC-RSK01-07 append-only for the owner: UPDATE, DELETE, TRUNCATE CASCADE hit forbid_mutation; plain TRUNCATE stops at the FK', async () => {
      await insertRuleOnlyDecision(db.runner, transfers[34]);
      for (const sql of [
        'UPDATE risk_decisions SET rule_score = 0',
        'DELETE FROM risk_decisions',
        'TRUNCATE risk_decisions CASCADE',
      ]) {
        const error = await attempt(db.runner, sql).then(
          () => undefined,
          (e: { driverError?: { code?: string; message?: string } }) => e.driverError,
        );
        expect({ sql, code: error?.code }).toEqual({ sql, code: '42501' });
        expect(error?.message).toMatch(/append-only/);
      }
      await expect(attempt(db.runner, 'TRUNCATE risk_decisions')).rejects.toMatchObject(
        rejects('0A000'),
      );
      expect(await q('SELECT count(*)::int AS n FROM risk_decisions')).toEqual([{ n: 1 }]);
    });

    it('TC-RSK01-08 dbs_worker may select and insert only; dbs_api may only select', async () => {
      await q('SET LOCAL ROLE dbs_worker');
      const [sql, args] = insertSql(ruleOnly(transfers[35]));
      expect(await attempt(db.runner, sql, args)).toHaveLength(1);
      expect(await attempt(db.runner, 'SELECT count(*)::int AS n FROM risk_decisions')).toEqual([
        { n: 1 },
      ]);
      for (const stmt of [
        'UPDATE risk_decisions SET rule_score = 0',
        'DELETE FROM risk_decisions',
        'TRUNCATE risk_decisions CASCADE',
      ]) {
        const error = await attempt(db.runner, stmt).then(
          () => undefined,
          (e: { driverError?: { code?: string; message?: string } }) => e.driverError,
        );
        expect({ stmt, code: error?.code }).toEqual({ stmt, code: '42501' });
        expect(error?.message).toMatch(/permission denied/);
      }
      await q('RESET ROLE');
      await q('SET LOCAL ROLE dbs_api');
      expect(await attempt(db.runner, 'SELECT count(*)::int AS n FROM risk_decisions')).toEqual([
        { n: 1 },
      ]);
      const [apiSql, apiArgs] = insertSql(ruleOnly(transfers[36]));
      const error = await attempt(db.runner, apiSql, apiArgs).then(
        () => undefined,
        (e: { driverError?: { code?: string; message?: string } }) => e.driverError,
      );
      expect(error?.code).toBe('42501');
      expect(error?.message).toMatch(/permission denied/);
    });
  });

  describe('TC-RSK01-04 two claims of one transfer: exactly one wins', () => {
    let source: DataSource;
    let transfers: string[];
    const claim = (runner: QueryRunner, transferId: string, eventId: string) =>
      runner.query(
        `INSERT INTO risk_decisions(transfer_id,event_id,rule_set_version,mode,rule_score,feature_snapshot,ai_status,ai_applied_weight)
         VALUES($1,$2,1,'rule_only',0,'{}','DISABLED',0)
         ON CONFLICT DO NOTHING RETURNING transfer_id`,
        [transferId, eventId],
      ) as Promise<{ transfer_id: string }[]>;

    async function waitForLock(runner: QueryRunner) {
      const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid');
      return pid as number;
    }
    async function untilWaiting(pid: number) {
      for (let i = 0; i < 200; i++) {
        const [row] = await q('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]);
        if (row?.wait_event_type === 'Lock') return;
        await wait(10);
      }
      throw new Error('second claim never waited on a lock');
    }

    beforeAll(async () => {
      source = await new DataSource({
        type: 'postgres',
        url: db.url,
        extra: { max: 50 },
      }).initialize();
      transfers = await seedTransfers(db.runner, 22);
    });
    afterAll(async () => {
      await source?.destroy();
    });

    it('TC-RSK01-04a the first claim commits: the waiting one returns no row and no error', async () => {
      const a = source.createQueryRunner();
      const b = source.createQueryRunner();
      const [eventA, eventB] = [randomUUID(), randomUUID()];
      try {
        await a.startTransaction();
        expect(await claim(a, transfers[0], eventA)).toHaveLength(1);
        await b.connect();
        const pid = await waitForLock(b);
        const pending = claim(b, transfers[0], eventB);
        await untilWaiting(pid);
        await a.commitTransaction();
        expect(await pending).toEqual([]);
      } finally {
        await a.release();
        await b.release();
      }
      expect(
        await q('SELECT event_id FROM risk_decisions WHERE transfer_id=$1', [transfers[0]]),
      ).toEqual([{ event_id: eventA }]);
    });

    it('TC-RSK01-04b the first claim rolls back: the waiting one wins', async () => {
      const a = source.createQueryRunner();
      const b = source.createQueryRunner();
      const [eventA, eventB] = [randomUUID(), randomUUID()];
      try {
        await a.startTransaction();
        expect(await claim(a, transfers[1], eventA)).toHaveLength(1);
        await b.connect();
        const pid = await waitForLock(b);
        const pending = claim(b, transfers[1], eventB);
        await untilWaiting(pid);
        await a.rollbackTransaction();
        expect(await pending).toEqual([{ transfer_id: transfers[1] }]);
      } finally {
        await a.release();
        await b.release();
      }
      expect(
        await q('SELECT event_id FROM risk_decisions WHERE transfer_id=$1', [transfers[1]]),
      ).toEqual([{ event_id: eventB }]);
    });

    it('TC-RSK01-04c (smoke) 20 transfers claimed by two connections at once: one winner each, no 23505', async () => {
      const ids = transfers.slice(2, 22);
      const results = await Promise.all(
        ids.flatMap(id =>
          [0, 1].map(async () => {
            const runner = source.createQueryRunner();
            try {
              return { id, rows: (await claim(runner, id, randomUUID())).length };
            } finally {
              await runner.release();
            }
          }),
        ),
      );
      for (const id of ids) {
        expect(results.filter(r => r.id === id).reduce((n, r) => n + r.rows, 0)).toBe(1);
      }
    });
  });

  it('TC-RSK01-12 measures the row and table size for the retention decision (§8)', async () => {
    const ids = await seedTransfers(db.runner, 10_000);
    await q(
      `INSERT INTO risk_decisions(transfer_id,event_id,rule_set_version,mode,rule_score,feature_snapshot,ai_status,ai_applied_weight)
       SELECT id, gen_random_uuid(), 1, 'rule_only', 30, $2::jsonb, 'DISABLED', 0 FROM unnest($1::uuid[]) AS id`,
      [ids, JSON.stringify(SNAPSHOT)],
    );
    const [ai] = await seedTransfers(db.runner, 1);
    const [sql, args] = insertSql(aiSucceeded(ai));
    await q(sql, args);
    const [sizes] = await q(
      `SELECT
         (SELECT pg_column_size(d.*) FROM risk_decisions d WHERE mode='rule_only' AND feature_snapshot <> '{}'::jsonb LIMIT 1) AS rule_only_row,
         (SELECT pg_column_size(d.*) FROM risk_decisions d WHERE transfer_id=$1) AS ai_row,
         (SELECT count(*) FROM risk_decisions)::int AS rows,
         pg_relation_size('risk_decisions') AS heap,
         pg_indexes_size('risk_decisions') AS indexes,
         pg_total_relation_size('risk_decisions') AS total`,
      [ai],
    );
    console.log(`RSK-01 size: ${JSON.stringify(sizes)}`);
    expect(Number(sizes.rule_only_row)).toBeGreaterThan(0);
    expect(Number(sizes.ai_row)).toBeGreaterThan(Number(sizes.rule_only_row));
  });
});

describe('RSK-01 revert and refusal', () => {
  it('TC-RSK01-09 revert removes everything when empty, re-runs, and refuses once a decision exists', async () => {
    const db = await createTempDatabase();
    const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
    try {
      await migrate(db.url);
      await migrate(db.url, 'undoLast');
      expect(
        await q(`SELECT to_regclass('public.risk_decisions') AS t,
          (SELECT count(*)::int FROM pg_constraint WHERE conname IN ('fraud_flags_decision_fkey','fraud_rule_hits_weight_check')) AS c,
          (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'risk_decisions_%') AS g`),
      ).toEqual([{ t: null, c: 0, g: 0 }]);
      await migrate(db.url);
      const [transfer] = await seedTransfers(db.runner, 1);
      await insertRuleOnlyDecision(db.runner, transfer);
      await expect(migrate(db.url, 'undoLast')).rejects.toMatchObject({ code: '55000' });
      expect(await q('SELECT count(*)::int AS n FROM risk_decisions')).toEqual([{ n: 1 }]);
    } finally {
      await db.drop();
    }
  });

  it('TC-RSK01-10 the migration refuses a flag that has no decision and leaves the schema as it was', async () => {
    const db = await createTempDatabase();
    const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
    try {
      await migrateThrough(db.url, BEFORE_RSK01);
      const [transfer] = await seedTransfers(db.runner, 1);
      await q(
        "INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version) VALUES($1,45,'MEDIUM',1)",
        [transfer],
      );
      await expect(migrate(db.url)).rejects.toMatchObject({ code: '55000' });
      expect(
        await q(`SELECT to_regclass('public.risk_decisions') AS t,
          (SELECT count(*)::int FROM migrations WHERE name LIKE 'CreateRiskDecisions%') AS m,
          (SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1) AS last`),
      ).toEqual([{ t: null, m: 0, last: BEFORE_RSK01 }]);
    } finally {
      await db.drop();
    }
  });

  it('TC-RSK01-07 a non-superuser owner is blocked by the trigger too', async () => {
    const db = await createTempDatabase();
    const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
    const admin = await new DataSource({
      type: 'postgres',
      url: requireDatabaseUrl(),
    }).initialize();
    const role = `dbs_rsk01_owner_${randomBytes(6).toString('hex')}`;
    try {
      await migrate(db.url);
      const [transfer] = await seedTransfers(db.runner, 1);
      await insertRuleOnlyDecision(db.runner, transfer);
      await admin.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      for (const table of ['risk_decisions', 'fraud_flags', 'fraud_rule_hits']) {
        await q(`ALTER TABLE ${table} OWNER TO "${role}"`);
      }
      await db.runner.startTransaction();
      try {
        await q(`SET LOCAL ROLE "${role}"`);
        for (const sql of [
          'UPDATE risk_decisions SET rule_score = 0',
          'DELETE FROM risk_decisions',
          'TRUNCATE risk_decisions CASCADE',
        ]) {
          const error = await attempt(db.runner, sql).then(
            () => undefined,
            (e: { driverError?: { code?: string; message?: string } }) => e.driverError,
          );
          expect({ sql, code: error?.code }).toEqual({ sql, code: '42501' });
          expect(error?.message).toMatch(/append-only/);
        }
      } finally {
        await db.runner.rollbackTransaction();
      }
    } finally {
      await db.drop();
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.destroy();
    }
  });
});
