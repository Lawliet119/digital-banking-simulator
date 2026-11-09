import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { TransactionService } from '@database/transaction.service';
import { limitsConfig } from '@config/limits.config';
import { runsWorkers } from '@common/app-role/app-role';
import { safeErrorMetadata } from '@common/logging/logging.options';
import { PollingLoop } from '@common/utils/polling-loop';
import { Clock, SystemClock } from '@common/clock';

/** The job runs once an hour; a run that left rows behind is continued after a second. */
export const CLEANUP_EVERY_MS = 60 * 60 * 1000;
export const CLEANUP_CONTINUE_MS = 1000;
/** A failure that repeats (no privilege, bad setting) is logged once a minute, not every 5 s. */
export const CLEANUP_ERROR_DELAY_MS = 60_000;
/** Rows per batch; every batch is its own short transaction. */
export const CLEANUP_BATCH_SIZE = 1000;
/** Batches per table in one run (200 000 rows); the rest follows in the next run. */
export const CLEANUP_MAX_BATCHES = 200;
/** A short rest between batches keeps WAL and replica lag from spiking. */
export const CLEANUP_PAUSE_MS = 25;
/**
 * One batch of old published outbox rows. The predicate `published_at < cutoff` never matches an
 * unpublished row (NULL); `IS NOT NULL` is there so the partial index `outbox_published_cleanup_idx`
 * can serve the query. TypeORM returns `[rows, rowCount]` for a statement whose command is
 * DELETE, so the count comes from a final SELECT.
 */
export const OUTBOX_BATCH_SQL = `
WITH doomed AS (
  SELECT id FROM outbox_events
  WHERE published_at IS NOT NULL AND published_at < now() - make_interval(days => $1)
  ORDER BY published_at LIMIT $2 FOR UPDATE SKIP LOCKED),
gone AS (
  DELETE FROM outbox_events WHERE id = ANY(ARRAY(SELECT id FROM doomed)) RETURNING 1)
SELECT count(*)::int AS count FROM gone`;

/**
 * No FOR UPDATE: `dbs_worker` has no UPDATE on `processed_events`; an advisory lock serializes the
 * jobs instead. The rows are picked by ctid (they are never updated) so the DELETE is a TID scan:
 * a join on the composite key made the planner read the whole table for every batch.
 */
export const PROCESSED_BATCH_SQL = `
WITH gone AS (
  DELETE FROM processed_events
  WHERE ctid = ANY(ARRAY(
    SELECT ctid FROM processed_events
    WHERE processed_at < $1::timestamptz
    ORDER BY processed_at LIMIT $2))
  RETURNING 1)
SELECT count(*)::int AS count FROM gone`;
const ADVISORY_LOCK_KEY = [92, 1] as const;

/** The timestamp index selects a bounded batch; ctid avoids scanning the composite primary key. */
export const IDEMPOTENCY_BATCH_SQL = `
WITH gone AS (
  DELETE FROM idempotency_keys
  WHERE ctid = ANY(ARRAY(
    SELECT ctid FROM idempotency_keys
    WHERE created_at < $1::timestamptz
    ORDER BY created_at LIMIT $2))
  RETURNING 1)
SELECT count(*)::int AS count FROM gone`;
const IDEMPOTENCY_LOCK_KEY = [136, 1] as const;
const DAY_MS = 86_400_000;

export interface CleanupResult {
  /** Outbox rows deleted. */
  outbox: number;
  /** processed_events rows deleted. */
  processed: number;
  /** Expired payment retry keys deleted (DBS-136). */
  idempotency: number;
  /** Batches run, over all three tables. */
  batches: number;
  /** True when a table still had rows when the run had to stop (budget or shutdown). */
  truncated?: true;
}

export interface CleanOptions {
  batchSize?: number;
  maxBatches?: number;
  pauseMs?: number;
  /** Called after every batch has committed; a test uses it to look at the database in between. */
  afterBatch?: () => unknown;
}

/**
 * Deletes old rows of `outbox_events` (published, past OUTBOX_RETENTION_DAYS) and of
 * `processed_events` and `idempotency_keys` past their separate retention windows in small batches,
 * so no table
 * grow for ever and no statement holds locks for long. It runs in the worker role, at start-up and
 * then every hour (docs/03 §10). An unpublished outbox row is never deleted: it has no
 * `published_at`, and BL-180 tracks the database-level guard.
 */
