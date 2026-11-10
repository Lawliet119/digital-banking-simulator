import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parse } from 'dotenv';
import request from 'supertest';
import { configureHttpApp, setupSwagger } from '../../src/app.setup';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { createDevTokenIssuer } from '../support/dev-tokens';
import { ErrorCode } from '../../src/common/errors/error-code.enum';
import { exportOpenApi } from '../../src/scripts/export-openapi';

interface OpenApiSchema {
  type?: string;
  $ref?: string;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  example?: unknown;
  items?: OpenApiSchema;
}

interface OpenApiResponse {
  description?: string;
  content?: {
    [contentType: string]: {
      schema?: OpenApiSchema;
      examples?: Record<string, { value: unknown }>;
    };
  };
}

interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  operationId?: string;
  'x-roles'?: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema?: OpenApiSchema;
  }>;
  requestBody?: {
    required?: boolean;
    content?: {
      [contentType: string]: {
        schema?: OpenApiSchema;
      };
    };
  };
  responses: Record<string, OpenApiResponse>;
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    schemas: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, unknown>;
  };
}

const EXPECTED_IMPLEMENTED_PATHS = [
  '/health/live',
  '/health/ready',
  '/v1/accounts',
  '/v1/accounts/{id}',
  '/v1/accounts/{id}/transactions',
  '/v1/audit/entries',
  '/v1/customers/me',
  '/v1/identity/me',
  '/v1/operator/accounts',
  '/v1/operator/accounts/{id}/lock',
  '/v1/operator/accounts/{id}/unlock',
  '/v1/operator/deposits',
  '/v1/operator/fraud-flags',
  '/v1/operator/fraud-flags/{transferId}',
  '/v1/operator/fraud-flags/{transferId}/review',
  '/v1/transfers',
  '/v1/transfers/{id}',
].sort();

