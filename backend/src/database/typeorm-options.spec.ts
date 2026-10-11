import type { ConfigType } from '@nestjs/config';
import type { appConfig, databaseConfig } from '../config';
import { createMigrationDataSource } from './data-source';
import { buildTypeOrmOptions } from './database.module';
import { SnakeNamingStrategy } from './snake-naming.strategy';

// TC-20-17. The app and the migration CLI must agree on column names, and the app must never
// change the schema on its own (migrations are a pipeline step, ADR-13).
describe('TypeORM options', () => {
  const db = {
    url: 'postgres://u:p@localhost:5432/banking',
    poolMax: 10,
    ssl: false,
    sslCaPath: undefined,
  } as ConfigType<typeof databaseConfig>;
  const app = { role: 'api' } as ConfigType<typeof appConfig>;

  it('the app connection uses snake_case names and never touches the schema', () => {
    const options = buildTypeOrmOptions(db, app);

    expect(options.namingStrategy).toBeInstanceOf(SnakeNamingStrategy);
    expect(options).toMatchObject({
      synchronize: false,
      migrationsRun: false,
      applicationName: 'dbs-api',
    });
  });

  it('the migration CLI uses the same naming strategy', () => {
    const dataSource = createMigrationDataSource('postgres://u:p@localhost:5432/banking');

    expect(dataSource.options.namingStrategy).toBeInstanceOf(SnakeNamingStrategy);
    expect(dataSource.options.synchronize ?? false).toBe(false);
  });
});
