import { Controller, Get, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Agent, request as httpRequest } from 'http';
import type { AddressInfo } from 'net';
import {
  ALB_IDLE_TIMEOUT_MS,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  configureHttpApp,
} from '../src/app.setup';

@Controller('probe')
class ProbeController {
  @Get()
  ok(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

/**
 * BL-414 (DBS-173): the ALB keeps an idle connection open for 60 s (the default; nothing in
 * Terraform changes it). Node closes an idle keep-alive connection after 5 s by default, so the ALB
 * now and then reuses a connection Node has just closed and answers 502 itself: 1 in 172,805
 * requests of the DBS-166 `baseline`, none counted as a 5xx by the application. The server must
 * keep an idle connection longer than the ALB does, and `headersTimeout` must stay above
 * `keepAliveTimeout` (Node's own rule, otherwise the header timer closes the connection first).
 * The app is built with `configureHttpApp`, the one function `main.ts` and every e2e test share.
 */
describe('HTTP server timeouts behind the ALB (BL-414)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(app, { trustProxyHops: 1, corsOrigins: [], isProduction: false });
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
  });

  it('TC-173-06 the constants keep the keep-alive above the 60 s ALB idle timeout and the header timeout above it', () => {
    expect(ALB_IDLE_TIMEOUT_MS).toBe(60_000);
    expect(HTTP_KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(ALB_IDLE_TIMEOUT_MS);
    expect(HTTP_HEADERS_TIMEOUT_MS).toBeGreaterThan(HTTP_KEEP_ALIVE_TIMEOUT_MS);
  });

  it('TC-173-06 configureHttpApp sets both timeouts on the server that listens', () => {
    const server = app.getHttpServer();
    expect(server.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HTTP_HEADERS_TIMEOUT_MS);
  });

  it('TC-173-06 a keep-alive socket idle for 6 s (past the old 5 s default) is still open and reused', async () => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const get = (): Promise<{ status: number; localPort: number }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/v1/probe', agent }, res => {
          res.resume();
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, localPort: req.socket?.localPort ?? 0 }),
          );
        });
        req.on('error', reject);
        req.end();
      });
    try {
      const first = await get();
      await new Promise(resolve => setTimeout(resolve, 6_000));
      const second = await get();
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.localPort).toBe(first.localPort); // the same TCP connection, not a new one
    } finally {
      agent.destroy();
    }
  }, 20_000);

  it('TC-173-06 shutting down with an idle keep-alive socket open returns well within the 30 s ECS stopTimeout', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    const other = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(other, { trustProxyHops: 1, corsOrigins: [], isProduction: false });
    await other.listen(0, '127.0.0.1');
    const port = (other.getHttpServer().address() as AddressInfo).port;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/v1/probe', agent }, res => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.end();
    });
    const started = Date.now();
    await other.close();
    agent.destroy();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
