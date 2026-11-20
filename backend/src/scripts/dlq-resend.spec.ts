import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, MessageAttributeValue } from '@aws-sdk/client-sqs';
import type { DlqPort } from './dlq-age-check';
import { runDlqResend, runDlqResendCli, type ResendRecord, type SendPort } from './dlq-resend';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const A = '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362';
const B = '3a7d2b01-8e4c-4f69-8b25-d6c9f1e8a473';
const C = '4b8e3c12-9f5d-4a7a-9c36-e7dafaf9b584';

interface Options {
  /** Days since the first send, taken from the attribute (a message that went through a dead-letter). */
  original?: number;
  /** Days since the first send, taken from the queue's own SentTimestamp (SQS moved it itself). */
  sent?: number;
  body?: string;
  attrs?: Record<string, MessageAttributeValue>;
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
    ReceiptHandle: `handle-${id}`,
    Body: options.body ?? JSON.stringify({ eventId, amount: '500000' }),
    // The DLQ copy was sent just now: its own SentTimestamp says nothing unless nothing else exists.
    ...(options.sent !== undefined
      ? { Attributes: { SentTimestamp: String(NOW - options.sent * DAY) } }
      : { Attributes: { SentTimestamp: String(NOW - 1000) } }),
    ...(Object.keys(attrs).length > 0 ? { MessageAttributes: attrs } : {}),
  };
}

/** `log` is shared with the fake source queue so the tests can assert the order of send and delete. */
class FakeDlq implements DlqPort {
  readonly released: string[] = [];
  readonly deleted: string[] = [];
  deleteFails = new Set<string>();
  receives = 0;
  private pending: Message[];
  constructor(
    readonly all: Message[],
    private readonly log: string[] = [],
    private readonly neverDrains = false,
  ) {
    this.pending = [...all];
  }
  receive(): Promise<Message[]> {
    this.receives++;
    if (this.neverDrains) return Promise.resolve([this.all[0]]);
    return Promise.resolve(this.pending.splice(0, 10));
  }
  visibleCount(): Promise<number> {
    return Promise.resolve(this.neverDrains ? 1 : this.pending.length);
  }
  delete(m: Message): Promise<void> {
    if (this.deleteFails.has(m.MessageId!)) return Promise.reject(new Error('delete failed'));
    this.log.push(`delete:${m.MessageId}`);
    this.deleted.push(m.MessageId!);
    return Promise.resolve();
  }
  release(m: Message): Promise<void> {
    this.released.push(m.MessageId!);
    return Promise.resolve();
  }
}

class FakeSend implements SendPort {
  readonly sent: Array<{ body: string; attributes: Record<string, MessageAttributeValue> }> = [];
  /** Bodies whose send fails. */
  failBodies = new Set<string>();
  verified = 0;
  verifyFails = false;
  constructor(private readonly log: string[] = []) {}
  verify(): Promise<void> {
    this.verified++;
    return this.verifyFails ? Promise.reject(new Error('no such queue')) : Promise.resolve();
  }
  send(body: string, attributes: Record<string, MessageAttributeValue>): Promise<string> {
    if (this.failBodies.has(body)) return Promise.reject(new Error('send failed'));
    if (Object.keys(attributes).length > 10)
      return Promise.reject(new Error('too many attributes'));
    this.sent.push({ body, attributes });
    this.log.push(`send:${this.sent.length}`);
    return Promise.resolve(`new-${this.sent.length}`);
  }
}

function setup(messages: Message[]) {
  const log: string[] = [];
  const dlq = new FakeDlq(messages, log);
  const to = new FakeSend(log);
  const records: ResendRecord[] = [];
  return { log, dlq, to, records };
}

const baseOptions = (records: ResendRecord[], select: 'all' | string[] = 'all') => ({
  now: NOW,
  select,
  record: (entry: ResendRecord) => records.push(entry),
});

