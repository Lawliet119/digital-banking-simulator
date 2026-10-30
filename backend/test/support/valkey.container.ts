import { setTimeout } from 'node:timers/promises';
import { createClient } from 'redis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { assertDockerAvailable, STARTUP_TIMEOUT_MS, withTimeout } from './postgres.container';
import { controlService, startServiceContainer, type ControlledService } from './service-container';

export interface StartedValkey extends ControlledService {
  host: string;
  port: number;
  url: string;
}

/**
 * Ngân sách retry thật của probe = 10×3000ms (connect + PING tối đa mỗi lần) + 9×250ms (nghỉ giữa
 * các lần, lần cuối không nghỉ) = 32.250ms. Đặt 45s để còn biên ~39% chịu jitter, cùng cách tính
 * với ELASTICMQ_PROBE_TIMEOUT_MS.
 */
export const VALKEY_PROBE_TIMEOUT_MS = 45_000;

const PROBE_ATTEMPTS = 10;

/**
 * Chờ Valkey nhận kết nối và trả PONG. Ngay sau khi Testcontainers báo container sẵn sàng, Docker
 * Desktop (Windows) có thể chưa nối xong cổng đã map nên lần connect đầu bị ECONNREFUSED; thử lại có
 * giới hạn, giống probe của ElasticMQ.
 *
 * `signal` được kiểm ở đầu mỗi lần thử để dừng ngay khi `startServiceContainer` abort. Client chỉ
 * bị `destroy()` khi còn mở: với `reconnectStrategy: false`, connect lỗi đã tự đóng client, và
 * `destroy()` trên client đã đóng ném ClientClosedError, che mất lỗi kết nối thật.
 */
export async function probeValkey(
  started: StartedTestContainer,
  signal: AbortSignal,
  attempts = PROBE_ATTEMPTS,
): Promise<void> {
  const url = `redis://${started.getHost()}:${started.getMappedPort(6379)}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal.aborted) throw new Error('Valkey probe aborted');
    const client = createClient({
      url,
      socket: { connectTimeout: 3000, reconnectStrategy: false },
    });
    // Lỗi socket được báo qua promise của connect()/ping(); không có listener thì node-redis ném
    // 'error' như lỗi chưa xử lý.
    client.on('error', () => undefined);
    try {
      await withTimeout(client.connect(), 3000, 'Valkey connection timed out');
      if ((await client.ping()) !== 'PONG') throw new Error('Valkey PING failed');
      return;
    } catch (error) {
      if (attempt === attempts || signal.aborted) throw error;
      await setTimeout(250);
    } finally {
      if (client.isOpen) client.destroy();
    }
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
    probeValkey,
    VALKEY_PROBE_TIMEOUT_MS,
  );
  const host = container.getHost();
  const port = container.getMappedPort(6379);
  return { ...controlService(container), host, port, url: `redis://${host}:${port}` };
}
