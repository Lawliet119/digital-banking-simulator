/**
 * BL-103: gives the three application roles of DBS-119 a login and a password, with the master credential.
 *
 * It runs as the one-off ECS task `dbs-db-roles` (infra/scripts/db-roles.sh) BEFORE the first migration of a
 * database, and again whenever a password in Secrets Manager changes. It is idempotent. Nothing but this task
 * reads the master secret; api, worker and dbs-migrate connect as dbs_api, dbs_worker and dbs_migrator.
 *
 * What it does, in one transaction as the master user:
 *   1. creates dbs_migrator, dbs_api and dbs_worker when missing (NOLOGIN, no privileges: same as step 7);
 *   2. `ALTER ROLE ... LOGIN PASSWORD '<SCRAM-SHA-256 verifier>'` for each. The server receives the verifier,
 *      not the password, so neither a failed statement in the RDS log nor pg_stat_statements can leak it;
 *   3. gives dbs_migrator what a migration runner needs before any table exists: USAGE and CREATE on schema
 *      public (owned by pg_database_owner, the master) and CREATE on the database (CREATE EXTENSION unaccent,
 *      BL-178, is a trusted extension, so CREATE on the database is enough);
 *   4. gives dbs_migrator the tables, views, functions and types of schema public that another role (the
 *      master, from a run before BL-103) still owns, so later ALTERs by dbs_migrator keep working. On a
 *      fresh database there is nothing to hand over.
 * Then, outside the transaction, it logs in as each role with the password it just set and runs
 * `SELECT current_user`: a password in Secrets Manager that the database does not accept fails here, not at
 * the next deploy.
 *
 * Privileges on tables are NOT granted here: the migration (step 7) and infra/scripts/db-roles.sql do that.
 * Passwords never reach a log: this module logs role names only.
 */
import { createHmac, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';

export const DB_ROLES = ['dbs_api', 'dbs_worker', 'dbs_migrator'] as const;
export type DbRole = (typeof DB_ROLES)[number];

/** Env var that carries each role's password (ECS `secrets`, `<secret arn>:password::`). */
export const PASSWORD_ENV: Record<DbRole, string> = {
  dbs_api: 'DBS_API_DB_PASSWORD',
  dbs_worker: 'DBS_WORKER_DB_PASSWORD',
  dbs_migrator: 'DBS_MIGRATOR_DB_PASSWORD',
};

export const MIN_PASSWORD_LENGTH = 24;
const SCRAM_ITERATIONS = 4096;

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for a password (RFC 5802/7677, PostgreSQL's
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`). `ALTER ROLE ... PASSWORD` accepts it as is.
 * Passwords here are alphanumeric (random_password, no special characters), so SASLprep is the identity.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** Reads and checks the three passwords. Error messages name the variable, never the value. */
export function readPasswords(env: NodeJS.ProcessEnv): Record<DbRole, string> {
  const problems: string[] = [];
  const passwords = {} as Record<DbRole, string>;
  for (const role of DB_ROLES) {
    const name = PASSWORD_ENV[role];
    const value = env[name];
    if (!value) {
      problems.push(`${name} is missing`);
    } else if (value.length < MIN_PASSWORD_LENGTH || !/^[A-Za-z0-9]+$/.test(value)) {
      problems.push(`${name} must be at least ${MIN_PASSWORD_LENGTH} letters or digits`);
    } else {
      passwords[role] = value;
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
  if (new Set(Object.values(passwords)).size !== DB_ROLES.length) {
    throw new Error('the three role passwords must differ from each other');
  }
  return passwords;
}

const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const CREATE_ROLES = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_migrator') THEN
    CREATE ROLE dbs_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_api') THEN
    CREATE ROLE dbs_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbs_worker') THEN
    CREATE ROLE dbs_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$`;

/** Schema public and the database: the two things dbs_migrator needs before its first migration. */
const GRANT_MIGRATOR_ACCESS = `
DO $$
BEGIN
  GRANT USAGE, CREATE ON SCHEMA public TO dbs_migrator;
  GRANT USAGE ON SCHEMA public TO dbs_api, dbs_worker;
  EXECUTE format('GRANT CREATE ON DATABASE %I TO dbs_migrator', current_database());
END $$`;

/**
 * Hands every object of schema public that dbs_migrator does not own yet to dbs_migrator. Extension members
 * (deptype 'e') are skipped, and so are sequences owned by a column, which follow their table. ALTER ... OWNER
 * needs the right to SET ROLE to dbs_migrator, so the current user is made a member of it first, only when
 * there is something to hand over (the same GRANT the BL-195 runbook describes).
 */
const ADOPT_OWNERSHIP = `
DO $$
DECLARE
  item record;
  member boolean := false;
BEGIN
  FOR item IN
    SELECT CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                          WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind,
           format('%I.%I', n.nspname, c.relname) AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       AND c.relowner <> 'dbs_migrator'::regrole
       AND NOT EXISTS (SELECT FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                          AND d.deptype IN ('e', 'a', 'i'))
    UNION ALL
    SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
           p.oid::regprocedure::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
       AND p.proowner <> 'dbs_migrator'::regrole
       AND NOT EXISTS (SELECT FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    UNION ALL
    SELECT 'TYPE', format('%I.%I', n.nspname, t.typname)
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')
       AND t.typowner <> 'dbs_migrator'::regrole
       AND NOT EXISTS (SELECT FROM pg_depend d
                        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    IF NOT member THEN
      EXECUTE format('GRANT dbs_migrator TO %I', current_user);
      member := true;
    END IF;
    EXECUTE format('ALTER %s %s OWNER TO dbs_migrator', item.kind, item.name);
  END LOOP;
END $$`;

/** The SQL of one provisioning run, in order. `verifiers` are SCRAM verifiers, never passwords. */
export function provisionStatements(verifiers: Record<DbRole, string>): string[] {
  return [
    CREATE_ROLES,
    ...DB_ROLES.map(role => `ALTER ROLE ${role} LOGIN PASSWORD ${quoteLiteral(verifiers[role])}`),
    GRANT_MIGRATOR_ACCESS,
    ADOPT_OWNERSHIP,
  ];
}

export interface Queryable {
  query(sql: string): Promise<unknown>;
}

export interface ProvisionDeps {
  /** One connection as the master user (not shared with the verification logins). */
  master: Queryable;
  /** Opens a new connection as `role` with `password`, runs `SELECT current_user`, returns the name. */
  loginAs(role: DbRole, password: string): Promise<string>;
  passwords: Record<DbRole, string>;
  log(line: string): void;
}

/** Runs the whole provisioning. Throws on the first failure; the transaction is rolled back. */
export async function provisionDbRoles(deps: ProvisionDeps): Promise<void> {
  const verifiers = {} as Record<DbRole, string>;
  for (const role of DB_ROLES) verifiers[role] = scramVerifier(deps.passwords[role]);

  await deps.master.query('BEGIN');
  try {
    for (const statement of provisionStatements(verifiers)) await deps.master.query(statement);
    await deps.master.query('COMMIT');
  } catch (error) {
    await deps.master.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  for (const role of DB_ROLES) deps.log(`Đã đặt LOGIN và mật khẩu cho role ${role}`);

  for (const role of DB_ROLES) {
    const actual = await deps.loginAs(role, deps.passwords[role]);
    if (actual !== role) throw new Error(`login as ${role} returned current_user ${actual}`);
    deps.log(`Đăng nhập thử bằng ${role}: được`);
  }
}
