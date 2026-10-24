import { startPostgresContainer } from './postgres.container';

export default async function globalSetup(): Promise<void> {
  // If DATABASE_URL is already explicitly set (e.g. CI dedicated Postgres service), honor it.
  // Otherwise, automatically start PostgreSQL 17 container.
  if (!process.env.DATABASE_URL) {
    const { databaseUrl } = await startPostgresContainer();
    // The only place that assigns it: Jest forks the test workers after globalSetup, so they
    // inherit this value.
    process.env.DATABASE_URL = databaseUrl;
  }
}
