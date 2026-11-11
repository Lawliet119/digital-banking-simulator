/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- free-form OpenAPI JSON: its shape is checked by the tests, not by types */
import type { OpenAPIObject } from '@nestjs/swagger';
import { ErrorCode } from '@common/errors/error-code.enum';
import { ERROR_CODES_EXTENSION } from './api-error-codes.decorator';

/**
 * Completes the OpenAPI document with what is true of every route and easy to forget (DBS-137):
 *
 * - the shared error responses: a signed-in route can answer 401 (`JwtAuthGuard`: UNAUTHENTICATED,
 *   TOKEN_EXPIRED, SESSION_REVOKED) and 503 (its user lookup), a route with roles can answer 403,
 *   and every route but health can answer 429 (the per-IP limiter);
 * - `x-error-codes`: per status, every code the operation can return (the route-specific ones come
 *   from `@ApiErrorCodes`);
 * - a problem+json body and an example per code for a response that has none, and `Retry-After` on
 *   429 and 503;
 * - one line in `description` with the role and the codes, because Swagger UI shows the
 *   description to everybody.
 *
 * Pure: returns a new document and never overwrites a response, a `content` or a status text the
 * controllers already declared. Calling it twice gives the same result.
 */

type Json = Record<string, any>;

const SIGNED_IN_401 = [
  ErrorCode.UNAUTHENTICATED,
  ErrorCode.TOKEN_EXPIRED,
  ErrorCode.SESSION_REVOKED,
];
const KNOWN_CODES = new Set<string>(Object.values(ErrorCode));
const DESCRIPTION_MARK = '\n\nVai trò: ';
const PROBLEM = 'application/problem+json';
const SCHEMA_REF = '#/components/schemas/ProblemDetailsDto';
const EXAMPLE_CORRELATION_ID = '4f1c2a9e-7b3d-4e58-9a61-2c0d5e8b7a13';

const TITLES: Record<string, string> = {
  '400': 'Bad Request',
  '401': 'Unauthorized',
  '403': 'Forbidden',
  '404': 'Not Found',
  '409': 'Conflict',
  '422': 'Unprocessable Entity',
  '429': 'Too Many Requests',
  '500': 'Internal Server Error',
  '503': 'Service Unavailable',
};
const DETAILS: Record<string, string> = {
  '400': 'The request is invalid',
  '401': 'The access token is missing, invalid, expired or revoked',
  '403': "The caller's role is not allowed to use this endpoint",
  '404': 'The resource was not found',
  '409': 'The request conflicts with the current state',
  '422': 'The request was understood but refused',
  '429': 'Too many requests, retry later',
  '500': 'Unexpected error',
  '503': 'Temporarily unavailable, retry with the same Idempotency-Key where one applies',
};

/** The shared problem+json schema: no per-property example, the examples sit on each response. */
const PROBLEM_SCHEMA: Json = {
  type: 'object',
  required: ['type', 'title', 'status', 'detail', 'correlationId'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    errorCode: { type: 'string', enum: Object.values(ErrorCode) },
    correlationId: { type: 'string', format: 'uuid' },
    errors: { type: 'array', items: { type: 'object' } },
  },
};

function union(...lists: (readonly string[] | undefined)[]): string[] {
  return [...new Set(lists.flatMap(list => list ?? []))];
}

function problemExample(status: string, code?: string): Json {
  return {
    value: {
      type: 'about:blank',
      title: TITLES[status] ?? 'Error',
      status: Number(status),
      detail: DETAILS[status] ?? 'Error',
      ...(code === undefined ? {} : { errorCode: code }),
      correlationId: EXAMPLE_CORRELATION_ID,
    },
  };
}

function rolesText(operation: Json): string {
  const hasSecurity = Array.isArray(operation.security) && operation.security.length > 0;
  const roles = operation['x-roles'] as string[] | undefined;
  if (roles !== undefined && roles.length > 0) return roles.join(', ');
  return hasSecurity ? 'mọi vai trò đã đăng nhập' : 'công khai';
}

function enrichOperation(path: string, operation: Json): void {
  const hasSecurity = Array.isArray(operation.security) && operation.security.length > 0;
  const roles = operation['x-roles'] as string[] | undefined;
  const declared = (operation[ERROR_CODES_EXTENSION] ?? {}) as Record<string, string[]>;
  for (const [status, codes] of Object.entries(declared)) {
    for (const code of codes) {
      if (!KNOWN_CODES.has(code)) {
        throw new Error(
          `${path}: x-error-codes ${status} names ${code}, which is not an ErrorCode`,
        );
      }
    }
  }
  const structural: Record<string, string[]> = {};
  if (hasSecurity) {
    structural['401'] = SIGNED_IN_401;
    structural['503'] = [ErrorCode.SERVICE_TEMPORARILY_UNAVAILABLE];
  }
  if (roles !== undefined && roles.length > 0) structural['403'] = [ErrorCode.FORBIDDEN];
  if (!path.startsWith('/health')) structural['429'] = [ErrorCode.RATE_LIMITED];

  const statuses = union(Object.keys(declared), Object.keys(structural)).sort(
    (a, b) => Number(a) - Number(b),
  );
  const merged: Record<string, string[]> = {};
  for (const status of statuses) merged[status] = union(declared[status], structural[status]);
  if (statuses.length > 0) operation[ERROR_CODES_EXTENSION] = merged;

  const responses = (operation.responses ??= {}) as Json;
  // Every declared non-2xx response without a body gets the shared problem schema; a status that
  // carries codes also gets the response itself when the controller never declared it.
  for (const status of statuses) {
    responses[status] ??= {
      description: `${TITLES[status] ?? 'Error'} (errorCode ${merged[status].join(' / ')})`,
    };
  }
  for (const [status, response] of Object.entries(responses) as [string, Json][]) {
    if (status.startsWith('2') || response.$ref !== undefined) continue;
    const codes = merged[status] ?? [];
    if (response.content === undefined) {
      response.content = {
        [PROBLEM]: {
          schema: { $ref: SCHEMA_REF },
          examples:
            codes.length === 0
              ? { default: problemExample(status) }
              : Object.fromEntries(codes.map(code => [code, problemExample(status, code)])),
        },
      };
    }
    if ((status === '429' || status === '503') && response.headers?.['Retry-After'] === undefined) {
      response.headers = {
        ...(response.headers ?? {}),
        'Retry-After': {
          description: 'Seconds to wait before retrying',
          schema: { type: 'integer', example: 5 },
        },
      };
    }
  }

  const codesLine = statuses.map(status => `${status} ${merged[status].join(' | ')}`).join('; ');
  const base = String(operation.description ?? '').split(DESCRIPTION_MARK)[0];
  operation.description = `${base}${DESCRIPTION_MARK}${rolesText(operation)}.${codesLine === '' ? '' : ` errorCode: ${codesLine}.`}`;
}

export function enrichOpenApi(document: OpenAPIObject): OpenAPIObject {
  const result = structuredClone(document) as OpenAPIObject & Json;
  for (const [path, item] of Object.entries(result.paths) as [string, Json][]) {
    for (const [method, operation] of Object.entries(item) as [string, Json][]) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      enrichOperation(path, operation);
    }
  }
  result.components ??= {};
  result.components.schemas ??= {};
  (result.components.schemas as Json).ProblemDetailsDto = PROBLEM_SCHEMA;
  return result;
}
