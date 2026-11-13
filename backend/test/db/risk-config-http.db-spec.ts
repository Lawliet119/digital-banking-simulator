import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { startRiskConfigApp, type RiskConfigApp } from '../support/risk-config-app';

interface TestConfig {
  mode: string;
  thresholds: Record<string, number>;
  rules: Record<string, Record<string, unknown>>;
  ai?: Record<string, unknown>;
  ml?: Record<string, unknown>;
}

const AI = {
  provider: 'openai',
  model: 'gpt-6-luna',
  rubric: 'Assess synthetic transaction features for operator review.',
  threshold: 0.8,
  weight: 30,
  maxAdmissionDelayMs: 2000,
  requestTimeoutMs: 3000,
};

describe('DBS-160 versioned risk configuration over real HTTP', () => {
  let fixture: RiskConfigApp;
  let admin: string;
  let operator: string;
  let customer: string;
  let adminSub: string;
  let seed: TestConfig;
  const root = '/v1/admin/risk-config';

  beforeAll(async () => {
    fixture = await startRiskConfigApp();
    adminSub = randomUUID();
    admin = await fixture.issuer.token('admin', { sub: adminSub });
    operator = await fixture.issuer.token('operator', { sub: randomUUID() });
    customer = await fixture.issuer.token('customer', { sub: randomUUID() });
    const [row] = (await fixture.db.runner.query(
      'SELECT config FROM risk_rule_sets WHERE version=1',
    )) as { config: TestConfig }[];
    seed = row.config;
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it('admin reads the seeded current version and immutable history', async () => {
    const current = await request(fixture.url)
      .get(root)
      .auth(admin, { type: 'bearer' })
      .expect(200);
    expect(current.body.version).toBe(1);
    expect(current.body.config.mode).toBe('rule_only');
    expect(current.body.createdBy).toBeNull();
    const detail = await request(fixture.url)
      .get(`${root}/versions/1`)
      .auth(admin, { type: 'bearer' })
      .expect(200);
    expect(detail.body).toEqual(current.body);
    const list = await request(fixture.url)
      .get(`${root}/versions`)
      .auth(admin, { type: 'bearer' })
      .expect(200);
    expect(list.body.items).toEqual([current.body]);
    expect(list.body.nextBefore).toBeNull();
  });

  it('only admin can read or create configurations', async () => {
    const unauthenticated = await request(fixture.url).get(root).expect(401);
    expect(unauthenticated.body.errorCode).toBe('UNAUTHENTICATED');
    for (const token of [operator, customer]) {
      const denied = await request(fixture.url)
        .get(root)
        .auth(token, { type: 'bearer' })
        .expect(403);
      expect(denied.body.errorCode).toBe('FORBIDDEN');
      await request(fixture.url)
        .post(`${root}/versions`)
        .auth(token, { type: 'bearer' })
        .send({ config: seed })
        .expect(403);
    }
    expect(await fixture.db.runner.query('SELECT count(*)::int AS n FROM risk_rule_sets')).toEqual([
      { n: 1 },
    ]);
  });

  it('creates immutable versions with the authenticated actor and atomic audit', async () => {
    const config = structuredClone(seed);
    const created = await request(fixture.url)
      .post(`${root}/versions`)
      .auth(admin, { type: 'bearer' })
      .send({ config })
      .expect(201);
    expect(created.body.version).toBe(2);
    expect(created.body.config).toEqual(config);
    const [actor] = (await fixture.db.runner.query('SELECT id FROM users WHERE cognito_sub=$1', [
      adminSub,
    ])) as { id: string }[];
    expect(created.body.createdBy).toBe(actor.id);
    const [audit] = (await fixture.db.runner.query(
      `SELECT actor_user_id,actor_role,action,target_type,target_id,metadata
       FROM audit_log WHERE action='risk_config.create' AND target_id='2'`,
    )) as {
      actor_user_id: string;
      actor_role: string;
      action: string;
      target_type: string;
      target_id: string;
      metadata: Record<string, unknown>;
    }[];
    expect(audit).toMatchObject({
      actor_user_id: actor.id,
      actor_role: 'admin',
      action: 'risk_config.create',
      target_type: 'risk_rule_set',
      target_id: '2',
    });
    expect(JSON.stringify(audit.metadata)).not.toContain(AI.rubric);
    const page = await request(fixture.url)
      .get(`${root}/versions?limit=1`)
      .auth(admin, { type: 'bearer' })
      .expect(200);
    expect(page.body.items[0].version).toBe(2);
    expect(page.body.nextBefore).toBe(2);
    const next = await request(fixture.url)
      .get(`${root}/versions?limit=1&before=2`)
      .auth(admin, { type: 'bearer' })
      .expect(200);
    expect(next.body.items[0].version).toBe(1);
    expect(next.body.nextBefore).toBeNull();
    await request(fixture.url)
      .put(`${root}/versions/1`)
      .auth(admin, { type: 'bearer' })
      .expect(404);
    await request(fixture.url)
      .delete(`${root}/versions/1`)
      .auth(admin, { type: 'bearer' })
      .expect(404);
  });

  it('rejects malformed versions, pagination and every invalid rule without writing', async () => {
    for (const path of [
      `${root}/versions/0`,
      `${root}/versions/01`,
      `${root}/versions/2147483648`,
      `${root}/versions?limit=0`,
      `${root}/versions?before=-1`,
      `${root}/versions?extra=value`,
    ]) {
      await request(fixture.url).get(path).auth(admin, { type: 'bearer' }).expect(400);
    }
    await request(fixture.url)
      .get(`${root}/versions/2147483647`)
      .auth(admin, { type: 'bearer' })
      .expect(404);
    const bad: TestConfig[] = [];
    const wrong = (change: (config: TestConfig) => void) => {
      const config = structuredClone(seed);
      change(config);
      bad.push(config);
    };
    wrong(c => (c.mode = 'unknown'));
    wrong(c => (c.thresholds.high = c.thresholds.medium));
    wrong(c => (c.rules.R1.windowMinutes = 11));
    wrong(c => (c.rules.R2.minHistory = 4));
    wrong(c => (c.rules.R3.maxAccountAgeHoursExclusive = 0));
    wrong(c => (c.rules.R4.reverseWindowMinutes = 61));
    wrong(c => (c.rules.R5.windowMinutes = 59));
    wrong(c => (c.rules.R6.minBalance = '0'));
    wrong(c => (c.rules.R5.sameOwnerExempt = false));
    wrong(c => (c.rules.R1.weight = 2_147_483_647));
    wrong(c => (c.rules.R1.extra = 'unexpected'));
    // BL-188: every value a rule would throw on is refused before the write.
    wrong(c => (c.rules.R2.historyDays = 29));
    wrong(c => (c.rules.R2.medianMultiplier = 2.005));
    wrong(c => (c.rules.R3.minAmountExclusive = 10_000_000));
    wrong(c => (c.rules.R3.minAmountExclusive = 'abc'));
    wrong(c => (c.rules.R3.maxAccountAgeHoursExclusive = 87_601));
    wrong(c => (c.rules.R4.reverseWindowMinutes = 0));
    wrong(c => (c.rules.R4.reverseWindowMinutes = 30.5));
    wrong(c => (c.rules.R5.noveltyDays = 7));
    wrong(c => (c.rules.R6.minBalancePercent = 0));
    wrong(c => (c.rules.R6.minBalancePercent = 101));
    wrong(c => (c.rules.R6.minBalancePercent = 90.5));
    wrong(c => (c.rules.R6.minBalance = 1_000_000));
    wrong(c => {
      c.rules.R3.enabled = false; // switching a rule off does not excuse a broken value
      c.rules.R3.minAmountExclusive = 10_000_000;
    });
    for (const mode of ['rule_only', 'rules_with_external_ai']) {
      for (const [field, value] of [
        ['provider', 'other'],
        ['model', 'not a model'],
        ['rubric', ''],
        ['threshold', 0],
        ['threshold', 1.01],
        ['weight', -1],
        ['weight', 2_147_483_647],
        ['maxAdmissionDelayMs', 0],
        ['requestTimeoutMs', -1],
      ] as const) {
        wrong(c => {
          c.mode = mode;
          c.ai = { ...AI, [field]: value };
        });
      }
    }
    wrong(c => (c.mode = 'rules_with_external_ai'));
    const [before] = (await fixture.db.runner.query(
      'SELECT count(*)::int AS n FROM risk_rule_sets',
    )) as { n: number }[];
    for (const config of bad) {
      const response = await request(fixture.url)
        .post(`${root}/versions`)
        .auth(admin, { type: 'bearer' })
        .send({ config })
        .expect(400);
      expect(JSON.stringify(response.body)).not.toContain(AI.rubric);
    }
    const [after] = (await fixture.db.runner.query(
      'SELECT count(*)::int AS n FROM risk_rule_sets',
    )) as { n: number }[];
    expect(after.n).toBe(before.n);
  });

  it('accepts a valid AI block in both modes but preserves the requested mode', async () => {
    for (const mode of ['rule_only', 'rules_with_external_ai']) {
      const config = structuredClone(seed);
      config.mode = mode;
      config.ai = { ...AI };
      const response = await request(fixture.url)
        .post(`${root}/versions`)
        .auth(admin, { type: 'bearer' })
        .send({ config })
        .expect(201);
      expect(response.body.config.mode).toBe(mode);
      expect(response.body.config.ai).toEqual(AI);
    }
  });

  it('serializes concurrent creates and rolls back a version when audit fails', async () => {
    const [before] = (await fixture.db.runner.query(
      'SELECT max(version)::int AS n FROM risk_rule_sets',
    )) as { n: number }[];
    const make = () =>
      request(fixture.url)
        .post(`${root}/versions`)
        .auth(admin, { type: 'bearer' })
        .send({ config: seed });
    const results = await Promise.all([make(), make()]);
    expect(results.map(result => result.status)).toEqual([201, 201]);
    expect(results.map(result => Number(result.body.version)).sort((a, b) => a - b)).toEqual([
      before.n + 1,
      before.n + 2,
    ]);
    await fixture.db.runner.query('REVOKE INSERT ON audit_log FROM dbs_api');
    try {
      await make().expect(500);
    } finally {
      await fixture.db.runner.query('GRANT INSERT ON audit_log TO dbs_api');
    }
    const [after] = (await fixture.db.runner.query(
      'SELECT max(version)::int AS n FROM risk_rule_sets',
    )) as { n: number }[];
    expect(after.n).toBe(before.n + 2);
  });

  it('holds a transaction-scoped writer lock until commit before choosing the next version', async () => {
    const runner = fixture.db.runner;
    const dataSource = fixture.app.get(DataSource);
    const [before] = (await runner.query('SELECT max(version)::int AS n FROM risk_rule_sets')) as {
      n: number;
    }[];
    await runner.startTransaction();
    let pending: Promise<request.Response> | undefined;
    try {
      await runner.query('SELECT pg_advisory_xact_lock(20261110, 160)');
      await runner.query(
        'INSERT INTO risk_rule_sets(version,config,created_by) VALUES($1,$2::jsonb,NULL)',
        [before.n + 1, JSON.stringify(seed)],
      );
      pending = request(fixture.url)
        .post(`${root}/versions`)
        .auth(admin, { type: 'bearer' })
        .send({ config: seed })
        .then(response => response);
      const deadline = Date.now() + 1500;
      let waiting = false;
      while (Date.now() < deadline) {
        const [row] = await dataSource.query<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname=current_database() AND wait_event='advisory'
             AND query LIKE '%pg_advisory_xact_lock%'`,
        );
        if (row.n > 0) {
          waiting = true;
          break;
        }
        await delay(10);
      }
      expect(waiting).toBe(true);
      await runner.commitTransaction();
      const result = await pending;
      expect(result.status).toBe(201);
      expect(result.body.version).toBe(before.n + 2);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await pending?.catch(() => undefined);
    }
  });
});
