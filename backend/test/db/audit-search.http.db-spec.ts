import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parse } from 'dotenv';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { Logger as PinoNestLogger, PinoLogger } from 'nestjs-pino';
import request, { type Response } from 'supertest';
import { configureHttpApp, setupSwagger } from '../../src/app.setup';
import { LOCAL_CLIENT_ID, LOCAL_ISSUER } from '../../src/config/auth-local';
import { createHttpLogging } from '../../src/common/logging/http-logging';
import { createLoggingOptions } from '../../src/common/logging/logging.options';
import { SafeLogger } from '../../src/common/logging/safe-logger';
import type { AuditEntriesPage } from '../../src/modules/audit/audit-search.query';
import { SEARCH_FIXTURE, seedAuditSearchData } from '../support/audit-search-fixtures';
import { createDevTokenIssuer, type DevTokenIssuer } from '../support/dev-tokens';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

const ROUTE = '/v1/audit/entries';
const backend = resolve(__dirname, '../..');
const example = parse(readFileSync(join(backend, 'env/.env.example')));
const precisionIds = ['9007199254740994', '9007199254740993', '9007199254740995'];
const sortIds = ['10000000000000000', '9999999999999999', '10', '9'];

describe('DBS-103 audit search through the real AppModule, JWT and PostgreSQL', () => {
  const originalEnv = { ...process.env };
  let db: TempDatabase;
  let app: NestExpressApplication;
  let issuer: DevTokenIssuer;
  let multiKey: KeyLike;
  let directory: string;
  let auditorToken: string;
  let output = '';

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    await seedAuditSearchData(db.runner);
    issuer = await createDevTokenIssuer();
    const multi = await generateKeyPair('RS256');
    multiKey = multi.privateKey;
    directory = mkdtempSync(join(tmpdir(), 'dbs103-http-'));
    const jwksPath = join(directory, 'jwks.json');
    writeFileSync(
      jwksPath,
      JSON.stringify({
        keys: [
          ...issuer.jwks.keys,
          {
            ...(await exportJWK(multi.publicKey)),
            kid: 'multi-role-key',
            alg: 'RS256',
            use: 'sig',
          },
        ],
      }),
    );
    Object.assign(process.env, example, {
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      DATABASE_URL: db.url,
      DATABASE_SSL: 'false',
      DATABASE_POOL_MAX: '12',
      REDIS_URL: 'redis://127.0.0.1:6379',
      AUTH_MODE: 'local',
      AUTH_LOCAL_JWKS_PATH: jwksPath,
      LOG_LEVEL: 'debug',
    });
    for (const name of [
      'COGNITO_USER_POOL_ID',
      'COGNITO_CLIENT_ID',
      'COGNITO_ISSUER',
      'DATABASE_SSL_CA_PATH',
    ]) {
      delete process.env[name];
    }
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString();
        done();
      },
    });
    const settings = { role: 'api', logLevel: 'debug' } as const;
    const pinoLogger = new PinoLogger({ pinoHttp: [createLoggingOptions(settings), stream] });
    const logger = new SafeLogger(new PinoNestLogger(pinoLogger, {}));
    // AppModule evaluates APP_ROLE while being imported, after the isolated DB/local JWKS exist.
    const { AppModule } = await import('../../src/app.module');
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger,
      abortOnError: false,
    });
    configureHttpApp(
      app,
      { trustProxyHops: 0, corsOrigins: [], isProduction: false },
      createHttpLogging(pinoLogger, settings),
    );
    setupSwagger(app);
    // Listen once: ten concurrent supertest requests must share one real listener.
    await app.listen(0, '127.0.0.1');
    auditorToken = await issuer.token('auditor');
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = originalEnv;
      await db?.drop();
      if (directory) {
        unlinkSync(join(directory, 'jwks.json'));
        rmdirSync(directory);
      }
      Logger.overrideLogger(false);
    }
  });

  function entries(response: Response) {
    return (response.body as AuditEntriesPage).entries;
  }

  function get(query: Record<string, string> = {}, token = auditorToken) {
    return request(app.getHttpServer())
      .get(ROUTE)
      .query(query)
      .set('Authorization', `Bearer ${token}`);
  }

  async function searchCount(): Promise<number> {
    const [row] = (await db.runner.query(
      "SELECT count(*)::text AS count FROM audit_log WHERE action = 'audit.search'",
    )) as { count: string }[];
    return Number(row.count);
  }

  async function auditFor(correlationId: string): Promise<Record<string, unknown>[]> {
    return (await db.runner.query('SELECT * FROM audit_log WHERE correlation_id = $1::uuid', [
      correlationId,
    ])) as Record<string, unknown>[];
  }

  it('TC-103-04/15 returns the exact combined filter and public audit projection', async () => {
    const response = await get({
      actorUserId: SEARCH_FIXTURE.actorUserId.toUpperCase(),
      action: 'transfer.create',
      from: '2026-11-04T08:00:00Z',
      to: '2026-11-04T09:00:00Z',
      correlationId: SEARCH_FIXTURE.correlationId.toUpperCase(),
      limit: '100',
    }).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(entries(response).map(row => row.id)).toEqual(precisionIds);
    expect(response.body.nextCursor).toBeNull();
    for (const row of entries(response)) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'id',
          'occurredAt',
          'actorUserId',
          'actorRole',
          'action',
          'outcome',
          'target',
          'correlationId',
          'metadata',
        ].sort(),
      );
      expect(row.occurredAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
      expect(typeof row.id).toBe('string');
      expect(row.actorUserId).toBe(SEARCH_FIXTURE.actorUserId);
      expect(row.action).toBe('transfer.create');
      expect(Object.keys(row.target).sort()).toEqual(['id', 'type']);
    }
    expect(JSON.stringify(response.body)).not.toMatch(/cognito_sub|fraud_flag|display_name|email/);
  });

  it('TC-103-04 applies every optional filter independently and preserves a NULL system actor', async () => {
    const actor = await get({ actorUserId: SEARCH_FIXTURE.actorUserId, limit: '100' }).expect(200);
    expect(entries(actor).length).toBeGreaterThanOrEqual(3);
    expect(entries(actor).every(row => row.actorUserId === SEARCH_FIXTURE.actorUserId)).toBe(true);
    const action = await get({ action: 'transfer.create', limit: '100' }).expect(200);
    expect(entries(action).length).toBeGreaterThanOrEqual(3);
    expect(entries(action).every(row => row.action === 'transfer.create')).toBe(true);
    const boundary = await get({
      correlationId: SEARCH_FIXTURE.correlationId,
      from: '2026-11-04T08:10:00.123456Z',
      to: '2026-11-04T08:10:00.123457Z',
    }).expect(200);
    expect(entries(boundary).map(row => row.id)).toEqual(precisionIds.slice(0, 2));
    const from = await get({
      correlationId: SEARCH_FIXTURE.correlationId,
      from: '2026-11-04T08:10:00.123456Z',
    }).expect(200);
    expect(entries(from).map(row => row.id)).toEqual(precisionIds.slice(0, 2));
    const to = await get({
      correlationId: SEARCH_FIXTURE.correlationId,
      to: '2026-11-04T08:10:00.123456Z',
    }).expect(200);
    expect(entries(to).map(row => row.id)).toEqual([precisionIds[2]]);
    const system = await get({ correlationId: SEARCH_FIXTURE.performanceCorrelationId }).expect(
      200,
    );
    expect(entries(system)).toHaveLength(1);
    expect(entries(system)[0].actorUserId).toBeNull();
  });

  it('TC-103-05 commits one self-audit even for an empty result', async () => {
    const response = await get({ correlationId: randomUUID() }).expect(200);
    expect(response.body).toEqual({ entries: [], nextCursor: null });
    const rows = await auditFor(response.headers['x-correlation-id']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'audit.search', outcome: 'SUCCESS' });
  });

  it.each([
    'limit=0',
    'limit=101',
    'limit=01',
    'limit=1.5',
    'limit=',
    'actorUserId=null',
    'correlationId=not-a-uuid',
    'action=',
    'action=%20%20',
    'action=%00',
    'from=2026-02-29T00%3A00%3A00Z',
    'from=2026-01-01T00%3A00%3A60Z',
    'from=2026-01-01T00%3A00%3A00.1234567Z',
    'from=1969-12-31T00%3A00%3A00Z',
    'from=2026-01-01T00%3A00%3A00%2B00%3A00',
    'from=2026-01-01T00%3A00%3A00Z&to=2026-01-01T00%3A00%3A00Z',
    'from=2026-01-02T00%3A00%3A00Z&to=2026-01-01T00%3A00%3A00Z',
    'unknown=private-probe%40example.invalid',
    'limit=1&limit=2',
    'limit%5B%5D=1',
    'cursor%5Bv%5D=1',
    'actorUserId%5Bx%5D=1',
  ])(
    'TC-103-02 rejects invalid/unknown/repeated/nested query %s before self-audit',
    async query => {
      const before = await searchCount();
      const response = await request(app.getHttpServer())
        .get(`${ROUTE}?${query}`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .expect(400)
        .expect('Content-Type', /application\/problem\+json/);
      expect(response.body.errorCode).toBeUndefined();
      expect(response.body.errors).toEqual(expect.any(Array));
      expect(response.body.correlationId).toBe(response.headers['x-correlation-id']);
      expect(JSON.stringify(response.body)).not.toContain('private-probe');
      expect(await searchCount()).toBe(before);
    },
  );

  it('TC-103-03 rejects damaged cursor payloads and changed filters but permits changing limit', async () => {
    const first = await get({ correlationId: SEARCH_FIXTURE.sortCorrelationId, limit: '1' }).expect(
      200,
    );
    const cursor = first.body.nextCursor as string;
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const invalid = [
      'private-probe@example.invalid',
      `${cursor}=`,
      'a'.repeat(513),
      Buffer.from('not json').toString('base64url'),
      encode({ ...payload, v: 2 }),
      encode({ ...payload, id: '0' }),
      encode({ ...payload, id: '9223372036854775808' }),
      encode({ ...payload, t: '2026-11-04T08:20:00.123Z' }),
      encode({ ...payload, f: '0'.repeat(64) }),
      encode({ ...payload, extra: true }),
    ];
    const before = await searchCount();
    for (const value of invalid) {
      const response = await get({
        correlationId: SEARCH_FIXTURE.sortCorrelationId,
        cursor: value,
      }).expect(400);
      expect(response.body.errorCode).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain('private-probe');
    }
    await get({ correlationId: SEARCH_FIXTURE.correlationId, cursor }).expect(400);
    expect(await searchCount()).toBe(before);
    const next = await get({
      correlationId: SEARCH_FIXTURE.sortCorrelationId,
      cursor,
      limit: '2',
    }).expect(200);
    expect(entries(next).map(row => row.id)).toEqual(sortIds.slice(1, 3));
  });

  it('TC-103-06 refuses missing, altered-signature and expired tokens without searching', async () => {
    const before = await searchCount();
    const missing = await request(app.getHttpServer()).get(ROUTE).expect(401);
    expect(missing.body.errorCode).toBe('UNAUTHENTICATED');
    const parts = auditorToken.split('.');
    parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
    const altered = await get({}, parts.join('.')).expect(401);
    expect(altered.body.errorCode).toBe('UNAUTHENTICATED');
    const now = Math.floor(Date.now() / 1000);
    const expired = await issuer.token('auditor', { iat: now - 3600, exp: now - 1800 });
    const response = await get({}, expired).expect(401);
    expect(response.body.errorCode).toBe('TOKEN_EXPIRED');
    expect(await searchCount()).toBe(before);
    for (const result of [missing, altered, response]) {
      expect(result.body.entries).toBeUndefined();
    }
  });

  it.each(['customer', 'operator', 'admin'] as const)(
    'TC-103-07 refuses %s even when query/header/body claim auditor',
    async role => {
      const before = await searchCount();
      const response = await get({ role: 'auditor' }, await issuer.token(role))
        .set('X-Role', 'auditor')
        .send({ role: 'auditor' })
        .expect(403);
      expect(response.body.errorCode).toBe('FORBIDDEN');
      expect(response.body.entries).toBeUndefined();
      expect(await searchCount()).toBe(before);
    },
  );

  it('TC-103-07 permits an auditor+admin token with audit attribution fixed to auditor', async () => {
    const token = await new SignJWT({
      sub: 'kiem-toan-vien-nguyen-thu-ha',
      client_id: LOCAL_CLIENT_ID,
      token_use: 'access',
      'cognito:groups': ['admin', 'auditor'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'multi-role-key' })
      .setIssuer(LOCAL_ISSUER)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(multiKey);
    const response = await get({ correlationId: SEARCH_FIXTURE.correlationId }, token).expect(200);
    const [row] = await auditFor(response.headers['x-correlation-id']);
    expect(row.actor_role).toBe('auditor');
    const [user] = (await db.runner.query('SELECT id FROM users WHERE cognito_sub = $1', [
      'kiem-toan-vien-nguyen-thu-ha',
    ])) as { id: string }[];
    expect(row.actor_user_id).toBe(user.id);
  });

  it.each(['1', '2', '100'])(
    'TC-103-08 pages numeric bigint ties and microseconds with limit %s',
    async limit => {
      for (const [correlationId, expected] of [
        [SEARCH_FIXTURE.sortCorrelationId, sortIds],
        [SEARCH_FIXTURE.correlationId, precisionIds],
      ] as const) {
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
          const query: Record<string, string> = { correlationId, limit };
          if (cursor !== null) query.cursor = cursor;
          const response: Response = await get(query).expect(200);
          ids.push(...entries(response).map(row => row.id));
          cursor = (response.body as AuditEntriesPage).nextCursor;
          expect(ids.length).toBeLessThanOrEqual(expected.length);
        } while (cursor);
        expect(ids).toEqual(expected);
        expect(new Set(ids).size).toBe(ids.length);
      }
    },
  );

  it('TC-103-09 does not repeat or shift older pages when newer rows/self-audits arrive', async () => {
    const correlationId = randomUUID();
    const inserted = (await db.runner.query(
      `INSERT INTO audit_log
       (occurred_at,actor_role,action,outcome,target_type,target_id,correlation_id)
       SELECT t::timestamptz,'system','audit.fixture.live','SUCCESS','fixture','live',$1::uuid
       FROM unnest(ARRAY['2026-11-04T08:00:03Z','2026-11-04T08:00:02Z','2026-11-04T08:00:01Z']) t
       RETURNING id::text`,
      [correlationId],
    )) as { id: string }[];
    const first = await get({ correlationId, limit: '1' }).expect(200);
    await db.runner.query(
      `INSERT INTO audit_log
       (occurred_at,actor_role,action,outcome,target_type,target_id,correlation_id)
       VALUES ('2099-01-01T00:00:00Z','system','audit.fixture.live','SUCCESS','fixture','new',$1::uuid)`,
      [correlationId],
    );
    const second = await get({
      correlationId,
      limit: '100',
      cursor: first.body.nextCursor as string,
    }).expect(200);
    expect([...entries(first), ...entries(second)].map(row => row.id)).toEqual(
      inserted.map(row => row.id),
    );
    expect(second.body.nextCursor).toBeNull();
  });

  it('TC-103-10 uses the server correlation and one durable self-audit per page/retry', async () => {
    const correlations: string[] = [];
    const first = await get({ correlationId: SEARCH_FIXTURE.correlationId, limit: '1' })
      .set('X-Correlation-Id', SEARCH_FIXTURE.correlationId)
      .set('X-Request-Id', SEARCH_FIXTURE.correlationId)
      .expect(200);
    const next = await get({
      correlationId: SEARCH_FIXTURE.correlationId,
      cursor: first.body.nextCursor as string,
      limit: '1',
    }).expect(200);
    const retry = await get({ correlationId: SEARCH_FIXTURE.correlationId, limit: '1' }).expect(
      200,
    );
    for (const response of [first, next, retry]) {
      const correlationId = response.headers['x-correlation-id'];
      correlations.push(correlationId);
      expect(correlationId).not.toBe(SEARCH_FIXTURE.correlationId);
      const rows = await auditFor(correlationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_user_id: SEARCH_FIXTURE.auditorUserId,
        actor_role: 'auditor',
        action: 'audit.search',
        outcome: 'SUCCESS',
        target_type: 'audit_search',
        target_id: correlationId,
        correlation_id: correlationId,
        metadata: {},
      });
    }
    expect(new Set(correlations).size).toBe(3);
  });

  it('TC-103-11 fails closed on a real SHARE-lock INSERT timeout, then recovers', async () => {
    const blocker = db.runner.connection.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    let failed: Response;
    try {
      await blocker.query('LOCK TABLE audit_log IN SHARE MODE');
      const [control] = (await blocker.query('SELECT count(*)::text AS count FROM audit_log')) as {
        count: string;
      }[];
      expect(Number(control.count)).toBeGreaterThan(0);
      failed = await get({ correlationId: SEARCH_FIXTURE.correlationId }).expect(503);
      expect(failed.headers['retry-after']).toBe('5');
      expect(failed.body.errorCode).toBe('SERVICE_TEMPORARILY_UNAVAILABLE');
      expect(failed.body.entries).toBeUndefined();
    } finally {
      await blocker.rollbackTransaction();
      await blocker.release();
    }
    expect(await auditFor(failed.headers['x-correlation-id'])).toHaveLength(0);
    const recovered = await get({ correlationId: SEARCH_FIXTURE.correlationId }).expect(200);
    expect(await auditFor(recovered.headers['x-correlation-id'])).toHaveLength(1);
  });

  it('TC-103-13 attributes ten concurrent real requests to ten users/server correlations', async () => {
    const subjects = [
      'kiem-toan-nguyen-thu-ha',
      'kiem-toan-tran-minh-anh',
      'kiem-toan-le-thanh-tung',
      'kiem-toan-pham-ngoc-lan',
      'kiem-toan-hoang-quoc-bao',
      'kiem-toan-do-thuy-linh',
      'kiem-toan-vu-anh-khoa',
      'kiem-toan-dang-hoa-mai',
      'kiem-toan-bui-trung-kien',
      'kiem-toan-ngo-bao-chau',
    ];
    const tokens = await Promise.all(subjects.map(sub => issuer.token('auditor', { sub })));
    const before = await searchCount();
    const responses = await Promise.all(
      tokens.map(token => get({ correlationId: SEARCH_FIXTURE.correlationId }, token).expect(200)),
    );
    expect(await searchCount()).toBe(before + 10);
    const correlations = responses.map(response => response.headers['x-correlation-id']);
    expect(new Set(correlations).size).toBe(10);
    for (const [index, response] of responses.entries()) {
      const [user] = (await db.runner.query('SELECT id FROM users WHERE cognito_sub=$1', [
        subjects[index],
      ])) as { id: string }[];
      const rows = await auditFor(response.headers['x-correlation-id']);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_user_id: user.id,
        actor_role: 'auditor',
        correlation_id: correlations[index],
        metadata: {},
      });
    }
  });

  it('TC-103-14 treats SQL-looking action as exact data and never logs raw query/token/PII', async () => {
    output = '';
    const hostile = "transfer.create' OR 1=1 --";
    const response = await get({ action: hostile }).expect(200);
    expect(response.body).toEqual({ entries: [], nextCursor: null });
    const invalid = await get({ cursor: 'private-probe@example.invalid' }).expect(400);
    expect(JSON.stringify(invalid.body)).not.toContain('private-probe');
    expect(output).toContain('Request completed');
    for (const value of [
      hostile,
      auditorToken,
      'private-probe',
      'SELECT a.',
      'INSERT INTO audit_log',
    ]) {
      expect(output).not.toContain(value);
    }
    const [row] = await auditFor(response.headers['x-correlation-id']);
    expect(row.metadata).toEqual({});
    expect(row.action).toBe('audit.search');
  });

  it('TC-103-16 provides no audit mutation routes and leaves every audit row unchanged', async () => {
    const snapshot = async (): Promise<{ count: string; hash: string }[]> =>
      (await db.runner.query(
        "SELECT count(*)::text AS count, md5(string_agg(row_to_json(a)::text,'' ORDER BY a.id)) AS hash FROM audit_log a",
      )) as { count: string; hash: string }[];
    const before = await snapshot();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const response = await request(app.getHttpServer())
        [method](ROUTE)
        .set('Authorization', `Bearer ${auditorToken}`)
        .send({ action: 'changed' })
        .expect(404);
      expect(response.body.errorCode).toBeUndefined();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('TC-103-20 serves the seven-query auditor-only Bearer contract from actual Swagger', async () => {
    await request(app.getHttpServer()).get('/docs').expect(200);
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);
    const document = response.body;
    const operation = document.paths[ROUTE].get;
    expect(Object.keys(document.paths[ROUTE])).toEqual(['get']);
    expect(operation['x-roles']).toEqual(['auditor']);
    expect(operation.security).toEqual([{ 'access-token': [] }]);
    const names = (operation.parameters as { name: string }[])
      .map(parameter => parameter.name)
      .sort();
    expect(names).toEqual([
      'action',
      'actorUserId',
      'correlationId',
      'cursor',
      'from',
      'limit',
      'to',
    ]);
    for (const status of ['200', '400', '401', '403', '500', '503']) {
      expect(operation.responses[status]).toBeDefined();
    }
    for (const status of ['400', '401', '403', '500', '503']) {
      expect(operation.responses[status].content['application/problem+json'].schema.$ref).toBe(
        '#/components/schemas/AuditSearchProblemDto',
      );
    }
    expect(operation.responses['200'].content['application/json']).toBeDefined();
    const schemas = document.components.schemas;
    expect(schemas.AuditEntryDto.properties.id.type).toBe('string');
    expect(schemas.AuditEntryDto.properties.occurredAt.type).toBe('string');
    expect(schemas.AuditEntryDto.properties.actorUserId.nullable).toBe(true);
    expect(schemas.AuditEntriesPageDto.properties.nextCursor.nullable).toBe(true);
    expect(schemas.AuditEntriesPageDto.properties.entries.items.$ref).toContain('AuditEntryDto');
  });

  it('TC-103-19 boots the real worker with no listener/query/identity while the writer still commits', async () => {
    const holder = createServer();
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve));
    const address = holder.address();
    if (!address || typeof address === 'string') throw new Error('No worker probe port');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      APP_ROLE: 'worker',
      PORT: String(address.port),
      AUTH_MODE: 'cognito',
      TS_NODE_TRANSPILE_ONLY: 'true',
    };
    delete env.AUTH_LOCAL_JWKS_PATH;
    const prefix = ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register'];
    const child = spawn(process.execPath, [...prefix, 'src/main.ts'], {
      cwd: backend,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let workerOutput = '';
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const ready = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Worker readiness deadline')), 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        workerOutput += chunk.toString();
        if (workerOutput.includes('Worker started — no HTTP listener')) {
          clearTimeout(deadline);
          resolve();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        workerOutput += chunk.toString();
      });
      child.once('close', () => {
        clearTimeout(deadline);
        reject(new Error('Worker exited before readiness'));
      });
    });
    try {
      await ready;
      expect(workerOutput).not.toContain('HTTP listener started');
    } finally {
      child.kill();
      await closed;
      await new Promise<void>((resolve, reject) =>
        holder.close(error => (error ? reject(error) : resolve())),
      );
    }
    const correlationId = randomUUID();
    const script = `
      require('reflect-metadata');
      const assert = require('node:assert/strict');
      const { NestFactory } = require('@nestjs/core');
      const { AppModule } = require('./src/app.module');
      const { AuditService } = require('./src/modules/audit');
      const { AuditSearchService } = require('./src/modules/audit/audit-search.service');
      const { AuditController } = require('./src/modules/audit/audit.controller');
      const { IdentityService } = require('./src/modules/identity');
      (async () => {
        const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
        try {
          for (const token of [AuditSearchService, AuditController, IdentityService]) assert.throws(() => app.get(token));
          await app.get(AuditService).recordDenied({ actor: null, role: 'system', action: 'worker.audit.probe', target: { type: 'worker', id: 'probe' }, correlationId: process.argv[1], metadata: {} });
          process.stdout.write(JSON.stringify({ event: 'worker-di-verified' }) + '\\n');
        } finally { await app.close(); }
      })().catch(() => { process.stderr.write('Worker DI probe failed\\n'); process.exitCode = 1; });
    `;
    const probe = spawn(process.execPath, [...prefix, '-e', script, correlationId], {
      cwd: backend,
      env,
    });
    let probeOutput = '';
    probe.stdout.on('data', (chunk: Buffer) => {
      probeOutput += chunk.toString();
    });
    probe.stderr.on('data', (chunk: Buffer) => {
      probeOutput += chunk.toString();
    });
    const status = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => {
        probe.kill();
        reject(new Error('Worker DI probe deadline'));
      }, 30_000);
      probe.once('error', error => {
        clearTimeout(deadline);
        reject(error);
      });
      probe.once('close', code => {
        clearTimeout(deadline);
        resolve(code);
      });
    });
    expect(status).toBe(0);
    expect(probeOutput).toContain('worker-di-verified');
    const rows = await auditFor(correlationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'worker.audit.probe', outcome: 'DENIED' });
  });
});