@Injectable()
export class OutboxCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxCleanupService.name);
  private stopping = false;
  /** Called after every run of the loop, with its result or its error (a test waits on it). */
  afterRun?: (outcome: CleanupResult | Error) => void;
  readonly retention: { outboxDays: number; processedEventsDays: number; idempotencyDays: number };
  private readonly loop = new PollingLoop(
    async () => {
      try {
        const result = await this.cleanOnce();
        this.afterRun?.(result);
        if (result.outbox + result.processed + result.idempotency > 0) {
          this.logger.log(
            {
              outbox: result.outbox,
              processed: result.processed,
              idempotency: result.idempotency,
              batches: result.batches,
            },
            'Outbox cleanup removed old rows',
          );
        }
        return result.truncated ? CLEANUP_CONTINUE_MS : CLEANUP_EVERY_MS;
      } catch (error) {
        this.afterRun?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
    error => this.logger.error(safeErrorMetadata(error), 'Outbox cleanup failed'),
    CLEANUP_ERROR_DELAY_MS,
  );

  constructor(
    private readonly tx: TransactionService,
    @Inject(limitsConfig.KEY) limits: ConfigType<typeof limitsConfig>,
    private readonly clock: Clock = new SystemClock(),
  ) {
    this.retention = {
      outboxDays: limits.outbox.retentionDays,
      processedEventsDays: limits.outbox.processedEventsRetentionDays,
      idempotencyDays: limits.idempotencyKeyRetentionDays,
    };
  }

  onApplicationBootstrap(): void {
    if (!runsWorkers()) return;
    this.stopping = false;
    this.loop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    // A run in progress stops between two batches.
    this.stopping = true;
    await this.loop.stop();
  }

  /** One run over both tables. Throws on a database error; batches already deleted stay deleted. */
  async cleanOnce(options: CleanOptions = {}): Promise<CleanupResult> {
    const batchSize = options.batchSize ?? CLEANUP_BATCH_SIZE;
    const maxBatches = options.maxBatches ?? CLEANUP_MAX_BATCHES;
    const pauseMs = options.pauseMs ?? CLEANUP_PAUSE_MS;
    let batches = 0;
    let truncated = false;

    // One cutoff per run: a long sweep cannot progressively eat into the protected window.
    const now = this.clock.now().getTime();
    const cutoffs = {
      processed: new Date(now - this.retention.processedEventsDays * DAY_MS),
      idempotency: new Date(now - this.retention.idempotencyDays * DAY_MS),
    };

    const sweep = async (table: 'outbox' | 'processed' | 'idempotency'): Promise<number> => {
      let total = 0;
      for (let i = 0; i < maxBatches; i++) {
        if (this.stopping) {
          truncated = true;
          return total;
        }
        const deleted = await this.deleteBatch(
          table,
          batchSize,
          table === 'outbox' ? undefined : cutoffs[table],
        );
        if (deleted === undefined) return total; // another job is cleaning this table
        batches += 1;
        total += deleted;
        await options.afterBatch?.();
        if (deleted < batchSize) return total;
        if (i === maxBatches - 1) {
          truncated = true; // the last batch was full: more may be waiting
          return total;
        }
        if (pauseMs > 0) await new Promise(resolve => setTimeout(resolve, pauseMs));
      }
      return total;
    };

    const outbox = await sweep('outbox');
    const processed = await sweep('processed');
    const idempotency = await sweep('idempotency');
    return {
      outbox,
      processed,
      idempotency,
      batches,
      ...(truncated ? { truncated: true as const } : {}),
    };
  }

  /** Rows deleted by one batch, or undefined when the table is being cleaned by another job. */
  private deleteBatch(
    table: 'outbox' | 'processed' | 'idempotency',
    size: number,
    cutoff?: Date,
  ): Promise<number | undefined> {
    return this.tx.run(
      async manager => {
        if (table !== 'outbox') {
          const [lock]: { locked: boolean }[] = await manager.query(
            'SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS locked',
            [...(table === 'processed' ? ADVISORY_LOCK_KEY : IDEMPOTENCY_LOCK_KEY)],
          );
          if (!lock.locked) return undefined;
        }
        const [row]: { count: number }[] = await manager.query(
          table === 'outbox'
            ? OUTBOX_BATCH_SQL
            : table === 'processed'
              ? PROCESSED_BATCH_SQL
              : IDEMPOTENCY_BATCH_SQL,
          [table === 'outbox' ? this.retention.outboxDays : cutoff, size],
        );
        return row.count;
      },
      { lockTimeoutMs: 500, statementTimeoutMs: 2000, idleInTransactionTimeoutMs: 2000 },
    );
  }
}
