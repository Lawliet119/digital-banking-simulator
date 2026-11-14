import type { Message } from '@aws-sdk/client-sqs';
import {
  ageOf,
  DEFAULT_MAX_AGE_DAYS,
  runDlqAgeCheck,
  runDlqAgeCheckCli,
  type DlqPort,
} from './dlq-age-check';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const EVENT_ID = '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362';

/** A DLQ message first sent `days` ago; `original` puts that time in the attribute, else in SentTimestamp. */
function message(
  id: string,
  days: number | undefined,
  options: { original?: boolean; body?: string } = {},
): Message {
  const sent = days === undefined ? undefined : String(NOW - days * DAY);
  return {
    MessageId: id,
    ReceiptHandle: `handle-${id}`,
    Body: options.body ?? JSON.stringify({ eventId: EVENT_ID, amount: '500000' }),
    ...(sent !== undefined && !options.original ? { Attributes: { SentTimestamp: sent } } : {}),
    ...(sent !== undefined && options.original
      ? {
          // The DLQ copy was sent just now: its own SentTimestamp says nothing about the age.
          Attributes: { SentTimestamp: String(NOW - 1000) },
          MessageAttributes: { OriginalSentTimestamp: { DataType: 'Number', StringValue: sent } },
        }
      : {}),
  };
}

/** A queue that hands each message out once per receive until all were seen, in batches of `batch`. */
class FakeDlq implements DlqPort {
  readonly deleted: string[] = [];
  readonly released: string[] = [];
  private pending: Message[];
  releaseFails = new Set<string>();
  deleteFails = new Set<string>();
  constructor(
    readonly all: Message[],
    private readonly batch = 10,
  ) {
    this.pending = [...all];
  }
  receive(): Promise<Message[]> {
    return Promise.resolve(this.pending.splice(0, this.batch));
  }
  visibleCount(): Promise<number> {
    return Promise.resolve(this.pending.length);
  }
  delete(m: Message): Promise<void> {
    if (this.deleteFails.has(m.MessageId!)) return Promise.reject(new Error('delete failed'));
    this.deleted.push(m.MessageId!);
    return Promise.resolve();
  }
  release(m: Message): Promise<void> {
    if (this.releaseFails.has(m.MessageId!)) return Promise.reject(new Error('release failed'));
    this.released.push(m.MessageId!);
    return Promise.resolve();
  }
}

const maxAgeMs = DEFAULT_MAX_AGE_DAYS * DAY;

