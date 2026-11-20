import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, MessageAttributeValue } from '@aws-sdk/client-sqs';
import { TRANSFER_SAMPLE } from '../../test/support/event-samples';
import type { DlqPort } from './dlq-age-check';
import {
  runDlqResend,
  runDlqResendCli,
  type QueueInfo,
  type ResendRecord,
  type SendPort,
} from './dlq-resend';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const A = '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362';
const B = '3a7d2b01-8e4c-4f69-8b25-d6c9f1e8a473';
const C = '4b8e3c12-9f5d-4a7a-9c36-e7dafaf9b584';

/** A body the consumers accept (`validateEvent`), with this `eventId`. */
const eventBody = (eventId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...TRANSFER_SAMPLE, eventId, ...extra });

interface Options {
  /** Days since the first send, taken from the attribute (a message that went through a dead-letter). */
  original?: number;
  /** Days since the first send, taken from the queue's own SentTimestamp (SQS moved it itself). */
  sent?: number;
  body?: string;
  attrs?: Record<string, MessageAttributeValue>;
  handle?: string;
}

function message(id: string, eventId: string | undefined, options: Options = {}): Message {
  const attrs: Record<string, MessageAttributeValue> = { ...options.attrs };
  if (options.original !== undefined)
    attrs.OriginalSentTimestamp = {
      DataType: 'Number',
      StringValue: String(NOW - options.original * DAY),
    };
  return {
    MessageId: id,
    ReceiptHandle: options.handle ?? `handle-${id}`,
    Body: options.body ?? eventBody(eventId as string),
    // The DLQ copy was sent just now: its own SentTimestamp says nothing unless nothing else exists.
    Attributes: {
      SentTimestamp: String(NOW - (options.sent === undefined ? 0 : options.sent * DAY) - 1000),
    },
    ...(Object.keys(attrs).length > 0 ? { MessageAttributes: attrs } : {}),
  };
}

/** `log` is shared with the fake source queue and the record so the tests can assert the order of steps. */
class FakeDlq implements DlqPort {
  readonly released: string[] = [];
  readonly deleted: string[] = [];
  readonly deletedHandles: string[] = [];
  deleteFails = new Set<string>();
  releaseFails = new Set<string>();
  receives = 0;
  private pending: Message[];
  constructor(
    readonly all: Message[],
    private readonly log: string[] = [],
    private readonly options: { neverDrains?: boolean; batch?: number } = {},
  ) {
    this.pending = [...all];
  }
  receive(): Promise<Message[]> {
    this.receives++;
    if (this.options.neverDrains) return Promise.resolve([this.all[0]]);
    return Promise.resolve(this.pending.splice(0, this.options.batch ?? 10));
  }
  visibleCount(): Promise<number> {
    return Promise.resolve(this.options.neverDrains ? 1 : this.pending.length);
  }
  delete(m: Message): Promise<void> {
    if (this.deleteFails.has(m.MessageId!)) return Promise.reject(new Error('delete failed'));
    this.log.push(`delete:${m.MessageId}`);
    this.deleted.push(m.MessageId!);
    this.deletedHandles.push(m.ReceiptHandle!);
    return Promise.resolve();
  }
  release(m: Message): Promise<void> {
    if (this.releaseFails.has(m.MessageId!)) return Promise.reject(new Error('release failed'));
    this.released.push(m.MessageId!);
    return Promise.resolve();
  }
}

class FakeSend implements SendPort {
  readonly sent: Array<{ body: string; attributes: Record<string, MessageAttributeValue> }> = [];
  /** Bodies whose send fails. */
  failBodies = new Set<string>();
  constructor(private readonly log: string[] = []) {}
  send(body: string, attributes: Record<string, MessageAttributeValue>): Promise<string> {
    if (this.failBodies.has(body))
      return Promise.reject(new Error('SECRET-URL http://sqs/000000000000/q'));
    if (Object.keys(attributes).length > 10)
      return Promise.reject(new Error('too many attributes'));
    this.sent.push({ body, attributes });
    this.log.push(`send:${this.sent.length}`);
    return Promise.resolve(`new-${this.sent.length}`);
  }
}

