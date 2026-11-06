import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { sqsConfig } from '@config/sqs.config';
import { type ConfigType } from '@nestjs/config';
import {
  SQSClient as AwsClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';

export interface ReceiveOptions {
  waitTimeSeconds?: number;
  maxMessages?: number;
  visibilityTimeout?: number;
}
export type SqsMessage = Message;
export interface BatchResult {
  messageId: string | undefined;
  status: 'acknowledged' | 'dead-lettered' | 'failed';
}

/** Transport only: consumers own transactions, event validation, dedup and worker lifecycle. */
@Injectable()
export class SqsClient implements OnModuleDestroy {
  private readonly sdk: AwsClient;
  constructor(
    @Inject(sqsConfig.KEY) config: Pick<ConfigType<typeof sqsConfig>, 'region' | 'endpoint'>,
  ) {
    this.sdk = new AwsClient({ region: config.region, endpoint: config.endpoint });
  }

  async send(queue: string, body: string, attributes: Record<string, string> = {}): Promise<void> {
    await this.sdk.send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: body,
        MessageAttributes: Object.fromEntries(
          Object.entries(attributes).map(([key, value]) => [
            key,
            { DataType: 'String', StringValue: value },
          ]),
        ),
      }),
    );
  }

  async receive(queue: string, options: ReceiveOptions = {}): Promise<Message[]> {
    const wait = options.waitTimeSeconds ?? 20;
    const batch = options.maxMessages ?? 10;
    const visibility = options.visibilityTimeout ?? 30;
    for (const [value, min, max] of [
      [wait, 0, 20],
      [batch, 1, 10],
      [visibility, 0, 43200],
    ]) {
      if (!Number.isInteger(value) || value < min || value > max)
        throw new RangeError('Invalid SQS receive options');
    }
    const result = await this.sdk.send(
      new ReceiveMessageCommand({
        QueueUrl: queue,
        WaitTimeSeconds: wait,
        MaxNumberOfMessages: batch,
        VisibilityTimeout: visibility,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return result.Messages ?? [];
  }

  /** Call only after committing the effect; a failed delete means redelivery is possible. */
  async acknowledge(queue: string, message: Message): Promise<void> {
    if (!message.ReceiptHandle) throw new Error('SQS message has no receipt handle');
    await this.sdk.send(
      new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  /** One batch only. Failed handlers stay unacknowledged; never logs message data or errors. */
  async processBatch(
    queue: string,
    dlq: string,
    handler: (body: unknown, message: Message) => Promise<void>,
    options: ReceiveOptions = {},
  ): Promise<BatchResult[]> {
    if (!dlq || dlq === queue) throw new Error('A distinct DLQ is required');
    const messages = await this.receive(queue, options);
    return Promise.all(
      messages.map(async (message): Promise<BatchResult> => {
        const result = (status: BatchResult['status']): BatchResult => ({
          messageId: message.MessageId,
          status,
        });
        try {
          if (message.Body === undefined || !message.ReceiptHandle) return result('failed');
          let body: unknown;
          try {
            body = JSON.parse(message.Body) as unknown;
          } catch {
            // Preserve raw message attributes, including types unknown to this adapter.
            await this.sdk.send(
              new SendMessageCommand({
                QueueUrl: dlq,
                MessageBody: message.Body,
                MessageAttributes: message.MessageAttributes,
              }),
            );
            // Forwarding already succeeded; report dead-lettered even if this delete fails,
            // so callers don't mistake a forwarded message for one nothing happened to.
            try {
              await this.acknowledge(queue, message);
            } catch {
              // Source stays visible and will redeliver; next attempt forwards to the DLQ
              // again, which the DLQ consumer must tolerate (at-least-once, see README).
            }
            return result('dead-lettered');
          }
          await handler(body, message);
          await this.acknowledge(queue, message);
          return result('acknowledged');
        } catch {
          return result('failed');
        }
      }),
    );
  }

  onModuleDestroy(): void {
    this.sdk.destroy();
  }
}
