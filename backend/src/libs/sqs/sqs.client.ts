import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { sqsConfig } from '@config/sqs.config';
import { type ConfigType } from '@nestjs/config';
import {
  SQSClient as AwsClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  type Message,
} from '@aws-sdk/client-sqs';

export interface ReceiveOptions {
  waitTimeSeconds?: number;
  maxMessages?: number;
  visibilityTimeout?: number;
  /**
   * Cancels the receive in flight (BL-209): a long poll waits up to 20 s for a message, so a
   * shutdown aborts it instead of waiting. The request is dropped on the client side; a message the
   * queue had just handed over stays invisible until its visibility timeout and is delivered again.
   */
  abortSignal?: AbortSignal;
}
export interface SendOptions {
  /** Gives up on the request after this many milliseconds (the message may still have arrived). */
  timeoutMs?: number;
}
export type SqsMessage = Message;
export interface BatchResult {
  messageId: string | undefined;
  status: 'acknowledged' | 'dead-lettered' | 'failed';
}

/**
 * Thrown by a handler for a message that can never succeed (it breaks the schema, or it used up its
 * retries): `processBatch` sends it to the DLQ at once instead of leaving it to be received again.
 * The message text is a fixed sentence; it never carries the body.
 */
export class PoisonMessageError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = 'PoisonMessageError';
  }
}

/** Transport only: consumers own transactions, event validation, dedup and worker lifecycle. */
@Injectable()
export class SqsClient implements OnApplicationShutdown {
  private readonly sdk: AwsClient;
  constructor(
    @Inject(sqsConfig.KEY) config: Pick<ConfigType<typeof sqsConfig>, 'region' | 'endpoint'>,
  ) {
    this.sdk = new AwsClient({ region: config.region, endpoint: config.endpoint });
  }

  async send(
    queue: string,
    body: string,
    attributes: Record<string, string> = {},
    options: SendOptions = {},
  ): Promise<void> {
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
      options.timeoutMs === undefined
        ? undefined
        : { abortSignal: AbortSignal.timeout(options.timeoutMs) },
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
      options.abortSignal === undefined ? undefined : { abortSignal: options.abortSignal },
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

  /**
   * Hides a received message for `seconds` more (0 makes it visible at once): the backoff before
   * the next delivery of a message whose handling failed.
   */
  async changeVisibility(queue: string, message: Message, seconds: number): Promise<void> {
    if (!message.ReceiptHandle) throw new Error('SQS message has no receipt handle');
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 43200)
      throw new RangeError('Invalid SQS visibility timeout');
    await this.sdk.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queue,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
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
            await this.deadLetter(queue, dlq, message);
            return result('dead-lettered');
          }
          try {
            await handler(body, message);
          } catch (error) {
            if (!(error instanceof PoisonMessageError)) throw error;
            await this.deadLetter(queue, dlq, message);
            return result('dead-lettered');
          }
          await this.acknowledge(queue, message);
          return result('acknowledged');
        } catch {
          return result('failed');
        }
      }),
    );
  }

  /** Copies the raw message to the DLQ, then deletes the source; a DLQ send failure propagates. */
  private async deadLetter(queue: string, dlq: string, message: Message): Promise<void> {
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
  }

  /**
   * Not `onModuleDestroy` (BL-249): that hook runs before the relay and consumer loops stop, and
   * destroying the SDK under a send or delete in flight made it fail on a stopping worker. The relay
   * and consumers stop their loops in `beforeApplicationShutdown`, which Nest runs after every
   * `onModuleDestroy` and before every `onApplicationShutdown`, so the SDK goes last.
   */
  onApplicationShutdown(): void {
    this.sdk.destroy();
  }
}
