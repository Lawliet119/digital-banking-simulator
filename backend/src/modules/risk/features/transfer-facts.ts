/**
 * SQL half of the online feature provider (DBS-109): every query reads the read-only view
 * `v_transfer_facts` (database-design §8), never `transfers`, and repeats
 * `status = 'COMPLETED' AND type = 'TRANSFER'` so the planner can use the partial indexes
 * `transfers_account_completed_idx (from_account_id, created_at)` and
 * `transfers_pair_completed_idx (from_account_id, to_account_id, created_at)`.
 *
 * **Time is compared in milliseconds.** An event's `occurredAt` is `created_at` cut to milliseconds
 * by `Date#toISOString()`, while the column keeps microseconds. So "created_at, in ms, is after B"
 * is written as `created_at >= B + 1 ms` and "is at or before B" as `created_at < B + 1 ms`, which
 * keeps the index usable and keeps the current transfer (`.123456` for an event at `.123`) inside
 * its own window.
 *
 * **One scan for three features (DBS-173, BL-413).** History (R2), velocity (R1) and outflow (R6)
 * all read the completed transfers of one source account; they differ only in how far back they
 * look. They used to be three queries, each reading its own slice of the same index range, and on
 * RDS each of them became a sequential scan of the whole table. `accountFacts` reads the widest
 * slice once, `[occ - 30 days, occ + 1 ms)`, and cuts the narrower windows out of it with `FILTER`.
 */
import { HISTORY_DAYS } from './feature-provider';

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** A `Queryable` that can lend out one dedicated connection: a TypeORM `DataSource`. */
interface ConnectionSource extends Queryable {
  createQueryRunner(): {
    connect(): Promise<unknown>;
    query(sql: string, params?: unknown[]): Promise<unknown>;
    release(): Promise<void>;
  };
}

const hasConnections = (db: Queryable): db is ConnectionSource =>
  typeof (db as Partial<ConnectionSource>).createQueryRunner === 'function';

/**
 * One statement string on purpose (no parameters, so PostgreSQL's simple protocol accepts several):
 * a single round trip opens the snapshot and bounds it. `READ ONLY` makes a stray write fail with
 * 25006; the idle timeout stops a stalled worker from pinning a snapshot (and so VACUUM) forever.
 * Both timeouts are `set_config(..., is_local => true)`: they end with the transaction and never
 * leak to the next user of the pooled connection.
 */
const BEGIN_SNAPSHOT_SQL = `START TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT set_config('statement_timeout', '5000ms', true),
       set_config('idle_in_transaction_session_timeout', '10000ms', true)`;

export interface TransferStamp {
  readonly id: string;
  /** `created_at` cut to milliseconds, as epoch milliseconds. */
  readonly atMs: number;
}

export interface RecipientStamp {
  readonly recipientId: string;
  /** Time of the first transfer to this recipient inside the window. */
  readonly atMs: number;
}

export interface History {
  readonly count: number;
  /** Twice the exact median, a canonical integer string; `null` when there is no history. */
  readonly median2: string | null;
}

export interface Outflow {
  readonly distinctRecipients: number;
  readonly sum: string;
  readonly small: number;
}

export interface Velocity {
  readonly tenMinutes: number;
  readonly hour: number;
  /** The current transfer is a completed transfer of the account inside the one-hour window. */
  readonly includesCurrent: boolean;
}

/** What one `accountFacts` statement answers: the history, velocity and outflow features. */
export interface AccountFacts {
  readonly history: History;
  readonly velocity: Velocity;
  readonly outflow: Outflow;
}

export interface Query {
  readonly sql: string;
  readonly params: unknown[];
}

const MS = (column: string): string =>
  `(extract(epoch FROM date_trunc('milliseconds', ${column})) * 1000)::bigint::text`;
