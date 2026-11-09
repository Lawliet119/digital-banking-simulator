import { createTempDatabase, type TempDatabase } from '../support/temp-database';
import {
  OfflineFeatureProvider,
  type OfflineTransferFact,
} from '../../src/modules/risk/features/offline-feature-provider';
import { TransferFacts } from '../../src/modules/risk/features/transfer-facts';
import type { TransferEvent } from '../../src/modules/risk/features/feature-provider';

describe('DBS-128 offline / real PostgreSQL TransferFacts parity', () => {
  let db: TempDatabase;
  beforeAll(async () => {
    db = await createTempDatabase();
    // Isolated synthetic relation with the production read-only view contract.
    await db.runner.query(`CREATE TABLE synthetic_facts (
      id text PRIMARY KEY, from_account_id text, to_account_id text,
      amount bigint, created_at timestamptz, status text, type text)`);
    await db.runner.query('CREATE VIEW v_transfer_facts AS SELECT * FROM synthetic_facts');
  });
  afterAll(async () => {
    if (db) await db.drop();
  });

  it('matches every fact at arbitrary extraction order, ties, microseconds and all boundaries', async () => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    const offsets = [
      -30 * 86_400_000 - 1,
      -30 * 86_400_000,
      -86_400_000,
      -3_600_000,
      -3_599_999,
      -600_000,
      -599_999,
      -1,
      0,
      0,
      1,
    ];
    const rows: OfflineTransferFact[] = [];
    for (let i = 0; i < 80; i++) {
      rows.push({
        id: `synthetic-${i}`,
        fromAccountId: i % 4 === 0 ? 'b' : 'a',
        toAccountId: i % 4 === 0 ? 'a' : `r${i % 7}`,
        amount: String(9_007_199_254_740_993n + BigInt(i)),
        createdAt: new Date(now + offsets[i % offsets.length])
          .toISOString()
          .replace('.000Z', '.000456Z'),
      });
    }
    for (const row of rows)
      await db.runner.query(
        "INSERT INTO synthetic_facts VALUES ($1,$2,$3,$4,$5,'COMPLETED','TRANSFER')",
        [row.id, row.fromAccountId, row.toAccountId, row.amount, row.createdAt],
      );
    const limit = 90_071_992_547_410_000n;
    const offline = new OfflineFeatureProvider(rows, limit);
    const sql = new TransferFacts(db.runner);
    for (const row of [...rows].reverse()) {
      const event: TransferEvent = {
        eventId: row.id,
        correlationId: 'synthetic',
        eventType: 'TransferCompleted',
        type: 'TRANSFER',
        occurredAt: row.createdAt,
        transferId: row.id,
        amount: row.amount,
        fromAccountId: row.fromAccountId,
        toAccountId: row.toAccountId,
        fromBalanceBefore: '999999999999999999',
        fromAccountCreatedAt: '2026-01-01T00:00:00Z',
        toAccountCreatedAt: '2026-01-01T00:00:00Z',
        fromUserId: 'u',
        toUserId: 'v',
        sameOwner: false,
      };
      const at = Date.parse(row.createdAt);
      const history = await sql.history(row.fromAccountId, at);
      const outflow = await sql.outflow24h(row.fromAccountId, at, limit);
      expect(await offline.extract(event)).toEqual({
        txCount10m: (await sql.windowTransfers(row.fromAccountId, at, 600_000)).length,
        txCount1h: (await sql.windowTransfers(row.fromAccountId, at, 3_600_000)).length,
        historyCount30d: history.count,
        medianAmount30dTimes2: history.count >= 5 ? history.median2 : null,
        reverseTransferOccurredAt: await sql.reverseTransfer(
          row.fromAccountId,
          row.toAccountId,
          at,
        ),
        newRecipients1h: (await sql.newRecipientsInWindow(row.fromAccountId, at, 3_600_000)).length,
        distinctRecipients24h: outflow.distinctRecipients,
        sumOut24h: outflow.sum,
        smallTxCount24h: outflow.small,
      });
    }
  });
});
