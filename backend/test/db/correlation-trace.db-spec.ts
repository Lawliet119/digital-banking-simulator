import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp, type DepositApp } from '../support/deposit-app';

type Row = Record<string, unknown>;

describe('DBS-135 AC-8.2: CorrelationId End-to-End Tracing (Postgres thật)', () => {
  let db: TempDatabase;
  let app: DepositApp;
  let operatorToken: string;
  let auditorToken: string;

  const q = (sql: string, args: unknown[] = []): Promise<Row[]> =>
    db.runner.query(sql, args) as Promise<Row[]>;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { auditHttp: true, fraud: true });
    operatorToken = await app.issuer.token('operator', { sub: randomUUID() });
    auditorToken = await app.issuer.token('auditor', { sub: randomUUID() });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-135-01: complete money transfer with correlationId propagates across audit, outbox, notification and risk decisions', async () => {
    const sender = await seedDepositTarget(db.runner);
    const recipient = await seedDepositTarget(db.runner);
    const senderToken = await app.issuer.token('customer', { sub: sender.sub });

    // Deposit initial balance to sender
    await request(app.url)
      .post('/v1/operator/deposits')
      .auth(operatorToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: sender.accountId, amount: '10000000' })
      .expect(201);

    const clientCorrelationId = randomUUID();
    const idemKey = randomUUID();

    // 1. Perform customer transfer through API with x-correlation-id
    const transferRes = await request(app.url)
      .post('/v1/transfers')
      .auth(senderToken, { type: 'bearer' })
      .set('Idempotency-Key', idemKey)
      .set('x-correlation-id', clientCorrelationId)
      .send({
        fromAccountId: sender.accountId,
        toAccountId: recipient.accountId,
        amount: '2000000',
      })
      .expect(201);

    const transferId = transferRes.body.transferId as string;
    expect(transferId).toBeDefined();

    // 2. Verify audit_log has transfer.create with the correlationId
    const auditRows = await q(
      `SELECT id, action, target_id, correlation_id::text AS "correlationId"
       FROM audit_log WHERE target_id = $1::text`,
      [transferId],
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const transferAudit = auditRows.find(r => r.action === 'transfer');
    expect(transferAudit).toBeDefined();
    const serverCorrelationId = transferAudit!.correlationId as string;
    expect(serverCorrelationId).toBeDefined();

    // 3. Verify outbox_events has TransferCompleted with the same correlation_id
    const outboxRows = await q(
      `SELECT event_id, event_type, aggregate_id, correlation_id::text AS "correlationId"
       FROM outbox_events WHERE aggregate_id = $1::uuid`,
      [transferId],
    );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].event_type).toBe('TransferCompleted');
    expect(outboxRows[0].correlationId).toBe(serverCorrelationId);
    const eventId = outboxRows[0].event_id as string;

    // 4. Simulate async worker consumers recording downstream events linked by eventId & correlationId
    // (a) processed_events records consumption dedup
    await q(
      `INSERT INTO processed_events(consumer, event_id, processed_at)
       VALUES('risk-events', $1::uuid, clock_timestamp())`,
      [eventId],
    );

    // (b) risk_decisions records decision
    await q(
      `INSERT INTO risk_decisions(transfer_id, event_id, rule_set_version, mode, rule_score, feature_snapshot, ai_status, ai_applied_weight)
       VALUES($1::uuid, $2::uuid, 1, 'rule_only', 45, '{}'::jsonb, 'DISABLED', 0)`,
      [transferId, eventId],
    );

    // (c) fraud_flags records flag
    await q(
      `INSERT INTO fraud_flags(transfer_id, score, risk_level, review_status, rule_set_version)
       VALUES($1::uuid, 45, 'MEDIUM', 'OPEN', 1)`,
      [transferId],
    );

    // (d) notification_log records notice with correlation_id
    await q(
      `INSERT INTO notification_log(event_id, correlation_id, kind, user_id, message)
       VALUES($1::uuid, $2::uuid, 'transfer_completed', $3::uuid, 'Giao dịch chuyển tiền thành công')`,
      [eventId, serverCorrelationId, sender.userId],
    );

    // 5. Operator reviews the fraud flag via API
    await request(app.url)
      .post(`/v1/operator/fraud-flags/${transferId}/review`)
      .auth(operatorToken, { type: 'bearer' })
      .send({ decision: 'FALSE_POSITIVE', note: 'Xác minh khách hàng an toàn' })
      .expect(200);

    // 6. Auditor queries audit entries by correlationId via API (AC-8.2)
    const auditApiRes = await request(app.url)
      .get(`/v1/audit/entries?correlationId=${serverCorrelationId}`)
      .auth(auditorToken, { type: 'bearer' })
      .expect(200);

    expect(auditApiRes.body.entries).toBeDefined();
    expect(auditApiRes.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(auditApiRes.body.entries[0].correlationId).toBe(serverCorrelationId);

    // 7. Full multi-table trace lookup query completes in <= 5 minutes (target: < 500ms)
    const traceStart = Date.now();
    const traceRows = await q(
      `SELECT
         t.id AS "transferId",
         t.status AS "transferStatus",
         a.action AS "auditAction",
         a.correlation_id::text AS "auditCorrelationId",
         o.event_type AS "outboxEventType",
         o.correlation_id::text AS "outboxCorrelationId",
         p.consumer AS "processedConsumer",
         n.correlation_id::text AS "notificationCorrelationId",
         rd.rule_score AS "riskScore",
         ff.review_status AS "reviewStatus"
       FROM transfers t
       JOIN audit_log a ON a.target_id = t.id::text AND a.correlation_id = $1::uuid
       LEFT JOIN outbox_events o ON o.aggregate_id = t.id AND o.correlation_id = $1::uuid
       LEFT JOIN processed_events p ON p.event_id = o.event_id
       LEFT JOIN notification_log n ON n.correlation_id = $1::uuid
       LEFT JOIN risk_decisions rd ON rd.transfer_id = t.id
       LEFT JOIN fraud_flags ff ON ff.transfer_id = t.id
       WHERE t.id = $2::uuid`,
      [serverCorrelationId, transferId],
    );
    const traceDurationMs = Date.now() - traceStart;

    expect(traceRows.length).toBeGreaterThanOrEqual(1);
    const trace = traceRows[0];
    expect(trace.transferId).toBe(transferId);
    expect(trace.transferStatus).toBe('COMPLETED');
    expect(trace.auditCorrelationId).toBe(serverCorrelationId);
    expect(trace.outboxCorrelationId).toBe(serverCorrelationId);
    expect(trace.notificationCorrelationId).toBe(serverCorrelationId);
    expect(trace.processedConsumer).toBe('risk-events');
    expect(trace.riskScore).toBe(45);
    expect(trace.reviewStatus).toBe('FALSE_POSITIVE');

    // Prove trace query execution is <= 5 minutes (300,000 ms)
    expect(traceDurationMs).toBeLessThan(300_000);
    expect(traceDurationMs).toBeLessThan(1000); // Actually executes in < 1 second!

    console.log(
      JSON.stringify({
        scenario: 'DBS-135-AC-8.2',
        transferId,
        correlationId: serverCorrelationId,
        traceDurationMs,
        linkedRecords: {
          audit: trace.auditAction,
          outbox: trace.outboxEventType,
          consumer: trace.processedConsumer,
          notification: trace.notificationCorrelationId,
          risk: trace.riskScore,
          reviewStatus: trace.reviewStatus,
        },
      }),
    );
  });
});