const COMPLETED = `status = 'COMPLETED' AND type = 'TRANSFER'`;
const iso = (ms: number): string => new Date(ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A transfer id nothing has: `includesCurrent` is then false. */
const NO_TRANSFER = '00000000-0000-0000-0000-000000000000';

/** The SQL text and parameters of each query, for `EXPLAIN` in tests. */
export function factQueries(
  fromId: string,
  toId: string,
  occMs: number,
  options: { windowMs?: number; perTxLimit?: bigint; transferId?: string } = {},
): Record<'window' | 'account' | 'reverse' | 'newRecipients', Query> {
  const windowMs = options.windowMs ?? HOUR;
  const until = iso(occMs + 1); // created_at < occ + 1 ms  <=>  created_at, in ms, <= occ
  return {
    window: {
      sql: `SELECT id, ${MS('created_at')} AS at_ms
            FROM v_transfer_facts
            WHERE from_account_id = $1 AND ${COMPLETED}
              AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
      params: [fromId, iso(occMs - windowMs + 1), until],
    },
    // Parameters: $1 account; $2 = occ - 30 days; $3 = occ + 1 ms (end of the scan, and of the 1 h and
    // 24 h windows); $4 = occ - 1 h + 1 ms; $5 = occ (history ends strictly before it); $6 = occ - 10 min
    // + 1 ms; $7 = occ - 24 h + 1 ms; $8 = per-transfer limit; $9 = the current transfer.
    //
    // Same values as the three queries of DBS-109 it replaces (TC-173-01 keeps those as the oracle):
    //  - n and the two middle amounts use the rows with created_at < occ, ranks (n + 1) / 2 and
    //    (n + 2) / 2 with integer division, summed as numeric so two amounts near 2^63 do not
    //    overflow bigint; an empty history leaves array_agg NULL, so median2 is NULL.
    //  - `to_account_id` is never NULL on a COMPLETED row (transfers_completed_has_target), so
    //    count(DISTINCT ...) and a plain count of recipients agree.
    //  - the current transfer is looked up by primary key with the same predicates and window, which
    //    is what `bool_or(id = $9)` over the window answered, without making the scan read the heap.
    //    $9 is left uncast: it takes the type of `id` (uuid here), and the text-typed synthetic view of the
    //    DBS-128 parity test runs the same statement.
    account: {
      sql: `WITH w AS (
              SELECT created_at, amount, to_account_id
              FROM v_transfer_facts
              WHERE from_account_id = $1 AND ${COMPLETED}
                AND created_at >= $2::timestamptz AND created_at < $3::timestamptz)
            SELECT agg.n,
                   (agg.amounts[(agg.n + 1) / 2]::numeric
                    + agg.amounts[(agg.n + 2) / 2]::numeric)::text AS median2,
                   agg.hour, agg.ten, agg.recipients, agg.total, agg.small,
                   EXISTS (SELECT 1 FROM v_transfer_facts
                           WHERE id = $9 AND from_account_id = $1 AND ${COMPLETED}
                             AND created_at >= $4::timestamptz AND created_at < $3::timestamptz) AS current
            FROM (SELECT (count(*) FILTER (WHERE created_at < $5::timestamptz))::int AS n,
                         array_agg(amount ORDER BY amount)
                           FILTER (WHERE created_at < $5::timestamptz) AS amounts,
                         (count(*) FILTER (WHERE created_at >= $4::timestamptz))::int AS hour,
                         (count(*) FILTER (WHERE created_at >= $6::timestamptz))::int AS ten,
                         (count(DISTINCT to_account_id)
                           FILTER (WHERE created_at >= $7::timestamptz))::int AS recipients,
                         COALESCE(sum(amount) FILTER (WHERE created_at >= $7::timestamptz), 0)::text AS total,
                         (count(*) FILTER (WHERE created_at >= $7::timestamptz
                                             AND amount::numeric * 10 < $8::numeric))::int AS small
                  FROM w) agg`,
      params: [
        fromId,
        iso(occMs - HISTORY_DAYS * DAY),
        until,
        iso(occMs - HOUR + 1),
        iso(occMs),
        iso(occMs - 600_000 + 1),
        iso(occMs - DAY + 1),
        String(options.perTxLimit ?? 0n),
        options.transferId ?? NO_TRANSFER,
      ],
    },
    reverse: {
      sql: `SELECT to_char(date_trunc('milliseconds', max(created_at)) AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
            FROM v_transfer_facts
            WHERE from_account_id = $2 AND to_account_id = $1 AND ${COMPLETED}
              AND created_at >= $3::timestamptz AND created_at < $4::timestamptz`,
      params: [fromId, toId, iso(occMs - HOUR), iso(occMs)],
    },
    newRecipients: {
      sql: `SELECT w.to_account_id AS recipient, ${MS('w.first_at')} AS at_ms
            FROM (SELECT to_account_id, min(created_at) AS first_at
                  FROM v_transfer_facts
                  WHERE from_account_id = $1 AND ${COMPLETED}
                    AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
                  GROUP BY to_account_id) w
            WHERE NOT EXISTS (
              SELECT 1 FROM v_transfer_facts p
              WHERE p.from_account_id = $1 AND p.to_account_id = w.to_account_id
                AND p.status = 'COMPLETED' AND p.type = 'TRANSFER'
                AND p.created_at >= date_trunc('milliseconds', w.first_at) - interval '30 days'
                AND p.created_at < date_trunc('milliseconds', w.first_at))`,
      params: [fromId, iso(occMs - windowMs + 1), until],
    },
  };
}

type Row = Record<string, unknown>;

export class TransferFacts {
  constructor(private readonly db: Queryable) {}

  /**
   * Runs `read` so that every query it makes through the `TransferFacts` it receives sees ONE
   * snapshot of the committed facts (BL-187): a `REPEATABLE READ READ ONLY` transaction on one
   * dedicated connection. Without it, each query is its own autocommitted statement on its own
   * pooled connection, and a transfer committing between two of them is counted by one feature
   * and missed by another (R1 and R5 of the same extraction would then describe different worlds).
   *
   * The queries inside `read` share one connection, so `read` must await them one at a time (the
   * driver deprecates queueing several on one client) and PostgreSQL runs them in that order; the
   * pool no longer fans five statements out to five connections.
   *
   * A `Queryable` that cannot lend a connection (a `QueryRunner`, a test double) is already one
   * connection chosen by the caller; `read` then gets `this` and snapshotting is the caller's job.
   * Any failure rolls the transaction back, releases the connection and rejects: nothing partial.
   */
  async snapshot<T>(read: (facts: TransferFacts) => Promise<T>): Promise<T> {
    if (!hasConnections(this.db)) return read(this);
    const runner = this.db.createQueryRunner();
    try {
      await runner.connect();
      await runner.query(BEGIN_SNAPSHOT_SQL);
      try {
        const result = await read(new TransferFacts(runner));
        await runner.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await runner.query('ROLLBACK');
        } catch {
          // The failure of `read` is the useful one; a dead connection cannot roll back anyway.
        }
        throw error;
      }
    } finally {
      await runner.release();
    }
  }

  private async rows(query: Query): Promise<Row[]> {
    return (await this.db.query(query.sql, query.params)) as Row[];
  }
  /**
   * History (R2), velocity (R1) and outflow (R6) of one source account from ONE statement and one
   * scan of its transfers (DBS-173). `transferId` is the current transfer, only for
   * `velocity.includesCurrent`; `perTxLimit` only for `outflow.small`.
   */
  async accountFacts(
    accountId: string,
    transferId: string,
    occMs: number,
    perTxLimit: bigint,
  ): Promise<AccountFacts> {
    const [row] = await this.rows(
      factQueries(accountId, accountId, occMs, { perTxLimit, transferId }).account,
    );
    return {
      history: {
        count: row.n === null || row.n === undefined ? 0 : Number(row.n),
        median2: (row.median2 as string | null | undefined) ?? null,
      },
      velocity: {
        tenMinutes: Number(row.ten),
        hour: Number(row.hour),
        includesCurrent: row.current === true,
      },
      outflow: {
        distinctRecipients: Number(row.recipients),
        sum: row.total as string,
        small: Number(row.small),
      },
    };
  }

  /** Aggregate R1 without materializing a busy account's full hour in the worker. */
  async velocity(accountId: string, transferId: string, occMs: number): Promise<Velocity> {
    return (await this.accountFacts(accountId, transferId, occMs, 0n)).velocity;
  }

  /** Aggregate the exact R5 novelty query; no recipient array crosses the connection. */
  async newRecipientCount(accountId: string, occMs: number): Promise<number> {
    const recipients = factQueries(accountId, accountId, occMs).newRecipients;
    const [row] = await this.rows({
      sql: `SELECT count(*)::int AS n FROM (${recipients.sql}) recipients`,
      params: recipients.params,
    });
    return Number(row.n);
  }

  /** Completed transfers from `accountId` in `(occ - windowMs, occ]`. */
  async windowTransfers(
    accountId: string,
    occMs: number,
    windowMs: number,
  ): Promise<TransferStamp[]> {
    const q = factQueries(accountId, accountId, occMs, { windowMs }).window;
    return (await this.rows(q)).map(r => ({ id: r.id as string, atMs: Number(r.at_ms) }));
  }

  /** Recipients whose first transfer in `(occ - windowMs, occ]` was to somebody new (30 days). */
  async newRecipientsInWindow(
    accountId: string,
    occMs: number,
    windowMs: number,
  ): Promise<RecipientStamp[]> {
    const q = factQueries(accountId, accountId, occMs, { windowMs }).newRecipients;
    return (await this.rows(q)).map(r => ({
      recipientId: r.recipient as string,
      atMs: Number(r.at_ms),
    }));
  }

  /** Completed transfers strictly before `occ`, in the 30 days before it. */
  async history(accountId: string, occMs: number): Promise<History> {
    return (await this.accountFacts(accountId, NO_TRANSFER, occMs, 0n)).history;
  }

  /** ISO time (ms) of the latest completed `toId -> fromId` transfer in `[occ - 1h, occ)`. */
  async reverseTransfer(fromId: string, toId: string, occMs: number): Promise<string | null> {
    const [row] = await this.rows(factQueries(fromId, toId, occMs).reverse);
    return (row.at as string | null | undefined) ?? null;
  }

  /** Recipients, total and small transfers sent in `(occ - 24h, occ]`, the current one included. */
  async outflow24h(accountId: string, occMs: number, perTxLimit: bigint): Promise<Outflow> {
    return (await this.accountFacts(accountId, NO_TRANSFER, occMs, perTxLimit)).outflow;
  }
}
