import { parseArgs } from 'node:util';
import {
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
  type MessageAttributeValue,
} from '@aws-sdk/client-sqs';
import { ORIGINAL_SENT_TIMESTAMP, originalSentTimestampOf } from '@libs/sqs';
import {
  ageOf,
  awsDlqPort,
  DEFAULT_MAX_AGE_DAYS,
  drainDlq,
  eventIdOf,
  EVENT_ID,
  type DlqPort,
} from './dlq-age-check';
import { appendLine, createExclusiveFile } from './dlq-files';

/**
 * Selective resend of DLQ messages to their source queue (BL-372, `docs/runbooks/dlq-redrive.md`).
 *
 * Use it after the cause of the failure is fixed and only for messages the operator chose. It is not
 * a redrive (`start-message-move-task` moves everything, with no filter). For each chosen event it
 * sends the message body unchanged to the source queue, with the same message attributes and with
 * `OriginalSentTimestamp` set to the first send, so the age that the 6-day replay limit counts from
 * (`processed_events` keeps its mark 7 days) is not reset. The DLQ copy is deleted only after the
 * send succeeded: a message is always in at least one queue.
 *
 * It never sends: a message with no `eventId` UUID in its body; an event with any copy older than
 * 6 days or with no send time (the dedup mark may have expired, a replay could apply it twice).
 * It never logs a body: report and record file hold SQS message ids and event ids only.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the resend needs from the source queue; `awsSendPort` implements it, the unit tests fake it. */
export interface SendPort {
  /** Throws when the queue does not exist or cannot be read. */
  verify(): Promise<void>;
  /** Sends one message and returns its new SQS message id. */
  send(body: string, attributes: Record<string, MessageAttributeValue>): Promise<string>;
}

export type ResendAction = 'resent' | 'duplicate_deleted' | 'resent_delete_failed';

/** One line of the record file (the command adds `at`). No body, no receipt handle. */
export interface ResendRecord {
  action: ResendAction;
  eventId: string;
  dlqMessageId: string;
  newMessageId?: string;
  originalSentTimestamp: number;
}

export type SkipReason = 'stale' | 'no_event_id' | 'not_selected';

export interface ResendReport {
  scanned: number;
  resent: number;
  duplicatesDeleted: number;
  skipped: Array<{ messageId: string; eventId?: string; reason: SkipReason }>;
  /** Chosen event ids that no DLQ message carries. */
  notFound: string[];
  /** Messages that could not be sent, deleted or handed back. */
  failed: string[];
  /** The scan saw every message. `false` means rounds ran out first: nothing was sent. */
  complete: boolean;
}

export interface ResendOptions {
  now: number;
  /** `'all'`, or the chosen event ids (UUIDs; case does not matter). */
  select: 'all' | string[];
  /** Called after each send or delete, in order. */
  record: (entry: ResendRecord) => void;
  maxRounds?: number;
}

/** Only what SQS accepts back: the receive result can carry empty list fields that a send refuses. */
function sendableAttributes(
  message: Message,
  originalSentTimestamp: number,
): Record<string, MessageAttributeValue> {
  const out: Record<string, MessageAttributeValue> = {};
  for (const [name, value] of Object.entries(message.MessageAttributes ?? {})) {
    if (name === ORIGINAL_SENT_TIMESTAMP) continue;
    out[name] = {
      DataType: value.DataType,
      ...(value.StringValue === undefined ? {} : { StringValue: value.StringValue }),
      ...(value.BinaryValue === undefined ? {} : { BinaryValue: value.BinaryValue }),
    };
  }
  out[ORIGINAL_SENT_TIMESTAMP] = { DataType: 'Number', StringValue: String(originalSentTimestamp) };
  return out;
}

