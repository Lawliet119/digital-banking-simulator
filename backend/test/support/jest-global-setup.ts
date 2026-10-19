import { startPostgresContainer } from './postgres.container';

export default async function globalSetup(): Promise<void> {
  // If DATABASE_URL is already explicitly set (e.g. CI dedicated Postgres service), honor it.
  // Otherwise, automatically start PostgreSQL 17 container.
  if (!process.env.DATABASE_URL) {
    const started = await startPostgresContainer();
    // Also assign to process.env in the globalSetup process
    process.env.DATABASE_URL = started.databaseUrl;
  }
}
