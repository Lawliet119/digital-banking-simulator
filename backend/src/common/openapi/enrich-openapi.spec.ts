/* eslint-disable @typescript-eslint/no-explicit-any -- free-form OpenAPI JSON: its shape is checked by the tests, not by types */
import { Controller, Get, Post } from '@nestjs/common';
import { DECORATORS } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ErrorCode } from '@common/errors/error-code.enum';
import { ApiErrorCodes } from './api-error-codes.decorator';
import { enrichOpenApi } from './enrich-openapi';

type Doc = { paths: Record<string, Record<string, any>>; components?: any } & Record<string, any>;
const enrich = (doc: Doc): Doc => enrichOpenApi(doc as unknown as OpenAPIObject);

const baseDoc = (): Doc => ({
  openapi: '3.0.0',
  info: { title: 't', version: '1' },
  paths: {
    '/v1/transfers': {
      post: {
        summary: 'Customer: transfer',
        description: 'Moves money.',
        security: [{ 'access-token': [] }],
        'x-roles': ['customer'],
        'x-error-codes': {
          400: [ErrorCode.IDEMPOTENCY_KEY_REQUIRED],
          422: [ErrorCode.INSUFFICIENT_FUNDS, ErrorCode.IDEMPOTENCY_KEY_REUSED],
        },
        responses: {
          201: {
            description: 'created',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          400: { description: 'Missing key (errorCode IDEMPOTENCY_KEY_REQUIRED)' },
          401: { description: 'UNAUTHENTICATED or TOKEN_EXPIRED' },
          422: { description: 'Rejected' },
          429: { description: 'Too many transfers' },
        },
      },
    },
    '/v1/identity/me': {
      get: {
        summary: 'Caller claims',
        security: [{ 'access-token': [] }],
        responses: { 200: { description: 'ok' }, 401: { description: 'no token' } },
      },
    },
    '/health/live': {
      get: { summary: 'Liveness', responses: { 200: { description: 'ok' } } },
    },
  },
  components: { schemas: {} },
});

describe('enrichOpenApi (DBS-137)', () => {
  it('TC-137-09 adds the shared 401, 403, 429 and 503 codes to a protected role route', () => {
    const op = enrich(baseDoc()).paths['/v1/transfers'].post;
    expect(op['x-error-codes']).toEqual({
      400: ['IDEMPOTENCY_KEY_REQUIRED'],
      401: ['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'SESSION_REVOKED'],
      403: ['FORBIDDEN'],
      422: ['INSUFFICIENT_FUNDS', 'IDEMPOTENCY_KEY_REUSED'],
      429: ['RATE_LIMITED'],
      503: ['SERVICE_TEMPORARILY_UNAVAILABLE'],
    });
    for (const status of ['400', '401', '403', '422', '429', '503'])
      expect(op.responses[status]).toBeDefined();
  });

  it('TC-137-09 a signed-in route without x-roles gets no 403 and reads "mọi vai trò đã đăng nhập"', () => {
    const op = enrich(baseDoc()).paths['/v1/identity/me'].get;
    expect(Object.keys(op['x-error-codes'])).toEqual(['401', '429', '503']);
    expect(op.description).toContain('Vai trò: mọi vai trò đã đăng nhập');
  });

  it('TC-137-09 a public route (no security) gets no error codes and reads "công khai"', () => {
    const op = enrich(baseDoc()).paths['/health/live'].get;
    expect(op['x-error-codes']).toBeUndefined();
    expect(op.responses['429']).toBeUndefined();
    expect(op.description).toContain('Vai trò: công khai');
  });

  it('TC-137-09 never overwrites an existing response, and fills only what it lacks', () => {
    const doc = baseDoc();
    doc.paths['/v1/transfers'].post.responses['403'] = {
      description: 'own',
      content: {
        'application/problem+json': { schema: { $ref: '#/components/schemas/FraudProblemDto' } },
      },
    };
    const op = enrich(doc).paths['/v1/transfers'].post;
    expect(op.responses['403'].description).toBe('own');
    expect(op.responses['403'].content['application/problem+json'].schema.$ref).toBe(
      '#/components/schemas/FraudProblemDto',
    );
    expect(op.responses['201'].description).toBe('created');
    // An existing response with no content gets the shared problem schema and one example per code.
    expect(op.responses['401'].description).toBe('UNAUTHENTICATED or TOKEN_EXPIRED');
    const media = op.responses['401'].content['application/problem+json'];
    expect(media.schema.$ref).toBe('#/components/schemas/ProblemDetailsDto');
    expect(Object.keys(media.examples)).toEqual([
      'UNAUTHENTICATED',
      'TOKEN_EXPIRED',
      'SESSION_REVOKED',
    ]);
    expect(media.examples.SESSION_REVOKED.value).toMatchObject({
      status: 401,
      errorCode: 'SESSION_REVOKED',
    });
  });

  it('TC-137-09 adds Retry-After to 429 and 503 and registers ProblemDetailsDto without property examples', () => {
    const doc = enrich(baseDoc());
    const op = doc.paths['/v1/transfers'].post;
    expect(op.responses['429'].headers['Retry-After']).toBeDefined();
    expect(op.responses['503'].headers['Retry-After']).toBeDefined();
    const schema = (doc.components!.schemas as Record<string, any>).ProblemDetailsDto;
    expect(schema.properties.errorCode.enum).toContain('FLAG_ALREADY_REVIEWED');
    expect(JSON.stringify(schema.properties)).not.toContain('"example"');
  });

  it('TC-137-09 appends one line naming the role and every code, and calling twice changes nothing', () => {
    const once = enrich(baseDoc());
    const op = once.paths['/v1/transfers'].post;
    expect(op.description).toContain('Moves money.');
    expect(op.description).toMatch(
      /Vai trò: customer\. errorCode: 400 IDEMPOTENCY_KEY_REQUIRED; 401 UNAUTHENTICATED \| TOKEN_EXPIRED \| SESSION_REVOKED; 403 FORBIDDEN; 422 INSUFFICIENT_FUNDS \| IDEMPOTENCY_KEY_REUSED; 429 RATE_LIMITED; 503 SERVICE_TEMPORARILY_UNAVAILABLE\./,
    );
    expect(enrich(once)).toEqual(once);
  });

  it('TC-137-09 does not mutate its input', () => {
    const doc = baseDoc();
    const before = JSON.stringify(doc);
    enrich(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('TC-137-09 refuses an error code that is not an ErrorCode member', () => {
    const doc = baseDoc();
    doc.paths['/v1/transfers'].post['x-error-codes'][422].push('MADE_UP_CODE');
    expect(() => enrich(doc)).toThrow(/MADE_UP_CODE/);
  });
});

describe('@ApiErrorCodes (DBS-137)', () => {
  @Controller('sample')
  class Sample {
    @Post()
    @ApiErrorCodes({
      422: [ErrorCode.INSUFFICIENT_FUNDS],
      400: [ErrorCode.IDEMPOTENCY_KEY_REQUIRED],
    })
    create(): void {}
    @Get()
    plain(): void {}
  }

  it('TC-137-09 writes the route-specific codes as x-error-codes', () => {
    const ext = Reflect.getMetadata(DECORATORS.API_EXTENSION, Sample.prototype.create) as Record<
      string,
      unknown
    >;
    expect(ext['x-error-codes']).toEqual({
      422: ['INSUFFICIENT_FUNDS'],
      400: ['IDEMPOTENCY_KEY_REQUIRED'],
    });
    expect(Reflect.getMetadata(DECORATORS.API_EXTENSION, Sample.prototype.plain)).toBeUndefined();
  });

  it('TC-137-09 rejects a status that is not a 4xx or 5xx at declaration time', () => {
    expect(() => ApiErrorCodes({ 200: [ErrorCode.FORBIDDEN] })).toThrow(/200/);
  });
});
