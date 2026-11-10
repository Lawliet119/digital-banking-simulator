/* eslint-disable @typescript-eslint/no-explicit-any -- free-form OpenAPI JSON: its shape is what the test checks */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parse } from 'dotenv';
import request from 'supertest';
import { ErrorCode } from '../../src/common/errors/error-code.enum';
import {
  mediaExampleGaps,
  type MediaObject,
  type SchemaMap,
} from '../../src/common/openapi/example-walker';
import { exportOpenApi } from '../../src/scripts/export-openapi';
import { configureHttpApp, setupSwagger } from '../../src/app.setup';
import { createDevTokenIssuer } from '../support/dev-tokens';
import {
  compareEndpoints,
  parseDocsEndpoints,
  parseDocsErrorCodes,
  type SwaggerOperation,
} from '../support/docs-endpoints';
import { NO_ROLE_ALLOWLIST } from '../support/no-role-allowlist';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

type Json = Record<string, any>;

const REPO = resolve(__dirname, '../../..');
const ARTIFACT = join(REPO, 'docs/deliverables/openapi.json');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** The codes only one route can return: the golden table the enricher output is compared with. */
const ROUTE_SPECIFIC: Record<string, Record<string, string[]>> = {
  'POST /v1/transfers': {
    '400': ['IDEMPOTENCY_KEY_REQUIRED'],
    '422': [
      'ACCOUNT_NOT_ACTIVE',
      'LIMIT_PER_TX_EXCEEDED',
      'LIMIT_PER_DAY_EXCEEDED',
      'INSUFFICIENT_FUNDS',
      'IDEMPOTENCY_KEY_REUSED',
    ],
  },
  'POST /v1/operator/deposits': {
    '400': ['IDEMPOTENCY_KEY_REQUIRED'],
    '422': ['ACCOUNT_NOT_ACTIVE', 'IDEMPOTENCY_KEY_REUSED'],
  },
  'POST /v1/accounts': { '409': ['ACCOUNT_LIMIT_REACHED'] },
  'POST /v1/operator/fraud-flags/{transferId}/review': { '409': ['FLAG_ALREADY_REVIEWED'] },
};
const IDEMPOTENT = ['POST /v1/transfers', 'POST /v1/operator/deposits'];

/** First JSON path where two values differ, or undefined when deep-equal. */
function firstDifference(a: unknown, b: unknown, path = '$'): string | undefined {
  if (Object.is(a, b)) return undefined;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return path;
  if (Array.isArray(a) !== Array.isArray(b)) return path;
  const left = a as Json;
  const right = b as Json;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const diff = firstDifference(left[key], right[key], `${path}.${key}`);
    if (diff !== undefined) return diff;
  }
  return undefined;
}

