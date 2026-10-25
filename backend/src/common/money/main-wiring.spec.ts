import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `main.ts` starts the app as soon as it is imported (`void bootstrap()`), so a test cannot import
 * it. What matters is that the JSON-safe-bigint bootstrap runs in EVERY role: the worker has no
 * HTTP server, never goes through `configureHttpApp`, and still writes SQS payloads, outbox rows
 * and audit `jsonb` with JSON.stringify. This pins the one line that guarantees it.
 */
describe('main.ts wiring of @common/money (DBS-22)', () => {
  const lines = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8').split(/\r?\n/);
  const indexOfLine = (pattern: RegExp): number => lines.findIndex(line => pattern.test(line));

  it('TC-22-25 imports the bigint bootstrap once, as a real line, after env and before AppModule', () => {
    const bootstrapLines = lines.filter(line =>
      /^import '@common\/money\/bigint-json\.bootstrap';$/.test(line),
    );
    expect(bootstrapLines).toHaveLength(1); // not commented out, not duplicated

    const envAt = indexOfLine(/^import '\.\/config\/env\.bootstrap';$/);
    const moneyAt = indexOfLine(/^import '@common\/money\/bigint-json\.bootstrap';$/);
    // AppModule is loaded inside the guarded bootstrap so configuration errors are logged safely.
    const appModuleAt = indexOfLine(
      /^\s*const \{ AppModule \} = await import\('\.\/app\.module'\);$/,
    );

    expect(envAt).toBeGreaterThanOrEqual(0);
    expect(appModuleAt).toBeGreaterThanOrEqual(0);
    expect(moneyAt).toBeGreaterThan(envAt); // env.bootstrap must stay the first import
    expect(moneyAt).toBeLessThan(appModuleAt);
  });

  it('TC-42-11 imports the process logging bootstrap once, right after env and before bigint', () => {
    const pattern =
      /^import \{ bootstrapLogger \} from '\.\/common\/logging\/process-logging\.bootstrap';$/;
    expect(lines.filter(line => pattern.test(line))).toHaveLength(1);

    const envAt = indexOfLine(/^import '\.\/config\/env\.bootstrap';$/);
    const loggingAt = indexOfLine(pattern);
    const moneyAt = indexOfLine(/^import '@common\/money\/bigint-json\.bootstrap';$/);

    expect(loggingAt).toBeGreaterThan(envAt); // LOG_LEVEL and APP_ROLE must already be loaded
    expect(loggingAt).toBeLessThan(moneyAt); // and the crash handlers must precede the rest
  });
});
