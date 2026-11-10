import { resolve } from 'node:path';
import { exportOpenApi } from '../../src/scripts/export-openapi';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startDepositApp, type DepositApp } from '../support/deposit-app';

describe('DBS-137 OpenAPI Clean-up and Artifact Export', () => {
  let db: TempDatabase;
  let app: DepositApp;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { withSwagger: true, fraud: true, auditHttp: true });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-137-01 exports valid openapi.json with summary, roles, and problem details on all endpoints', async () => {
    const destination = resolve(__dirname, '../../../docs/deliverables/openapi.json');
    await exportOpenApi({
      url: `${app.url}/docs-json`,
      destination,
    });

    const res = await fetch(`${app.url}/docs-json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<
        string,
        Record<string, { summary?: string; responses?: Record<string, unknown> }>
      >;
    };

    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe('Digital Banking Simulator API');

    // Verify all business paths exist and have summaries
    const requiredPaths = [
      '/v1/identity/me',
      '/v1/customers/me',
      '/v1/accounts',
      '/v1/operator/accounts',
      '/v1/transfers',
      '/v1/operator/deposits',
      '/v1/audit/entries',
      '/v1/operator/fraud-flags',
    ];

    for (const path of requiredPaths) {
      expect(doc.paths[path]).toBeDefined();
      const methods = Object.keys(doc.paths[path]);
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        const op = doc.paths[path][method];
        expect(op.summary).toBeDefined();
        expect(op.summary!.trim().length).toBeGreaterThan(5);
        expect(op.responses).toBeDefined();
      }
    }
  });
});
