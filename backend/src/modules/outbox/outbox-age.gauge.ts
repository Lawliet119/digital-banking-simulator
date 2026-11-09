import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { runsWorkers } from '@common/app-role/app-role';
import { MetricsService } from '@common/metrics';

export const OUTBOX_AGE_METRIC = 'outbox_oldest_unpublished_age_seconds';

/**
 * Age, by the clock of the database, of the oldest outbox row that was never published
 * (docs/03 §14: under 10 s, alarm over 30 s: the relay or the worker is stuck). Rows come out of
 * the relay in `id` order, so the first row of the partial index `outbox_unpublished_idx` is the
 * one that has waited longest; no other row is looked at.
 */
export const OUTBOX_AGE_SQL = `
  SELECT GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - created_at))::float8 AS age
  FROM outbox_events
  WHERE published_at IS NULL
  ORDER BY id
  LIMIT 1`;

/** A read must not hold a connection for long: the pool is shared with the relay and the consumers. */
const READ_STATEMENT_TIMEOUT_MS = 2000;

/**
 * The worker's gauge for the outbox (DBS-144). It lives with the module that owns the table, in
 * `OutboxRelayModule`, so only a process that runs workers has it: the `api` role is not granted
 * `SELECT` on `outbox_events`. When nothing waits it reports 0, so an alarm has data to compare;
 * when the worker is dead there is no data at all, and the alarm has to treat that as breaching.
 */
@Injectable()
export class OutboxAgeGauge implements OnModuleInit {
  constructor(
    private readonly tx: TransactionService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!runsWorkers()) return;
    this.metrics.registerGauge({
      name: OUTBOX_AGE_METRIC,
      unit: 'Seconds',
      read: () => this.read(),
    });
  }

  async read(): Promise<number> {
    return this.tx.run(
      async manager => {
        const rows = await manager.query<{ age: number }[]>(OUTBOX_AGE_SQL);
        return rows[0]?.age ?? 0;
      },
      { statementTimeoutMs: READ_STATEMENT_TIMEOUT_MS, maxRetries: 0 },
    );
  }
}
