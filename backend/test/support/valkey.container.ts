import { createClient } from 'redis';
import { GenericContainer, Wait } from 'testcontainers';
import { STARTUP_TIMEOUT_MS, withTimeout } from './postgres.container';
import {
  assertServiceDockerAvailable,
  controlService,
  startServiceContainer,
  type ControlledService,
} from './service-container';

export interface StartedValkey extends ControlledService {
  host: string;
  port: number;
  url: string;
}

export async function startValkeyContainer(): Promise<StartedValkey> {
  await assertServiceDockerAvailable();
  const container = await startServiceContainer(
    'Valkey',
    new GenericContainer('valkey/valkey:8-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forSuccessfulCommand('valkey-cli ping'))
      .withStartupTimeout(STARTUP_TIMEOUT_MS)
      .start(),
    async started => {
      const url = `redis://${started.getHost()}:${started.getMappedPort(6379)}`;
      const client = createClient({
        url,
        socket: { connectTimeout: 3000, reconnectStrategy: false },
      });
      try {
        await withTimeout(client.connect(), 5000, 'Valkey connection timed out');
        if ((await client.ping()) !== 'PONG') throw new Error('Valkey PING failed');
      } finally {
        client.destroy();
      }
    },
  );
  const host = container.getHost();
  const port = container.getMappedPort(6379);
  return { ...controlService(container), host, port, url: `redis://${host}:${port}` };
}
