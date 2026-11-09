import { assertNotMigratorUser } from './database-url.guard';

describe('assertNotMigratorUser (DoD #2)', () => {
  it('throws a security violation when username is dbs_migrator', () => {
    expect(() =>
      assertNotMigratorUser('postgres://dbs_migrator:secret@localhost:5432/dbs'),
    ).toThrow(
      /Security violation: The application must never connect to the database as dbs_migrator/,
    );
  });

  it('throws case-insensitively when username is mixed or uppercase DBS_MIGRATOR', () => {
    expect(() =>
      assertNotMigratorUser('postgresql://DBS_MIGRATOR:secret@rds.internal:5432/dbs'),
    ).toThrow(
      /Security violation: The application must never connect to the database as dbs_migrator/,
    );
  });

  it('throws when username is percent-encoded dbs%5Fmigrator', () => {
    expect(() =>
      assertNotMigratorUser('postgres://dbs%5Fmigrator:secret@localhost:5432/dbs'),
    ).toThrow(
      /Security violation: The application must never connect to the database as dbs_migrator/,
    );
  });

  it('does not throw for valid runtime application roles or superusers', () => {
    expect(() =>
      assertNotMigratorUser('postgres://dbs_api:secret@localhost:5432/dbs'),
    ).not.toThrow();
    expect(() =>
      assertNotMigratorUser('postgres://dbs_worker:secret@localhost:5432/dbs'),
    ).not.toThrow();
    expect(() =>
      assertNotMigratorUser('postgres://banking:banking_local_only@localhost:5432/banking'),
    ).not.toThrow();
    expect(() =>
      assertNotMigratorUser('postgres://postgres:postgres@localhost:5432/postgres'),
    ).not.toThrow();
  });

  it('does not throw when databaseUrl is undefined or empty', () => {
    expect(() => assertNotMigratorUser(undefined)).not.toThrow();
    expect(() => assertNotMigratorUser('')).not.toThrow();
  });
});