function setup(messages: Message[], dlqOptions: { neverDrains?: boolean; batch?: number } = {}) {
  const log: string[] = [];
  const dlq = new FakeDlq(messages, log, dlqOptions);
  const to = new FakeSend(log);
  const records: ResendRecord[] = [];
  return { log, dlq, to, records };
}

function options(
  s: { log: string[]; records: ResendRecord[] },
  select: 'all' | string[] = 'all',
  extra: Partial<Parameters<typeof runDlqResend>[2]> = {},
) {
  return {
    now: NOW,
    select,
    record: (entry: ResendRecord) => {
      s.log.push(`record:${entry.action}`);
      s.records.push(entry);
    },
    ...extra,
  };
}

describe('BL-372 dlq:resend (library)', () => {
  it('TC-BL-05 records, sends the body unchanged with every attribute, records, then deletes the DLQ copy', async () => {
    const s = setup([
      message('m1', A, {
        original: 2,
        attrs: {
          correlationId: { DataType: 'String', StringValue: 'corr-1' },
          eventType: { DataType: 'String', StringValue: 'TransferCompleted' },
        },
      }),
    ]);
    const report = await runDlqResend(s.dlq, s.to, options(s));
    expect(s.to.sent).toHaveLength(1);
    expect(s.to.sent[0].body).toBe(s.dlq.all[0].Body);
    expect(s.to.sent[0].attributes).toEqual({
      correlationId: { DataType: 'String', StringValue: 'corr-1' },
      eventType: { DataType: 'String', StringValue: 'TransferCompleted' },
      OriginalSentTimestamp: { DataType: 'Number', StringValue: String(NOW - 2 * DAY) },
    });
    expect(s.log).toEqual(['record:sending', 'send:1', 'record:resent', 'delete:m1']);
    expect(report).toMatchObject({ scanned: 1, resent: 1, duplicatesDeleted: 0, complete: true });
  });

  it('TC-BL-06 a message SQS moved itself carries no attribute: the age comes from SentTimestamp', async () => {
    const s = setup([message('m1', A, { sent: 3 })]);
    await runDlqResend(s.dlq, s.to, options(s));
    expect(s.to.sent[0].attributes.OriginalSentTimestamp.StringValue).toBe(
      String(NOW - 3 * DAY - 1000),
    );
  });

  it('TC-BL-07 the attribute that is older than the queue SentTimestamp wins', async () => {
    const s = setup([message('m1', A, { original: 4, sent: 1 })]);
    await runDlqResend(s.dlq, s.to, options(s));
    expect(s.to.sent[0].attributes.OriginalSentTimestamp.StringValue).toBe(String(NOW - 4 * DAY));
  });

  it('TC-BL-35 Number, Binary and custom attribute types go through with their values', async () => {
    const attrs = {
      n: { DataType: 'Number', StringValue: '42' },
      bin: { DataType: 'Binary', BinaryValue: new Uint8Array([1, 2]), StringListValues: [] },
      custom: { DataType: 'String.custom', StringValue: 'x' },
    } as Record<string, MessageAttributeValue>;
    const s = setup([message('m1', A, { original: 1, attrs })]);
    await runDlqResend(s.dlq, s.to, options(s));
    expect(s.to.sent[0].attributes.n).toEqual({ DataType: 'Number', StringValue: '42' });
    expect(s.to.sent[0].attributes.bin).toEqual({
      DataType: 'Binary',
      BinaryValue: new Uint8Array([1, 2]),
    });
    expect(s.to.sent[0].attributes.custom).toEqual({ DataType: 'String.custom', StringValue: 'x' });
  });

  it('TC-BL-08 a message 7 days old, with no send time, or with a malformed attribute is never sent or deleted', async () => {
    const noTime: Message = { MessageId: 'none', ReceiptHandle: 'h-none', Body: eventBody(B) };
    const badAttr: Message = {
      MessageId: 'bad',
      ReceiptHandle: 'h-bad',
      Body: eventBody(C),
      MessageAttributes: { OriginalSentTimestamp: { DataType: 'Number', StringValue: 'abc' } },
    };
    const s = setup([message('old', A, { original: 7 }), noTime, badAttr]);
    const report = await runDlqResend(s.dlq, s.to, options(s));
    expect(s.to.sent).toEqual([]);
    expect(s.dlq.deleted).toEqual([]);
    expect(s.dlq.released.sort()).toEqual(['bad', 'none', 'old']);
    expect(report.skipped.map(x => x.reason)).toEqual(['stale', 'stale', 'stale']);
  });

  it('TC-BL-21 one copy of an event older than 6 days blocks every copy of it', async () => {
    const s = setup([message('old', A, { original: 8 }), message('new', A, { original: 2 })]);
    const report = await runDlqResend(s.dlq, s.to, options(s));
    expect(s.to.sent).toEqual([]);
    expect(s.dlq.deleted).toEqual([]);
    expect(report.skipped.map(x => [x.messageId, x.reason]).sort()).toEqual([
      ['new', 'stale'],
      ['old', 'stale'],
    ]);
  });

  it('TC-BL-09 a body that is not JSON, or has no UUID eventId, is never sent or deleted', async () => {
    const s = setup([
      message('junk', undefined, { original: 1, body: '{not json' }),
      message('noid', undefined, { original: 1, body: JSON.stringify({ eventId: 'abc' }) }),
    ]);
    const report = await runDlqResend(s.dlq, s.to, options(s));
    expect(s.to.sent).toEqual([]);
    expect(s.dlq.deleted).toEqual([]);
    expect(report.skipped.map(x => [x.messageId, x.reason])).toEqual([
      ['junk', 'no_event_id'],
      ['noid', 'no_event_id'],
    ]);
  });

  it('TC-BL-28 an event the consumers would refuse (missing field, unknown type, upper-case UUID) is never sent', async () => {
    const missing = { ...TRANSFER_SAMPLE, eventId: A } as Record<string, unknown>;
    delete missing.amount;
    const s = setup([
      message('missing', A, { original: 1, body: JSON.stringify(missing) }),
      message('unknown', B, {
        original: 1,
        body: JSON.stringify({ ...TRANSFER_SAMPLE, eventId: B, eventType: 'Nope' }),
      }),
      message('upper', C, { original: 1, body: eventBody(C.toUpperCase()) }),
    ]);
    const report = await runDlqResend(s.dlq, s.to, options(s));
    expect(s.to.sent).toEqual([]);
    expect(s.dlq.deleted).toEqual([]);
    expect(report.skipped.map(x => [x.messageId, x.reason])).toEqual([
      ['missing', 'invalid_event'],
      ['unknown', 'invalid_event'],
      ['upper', 'invalid_event'],
    ]);
  });

  it('TC-BL-10 three copies of one event: the earliest first send is sent, then all three leave the DLQ', async () => {
    const s = setup([
      message('late', A, { original: 1 }),
      message('first', A, { original: 3 }),
      message('mid', A, { original: 2 }),
    ]);
    const report = await runDlqResend(s.dlq, s.to, options(s));
    expect(s.to.sent).toHaveLength(1);
    expect(s.to.sent[0].attributes.OriginalSentTimestamp.StringValue).toBe(String(NOW - 3 * DAY));
    expect(s.log.slice(0, 4)).toEqual([
      'record:sending',
      'send:1',
      'record:resent',
      'delete:first',
    ]);
    expect([...s.dlq.deleted].sort()).toEqual(['first', 'late', 'mid']);
    expect(report).toMatchObject({ resent: 1, duplicatesDeleted: 2 });
    expect(s.records.map(r => r.action)).toEqual([
      'sending',
      'resent',
      'duplicate_deleted',
      'duplicate_deleted',
    ]);
  });

  it('TC-BL-11 a failed send deletes none of the three copies and hands them all back; other events still go', async () => {
    const s = setup([
      message('x1', A, { original: 1 }),
      message('x2', A, { original: 2 }),
      message('x3', A, { original: 3 }),
      message('y', B, { original: 1 }),
    ]);
    s.to.failBodies.add(s.dlq.all[0].Body!);
    const report = await runDlqResend(s.dlq, s.to, options(s));
    expect(s.dlq.deleted).toEqual(['y']);
    expect(s.dlq.released.sort()).toEqual(['x1', 'x2', 'x3']);
    expect(report.resent).toBe(1);
    expect(report.failed).toEqual([{ messageId: 'x3', eventId: A, step: 'send', error: 'Error' }]);
    expect(JSON.stringify(report)).not.toContain('SECRET-URL');
  });

  it('TC-BL-12 a delete that fails after the send is recorded; neither it nor its duplicate is handed back', async () => {
    const s = setup([message('m1', A, { original: 2 }), message('dup', A, { original: 1 })]);
    s.dlq.deleteFails.add('m1');
    const report = await runDlqResend(s.dlq, s.to, options(s));
    expect(s.to.sent).toHaveLength(1);
    expect(report.failed).toEqual([
      { messageId: 'm1', eventId: A, step: 'delete', error: 'Error' },
    ]);
    expect(s.records.map(r => r.action)).toEqual(['sending', 'resent', 'resent_delete_failed']);
    // Hidden until the scan visibility ends: a quick rerun must not see either copy.
    expect(s.dlq.released).toEqual([]);
    expect(s.dlq.deleted).toEqual([]);
  });

  it('TC-BL-37 a duplicate that cannot be deleted stays hidden, is reported, and the others are deleted', async () => {
    const s = setup([
      message('m1', A, { original: 3 }),
      message('d1', A, { original: 2 }),
      message('d2', A, { original: 1 }),
    ]);
    s.dlq.deleteFails.add('d1');
    const report = await runDlqResend(s.dlq, s.to, options(s));
    expect(s.dlq.deleted.sort()).toEqual(['d2', 'm1']);
    expect(s.dlq.released).toEqual([]);
    expect(report.failed).toEqual([
      { messageId: 'd1', eventId: A, step: 'delete', error: 'Error' },
    ]);
  });

  it('TC-BL-29 a record that cannot be written stops the run: no send after a failed `sending`, no release after a sent message', async () => {
    // Fails on the `sending` line of the second event.
    const first = setup([
      message('a', A, { original: 1 }),
      message('b', B, { original: 1 }),
      message('c', C, { original: 1 }),
    ]);
    let writes = 0;
    const report1 = await runDlqResend(first.dlq, first.to, {
      ...options(first),
      record: entry => {
        if (++writes === 3) throw new Error('disk full'); // a:sending, a:resent, b:sending
        first.records.push(entry);
      },
    });
    expect(first.to.sent).toHaveLength(1); // only A was sent
    expect(first.dlq.deleted).toEqual(['a']);
    expect(first.dlq.released.sort()).toEqual(['b', 'c']);
    expect(report1.failed).toEqual([
      { messageId: 'b', eventId: B, step: 'record', error: 'Error' },
    ]);

    // Fails on the `resent` line: the message is already in the source queue, so it is not handed back.
    const second = setup([message('a', A, { original: 2 }), message('dup', A, { original: 1 })]);
    let writes2 = 0;
    const report2 = await runDlqResend(second.dlq, second.to, {
      ...options(second),
      record: () => {
        if (++writes2 === 2) throw new Error('disk full');
      },
    });
    expect(second.to.sent).toHaveLength(1);
    expect(second.dlq.released).toEqual([]);
    expect(second.dlq.deleted).toEqual([]);
    expect(report2.failed.map(f => f.step)).toEqual(['record']);
  });

  it('TC-BL-13 --event-id sends only the chosen event; the other stays, an unknown id is reported', async () => {
    const s = setup([message('m1', A, { original: 1 }), message('m2', B, { original: 1 })]);
    const report = await runDlqResend(s.dlq, s.to, options(s, [A, C]));
    expect(s.to.sent).toHaveLength(1);
    expect(s.dlq.deleted).toEqual(['m1']);
    expect(s.dlq.released).toEqual(['m2']);
    expect(report.skipped).toEqual([{ messageId: 'm2', eventId: B, reason: 'not_selected' }]);
    expect(report.notFound).toEqual([C]);
  });

  it('TC-BL-23 an upper-case or repeated --event-id selects the same message once', async () => {
    const s = setup([message('m1', A, { original: 1 })]);
    const report = await runDlqResend(s.dlq, s.to, options(s, [A.toUpperCase(), A]));
    expect(s.to.sent).toHaveLength(1);
    expect(report.notFound).toEqual([]);
  });

  it('TC-BL-30 a message received twice with different handles is sent once and deleted with the newest handle', async () => {
    const s = setup(
      [
        message('m1', A, { original: 1, handle: 'h-old' }),
        message('m1', A, { original: 1, handle: 'h-new' }),
      ],
      { batch: 1 },
    );
    const report = await runDlqResend(s.dlq, s.to, options(s));
    expect(report.scanned).toBe(1);
    expect(s.to.sent).toHaveLength(1);
    expect(s.dlq.deletedHandles).toEqual(['h-new']);
  });

  it('TC-BL-14 a queue that never drains sends nothing and hands back what it saw', async () => {
    const s = setup([message('m1', A, { original: 1 })], { neverDrains: true });
    const report = await runDlqResend(s.dlq, s.to, { ...options(s), maxRounds: 3 });
    expect(report.complete).toBe(false);
    expect(s.to.sent).toEqual([]);
    expect(s.dlq.deleted).toEqual([]);
    expect(s.dlq.released).toEqual(['m1']);
  });

  it('TC-BL-32 a message that cannot be handed back is reported with its step', async () => {
    const s = setup([message('m1', A, { original: 1 }), message('m2', B, { original: 1 })]);
    s.dlq.releaseFails.add('m2');
    const report = await runDlqResend(s.dlq, s.to, options(s, [A]));
    expect(report.failed).toEqual([
      { messageId: 'm2', eventId: B, step: 'release', error: 'Error' },
    ]);
  });

  it('TC-BL-33 past the time budget the run stops sending and hands the rest back', async () => {
    const s = setup([message('m1', A, { original: 1 }), message('m2', B, { original: 1 })]);
    let calls = 0;
    const report = await runDlqResend(
      s.dlq,
      s.to,
      options(s, 'all', { clock: () => (calls++ < 2 ? 0 : 2_000_000) }),
    );
    expect(s.to.sent).toHaveLength(1);
    expect(s.dlq.released).toEqual(['m2']);
    expect(report.stoppedEarly).toBe(true);
  });

  it('TC-BL-22 ten attributes pass, eleven are refused by the queue and the DLQ copy stays', async () => {
    const custom = (n: number) => {
      const out: Record<string, MessageAttributeValue> = {};
      for (let i = 0; i < n; i++) out[`a${i}`] = { DataType: 'String', StringValue: String(i) };
      return out;
    };
    const ok = setup([message('ok', A, { original: 1, attrs: custom(9) })]);
    await runDlqResend(ok.dlq, ok.to, options(ok));
    expect(Object.keys(ok.to.sent[0].attributes)).toHaveLength(10);

    const many = setup([message('many', B, { original: 1, attrs: custom(10) })]);
    const report = await runDlqResend(many.dlq, many.to, options(many));
    expect(report.failed).toEqual([
      { messageId: 'many', eventId: B, step: 'send', error: 'Error' },
    ]);
    expect(many.dlq.deleted).toEqual([]);
  });
});

