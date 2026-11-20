import { parseArgs } from 'node:util';
import {
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
  type MessageAttributeValue,
} from '@aws-sdk/client-sqs';
import { validateEvent } from '@common/events';
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
import {
  appendLine,
  assertSafeOutputPath,
  createExclusiveFile,
  FileExistsError,
} from './dlq-files';

/**
 * Selective resend of DLQ messages to their source queue (BL-372, `docs/runbooks/dlq-redrive.md`).
 *
 * Use it after the cause of the failure is fixed and only for messages the operator chose. It is not
 * a redrive (`start-message-move-task` moves everything, with no filter). For each chosen event it
 * sends the message body unchanged to the source queue, with the same message attributes and with
 * `OriginalSentTimestamp` set to the first send, so the age that the 6-day replay limit counts from
 * (`processed_events` keeps its mark 7 days) is not reset. The DLQ copy is deleted only after the
 * send succeeded: a message is always in at least one queue, and the record file names it before
 * the send.
 *
 * It sends only into an empty source queue whose RedrivePolicy (when it has one) points to this DLQ.
 * It never sends: a message with no `eventId` UUID; a message the consumers would refuse
 * (`validateEvent`); an event with any copy older than 6 days or with no send time (the dedup mark
 * may have expired, a replay could apply it twice). It never logs a body or an error text: report
 * and record file hold SQS message ids, event ids and error names only.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A receipt handle lives 1800 s from the receive; stop sending well before that. */
const DEFAULT_BUDGET_MS = 1_500_000;

/** What the resend needs from the source queue; `awsSendPort` implements it, the unit tests fake it. */
export interface SendPort {
  /** Sends one message and returns its new SQS message id. */
  send(body: string, attributes: Record<string, MessageAttributeValue>): Promise<string>;
}

/** What the command checks about a queue before it touches the DLQ. */
export interface QueueInfo {
  /** Visible + not visible + delayed messages. */
  queued: number;
  arn?: string;
  /** `deadLetterTargetArn` of the queue's RedrivePolicy, when it has one. */
  deadLetterTargetArn?: string;
}

export type ResendAction = 'sending' | 'resent' | 'duplicate_deleted' | 'resent_delete_failed';

/** One line of the record file (the command adds `at`). No body, no receipt handle. */
export interface ResendRecord {
  action: ResendAction;
  eventId: string;
  dlqMessageId: string;
  newMessageId?: string;
  originalSentTimestamp: number;
}

export type SkipReason = 'stale' | 'no_event_id' | 'invalid_event' | 'not_selected';

export interface FailedItem {
  messageId: string;
  eventId?: string;
  step: 'send' | 'delete' | 'release' | 'record';
  /** The error name only: the text of an SDK error carries the queue URL and the account id. */
  error: string;
}

export interface ResendReport {
  scanned: number;
  resent: number;
  duplicatesDeleted: number;
  skipped: Array<{ messageId: string; eventId?: string; reason: SkipReason }>;
  /** Chosen event ids that no DLQ message carries. */
  notFound: string[];
  failed: FailedItem[];
  /** The scan saw every message. `false` means rounds ran out first: nothing was sent. */
  complete: boolean;
  /** The time budget ran out before every event was handled. */
  stoppedEarly: boolean;
}

