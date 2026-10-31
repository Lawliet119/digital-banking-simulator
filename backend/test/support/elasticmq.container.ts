import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { assertDockerAvailable, STARTUP_TIMEOUT_MS, withTimeout } from './postgres.container';
import { controlService, startServiceContainer, type ControlledService } from './service-container';

export interface StartedElasticMq extends ControlledService {
  host: string;
  port: number;
  endpoint: string;
  riskQueueUrl: string;
}

/**
 * Ngân sách thật của 40 lần retry = 40×3000ms (timeout mỗi lần) + 39×250ms (nghỉ giữa các lần,
 * lần cuối không nghỉ) = 129.750ms (~129,75s). Đặt probe timeout 150s để còn biên an toàn ~15,6%
 * (20,25s) chịu được jitter scheduler/GC qua 40 vòng, thay vì sát ngân sách.
 */
export const ELASTICMQ_PROBE_TIMEOUT_MS = 150_000;

export function localSqsClient(endpoint: string): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    maxAttempts: 1,
  });
}

/**
 * Xác nhận queue `risk-events` bằng SQS `GetQueueUrl`, trả đường dẫn queue (path của URL do
 * ElasticMQ quảng bá) qua giá trị trả về — không qua biến side-effect ở outer scope. `signal`
 * được kiểm ở đầu mỗi vòng lặp và truyền vào `sqs.send` để khi `startServiceContainer` abort (do
 * probe timeout tổng bắn), vòng lặp dừng ngay thay vì tiếp tục gửi request tới một container đang
 * bị dọn.
 */
export async function probeRiskQueue(
  started: StartedTestContainer,
  signal: AbortSignal,
): Promise<string> {
  const endpoint = `http://${started.getHost()}:${started.getMappedPort(9324)}`;
  const sqs = localSqsClient(endpoint);
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (signal.aborted) throw new Error('ElasticMQ risk-events queue probe aborted');
      try {
        const result = await withTimeout(
          sqs.send(new GetQueueUrlCommand({ QueueName: 'risk-events' }), { abortSignal: signal }),
          3_000,
          'ElasticMQ GetQueueUrl timed out',
        );
        if (!result.QueueUrl) throw new Error('ElasticMQ risk-events queue is missing');
        return new URL(result.QueueUrl).pathname;
      } catch (error) {
        if (attempt === 39 || signal.aborted) throw error;
        await setTimeout(250);
      }
    }
    // Unreachable: attempt === 39 always throws above. Kept so the function's return type stays
    // Promise<string> without a non-null assertion at the call site.
    throw new Error('ElasticMQ risk-events queue probe exhausted retries');
  } finally {
    sqs.destroy();
  }
}

export async function startElasticMqContainer(): Promise<StartedElasticMq> {
  await assertDockerAvailable(undefined, 'service container tests (Valkey/ElasticMQ)');
  const { container, probeResult: riskQueuePath } = await startServiceContainer(
    'ElasticMQ',
    new GenericContainer('softwaremill/elasticmq-native:latest')
      .withCopyFilesToContainer([
        {
          source: resolve(__dirname, '../../../infra/local/elasticmq.conf'),
          target: '/opt/elasticmq.conf',
        },
      ])
      .withExposedPorts(9324)
      .withWaitStrategy(Wait.forListeningPorts())
      .withStartupTimeout(STARTUP_TIMEOUT_MS)
      .start(),
    probeRiskQueue,
    ELASTICMQ_PROBE_TIMEOUT_MS,
  );
  const host = container.getHost();
  const port = container.getMappedPort(9324);
  const endpoint = `http://${host}:${port}`;
  return {
    ...controlService(container),
    host,
    port,
    endpoint,
    riskQueueUrl: new URL(riskQueuePath, endpoint).toString(),
  };
}
