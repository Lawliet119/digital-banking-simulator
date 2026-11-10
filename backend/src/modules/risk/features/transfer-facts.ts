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
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

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

/** The SQL text and parameters of each query, for `EXPLAIN` in tests. */
export function factQueries(
  fromId: string,
  toId: string,
  occMs: number,
  options: { windowMs?: number; perTxLimit?: bigint } = {},
): Record<'window' | 'history' | 'reverse' | 'outflow' | 'newRecipients', Query> {
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
    history: {
      sql: `WITH h AS (
              SELECT amount, row_number() OVER (ORDER BY amount) AS rn, count(*) OVER () AS n
              FROM v_transfer_facts
              WHERE from_account_id = $1 AND ${COMPLETED}
                AND created_at >= $2::timestamptz AND created_at < $3::timestamptz)
            SELECT max(n)::int AS n,
                   (sum(amount) FILTER (WHERE rn = (n + 1) / 2)
                    + sum(amount) FILTER (WHERE rn = (n + 2) / 2))::text AS median2
            FROM h`,
      params: [fromId, iso(occMs - 30 * DAY), iso(occMs)],
    },
    reverse: {
      sql: `SELECT to_char(date_trunc('milliseconds', max(created_at)) AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
            FROM v_transfer_facts
            WHERE from_account_id = $2 AND to_account_id = $1 AND ${COMPLETED}
              AND created_at >= $3::timestamptz AND created_at < $4::timestamptz`,
      params: [fromId, toId, iso(occMs - HOUR), iso(occMs)],
    },
    outflow: {
      sql: `SELECT count(DISTINCT to_account_id)::int AS recipients,
                   COALESCE(sum(amount), 0)::text AS total,
                   (count(*) FILTER (WHERE amount::numeric * 10 < $4::numeric))::int AS small
            FROM v_transfer_facts
            WHERE from_account_id = $1 AND ${COMPLETED}
              AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
      params: [fromId, iso(occMs - DAY + 1), until, String(options.perTxLimit ?? 0n)],
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

  private async rows(query: Query): Promise<Row[]> {
    return (await this.db.query(query.sql, query.params)) as Row[];
  }
  /** Aggregate R1 without materializing a busy account's full hour in the worker. */
  async velocity(
    accountId: string,
    transferId: string,
    occMs: number,
  ): Promise<{
    tenMinutes: number;
    hour: number;
    includesCurrent: boolean;
  }> {
    const [row] = await this.rows({
      sql: `SELECT count(*)::int AS hour,
                   (count(*) FILTER (WHERE created_at >= $4::timestamptz))::int AS ten,
                   COALESCE(bool_or(id = $5::uuid), false) AS current
            FROM v_transfer_facts
            WHERE from_account_id = $1 AND ${COMPLETED}
              AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
      params: [
        accountId,
        iso(occMs - HOUR + 1),
        iso(occMs + 1),
        iso(occMs - 600_000 + 1),
        transferId,
      ],
    });
    return {
      tenMinutes: Number(row.ten),
      hour: Number(row.hour),
      includesCurrent: row.current === true,
    };
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
    const [row] = await this.rows(factQueries(accountId, accountId, occMs).history);
    return {
      count: row.n === null || row.n === undefined ? 0 : Number(row.n),
      median2: (row.median2 as string | null | undefined) ?? null,
    };
  }

  /** ISO time (ms) of the latest completed `toId -> fromId` transfer in `[occ - 1h, occ)`. */
  async reverseTransfer(fromId: string, toId: string, occMs: number): Promise<string | null> {
    const [row] = await this.rows(factQueries(fromId, toId, occMs).reverse);
    return (row.at as string | null | undefined) ?? null;
  }

  /** Recipients, total and small transfers sent in `(occ - 24h, occ]`, the current one included. */
  async outflow24h(accountId: string, occMs: number, perTxLimit: bigint): Promise<Outflow> {
    const [row] = await this.rows(factQueries(accountId, accountId, occMs, { perTxLimit }).outflow);
    return {
      distinctRecipients: Number(row.recipients),
      sum: row.total as string,
      small: Number(row.small),
    };
  }
}
