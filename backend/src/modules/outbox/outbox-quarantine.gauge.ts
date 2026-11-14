import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { runsWorkers } from '@common/app-role/app-role';
import { MetricsService } from '@common/metrics';

export const OUTBOX_QUARANTINED_METRIC = 'outbox_quarantined_events';

/**
 * How many outbox rows the relay gave up on (BL-181) and nobody has re-queued or published yet.
 * It counts on the partial index `outbox_quarantined_idx`, which holds only those rows, so the
 * read costs the same whether the table has ten rows or ten million.
 */
export const OUTBOX_QUARANTINED_SQL = `
  SELECT count(*)::int AS quarantined
  FROM outbox_events
  WHERE quarantined_at IS NOT NULL AND published_at IS NULL`;

/** A read must not hold a connection for long: the pool is shared with the relay and the consumers. */
const READ_STATEMENT_TIMEOUT_MS = 2000;

/**
 * The worker's gauge for quarantined outbox events, next to `OutboxAgeGauge` and with the same
 * rules: no dimension, only a process that runs workers has it (`dbs_api` has no `SELECT` on the
 * table), `0` when there is nothing to report, so the alarm has data to compare. The alarm treats
 * a missing point as "no change" because a stopped worker is reported by the age alarm.
 */
@Injectable()
export class OutboxQuarantineGauge implements OnModuleInit {
  constructor(
    private readonly tx: TransactionService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!runsWorkers()) return;
    this.metrics.registerGauge({
      name: OUTBOX_QUARANTINED_METRIC,
      unit: 'Count',
      read: () => this.read(),
    });
  }

  async read(): Promise<number> {
    return this.tx.run(
      async manager => {
        const rows = await manager.query<{ quarantined: number }[]>(OUTBOX_QUARANTINED_SQL);
        return rows[0]?.quarantined ?? 0;
      },
      { statementTimeoutMs: READ_STATEMENT_TIMEOUT_MS, maxRetries: 0 },
    );
  }
}