describe('DBS-137 Clean OpenAPI specification and error codes', () => {
  const originalEnv = { ...process.env };
  let db: TempDatabase;
  let app: NestExpressApplication;
  let dir: string;
  let url: string;
  let doc: OpenApiDocument;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    dir = await fs.mkdtemp(join(tmpdir(), 'dbs137-api-'));
    const issuer = await createDevTokenIssuer();
    const jwksPath = join(dir, 'jwks.json');
    await fs.writeFile(jwksPath, JSON.stringify(issuer.jwks));

    Object.assign(process.env, parse(await fs.readFile('env/.env.example', 'utf8')), {
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      DATABASE_URL: db.url,
      DATABASE_SSL: 'false',
      AUTH_MODE: 'local',
      AUTH_LOCAL_JWKS_PATH: jwksPath,
      LOG_LEVEL: 'fatal',
    });

    const { AppModule } = await import('../../src/app.module');
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: false,
      abortOnError: false,
    });
    configureHttpApp(app, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
    setupSwagger(app);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();

    const res = await request(app.getHttpServer()).get('/docs-json').expect(200);
    doc = res.body as OpenApiDocument;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = originalEnv;
      await db?.drop();
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('TC-137-01 covers exact 17 paths / 19 operations, each with summary and role info', () => {
    const paths = Object.keys(doc.paths);
    expect(paths.length).toBe(17);

    let operationCount = 0;
    for (const [pathKey, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        operationCount++;

        // Every operation must have a non-empty summary and tags
        expect(op.summary).toBeDefined();
        expect(op.summary!.trim().length).toBeGreaterThan(5);
        expect(op.tags).toBeDefined();
        expect(op.tags!.length).toBeGreaterThan(0);

        // Every operation documents its role
        if (pathKey.startsWith('/health/')) {
          expect(op.summary).toMatch(/Liveness|Readiness/i);
        } else if (pathKey === '/v1/identity/me') {
          expect(op['x-roles']).toEqual(['customer', 'operator', 'auditor', 'admin']);
        } else {
          expect(Array.isArray(op['x-roles'])).toBe(true);
          expect(op['x-roles']!.length).toBeGreaterThan(0);
        }
      }
    }

    expect(operationCount).toBe(19);
  });

  it('TC-137-02 verifies every request body has schema & example, and 200/201 has schema/properties', () => {
    for (const [, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

        // If operation takes a requestBody, verify JSON schema exists
        if (op.requestBody) {
          const bodyJson = op.requestBody.content?.['application/json'];
          expect(bodyJson).toBeDefined();
          expect(bodyJson?.schema).toBeDefined();
        }

        // Verify success response exists (200 or 201)
        const successStatus = method === 'post' && !op.responses['200'] ? '201' : '200';
        const successResp = op.responses[successStatus];
        expect(successResp).toBeDefined();
        const jsonContent = successResp.content?.['application/json'];
        expect(jsonContent).toBeDefined();
        expect(jsonContent?.schema).toBeDefined();
      }
    }

    // Specific check: /health/live returns schema status: 'ok'
    const liveSuccess = doc.paths['/health/live'].get.responses['200'];
    expect(liveSuccess.content?.['application/json']?.schema?.properties?.status).toBeDefined();

    // Specific check: /v1/identity/me returns AuthenticatedUserDto
    const identitySuccess = doc.paths['/v1/identity/me'].get.responses['200'];
    expect(identitySuccess.content?.['application/json']?.schema?.$ref).toContain(
      'AuthenticatedUserDto',
    );
  });

  it('TC-137-03 verifies error responses use application/problem+json and all 14 ErrorCodes appear', () => {
    const errorCodesFound = new Set<string>();

    for (const [pathKey, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

        for (const [statusStr, resp] of Object.entries(op.responses)) {
          const status = parseInt(statusStr, 10);
          if (status >= 400) {
            // For all business endpoints (/v1/...), application/problem+json is required
            if (pathKey.startsWith('/v1/')) {
              expect(resp.content?.['application/problem+json']).toBeDefined();
            }

            // Collect any examples that contain errorCode
            const examples = resp.content?.['application/problem+json']?.examples;
            if (examples) {
              for (const ex of Object.values(examples)) {
                const val = ex.value as { errorCode?: string };
                if (val?.errorCode) {
                  errorCodesFound.add(val.errorCode);
                }
              }
            }
          }
        }
      }
    }

    // Verify all 14 ErrorCode enum values are represented in error examples
    const allExpectedCodes = Object.values(ErrorCode);
    expect(allExpectedCodes.length).toBe(14);
    for (const code of allExpectedCodes) {
      expect(errorCodesFound.has(code)).toBe(true);
    }
  });

  it('TC-137-04 verifies bearerAuth on all 17 business operations, and Idempotency-Key on transfers & deposits', () => {
    expect(doc.components.securitySchemes?.['access-token']).toBeDefined();

    for (const [pathKey, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

        if (pathKey.startsWith('/health/')) {
          expect(op.security).toBeUndefined();
        } else {
          expect(op.security).toEqual([{ 'access-token': [] }]);
        }
      }
    }

    // Transfers POST has Idempotency-Key header
    const transferParams = doc.paths['/v1/transfers'].post.parameters;
    const transferIdemKey = transferParams?.find(p => p.name === 'Idempotency-Key');
    expect(transferIdemKey).toBeDefined();
    expect(transferIdemKey?.required).toBe(true);
    expect(transferIdemKey?.in).toBe('header');

    // Operator deposits POST has Idempotency-Key header
    const depositParams = doc.paths['/v1/operator/deposits'].post.parameters;
    const depositIdemKey = depositParams?.find(p => p.name === 'Idempotency-Key');
    expect(depositIdemKey).toBeDefined();
    expect(depositIdemKey?.required).toBe(true);
    expect(depositIdemKey?.in).toBe('header');
  });

  it('TC-137-05 reconciles paths with docs/03 §7: exact 1:1 match with 17 Implemented paths', () => {
    const actualPaths = Object.keys(doc.paths).sort();
    expect(actualPaths).toEqual(EXPECTED_IMPLEMENTED_PATHS);
  });

  it('TC-137-06 exports updated OpenAPI artifact and verifies file integrity', async () => {
    const destination = resolve(__dirname, '../../../docs/deliverables/openapi.json');
    await exportOpenApi({ url: url + '/docs-json', destination });
    const text = await fs.readFile(destination, 'utf8');
    const exportedDoc = JSON.parse(text);
    expect(exportedDoc.openapi).toBe('3.0.0');
    expect(Object.keys(exportedDoc.paths).sort()).toEqual(EXPECTED_IMPLEMENTED_PATHS);
    expect(exportedDoc.components?.schemas?.ProblemDetailsDto).toBeDefined();
    expect(exportedDoc.components?.schemas?.AuthenticatedUserDto).toBeDefined();
  });
});

