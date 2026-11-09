import { performance } from 'node:perf_hooks';
import {
  OfflineFeatureProvider,
  type OfflineTransferFact,
} from '../../src/modules/risk/features/offline-feature-provider';
import type { TransferEvent } from '../../src/modules/risk/features/feature-provider';

// Synthetic only: no dataset, labels, files, network or model. Includes a single-account hotspot.
async function main(): Promise<void> {
  const start = performance.now();
  const rows: OfflineTransferFact[] = Array.from({ length: 100_000 }, (_, i) => ({
    id: `synthetic-${i}`,
    fromAccountId: i % 2 ? 'hotspot' : `a${i % 100}`,
    toAccountId: `r${i % 1000}`,
    amount: String(1 + (i % 10000)),
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 30_000).toISOString(),
  }));
  const provider = new OfflineFeatureProvider(rows, 100_000n);
  const indexed = performance.now();
  let checksum = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
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
      fromBalanceBefore: '1000000',
      fromAccountCreatedAt: '2025-01-01T00:00:00Z',
      toAccountCreatedAt: '2025-01-01T00:00:00Z',
      fromUserId: 'u',
      toUserId: 'v',
      sameOwner: false,
    };
    checksum += (await provider.extract(event)).txCount1h;
    const capture = await provider.extractAiInput(event);
    if (Object.keys(capture).length !== 11) throw new Error('AI allowlist changed');
  }
  console.log(
    JSON.stringify({
      transactions: rows.length,
      indexMs: indexed - start,
      extractAndProjectMs: performance.now() - indexed,
      checksum,
      heapBytes: process.memoryUsage().heapUsed,
    }),
  );
}
void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