export async function runDlqResend(
  dlq: DlqPort,
  to: SendPort,
  options: ResendOptions,
): Promise<ResendReport> {
  const maxAgeMs = DEFAULT_MAX_AGE_DAYS * DAY_MS;
  const chosen =
    options.select === 'all' ? undefined : new Set(options.select.map(id => id.toLowerCase()));
  const { seen, complete } = await drainDlq(dlq, options.maxRounds);

  const report: ResendReport = {
    scanned: seen.size,
    resent: 0,
    duplicatesDeleted: 0,
    skipped: [],
    notFound: [],
    failed: [],
    complete,
  };
  // Gone from the DLQ, or sent and left hidden on purpose: neither is handed back.
  const handled = new Set<string>();

  if (complete) {
    const groups = new Map<string, Message[]>();
    for (const message of seen.values()) {
      const eventId = eventIdOf(message.Body)?.toLowerCase();
      if (eventId === undefined) {
        report.skipped.push({ messageId: message.MessageId ?? 'unknown', reason: 'no_event_id' });
        continue;
      }
      groups.set(eventId, [...(groups.get(eventId) ?? []), message]);
    }

    for (const [eventId, messages] of groups) {
      const skip = (reason: SkipReason): void => {
        for (const m of messages)
          report.skipped.push({ messageId: m.MessageId ?? 'unknown', eventId, reason });
      };
      if (chosen && !chosen.has(eventId)) {
        skip('not_selected');
        continue;
      }
      // One copy older than 6 days (or with no send time) blocks every copy of the event.
      const unsafe = messages.some(m => {
        const age = ageOf(m, options.now);
        return age === undefined || age > maxAgeMs;
      });
      if (unsafe) {
        skip('stale');
        continue;
      }
      const ordered = [...messages].sort(
        (a, b) => (originalSentTimestampOf(a) ?? 0) - (originalSentTimestampOf(b) ?? 0),
      );
      const [first, ...duplicates] = ordered;
      const firstSent = originalSentTimestampOf(first) as number;
      const entry = (action: ResendAction, m: Message, newMessageId?: string): ResendRecord => ({
        action,
        eventId,
        dlqMessageId: m.MessageId ?? 'unknown',
        ...(newMessageId === undefined ? {} : { newMessageId }),
        originalSentTimestamp: originalSentTimestampOf(m) as number,
      });

      let newMessageId: string;
      try {
        newMessageId = await to.send(first.Body ?? '', sendableAttributes(first, firstSent));
      } catch {
        report.failed.push(first.MessageId ?? 'unknown');
        continue;
      }
      report.resent++;
      options.record(entry('resent', first, newMessageId));
      try {
        await dlq.delete(first);
        handled.add(first.MessageId as string);
      } catch {
        options.record(entry('resent_delete_failed', first, newMessageId));
        report.failed.push(first.MessageId ?? 'unknown');
        // Hidden until the scan visibility ends, so a quick rerun cannot send it again.
        handled.add(first.MessageId as string);
        continue;
      }
      for (const duplicate of duplicates) {
        try {
          await dlq.delete(duplicate);
          handled.add(duplicate.MessageId as string);
          report.duplicatesDeleted++;
          options.record(entry('duplicate_deleted', duplicate));
        } catch {
          report.failed.push(duplicate.MessageId ?? 'unknown');
        }
      }
    }
    if (chosen) for (const id of chosen) if (!groups.has(id)) report.notFound.push(id);
  }

  for (const message of seen.values()) {
    if (handled.has(message.MessageId as string)) continue;
    try {
      await dlq.release(message);
    } catch {
      report.failed.push(message.MessageId ?? 'unknown');
    }
  }
  return report;
}

/** The port over a real source queue (AWS or ElasticMQ). The caller owns `client` and destroys it. */
export function awsSendPort(client: SQSClient, queueUrl: string): SendPort {
  return {
    async verify() {
      await client.send(
        new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
      );
    },
    async send(body, attributes) {
      const result = await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          MessageAttributes: attributes,
        }),
      );
      return result.MessageId ?? 'unknown';
    },
  };
}

// ── Command line ──────────────────────────────────────────────────────────────────────────────

