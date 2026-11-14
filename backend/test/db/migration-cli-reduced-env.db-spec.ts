import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createMigrationDataSource } from '@database/data-source';
import { createTempDatabase, type TempDatabase } from '../support/temp-database';

/**
 * BL-110 (d), M-68-08: the `dbs-migrate` ECS task gives the TypeORM CLI only `NODE_ENV`, `DB_*` and
 * `DATABASE_SSL` (infra/terraform/envs/dev/session/ecs.tf; no `COGNITO_*`, `REDIS_URL`, `APP_ROLE`).
 * This runs the real CLI (`migration:run`, same `data-source.ts`) with exactly that environment on
 * a throwaway database. `initialize()` imports every `*.entity.{ts,js}` the glob finds, so the
 * run fails the day an entity file pulls in config validation, Redis or Cognito at import time.
 * The compiled `dist` run (`migration:run:prod`) differs only in the file extension.
 *
 * Merely `require`-ing `data-source` is NOT enough: TypeORM imports entities in `initialize()`,
 * not in `new DataSource()`, which is why the manual M-68-08 of DBS-68 could not prove it.
 */
const BACKEND = resolve(__dirname, '..', '..');
const MIGRATIONS = join(BACKEND, 'src', 'database', 'migrations');

function listFiles(dir: string, suffix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listFiles(path, suffix);
    return entry.name.endsWith(suffix) ? [path] : [];
  });
}

/** Only what the task definition sets, plus the OS variables Node itself needs to start. */
function taskEnv(url: URL, database: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'staging',
    DB_HOST: url.hostname,
    DB_PORT: url.port || '5432',
    DB_NAME: database,
    DB_USER: decodeURIComponent(url.username),
    DB_PASSWORD: decodeURIComponent(url.password),
    DATABASE_SSL: 'false',
  };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

describe('BL-110(d) migration CLI with the dbs-migrate task environment', () => {
  let db: TempDatabase;

  beforeEach(async () => {
    db = await createTempDatabase();
  });
  afterEach(async () => {
    await db?.drop();
  });

  it('M-68-08 migration:run exits 0 and applies every migration without COGNITO_*, REDIS_URL or APP_ROLE', async () => {
    const env = taskEnv(new URL(db.url), db.name);
    for (const key of ['COGNITO_USER_POOL_ID', 'REDIS_URL', 'APP_ROLE', 'DATABASE_URL']) {
      expect(env[key]).toBeUndefined();
    }

    const result = spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        '-r',
        'tsconfig-paths/register',
        join('node_modules', 'typeorm', 'cli.js'),
        '-d',
        join('src', 'database', 'data-source.ts'),
        'migration:run',
      ],
      { cwd: BACKEND, env, encoding: 'utf8', timeout: 110_000 },
    );
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });

    const applied = (await db.runner.query('SELECT name FROM migrations')) as unknown[];
    expect(applied).toHaveLength(listFiles(MIGRATIONS, '.ts').length);
  }, 120_000);

  it('the entity glob finds every *.entity.ts file (so the run above covers them all)', async () => {
    const files = listFiles(join(BACKEND, 'src'), '.entity.ts');
    const dataSource = createMigrationDataSource(db.url);
    await dataSource.initialize();
    try {
      // A `*.entity.ts` file that declares no @Entity is a mistake; a file may declare several.
      expect(dataSource.entityMetadatas.length).toBeGreaterThanOrEqual(files.length);
    } finally {
      await dataSource.destroy();
    }
  });
});
