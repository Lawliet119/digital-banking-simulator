import { randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';

export const INVARIANT_FUNDING_ID = '00000000-0000-4000-8000-000000000001';

export interface InvariantAccounts {
  actorId: string;
  senderId: string;
  recipientId: string;
  unusedId: string;
}

/** These fixtures deliberately bypass the absent deposit API, only in disposable databases. */
export async function assertInvariantFixtureDatabase(runner: QueryRunner): Promise<void> {
  const [{ name }] = await runner.query('SELECT current_database() AS name');
  if (typeof name !== 'string' || !/^dbs_test_[0-9a-f]{12}$/.test(name)) {
    throw new Error('Invariant fixtures require a disposable dbs_test database');
  }
  if (!runner.isTransactionActive) {
    throw new Error('Invariant fixture writes require an explicit transaction');
  }
}

export async function seedInvariantAccounts(runner: QueryRunner): Promise<InvariantAccounts> {
  await assertInvariantFixtureDatabase(runner);
  const accounts: string[] = [];
  let actorId = '';
  for (const [sub, name, type, status] of [
    ['nguyen-minh-local', 'Nguyễn Minh', 'CHECKING', 'ACTIVE'],
    ['tran-lan-local', 'Trần Lan', 'SAVINGS', 'LOCKED'],
    ['le-anh-local', 'Lê Anh', 'CHECKING', 'ACTIVE'],
  ]) {
    const [user] = await runner.query('INSERT INTO users(cognito_sub) VALUES($1) RETURNING id', [
      sub,
    ]);
    const [customer] = await runner.query(
      'INSERT INTO customers(user_id,full_name) VALUES($1,$2) RETURNING id',
      [user.id, name],
    );
    const [account] = await runner.query(
      'INSERT INTO accounts(customer_id,type,status) VALUES($1,$2,$3) RETURNING id',
      [customer.id, type, status],
    );
    accounts.push(account.id as string);
    if (!actorId) actorId = user.id as string;
  }
  return { actorId, senderId: accounts[0], recipientId: accounts[1], unusedId: accounts[2] };
}

interface FixtureEntry {
  direction: 'DEBIT' | 'CREDIT';
  accountId: string;
  amount: string;
}

export async function postInvariantTransfer(
  runner: QueryRunner,
  input: {
    actorId: string;
    from: string;
    to: string;
    amount: string;
    type?: 'DEPOSIT' | 'TRANSFER';
    entries?: FixtureEntry[];
  },
): Promise<string> {
  await assertInvariantFixtureDatabase(runner);
  const [transfer] = await runner.query(
    `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id)
     VALUES($1,$2,$3,$4,'COMPLETED',$5,$6) RETURNING id`,
    [input.type ?? 'TRANSFER', input.from, input.to, input.amount, input.actorId, randomUUID()],
  );
  const entries = input.entries ?? [
    { direction: 'DEBIT', accountId: input.from, amount: input.amount },
    { direction: 'CREDIT', accountId: input.to, amount: input.amount },
  ];
  for (const entry of entries) {
    const delta = entry.direction === 'DEBIT' ? `-${entry.amount}` : entry.amount;
    const [account] = await runner.query(
      'WITH changed AS (UPDATE accounts SET balance=balance+$2::bigint WHERE id=$1 RETURNING balance) SELECT balance FROM changed',
      [entry.accountId, delta],
    );
    await runner.query(
      `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after)
       VALUES($1,$2,$3,$4,$5)`,
      [transfer.id, entry.accountId, entry.direction, entry.amount, account.balance],
    );
  }
  return transfer.id as string;
}

export async function seedInvariantLedger(runner: QueryRunner): Promise<InvariantAccounts> {
  const refs = await seedInvariantAccounts(runner);
  await postInvariantTransfer(runner, {
    actorId: refs.actorId,
    from: INVARIANT_FUNDING_ID,
    to: refs.senderId,
    amount: '1000000',
    type: 'DEPOSIT',
  });
  await postInvariantTransfer(runner, {
    actorId: refs.actorId,
    from: refs.senderId,
    to: refs.recipientId,
    amount: '250000',
  });
  await runner.query(
    `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id)
     VALUES('TRANSFER',$1,$2,'10000000','REJECTED','INSUFFICIENT_FUNDS',$3,$4)`,
    [refs.senderId, refs.recipientId, refs.actorId, randomUUID()],
  );
  return refs;
}

export async function invariantState(runner: QueryRunner) {
  return {
    accounts: (await runner.query(
      'SELECT id,type,status,balance FROM public.accounts ORDER BY id',
    )) as Record<string, unknown>[],
    transfers: (await runner.query(
      'SELECT id,type,from_account_id,to_account_id,amount,status FROM public.transfers ORDER BY id',
    )) as Record<string, unknown>[],
    entries: (await runner.query(
      'SELECT id,transfer_id,account_id,direction,amount,balance_after FROM public.ledger_entries ORDER BY id',
    )) as Record<string, unknown>[],
  };
}
