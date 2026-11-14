import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  DB_ROLES,
  provisionDbRoles,
  type DbRole,
  type ProvisionDeps,
} from '../../src/scripts/provision-db-roles';
import { migrate, requireDatabaseUrl } from '../support/temp-database';

/**
 * BL-103: api, worker and dbs-migrate connect as dbs_api, dbs_worker and dbs_migrator instead of the RDS
 * master user. `provisionDbRoles` (the ECS task `dbs-db-roles`) gives the roles a login and a password,
 * as the master, before the first migration. These tests run it against PostgreSQL 17 with a login that
 * has CREATEROLE and CREATEDB but is not a superuser (the stand-in for the RDS master, as in
 * migration-owner-role.db-spec.ts; `rds_superuser` itself is not reproduced), then run the real migrations as
 * dbs_migrator and open connections as the other two roles.
 *
 * Postgres roles belong to the cluster, shared with every other spec, so the simulated master is made
 * ADMIN of the three roles first (on RDS it is, because it creates them in this very step).
 */
describe('BL-103 role credentials: provisioning, then migrations as dbs_migrator', () => {
  const suffix = randomBytes(6).toString('hex');
  const master = `dbs_master_sim_${suffix}`;
  const masterPassword = randomBytes(16).toString('hex');
  const passwords: Record<DbRole, string> = {
    dbs_api: randomBytes(16).toString('hex'),
    dbs_worker: randomBytes(16).toString('hex'),
    dbs_migrator: randomBytes(16).toString('hex'),
  };
  const databases: string[] = [];
  let admin: DataSource;

  const urlFor = (database: string, user: string, password: string) => {
    const url = new URL(requireDatabaseUrl());
    url.username = user;
    url.password = password;
    url.pathname = `/${database}`;
    return url.toString();
  };

  async function ownedDatabase(): Promise<string> {
    const name = `dbs_test_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name} OWNER "${master}"`);
    databases.push(name);
    return name;
  }

  async function onDatabase<T>(
    database: string,
    user: string,
    password: string,
    work: (source: DataSource) => Promise<T>,
  ): Promise<T> {
    const source = await new DataSource({
      type: 'postgres',
      url: urlFor(database, user, password),
    }).initialize();
    try {
      return await work(source);
    } finally {
      await source.destroy();
    }
  }

  /** Same wiring as provision-db-roles.main.ts, on the temp database. */
  async function provision(database: string): Promise<string[]> {
    const logs: string[] = [];
    const source = await new DataSource({
      type: 'postgres',
      url: urlFor(database, master, masterPassword),
    }).initialize();
    const runner = source.createQueryRunner();
    try {
      await runner.connect();
      const deps: ProvisionDeps = {
        master: runner,
        passwords,
        log: line => logs.push(line),
        loginAs: (role, password) =>
          onDatabase(database, role, password, async s => {
            const rows = await s.query<{ current_user: string }[]>('SELECT current_user');
            return rows[0].current_user;
          }),
      };
      await provisionDbRoles(deps);
    } finally {
      await runner.release();
      await source.destroy();
    }
    return logs;
  }

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: requireDatabaseUrl() }).initialize();
    await admin.query(
      `CREATE ROLE "${master}" LOGIN PASSWORD '${masterPassword}' NOSUPERUSER CREATEDB CREATEROLE`,
    );
    for (const role of DB_ROLES) {
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
        END IF; END $$`);
      await admin.query(`GRANT ${role} TO "${master}" WITH ADMIN OPTION`);
    }
  });

  afterAll(async () => {
    try {
      for (const name of databases) {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
      // Other specs share these roles: leave them as NOLOGIN as they started, only drop the stand-in.
      for (const role of DB_ROLES) await admin.query(`ALTER ROLE ${role} NOLOGIN`);
      await admin.query(`DROP OWNED BY "${master}"`);
      await admin.query(`DROP ROLE IF EXISTS "${master}"`);
    } finally {
      await admin.destroy();
    }
  });

  it('TC-103-01 the stand-in master is not a superuser and has no table privilege of its own to lean on', async () => {
    expect(await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = $1', [master])).toEqual(
      [{ rolsuper: false }],
    );
  });

  it('TC-103-02 on a fresh database: provision, migrate as dbs_migrator, then connect as every role', async () => {
    const database = await ownedDatabase();
    const logs = await provision(database);

    expect(logs.join('\n')).toContain('Đăng nhập thử bằng dbs_migrator: được');
    for (const password of Object.values(passwords))
      expect(logs.join('\n')).not.toContain(password);

    await expect(
      migrate(urlFor(database, 'dbs_migrator', passwords.dbs_migrator)),
    ).resolves.toBeUndefined();
    // Every deploy runs the migrate task again: nothing pending, no error.
    await expect(
      migrate(urlFor(database, 'dbs_migrator', passwords.dbs_migrator)),
    ).resolves.toBeUndefined();

    await onDatabase(database, 'dbs_migrator', passwords.dbs_migrator, async source => {
      expect(
        await source.query(
          `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v')`,
        ),
      ).toEqual([{ owner: 'dbs_migrator' }]);
      expect(await source.query('SELECT count(*)::int AS n FROM migrations')).toEqual([
        { n: expect.any(Number) as number },
      ]);
    });

    // dbs_api: the matrix of step 7 applies (reads users, cannot create tables or touch ledger rows).
    await onDatabase(database, 'dbs_api', passwords.dbs_api, async source => {
      expect(await source.query('SELECT count(*)::int AS n FROM users')).toEqual([{ n: 0 }]);
      await expect(source.query('CREATE TABLE api_made_this (id int)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(source.query('DELETE FROM ledger_entries')).rejects.toThrow(/permission denied/);
    });
    // dbs_worker: reads accounts, not users.
    await onDatabase(database, 'dbs_worker', passwords.dbs_worker, async source => {
      await expect(source.query('SELECT count(*) FROM accounts')).resolves.toHaveLength(1);
      await expect(source.query('SELECT 1 FROM users')).rejects.toThrow(/permission denied/);
    });

    expect(
      await admin.query(
        `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles
          WHERE rolname = ANY($1) ORDER BY rolname`,
        [[...DB_ROLES]],
      ),
    ).toEqual(
      [...DB_ROLES].sort().map(rolname => ({
        rolname,
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
      })),
    );
  });

  it('TC-103-03 the master is refused by none of this: a wrong role password fails the login check', async () => {
    const database = await ownedDatabase();
    await provision(database);
    await expect(
      onDatabase(database, 'dbs_api', passwords.dbs_worker, () => Promise.resolve('unreachable')),
    ).rejects.toThrow(/password authentication failed/);
  });

  it('TC-103-04 a database migrated earlier by the master is handed to dbs_migrator, and provisioning is repeatable', async () => {
    const database = await ownedDatabase();
    // The path before BL-103: the master ran every migration, so it owns every table.
    await migrate(urlFor(database, master, masterPassword));
    await onDatabase(database, master, masterPassword, async source => {
      expect(
        await source.query(
          `SELECT count(*)::int AS n FROM pg_class
            WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
              AND relowner <> 'dbs_migrator'::regrole`,
        ),
      ).not.toEqual([{ n: 0 }]);
    });

    await provision(database);
    await provision(database); // same passwords, new salts, nothing left to hand over

    await onDatabase(database, 'dbs_migrator', passwords.dbs_migrator, async source => {
      expect(
        await source.query(
          `SELECT count(*)::int AS n FROM pg_class
            WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm')
              AND relowner <> 'dbs_migrator'::regrole`,
        ),
      ).toEqual([{ n: 0 }]);
      // Functions and types too, except members of an extension (unaccent stays with its creator).
      expect(
        await source.query(
          `SELECT count(*)::int AS n FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proowner <> 'dbs_migrator'::regrole
              AND NOT EXISTS (SELECT FROM pg_depend d
                               WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                                 AND d.deptype = 'e')`,
        ),
      ).toEqual([{ n: 0 }]);
      // A later migration alters tables it did not create: dbs_migrator must be able to.
      await source.query('ALTER TABLE notification_log ADD COLUMN bl103_probe integer');
      await source.query('ALTER TABLE notification_log DROP COLUMN bl103_probe');
    });
    await expect(
      migrate(urlFor(database, 'dbs_migrator', passwords.dbs_migrator)),
    ).resolves.toBeUndefined();
  });
});