export const USAGE = `Usage: npm run --silent dlq:resend -- --from-dlq <DLQ url> --to-queue <source queue url> \\
         --record-file <path> (--all | --event-id <uuid> [--event-id <uuid> ...]) [--endpoint-url <url>]

  --from-dlq <url>       the DLQ to take the messages from (required)
  --to-queue <url>       the queue they go back to (required, not the DLQ)
  --record-file <path>   new file: one JSON line per send or delete, no body (required; an existing
                         file is refused, missing folders are created)
  --all                  resend every valid message ...
  --event-id <uuid>      ... or only the events you name (repeat the option)
  --endpoint-url <url>   SQS endpoint, for ElasticMQ (http://localhost:9324)

Never sends a message older than ${DEFAULT_MAX_AGE_DAYS} days or without an eventId; those stay in the DLQ.

Exit code: 0 every chosen message was sent, 1 some message stays in the DLQ (older than ${DEFAULT_MAX_AGE_DAYS} days,
no eventId, or a chosen event id not found), 2 bad arguments, a queue that cannot be read, an
incomplete scan, or a send or delete that failed.`;

export interface ResendCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** For tests: ready ports instead of ones built from the arguments. */
  port?: DlqPort;
  sendPort?: SendPort;
}

const sameQueue = (a: string, b: string): boolean =>
  a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');

export async function runDlqResendCli(argv: string[], io: ResendCliIo): Promise<number> {
  let values: {
    'from-dlq'?: string;
    'to-queue'?: string;
    'record-file'?: string;
    'endpoint-url'?: string;
    'event-id'?: string[];
    all?: boolean;
    help?: boolean;
  };
  try {
    values = parseArgs({
      args: argv,
      options: {
        'from-dlq': { type: 'string' },
        'to-queue': { type: 'string' },
        'record-file': { type: 'string' },
        'endpoint-url': { type: 'string' },
        'event-id': { type: 'string', multiple: true },
        all: { type: 'boolean' },
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
  const fail = (message: string): number => {
    io.stderr(`${message}\n${USAGE}\n`);
    return 2;
  };
  const fromDlq = values['from-dlq'];
  const toQueue = values['to-queue'];
  const recordFile = values['record-file'];
  if (!fromDlq || !toQueue || !recordFile)
    return fail('--from-dlq, --to-queue and --record-file are required');
  if (sameQueue(fromDlq, toQueue))
    return fail('--from-dlq and --to-queue must be different queues');
  const eventIds = values['event-id'] ?? [];
  if (values.all === true && eventIds.length > 0) return fail('use --all or --event-id, not both');
  if (values.all !== true && eventIds.length === 0)
    return fail('choose what to resend: --all or at least one --event-id');
  if (eventIds.some(id => !EVENT_ID.test(id))) return fail('--event-id must be a UUID');
  const select: 'all' | string[] =
    values.all === true ? 'all' : [...new Set(eventIds.map(id => id.toLowerCase()))];

  const client =
    io.port === undefined || io.sendPort === undefined
      ? new SQSClient({
          region: io.env.AWS_REGION ?? io.env.AWS_DEFAULT_REGION ?? 'us-east-1',
          ...(values['endpoint-url'] === undefined ? {} : { endpoint: values['endpoint-url'] }),
        })
      : undefined;
  try {
    const dlq = io.port ?? awsDlqPort(client as SQSClient, fromDlq);
    const to = io.sendPort ?? awsSendPort(client as SQSClient, toQueue);
    // Both queues must exist before anything is received: a receive hides the messages for 30 minutes.
    await to.verify();
    await dlq.visibleCount();
    // The record file is made exclusively and before the first receive: a name already used stops here.
    createExclusiveFile(recordFile);
    const report = await runDlqResend(dlq, to, {
      now: io.now(),
      select,
      record: entry =>
        appendLine(recordFile, JSON.stringify({ ...entry, at: new Date(io.now()).toISOString() })),
    });
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.complete || report.failed.length > 0) {
      io.stderr('The scan was incomplete or some messages could not be handled: check the DLQ.\n');
      return 2;
    }
    const left = report.skipped.some(s => s.reason !== 'not_selected');
    return left || report.notFound.length > 0 ? 1 : 0;
  } catch (error) {
    io.stderr(`dlq-resend failed: ${(error as Error).name}\n`);
    return 2;
  } finally {
    client?.destroy();
  }
}
