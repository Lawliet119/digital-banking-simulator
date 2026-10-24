import { createClient } from 'redis';
import { getContainerRuntimeClient } from 'testcontainers';
import { ListQueuesCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { startValkeyContainer } from '../support/valkey.container';
import { startElasticMqContainer } from '../support/elasticmq.container';
import { localSqsClient } from '../support/elasticmq.container';
import { withTimeout } from '../support/postgres.container';

describe('DBS-40 isolated service containers', () => {
  it('TC-40-01/03: starts Valkey on a dynamic port, reads a key, pauses and recovers', async () => {
    const service = await startValkeyContainer();
    console.log(`DBS-40 Valkey created id=${service.containerId} port=${service.port}`);
    const client = createClient({ url: service.url, socket: { reconnectStrategy: false } });
    try {
      await client.connect();
      await client.set('dbs40:health', 'ready');
      expect(await client.get('dbs40:health')).toBe('ready');
      console.log('DBS-40 Valkey SET/GET verified value=ready');
      await service.pause();
      const pending = client.ping();
      const timedOut = await Promise.race([
        pending.then(() => false),
        new Promise<boolean>(resolve => setTimeout(() => resolve(true), 500)),
      ]);
      expect(timedOut).toBe(true);
      await service.resume();
      expect(await pending).toBe('PONG');
      console.log('DBS-40 Valkey pause timeout and resume PONG verified');
    } finally {
      await service.resume();
      if (client.isOpen) await client.quit();
      await service.stop();
    }
    const runtime = await getContainerRuntimeClient();
    await expect(runtime.container.getById(service.containerId).inspect()).rejects.toThrow();
    console.log(`DBS-40 Valkey removed id=${service.containerId}`);
    const down = createClient({
      url: service.url,
      socket: { connectTimeout: 1000, reconnectStrategy: false },
    });
    down.on('error', () => undefined);
    try {
      await expect(
        withTimeout(down.connect(), 2000, 'Valkey did not reject down connection'),
      ).rejects.toThrow();
      console.log('DBS-40 Valkey stopped connection rejected');
    } finally {
      if (down.isOpen) down.destroy();
    }
    const recovered = await startValkeyContainer();
    const probe = createClient({ url: recovered.url, socket: { reconnectStrategy: false } });
    try {
      await probe.connect();
      expect(await probe.ping()).toBe('PONG');
      console.log('DBS-40 Valkey fresh container recovery PONG verified');
    } finally {
      probe.destroy();
      await recovered.stop();
    }
    await expect(runtime.container.getById(recovered.containerId).inspect()).rejects.toThrow();
    console.log(`DBS-40 Valkey recovery removed id=${recovered.containerId}`);
  });

  it('TC-40-02/04: starts ElasticMQ with local config, sends and receives a message', async () => {
    const service = await startElasticMqContainer();
    console.log(`DBS-40 ElasticMQ created id=${service.containerId} port=${service.port}`);
    const sqs = localSqsClient(service.endpoint);
    try {
      const listed = await sqs.send(new ListQueuesCommand({}));
      // ElasticMQ advertises its internal 9324 URL; the helper rewrites that queue path
      // onto the dynamically mapped Testcontainers endpoint used by the SDK.
      expect(
        listed.QueueUrls?.some(
          url => new URL(url).pathname === new URL(service.riskQueueUrl).pathname,
        ),
      ).toBe(true);
      expect(listed.QueueUrls?.some(url => url.endsWith('/notification-events'))).toBe(true);
      expect(listed.QueueUrls?.some(url => url.endsWith('/risk-events-dlq'))).toBe(true);
      const message = 'dbs40 service check';
      await sqs.send(
        new SendMessageCommand({ QueueUrl: service.riskQueueUrl, MessageBody: message }),
      );
      const received = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: service.riskQueueUrl, WaitTimeSeconds: 1 }),
      );
      expect(received.Messages?.[0]?.Body).toBe(message);
      console.log('DBS-40 ElasticMQ send/receive verified queue=risk-events');
      await service.pause();
      await expect(
        sqs.send(new ListQueuesCommand({}), { abortSignal: AbortSignal.timeout(500) }),
      ).rejects.toThrow();
      await service.resume();
      expect((await sqs.send(new ListQueuesCommand({}))).QueueUrls?.length).toBeGreaterThan(0);
      console.log('DBS-40 ElasticMQ pause timeout and resume verified');
    } finally {
      await service.resume();
      sqs.destroy();
      await service.stop();
    }
    const runtime = await getContainerRuntimeClient();
    await expect(runtime.container.getById(service.containerId).inspect()).rejects.toThrow();
    console.log(`DBS-40 ElasticMQ removed id=${service.containerId}`);
    const down = localSqsClient(service.endpoint);
    try {
      await expect(
        down.send(new ListQueuesCommand({}), { abortSignal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow();
      console.log('DBS-40 ElasticMQ stopped request rejected');
    } finally {
      down.destroy();
    }
    const recovered = await startElasticMqContainer();
    const probe = localSqsClient(recovered.endpoint);
    try {
      expect((await probe.send(new ListQueuesCommand({}))).QueueUrls?.length).toBeGreaterThan(0);
      console.log('DBS-40 ElasticMQ fresh container recovery verified');
    } finally {
      probe.destroy();
      await recovered.stop();
    }
    await expect(runtime.container.getById(recovered.containerId).inspect()).rejects.toThrow();
    console.log(`DBS-40 ElasticMQ recovery removed id=${recovered.containerId}`);
  });
});
