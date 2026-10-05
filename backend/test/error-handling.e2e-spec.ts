import {
  Body,
  Controller,
  Get,
  type INestApplication,
  Logger,
  NotFoundException,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, Min } from 'class-validator';
import request from 'supertest';
import { configureHttpApp } from '../src/app.setup';
import { ErrorCode } from '../src/common/errors/error-code.enum';

class CreateThingDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(1)
  amount!: number;
}

/** Throws every kind of error the filter has to translate. */
@Controller('probe')
class ProbeController {
  @Get('rejected')
  rejected(): never {
    // What the ledger will throw for a REJECTED transfer.
    throw new UnprocessableEntityException({
      errorCode: ErrorCode.INSUFFICIENT_FUNDS,
      transferId: '8f3c0a52-0000-4000-8000-000000000001',
      status: 'REJECTED', // a domain value that must NOT replace the HTTP status
    });
  }

  @Get('not-found')
  notFound(): never {
    throw new NotFoundException('Account not found');
  }

  @Get('boom')
  boom(): never {
    throw new Error('connection string postgres://admin:hunter2@db.internal leaked');
  }

  @Get('deadlock')
  deadlock(): never {
    throw Object.assign(new Error('deadlock detected'), { driverError: { code: '40P01' } });
  }

  @Get('lost-connection')
  lostConnection(): never {
    throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  }

  @Get('ok')
  ok(): { fine: boolean } {
    return { fine: true };
  }

  @Post('things')
  create(@Body() dto: CreateThingDto): CreateThingDto {
    return dto;
  }
}

describe('HTTP error handling (e2e, no database)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let logError: jest.SpyInstance;
  let logWarn: jest.SpyInstance;

  beforeAll(async () => {
    // The filter logs unexpected errors on purpose; keep the test output readable and assert on it.
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(nest, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
    await nest.init();
    app = nest;
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    logError.mockClear();
    logWarn.mockClear();
  });

  describe('RFC 7807 problem+json', () => {
    it('answers every error as application/problem+json with the mandatory members', async () => {
      const res = await request(server).get('/v1/probe/not-found').expect(404);

      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Account not found',
      });
    });

    it('forwards the errorCode and other keys a service attached (a REJECTED transfer)', async () => {
      const res = await request(server).get('/v1/probe/rejected').expect(422);

      expect(res.body.errorCode).toBe(ErrorCode.INSUFFICIENT_FUNDS);
      expect(res.body.transferId).toBe('8f3c0a52-0000-4000-8000-000000000001');
    });

    it('keeps `status` as the HTTP status number even if the thrower sent a domain status', async () => {
      const res = await request(server).get('/v1/probe/rejected').expect(422);

      expect(res.body.status).toBe(422);
    });

    it('reports ValidationPipe failures as a list of messages, and rejects unknown fields', async () => {
      const res = await request(server)
        .post('/v1/probe/things')
        .send({ name: 42, amount: 0, extra: 'not allowed' })
        .expect(400);

      expect(res.body.detail).toBe('Request validation failed');
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('name must be a string'),
          expect.stringContaining('amount must not be less than 1'),
          expect.stringContaining('property extra should not exist'),
        ]),
      );
    });

    it('lets a valid request through', async () => {
      const res = await request(server)
        .post('/v1/probe/things')
        .send({ name: 'rent', amount: 5 })
        .expect(201);

      expect(res.body).toEqual({ name: 'rent', amount: 5 });
    });
  });

  describe('unexpected errors', () => {
    it('answers 500 with a generic detail and never leaks the real error', async () => {
      const res = await request(server).get('/v1/probe/boom').expect(500);

      expect(res.body.detail).toBe('Internal server error');
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
      expect(res.body.errorCode).toBeUndefined();
    });

    it('logs the real error server-side with the correlation id, so it can still be diagnosed', async () => {
      const res = await request(server).get('/v1/probe/boom').expect(500);

      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining(`[${res.body.correlationId as string}]`),
        expect.stringContaining('hunter2'),
      );
    });
  });

  describe('transient database failures → 503 + Retry-After', () => {
    it.each([
      ['a deadlock that survived the retries', '/v1/probe/deadlock'],
      ['a lost connection', '/v1/probe/lost-connection'],
    ])('maps %s so the client retries with the same Idempotency-Key', async (_name, path) => {
      const res = await request(server).get(path).expect(503);

      expect(res.headers['retry-after']).toBe('5');
      expect(res.body.errorCode).toBe(ErrorCode.SERVICE_TEMPORARILY_UNAVAILABLE);
      expect(res.body.status).toBe(503);
      expect(logWarn).toHaveBeenCalled(); // a warning, not an error: it is expected and recoverable
      expect(logError).not.toHaveBeenCalled();
    });
  });

  describe('correlation id', () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    it('is generated, returned in the header, and repeated in an error body', async () => {
      const res = await request(server).get('/v1/probe/not-found').expect(404);

      expect(res.headers['x-correlation-id']).toMatch(UUID);
      expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
    });

    it('is always chosen by the server, never by the caller', async () => {
      const chosen = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
      const res = await request(server)
        .get('/v1/probe/ok')
        .set('X-Correlation-Id', chosen)
        .expect(200);

      expect(res.headers['x-correlation-id']).toMatch(UUID);
      expect(res.headers['x-correlation-id']).not.toBe(chosen);
    });

    it('echoes a well-formed caller X-Request-Id separately, so the client can match its request', async () => {
      const mine = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
      const res = await request(server).get('/v1/probe/ok').set('X-Request-Id', mine).expect(200);

      expect(res.headers['x-request-id']).toBe(mine);
      expect(res.headers['x-correlation-id']).not.toBe(mine);
    });

    it('does not echo a malformed X-Request-Id', async () => {
      const res = await request(server)
        .get('/v1/probe/ok')
        .set('X-Request-Id', 'forged-by-client')
        .expect(200);

      expect(res.headers['x-request-id']).toBeUndefined();
    });

    it('is present even on a 404 for a route that does not exist', async () => {
      const res = await request(server).get('/v1/nope').expect(404);

      expect(res.headers['x-correlation-id']).toMatch(UUID);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    });
  });

  describe('security headers', () => {
    it('sets helmet defaults and does not advertise the framework', async () => {
      const res = await request(server).get('/v1/probe/ok').expect(200);

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });
});
