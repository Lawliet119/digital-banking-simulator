import { randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';

/** Vietnam has no daylight saving: the day of the daily limit (BR-06) always starts at 17:00Z. */
export const VN_ZONE = 'Asia/Ho_Chi_Minh';

export interface Counter {
  sentToday: string;
  sentDay: string | null;
}

/** The counter of BL-418 as stored on the account row. */
export async function counterOf(
  runner: Pick<QueryRunner, 'query'>,
  accountId: string,
): Promise<Counter> {
  const [row] = (await runner.query(
    `SELECT sent_today::text AS "sentToday", to_char(sent_day,'YYYY-MM-DD') AS "sentDay"
     FROM accounts WHERE id=$1`,
    [accountId],
  )) as Counter[];
  return row;
}

/** The truth the counter must equal: the latest Vietnam day with a DEBIT line, and that day's sum. */
export async function ledgerTruth(
  runner: Pick<QueryRunner, 'query'>,
  accountId: string,
): Promise<Counter> {
  const [row] = (await runner.query(
    `WITH last AS (
       SELECT max((created_at AT TIME ZONE '${VN_ZONE}')::date) AS d
       FROM ledger_entries WHERE account_id=$1 AND direction='DEBIT')
     SELECT to_char(last.d,'YYYY-MM-DD') AS "sentDay",
            coalesce((SELECT sum(amount) FROM ledger_entries e
                       WHERE e.account_id=$1 AND e.direction='DEBIT'
                         AND (e.created_at AT TIME ZONE '${VN_ZONE}')::date = last.d),0)::text AS "sentToday"
     FROM last`,
    [accountId],
  )) as Counter[];
  return row;
}

/** SQL INPUT: a COMPLETED transfer and its DEBIT line at an exact instant (the ledger is append-only). */
export async function debitAt(
  runner: Pick<QueryRunner, 'query'>,
  input: { actorId: string; from: string; to: string; amount: string; at: string },
): Promise<void> {
  const [transfer] = await runner.query(
    `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id,created_at)
     VALUES('TRANSFER',$1,$2,$3,'COMPLETED',$4,$5,$6::timestamptz) RETURNING id`,
    [input.from, input.to, input.amount, input.actorId, randomUUID(), input.at],
  );
  await runner.query(
    `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after,created_at)
     VALUES($1,$2,'DEBIT',$3,0,$4::timestamptz)`,
    [transfer.id, input.from, input.amount, input.at],
  );
}