describe('BL-372 dlq:resend (library)', () => {
  it('TC-BL-05 sends the body unchanged with every attribute, then deletes the DLQ copy', async () => {
    const { log, dlq, to, records } = setup([
      message('m1', A, {
        original: 2,
        attrs: {
          correlationId: { DataType: 'String', StringValue: 'corr-1' },
          eventType: { DataType: 'String', StringValue: 'TransferCompleted' },
        },
      }),
    ]);
    const report = await runDlqResend(dlq, to, baseOptions(records));
    expect(to.sent).toHaveLength(1);
    expect(to.sent[0].body).toBe(dlq.all[0].Body);
    expect(to.sent[0].attributes).toEqual({
      correlationId: { DataType: 'String', StringValue: 'corr-1' },
      eventType: { DataType: 'String', StringValue: 'TransferCompleted' },
      OriginalSentTimestamp: { DataType: 'Number', StringValue: String(NOW - 2 * DAY) },
    });
    expect(log).toEqual(['send:1', 'delete:m1']);
    expect(report).toMatchObject({ scanned: 1, resent: 1, duplicatesDeleted: 0, complete: true });
  });

  it('TC-BL-06 a message SQS moved itself carries no attribute: the age comes from SentTimestamp', async () => {
    const { dlq, to, records } = setup([message('m1', A, { sent: 3 })]);
    await runDlqResend(dlq, to, baseOptions(records));
    expect(to.sent[0].attributes.OriginalSentTimestamp).toEqual({
      DataType: 'Number',
      StringValue: String(NOW - 3 * DAY),
    });
  });

  it('TC-BL-07 the attribute that is older than the queue SentTimestamp wins', async () => {
    const { dlq, to, records } = setup([message('m1', A, { original: 4, sent: 1 })]);
    await runDlqResend(dlq, to, baseOptions(records));
    expect(to.sent[0].attributes.OriginalSentTimestamp.StringValue).toBe(String(NOW - 4 * DAY));
  });

  it('TC-BL-08 a message first sent 7 days ago, or with no send time, is never sent or deleted', async () => {
    const noTime: Message = {
      MessageId: 'none',
      ReceiptHandle: 'handle-none',
      Body: JSON.stringify({ eventId: B }),
    };
    const { dlq, to, records } = setup([message('old', A, { original: 7 }), noTime]);
    const report = await runDlqResend(dlq, to, baseOptions(records));
    expect(to.sent).toEqual([]);
    expect(dlq.deleted).toEqual([]);
    expect(dlq.released.sort()).toEqual(['none', 'old']);
    expect(report.skipped).toEqual([
      { messageId: 'old', eventId: A, reason: 'stale' },
      { messageId: 'none', eventId: B, reason: 'stale' },
    ]);
  });

  it('TC-BL-09 a body that is not JSON or has no UUID eventId is never sent or deleted', async () => {
    const { dlq, to, records } = setup([
      message('junk', undefined, { original: 1, body: '{not json' }),
      message('noid', undefined, { original: 1, body: JSON.stringify({ eventId: 'abc' }) }),
    ]);
    const report = await runDlqResend(dlq, to, baseOptions(records));
    expect(to.sent).toEqual([]);
    expect(dlq.deleted).toEqual([]);
    expect(report.skipped.map(s => [s.messageId, s.reason])).toEqual([
      ['junk', 'no_event_id'],
      ['noid', 'no_event_id'],
    ]);
  });

  it('TC-BL-10 three copies of one event: the earliest first send is sent, all three leave the DLQ', async () => {
    const { log, dlq, to, records } = setup([
      message('late', A, { original: 1 }),
      message('first', A, { original: 3 }),
      message('mid', A, { original: 2 }),
    ]);
    const report = await runDlqResend(dlq, to, baseOptions(records));
    expect(to.sent).toHaveLength(1);
    expect(to.sent[0].attributes.OriginalSentTimestamp.StringValue).toBe(String(NOW - 3 * DAY));
    expect(log[0]).toBe('send:1');
    expect([...dlq.deleted].sort()).toEqual(['first', 'late', 'mid']);
    expect(log.indexOf('delete:first')).toBeLessThan(log.indexOf('delete:late'));
    expect(report).toMatchObject({ resent: 1, duplicatesDeleted: 2 });
    expect(records.map(r => r.action)).toEqual([
      'resent',
      'duplicate_deleted',
      'duplicate_deleted',
    ]);
  });

  it('TC-BL-11 a failed send keeps that DLQ copy and the others are still sent', async () => {
    const { dlq, to, records } = setup([
      message('m1', A, { original: 1 }),
      message('m2', B, { original: 1 }),
    ]);
    to.failBodies.add(dlq.all[0].Body!);
    const report = await runDlqResend(dlq, to, baseOptions(records));
    expect(dlq.deleted).toEqual(['m2']);
    expect(dlq.released).toContain('m1');
    expect(report).toMatchObject({ resent: 1, failed: ['m1'] });
  });

  it('TC-BL-12 a delete that fails after the send is recorded and reported', async () => {
    const { dlq, to, records } = setup([message('m1', A, { original: 1 })]);
    dlq.deleteFails.add('m1');
    const report = await runDlqResend(dlq, to, baseOptions(records));
    expect(to.sent).toHaveLength(1);
    expect(report.failed).toEqual(['m1']);
    expect(records).toEqual([
      expect.objectContaining({ action: 'resent', eventId: A, dlqMessageId: 'm1' }),
      expect.objectContaining({ action: 'resent_delete_failed', eventId: A, dlqMessageId: 'm1' }),
    ]);
    // Not handed back: it stays hidden until the scan visibility ends, so a quick rerun cannot resend it.
    expect(dlq.released).not.toContain('m1');
  });

  it('TC-BL-13 --event-id sends only the chosen event; the other stays, an unknown id is reported', async () => {
    const { dlq, to, records } = setup([
      message('m1', A, { original: 1 }),
      message('m2', B, { original: 1 }),
    ]);
    const report = await runDlqResend(dlq, to, baseOptions(records, [A, C]));
    expect(to.sent).toHaveLength(1);
    expect(dlq.deleted).toEqual(['m1']);
    expect(dlq.released).toEqual(['m2']);
    expect(report.skipped).toEqual([{ messageId: 'm2', eventId: B, reason: 'not_selected' }]);
    expect(report.notFound).toEqual([C]);
  });

  it('TC-BL-14 a queue that never drains sends nothing and hands back what it saw', async () => {
    const log: string[] = [];
    const dlq = new FakeDlq([message('m1', A, { original: 1 })], log, true);
    const to = new FakeSend(log);
    const report = await runDlqResend(dlq, to, { ...baseOptions([]), maxRounds: 3 });
    expect(report.complete).toBe(false);
    expect(to.sent).toEqual([]);
    expect(dlq.deleted).toEqual([]);
    expect(dlq.released).toEqual(['m1']);
  });

  it('TC-BL-21 one copy of an event older than 6 days blocks every copy of it', async () => {
    const { dlq, to, records } = setup([
      message('old', A, { original: 8 }),
      message('new', A, { original: 2 }),
    ]);
    const report = await runDlqResend(dlq, to, baseOptions(records));
    expect(to.sent).toEqual([]);
    expect(dlq.deleted).toEqual([]);
    expect(report.skipped.map(s => [s.messageId, s.reason]).sort()).toEqual([
      ['new', 'stale'],
      ['old', 'stale'],
    ]);
  });

  it('TC-BL-22 only DataType, StringValue and BinaryValue are copied; ten attributes pass, eleven are refused', async () => {
    const custom = (n: number) => {
      const out: Record<string, MessageAttributeValue> = {};
      for (let i = 0; i < n; i++) out[`a${i}`] = { DataType: 'String', StringValue: String(i) };
      return out;
    };
    // 8 plain + 1 binary (with an empty list the SDK may return) + the existing OriginalSentTimestamp = 10.
    const attrs = {
      ...custom(8),
      bin: { DataType: 'Binary', BinaryValue: new Uint8Array([1, 2]), StringListValues: [] },
    } as Record<string, MessageAttributeValue>;
    const ok = setup([message('ok', A, { original: 1, attrs })]);
    const okReport = await runDlqResend(ok.dlq, ok.to, baseOptions(ok.records));
    const sent = ok.to.sent[0].attributes;
    expect(Object.keys(sent)).toHaveLength(10);
    expect(sent.bin).toEqual({ DataType: 'Binary', BinaryValue: new Uint8Array([1, 2]) });
    expect(sent.OriginalSentTimestamp.StringValue).toBe(String(NOW - DAY));
    expect(okReport.failed).toEqual([]);

    // 10 plain + OriginalSentTimestamp = 11: SQS refuses, the DLQ copy stays.
    const tooMany = setup([message('many', B, { original: 1, attrs: custom(10) })]);
    const report = await runDlqResend(tooMany.dlq, tooMany.to, baseOptions(tooMany.records));
    expect(report.failed).toEqual(['many']);
    expect(tooMany.dlq.deleted).toEqual([]);
  });

  it('TC-BL-23 an upper-case or repeated --event-id selects the same message once', async () => {
    const { dlq, to, records } = setup([message('m1', A, { original: 1 })]);
    const report = await runDlqResend(dlq, to, baseOptions(records, [A.toUpperCase(), A]));
    expect(to.sent).toHaveLength(1);
    expect(report.notFound).toEqual([]);
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

  const urls = ['--from-dlq', 'http://sqs/q-dlq', '--to-queue', 'http://sqs/q'];

  function run(argv: string[], dlq: FakeDlq, to: FakeSend) {
    const out: string[] = [];
    const err: string[] = [];
    return runDlqResendCli(argv, {
      stdout: t => out.push(t),
      stderr: t => err.push(t),
      env: {},
      now: () => NOW,
      port: dlq,
      sendPort: to,
    }).then(code => ({ code, out: out.join(''), err: err.join('') }));
  }

  it('TC-BL-15 bad arguments exit 2 before any receive, send or delete', async () => {
    const record = join(dir, 'r.jsonl');
    const existing = join(dir, 'existing.jsonl');
    writeExisting(existing);
    const bad: string[][] = [
      [],
      [...urls],
      [...urls, '--record-file', record],
      [...urls, '--record-file', record, '--all', '--event-id', A],
      [...urls, '--record-file', record, '--event-id', 'not-a-uuid'],
      [
        '--from-dlq',
        'http://sqs/same',
        '--to-queue',
        'http://sqs/same',
        '--record-file',
        record,
        '--all',
      ],
      [...urls, '--record-file', existing, '--all'],
      [...urls, '--record-file', record, '--all', '--max-age-days', '3'],
    ];
    for (const argv of bad) {
      const { dlq, to } = setup([message('m1', A, { original: 1 })]);
      const result = await run(argv, dlq, to);
      expect(result.code).toBe(2);
      expect(dlq.receives).toBe(0);
      expect(to.sent).toEqual([]);
      expect(dlq.deleted).toEqual([]);
    }
    expect(existsSync(record)).toBe(false);
  });

  it('TC-BL-15b a destination queue that does not exist exits 2 before the DLQ is touched and creates no file', async () => {
    const record = join(dir, 'r.jsonl');
    const { dlq, to } = setup([message('m1', A, { original: 1 })]);
    to.verifyFails = true;
    const result = await run([...urls, '--record-file', record, '--all'], dlq, to);
    expect(result.code).toBe(2);
    expect(dlq.receives).toBe(0);
    expect(existsSync(record)).toBe(false);
  });

  it('TC-BL-16 the report and the record file carry no body and no receipt handle', async () => {
    const record = join(dir, 'sub', 'r.jsonl');
    const { dlq, to } = setup([
      message('m1', A, {
        original: 2,
        body: JSON.stringify({ eventId: A, secret: 'BODY-MARKER' }),
      }),
      message('m2', A, {
        original: 3,
        body: JSON.stringify({ eventId: A, secret: 'BODY-MARKER' }),
      }),
      message('old', B, {
        original: 9,
        body: JSON.stringify({ eventId: B, secret: 'BODY-MARKER' }),
      }),
    ]);
    const result = await run([...urls, '--record-file', record, '--all'], dlq, to);
    const file = readFileSync(record, 'utf8');
    for (const text of [result.out, result.err, file]) {
      expect(text).not.toContain('BODY-MARKER');
      expect(text).not.toContain('handle-');
    }
    const lines = file
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map(l => l.action)).toEqual(['resent', 'duplicate_deleted']);
    expect(lines[0]).toMatchObject({
      eventId: A,
      dlqMessageId: 'm2',
      newMessageId: 'new-1',
      originalSentTimestamp: NOW - 3 * DAY,
      at: expect.stringMatching(/^2026-11-20T/),
    });
    expect(JSON.parse(result.out)).toMatchObject({
      scanned: 3,
      resent: 1,
      duplicatesDeleted: 1,
      complete: true,
      skipped: [{ messageId: 'old', eventId: B, reason: 'stale' }],
    });
    expect(result.code).toBe(1);
  });

  it('TC-BL-16b exit 0 when everything chosen was sent, 2 when a send failed', async () => {
    const ok = setup([message('m1', A, { original: 1 })]);
    const okResult = await run(
      [...urls, '--record-file', join(dir, 'ok.jsonl'), '--all'],
      ok.dlq,
      ok.to,
    );
    expect(okResult.code).toBe(0);

    const bad = setup([message('m1', A, { original: 1 })]);
    bad.to.failBodies.add(bad.dlq.all[0].Body!);
    const badResult = await run(
      [...urls, '--record-file', join(dir, 'bad.jsonl'), '--all'],
      bad.dlq,
      bad.to,
    );
    expect(badResult.code).toBe(2);
    expect(bad.dlq.deleted).toEqual([]);
  });
});

function writeExisting(path: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:fs') as typeof import('node:fs')).writeFileSync(path, 'earlier\n');
}
