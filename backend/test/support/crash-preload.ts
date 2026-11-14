/**
 * Test-only preload (`node -r ts-node/register -r ./test/support/crash-preload.ts src/main.ts`).
 * It makes the real entrypoint die from an error nobody catches, so the process-level handlers
 * can be observed without putting a crash hook into production code.
 *
 * `setImmediate` runs after the whole synchronous top level of main.ts, handler registration
 * included, while the application is still starting, so it needs no PostgreSQL and no "ready"
 * signal. The throw therefore happens during bootstrap, not after the app has served anything.
 */
const kind = process.env.DBS42_CRASH;

if (kind === 'uncaught') {
  setImmediate(() => {
    throw new Error('sensitive-uncaught-fixture');
  });
} else if (kind === 'warning') {
  // BL-026: a process warning (like the sslmode one of pg-connection-string) must come out as JSON.
  setImmediate(() => {
    process.emitWarning(
      "SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.\nsensitive-warning-fixture postgres://u:sensitive-uri-fixture@h/db",
    );
    process.emitWarning('sensitive-other-warning-fixture', { code: 'DBS26_TEST' });
  });
} else if (kind === 'unhandled') {
  setImmediate(() => {
    void Promise.reject(new Error('sensitive-rejection-fixture'));
  });
}
