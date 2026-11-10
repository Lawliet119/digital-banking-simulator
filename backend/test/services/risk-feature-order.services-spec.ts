import { DataSource } from 'typeorm';
import type { TransferEvent } from '@modules/risk/features/feature-provider';
import { OnlineFeatureProvider } from '@modules/risk/features/online-feature-provider';
import { TransferFacts } from '@modules/risk/features/transfer-facts';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { TransferFixture } from '../support/transfer-facts-fixture';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BASE = Date.parse('2026-11-09T03:00:00.000Z');

describe('Committed fraud features are independent of event delivery order (real services)', () => {
  let db: TempDatabase | undefined;
  let source: DataSource | undefined;
  let fixture: TransferFixture;
  let facts: TransferFacts;
  let provider: OnlineFeatureProvider;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    fixture = new TransferFixture(db.runner);
    facts = new TransferFacts(source);
    provider = new OnlineFeatureProvider({
      facts,
      perTxLimit: 500_000n,
    });
  });

  afterAll(async () => {
    try {
      if (source?.isInitialized) await source.destroy();
    } finally {
      await db?.drop();
    }
  });

  async function send(from: string, to: string, atMs: number): Promise<TransferEvent> {
    // The fixture executes a real autocommitted INSERT; source reads use a different connection.
    const transfer = await fixture.transfer({
      from,
      to,
      amount: '40000',
      at: new Date(atMs).toISOString(),
    });
    return {
      ...TRANSFER_SAMPLE,
      eventId: transfer.id,
      transferId: transfer.id,
      fromAccountId: from,
      toAccountId: to,
      occurredAt: new Date(atMs).toISOString(),
    } as TransferEvent;
  }

  it('R1 includes an earlier committed but undelivered transfer after warming the window', async () => {
    const [from, to] = await fixture.accounts(2);
    const warm = await send(from, to, BASE);
    expect((await provider.extract(warm)).txCount10m).toBe(1);

    const earlier = await send(from, to, BASE + MIN);
    const later = await send(from, to, BASE + 2 * MIN);
    // Both rows committed after the first extraction; neither event has been extracted yet.
    const rows = await facts.windowTransfers(from, BASE + 2 * MIN, 10 * MIN);
    expect(rows.map(row => row.id).sort()).toEqual(
      [warm.transferId, earlier.transferId, later.transferId].sort(),
    );
    const actual = await provider.extract(later);
    expect({ txCount10m: actual.txCount10m, txCount1h: actual.txCount1h }).toEqual({
      txCount10m: rows.length,
      txCount1h: rows.length,
    });
    const earlierRows = await facts.windowTransfers(from, BASE + MIN, 10 * MIN);
    expect((await provider.extract(earlier)).txCount10m).toBe(earlierRows.length);
  });

  it('R5 includes an earlier committed new recipient whose event has not been delivered', async () => {
    const [from, first, second, third] = await fixture.accounts(4);
    const warm = await send(from, first, BASE);
    expect((await provider.extract(warm)).newRecipients1h).toBe(1);

    const earlier = await send(from, second, BASE + MIN);
    const later = await send(from, third, BASE + 2 * MIN);
    const recipients = await facts.newRecipientsInWindow(from, BASE + 2 * MIN, HOUR);
    expect(recipients.map(row => row.recipientId).sort()).toEqual([first, second, third].sort());
    expect((await provider.extract(later)).newRecipients1h).toBe(recipients.length);
    const earlierRecipients = await facts.newRecipientsInWindow(from, BASE + MIN, HOUR);
    expect((await provider.extract(earlier)).newRecipients1h).toBe(earlierRecipients.length);
  });

  it('R5 historical replay does not move a recent recipient outside a future window', async () => {
    const [from, repeated, other] = await fixture.accounts(3);
    const historical = await send(from, repeated, BASE - 31 * DAY);
    const recent = await send(from, repeated, BASE);
    expect((await provider.extract(recent)).newRecipients1h).toBe(1);

    // Replaying the historical event must not mutate any future feature window.
    expect((await provider.extract(historical)).newRecipients1h).toBe(1);
    const future = await send(from, other, BASE + MIN);
    const authoritative = await facts.newRecipientsInWindow(from, BASE + MIN, HOUR);
    expect(authoritative.map(row => row.recipientId).sort()).toEqual([repeated, other].sort());
    expect((await provider.extract(future)).newRecipients1h).toBe(authoritative.length);
  });

  it('excludes the next millisecond for fractional timestamps before 1970', async () => {
    const [from, to, futureRecipient] = await fixture.accounts(3);
    const current = await fixture.transfer({
      from,
      to,
      amount: '40000',
      at: '1969-12-31T23:59:59.999500Z',
    });
    await fixture.transfer({
      from,
      to: futureRecipient,
      amount: '40000',
      at: '1970-01-01T00:00:00.000000Z',
    });
    const result = await provider.extract({
      ...TRANSFER_SAMPLE,
      eventId: current.id,
      transferId: current.id,
      fromAccountId: from,
      toAccountId: to,
      occurredAt: current.at,
    } as TransferEvent);
    expect(result.txCount10m).toBe(1);
    expect(result.newRecipients1h).toBe(1);
    expect(result.sumOut24h).toBe('40000');
  });
});
