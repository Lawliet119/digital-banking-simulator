import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Runs the real production image (`backend/Dockerfile`) as `api` or `worker`, so a test sees what
 * ECS sees: Node is PID 1 and no init process sits in front of it. A test that spawns
 * `node dist/main.js` as an ordinary process cannot reproduce a shutdown bug that depends on PID 1.
 *
 * Containers are driven with the Docker CLI (not Testcontainers) because the tests need
 * `docker stop -t` timing and the exit code of a stopped container, and Testcontainers removes a
 * container as soon as it is stopped.
 */

/** Hostname under which a container reaches services published on the Docker host. */
export const HOST_FROM_CONTAINER = 'host.docker.internal';

export interface AppEnvironment {
  databaseUrl: string;
  redisUrl: string;
  sqsEndpoint: string;
  riskQueueUrl: string;
  notificationQueueUrl: string;
}

/** Same URL with its host replaced by the name a container uses to reach the Docker host. */
export function forContainer(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = HOST_FROM_CONTAINER;
  return parsed.toString();
}

/** Builds the image once per test run (Docker's layer cache makes a repeat cheap). */
export async function buildAppImage(): Promise<string> {
  const tag = `dbs-app-test:${randomBytes(4).toString('hex')}`;
  await run('docker', ['build', '--quiet', '-t', tag, resolve(__dirname, '../..')], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return tag;
}

export async function removeImage(tag: string): Promise<void> {
  await run('docker', ['rmi', '-f', tag]).catch(() => undefined);
}

export interface StartOptions {
  /** Added to, or replacing, the default variables; `undefined` removes one. */
  vars?: Record<string, string | undefined>;
  /** Read-only bind mounts, `[hostPath, containerPath]`. */
  mounts?: [string, string][];
  /** Publishes port 3000 on a free host port, see `url()`. */
  publish?: boolean;
}

export interface StartedApp {
  name: string;
  /** `http://127.0.0.1:<port>` of a container started with `publish`. */
  url(): Promise<string>;
  /** Resolves once the log shows `readyLine`; rejects after `timeoutMs` with the log attached. */
  ready(readyLine: RegExp, timeoutMs?: number): Promise<void>;
  logs(): Promise<string>;
  /** `docker stop -t <graceSeconds>`: SIGTERM, then SIGKILL after the grace period. */
  stop(graceSeconds: number): Promise<{ elapsedMs: number; exitCode: number }>;
  remove(): Promise<void>;
}

export async function startApp(
  image: string,
  role: 'api' | 'worker',
  env: AppEnvironment,
  options: StartOptions = {},
): Promise<StartedApp> {
  const name = `dbs-app-test-${role}-${randomBytes(4).toString('hex')}`;
  const vars: Record<string, string | undefined> = {
    APP_ROLE: role,
    NODE_ENV: 'development',
    PORT: '3000',
    LOG_LEVEL: 'log',
    DATABASE_URL: env.databaseUrl,
    DATABASE_SSL: 'false',
    REDIS_URL: env.redisUrl,
    AWS_REGION: 'ap-southeast-1',
    SQS_ENDPOINT: env.sqsEndpoint,
    SQS_RISK_QUEUE_URL: env.riskQueueUrl,
    SQS_NOTIFICATION_QUEUE_URL: env.notificationQueueUrl,
    AWS_ACCESS_KEY_ID: 'local',
    AWS_SECRET_ACCESS_KEY: 'local',
    COGNITO_USER_POOL_ID: 'ap-southeast-1_test',
    COGNITO_CLIENT_ID: 'testclient',
    COGNITO_ISSUER: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_test',
    ...options.vars,
  };
  const envArgs = Object.entries(vars).flatMap(([key, value]) =>
    value === undefined ? [] : ['-e', `${key}=${value}`],
  );
  const mountArgs = (options.mounts ?? []).flatMap(([from, to]) => ['-v', `${from}:${to}:ro`]);
  // No `--init`: the point is Node running as PID 1, exactly as in the ECS task definition.
  await run('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--add-host',
    `${HOST_FROM_CONTAINER}:host-gateway`,
    ...envArgs,
    ...mountArgs,
    ...(options.publish ? ['-p', '127.0.0.1::3000'] : []),
    image,
  ]);

  const logs = async (): Promise<string> => {
    const { stdout, stderr } = await run('docker', ['logs', name], { maxBuffer: 16 * 1024 * 1024 });
    return stdout + stderr;
  };

  return {
    name,
    logs,
    async url() {
      const { stdout } = await run('docker', ['port', name, '3000/tcp']);
      return `http://${stdout.trim().split(/\r?\n/)[0]}`;
    },
    async ready(readyLine, timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const text = await logs();
        if (readyLine.test(text)) return;
        if (Date.now() > deadline) {
          throw new Error(`${name} was not ready within ${timeoutMs} ms. Log:\n${text}`);
        }
        await wait(500);
      }
    },
    async stop(graceSeconds) {
      const started = Date.now();
      await run('docker', ['stop', '-t', String(graceSeconds), name]);
      const elapsedMs = Date.now() - started;
      const { stdout } = await run('docker', ['inspect', '-f', '{{.State.ExitCode}}', name]);
      return { elapsedMs, exitCode: Number(stdout.trim()) };
    },
    async remove() {
      await run('docker', ['rm', '-f', name]).catch(() => undefined);
    },
  };
}
