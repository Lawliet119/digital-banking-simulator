import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTempDatabase, migrate } from '../support/temp-database';
import { startDepositApp } from '../support/deposit-app';
import { TransferFixture } from '../support/transfer-facts-fixture';

// Synthetic data only; creates and drops its own migrated PostgreSQL database.
async function main(): Promise<void> {
  const db = await createTempDatabase();
  let app: Awaited<ReturnType<typeof startDepositApp>> | undefined;
  try {
    await migrate(db.url);
    const fixture = new TransferFixture(db.runner);
    const [from, to] = await fixture.accounts(2);
    const transfer = await fixture.transfer({ from, to, at: '2026-10-19T03:15:42.123456Z' });
    await db.runner.startTransaction();
    await db.runner.query(
      `INSERT INTO risk_decisions
        (transfer_id,event_id,rule_set_version,mode,rule_score,feature_snapshot,ai_status,ai_applied_weight)
       VALUES($1,$2,1,'rule_only',40,'{}','DISABLED',0)`,
      [transfer.id, randomUUID()],
    );
    await db.runner.query(
      `INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version)
       VALUES($1,40,'MEDIUM',1)`,
      [transfer.id],
    );
    await db.runner.query(
      `INSERT INTO fraud_rule_hits(transfer_id,rule_id,weight,explanation)
       VALUES($1,'R1',40,'Synthetic threshold reached')`,
      [transfer.id],
    );
    await db.runner.commitTransaction();
    app = await startDepositApp(db.url, { fraud: true });
    const operator = await app.issuer.token('operator', { sub: randomUUID() });
    const customer = await app.issuer.token('customer', { sub: randomUUID() });
    const base = `${app.url}/v1/operator/fraud-flags/${transfer.id}`;
    const headers = (token: string) => ({ authorization: `Bearer ${token}` });
    const detail = await fetch(base, { headers: headers(operator) });
    assert.equal(detail.status, 200);
    const body = (await detail.json()) as { score: number; hits: unknown[]; aiAssessment: unknown };
    assert.equal(body.score, 40);
    assert.equal(body.hits.length, 1);
    assert.equal(body.aiAssessment, null);
    const forbidden = await fetch(base, { headers: headers(customer) });
    assert.equal(forbidden.status, 403);
    const submit = () =>
      fetch(`${base}/review`, {
        method: 'POST',
        headers: { ...headers(operator), 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'FALSE_POSITIVE' }),
      });
    assert.equal((await submit()).status, 200);
    assert.equal((await submit()).status, 409);
    const audits = (await db.runner.query(
      `SELECT action FROM audit_log
      WHERE target_id=$1 AND action IN ('fraud_flag.view','fraud_flag.review') ORDER BY action`,
      [transfer.id],
    )) as { action: string }[];
    assert.deepEqual(
      audits.map(row => row.action),
      ['fraud_flag.review', 'fraud_flag.view'],
    );
    console.log(
      'M-FRAUD-HTTP PASS: operator detail 200; customer 403; review 200 then 409; audits committed',
    );
  } finally {
    if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
    await app?.close();
    await db.drop();
    console.log('cleanup: isolated temporary database dropped');
  }
}
void main().catch(() => {
  console.error('Fraud operator smoke failed');
  process.exitCode = 1;
});
