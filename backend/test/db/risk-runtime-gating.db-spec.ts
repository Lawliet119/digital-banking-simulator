import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { RiskAiService } from '@modules/risk/ai/risk-ai.service';
import { buildRiskConsumer, eventFor, riskFixtures } from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startDepositApp, type DepositApp } from '../support/deposit-app';
import { expectLedgerInvariantsAfterEach } from '../support/ledger-invariants';

/**
 * RSK-06, the parts of the DoD that no other test proves (the rest is referenced in the feature doc):
 *  - a decision is never redone when the mode changes or the transfer comes again with a new event
 *    (LOW and rule_only included);
 *  - a configuration change while requests are in flight gives a consistent mode per request and no error;
 *  - a customer sees nothing of flags, AI assessment or decisions on any customer endpoint.
 * risk_rule_sets is append-only, so the three tests share one database and run in this order.
 */
const VALID_AI = {
  provider: 'openai',
  model: 'gpt-6-luna',
  rubric:
    'needs_operator_review: đánh giá mẫu giao dịch đã hoàn tất có dấu hiệu cần nhân viên xem xét',
  threshold: 0.8,
  weight: 20,
  maxAdmissionDelayMs: 2000,
  requestTimeoutMs: 3000,
};

describe('RSK-06 runtime of the AI gate on PostgreSQL', () => {
  let db: TempDatabase;
  let app: DepositApp;
  let source: DataSource;
  let fx: ReturnType<typeof riskFixtures>;
  const aiCalls = jest.fn();
  const ai = {
    evaluate: (...args: unknown[]) => {
      aiCalls(...args);
      return Promise.resolve({
        status: 'UNAVAILABLE',
        probability: null,
        provider: 'openai',
        requestedModel: 'gpt-6-luna',
        responseModel: null,
        requestId: null,
        rubricSha256: 'a'.repeat(64),
        inputSha256: 'b'.repeat(64),
        usage: null,
      });
    },
  } as unknown as RiskAiService;

  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> =>
    db.runner.query(sql, args) as Promise<T[]>;

  type Customer = Awaited<ReturnType<typeof fx.customer>>;
  interface Sale {
    sender: Customer;
    recipient: Customer;
    transferId: string;
    event: Record<string, unknown>;
  }

  /** AC-9.1: 20 of 21 million from a new account to another owner, MEDIUM (R3 + R6) under the seed. */
  async function flaggable(label: string): Promise<Sale> {
    const sender = await fx.customer(`Gửi ${label}`);
    const recipient = await fx.customer(`Nhận ${label}`);
    await fx.deposit(sender.accounts[0], '21000000');
    const transferId = await fx.transfer(
      sender.token,
      sender.accounts[0],
      recipient.accounts[0],
      '20000000',
    );
    return { sender, recipient, transferId, event: await eventFor(db.runner, transferId) };
  }

  async function small(label: string): Promise<Sale> {
    const sender = await fx.customer(`Gửi ${label}`);
    const recipient = await fx.customer(`Nhận ${label}`);
    await fx.deposit(sender.accounts[0], '10000000');
    const transferId = await fx.transfer(
      sender.token,
      sender.accounts[0],
      recipient.accounts[0],
      '1000',
    );
    return { sender, recipient, transferId, event: await eventFor(db.runner, transferId) };
  }

  const decisionsOf = (transferId: string) =>
    q<{ mode: string; rule_set_version: number; ai_status: string }>(
      'SELECT mode, rule_set_version, ai_status FROM risk_decisions WHERE transfer_id = $1',
      [transferId],
    );
  const flagsOf = (transferId: string) =>
    q('SELECT 1 FROM fraud_flags WHERE transfer_id = $1', [transferId]);
  const auditsOf = (transferId: string) =>
    q("SELECT 1 FROM audit_log WHERE target_id = $1 AND action = 'fraud.flagged'", [transferId]);

  // State shared by the three tests (they depend on each other by design, see the header).
  let lowSale: Sale;
  let before: Sale[];
  let after: Sale[];

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { fraud: true });
    fx = riskFixtures(app, await app.issuer.token('operator', { sub: randomUUID() }));
    source = await new DataSource({
      type: 'postgres',
      url: db.url,
      extra: { max: 20 },
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

  expectLedgerInvariantsAfterEach(() => source);

  it('TC-RSK06-01 DoD 4: six requests in flight while the rule set switches to AI keep their own mode; later ones use AI; nobody fails', async () => {
    lowSale = await small('thấp');
    before = [];
    after = [];
    for (let i = 0; i < 6; i++) before.push(await flaggable(`trước ${i}`));
    for (let i = 0; i < 6; i++) after.push(await flaggable(`sau ${i}`));

    const parts = buildRiskConsumer(source, { ai });
    // A LOW transfer decided under rule_only before the switch (used by TC-RSK06-02).
    await parts.consumer.handle(lowSale.event);

    // Hold all six requests inside feature extraction, i.e. after they read the rule set.
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let reached = 0;
    const extract = parts.provider.extract.bind(parts.provider);
    jest.spyOn(parts.provider, 'extract').mockImplementation(async event => {
      reached++;
      await gate;
      return extract(event);
    });
    const inFlight = before.map(sale => parts.consumer.handle(sale.event));
    while (reached < 6) await new Promise(resolve => setTimeout(resolve, 10));

    // The configuration changes now: version 2 asks for external AI.
    await q(
      `INSERT INTO risk_rule_sets(version, config)
       SELECT max(version) + 1,
              (SELECT config FROM risk_rule_sets WHERE version = 1)
                || jsonb_build_object('mode', 'rules_with_external_ai', 'ai', $1::jsonb)
         FROM risk_rule_sets`,
      [JSON.stringify(VALID_AI)],
    );
    release();
    await expect(Promise.all(inFlight)).resolves.toHaveLength(6);
    expect(aiCalls).not.toHaveBeenCalled(); // they read version 1, rule_only

    await expect(
      Promise.all(after.map(sale => parts.consumer.handle(sale.event))),
    ).resolves.toHaveLength(6);
    expect(aiCalls).toHaveBeenCalledTimes(6); // only the later six went to AI

    for (const sale of before) {
      expect(await decisionsOf(sale.transferId)).toEqual([
        { mode: 'rule_only', rule_set_version: 1, ai_status: expect.any(String) as string },
      ]);
    }
    for (const sale of after) {
      expect(await decisionsOf(sale.transferId)).toEqual([
        { mode: 'rules_with_external_ai', rule_set_version: 2, ai_status: 'UNAVAILABLE' },
      ]);
    }
    for (const sale of [...before, ...after]) {
      expect(await flagsOf(sale.transferId)).toHaveLength(1);
      expect(await auditsOf(sale.transferId)).toHaveLength(1);
    }
    expect(await decisionsOf(lowSale.transferId)).toHaveLength(1);
    expect(await flagsOf(lowSale.transferId)).toHaveLength(0);
  });

  it('TC-RSK06-02 DoD 1: after the switch, a new event of a decided transfer (rule_only, flagged or LOW) is not scored again and does not call AI', async () => {
    const parts = buildRiskConsumer(source, { ai });
    const score = jest.spyOn(parts.scoring, 'score');
    const calls = aiCalls.mock.calls.length;
    const again = [before[0], lowSale];
    const decisionsBefore = await Promise.all(again.map(sale => decisionsOf(sale.transferId)));
    // Two workers at once, each with its own event of the same transfer.
    await Promise.all(
      again.flatMap(sale => [
        parts.consumer.handle({ ...sale.event, eventId: randomUUID() }),
        parts.consumer.handle({ ...sale.event, eventId: randomUUID() }),
      ]),
    );
    expect(score).not.toHaveBeenCalled();
    expect(aiCalls.mock.calls.length).toBe(calls);
    expect(await Promise.all(again.map(sale => decisionsOf(sale.transferId)))).toEqual(
      decisionsBefore,
    );
    expect(await flagsOf(before[0].transferId)).toHaveLength(1);
    expect(await auditsOf(before[0].transferId)).toHaveLength(1);
    expect(await flagsOf(lowSale.transferId)).toHaveLength(0);
  });

  it('TC-RSK06-03 DoD 3: a customer with a flagged transfer (rule_only and AI decision) sees nothing about flags, AI or decisions on any customer endpoint', async () => {
    const forbidden =
      /fraud|flag|aiAssessment|ai_status|aiStatus|probability|rubric|rule_?score|ruleScore|risk|review|rule_?set|decision|hits/i;
    for (const sale of [before[0], after[0]]) {
      for (const person of [sale.sender, sale.recipient]) {
        const routes = [
          '/v1/accounts',
          `/v1/accounts/${person.accounts[0]}`,
          `/v1/accounts/${person.accounts[0]}/transactions`,
          '/v1/customers/me',
          '/v1/identity/me',
        ];
        if (person === sale.sender) routes.push(`/v1/transfers/${sale.transferId}`);
        for (const route of routes) {
          const res = await request(app.url).get(route).auth(person.token, { type: 'bearer' });
          expect([route, res.status]).toEqual([route, 200]);
          expect([route, JSON.stringify(res.body).match(forbidden)]).toEqual([route, null]);
        }
        for (const route of [
          '/v1/operator/fraud-flags',
          `/v1/operator/fraud-flags/${sale.transferId}`,
        ]) {
          const res = await request(app.url).get(route).auth(person.token, { type: 'bearer' });
          expect([route, res.status]).toEqual([route, 403]);
          expect(JSON.stringify(res.body)).not.toMatch(/"score"|riskLevel|probability/);
        }
      }
    }
    // The same flag is visible where it should be (so the checks above are not vacuous).
    const operator = await app.issuer.token('operator', { sub: randomUUID() });
    const seen = await request(app.url)
      .get(`/v1/operator/fraud-flags/${before[0].transferId}`)
      .auth(operator, { type: 'bearer' })
      .expect(200);
    expect(JSON.stringify(seen.body)).toMatch(/riskLevel|risk_level/i);
  });
});