export interface ResendOptions {
  now: number;
  /** `'all'`, or the chosen event ids (UUIDs; case does not matter). */
  select: 'all' | string[];
  /** Called before each send and after each send or delete, in order. May throw: the run then stops. */
  record: (entry: ResendRecord) => void;
  maxRounds?: number;
  /** Stop sending this long after the scan started (default 1500 s). */
  budgetMs?: number;
  clock?: () => number;
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

function acceptedByConsumers(body: string | undefined): boolean {
  try {
    return validateEvent(JSON.parse(body ?? '')).ok;
  } catch {
    return false;
  }
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

export async function runDlqResend(
  dlq: DlqPort,
  to: SendPort,
  options: ResendOptions,
): Promise<ResendReport> {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
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
    stoppedEarly: false,
  };
  // Not handed back: gone from the DLQ, or sent and left hidden on purpose (so a quick rerun cannot
  // see a copy of an event that was already sent).
  const handled = new Set<string>();
  const fail = (m: Message, step: FailedItem['step'], error: unknown): void => {
    const eventId = eventIdOf(m.Body)?.toLowerCase();
    report.failed.push({
      messageId: m.MessageId ?? 'unknown',
      ...(eventId === undefined ? {} : { eventId }),
      step,
      error: errorName(error),
    });
  };

  if (complete) {
    const groups = new Map<string, Message[]>();
    const known = new Set<string>();
    for (const message of seen.values()) {
      const messageId = message.MessageId ?? 'unknown';
      const eventId = eventIdOf(message.Body)?.toLowerCase();
      if (eventId === undefined) {
        report.skipped.push({ messageId, reason: 'no_event_id' });
        continue;
      }
      known.add(eventId);
      if (chosen && !chosen.has(eventId)) {
        report.skipped.push({ messageId, eventId, reason: 'not_selected' });
        continue;
      }
      if (!acceptedByConsumers(message.Body)) {
        report.skipped.push({ messageId, eventId, reason: 'invalid_event' });
        continue;
      }
      groups.set(eventId, [...(groups.get(eventId) ?? []), message]);
    }

    groups: for (const [eventId, messages] of groups) {
      // One copy older than 6 days (or with no send time) blocks every copy of the event.
      const unsafe = messages.some(m => {
        const age = ageOf(m, options.now);
        return age === undefined || age > maxAgeMs;
      });
      if (unsafe) {
        for (const m of messages)
          report.skipped.push({ messageId: m.MessageId ?? 'unknown', eventId, reason: 'stale' });
        continue;
      }
      if (clock() - startedAt > budgetMs) {
        report.stoppedEarly = true;
        break;
      }
      const [first, ...duplicates] = [...messages].sort(
        (a, b) => (originalSentTimestampOf(a) ?? 0) - (originalSentTimestampOf(b) ?? 0),
      );
      const entry = (action: ResendAction, m: Message, newMessageId?: string): ResendRecord => ({
        action,
        eventId,
        dlqMessageId: m.MessageId ?? 'unknown',
        ...(newMessageId === undefined ? {} : { newMessageId }),
        originalSentTimestamp: originalSentTimestampOf(m) as number,
      });
      // The record is written first: a message that reaches the source queue always has a trace.
      try {
        options.record(entry('sending', first));
      } catch (error) {
        fail(first, 'record', error);
        break;
      }
      let newMessageId: string;
      try {
        newMessageId = await to.send(
          first.Body ?? '',
          sendableAttributes(first, originalSentTimestampOf(first) as number),
        );
      } catch (error) {
        fail(first, 'send', error);
        continue;
      }
      report.resent++;
      // Sent: no copy of this event may be handed back now. Each is deleted below, or stays hidden.
      for (const m of messages) handled.add(m.MessageId as string);
      try {
        options.record(entry('resent', first, newMessageId));
      } catch (error) {
        fail(first, 'record', error);
        break;
      }
      try {
        await dlq.delete(first);
      } catch (error) {
        fail(first, 'delete', error);
        try {
          options.record(entry('resent_delete_failed', first, newMessageId));
        } catch (recordError) {
          fail(first, 'record', recordError);
          break groups;
        }
        continue;
      }
      for (const duplicate of duplicates) {
        try {
          await dlq.delete(duplicate);
        } catch (error) {
          fail(duplicate, 'delete', error);
          continue;
        }
        report.duplicatesDeleted++;
        try {
          options.record(entry('duplicate_deleted', duplicate));
        } catch (error) {
          fail(duplicate, 'record', error);
          break groups;
        }
      }
    }
    if (chosen) for (const id of chosen) if (!known.has(id)) report.notFound.push(id);
  }

  for (const message of seen.values()) {
    if (handled.has(message.MessageId as string)) continue;
    try {
      await dlq.release(message);
    } catch (error) {
      fail(message, 'release', error);
    }
  }
  return report;
}

/** The port over a real source queue (AWS or ElasticMQ). The caller owns `client` and destroys it. */
export function awsSendPort(client: SQSClient, queueUrl: string): SendPort {
  return {
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

/** Reads the attributes the command checks. Throws when the queue does not exist or cannot be read. */
export function awsInspect(client: SQSClient): (queueUrl: string) => Promise<QueueInfo> {
  return async queueUrl => {
    const result = await client.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] }),
    );
    const a = result.Attributes ?? {};
    let deadLetterTargetArn: string | undefined;
    if (a.RedrivePolicy) {
      try {
        const policy = JSON.parse(a.RedrivePolicy) as { deadLetterTargetArn?: unknown };
        if (typeof policy.deadLetterTargetArn === 'string')
          deadLetterTargetArn = policy.deadLetterTargetArn;
      } catch {
        // A policy that does not parse proves nothing: the pair is then not checked.
      }
    }
    return {
      queued:
        Number(a.ApproximateNumberOfMessages ?? 0) +
        Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) +
        Number(a.ApproximateNumberOfMessagesDelayed ?? 0),
      ...(a.QueueArn === undefined ? {} : { arn: a.QueueArn }),
      ...(deadLetterTargetArn === undefined ? {} : { deadLetterTargetArn }),
    };
  };
}

