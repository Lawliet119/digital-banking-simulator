/** Manual runtime check: node -r ts-node/register -r tsconfig-paths/register test/support/logging-driver.ts */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const backend = resolve(__dirname, '../..');
const example = parse(readFileSync(resolve(backend, 'env/.env.example')));
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  await new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done())));
  return address.port;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

async function run(role: 'api' | 'worker' | 'both', logLevel: 'debug' | 'error' = 'debug') {
  const port = await unusedPort();
  console.log(
    `\n$ APP_ROLE=${role} LOG_LEVEL=${logLevel} PORT=<ephemeral> node -r ts-node/register -r tsconfig-paths/register src/main.ts`,
  );
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', 'src/main.ts'],
    {
      cwd: backend,
      env: {
        ...process.env,
        ...example,
        NODE_ENV: 'test',
        APP_ROLE: role,
        LOG_LEVEL: logLevel,
        PORT: String(port),
        TS_NODE_TRANSPILE_ONLY: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<void>((done, fail) => {
    child.once('error', fail);
    child.once('close', () => done());
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 25_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Application exited before readiness');
      if (role === 'worker') ready = stdout.includes('Worker started');
      else {
        try {
          ready = (await fetch(`${url}/health/live`, { signal: AbortSignal.timeout(500) })).ok;
        } catch {
          /* Wait for the actual listener. */
        }
      }
      if (ready) break;
      await delay(100);
    }
    check(ready, `${role} started`);
    if (role === 'worker') {
      let listening = false;
      try {
        await fetch(`${url}/health/live`, { signal: AbortSignal.timeout(500) });
        listening = true;
      } catch {
        /* No HTTP is expected. */
      }
      check(!listening, 'M-42-03 worker has no HTTP listener');
    } else {
      const headers = {
        'X-Correlation-Id': '12ab5ea6-f71f-4034-844b-a3e752af4fbc',
        Authorization: 'Bearer sensitive-manual-fixture',
      };
      const response = await fetch(`${url}/health/ready`, { headers });
      check(response.status === 200, 'M-42-01 ready=200 against real PostgreSQL');
      const id = response.headers.get('x-correlation-id');
      check(id && id !== headers['X-Correlation-Id'], 'M-42-01 server chooses correlationId');
      console.log(`HTTP ready status=${response.status} correlationId=${id}`);
      console.log(await response.text());
      const missing = await fetch(`${url}/sensitive-path-fixture?token=sensitive-query-fixture`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: 'sensitive-body-fixture',
          accountNumber: '9876543210987654',
        }),
      });
      check(missing.status === 404, 'M-42-02 unknown route=404');
      console.log(
        `HTTP missing status=${missing.status} correlationId=${missing.headers.get('x-correlation-id')}`,
      );
      const problem = (await missing.json()) as { status: number; correlationId: string };
      console.log(
        `Selected problem fields: ${JSON.stringify({ status: problem.status, correlationId: problem.correlationId })}`,
      );
      await delay(20); // Flush observation only; no correctness assertion depends on a fixed sleep.
      if (logLevel === 'debug')
        check(stdout.includes(id), 'M-42-01 response ID appears in JSON log');
    }
  } finally {
    child.kill();
    await closed;
    console.log('APPLICATION STDOUT:');
    console.log(stdout.trim() || '(empty)');
    check(stderr.length === 0, 'no plain-text stderr');
  }

  check(
    !stdout.includes('sensitive-') && !stdout.includes('9876543210987654'),
    'M-42-02 no sensitive fixtures in logs',
  );
  const rows = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
  for (const row of rows) {
    check(
      typeof row.level === 'number' &&
        typeof row.time === 'string' &&
        /^\d{4}-.*Z$/.test(row.time) &&
        typeof row.message === 'string' &&
        (row.role === 'api' || row.role === 'worker') &&
        'correlationId' in row,
      'M-42-01 JSON record has required fields',
    );
  }
  if (role === 'worker')
    check(
      rows.every(row => row.role === 'worker' && row.correlationId === null),
      'M-42-03 worker role and null startup ID',
    );
  if (role === 'both')
    check(
      rows.every(row => row.appRole === 'both' && row.role === 'api'),
      'both keeps appRole and HTTP role',
    );
  if (logLevel === 'error')
    check(rows.length === 0, 'M-42-04 error level suppresses successful startup, 200 and 404 logs');
}

async function main() {
  console.log(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: backend, encoding: 'utf8' }).trim(),
  );
  console.log(
    'Manual runtime logging check; source app, PostgreSQL Compose, synthetic secrets only.',
  );
  await run('api');
  await run('worker');
  await run('both');
  await run('api', 'error');
  console.log(
    '\nAll manual runtime checks passed. Error paths are additionally executed by logging-bootstrap/logging HTTP e2e suites.',
  );
}

void main().catch(() => {
  console.error('Manual logging check failed; inspect the preceding output.');
  process.exitCode = 1;
});
