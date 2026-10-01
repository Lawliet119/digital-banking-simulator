import type { Response } from 'express';
import {
  CORRELATION_ID_HEADER,
  correlationIdMiddleware,
  type RequestWithCorrelationId,
} from './correlation-id.middleware';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function run(incoming?: string) {
  const req = {
    header: jest.fn().mockReturnValue(incoming),
  } as unknown as RequestWithCorrelationId;
  const res = { setHeader: jest.fn() } as unknown as Response;
  const next = jest.fn();
  correlationIdMiddleware(req, res, next);
  return { req, res, next };
}

describe('correlationIdMiddleware', () => {
  it('generates a UUID when the caller sends none', () => {
    const { req, res, next } = run(undefined);
    expect(req.correlationId).toMatch(UUID);
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, req.correlationId);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('reuses a well-formed UUID from the caller (lower-cased)', () => {
    const id = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
    const { req } = run(id);
    expect(req.correlationId).toBe(id.toLowerCase());
  });

  it.each(['not-a-uuid', 'x'.repeat(500), '3f2504e0-4f89-41d3-9a0c-0305e82c3301\nforged: line'])(
    'replaces a malformed id so it cannot forge log lines: %j',
    bad => {
      const { req } = run(bad);
      expect(req.correlationId).toMatch(UUID);
      expect(req.correlationId).not.toBe(bad);
    },
  );
});
