import { type INestApplication, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureHttpApp } from '../src/app.setup';
import { MoneyProbeController } from './support/money-probe';

const AMOUNT_URL = '/v1/probe/money';

describe('@common/money over HTTP (e2e, no database)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let probe: MoneyProbeController;
  let logError: jest.SpyInstance;

  beforeAll(async () => {
    // The filter logs an unexpected error on purpose; keep the output readable and assert on it.
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // Start from a process that has NOT had the bigint bootstrap (only main.ts imports it), so
    // that TC-22-29 proves configureHttpApp installs it by itself.
    delete BigInt.prototype.toJSON;

    const moduleRef = await Test.createTestingModule({
      controllers: [MoneyProbeController],
    }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(nest, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
    await nest.init();
    app = nest;
    server = app.getHttpServer() as Parameters<typeof request>[0];
    probe = moduleRef.get(MoneyProbeController);
  });

  afterAll(async () => {
    await app.close();
    logError.mockRestore();
  });

  beforeEach(() => {
    probe.calls = 0;
    logError.mockClear();
  });

  it('TC-22-26 a 2^53 + 1 amount goes body -> DTO -> domain -> response without losing a digit', async () => {
    const res = await request(server).post(AMOUNT_URL).send({ amount: '9007199254740993' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      received: '9007199254740993',
      plusOne: '9007199254740994',
      fundingAfter: '-9007199254740993',
    });
    // In the raw JSON text, not just after parsing: strings, so no client can round them.
    expect(res.text).toContain('"plusOne":"9007199254740994"');
    expect(res.text).toContain('"fundingAfter":"-9007199254740993"');
  });

  it('TC-22-27 refuses 0, -1, 1.5, 1e3, 01 and " 1" with a 400 before any handler runs', async () => {
    for (const amount of ['0', '-1', '1.5', '1e3', '01', ' 1']) {
      const res = await request(server).post(AMOUNT_URL).send({ amount });

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.errors).toHaveLength(1); // the one constraint on `amount`
      expect(res.body.errorCode).toBeUndefined(); // no ErrorCode for a malformed amount (G1 Q2)
      expect(probe.calls).toBe(0);
    }
    // Control: the same endpoint with a good amount works, so the 400s above came from the amount.
    await request(server).post(AMOUNT_URL).send({ amount: '1' }).expect(201);
    expect(probe.calls).toBe(1);
  });

  it('TC-22-28 refuses a JSON number (even exact), null and a missing amount', async () => {
    const rawBodies = [
      '{"amount":9007199254740993}', // JSON.parse has already made it ...992 when we see it
      '{"amount":1000}', // exact, still refused: money is a string, one rule
      '{"amount":null}',
      '{}',
    ];
    for (const body of rawBodies) {
      const res = await request(server)
        .post(AMOUNT_URL)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.errors).toHaveLength(1);
      expect(probe.calls).toBe(0);
    }
    // Control. Also pins that the global pipe does not convert types by itself
    // (`enableImplicitConversion` would turn the number 1000 into the string "1000").
    await request(server).post(AMOUNT_URL).send({ amount: '1000' }).expect(201);
    expect(probe.calls).toBe(1);
  });

  it('TC-22-29 configureHttpApp makes a forgotten-format bigint a string, not a 500', async () => {
    const res = await request(server).get('/v1/probe/raw-bigint');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      a: '9007199254740993',
      list: ['1'],
      nested: { max: '9223372036854775807' },
    });
  });

  it('TC-22-30 an arithmetic overflow is a generic 500 that leaks nothing', async () => {
    const res = await request(server).post('/v1/probe/overflow');

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe('Internal server error');
    expect(res.body.errorCode).toBeUndefined();
    expect(res.text).not.toContain('9223372036854775807');
    expect(res.text).not.toContain('MoneyError');
    expect(logError).toHaveBeenCalledTimes(1); // the real error went to the log, not the client
  });
});
