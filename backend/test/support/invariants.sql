-- One statement gives every check the same MVCC snapshot, including during concurrent writes.
-- SUM(bigint) is numeric: keep it numeric until text encoding, even above the int64 limit.
WITH
entry_totals AS (
  SELECT COALESCE(SUM(amount::numeric) FILTER (WHERE direction = 'DEBIT'), 0) AS debit,
         COALESCE(SUM(amount::numeric) FILTER (WHERE direction = 'CREDIT'), 0) AS credit
  FROM public.ledger_entries
),
entry_balances AS (
  SELECT account_id,
         SUM(CASE WHEN direction = 'CREDIT' THEN amount::numeric ELSE -amount::numeric END) AS balance
  FROM public.ledger_entries
  GROUP BY account_id
),
account_values AS (
  SELECT a.id, a.type, a.balance::numeric AS actual, COALESCE(e.balance, 0) AS expected
  FROM public.accounts a
  LEFT JOIN entry_balances e ON e.account_id = a.id
),
account_total AS (
  SELECT COALESCE(SUM(actual), 0) AS balance FROM account_values
),
pair_values AS (
  SELECT t.id, t.amount::numeric AS amount,
         t.from_account_id::text AS from_account_id, t.to_account_id::text AS to_account_id,
         COUNT(e.id) FILTER (WHERE e.direction = 'DEBIT') AS debit_count,
         COUNT(e.id) FILTER (WHERE e.direction = 'CREDIT') AS credit_count,
         COALESCE(SUM(e.amount::numeric) FILTER (WHERE e.direction = 'DEBIT'), 0) AS debit_amount,
         COALESCE(SUM(e.amount::numeric) FILTER (WHERE e.direction = 'CREDIT'), 0) AS credit_amount,
         MIN(e.account_id::text) FILTER (WHERE e.direction = 'DEBIT') AS debit_account_id,
         MIN(e.account_id::text) FILTER (WHERE e.direction = 'CREDIT') AS credit_account_id
  FROM public.transfers t
  LEFT JOIN public.ledger_entries e ON e.transfer_id = t.id
  WHERE t.status = 'COMPLETED'
  GROUP BY t.id, t.amount, t.from_account_id, t.to_account_id
),
violations AS (
  SELECT 1 AS ordinal, ''::text AS identifier,
         jsonb_build_object(
           'check', 'ledger_totals', 'accountId', NULL, 'transferId', NULL,
           'actual', jsonb_build_object('debit', debit::text, 'credit', credit::text,
                                        'difference', (debit - credit)::text),
           'expected', jsonb_build_object('difference', '0')) AS finding
  FROM entry_totals WHERE debit <> credit
  UNION ALL
  SELECT 2, id::text,
         jsonb_build_object(
           'check', 'account_balances', 'accountId', id::text, 'transferId', NULL,
           'actual', jsonb_build_object('balance', actual::text),
           'expected', jsonb_build_object('balance', expected::text))
  FROM account_values WHERE actual <> expected
  UNION ALL
  SELECT 3, '',
         jsonb_build_object(
           'check', 'total_balances', 'accountId', NULL, 'transferId', NULL,
           'actual', jsonb_build_object('balance', balance::text),
           'expected', jsonb_build_object('balance', '0'))
  FROM account_total WHERE balance <> 0
  UNION ALL
  SELECT 4, id::text,
         jsonb_build_object(
           'check', 'customer_balances', 'accountId', id::text, 'transferId', NULL,
           'actual', jsonb_build_object('balance', actual::text),
           'expected', jsonb_build_object('minimumBalance', '0'))
  FROM account_values WHERE type <> 'SYSTEM' AND actual < 0
  UNION ALL
  SELECT 5, id::text,
         jsonb_build_object(
           'check', 'completed_pairs', 'accountId', NULL, 'transferId', id::text,
           'actual', jsonb_build_object(
             'debitCount', debit_count::text, 'creditCount', credit_count::text,
             'debitAmount', debit_amount::text, 'creditAmount', credit_amount::text,
             'debitAccountId', debit_account_id, 'creditAccountId', credit_account_id),
           'expected', jsonb_build_object(
             'debitCount', '1', 'creditCount', '1', 'amount', amount::text,
             'fromAccountId', from_account_id, 'toAccountId', to_account_id))
  FROM pair_values
  WHERE debit_count <> 1 OR credit_count <> 1
     OR debit_amount <> amount OR credit_amount <> amount
     OR debit_account_id IS DISTINCT FROM from_account_id
     OR credit_account_id IS DISTINCT FROM to_account_id
)
SELECT jsonb_build_object(
  'status', CASE WHEN EXISTS (SELECT 1 FROM violations) THEN 'FAIL' ELSE 'PASS' END,
  'totals', jsonb_build_object('debit', e.debit::text, 'credit', e.credit::text,
                              'balance', a.balance::text),
  'violations', COALESCE(
    (SELECT jsonb_agg(finding ORDER BY ordinal, identifier) FROM violations), '[]'::jsonb)
) AS report
FROM entry_totals e CROSS JOIN account_total a;
