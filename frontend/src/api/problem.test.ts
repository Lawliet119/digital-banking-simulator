import { describe, expect, it } from 'vitest';
import { ApiProblem, describeError, describeProblem, toProblem } from './problem';

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('toProblem', () => {
  it('reads errorCode, detail, correlationId and Retry-After', () => {
    const problem = toProblem(response(429, { 'Retry-After': '17' }), {
      status: 429,
      errorCode: 'RATE_LIMITED',
      detail: 'Too many requests',
      correlationId: 'c-1',
    });
    expect(problem).toMatchObject({
      status: 429,
      errorCode: 'RATE_LIMITED',
      detail: 'Too many requests',
      correlationId: 'c-1',
      retryAfterSeconds: 17,
    });
  });

  it('falls back to the X-Correlation-Id header and survives a body that is not JSON', () => {
    const problem = toProblem(response(502, { 'X-Correlation-Id': 'c-2' }), undefined);
    expect(problem).toMatchObject({ status: 502, errorCode: undefined, correlationId: 'c-2' });
  });

  it('keeps the per-field messages of a 400', () => {
    const problem = toProblem(response(400), { errors: ['limit must be 1..50', 3] });
    expect(problem.errors).toEqual(['limit must be 1..50']);
  });
});

describe('describeProblem', () => {
  it('gives the Vietnamese sentence of a known code', () => {
    expect(describeProblem(new ApiProblem(422, 'INSUFFICIENT_FUNDS', 'x', 'c'))).toBe(
      'Số dư không đủ.',
    );
    expect(describeProblem(new ApiProblem(409, 'FLAG_ALREADY_REVIEWED', 'x', 'c'))).toBe(
      'Cờ này đã được review.',
    );
  });

  it('adds the wait of a 429', () => {
    expect(describeProblem(new ApiProblem(429, 'RATE_LIMITED', 'x', 'c', 30))).toContain('30 giây');
  });

  it('gives a generic sentence with the trace id for an unknown code', () => {
    const text = describeProblem(new ApiProblem(500, 'SOMETHING_NEW', 'boom', 'trace-9'));
    expect(text).toContain('HTTP 500');
    expect(text).toContain('trace-9');
    expect(text).not.toContain('boom');
  });

  it('says "not found" for a 404 without a code', () => {
    expect(describeProblem(new ApiProblem(404, undefined, undefined, undefined))).toBe(
      'Không tìm thấy.',
    );
  });

  it('describes a network failure', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toContain('Không kết nối');
  });
});