// ── Command line ──────────────────────────────────────────────────────────────────────────────

export const USAGE = `Usage: npm run --silent dlq:resend -- --from-dlq <DLQ url> --to-queue <source queue url> \\
         --record-file <path> (--all | --event-id <uuid> [--event-id <uuid> ...]) [--endpoint-url <url>]

  --from-dlq <url>       the DLQ to take the messages from (required)
  --to-queue <url>       the queue they go back to (required; must be empty, and its RedrivePolicy,
                         if any, must point to the DLQ)
  --record-file <path>   new file: one JSON line per step, no body (required; an existing file is
                         refused, missing folders are created, not under ~ or inside a git tree)
  --all                  resend every valid message ... (only after the messages to skip were
                         dealt with and noted, runbook section 3c)
  --event-id <uuid>      ... or only the events you name (repeat the option)
  --endpoint-url <url>   SQS endpoint, for ElasticMQ (http://localhost:9324)

Never sends a message older than ${DEFAULT_MAX_AGE_DAYS} days (any copy of the event), without an eventId, or that the
consumers would refuse; those stay in the DLQ. Check the earlier record files first: an event is resent
once (runbook section 5).

Exit code: 0 every chosen message was sent, 1 something stays in the DLQ that blocks a redrive (an
old, invalid or id-less message; with --event-id only the chosen events count) or a chosen event id
was not found, 2 bad arguments, a queue that is not ready, an incomplete scan, or a failed step.`;

export interface ResendCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** For tests: ready ports instead of ones built from the arguments. */
  port?: DlqPort;
  sendPort?: SendPort;
  inspect?: (queueUrl: string) => Promise<QueueInfo>;
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
  try {
    assertSafeOutputPath(recordFile);
  } catch (error) {
    return fail(`dlq-resend failed: ${(error as Error).name}\n${(error as Error).message}`);
  }
  const select: 'all' | string[] =
    values.all === true ? 'all' : [...new Set(eventIds.map(id => id.toLowerCase()))];

  const client =
    io.port && io.sendPort && io.inspect
      ? undefined
      : new SQSClient({
          region: io.env.AWS_REGION ?? io.env.AWS_DEFAULT_REGION ?? 'us-east-1',
          ...(values['endpoint-url'] === undefined ? {} : { endpoint: values['endpoint-url'] }),
        });
  try {
    const dlq = io.port ?? awsDlqPort(client as SQSClient, fromDlq);
    const to = io.sendPort ?? awsSendPort(client as SQSClient, toQueue);
    const inspect = io.inspect ?? awsInspect(client as SQSClient);
    // Before anything is received (a receive hides the messages for 30 minutes): both queues exist, the
    // source queue is empty so a resent message is handled at once, and the pair is the right one.
    const destination = await inspect(toQueue);
    const source = await inspect(fromDlq);
    if (destination.queued !== 0)
      return fail('The destination queue is not empty: wait until it is drained, then run again');
    if (
      destination.deadLetterTargetArn !== undefined &&
      source.arn !== undefined &&
      destination.deadLetterTargetArn !== source.arn
    )
      return fail(
        'The destination queue dead-letters to another queue: wrong --from-dlq/--to-queue pair',
      );
    // Exclusive, and before the first receive: a name already used stops here.
    createExclusiveFile(recordFile);
    const report = await runDlqResend(dlq, to, {
      now: io.now(),
      select,
      record: entry =>
        appendLine(recordFile, JSON.stringify({ ...entry, at: new Date(io.now()).toISOString() })),
    });
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.complete || report.stoppedEarly || report.failed.length > 0) {
      io.stderr('The run did not finish cleanly: check the DLQ and the record file.\n');
      return 2;
    }
    const blocks = report.skipped.some(
      s =>
        s.reason === 'stale' ||
        s.reason === 'invalid_event' ||
        (s.reason === 'no_event_id' && select === 'all'),
    );
    return blocks || report.notFound.length > 0 ? 1 : 0;
  } catch (error) {
    io.stderr(`dlq-resend failed: ${errorName(error)}\n`);
    if (error instanceof FileExistsError) io.stderr(`${error.message}\n`);
    return 2;
  } finally {
    client?.destroy();
  }
}
