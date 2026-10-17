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
    const appModuleAt = indexOfLine(/^import \{ AppModule \} from '\.\/app\.module';$/);

    expect(envAt).toBeGreaterThanOrEqual(0);
    expect(appModuleAt).toBeGreaterThanOrEqual(0);
    expect(moneyAt).toBeGreaterThan(envAt); // env.bootstrap must stay the first import
    expect(moneyAt).toBeLessThan(appModuleAt);
  });
});
