import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { createHttpMetricsMiddleware } from './http-metrics.middleware';
import { HttpStats } from './http-stats';

class FakeResponse extends EventEmitter {
  statusCode = 200;
  writableFinished = false;
}

function run(
  stats: HttpStats,
  req: Partial<Request>,
  steps: (res: FakeResponse) => void,
): FakeResponse {
  const res = new FakeResponse();
  const next = jest.fn() as unknown as NextFunction;
  createHttpMetricsMiddleware(stats)(req as Request, res as unknown as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  steps(res);
  return res;
}

describe('createHttpMetricsMiddleware', () => {
  it('TC-144-05b finish then close counts the request once', () => {
    const stats = new HttpStats();
    run(stats, { method: 'GET', route: { path: '/v1/accounts/:id' }, baseUrl: '' }, res => {
      res.statusCode = 200;
      res.writableFinished = true;
      res.emit('finish');
      res.emit('close');
    });
    const [group] = stats.drain();
    expect(group).toMatchObject({
      route: '/v1/accounts/:id',
      method: 'GET',
      requests: 1,
      aborted: 0,
      errors5xx: 0,
    });
  });

  it('TC-144-05b close before the answer is finished counts as aborted, not as a 5xx', () => {
    const stats = new HttpStats();
    run(stats, { method: 'POST', route: { path: '/v1/transfers' }, baseUrl: '' }, res => {
      res.statusCode = 200;
      res.writableFinished = false;
      res.emit('close');
    });
    const [group] = stats.drain();
    expect(group).toMatchObject({ requests: 1, aborted: 1, errors5xx: 0 });
    expect(group.latency.samples).toHaveLength(1);
  });

  it('TC-144-05b a close with no finish after an answer was written is counted once, as served', () => {
    const stats = new HttpStats();
    run(stats, { method: 'GET', route: { path: '/v1/accounts' }, baseUrl: '' }, res => {
      res.statusCode = 503;
      res.writableFinished = true;
      res.emit('close');
    });
    const [group] = stats.drain();
    expect(group).toMatchObject({ requests: 1, aborted: 0, errors5xx: 1 });
  });

  it('TC-144-05b labels a request that matched no route as unmatched and reads the route at the end', () => {
    const stats = new HttpStats();
    const req: Partial<Request> = { method: 'GET', baseUrl: '' };
    run(stats, req, res => {
      res.writableFinished = true;
      res.statusCode = 404;
      res.emit('finish');
    });
    expect(stats.drain()[0]).toMatchObject({ route: 'unmatched', method: 'GET' });

    const late: Partial<Request> = { method: 'GET', baseUrl: '' };
    run(stats, late, res => {
      // The route is set while the request is handled, after the middleware ran.
      (late as { route?: unknown }).route = { path: '/v1/transfers' };
      res.writableFinished = true;
      res.emit('finish');
    });
    expect(stats.drain()[0]).toMatchObject({ route: '/v1/transfers' });
  });

  it('TC-144-05b prefixes the base URL of a mounted router, and never the real URL', () => {
    const stats = new HttpStats();
    run(
      stats,
      {
        method: 'GET',
        baseUrl: '/v1',
        route: { path: '/accounts/:id' },
        originalUrl: '/v1/accounts/3f2b8c1e-9a4d-4e21-8c7a-1b2c3d4e5f60',
      },
      res => {
        res.writableFinished = true;
        res.emit('finish');
      },
    );
    const [group] = stats.drain();
    expect(group.route).toBe('/v1/accounts/:id');
    expect(JSON.stringify(group)).not.toContain('3f2b8c1e');
  });

  it('TC-144-05b a failing stats never reaches the request', () => {
    const stats = new HttpStats();
    jest.spyOn(stats, 'record').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() =>
      run(stats, { method: 'GET', baseUrl: '' }, res => {
        res.writableFinished = true;
        res.emit('finish');
      }),
    ).not.toThrow();
  });
});
