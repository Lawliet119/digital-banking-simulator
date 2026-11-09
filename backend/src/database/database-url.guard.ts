/**
 * Guard preventing runtime applications from connecting as dbs_migrator (DoD #2).
 * Only the migration pipeline CLI (data-source.ts) may connect using dbs_migrator.
 */
export function assertNotMigratorUser(databaseUrl: string | undefined): void {
  if (!databaseUrl) return;
  try {
    const parsed = new URL(databaseUrl);
    if (decodeURIComponent(parsed.username).toLowerCase() === 'dbs_migrator') {
      throw new Error(
        'Security violation: The application must never connect to the database as dbs_migrator (DoD #2). ' +
          'Use dbs_api for the API role or dbs_worker for the worker role.',
      );
    }
  } catch (err) {
    if ((err as Error).message.includes('Security violation')) throw err;
  }
}