describe('BL-210 DLQ age check before a redrive', () => {
  it('TC-210-05 a message sent 5 days ago is fresh, one sent 7 days ago is stale', async () => {
    const dlq = new FakeDlq([message('fresh', 5), message('old', 7)]);
    const report = await runDlqAgeCheck(dlq, { now: NOW, maxAgeMs, deleteStale: false });
    expect(report).toMatchObject({ checked: 2, fresh: 1, deleted: 0, complete: true, failed: [] });
    expect(report.stale).toEqual([{ messageId: 'old', eventId: EVENT_ID, ageHours: 168 }]);
  });

  it('TC-210-06 the age counts from OriginalSentTimestamp, not from the DLQ copy that was sent just now', async () => {
    const report = await runDlqAgeCheck(new FakeDlq([message('replayed', 7, { original: true })]), {
      now: NOW,
      maxAgeMs,
      deleteStale: false,
    });
    expect(report.stale.map(s => s.messageId)).toEqual(['replayed']);
    expect(ageOf(message('x', 7, { original: true }), NOW)).toBe(7 * DAY);
  });

  it('TC-210-07 exactly 6 days is still allowed; a message with no send time is refused, not trusted', async () => {
    const report = await runDlqAgeCheck(
      new FakeDlq([message('edge', 6), message('unknown', undefined)]),
      { now: NOW, maxAgeMs, deleteStale: false },
    );
    expect(report.fresh).toBe(1);
    expect(report.stale).toEqual([{ messageId: 'unknown', eventId: EVENT_ID, ageHours: null }]);
  });

  it('TC-210-08 reads the whole queue over several batches and keeps the newest handle of a repeated message', async () => {
    const all = Array.from({ length: 25 }, (_, i) => message(`m${i}`, i % 2 === 0 ? 1 : 9));
    const dlq = new FakeDlq(all, 10);
    const report = await runDlqAgeCheck(dlq, { now: NOW, maxAgeMs, deleteStale: false });
    expect(report.checked).toBe(25);
    expect(report.stale).toHaveLength(12);
    // Nothing is deleted without --delete-stale and every message is handed back (visibility 0).
    expect(dlq.deleted).toEqual([]);
    expect(dlq.released).toHaveLength(25);
  });

  it('TC-210-09 with deleteStale the stale messages are saved first, then deleted; the fresh ones are released', async () => {
    const dlq = new FakeDlq([message('fresh', 1), message('old', 8)]);
    const order: string[] = [];
    const saveStale = jest.fn((messages: Message[]) => {
      order.push(`save:${messages.map(m => m.MessageId).join(',')}:deleted=${dlq.deleted.length}`);
    });
    const report = await runDlqAgeCheck(dlq, { now: NOW, maxAgeMs, deleteStale: true, saveStale });
    expect(order).toEqual(['save:old:deleted=0']);
    expect(dlq.deleted).toEqual(['old']);
    expect(dlq.released).toEqual(['fresh']);
    expect(report).toMatchObject({ checked: 2, fresh: 1, deleted: 1, failed: [] });
  });

  it('TC-210-10 a failed save deletes nothing and gives every message back', async () => {
    const dlq = new FakeDlq([message('fresh', 1), message('old', 8)]);
    await expect(
      runDlqAgeCheck(dlq, {
        now: NOW,
        maxAgeMs,
        deleteStale: true,
        saveStale: () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');
    expect(dlq.deleted).toEqual([]);
    expect(dlq.released.sort()).toEqual(['fresh', 'old']);
  });

  it('TC-210-11 deleteStale without a way to save is refused', async () => {
    await expect(
      runDlqAgeCheck(new FakeDlq([]), { now: NOW, maxAgeMs, deleteStale: true }),
    ).rejects.toThrow('saveStale');
  });

  it('TC-210-12 a queue that never drains is reported as incomplete, not as clean', async () => {
    const endless: DlqPort = {
      receive: () => Promise.resolve([]),
      visibleCount: () => Promise.resolve(3),
      delete: () => Promise.resolve(),
      release: () => Promise.resolve(),
    };
    const report = await runDlqAgeCheck(endless, {
      now: NOW,
      maxAgeMs,
      deleteStale: false,
      maxRounds: 3,
    });
    expect(report.complete).toBe(false);
  });

  it('TC-210-13 the report never carries a body, and an event id only when the body has a UUID one', async () => {
    const secret = 'ACCOUNT-123456';
    const report = await runDlqAgeCheck(
      new FakeDlq([
        message('a', 9, { body: JSON.stringify({ eventId: secret, note: secret }) }),
        message('b', 9, { body: 'not json' }),
      ]),
      { now: NOW, maxAgeMs, deleteStale: false },
    );
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.stale).toEqual([
      { messageId: 'a', ageHours: 216 },
      { messageId: 'b', ageHours: 216 },
    ]);
  });
});

describe('BL-210 dlq-age-check command', () => {
  function run(argv: string[], dlq: FakeDlq) {
    const out: string[] = [];
    const err: string[] = [];
    const files: Array<[string, string]> = [];
    return runDlqAgeCheckCli(argv, {
      stdout: t => out.push(t),
      stderr: t => err.push(t),
      env: {},
      now: () => NOW,
      port: dlq,
      writeFile: (path, text) => files.push([path, text]),
    }).then(code => ({ code, out: out.join(''), err: err.join(''), files }));
  }
  const queueArgs = ['--queue-url', 'http://localhost:9324/000000000000/x-dlq'];

  it('TC-210-14 exit 0 when every message is within 6 days, 1 when a stale one remains', async () => {
    expect((await run(queueArgs, new FakeDlq([message('a', 2)]))).code).toBe(0);
    const stale = await run(queueArgs, new FakeDlq([message('a', 2), message('b', 7)]));
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.out)).toMatchObject({ checked: 2, fresh: 1 });
  });

  it('TC-210-15 --max-age-days changes the limit', async () => {
    const dlq = () => new FakeDlq([message('a', 2)]);
    expect((await run([...queueArgs, '--max-age-days', '1'], dlq())).code).toBe(1);
    expect((await run([...queueArgs, '--max-age-days', '3'], dlq())).code).toBe(0);
  });

  it('TC-210-16 --delete-stale writes the stale bodies to the quarantine file and exits 0', async () => {
    const dlq = new FakeDlq([message('a', 2), message('b', 7)]);
    const result = await run(
      [...queueArgs, '--delete-stale', '--quarantine-file', 'stale.jsonl'],
      dlq,
    );
    expect(result.code).toBe(0);
    expect(dlq.deleted).toEqual(['b']);
    expect(result.files).toHaveLength(1);
    expect(result.files[0][0]).toBe('stale.jsonl');
    expect(JSON.parse(result.files[0][1].trim())).toMatchObject({
      messageId: 'b',
      body: expect.stringContaining(EVENT_ID),
    });
  });

  it('TC-210-17 bad arguments exit 2 and delete nothing', async () => {
    for (const argv of [
      [],
      [...queueArgs, '--max-age-days', 'abc'],
      [...queueArgs, '--max-age-days', '0'],
      [...queueArgs, '--max-age-days', '7'],
      [...queueArgs, '--delete-stale'],
      [...queueArgs, '--nope'],
    ]) {
      const dlq = new FakeDlq([message('b', 7)]);
      const result = await run(argv, dlq);
      expect(result.code).toBe(2);
      expect(dlq.deleted).toEqual([]);
    }
  });

  it('TC-210-18 a message that could not be handed back makes the run fail', async () => {
    const dlq = new FakeDlq([message('a', 1)]);
    dlq.releaseFails.add('a');
    const result = await run(queueArgs, dlq);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out).failed).toEqual(['a']);
  });
});