describe('BL-372 dlq:resend (command)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bl372-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const FROM = 'http://sqs/000000000000/q-dlq';
  const TO = 'http://sqs/000000000000/q';
  const urls = ['--from-dlq', FROM, '--to-queue', TO];
  const infoOf =
    (overrides: Record<string, Partial<QueueInfo> | 'missing'> = {}) =>
    (url: string): Promise<QueueInfo> => {
      const override = overrides[url];
      if (override === 'missing') return Promise.reject(new Error('NonExistentQueue'));
      const base: QueueInfo =
        url === TO
          ? { queued: 0, arn: 'arn:to', deadLetterTargetArn: 'arn:dlq' }
          : { queued: 5, arn: 'arn:dlq' };
      return Promise.resolve({ ...base, ...override });
    };

  function run(
    argv: string[],
    s: { dlq: FakeDlq; to: FakeSend },
    inspect: (url: string) => Promise<QueueInfo> = infoOf(),
  ) {
    const out: string[] = [];
    const err: string[] = [];
    return runDlqResendCli(argv, {
      stdout: t => out.push(t),
      stderr: t => err.push(t),
      env: {},
      now: () => NOW,
      port: s.dlq,
      sendPort: s.to,
      inspect,
    }).then(code => ({ code, out: out.join(''), err: err.join('') }));
  }

  it('TC-BL-15 bad arguments exit 2 before any receive, send or delete', async () => {
    const record = join(dir, 'r.jsonl');
    const bad: string[][] = [
      [],
      [...urls],
      [...urls, '--record-file', record],
      [...urls, '--record-file', record, '--all', '--event-id', A],
      [...urls, '--record-file', record, '--event-id', 'not-a-uuid'],
      ['--from-dlq', TO, '--to-queue', `${TO}/`, '--record-file', record, '--all'],
      [...urls, '--record-file', '~/dbs-ops/r.jsonl', '--all'],
      [...urls, '--record-file', 'relative-in-repo.jsonl', '--all'],
      [...urls, '--record-file', record, '--all', '--max-age-days', '3'],
    ];
    for (const argv of bad) {
      const s = setup([message('m1', A, { original: 1 })]);
      const result = await run(argv, s);
      expect(result.code).toBe(2);
      expect(s.dlq.receives).toBe(0);
      expect(s.to.sent).toEqual([]);
      expect(s.dlq.deleted).toEqual([]);
    }
    expect(existsSync(record)).toBe(false);
    expect(existsSync('relative-in-repo.jsonl')).toBe(false);
  });

  it('TC-BL-31 a record file that already exists exits 2 before the DLQ is touched and is not changed', async () => {
    const record = join(dir, 'r.jsonl');
    writeFileSync(record, 'earlier\n');
    const s = setup([message('m1', A, { original: 1 })]);
    const result = await run([...urls, '--record-file', record, '--all'], s);
    expect(result.code).toBe(2);
    expect(s.dlq.receives).toBe(0);
    expect(readFileSync(record, 'utf8')).toBe('earlier\n');
    expect(result.err).toContain('FileExistsError');
  });

  it('TC-BL-26 a destination queue that still holds messages exits 2 and leaves the DLQ and the file alone', async () => {
    const record = join(dir, 'r.jsonl');
    const s = setup([message('m1', A, { original: 1 })]);
    const result = await run(
      [...urls, '--record-file', record, '--all'],
      s,
      infoOf({ [TO]: { queued: 1 } }),
    );
    expect(result.code).toBe(2);
    expect(s.dlq.receives).toBe(0);
    expect(existsSync(record)).toBe(false);
  });

  it('TC-BL-27 a missing queue or a destination whose RedrivePolicy points to another DLQ exits 2; no policy goes on', async () => {
    const record = join(dir, 'r.jsonl');
    for (const info of [
      infoOf({ [TO]: 'missing' }),
      infoOf({ [FROM]: 'missing' }),
      infoOf({ [TO]: { deadLetterTargetArn: 'arn:other-dlq' } }),
    ]) {
      const s = setup([message('m1', A, { original: 1 })]);
      const result = await run([...urls, '--record-file', record, '--all'], s, info);
      expect(result.code).toBe(2);
      expect(s.dlq.receives).toBe(0);
      expect(existsSync(record)).toBe(false);
    }
    const s = setup([message('m1', A, { original: 1 })]);
    const noPolicy = await run(
      [...urls, '--record-file', record, '--all'],
      s,
      infoOf({ [TO]: { deadLetterTargetArn: undefined } }),
    );
    expect(noPolicy.code).toBe(0);
    expect(s.to.sent).toHaveLength(1);
  });

  it('TC-BL-16 the report, stderr and record file carry no body, receipt handle or error text', async () => {
    const record = join(dir, 'sub', 'r.jsonl');
    const marked = (id: string) => eventBody(id, { note: 'BODY-MARKER' });
    const s = setup([
      message('m1', A, { original: 2, body: marked(A) }),
      message('m2', A, { original: 3, body: marked(A) }),
      message('old', B, { original: 9, body: marked(B) }),
      message('boom', C, { original: 1, body: marked(C) }),
    ]);
    s.to.failBodies.add(marked(C));
    const result = await run([...urls, '--record-file', record, '--all'], s);
    const file = readFileSync(record, 'utf8');
    for (const text of [result.out, result.err, file]) {
      expect(text).not.toContain('BODY-MARKER');
      expect(text).not.toContain('handle-');
      expect(text).not.toContain('SECRET-URL');
    }
    const lines = file
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map(l => l.action)).toEqual(['sending', 'resent', 'duplicate_deleted', 'sending']);
    expect(lines[1]).toMatchObject({
      eventId: A,
      dlqMessageId: 'm2',
      newMessageId: 'new-1',
      originalSentTimestamp: NOW - 3 * DAY,
      at: expect.stringMatching(/^2026-11-20T/),
    });
    expect(JSON.parse(result.out)).toMatchObject({
      scanned: 4,
      resent: 1,
      duplicatesDeleted: 1,
      complete: true,
      stoppedEarly: false,
      failed: [{ messageId: 'boom', step: 'send', error: 'Error' }],
    });
    expect(result.code).toBe(2);
  });

  it('TC-BL-34 exit 0 when everything chosen went, 1 when something stays, 2 when something failed', async () => {
    const recordIn = (name: string) => join(dir, name);
    const ok = setup([message('m1', A, { original: 1 })]);
    expect((await run([...urls, '--record-file', recordIn('a'), '--all'], ok)).code).toBe(0);

    // With --event-id only the chosen events count: a junk message in the DLQ is not theirs.
    const chosen = setup([
      message('m1', A, { original: 1 }),
      message('junk', undefined, { body: '{x' }),
    ]);
    expect(
      (await run([...urls, '--record-file', recordIn('b'), '--event-id', A], chosen)).code,
    ).toBe(0);

    // With --all the junk message stays: do not redrive blindly.
    const all = setup([
      message('m1', A, { original: 1 }),
      message('junk', undefined, { body: '{x' }),
    ]);
    expect((await run([...urls, '--record-file', recordIn('c'), '--all'], all)).code).toBe(1);

    const missing = setup([message('m1', A, { original: 1 })]);
    expect(
      (await run([...urls, '--record-file', recordIn('d'), '--event-id', C], missing)).code,
    ).toBe(1);

    // A chosen event that is too old stays: 1.
    const stale = setup([message('old', A, { original: 8 }), message('m2', B, { original: 1 })]);
    expect(
      (await run([...urls, '--record-file', recordIn('e'), '--event-id', A], stale)).code,
    ).toBe(1);

    const failing = setup([message('m1', A, { original: 1 })]);
    failing.to.failBodies.add(failing.dlq.all[0].Body!);
    expect((await run([...urls, '--record-file', recordIn('f'), '--all'], failing)).code).toBe(2);
    expect(failing.dlq.deleted).toEqual([]);
  });
});