describe('DBS-137 the OpenAPI document is complete and agrees with docs/03', () => {
  const original = { ...process.env };
  let db: TempDatabase;
  let app: NestExpressApplication;
  let dir: string;
  let url: string;
  let doc: Json;
  let docs03: string;
  let operations: { key: string; method: string; path: string; op: Json }[];

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    dir = await fs.mkdtemp(join(tmpdir(), 'dbs137-api-'));
    const issuer = await createDevTokenIssuer();
    const jwks = join(dir, 'jwks.json');
    await fs.writeFile(jwks, JSON.stringify(issuer.jwks));
    Object.assign(process.env, parse(await fs.readFile('env/.env.example', 'utf8')), {
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      DATABASE_URL: db.url,
      DATABASE_SSL: 'false',
      AUTH_MODE: 'local',
      AUTH_LOCAL_JWKS_PATH: jwks,
      LOG_LEVEL: 'fatal',
    });
    const { AppModule } = await import('../../src/app.module');
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: false,
      abortOnError: false,
    });
    configureHttpApp(app, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
    setupSwagger(app); // the same call main.ts makes: /docs-json is the enriched document
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    doc = (await request(url).get('/docs-json').expect(200)).body as Json;
    docs03 = await fs.readFile(join(REPO, 'docs/03_HIGH_LEVEL_ARCHITECTURE.md'), 'utf8');
    operations = Object.entries(doc.paths as Json).flatMap(([path, item]) =>
      Object.entries(item as Json)
        .filter(([method]) => METHODS.includes(method))
        .map(([method, op]) => ({
          key: `${method.toUpperCase()} ${path}`,
          method: method.toUpperCase(),
          path,
          op: op as Json,
        })),
    );
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = original;
      await db?.drop();
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  });

  const hasSecurity = (op: Json): boolean => Array.isArray(op.security) && op.security.length > 0;
  const schemas = (): SchemaMap => (doc.components as Json).schemas as SchemaMap;

  it('TC-137-01 every operation has a summary, a role (or an explicit reason not to) and security', () => {
    expect(operations.length).toBeGreaterThanOrEqual(19);
    const problems: string[] = [];
    for (const { key, path, op } of operations) {
      if (typeof op.summary !== 'string' || op.summary.trim() === '')
        problems.push(`${key}: no summary`);
      const publicRoute = !hasSecurity(op);
      if (publicRoute && !path.startsWith('/health'))
        problems.push(`${key}: no security and not health`);
      const roles = op['x-roles'] as string[] | undefined;
      const hasRoles = Array.isArray(roles) && roles.length > 0;
      if (!hasRoles && !publicRoute && !(key in NO_ROLE_ALLOWLIST)) {
        problems.push(`${key}: no x-roles and not in the no-role allowlist`);
      }
      if (key in NO_ROLE_ALLOWLIST && hasRoles)
        problems.push(`${key}: allowlisted but has x-roles`);
    }
    expect(problems).toEqual([]);
  });

  it('TC-137-02 every request body and every 2xx response has a complete example, and money is a string', () => {
    const problems: string[] = [];
    for (const { key, op } of operations) {
      const bodies = Object.values((op.requestBody?.content ?? {}) as Record<string, MediaObject>);
      for (const media of bodies) {
        const gaps = mediaExampleGaps(media, schemas());
        if (gaps.length > 0) problems.push(`${key} request: ${gaps.join(', ')}`);
      }
      if (!Object.keys((op.responses ?? {}) as Json).some(status => status.startsWith('2'))) {
        problems.push(`${key}: no 2xx response`);
      }
      for (const [status, response] of Object.entries((op.responses ?? {}) as Json)) {
        if (!status.startsWith('2') || status === '204') continue;
        const content = Object.values((response.content ?? {}) as Record<string, MediaObject>);
        if (content.length === 0) problems.push(`${key} ${status}: no content`);
        for (const media of content) {
          const gaps = mediaExampleGaps(media, schemas());
          if (gaps.length > 0) problems.push(`${key} ${status}: ${gaps.join(', ')}`);
        }
      }
    }
    expect(problems).toEqual([]);
    for (const [name, schema] of Object.entries(schemas()) as [string, Json][]) {
      for (const field of ['amount', 'balance', 'fromBalanceBefore']) {
        const property = schema.properties?.[field] as Json | undefined;
        if (property?.type !== undefined)
          expect([name, field, property.type]).toEqual([name, field, 'string']);
      }
    }
  });

  it('TC-137-03 x-error-codes is complete, agrees with docs/03 section 7.1 and has a response per status', () => {
    const table = parseDocsErrorCodes(docs03);
    const problems: string[] = [];
    for (const { key, path, op } of operations) {
      const expected: Record<string, Set<string>> = {};
      const add = (status: string, codes: string[]) => {
        expected[status] = new Set([...(expected[status] ?? []), ...codes]);
      };
      if (hasSecurity(op)) {
        add('401', ['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'SESSION_REVOKED']);
        add('503', ['SERVICE_TEMPORARILY_UNAVAILABLE']);
      }
      if (Array.isArray(op['x-roles']) && op['x-roles'].length > 0) add('403', ['FORBIDDEN']);
      if (!path.startsWith('/health')) add('429', ['RATE_LIMITED']);
      for (const [status, codes] of Object.entries(ROUTE_SPECIFIC[key] ?? {})) add(status, codes);

      const actual = (op['x-error-codes'] ?? {}) as Record<string, string[]>;
      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
      for (const [status, codes] of Object.entries(actual)) {
        if ([...codes].sort().join() !== [...(expected[status] ?? [])].sort().join()) {
          problems.push(
            `${key} ${status}: ${codes.join(',')} instead of ${[...(expected[status] ?? [])].join(',')}`,
          );
        }
        for (const code of codes) {
          if (!(code in ErrorCode)) problems.push(`${key} ${status}: ${code} is not an ErrorCode`);
          if (table.get(code) !== status) {
            problems.push(
              `${key}: docs/03 7.1 says ${code} is ${table.get(code)}, Swagger lists it under ${status}`,
            );
          }
        }
        const response = (op.responses as Json)[status] as Json | undefined;
        if (response === undefined)
          problems.push(`${key}: x-error-codes has ${status} but no response`);
        else if (Object.keys(response.content ?? {}).length === 0)
          problems.push(`${key} ${status}: no content`);
        for (const code of codes) {
          if (!String(op.description).includes(code))
            problems.push(`${key}: description does not name ${code}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('TC-137-04 Idempotency-Key is a required 1-128 header on exactly the two money endpoints; the bearer scheme is declared', () => {
    const withHeader = operations
      .filter(({ op }) =>
        ((op.parameters ?? []) as Json[]).some(
          p => p.in === 'header' && p.name === 'Idempotency-Key',
        ),
      )
      .map(({ key }) => key)
      .sort();
    expect(withHeader).toEqual([...IDEMPOTENT].sort());
    for (const key of IDEMPOTENT) {
      const parameter = ((operations.find(o => o.key === key)!.op.parameters ?? []) as Json[]).find(
        p => p.name === 'Idempotency-Key',
      )!;
      expect(parameter.required).toBe(true);
      expect(parameter.schema).toMatchObject({ type: 'string', minLength: 1, maxLength: 128 });
    }
    expect((doc.components as Json).securitySchemes['access-token']).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('TC-137-05 the ErrorCode enum and the table of docs/03 section 7.1 have the same members and statuses', () => {
    const table = parseDocsErrorCodes(docs03);
    expect([...table.keys()].sort()).toEqual(Object.values(ErrorCode).sort());
  });

  it('TC-137-06/07 the endpoints and roles of docs/03 section 7 equal Swagger, planned rows aside', () => {
    const swagger: SwaggerOperation[] = operations.map(({ method, path, op }) => ({
      method,
      path,
      roles: op['x-roles'] as string[] | undefined,
      hasSecurity: hasSecurity(op),
    }));
    const rows = parseDocsEndpoints(docs03);
    expect(compareEndpoints(rows, swagger, new Set(Object.keys(NO_ROLE_ALLOWLIST)))).toEqual([]);
    expect(rows.filter(r => r.planned).map(r => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/admin/risk-config',
      'POST /v1/admin/risk-config/versions',
    ]);
  });

  it('TC-137-12 no example carries a token, and no customer schema mentions fraud', () => {
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/eyJ[\w-]+\.eyJ[\w-]+\./);
    expect(text).not.toContain('Bearer ey');
    expect(text).not.toMatch(/"(jti|origin_jti)"/);
    const customerRoots = operations
      .filter(
        ({ op }) =>
          Array.isArray(op['x-roles']) && (op['x-roles'] as string[]).includes('customer'),
      )
      .flatMap(({ op }) => JSON.stringify(op).match(/#\/components\/schemas\/\w+/g) ?? []);
    const reached = new Set<string>();
    const queue = customerRoots.map(ref => ref.split('/').pop()!);
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (reached.has(name) || schemas()[name] === undefined) continue;
      reached.add(name);
      for (const ref of JSON.stringify(schemas()[name]).match(/#\/components\/schemas\/\w+/g) ??
        []) {
        queue.push(ref.split('/').pop()!);
      }
    }
    expect(reached.size).toBeGreaterThan(5);
    for (const name of reached) {
      if (/ProblemDto$|^ProblemDetailsDto$/.test(name)) continue;
      expect([
        name,
        JSON.stringify(schemas()[name]).match(/fraud|flag|risk|score|review/i),
      ]).toEqual([name, null]);
    }
  });

  it('TC-137-11 docs/deliverables/openapi.json equals the document the app serves', async () => {
    const update = process.env.OPENAPI_UPDATE === '1';
    if (update && process.env.CI) {
      throw new Error(
        'OPENAPI_UPDATE=1 must not be set in CI: the artifact would be rewritten, never compared',
      );
    }
    if (update) await exportOpenApi({ url: `${url}/docs-json`, destination: ARTIFACT });
    const committed = JSON.parse(await fs.readFile(ARTIFACT, 'utf8')) as unknown;
    const difference = firstDifference(committed, doc);
    if (difference !== undefined) {
      throw new Error(
        `docs/deliverables/openapi.json differs from /docs-json at ${difference}. ` +
          'Re-export it: OPENAPI_UPDATE=1 npm run test:db -- test/db/openapi-completeness.db-spec.ts ' +
          '(or npm run openapi:export against a running API), then commit the file.',
      );
    }
    expect(difference).toBeUndefined();
  });
});
