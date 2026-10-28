import { createClient } from 'redis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { assertDockerAvailable, STARTUP_TIMEOUT_MS, withTimeout } from './postgres.container';
import { controlService, startServiceContainer, type ControlledService } from './service-container';

export interface StartedValkey extends ControlledService {
  host: string;
  port: number;
  url: string;
}

/** Generous so với connect timeout 5s + PING; không cần ngân sách retry dài như ElasticMQ. */
export const VALKEY_PROBE_TIMEOUT_MS = 10_000;

async function probePing(started: StartedTestContainer, signal: AbortSignal): Promise<void> {
  const url = `redis://${started.getHost()}:${started.getMappedPort(6379)}`;
  const client = createClient({
    url,
    socket: { connectTimeout: 3000, reconnectStrategy: false },
  });
  try {
    await withTimeout(client.connect(), 5000, 'Valkey connection timed out');
    if (signal.aborted) throw new Error('Valkey probe aborted');
    if ((await client.ping()) !== 'PONG') throw new Error('Valkey PING failed');
  } finally {
    client.destroy();
  }
}

export async function startValkeyContainer(): Promise<StartedValkey> {
  await assertDockerAvailable(undefined, 'service container tests (Valkey/ElasticMQ)');
  const { container } = await startServiceContainer(
    'Valkey',
    new GenericContainer('valkey/valkey:8-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forSuccessfulCommand('valkey-cli ping'))
      .withStartupTimeout(STARTUP_TIMEOUT_MS)
      .start(),
    probePing,
    VALKEY_PROBE_TIMEOUT_MS,
  );
  const host = container.getHost();
  const port = container.getMappedPort(6379);
  return { ...controlService(container), host, port, url: `redis://${host}:${port}` };
}
