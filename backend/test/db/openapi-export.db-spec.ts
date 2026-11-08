import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parse } from 'dotenv';
import request from 'supertest';
import { configureHttpApp, setupSwagger } from '../../src/app.setup';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { createDevTokenIssuer } from '../support/dev-tokens';

const run = promisify(execFile);
describe('DBS-72 OpenAPI artifact from the real AppModule', () => {
  const original = { ...process.env };
  let db: TempDatabase, app: NestExpressApplication, dir: string, url: string;
  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    dir = await fs.mkdtemp(join(tmpdir(), 'dbs72-api-'));
    const issuer = await createDevTokenIssuer();
    const jwks = join(dir, 'jwks.json');
    await fs.writeFile(jwks, JSON.stringify(issuer.jwks));
    Object.assign(process.env, parse(await fs.readFile('env/.env.example', 'utf8')), {
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      DATABASE_URL: db.url,
      DATABASE_SSL: 'false',
      AUTH_MODE: 'local',
      AUTH_LOCAL_JWKS_PATH: jwks,
      LOG_LEVEL: 'fatal',
    });
    const { AppModule } = await import('../../src/app.module');
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: false,
      abortOnError: false,
    });
    configureHttpApp(app, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
    setupSwagger(app);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = original;
      await db?.drop();
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it('TC-72-03 CLI exports exact Swagger routes, roles, money strings and leaves old artifact on HTTP failure', async () => {
    const endpoint = await request(url).get('/docs-json').expect(200);
    const destination = join(dir, 'openapi.json');
    const args = [
      '-r',
      'ts-node/register',
      '-r',
      'tsconfig-paths/register',
      'src/scripts/export-openapi.ts',
      '--url',
      url + '/docs-json',
      '--destination',
      destination,
    ];
    const cli = await run(process.execPath, args, {
      cwd: resolve(__dirname, '../..'),
      timeout: 30000,
    });
    expect(cli.stdout).toContain('OpenAPI artifact exported');
    const text = await fs.readFile(destination, 'utf8');
    const document = JSON.parse(text);
    expect(document).toEqual(endpoint.body);
    for (const path of ['/v1/transfers', '/v1/operator/deposits', '/v1/accounts', '/health/live'])
      expect(document.paths[path]).toBeDefined();
    expect(document.paths['/v1/transfers'].post['x-roles']).toEqual(['customer']);
    expect(document.paths['/v1/transfers'].post.security).toEqual([{ 'access-token': [] }]);
    expect(document.components.schemas.TransferDto.properties.amount.type).toBe('string');
    expect(document.paths['/v1/transfers'].post.responses['422']).toBeDefined();
    args[args.indexOf('--url') + 1] = url + '/missing';
    await expect(run(process.execPath, args, { timeout: 30000 })).rejects.toMatchObject({
      code: 1,
    });
    expect(await fs.readFile(destination, 'utf8')).toBe(text);
  });
});
