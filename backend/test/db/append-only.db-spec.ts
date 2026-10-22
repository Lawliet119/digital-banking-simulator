import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import {
  createTempDatabase,
  migrate,
  migrateThrough,
  attempt,
  requireDatabaseUrl,
  type TempDatabase,
} from '../support/temp-database';

const TABLES = ['ledger_entries', 'transfers', 'audit_log'] as const;
describe('append-only migration with a real non-superuser table owner', () => {
  let db: TempDatabase;
  let server: DataSource;
  let role: string;
  let roleCreated: boolean;
  let refs: { user: string; a: string; b: string };
  let fixture: { transfer: string; ledger: string; audit: string };
  async function insert(): Promise<{ transfer: string; ledger: string; audit: string }> {
    const [transfer] = await db.runner.query(
      "INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id) VALUES('TRANSFER',$1,$2,'250000','COMPLETED',$3,$4) RETURNING id",
      [refs.a, refs.b, refs.user, randomUUID()],
    );
    const entries = await db.runner.query(
      "INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after) VALUES($1,$2,'DEBIT','250000','0'),($1,$3,'CREDIT','250000','0') RETURNING id",
      [transfer.id, refs.a, refs.b],
    );
    const [audit] = await db.runner.query(
      "INSERT INTO audit_log(actor_user_id,actor_role,action,outcome,target_type,target_id,correlation_id) VALUES($1,'operator','transfer.create','SUCCESS','transfer',$2,$3) RETURNING id",
      [refs.user, transfer.id, randomUUID()],
    );
    return { transfer: transfer.id, ledger: entries[0].id, audit: audit.id };
  }
  async function owner() {
    await db.runner.query(`SET LOCAL ROLE "${role}"`);
    const ownership = await db.runner.query(
      "SELECT c.relname,pg_get_userbyid(c.relowner)=current_user AS owns,r.rolsuper FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.rolname=current_user WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname",
      [TABLES],
    );
    expect(ownership).toEqual(
      [...TABLES].sort().map(relname => ({ relname, owns: true, rolsuper: false })),
    );
    for (const table of TABLES)
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
        expect(
          (
            await db.runner.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [
              table,
              privilege,
            ])
          )[0].allowed,
        ).toBe(true);
    for (const [table, privilege] of [
      ['accounts', 'SELECT'],
      ['idempotency_keys', 'SELECT'],
      ['idempotency_keys', 'TRUNCATE'],
    ])
      expect(
        (
          await db.runner.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [
            table,
            privilege,
          ])
        )[0].allowed,
      ).toBe(true);
    for (const table of ['accounts', 'idempotency_keys'])
      for (const privilege of ['UPDATE', 'DELETE'])
        expect(
          (
            await db.runner.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [
              table,
              privilege,
            ])
          )[0].allowed,
        ).toBe(false);
    expect(
      (
        await db.runner.query(
          "SELECT has_table_privilege(current_user,'idempotency_keys','INSERT') AS allowed",
        )
      )[0].allowed,
    ).toBe(false);
  }
  async function snapshot() {
    return {
      ledger: await db.runner.query('SELECT * FROM ledger_entries ORDER BY id'),
      transfers: await db.runner.query('SELECT * FROM transfers ORDER BY id'),
      audit: await db.runner.query('SELECT * FROM audit_log ORDER BY id'),
      keys: await db.runner.query('SELECT * FROM idempotency_keys ORDER BY user_id,idem_key'),
      balances: await db.runner.query('SELECT id,balance FROM accounts ORDER BY id'),
    };
  }
  beforeEach(async () => {
    roleCreated = false;
    db = await createTempDatabase();
    await migrate(db.url);
    server = await new DataSource({ type: 'postgres', url: requireDatabaseUrl() }).initialize();
    role = `dbs_test_owner_${randomBytes(6).toString('hex')}`;
    if (!/^dbs_test_owner_[0-9a-f]{12}$/.test(role)) throw new Error('Unsafe fixture role');
    await server.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    roleCreated = true;
    const accounts: string[] = [];
    let user = '';
    for (const [sub, name] of [
      ['minh-local', 'Nguyễn Minh'],
      ['lan-local', 'Trần Lan'],
    ]) {
      const [u] = await db.runner.query('INSERT INTO users(cognito_sub) VALUES($1) RETURNING id', [
        sub,
      ]);
      const [c] = await db.runner.query(
        'INSERT INTO customers(user_id,full_name) VALUES($1,$2) RETURNING id',
        [u.id, name],
      );
      const [a] = await db.runner.query(
        "INSERT INTO accounts(customer_id,type) VALUES($1,'CHECKING') RETURNING id",
        [c.id],
      );
      accounts.push(a.id);
      user = u.id;
    }
    refs = { user, a: accounts[0], b: accounts[1] };
    for (const table of TABLES) await db.runner.query(`ALTER TABLE ${table} OWNER TO "${role}"`);
    await db.runner.query(`GRANT SELECT ON accounts,idempotency_keys TO "${role}"`);
    await db.runner.query(`GRANT TRUNCATE ON idempotency_keys TO "${role}"`);
    await db.runner.startTransaction();
    await owner();
    fixture = await insert();
    await db.runner.query('RESET ROLE');
    await db.runner.query(
      "INSERT INTO idempotency_keys(user_id,idem_key,request_hash,transfer_id) VALUES($1,'chuyen-tien-minh-lan',repeat('a',64),$2)",
      [refs.user, fixture.transfer],
    );
    await owner();
    await db.runner.commitTransaction();
  });
  afterEach(async () => {
    try {
      if (db?.runner.isTransactionActive) await db.runner.rollbackTransaction();
      await db?.drop();
    } finally {
      if (server?.isInitialized) {
        if (roleCreated) await server.query(`DROP ROLE "${role}"`);
        await server.destroy();
      }
    }
  });
  function cli(script: string) {
    execFileSync(process.execPath, [process.env.npm_execpath!, 'run', script], {
      cwd: resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: db.url },
      stdio: 'pipe',
    });
  }
  async function blocked(sql: string, params: unknown[] = []) {
    await db.runner.startTransaction();
    try {
      await owner();
      const before = await snapshot();
      await expect(attempt(db.runner, sql, params)).rejects.toMatchObject({
        driverError: {
          code: '42501',
          where: expect.stringMatching(
            /PL\/pgSQL function (?:public\.)?forbid_mutation\(\) line \d+ at RAISE/,
          ),
        },
      });
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.runner.rollbackTransaction();
    }
  }
  it('TC-27-01 one invoker PL/pgSQL function and six enabled row/statement triggers', async () => {
    const fn = await db.runner.query(
      "SELECT n.nspname,p.proname,p.pronargs,t.typname AS returns,l.lanname,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_type t ON t.oid=p.prorettype JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname='forbid_mutation'",
    );
    expect(fn).toEqual([
      {
        nspname: 'public',
        proname: 'forbid_mutation',
        pronargs: 0,
        returns: 'trigger',
        lanname: 'plpgsql',
        prosecdef: false,
      },
    ]);
    const triggers = await db.runner.query(
      "SELECT t.tgname,t.tgtype,t.tgenabled FROM pg_trigger t WHERE t.tgfoid='public.forbid_mutation()'::regprocedure ORDER BY tgname",
    );
    expect(triggers).toEqual(
      [...TABLES].sort().flatMap(table => [
        { tgname: `${table}_append_only`, tgtype: 27, tgenabled: 'O' },
        { tgname: `${table}_no_truncate`, tgtype: 34, tgenabled: 'O' },
      ]),
    );
  });
  it('TC-27-02 effective owner is non-superuser and has all required cascade/snapshot privileges', async () => {
    await db.runner.startTransaction();
    await owner();
    const s = await snapshot();
    expect(s.keys).toHaveLength(1);
    expect(s.keys[0].transfer_id).toBe(fixture.transfer);
    await db.runner.rollbackTransaction();
  });
  it('TC-27-03 owner INSERT succeeds on all targets with generated identity/defaults', async () => {
    await db.runner.startTransaction();
    await owner();
    const added = await insert();
    expect(added.transfer).not.toBe(fixture.transfer);
    const s = await snapshot();
    expect(s.transfers).toHaveLength(2);
    expect(s.ledger).toHaveLength(4);
    expect(s.audit).toHaveLength(2);
    expect(s.balances.every((r: { balance: string }) => r.balance === '0')).toBe(true);
    await db.runner.rollbackTransaction();
  });
  it.each(TABLES)('TC-27-04 UPDATE real %s row is rejected by the function', async table => {
    const statements = {
      ledger_entries: [
        'UPDATE ledger_entries SET balance_after=balance_after+1 WHERE id=$1',
        [fixture.ledger],
      ],
      transfers: [
        'UPDATE transfers SET correlation_id=$2 WHERE id=$1',
        [fixture.transfer, randomUUID()],
      ],
      audit_log: ["UPDATE audit_log SET target_id='changed' WHERE id=$1", [fixture.audit]],
    } as const;
    const [sql, args] = statements[table];
    await blocked(sql, [...args]);
  });
  it.each(TABLES)('TC-27-05 same-value UPDATE on %s is still blocked', async table => {
    const id =
      table === 'ledger_entries'
        ? fixture.ledger
        : table === 'transfers'
          ? fixture.transfer
          : fixture.audit;
    const column =
      table === 'ledger_entries'
        ? 'balance_after'
        : table === 'transfers'
          ? 'correlation_id'
          : 'target_id';
    await blocked(`UPDATE ${table} SET ${column}=${column} WHERE id=$1`, [id]);
  });
  it.each(TABLES)('TC-27-06 DELETE real %s row is blocked before FK', async table => {
    const id =
      table === 'ledger_entries'
        ? fixture.ledger
        : table === 'transfers'
          ? fixture.transfer
          : fixture.audit;
    await blocked(`DELETE FROM ${table} WHERE id=$1`, [id]);
  });
  it.each(TABLES)(
    'TC-27-07 TRUNCATE populated %s has trigger context and preserves cascade data',
    async table => {
      await blocked(`TRUNCATE ${table}${table === 'transfers' ? ' CASCADE' : ''}`);
    },
  );
  it.each(TABLES)('TC-27-08 even empty %s TRUNCATE reaches the statement trigger', async table => {
    // A separate migrated database proves statement triggers also fire with zero rows.
    const empty = await createTempDatabase();
    try {
      await migrate(empty.url);
      for (const name of TABLES) await empty.runner.query(`ALTER TABLE ${name} OWNER TO "${role}"`);
      await empty.runner.query(`GRANT SELECT ON accounts,idempotency_keys TO "${role}"`);
      await empty.runner.query(`GRANT TRUNCATE ON idempotency_keys TO "${role}"`);
      await empty.runner.startTransaction();
      await empty.runner.query(`SET LOCAL ROLE "${role}"`);
      expect(
        await empty.runner.query(
          "SELECT c.relname,pg_get_userbyid(c.relowner)=current_user AS owns,r.rolsuper FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.rolname=current_user WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname",
          [TABLES],
        ),
      ).toEqual([...TABLES].sort().map(relname => ({ relname, owns: true, rolsuper: false })));
      for (const name of [...TABLES, 'idempotency_keys']) {
        expect(
          (
            await empty.runner.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [
              name,
              'TRUNCATE',
            ])
          )[0].allowed,
        ).toBe(true);
        expect(await empty.runner.query(`SELECT * FROM ${name}`)).toEqual([]);
      }
      await expect(
        attempt(empty.runner, `TRUNCATE ${table}${table === 'transfers' ? ' CASCADE' : ''}`),
      ).rejects.toMatchObject({
        driverError: {
          code: '42501',
          where: expect.stringMatching(
            /PL\/pgSQL function (?:public\.)?forbid_mutation\(\) line \d+ at RAISE/,
          ),
        },
      });
      for (const name of [...TABLES, 'idempotency_keys'])
        expect(await empty.runner.query(`SELECT * FROM ${name}`)).toEqual([]);
      await empty.runner.rollbackTransaction();
    } finally {
      if (empty.runner.isTransactionActive) await empty.runner.rollbackTransaction();
      await empty.drop();
    }
  });
  it.each(TABLES)(
    'TC-27-09 unmatched UPDATE/DELETE on %s affects zero rows without error',
    async table => {
      await db.runner.startTransaction();
      try {
        await owner();
        const before = await snapshot();
        const column =
          table === 'ledger_entries'
            ? 'balance_after'
            : table === 'transfers'
              ? 'correlation_id'
              : 'target_id';
        expect(
          await db.runner.query(
            `UPDATE ${table} SET ${column}=${column} WHERE false RETURNING id`,
            undefined,
            true,
          ),
        ).toMatchObject({ records: [], affected: 0 });
        expect(
          await db.runner.query(`DELETE FROM ${table} WHERE false RETURNING id`, undefined, true),
        ).toMatchObject({ records: [], affected: 0 });
        expect(await snapshot()).toEqual(before);
      } finally {
        await db.runner.rollbackTransaction();
      }
    },
  );
  it('TC-27-10 apply to populated schema preserves rows, constraints, indexes and sequences', async () => {
    await migrate(db.url, 'undoLast');
    const before = await snapshot();
    const objects = await db.runner.query(
      "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname",
    );
    const constraints = await db.runner.query(
      'SELECT conrelid::regclass::text AS table_name,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=ANY($1::regclass[]) ORDER BY conrelid::regclass::text,conname',
      [TABLES],
    );
    const columns = await db.runner.query(
      "SELECT table_name,column_name,data_type,is_nullable,column_default,is_identity FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position",
      [TABLES],
    );
    const sequences = await db.runner.query(
      "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' AND sequencename IN ('ledger_entries_id_seq','audit_log_id_seq') ORDER BY sequencename",
    );
    await migrate(db.url);
    expect(await snapshot()).toEqual(before);
    expect(
      await db.runner.query(
        "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname",
      ),
    ).toEqual(objects);
    expect(
      await db.runner.query(
        'SELECT conrelid::regclass::text AS table_name,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=ANY($1::regclass[]) ORDER BY conrelid::regclass::text,conname',
        [TABLES],
      ),
    ).toEqual(constraints);
    expect(
      await db.runner.query(
        "SELECT table_name,column_name,data_type,is_nullable,column_default,is_identity FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position",
        [TABLES],
      ),
    ).toEqual(columns);
    expect(
      await db.runner.query(
        "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' AND sequencename IN ('ledger_entries_id_seq','audit_log_id_seq') ORDER BY sequencename",
      ),
    ).toEqual(sequences);
  });
  it('TC-27-11 revert with committed rows removes triggers first and leaves data; ACL allows CASCADE', async () => {
    const before = await snapshot();
    const history: { name: string }[] = await db.runner.query(
      'SELECT name FROM migrations ORDER BY timestamp,id',
    );
    expect(history.at(-1)?.name).toBe('AddAppendOnlyTriggers1792627200002');
    const sequences = await db.runner.query(
      "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' AND sequencename IN ('ledger_entries_id_seq','audit_log_id_seq') ORDER BY sequencename",
    );
    cli('migration:revert');
    expect(await snapshot()).toEqual(before);
    expect(await db.runner.query('SELECT name FROM migrations ORDER BY timestamp,id')).toEqual(
      history.slice(0, -1),
    );
    expect(
      await db.runner.query(
        "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' AND sequencename IN ('ledger_entries_id_seq','audit_log_id_seq') ORDER BY sequencename",
      ),
    ).toEqual(sequences);
    expect(
      await db.runner.query("SELECT to_regprocedure('public.forbid_mutation()') AS name"),
    ).toEqual([{ name: null }]);
    expect(
      await db.runner.query(
        'SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid=ANY($1::regclass[])',
        [TABLES],
      ),
    ).toEqual([]);
    await db.runner.startTransaction();
    try {
      await owner();
      await db.runner.query('SAVEPOINT probe');
      await db.runner.query("UPDATE audit_log SET target_id='rollback-check'");
      await db.runner.query('ROLLBACK TO SAVEPOINT probe');
      await db.runner.query('TRUNCATE transfers CASCADE');
      await db.runner.query('ROLLBACK TO SAVEPOINT probe');
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.runner.rollbackTransaction();
    }
  });
  it('TC-27-12 re-run restores protection on every target while INSERT stays allowed', async () => {
    const before = await snapshot();
    cli('migration:revert');
    cli('migration:run');
    expect(await snapshot()).toEqual(before);
    for (const table of TABLES) {
      const column =
        table === 'ledger_entries'
          ? 'balance_after'
          : table === 'transfers'
            ? 'correlation_id'
            : 'target_id';
      await blocked(`UPDATE ${table} SET ${column}=${column}`);
      await blocked(`DELETE FROM ${table}`);
      await blocked(`TRUNCATE ${table}${table === 'transfers' ? ' CASCADE' : ''}`);
    }
    await db.runner.startTransaction();
    await owner();
    await insert();
    await db.runner.rollbackTransaction();
  });
  it('TC-27-13/14 legacy prefix still has two migrations and seven RESTRICT foreign keys', async () => {
    const legacy = await createTempDatabase();
    try {
      await migrateThrough(legacy.url, 'CreateTransfersLedgerIdempotency1791849600000');
      expect(
        await legacy.runner.query('SELECT name FROM migrations ORDER BY timestamp'),
      ).toHaveLength(2);
      const keys = await legacy.runner.query(
        "SELECT confdeltype FROM pg_constraint WHERE contype='f' AND conrelid=ANY($1::regclass[])",
        [['transfers', 'ledger_entries', 'idempotency_keys']],
      );
      expect(keys).toHaveLength(7);
      expect(keys.every((r: { confdeltype: string }) => r.confdeltype === 'r')).toBe(true);
      expect(
        await legacy.runner.query("SELECT to_regprocedure('public.forbid_mutation()') AS name"),
      ).toEqual([{ name: null }]);
    } finally {
      await legacy.drop();
    }
  });
});
