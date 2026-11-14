// Must stay the first import: it composes DATABASE_URL (the MASTER credential) from DB_* like data-source.ts.
import '../config/env.bootstrap';
import { DataSource } from 'typeorm';
import { buildSslOptions } from '../database/pg-ssl';
import { type DbRole, provisionDbRoles, readPasswords } from './provision-db-roles';

/**
 * Entry point of the ECS task `dbs-db-roles` (`node dist/scripts/provision-db-roles.main.js`, BL-103).
 * DB_USER and DB_PASSWORD are the master secret; DBS_{API,WORKER,MIGRATOR}_DB_PASSWORD are the
 * passwords of the three roles (Secrets Manager `dbs/dev/db-*`). Exit 0 only when every role could log in.
 * Output names roles and error text only: no password, no connection string.
 */
const ssl = buildSslOptions({
  enabled: process.env.DATABASE_SSL === 'true',
  caPath: process.env.DATABASE_SSL_CA_PATH,
});

function connectAs(url: string): Promise<DataSource> {
  return new DataSource({ type: 'postgres', url, ssl }).initialize();
}

function urlFor(role: DbRole, password: string): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function run(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (DB_* incomplete)');
  const passwords = readPasswords(process.env);
  const master = await connectAs(process.env.DATABASE_URL);
  const runner = master.createQueryRunner(); // BEGIN and COMMIT must share one connection
  try {
    await runner.connect();
    await provisionDbRoles({
      master: runner,
      passwords,
      log: line => process.stdout.write(`${line}\n`),
      loginAs: async (role, password) => {
        const source = await connectAs(urlFor(role, password));
        try {
          const rows = await source.query<{ current_user: string }[]>('SELECT current_user');
          return rows[0]?.current_user ?? '';
        } finally {
          await source.destroy();
        }
      },
    });
  } finally {
    await runner.release().catch(() => undefined);
    await master.destroy().catch(() => undefined);
  }
}

run().then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    // pg errors carry a code and a message about the server, never the password we sent.
    const code = (error as { code?: string }).code;
    process.stderr.write(
      `Tạo role DB thất bại${code ? ` (${code})` : ''}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
