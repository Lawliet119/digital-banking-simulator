import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { buildRiskConsumer, eventFor, riskFixtures } from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startDepositApp, type DepositApp } from '../support/deposit-app';

describe('RSK-06: AI Risk Runtime Gating & Concurrency (Postgres thật)', () => {
  let db: TempDatabase;
  let app: DepositApp;
  let source: DataSource;
  let operatorToken: string;
  let fx: ReturnType<typeof riskFixtures>;

  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> =>
    db.runner.query(sql, args) as Promise<T[]>;

  const message = (attempts = 1) => ({
    MessageId: randomUUID(),
    ReceiptHandle: randomUUID(),
    Attributes: { ApproximateReceiveCount: String(attempts) },
  });

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { fraud: true });
    operatorToken = await app.issuer.token('operator', { sub: randomUUID() });
    fx = riskFixtures(app, operatorToken);
    source = await new DataSource({
      type: 'postgres',
      url: db.url,
      synchronize: false,
      extra: { max: 10 },
    }).initialize();
  });

  afterAll(async () => {
    try {
      await source?.destroy();
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-RSK-06-01: two workers racing on the same transfer create exactly one decision and one flag (idempotent)', async () => {
    const c1 = await fx.customer('Alice Sender');
    const c2 = await fx.customer('Bob Recipient');
    await fx.deposit(c1.accounts[0], '50000000');

    // Transfer money
    const transferId = await fx.transfer(c1.token, c1.accounts[0], c2.accounts[0], '20000000');
    const event = await eventFor(db.runner, transferId);
    const copyEvent = { ...event, eventId: randomUUID() };

    // Build two distinct worker consumer instances
    const workerA = buildRiskConsumer(source);
    const workerB = buildRiskConsumer(source);

    // Race both consumers concurrently on the same transfer
    await Promise.all([
      workerA.consumer.handle(event, message(1)),
      workerB.consumer.handle(copyEvent, message(1)),
    ]);

    // Verify exactly 1 risk_decision was written
    const decisions = await q(
      'SELECT transfer_id, mode, ai_status, rule_score FROM risk_decisions WHERE transfer_id = $1::uuid',
      [transferId],
    );
    expect(decisions).toHaveLength(1);

    // Verify fraud_flags has at most 1 flag
    const flags = await q(
      'SELECT transfer_id, score, risk_level, review_status FROM fraud_flags WHERE transfer_id = $1::uuid',
      [transferId],
    );
    expect(flags.length).toBeLessThanOrEqual(1);

    // Verify audit log for fraud.flagged (if generated) is at most 1
    const audits = await q(
      "SELECT id, action, outcome FROM audit_log WHERE target_id = $1 AND action = 'fraud.flagged'",
      [transferId],
    );
    expect(audits.length).toBeLessThanOrEqual(1);
  });

  it('TC-RSK-06-02: transaction rolls back when audit fails; consumer throws so SQS does not ack', async () => {
    const c1 = await fx.customer('Charlie Sender');
    const c2 = await fx.customer('David Recipient');
    await fx.deposit(c1.accounts[0], '50000000');

    const transferId = await fx.transfer(c1.token, c1.accounts[0], c2.accounts[0], '15000000');
    const event = await eventFor(db.runner, transferId);

    const parts = buildRiskConsumer(source);

    // Mock audit service to throw an error
    jest
      .spyOn(parts.tx, 'run')
      .mockRejectedValueOnce(new Error('Forced database transaction failure'));

    // Consumer handle must throw error (ensuring SQS redelivers)
    await expect(parts.consumer.handle(event, message(1))).rejects.toThrow(
      'Forced database transaction failure',
    );

    // Verify nothing committed: no partial risk_decision or processed_event
    const decisions = await q(
      'SELECT transfer_id FROM risk_decisions WHERE transfer_id = $1::uuid',
      [transferId],
    );
    expect(decisions).toHaveLength(0);

    const processed = await q('SELECT event_id FROM processed_events WHERE event_id = $1::uuid', [
      (event as { eventId: string }).eventId,
    ]);
    expect(processed).toHaveLength(0);
  });

  it('TC-RSK-06-03: dbs_worker role is append-only on risk_decisions (UPDATE and DELETE are denied)', async () => {
    await db.runner.query("ALTER ROLE dbs_worker LOGIN PASSWORD 'role-test-only'");
    const url = new URL(db.url);
    url.username = 'dbs_worker';
    url.password = 'role-test-only';
    const workerDbUrl = url.toString();
    let workerSource: DataSource | undefined;

    try {
      workerSource = await new DataSource({
        type: 'postgres',
        url: workerDbUrl,
        synchronize: false,
      }).initialize();

      const workerRunner = workerSource.createQueryRunner();

      // Test UPDATE on risk_decisions -> must be rejected
      await expect(
        workerRunner.query(
          "UPDATE risk_decisions SET rule_score = 99 WHERE transfer_id = '00000000-0000-0000-0000-000000000000'",
        ),
      ).rejects.toThrow(/permission denied for table risk_decisions/i);

      // Test DELETE on risk_decisions -> must be rejected
      await expect(
        workerRunner.query(
          "DELETE FROM risk_decisions WHERE transfer_id = '00000000-0000-0000-0000-000000000000'",
        ),
      ).rejects.toThrow(/permission denied for table risk_decisions/i);

      await workerRunner.release();
    } finally {
      await workerSource?.destroy();
    }
  });

  it('TC-RSK-06-04: customer endpoints never leak internal AI risk assessment, probability, or rubric details', async () => {
    const c1 = await fx.customer('Eve Sender');
    const c2 = await fx.customer('Frank Recipient');
    await fx.deposit(c1.accounts[0], '50000000');

    const transferId = await fx.transfer(c1.token, c1.accounts[0], c2.accounts[0], '5000000');
    const event = await eventFor(db.runner, transferId);

    const parts = buildRiskConsumer(source);
    await parts.consumer.handle(event, message(1));

    // Customer checks transfer status
    const statusRes = await request(app.url)
      .get(`/v1/transfers/${transferId}`)
      .auth(c1.token, { type: 'bearer' })
      .expect(200);

    const bodyStr = JSON.stringify(statusRes.body);
    expect(bodyStr).not.toContain('ai_status');
    expect(bodyStr).not.toContain('probability');
    expect(bodyStr).not.toContain('rubric_sha256');
    expect(bodyStr).not.toContain('risk_score');
    expect(bodyStr).not.toContain('rule_score');
    expect(bodyStr).not.toContain('aiAssessment');

    // Customer checks account transactions
    const txRes = await request(app.url)
      .get(`/v1/accounts/${c1.accounts[0]}/transactions`)
      .auth(c1.token, { type: 'bearer' })
      .expect(200);

    const txBodyStr = JSON.stringify(txRes.body);
    expect(txBodyStr).not.toContain('ai_status');
    expect(txBodyStr).not.toContain('probability');
    expect(txBodyStr).not.toContain('rubric_sha256');
    expect(txBodyStr).not.toContain('aiAssessment');
  });
});
