import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `main.ts` starts the app as soon as it is imported, so a test cannot import it. `configureHttpApp`
 * takes the metrics middleware as an optional argument, which means forgetting it compiles and
 * passes every e2e test (they build the app themselves) and leaves production without a single
 * HTTP metric. This pins the line that passes it (DBS-144).
 */
describe('main.ts wiring of @common/metrics (DBS-144)', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');

  it('TC-144-05c imports MetricsService from @common/metrics', () => {
    expect(source).toMatch(/^import \{ MetricsService \} from '\.\/common\/metrics';$/m);
  });

  it('TC-144-05c passes the HTTP middleware of MetricsService to configureHttpApp', () => {
    const call = /configureHttpApp\(([\s\S]*?)\);/.exec(source);
    expect(call).not.toBeNull();
    expect(call?.[1]).toMatch(/app\.get\(MetricsService\)\.httpMiddleware\(\)/);
  });
});
