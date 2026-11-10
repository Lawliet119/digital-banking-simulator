import { DataSource } from 'typeorm';
import { OnlineFeatureProvider } from '@modules/risk/features/online-feature-provider';
import { TransferFacts } from '@modules/risk/features/transfer-facts';
import type { TransferEvent } from '@modules/risk/features/feature-provider';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { TransferFixture } from '../support/transfer-facts-fixture';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

const MIN = 60_000;
const BASE = Date.parse('2026-10-19T03:00:00.000Z');

describe('OnlineFeatureProvider (real PostgreSQL, no Redis dependency)', () => {
  let db: TempDatabase | undefined;
  let source: DataSource | undefined;
  let fixture: TransferFixture;
  let provider: OnlineFeatureProvider;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    fixture = new TransferFixture(db.runner);
    provider = new OnlineFeatureProvider({
      facts: new TransferFacts(source),
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

  async function send(from: string, to: string, atMs: number, status?: 'REJECTED') {
    const row = await fixture.transfer({
      from,
      to,
      amount: '40000',
      status,
      at: new Date(atMs).toISOString().replace('Z', '321Z'),
    });
    return {
      ...TRANSFER_SAMPLE,
      eventId: row.id,
      transferId: row.id,
      fromAccountId: from,
      toAccountId: to,
      occurredAt: new Date(atMs).toISOString(),
    } as TransferEvent;
  }

  it('counts completed transfers once, uses event windows and retains all SQL feature semantics', async () => {
    const [a, b, c, d] = await fixture.accounts(4);
    await send(b, a, BASE - 20 * MIN);
    await send(a, b, BASE, 'REJECTED');
    const events: TransferEvent[] = [];
    for (let i = 0; i < 7; i++) events.push(await send(a, [b, c, d][i % 3], BASE + (i + 1) * MIN));
    const last = events[6];
    const features = await provider.extract(last);
    expect(features).toEqual({
      txCount10m: 7,
      txCount1h: 7,
      historyCount30d: 6,
      medianAmount30dTimes2: '80000',
      reverseTransferOccurredAt: new Date(BASE - 20 * MIN).toISOString(),
      newRecipients1h: 3,
      distinctRecipients24h: 3,
      sumOut24h: '280000',
      smallTxCount24h: 7,
    });
    expect(await provider.extract(last)).toEqual(features);
    expect((await provider.extract(events[0])).txCount1h).toBe(1);
  });

  it('propagates a PostgreSQL outage instead of returning incomplete features', async () => {
    const [from, to] = await fixture.accounts(2);
    const event = await send(from, to, BASE);
    await source!.destroy();
    await expect(provider.extract(event)).rejects.toThrow();
  });
});
