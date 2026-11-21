/**
 * DBS-173 manual test M-173-02 (BL-414): does a keep-alive connection that stays idle longer than
 * Node's 5 s default survive? An ALB keeps an idle connection for 60 s, so the server must too.
 *
 *   npx ts-node -r tsconfig-paths/register test/manual/dbs-173-keepalive.manual.ts [idleMs]
 *
 * `idleMs` defaults to 70,000 (past the ALB's 60 s). The server is built with `configureHttpApp`,
 * the function `main.ts` uses, so running it with the `app.setup.ts` of commit d6bf542d shows the
 * behaviour before the change and running it on the branch shows the behaviour after.
 */
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Agent, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { configureHttpApp } from '../../src/app.setup';

@Controller('probe')
class ProbeController {
  @Get()
  ok(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

async function main(): Promise<void> {
  const idleMs = Number(process.argv[2] ?? 70_000);
  const app = await NestFactory.create<NestExpressApplication>(ProbeModule, { logger: false });
  configureHttpApp(app, { trustProxyHops: 1, corsOrigins: [], isProduction: false });
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer();
  const port = (server.address() as AddressInfo).port;
  console.log(
    `server keepAliveTimeout=${server.keepAliveTimeout} ms, headersTimeout=${server.headersTimeout} ms`,
  );

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

  const first = await get();
  console.log(`request 1: status ${first.status} on local port ${first.localPort}`);
  console.log(`idle for ${idleMs} ms ...`);
  await new Promise(resolve => setTimeout(resolve, idleMs));
  let reused = false;
  try {
    const second = await get();
    reused = second.localPort === first.localPort;
    console.log(
      `request 2: status ${second.status} on local port ${second.localPort}: ${
        reused ? 'the SAME connection was reused' : 'a NEW connection (the old one was closed)'
      }`,
    );
  } catch (error) {
    console.log(`request 2 failed: ${(error as Error).message}`);
  }
  agent.destroy();
  await app.close();
  process.exit(reused ? 0 : 1);
}

void main();
