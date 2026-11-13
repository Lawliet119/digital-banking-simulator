import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { migrate, requireDatabaseUrl } from '../support/temp-database';

/**
 * BL-195: on RDS the user that runs `migration:run` is the master user, which is NOT a superuser.
 * Step 7 of DBS-119 (`CreateDbRolesAndGrants1793664000000`) runs `ALTER VIEW v_transfer_facts OWNER
 * TO dbs_migrator`, and PostgreSQL lets a non-superuser give an object to a role only when it may
 * SET ROLE to it. The other tests migrate as the Testcontainers superuser and cannot see this. Here
 * the migrations run as a login with CREATEROLE and CREATEDB but no SUPERUSER, which is the closest
 * local stand-in for the master user (not RDS itself: `rds_superuser` is not reproduced).
 *
 * The runbook step that follows from this is in infra/terraform/README.md, "Role chạy migration".
 */
describe('BL-195 migrations as a non-superuser owner (the RDS master user)', () => {
  const suffix = randomBytes(6).toString('hex');
  const master = `dbs_master_sim_${suffix}`;
  const password = randomBytes(12).toString('hex');
  const databases: string[] = [];
  let admin: DataSource;

  const urlFor = (database: string, user = master, pass = password) => {
    const url = new URL(requireDatabaseUrl());
    url.username = user;
    url.password = pass;
    url.pathname = `/${database}`;
    return url.toString();
  };

  /** A database owned by the simulated master, so it owns the schema objects the migrations create. */
  async function ownedDatabase(): Promise<string> {
    const name = `dbs_test_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name} OWNER "${master}"`);
    databases.push(name);
    return name;
  }

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: requireDatabaseUrl() }).initialize();
    await admin.query(
      `CREATE ROLE "${master}" LOGIN PASSWORD '${password}' NOSUPERUSER CREATEDB CREATEROLE`,
    );
  });
  afterAll(async () => {
    try {
      for (const name of databases)
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS "${master}"`);
    } finally {
      await admin.destroy();
    }
  });

  it('TC-195-01 the simulated master is not a superuser', async () => {
    expect(await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = $1', [master])).toEqual(
      [{ rolsuper: false }],
    );
  });

  it('TC-195-02 without GRANT dbs_migrator the run stops at step 7 with 42501 and leaves nothing applied', async () => {
    const database = await ownedDatabase();
    await expect(migrate(urlFor(database))).rejects.toMatchObject({
      code: '42501',
      message: expect.stringMatching(/SET ROLE|dbs_migrator/) as string,
    });
    // `transaction: 'all'`: the whole run is rolled back, not only step 7.
    const probe = await new DataSource({ type: 'postgres', url: urlFor(database) }).initialize();
    try {
      expect(await probe.query('SELECT name FROM migrations')).toEqual([]);
      expect(await probe.query("SELECT to_regclass('public.users') AS t")).toEqual([{ t: null }]);
    } finally {
      await probe.destroy();
    }
  });

  it('TC-195-02b a CREATEROLE user that created a role may GRANT it to itself, and only then SET ROLE to it', async () => {
    // Same PostgreSQL rule as step 7, on a role of its own so that dbs_migrator (shared by every
    // test file of this cluster) is not touched: this is why the runbook pre-step can be run by the
    // master itself when the master is the one that created dbs_migrator.
    const probe = `dbs_probe_${suffix}`;
    const database = await ownedDatabase();
    const asMaster = await new DataSource({ type: 'postgres', url: urlFor(database) }).initialize();
    const runner = asMaster.createQueryRunner(); // SET ROLE is per connection
    try {
      await runner.connect();
      await runner.query(`CREATE ROLE "${probe}" NOLOGIN`);
      await expect(runner.query(`SET ROLE "${probe}"`)).rejects.toMatchObject({
        driverError: { code: '42501' },
      });
      await runner.query(`GRANT "${probe}" TO "${master}"`);
      await runner.query(`SET ROLE "${probe}"`);
      await runner.query('RESET ROLE');
    } finally {
      await runner.release();
      await asMaster.destroy();
      await admin.query(`DROP ROLE IF EXISTS "${probe}"`);
    }
  });

  it('TC-195-03 with the role created and GRANTed to the master first, the same run succeeds', async () => {
    const database = await ownedDatabase();
    // The runbook pre-step. The migration itself creates the role only when it is missing and
    // never grants anything to the user that runs it.
    await admin.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_migrator') THEN
          CREATE ROLE dbs_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
        END IF;
      END $$`);
    await admin.query(`GRANT dbs_migrator TO "${master}"`);
    await migrate(urlFor(database));
    const done = await new DataSource({ type: 'postgres', url: urlFor(database) }).initialize();
    try {
      expect(
        await done.query(
          `SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
            WHERE c.oid = 'public.v_transfer_facts'::regclass`,
        ),
      ).toEqual([{ owner: 'dbs_migrator' }]);
      // The run is repeatable (every deploy runs the migrate task): nothing pending, no error.
      await expect(migrate(urlFor(database))).resolves.toBeUndefined();
    } finally {
      await done.destroy();
    }
  });
});
