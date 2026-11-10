import { OfflineFeatureProvider, type OfflineTransferFact } from './offline-feature-provider';
import type { TransferEvent } from './feature-provider';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const DAY = 86_400_000;
function fact(id: string, offset: number, amount = '10', toAccountId = id): OfflineTransferFact {
  return {
    id,
    fromAccountId: 'a',
    toAccountId,
    amount,
    createdAt: new Date(NOW + offset).toISOString(),
  };
}
function event(row: OfflineTransferFact): TransferEvent {
  return {
    eventId: row.id,
    eventType: 'TransferCompleted',
    correlationId: 'synthetic',
    transferId: row.id,
    type: 'TRANSFER',
    occurredAt: row.createdAt,
    fromAccountId: row.fromAccountId,
    toAccountId: row.toAccountId,
    amount: row.amount,
    fromBalanceBefore: '1000',
    fromAccountCreatedAt: '2026-01-01T00:00:00.000Z',
    toAccountCreatedAt: '2026-01-01T00:00:00.000Z',
    sameOwner: false,
    fromUserId: 'u',
    toUserId: 'v',
  };
}

describe('DBS-128 offline event-time facts', () => {
  it('hand-computes R1/R2/R4/R5, half-dong median, thresholds and exact boundaries', async () => {
    const current = fact('current', 0, '100', 'new');
    const rows = [
      fact('old', -30 * DAY - 1),
      fact('d30', -30 * DAY, '1'),
      fact('day', -DAY, '2'),
      fact('hour', -3_600_000, '3'),
      fact('ten', -600_000, '4'),
      fact('recent', -1, '5'),
      current,
      fact('tie', 0, '6', 'new'),
      fact('future', 1),
      { ...fact('reverse', -3_600_000), fromAccountId: 'new', toAccountId: 'a' },
    ];
    const provider = new OfflineFeatureProvider([...rows].reverse(), 100n);
    expect(await provider.extract(event(current))).toEqual({
      txCount10m: 3,
      txCount1h: 4,
      historyCount30d: 5,
      medianAmount30dTimes2: '6',
      reverseTransferOccurredAt: new Date(NOW - 3_600_000).toISOString(),
      newRecipients1h: 3,
      distinctRecipients24h: 4,
      sumOut24h: '118',
      smallTxCount24h: 4,
    });
    const even = fact('even', 1, '7');
    const half = new OfflineFeatureProvider(
      [...Array.from({ length: 6 }, (_, i) => fact(`h${i}`, -100 - i, String(i + 1))), even],
      100n,
    );
    expect((await half.extract(event(even))).medianAmount30dTimes2).toBe('7');
    const ai = await half.extractAiInput(event(even));
    expect(ai.medianAmount30d).toBe('3.5');
    expect(Object.keys(ai)).toHaveLength(11);
  });

  it('uses first-in-hour novelty, not current-recipient novelty; excludes same-ms history', async () => {
    const now = fact('now', 0, '10', 'r');
    const rows = [
      fact('prior', -30 * DAY, '10', 'r'),
      fact('first', -1000, '10', 'r'),
      now,
      fact('same-ms', 0, '10', 's'),
    ];
    const provider = new OfflineFeatureProvider(rows, 100n);
    expect((await provider.extract(event(now))).newRecipients1h).toBe(1);
    expect((await provider.extract(event(now))).historyCount30d).toBe(2);
    expect((await provider.extract(event(rows[1]))).historyCount30d).toBe(1);
    expect((await provider.extractAiInput(event(now))).medianAmount30d).toBeNull();
  });

  it('keeps bigint amounts exact, excludes equal-time reverse and treats one-tenth as not small', async () => {
    const current = fact('big-current', 0, '9007199254740993', 'b');
    const reverse = { ...fact('equal-reverse', 0), fromAccountId: 'b', toAccountId: 'a' };
    const rows = [
      fact('edge', -30 * DAY, '9007199254740993', 'b'),
      fact('h1', -5, '9007199254740993'),
      fact('h2', -4, '9007199254740994'),
      fact('h3', -3, '9007199254740994'),
      fact('h4', -2, '9007199254740995'),
      fact('h5', -1, '9007199254740995'),
      current,
      reverse,
    ];
    const provider = new OfflineFeatureProvider(rows, 90071992547409930n);
    expect(await provider.extract(event(current))).toMatchObject({
      medianAmount30dTimes2: '18014398509481988',
      smallTxCount24h: 0,
      sumOut24h: '54043195528445964',
      reverseTransferOccurredAt: null,
      newRecipients1h: 5,
    });
    const older = { ...rows[0], createdAt: new Date(NOW - 30 * DAY - 1).toISOString() };
    expect(
      (await new OfflineFeatureProvider([older, current], 100n).extract(event(current)))
        .newRecipients1h,
    ).toBe(1);
  });

  it('does not merge a sub-millisecond timestamp before the epoch with a later fact', async () => {
    const before = { ...fact('before-epoch', 0), createdAt: '1969-12-31T23:59:59.999500Z' };
    const later = { ...fact('after-epoch', 0), createdAt: '1970-01-01T00:00:00.000000Z' };
    const provider = new OfflineFeatureProvider([before, later], 100n);
    expect((await provider.extract(event(before))).txCount1h).toBe(1);
  });

  it('copies input, deduplicates identical ids and rejects conflicts or absent snapshots', async () => {
    const row = { ...fact('one', 0) };
    const provider = new OfflineFeatureProvider([row, { ...row }], 100n);
    row.amount = '20';
    await expect(provider.extract(event({ ...row, amount: '10' }))).resolves.toMatchObject({
      txCount1h: 1,
    });
    expect(() => new OfflineFeatureProvider([row, { ...row, amount: '21' }], 100n)).toThrow(
      'Conflicting',
    );
    await expect(provider.extract(event(fact('missing', 0)))).rejects.toThrow('does not match');
  });
});
