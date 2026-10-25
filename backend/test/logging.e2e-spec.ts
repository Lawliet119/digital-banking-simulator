import { Body, Controller, Get, Injectable, Logger, Param, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Writable } from 'node:stream';
import { Logger as PinoNestLogger, LoggerModule, PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { configureHttpApp } from '../src/app.setup';
import { createLoggingOptions } from '../src/common/logging/logging.options';
import { createHttpLogging } from '../src/common/logging/http-logging';
import { CorrelationModule } from '../src/common/correlation/correlation.module';
import { CorrelationContext } from '../src/common/correlation/correlation-context';

@Injectable()
class NestedTraceService {
  private readonly logger = new Logger(NestedTraceService.name);
  private arrivals = 0;
  private release?: () => void;
  private readonly barrier = new Promise<void>(resolve => (this.release = resolve));

  constructor(private readonly context: CorrelationContext) {}

  async observe(slot: string): Promise<{ correlationId: string | undefined }> {
    this.arrivals++;
    if (this.arrivals === 2) this.release?.();
    await this.barrier;
    const correlationId = this.context.getCorrelationId();
    this.logger.log({ slot, observedId: correlationId }, 'Nested service completed');
    return { correlationId };
  }
}

@Controller('logging-probe')
class LoggingProbeController {
  private readonly logger = new Logger(LoggingProbeController.name);

  constructor(private readonly nested: NestedTraceService) {}

  @Get('nested/:slot')
  nestedTrace(@Param('slot') slot: string) {
    return this.nested.observe(slot);
  }

  @Get('ok')
  ok() {
    this.logger.log('Handler completed');
    return { ok: true };
  }

  @Post('body')
  body(@Body() _body: unknown) {
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('sensitive-unhandled-fixture');
  }

  @Get('transient')
  transient(): never {
    throw Object.assign(new Error('sensitive-db-fixture'), { driverError: { code: '40P01' } });
  }
}

describe('DBS-42 logger HTTP integration (no database)', () => {
  let app: NestExpressApplication;
  let output = '';
  const rows = () =>
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString();
        done();
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        CorrelationModule,
        LoggerModule.forRoot({
          forRoutes: [],
          pinoHttp: [createLoggingOptions({ role: 'both', logLevel: 'debug' }), stream],
        }),
      ],
      controllers: [LoggingProbeController],
      providers: [NestedTraceService],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    app.useLogger(app.get(PinoNestLogger));
    configureHttpApp(
      app,
      { trustProxyHops: 0, corsOrigins: [], isProduction: false },
      createHttpLogging(await app.resolve(PinoLogger), { role: 'both', logLevel: 'debug' }),
    );
    await app.init();
    app.flushLogs();
  });

  afterAll(async () => {
    await app?.close();
    Logger.overrideLogger(false);
  });
  beforeEach(() => {
    output = '';
  });

  it('TC-42-05 uses the response server id in both completion and Nest handler logs', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/logging-probe/ok')
      .set('X-Correlation-Id', '12ab5ea6-f71f-4034-844b-a3e752af4fbc')
      .expect(200);
    const id = res.headers['x-correlation-id'];
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(id).not.toBe('12ab5ea6-f71f-4034-844b-a3e752af4fbc');
    expect(rows().find(row => row.message === 'Handler completed')).toMatchObject({
      correlationId: id,
      role: 'api',
    });
    expect(rows().find(row => row.message === 'Request completed')).toMatchObject({
      correlationId: id,
      role: 'api',
      res: { statusCode: 200 },
    });
    for (const row of rows()) {
      expect(row).toEqual(
        expect.objectContaining({
          level: expect.any(Number),
          time: expect.any(String),
          message: expect.any(String),
          role: 'api',
          correlationId: id,
        }),
      );
    }
  });

  it('TC-43-04 isolates two overlapping HTTP requests through a nested service and logs both ids', async () => {
    const [first, second] = await Promise.all([
      request(app.getHttpServer()).get('/v1/logging-probe/nested/first').expect(200),
      request(app.getHttpServer()).get('/v1/logging-probe/nested/second').expect(200),
    ]);
    const firstId = first.headers['x-correlation-id'];
    const secondId = second.headers['x-correlation-id'];
    expect(firstId).not.toBe(secondId);
    expect(first.body.correlationId).toBe(firstId);
    expect(second.body.correlationId).toBe(secondId);
    expect(rows().filter(row => row.message === 'Nested service completed')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slot: 'first', observedId: firstId, correlationId: firstId }),
        expect.objectContaining({ slot: 'second', observedId: secondId, correlationId: secondId }),
      ]),
    );
  });

  it('TC-42-06 never logs URL/query, headers, bodies or client-controlled IDs', async () => {
    const first = await request(app.getHttpServer())
      .post('/v1/logging-probe/body?token=sensitive-query-fixture')
      .set('Authorization', 'Bearer sensitive-auth-fixture')
      .set('Cookie', 'session=sensitive-cookie-fixture')
      .send({ password: 'sensitive-body-fixture', accountNumber: '9876543210987654' })
      .expect(201);
    const second = await request(app.getHttpServer()).get('/v1/logging-probe/ok').expect(200);
    expect(first.headers['x-correlation-id']).not.toBe(second.headers['x-correlation-id']);
    for (const secret of ['sensitive-', '9876543210987654', '/logging-probe/', 'authorization'])
      expect(output).not.toContain(secret);
    expect(rows().find(row => row.message === 'Request completed')).toMatchObject({
      req: { method: 'POST' },
    });
  });

  it.each([
    ['boom', 500],
    ['transient', 503],
  ] as const)(
    'TC-42-07 preserves %s response while omitting sensitive error strings',
    async (path, status) => {
      const res = await request(app.getHttpServer())
        .get(`/v1/logging-probe/${path}?password=sensitive-url-fixture`)
        .expect(status);
      expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
      expect(output).not.toContain('sensitive-');
      expect(output).not.toContain('/logging-probe/');
      const failure = rows().find(
        row =>
          row.message === (status === 503 ? 'Transient database error' : 'Unhandled exception'),
      );
      expect(failure).toMatchObject({
        correlationId: res.body.correlationId,
        level: status === 503 ? 40 : 50,
      });
      if (status === 503) expect(res.headers['retry-after']).toBe('5');
    },
  );

  it('TC-42-10 logs a CORS preflight exactly once before module middleware', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/logging-probe/ok')
      .set('Origin', 'https://example.com')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    const completions = rows().filter(row => row.message === 'Request completed');
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      correlationId: res.headers['x-correlation-id'],
      res: { statusCode: 204 },
    });
  });

  it.each([
    ['malformed', '{"password":"sensitive-json-fixture"', 400],
    [
      'oversized',
      JSON.stringify({ password: 'sensitive-oversize-fixture', padding: 'x'.repeat(110_000) }),
      // Existing filter maps body-parser's PayloadTooLargeError to 500; DBS-42 preserves it.
      500,
    ],
  ])('TC-42-10 logs %s JSON rejection once without the body', async (_name, body, status) => {
    const res = await request(app.getHttpServer())
      .post('/v1/logging-probe/body')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(status);
    const completions = rows().filter(
      row => row.message === 'Request completed' || row.message === 'Request failed',
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      correlationId: res.headers['x-correlation-id'],
      res: { statusCode: status },
    });
    expect(output).not.toContain('sensitive-');
  });
});
