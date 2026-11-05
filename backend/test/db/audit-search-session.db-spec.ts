import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createDevTokenIssuer } from '../support/dev-tokens';
import { requireDatabaseUrl } from '../support/temp-database';

const backend = resolve(__dirname, '../..');
const example = parse(readFileSync(join(backend, 'env/.env.example')));
const DATABASE_NAME = /^dbs_test_[0-9a-f]{12}$/;

describe('DBS-103 isolated manual-session lifecycle (real process/AppModule/PG)', () => {
  let admin: DataSource;
  let directory: string;
  let environment: NodeJS.ProcessEnv;
  let controlName: string;

  beforeAll(async () => {
    const adminUrl = requireDatabaseUrl();
    admin = await new DataSource({ type: 'postgres', url: adminUrl }).initialize();
    const [control] = await admin.query<{ name: string }[]>('SELECT current_database() AS name');
    controlName = control.name;
    directory = mkdtempSync(join(tmpdir(), 'dbs103-session-'));
    const issuer = await createDevTokenIssuer();
    const jwks = join(directory, 'jwks.json');
    writeFileSync(jwks, JSON.stringify(issuer.jwks));
    environment = {
      ...process.env,
      ...example,
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      AUTH_MODE: 'local',
      AUTH_LOCAL_JWKS_PATH: jwks,
      DATABASE_URL: adminUrl,
      DATABASE_SSL: 'false',
      REDIS_URL: 'redis://127.0.0.1:6379',
      TS_NODE_TRANSPILE_ONLY: 'true',
    };
    for (const name of [
      'COGNITO_USER_POOL_ID',
      'COGNITO_CLIENT_ID',
      'COGNITO_ISSUER',
      'DATABASE_SSL_CA_PATH',
    ]) {
      delete environment[name];
    }
  });

  afterAll(async () => {
    await admin?.destroy();
    if (directory) {
      for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
      rmdirSync(directory);
    }
  });

  function launch(port: number, stateFile: string) {
    const child = spawn(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        '-r',
        'tsconfig-paths/register',
        'test/manual/audit-search-session.ts',
        '--port',
        String(port),
        '--db-name-file',
        stateFile,
      ],
      { cwd: backend, env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    let readyResolve: (port: number) => void;
    let readyReject: (error: Error) => void;
    const ready = new Promise<number>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // A failing-setup case only awaits exit; still observe the readiness rejection immediately.
    void ready.catch(() => undefined);
    const deadline = setTimeout(() => {
      child.kill();
      readyReject(new Error('Manual session readiness/exit deadline'));
    }, 45_000);
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const value = chunk.toString();
      output += value;
      pending += value;
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        const row = JSON.parse(line) as { event?: string; port?: number };
        if (row.event === 'audit-search-ready') readyResolve(row.port!);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once('error', error => {
        clearTimeout(deadline);
        readyReject(error);
        reject(error);
      });
      child.once('close', code => {
        clearTimeout(deadline);
        readyReject(new Error('Manual session closed before readiness'));
        resolve(code);
      });
    });
    return { child, ready, exit, output: () => output };
  }

  async function expectCleanup(stateFile: string): Promise<void> {
    const name = readFileSync(stateFile, 'utf8').trim();
    expect(name).toMatch(DATABASE_NAME);
    expect(await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).toEqual(
      [],
    );
    expect(
      await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [controlName]),
    ).toHaveLength(1);
    const [current] = await admin.query<{ name: string }[]>('SELECT current_database() AS name');
    expect(current.name).toBe(controlName);
  }

  it('TC-103-21a listens on loopback then quits through real cleanup and removes only its DB', async () => {
    const stateFile = join(directory, 'normal-db.txt');
    const session = launch(0, stateFile);
    try {
      const port = await session.ready;
      await request(`http://127.0.0.1:${port}`).get('/health/live').expect(200);
      session.child.stdin.write('quit\n');
      expect(await session.exit).toBe(0);
      expect(session.output()).toContain('audit-search-cleaned');
      expect(session.output()).not.toContain(environment.DATABASE_URL!);
      await expectCleanup(stateFile);
    } finally {
      if (session.child.exitCode === null) {
        session.child.kill();
        await session.exit;
      }
    }
  });

  it('TC-103-21b a real EADDRINUSE after DB creation still restores admin URL and drops the DB', async () => {
    const holder = createServer();
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve));
    const address = holder.address();
    if (!address || typeof address === 'string') throw new Error('No occupied probe port');
    const stateFile = join(directory, 'listen-failed-db.txt');
    const session = launch(address.port, stateFile);
    try {
      expect(await session.exit).not.toBe(0);
      expect(session.output()).toContain('EADDRINUSE');
      expect(session.output()).toContain('audit-search-cleaned');
      expect(session.output()).not.toContain('audit-search-ready');
      expect(session.output()).not.toContain(environment.DATABASE_URL!);
      await expectCleanup(stateFile);
    } finally {
      if (session.child.exitCode === null) {
        session.child.kill();
        await session.exit;
      }
      await new Promise<void>((resolve, reject) =>
        holder.close(error => (error ? reject(error) : resolve())),
      );
    }
  });
});
