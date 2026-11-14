import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { ORIGINAL_SENT_TIMESTAMP, originalSentTimestampOf } from '@libs/sqs';

/**
 * Age check for a DLQ before a redrive (BL-210, `docs/runbooks/dlq-redrive.md` section 3).
 *
 * Why it exists: `processed_events` keeps an event id for 7 days (database-design section 10), so a
 * replay is only safe for a message whose first send was at most 6 days ago. The DLQ cannot be
 * trusted to enforce that on its own: `ConsumerBase` moves a message with `SendMessage`, which
 * restarts the DLQ's own retention, and the AWS redrive (`start-message-move-task`) moves every
 * message with no filter. So this tool reads the age from `OriginalSentTimestamp` (set by
 * `SqsClient.deadLetter`, kept across a replay) and falls back to the queue's `SentTimestamp` for a
 * message SQS moved itself. A message with neither is treated as too old, never as fresh.
 *
 * It reads the whole DLQ the way the runbook's manual scan does (long visibility, newest receipt
 * handle per message), reports the stale ones, optionally saves and deletes them, and hands every
 * other message back (visibility 0). It never logs a body: a report line has the SQS message id,
 * the event id and the age.
 */

/** Replay limit: the DLQ keeps a message 6 days, and `processed_events` keeps its mark 7 days. */
export const DEFAULT_MAX_AGE_DAYS = 6;
/** Long enough to hold every message for the whole scan (the runbook uses the same 1800 s). */
const SCAN_VISIBILITY_SECONDS = 1800;
const DAY_MS = 24 * 60 * 60 * 1000;
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the scan needs from a queue; `awsDlqPort` implements it, the unit tests fake it. */
export interface DlqPort {
  /** One receive of at most 10 messages, each hidden for the scan. */
  receive(): Promise<Message[]>;
  /** `ApproximateNumberOfMessages`: the messages that are visible right now. */
  visibleCount(): Promise<number>;
  delete(message: Message): Promise<void>;
  /** Makes the message visible at once (visibility 0). */
  release(message: Message): Promise<void>;
}

export interface StaleMessage {
  messageId: string;
  /** From the body, only when it is a UUID; the body is never copied into the report. */
  eventId?: string;
  /** `null` when the message carries no usable send time. */
  ageHours: number | null;
}

export interface DlqAgeReport {
  checked: number;
  fresh: number;
  stale: StaleMessage[];
  /** Stale messages saved to the quarantine file and removed from the DLQ. */
  deleted: number;
  /** Messages that could not be handed back or deleted; they stay hidden until the scan visibility ends. */
  failed: string[];
  /** The scan saw every message. `false` means rounds ran out first: do not redrive. */
  complete: boolean;
}

export interface DlqAgeCheckOptions {
  now: number;
  maxAgeMs: number;
  /** Delete the stale messages (after `saveStale` returned). Without it they are only reported. */
  deleteStale: boolean;
  /** Saves the stale messages (bodies included) before any is deleted. Required with `deleteStale`. */
  saveStale?: (messages: Message[]) => void | Promise<void>;
  /** Upper bound on receives, so a queue that never drains cannot loop forever. */
  maxRounds?: number;
}

function eventIdOf(body: string | undefined): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body ?? '');
    const id = (parsed as { eventId?: unknown } | null)?.eventId;
    return typeof id === 'string' && EVENT_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Milliseconds since the first send, or `undefined` when the message has no usable send time. */
export function ageOf(message: Message, now: number): number | undefined {
  const sent = originalSentTimestampOf(message);
  return sent === undefined ? undefined : Math.max(0, now - sent);
}

export async function runDlqAgeCheck(
  port: DlqPort,
  options: DlqAgeCheckOptions,
): Promise<DlqAgeReport> {
  if (options.deleteStale && !options.saveStale)
    throw new Error('Deleting stale messages needs saveStale: nothing may be deleted unsaved');
  const maxRounds = options.maxRounds ?? 200;
  // Newest receipt handle per message: an older handle may no longer be accepted.
  const seen = new Map<string, Message>();
  let complete = false;
  for (let round = 0; round < maxRounds; round++) {
    const batch = await port.receive();
    for (const message of batch) if (message.MessageId) seen.set(message.MessageId, message);
    if (batch.length === 0 && (await port.visibleCount()) === 0) {
      complete = true;
      break;
    }
  }

  const stale: Message[] = [];
  const fresh: Message[] = [];
  for (const message of seen.values()) {
    const age = ageOf(message, options.now);
    (age === undefined || age > options.maxAgeMs ? stale : fresh).push(message);
  }

  const failed: string[] = [];
  let deleted = 0;
  const keep = [...fresh];
  if (options.deleteStale && stale.length > 0) {
    // Save first: if this throws, nothing was deleted and the messages are released below.
    try {
      await options.saveStale?.(stale);
      for (const message of stale) {
        try {
          await port.delete(message);
          deleted++;
        } catch {
          failed.push(message.MessageId ?? 'unknown');
        }
      }
    } catch (error) {
      await releaseAll(port, [...keep, ...stale], failed);
      throw error;
    }
  } else {
    keep.push(...stale);
  }
  await releaseAll(port, keep, failed);

  return {
    checked: seen.size,
    fresh: fresh.length,
    stale: stale.map(message => ({
      messageId: message.MessageId ?? 'unknown',
      ...(eventIdOf(message.Body) === undefined ? {} : { eventId: eventIdOf(message.Body) }),
      ageHours: ageHours(message, options.now),
    })),
    deleted,
    failed,
    complete,
  };
}

