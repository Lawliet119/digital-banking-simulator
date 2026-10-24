import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GenericContainer, Wait } from 'testcontainers';
import { STARTUP_TIMEOUT_MS, withTimeout } from './postgres.container';
import {
  assertServiceDockerAvailable,
  controlService,
  startServiceContainer,
  type ControlledService,
} from './service-container';

export interface StartedElasticMq extends ControlledService {
  host: string;
  port: number;
  endpoint: string;
  riskQueueUrl: string;
}

export function localSqsClient(endpoint: string): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    maxAttempts: 1,
  });
}

export async function startElasticMqContainer(): Promise<StartedElasticMq> {
  await assertServiceDockerAvailable();
  let riskQueuePath: string | undefined;
  const container = await startServiceContainer(
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
    async started => {
      const endpoint = `http://${started.getHost()}:${started.getMappedPort(9324)}`;
      const sqs = localSqsClient(endpoint);
      try {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            const result = await withTimeout(
              sqs.send(new GetQueueUrlCommand({ QueueName: 'risk-events' })),
              3_000,
              'ElasticMQ GetQueueUrl timed out',
            );
            if (!result.QueueUrl) throw new Error('ElasticMQ risk-events queue is missing');
            riskQueuePath = new URL(result.QueueUrl).pathname;
            return;
          } catch (error) {
            if (attempt === 39) throw error;
            await setTimeout(250);
          }
        }
      } finally {
        sqs.destroy();
      }
    },
  );
  const host = container.getHost();
  const port = container.getMappedPort(9324);
  const endpoint = `http://${host}:${port}`;
  return {
    ...controlService(container),
    host,
    port,
    endpoint,
    riskQueueUrl: new URL(riskQueuePath!, endpoint).toString(),
  };
}
