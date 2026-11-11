import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureHttpApp } from '../../src/app.setup';
import { createDevTokenIssuer, type DevTokenIssuer } from './dev-tokens';
import { createTempDatabase, migrate, type TempDatabase } from './temp-database';

export interface RiskConfigApp {
  app: NestExpressApplication;
  url: string;
  db: TempDatabase;
  issuer: DevTokenIssuer;
  close(): Promise<void>;
}

/** Isolated migrated PostgreSQL and real AppModule, with a login inheriting only dbs_api. */
export async function startRiskConfigApp(): Promise<RiskConfigApp> {
  const original = process.env;
  const directory = mkdtempSync(join(tmpdir(), 'dbs160-jwks-'));
  const role = `dbs160_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  let roleCreated = false;
  let db: TempDatabase | undefined;
  let app: NestExpressApplication | undefined;
  const close = async () => {
    try {
      await app?.close();
      process.env = original;
      try {
        if (db && roleCreated) await db.runner.query(`DROP ROLE "${role}"`);
      } finally {
        await db?.drop();
      }
    } finally {
      process.env = original;
      rmSync(directory, { recursive: true, force: true });
    }
  };
  try {
    db = await createTempDatabase();
    await migrate(db.url);
    await db.runner.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' IN ROLE dbs_api`);
    roleCreated = true;
    const apiUrl = new URL(db.url);
    apiUrl.username = role;
    apiUrl.password = password;
    const issuer = await createDevTokenIssuer();
    const jwksPath = join(directory, 'jwks.json');
    writeFileSync(jwksPath, JSON.stringify(issuer.jwks));
    process.env = {
      ...original,
      // validation.schema.ts requires more than DATABASE_URL (REDIS_URL, queue URLs, ...): take the
      // documented defaults so the fixture also boots on CI, where only DATABASE_URL is set.
      ...parse(readFileSync(join(__dirname, '../../env/.env.example'), 'utf8')),
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      DATABASE_URL: apiUrl.toString(),
      AUTH_MODE: 'local',
      AUTH_LOCAL_JWKS_PATH: jwksPath,
    };
    // AppModule selects role-specific modules at import time; set APP_ROLE before loading it.
    const { AppModule } = await import('../../src/app.module');
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: false,
      abortOnError: false, // a boot failure must throw here, not exit the Jest worker silently
    });
    configureHttpApp(app, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
    await app.listen(0, '127.0.0.1');
    return { app, url: await app.getUrl(), db, issuer, close };
  } catch (error) {
    await close();
    throw error;
  }
}