function ageHours(message: Message, now: number): number | null {
  const age = ageOf(message, now);
  return age === undefined ? null : Math.round((age / 3_600_000) * 10) / 10;
}

async function releaseAll(port: DlqPort, messages: Message[], failed: string[]): Promise<void> {
  for (const message of messages) {
    try {
      await port.release(message);
    } catch {
      failed.push(message.MessageId ?? 'unknown');
    }
  }
}

/** The port over a real queue (AWS or ElasticMQ). The caller owns `client` and destroys it. */
export function awsDlqPort(client: SQSClient, queueUrl: string): DlqPort {
  const receiptOf = (message: Message): string => {
    if (!message.ReceiptHandle) throw new Error('SQS message has no receipt handle');
    return message.ReceiptHandle;
  };
  return {
    async receive() {
      const result = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: SCAN_VISIBILITY_SECONDS,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['SentTimestamp'],
        }),
      );
      return result.Messages ?? [];
    },
    async visibleCount() {
      const result = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
      return Number(result.Attributes?.ApproximateNumberOfMessages ?? 0);
    },
    async delete(message) {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptOf(message) }),
      );
    },
    async release(message) {
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptOf(message),
          VisibilityTimeout: 0,
        }),
      );
    },
  };
}

// ── Command line ──────────────────────────────────────────────────────────────────────────────

export const USAGE = `Usage: npm run --silent dlq:age-check -- --queue-url <DLQ url> [options]

  --queue-url <url>          the DLQ to scan (required)
  --endpoint-url <url>       SQS endpoint, for ElasticMQ (http://localhost:9324)
  --max-age-days <n>         replay limit in days (default ${DEFAULT_MAX_AGE_DAYS})
  --delete-stale             delete the stale messages from the DLQ after saving them
  --quarantine-file <path>   where --delete-stale saves them (JSON lines, bodies included)

Exit code: 0 no stale message is left in the DLQ, 1 stale messages remain (do not redrive),
2 the scan failed or did not see every message (do not redrive).`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** For tests: a ready port instead of one built from the arguments. */
  port?: DlqPort;
  /** For tests: the file writer. */
  writeFile?: (path: string, text: string) => void;
}

export async function runDlqAgeCheckCli(argv: string[], io: CliIo): Promise<number> {
  let values: {
    'queue-url'?: string;
    'endpoint-url'?: string;
    'max-age-days'?: string;
    'delete-stale'?: boolean;
    'quarantine-file'?: string;
    help?: boolean;
  };
  try {
    values = parseArgs({
      args: argv,
      options: {
        'queue-url': { type: 'string' },
        'endpoint-url': { type: 'string' },
        'max-age-days': { type: 'string' },
        'delete-stale': { type: 'boolean' },
        'quarantine-file': { type: 'string' },
        help: { type: 'boolean' },
      },
      strict: true,
    }).values;
  } catch (error) {
    io.stderr(`${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (values.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  const queueUrl = values['queue-url'];
  if (!queueUrl) {
    io.stderr(`--queue-url is required\n${USAGE}\n`);
    return 2;
  }
  const days =
    values['max-age-days'] === undefined ? DEFAULT_MAX_AGE_DAYS : Number(values['max-age-days']);
  if (!Number.isFinite(days) || days <= 0 || days > DEFAULT_MAX_AGE_DAYS) {
    // Never above 6: processed_events keeps its mark 7 days and a redrive may take 24 hours.
    io.stderr(`--max-age-days must be above 0 and at most ${DEFAULT_MAX_AGE_DAYS}\n${USAGE}\n`);
    return 2;
  }
  const deleteStale = values['delete-stale'] === true;
  const quarantineFile = values['quarantine-file'];
  if (deleteStale && !quarantineFile) {
    io.stderr(`--delete-stale needs --quarantine-file: nothing is deleted unsaved\n${USAGE}\n`);
    return 2;
  }

  const client =
    io.port === undefined
      ? new SQSClient({
          region: io.env.AWS_REGION ?? io.env.AWS_DEFAULT_REGION ?? 'us-east-1',
          ...(values['endpoint-url'] === undefined ? {} : { endpoint: values['endpoint-url'] }),
        })
      : undefined;
  try {
    const port = io.port ?? awsDlqPort(client as SQSClient, queueUrl);
    const write =
      io.writeFile ?? ((path: string, text: string) => writeFileSync(path, text, { mode: 0o600 }));
    const report = await runDlqAgeCheck(port, {
      now: io.now(),
      maxAgeMs: days * DAY_MS,
      deleteStale,
      saveStale: messages =>
        write(
          quarantineFile as string,
          messages
            .map(message =>
              JSON.stringify({
                messageId: message.MessageId,
                originalSentTimestamp: originalSentTimestampOf(message) ?? null,
                attribute:
                  message.MessageAttributes?.[ORIGINAL_SENT_TIMESTAMP]?.StringValue ?? null,
                body: message.Body,
              }),
            )
            .join('\n') + '\n',
        ),
    });
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.complete || report.failed.length > 0) {
      io.stderr('The scan was incomplete or some messages could not be handled: do not redrive.\n');
      return 2;
    }
    return report.stale.length - report.deleted > 0 ? 1 : 0;
  } catch (error) {
    io.stderr(`dlq-age-check failed: ${(error as Error).name}\n`);
    return 2;
  } finally {
    client?.destroy();
  }
}
