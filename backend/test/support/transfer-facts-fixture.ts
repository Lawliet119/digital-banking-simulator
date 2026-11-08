import { randomUUID } from 'node:crypto';

/** Anything with `query(sql, params)`: a TypeORM `QueryRunner` or `DataSource`. */
export interface Sql {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface SeededTransfer {
  id: string;
  from: string;
  to: string;
  /** The exact `created_at` that was stored (ISO text with microseconds). */
  at: string;
}

/**
 * Rows for the fraud feature tests (DBS-109): customers with accounts, and `transfers` written
 * directly with a chosen `created_at`. The ledger is not touched: the risk queries read only the
 * `v_transfer_facts` view. For a throw-away `dbs_test_*` database only.
 */
export class TransferFixture {
  private readonly actor = randomUUID();
  private ready = false;

  constructor(private readonly sql: Sql) {}

  private async init(): Promise<void> {
    if (this.ready) return;
    await this.sql.query('INSERT INTO users(id,cognito_sub) VALUES($1,$2)', [
      this.actor,
      randomUUID(),
    ]);
    this.ready = true;
  }

  /** `n` new ACTIVE accounts, each of its own customer unless `owner` is given. */
  async accounts(n: number, owner?: { customerId: string }): Promise<string[]> {
    await this.init();
    const ids: string[] = [];
    let customerId = owner?.customerId;
    for (let i = 0; i < n; i++) {
      if (!owner) {
        const user = randomUUID();
        await this.sql.query('INSERT INTO users(id,cognito_sub) VALUES($1,$2)', [
          user,
          randomUUID(),
        ]);
        const rows = (await this.sql.query(
          `INSERT INTO customers(user_id,full_name) VALUES($1,'Nguyễn Văn An') RETURNING id`,
          [user],
        )) as { id: string }[];
        customerId = rows[0].id;
      }
      const rows = (await this.sql.query(
        `INSERT INTO accounts(customer_id,type) VALUES($1,'CHECKING') RETURNING id`,
        [customerId],
      )) as { id: string }[];
      ids.push(rows[0].id);
    }
    return ids;
  }

  /** A transfer row with the given instant, e.g. `2026-10-19T03:15:42.123456Z`. */
  async transfer(input: {
    from: string;
    to: string;
    at: string;
    amount?: string;
    status?: 'COMPLETED' | 'REJECTED';
    type?: 'TRANSFER' | 'DEPOSIT';
  }): Promise<SeededTransfer> {
    await this.init();
    const status = input.status ?? 'COMPLETED';
    const rows = (await this.sql.query(
      `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz) RETURNING id`,
      [
        input.type ?? 'TRANSFER',
        input.from,
        input.to,
        input.amount ?? '500000',
        status,
        status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null,
        this.actor,
        randomUUID(),
        input.at,
      ],
    )) as { id: string }[];
    return { id: rows[0].id, from: input.from, to: input.to, at: input.at };
  }
}
